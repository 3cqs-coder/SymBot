'use strict';

// Pins the single Hub-aware reboot (System.rebootAfterOp) shared by the rollback, system-update, and DB-restore
// flows. Under the Hub each instance is a worker_thread in one process, and a bare exit 0 is treated as an
// intentional clean shutdown that is NOT respawned — so a worker MUST ask the parent to restart the whole Hub
// (WORKER_TO_HUB.SHUTDOWN_HUB) rather than exit locally. Standalone (no parent) must fall back to the local
// shutdown so the process manager restarts. This exact drift — restore omitting the Hub-aware branch — left a
// restored Hub instance permanently offline, so the contract is locked here for all three callers.

const assert = require('assert');
const System = require('../../app/System.js');
const { WORKER_TO_HUB } = require('../../app/Hub/MessageTypes.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function eq(a, b, m) { assert.strictEqual(a, b, m + ' (got ' + JSON.stringify(a) + ')'); passed++; }

(async () => {

	// ── Under the Hub: sendParentMsg succeeds → the parent restarts the Hub; NO local shutDown. ──
	let sent = null;
	let shutDownCalls = 0;
	System.init({
		Common: { sendParentMsg: async (msg) => { sent = msg; return { success: true }; }, logger: function () {} }
	}, function () { shutDownCalls++; });

	await System.rebootAfterOp();
	ok(sent && sent.type === WORKER_TO_HUB.SHUTDOWN_HUB, 'under the Hub it asks the parent to restart via SHUTDOWN_HUB');
	eq(shutDownCalls, 0, 'under the Hub it does NOT call the local shutdown (a bare exit 0 would not be respawned)');

	// ── Standalone: no parent (sendParentMsg reports success:false) → fall back to the local shutdown. ──
	sent = null;
	shutDownCalls = 0;
	System.init({
		Common: { sendParentMsg: async (msg) => { sent = msg; return { success: false }; }, logger: function () {} }
	}, function () { shutDownCalls++; });

	await System.rebootAfterOp();
	ok(sent && sent.type === WORKER_TO_HUB.SHUTDOWN_HUB, 'standalone still ATTEMPTS the parent message first');
	eq(shutDownCalls, 1, 'standalone falls back to the local shutdown exactly once (process manager restarts it)');

	// ── Defensive: a null/malformed parent reply is treated as "no parent" → local shutdown, no throw. ──
	shutDownCalls = 0;
	System.init({
		Common: { sendParentMsg: async () => null, logger: function () {} }
	}, function () { shutDownCalls++; });

	await System.rebootAfterOp();
	eq(shutDownCalls, 1, 'a null parent reply falls back to the local shutdown (no throw)');

	console.log('RebootAfterOp: ' + passed + ' assertions passed');
	process.exit(0);
})().catch((e) => { console.error('RebootAfterOp test error:', e && e.stack || e); process.exit(1); });
