'use strict';

// server_id-change re-homing + its Watchdog backstop.
//
// A SymBot database always holds exactly ONE live server_id: it is derived from the database's own `server`
// collection, and the Hub refuses to start a second live worker on an id already in use, so two live instances
// never share one database. So when an instance's server_id changes (a "Reset server ID", or a restore that
// re-mints it), ANY scoped row still under a FOREIGN id — present, but neither the current id nor blank — is
// this instance's own, stranded by the previous id; rehomeScopedIdentity sweeps them all to the current id. One
// path serves a standalone and a Hub worker alike. Certain collections are deliberately left: 'server'
// (identity), audit_log/audit_checkpoint (per-server_id hash chain), schedules (Scheduler re-homes them,
// singleton-aware), ai_learning (server_id-agnostic). Blank rows are left for each collection's own blank→current
// adoption. Unscoped collections (deals, bots) have NO server_id field and must never be given one.

const assert = require('assert');
const System = require('../../app/System.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

// In-memory mock of the mongo db handle the functions use. updateMany/countDocuments here FAITHFULLY reproduce
// MongoDB's operator semantics — critically, that `$nin` matches a document whose field is MISSING (Mongo treats
// a missing field as "not in" the array), and that `$exists: true` is what excludes those missing-field docs.
// This is what makes the "deals/bots never given a server_id" assertions a real regression guard: drop the
// `$exists: true` from the production filter and these tests fail, exactly as production would misbehave.
function mockDb(data) {
	const selects = (row, cond) => {
		const has = Object.prototype.hasOwnProperty.call(row, 'server_id');
		if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
			if (cond.$exists === true && !has) { return false; }       // $exists:true → a missing field is excluded
			if (Array.isArray(cond.$nin)) {
				if (!has) { return true; }                             // Mongo: $nin MATCHES a missing field
				return !cond.$nin.includes(row.server_id);
			}
			return true;                                               // only $exists given
		}
		return has && row.server_id === cond;                          // scalar equality never matches a missing field
	};
	return {
		listCollections: () => ({ toArray: async () => Object.keys(data).map(name => ({ name })) }),
		collection: (name) => ({
			updateMany: async (filter, update) => {
				const rows = data[name] || [];
				let modifiedCount = 0;
				for (const r of rows) { if (selects(r, filter.server_id)) { r.server_id = update.$set.server_id; modifiedCount++; } }
				return { modifiedCount };
			},
			countDocuments: async (filter) => (data[name] || []).filter(r => selects(r, filter.server_id)).length,
		}),
	};
}

(async () => {

	System.init({ Common: { logger: () => {}, uuidv4: () => 'x' } });

	// ── rehomeScopedIdentityOnDb: the production foreign-id sweep, exactly as boot calls it ─────────────────
	const data = {
		signal_activity:  [ { server_id: 'OLD1' }, { server_id: 'OLD2' }, { server_id: 'CUR' }, { server_id: '' } ],
		ai_conversations: [ { server_id: 'OLD1' } ],
		api_keys:         [ { server_id: 'OLD1' } ],
		schedule_runs:    [ { server_id: 'OLD1' } ],   // swept — run history follows the instance
		audit_log:        [ { server_id: 'OLD1' } ],   // skipped — hash chain
		audit_checkpoint: [ { server_id: 'OLD1' } ],   // skipped
		schedules:        [ { server_id: 'OLD1' } ],   // skipped — Scheduler owns these (singleton-aware)
		server:           [ { server_id: 'OLD1' } ],   // skipped — identity
		ai_learning:      [ {} ],                       // skipped — no server_id anyway
		deals:            [ { dealId: 'z' }, { dealId: 'y' } ],   // MONEY-PATH — skipped by name AND unscoped
		bots:             [ { botId: 'b1' } ],                    // MONEY-PATH — skipped by name AND unscoped
		sessions:         [ { sid: 's1' } ],                      // UNSCOPED, NOT skip-listed → guarded only by $exists:true
	};

	const r = await System.rehomeScopedIdentityOnDb(mockDb(data), 'CUR');
	ok(r.moved === 5, 'sweep moves every foreign-id row in scoped collections (signal x2 + ai_conversations + api_keys + schedule_runs = 5; the CUR and blank signal rows and all skipped/unscoped collections are untouched) = ' + r.moved);
	ok(data.signal_activity.filter(x => x.server_id === 'CUR').length === 3, 'both foreign signal rows now CUR (3 total incl. the pre-existing CUR)');
	ok(data.signal_activity.some(x => x.server_id === ''), 'the blank row is NOT swept (adoptLegacyRows owns blank→current)');
	ok(data.schedule_runs[0].server_id === 'CUR', 'schedule_runs foreign id is re-homed (run history follows the instance)');
	ok(data.audit_log[0].server_id === 'OLD1', 'audit_log NOT re-homed (per-server_id hash chain preserved)');
	ok(data.audit_checkpoint[0].server_id === 'OLD1', 'audit_checkpoint NOT re-homed');
	ok(data.schedules[0].server_id === 'OLD1', 'schedules NOT re-homed here (Scheduler handles them, singleton-aware)');
	ok(data.server[0].server_id === 'OLD1', 'server identity row NOT touched');
	// Money-path guarantee: the trading collections are skip-listed, so this boot task never writes to them.
	ok(data.deals.every(x => !Object.prototype.hasOwnProperty.call(x, 'server_id')), 'deals (money-path) are NEVER touched — skip-listed');
	ok(data.bots.every(x => !Object.prototype.hasOwnProperty.call(x, 'server_id')), 'bots (money-path) are NEVER touched — skip-listed');
	// General $exists:true guard (regression guard for the $nin-matches-missing-field bug) on a non-skip-listed
	// unscoped collection: without $exists:true, the sweep would ADD a stray server_id here.
	ok(data.sessions.every(x => !Object.prototype.hasOwnProperty.call(x, 'server_id')), 'sessions (unscoped, not skip-listed) are NEVER given a server_id — $exists:true excludes missing-field docs');

	// Guards on the public entry point (these return before any DB access).
	ok((await System.rehomeScopedIdentity(null)).moved === 0, 'no current id → no-op');
	ok((await System.rehomeScopedIdentity('')).moved === 0, 'blank current id → no-op');

	// A clean database (everything already current or blank) → nothing moves (idempotent every-boot re-run).
	const clean = { signal_activity: [ { server_id: 'CUR' }, { server_id: '' } ], deals: [ { dealId: 'z' } ] };
	const r2 = await System.rehomeScopedIdentityOnDb(mockDb(clean), 'CUR');
	ok(r2.moved === 0, 'a clean database is a no-op (idempotent)');
	ok(clean.deals.every(x => !Object.prototype.hasOwnProperty.call(x, 'server_id')), 'clean run still never touches unscoped deals');

	// ── strandedScopedRowsCheck (Watchdog): flags a previous-id row, for standalone AND Hub alike ──────────
	const stranded = {
		signal_activity: [ { server_id: 'OLD' }, { server_id: 'CUR' } ],
		ai_conversations: [ { server_id: 'CUR' } ],
		deals: [ { dealId: 'z' } ],   // unscoped — must never count as stranded
	};

	// Standalone (no worker_data) with a row under a previous id → finding; unscoped deals excluded.
	System.init({ appData: { server_id: 'CUR' }, DB: { mongoose: { connection: { db: mockDb(stranded) } } }, Common: { logger: () => {}, uuidv4: () => 'x' } });
	const f = await System.strandedScopedRowsCheck();
	ok(f && f.action === 'watchdog.stranded_scoped_rows' && /signal_activity\(1\)/.test(f.detail) && !/deals/.test(f.detail), 'standalone: flags the 1 stranded signal_activity row, and does NOT count unscoped deals');

	// A Hub worker ALSO flags: its database likewise holds one live id, so a foreign id is stranded, not a sibling.
	System.init({ appData: { server_id: 'CUR', worker_data: { id: 'w1' } }, DB: { mongoose: { connection: { db: mockDb(stranded) } } }, Common: { logger: () => {}, uuidv4: () => 'x' } });
	const fh = await System.strandedScopedRowsCheck();
	ok(fh && fh.action === 'watchdog.stranded_scoped_rows' && /signal_activity\(1\)/.test(fh.detail), 'hub worker: also flags the stranded row (one live id per database, so a foreign id is never a sibling)');

	// All rows current → no finding.
	System.init({ appData: { server_id: 'CUR' }, DB: { mongoose: { connection: { db: mockDb({ signal_activity: [ { server_id: 'CUR' } ] }) } } }, Common: { logger: () => {}, uuidv4: () => 'x' } });
	ok((await System.strandedScopedRowsCheck()) === null, 'all rows current → no finding');

	console.log('RehomeScopedIdentity: ' + passed + ' assertions passed');
	process.exit(0);
})().catch((e) => { console.error('RehomeScopedIdentity FAIL: ' + (e && e.stack || e)); process.exit(1); });
