'use strict';

// Tests for the off-main-thread one-shot SQLite reader (libs/app/store/SqliteReadWorker.js) and the
// HubStore.queryOffThread() entry point wired on top of it. They use a real file-backed database so the
// cross-thread read is exercised end-to-end, and prove the guarantees that matter: rows come back
// correctly, bind params work, a write is refused (read-only), a bad query and a timeout reject cleanly
// rather than hang, and an in-memory / unavailable store is handled without throwing.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SqliteDriver = require('../../app/store/SqliteDriver.js');
const SqliteReadWorker = require('../../app/store/SqliteReadWorker.js');
const HubStore = require('../../app/store/HubStore.js');

let passed = 0, failed = 0;
async function test(name, fn) {
	try { await fn(); passed++; console.log('  ok   - ' + name); }
	catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + (e && e.message)); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'symbot-readworker-'));
function freshDir(name) { const d = path.join(TMP, name + '-' + Math.floor(Math.random() * 1e9)); fs.mkdirSync(d, { recursive: true }); return d; }

// A file-backed DB seeded with a couple of rows via the same hardened driver the Hub uses.
function seededDbPath(name) {
	const dbPath = path.join(freshDir(name), 'db.db');
	const d = SqliteDriver({ path: dbPath });
	d.open();
	d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER);');
	d.run('INSERT INTO t (id, name, n) VALUES (?,?,?)', [ 1, 'alpha', 10 ]);
	d.run('INSERT INTO t (id, name, n) VALUES (?,?,?)', [ 2, 'beta', 20 ]);
	d.run('INSERT INTO t (id, name, n) VALUES (?,?,?)', [ 3, 'gamma', 30 ]);
	d.close();   // WAL is checkpointed on close, so the reader sees the rows in the main file
	return dbPath;
}


(async () => {

	if (!SqliteReadWorker.available) {
		console.log('\nSqliteReadWorker: node:sqlite unavailable in this runtime — skipping (upgrade to Node 22.13+).');
		console.log('\n' + passed + ' passed, ' + failed + ' failed');
		return;
	}

	console.log('\nqueryOnce:');

	await test('reads all rows off-thread', async () => {
		const dbPath = seededDbPath('read');
		const rows = await SqliteReadWorker.queryOnce(dbPath, 'SELECT id, name, n FROM t ORDER BY id');
		assert.strictEqual(rows.length, 3);
		assert.strictEqual(rows[0].name, 'alpha');
		assert.strictEqual(rows[2].n, 30);
	});

	await test('honors positional bind parameters', async () => {
		const dbPath = seededDbPath('params');
		const rows = await SqliteReadWorker.queryOnce(dbPath, 'SELECT name FROM t WHERE n >= ? ORDER BY id', [ 20 ]);
		assert.deepStrictEqual(rows.map(r => r.name), [ 'beta', 'gamma' ]);
	});

	await test('honors NAMED bind parameters (object)', async () => {
		const dbPath = seededDbPath('named');
		const rows = await SqliteReadWorker.queryOnce(dbPath, 'SELECT name FROM t WHERE n = @n', { '@n': 20 });
		assert.deepStrictEqual(rows.map(r => r.name), [ 'beta' ]);
	});

	await test('a runaway result set rejects (memory cap) rather than aborting the process', async () => {
		const dbPath = seededDbPath('memcap');
		// A cross join blown up by a recursive CTE would materialize a huge row set; the small heap cap must
		// terminate the worker and surface an error, never OOM-abort the process. Bounded time via timeout.
		const huge = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 5000000) '
			+ 'SELECT x, printf("%0100d", x) AS pad FROM c';
		await assert.rejects(() => SqliteReadWorker.queryOnce(dbPath, huge, [], { maxResultMb: 16, timeoutMs: 20000 }),
			/./);   // any rejection (worker 'error' from the heap cap, or the timeout) — never a process abort
	});

	await test('rejects a malformed query (no hang)', async () => {
		const dbPath = seededDbPath('bad');
		await assert.rejects(() => SqliteReadWorker.queryOnce(dbPath, 'SELECT nope FROM t'), /no such column|nope/i);
	});

	await test('is read-only — a write is refused', async () => {
		const dbPath = seededDbPath('ro');
		await assert.rejects(() => SqliteReadWorker.queryOnce(dbPath, "INSERT INTO t (id, name, n) VALUES (99, 'x', 1)"),
			/readonly|read-only|query_only|not authorized|cannot|attempt to write/i);
		// And the row was NOT written — confirm from a fresh main-thread read.
		const d = SqliteDriver({ path: dbPath }); d.open();
		const row = d.get('SELECT COUNT(*) AS c FROM t');
		d.close();
		assert.strictEqual(row.c, 3, 'no row should have been inserted by the read worker');
	});

	await test('reads concurrently while the writer holds the DB open (WAL snapshot)', async () => {
		// The real Hub case: the main-thread driver keeps the DB open in WAL while the reader opens its own
		// read-only handle. WAL must let the reader see committed rows without the writer closing first.
		const dbPath = path.join(freshDir('concurrent'), 'db.db');
		const w = SqliteDriver({ path: dbPath });
		w.open();
		w.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER);');
		w.run('INSERT INTO t (id, n) VALUES (?, ?)', [ 1, 100 ]);
		try {
			const first = await SqliteReadWorker.queryOnce(dbPath, 'SELECT COUNT(*) AS c FROM t');
			assert.strictEqual(first[0].c, 1, 'reader sees the first committed row while writer is open');
			w.run('INSERT INTO t (id, n) VALUES (?, ?)', [ 2, 200 ]);   // a later commit
			const second = await SqliteReadWorker.queryOnce(dbPath, 'SELECT COUNT(*) AS c FROM t');
			assert.strictEqual(second[0].c, 2, 'a fresh read sees the newer commit');
		}
		finally { w.close(); }
	});

	await test('rejects on timeout rather than hanging', async () => {
		const dbPath = seededDbPath('timeout');
		// A recursive CTE that counts very high is a long synchronous scan; a tiny timeout must fire and
		// terminate the worker. (Even if the timer beats the worker spawn, the timeout path is what we prove.)
		const heavy = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 100000000) SELECT COUNT(*) AS c FROM c';
		await assert.rejects(() => SqliteReadWorker.queryOnce(dbPath, heavy, [], { timeoutMs: 50 }), /timed out/i);
	});

	await test('rejects a missing / non-string path without throwing', async () => {
		await assert.rejects(() => SqliteReadWorker.queryOnce('', 'SELECT 1'), /file path/i);
		await assert.rejects(() => SqliteReadWorker.queryOnce(seededDbPath('nosql'), ''), /SQL string/i);
	});

	console.log('\nHubStore.queryOffThread:');

	await test('returns rows from the Hub database off-thread', async () => {
		const dir = freshDir('hub');
		const r = HubStore.init({ path: path.join(dir, 'hub.db'), backupDir: path.join(dir, 'backups'), logger: () => {} });
		assert.ok(r.available, 'hub store available');
		// Read a table the schema always creates; the point is the off-thread round-trip returns an array.
		const rows = await HubStore.queryOffThread('SELECT COUNT(*) AS c FROM users');
		assert.ok(Array.isArray(rows) && rows.length === 1 && typeof rows[0].c === 'number');
		HubStore.close();
	});

	await test('rejects cleanly when storage is closed / unavailable', async () => {
		HubStore.close();   // idempotent — ensure no driver
		await assert.rejects(() => HubStore.queryOffThread('SELECT 1'), /unavailable/i);
	});

	await test('rejects an in-memory database (cannot cross threads)', async () => {
		const r = HubStore.init({ path: null, logger: () => {} });   // :memory:
		if (r.available) {
			await assert.rejects(() => HubStore.queryOffThread('SELECT 1'), /file-backed/i);
			HubStore.close();
		}
	});

	console.log('\n' + passed + ' passed, ' + failed + ' failed');
})();
