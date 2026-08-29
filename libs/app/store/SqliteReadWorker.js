'use strict';

// ── SqliteReadWorker — off-main-thread one-shot SQLite READ ──────────────────
//
// Node's built-in `node:sqlite` (DatabaseSync) is SYNCHRONOUS: a query blocks the whole event loop for
// its full duration. For the tiny, indexed point lookups the Hub does today (a login, a key resolve, an
// audit insert) that is sub-millisecond and belongs on the main thread — a worker there would be pure
// overhead. This module is the tool for the OTHER case: a genuinely heavy read (a large audit/report scan
// over a grown table) that would otherwise freeze the Hub's HTTP/UI while it runs. It runs that one read
// on a short-lived worker thread and hands the caller a Promise of the rows.
//
// It is deliberately a forward-looking primitive: nothing on a hot path needs it yet, so it is wired to
// HubStore.queryOffThread() as a ready entry point rather than left unused. When a heavy Hub read does
// appear, route it here instead of adding a second, ad-hoc worker.
//
// Safety and scope:
//   • READ-ONLY. The worker opens the database read-only and sets `PRAGMA query_only`, so it can never
//     write — it cannot corrupt or lock out the main-thread writer.
//   • Concurrency-safe alongside the live writer BECAUSE the database is WAL (the main-thread driver opens
//     it that way): WAL lets a reader run against a consistent committed snapshot while the writer works.
//   • Hub control-plane only. The instance side has no synchronous SQLite (its data is MongoDB), and the
//     Hub has no trading connection — so this primitive is nowhere near, and can never affect, the money
//     path. A failure here rejects a Promise rather than throwing the process down — including a runaway
//     result set, which the worker's memory cap (`maxResultMb`) turns into a terminated-worker rejection
//     instead of an out-of-memory process abort.
//
// One honest limit: `timeoutMs` bounds the CALLER's wait, not the underlying work. node:sqlite exposes no
// query interrupt, so terminating the worker cannot stop a synchronous query already running inside SQLite
// — that thread keeps a core busy until the query returns on its own (and can delay process shutdown). So
// this offloads a heavy read to keep the main thread responsive; it does NOT make an unbounded query safe.
// Callers must keep the query self-bounding (a LIMIT, an indexed predicate).
//
// The worker body is inlined as a string and spawned with `eval: true`, so there is no separate worker
// file to ship — the whole primitive stays in this one module.

const { Worker } = require('worker_threads');


// Coerce n to an integer within [lo, hi], falling back to dflt for a NaN/undefined value. Keeps the numeric
// knobs from producing a hang, a setTimeout overflow (a value > 2^31−1 clamps to 1ms), or a wrapped PRAGMA.
function clampInt(n, dflt, lo, hi) {
	n = Number(n);
	if (!Number.isFinite(n)) { n = dflt; }
	n = Math.round(n);
	if (n < lo) { n = lo; }
	if (n > hi) { n = hi; }
	return n;
}


// node:sqlite is built into Node (no external/native dependency): present from 22.5.0 and loads without a
// flag on 22.13+ (the 22 LTS line) and 24+. Probe it in the parent so `available` can gate callers cleanly
// on an older runtime, exactly as SqliteDriver does — the require is defensive so load can never crash.
let SQLITE_AVAILABLE = false;
try { const { DatabaseSync } = require('node:sqlite'); SQLITE_AVAILABLE = typeof DatabaseSync === 'function'; }
catch (e) { SQLITE_AVAILABLE = false; }


// The worker: open the file read-only, run exactly ONE prepared query, post the rows back, and stay alive
// for the single message the parent sends. Wrapped in an IIFE so an early `return` on an open failure is
// legal, and every path posts a structured { ok, ... } reply so the parent never hangs waiting.
const WORKER_SRC = `
'use strict';
const { parentPort, workerData } = require('worker_threads');
(function () {
	let DatabaseSync = null;
	try { ({ DatabaseSync } = require('node:sqlite')); }
	catch (e) { parentPort.postMessage({ ok: false, error: 'node:sqlite unavailable: ' + ((e && e.message) || e) }); return; }

	let db = null;
	try {
		db = new DatabaseSync(workerData.dbPath, { readOnly: true });
		// query_only makes a write attempt fail loudly; busy_timeout waits out a brief lock instead of
		// erroring. Both are best-effort — a PRAGMA that a given build rejects must not sink the read.
		try { db.exec('PRAGMA query_only = 1;'); } catch (e) {}
		try { db.exec('PRAGMA busy_timeout = ' + ((workerData.busyMs | 0) || 5000) + ';'); } catch (e) {}
	}
	catch (e) { parentPort.postMessage({ ok: false, error: 'open failed: ' + ((e && e.message) || e) }); return; }

	parentPort.on('message', function (m) {
		try {
			const stmt = db.prepare(m.sql);
			// Positional params arrive as an ARRAY (spread as anonymous binds); named params arrive as a
			// plain OBJECT (passed as the single named-parameter argument). Neither → a no-arg query.
			let rows;
			if (Array.isArray(m.params)) { rows = stmt.all.apply(stmt, m.params); }
			else if (m.params && typeof m.params === 'object') { rows = stmt.all(m.params); }
			else { rows = stmt.all(); }
			parentPort.postMessage({ ok: true, rows: rows });
		}
		catch (e) { parentPort.postMessage({ ok: false, error: (e && e.message) ? e.message : String(e) }); }
	});
})();
`;


// Run ONE read-only query off the main thread and resolve with its rows. Never throws synchronously — it
// always returns a Promise, so a caller can `await` it without a surrounding try for the setup. A fresh
// worker is spawned per call and terminated the moment the call settles (success, error, early exit, or
// timeout), so there is no pool to leak. See the module header for the `timeoutMs`-bounds-the-caller-only
// caveat and the `maxResultMb` cap — keep the query self-bounding (a LIMIT / an indexed predicate).
//
//   dbPath   — path to the SQLite FILE (an in-memory ':memory:' DB cannot be shared across threads).
//   sql      — a single read (SELECT/PRAGMA) statement.
//   params   — bind parameters: a positional ARRAY, or a named-parameter OBJECT ({ '@name': value }).
//              Anything else is treated as no parameters.
//   opts     — { timeoutMs = 60000, busyMs = 5000, maxResultMb = 256, logger }.
//
// Single exit (one returned Promise); settle-once guard prevents a double resolve/reject.
function queryOnce(dbPath, sql, params, opts) {

	opts = opts || {};
	// Clamp the numeric knobs to sane ranges so a NaN/negative/oversized value fails fast rather than
	// hanging or tripping a setTimeout overflow: timeout 1s–1h, busy 0–60s, worker heap cap 16MB–4GB.
	const timeoutMs   = clampInt(opts.timeoutMs, 60000, 1000, 3600000);
	const busyMs      = clampInt(opts.busyMs, 5000, 0, 60000);
	const maxResultMb = clampInt(opts.maxResultMb, 256, 16, 4096);
	const logger      = typeof opts.logger === 'function' ? opts.logger : function () {};

	return new Promise(function (resolve, reject) {

		if (!SQLITE_AVAILABLE) { reject(new Error('node:sqlite unavailable in this Node runtime')); return; }
		if (!dbPath || typeof dbPath !== 'string') { reject(new Error('queryOnce requires a database file path')); return; }
		if (!sql || typeof sql !== 'string') { reject(new Error('queryOnce requires a SQL string')); return; }

		let worker = null;
		let timer = null;
		let settled = false;

		function finish(err, rows) {
			if (settled) { return; }
			settled = true;
			if (timer) { clearTimeout(timer); timer = null; }
			if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
			if (err) { reject(err); } else { resolve(rows); }
		}

		try {
			// resourceLimits caps the worker's heap: a runaway result set hits the cap and the worker
			// terminates with an 'error' event (→ a clean rejection below) instead of OOM-aborting the
			// whole process. It bounds memory only — it cannot interrupt a CPU-bound query (see timer note).
			worker = new Worker(WORKER_SRC, {
				eval: true,
				workerData: { dbPath: dbPath, busyMs: busyMs },
				resourceLimits: { maxOldGenerationSizeMb: maxResultMb }
			});
		}
		catch (e) { finish(new Error('worker spawn failed: ' + ((e && e.message) || e))); return; }

		// The caller's deadline. NOT unref'd (nor is the worker): a one-shot must keep the event loop alive
		// until it settles, or the process could exit with the query still outstanding. On expiry the caller
		// is rejected and the worker is asked to terminate — but a synchronous query already inside SQLite
		// runs to completion regardless (node:sqlite has no interrupt), so a heavy read must be self-bounding.
		timer = setTimeout(function () {
			logger('SqliteReadWorker: query timed out after ' + timeoutMs + 'ms — terminating worker');
			finish(new Error('query timed out after ' + timeoutMs + 'ms'));
		}, timeoutMs);

		worker.on('message', function (msg) {
			if (msg && msg.ok) { finish(null, Array.isArray(msg.rows) ? msg.rows : []); }
			else { finish(new Error((msg && msg.error) ? msg.error : 'unknown worker error')); }
		});
		worker.on('error', function (e) { finish(new Error('worker error: ' + ((e && e.message) || e))); });
		worker.on('exit', function (code) { if (!settled) { finish(new Error('worker exited early (code ' + code + ')')); } });

		// Pass positional (array) or named (plain object) params straight through; normalize anything else to
		// none. Structured-clone carries both shapes across the thread boundary.
		const bound = Array.isArray(params) ? params : ((params && typeof params === 'object') ? params : []);
		try { worker.postMessage({ sql: sql, params: bound }); }
		catch (e) { finish(new Error('postMessage failed: ' + ((e && e.message) || e))); }
	});
}


// Whether Node's built-in SQLite is usable here (see the probe above). Callers gate on this so an older
// Node degrades cleanly (queryOnce also rejects with the same reason) rather than surfacing a raw throw.
queryOnce.available = SQLITE_AVAILABLE;

module.exports = { queryOnce: queryOnce, available: SQLITE_AVAILABLE };
