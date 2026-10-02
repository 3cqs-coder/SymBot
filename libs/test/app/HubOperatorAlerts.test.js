'use strict';

// Phase 2 Tier A — the Hub's operator alerting (libs/app/Hub/Main.js: notifyOperator / alertOnWatchdogFindings).
// The crash supervisor and the Watchdog already DETECT unmanaged-money conditions (an instance the supervisor gave
// up on after its restart cap, orphaned/duplicate/half-started deals) but only logged + audited them, where they
// are easy to miss. Tier A ESCALATES them to the Hub's native dashboard notification + audit, DEDUPED so a
// persistent condition can't flood every sweep. These tests pin: an alert pushes to dashboard + audit; the same
// condition is deduped within the cooldown and re-alerts after it; only alert-worthy Watchdog actions alert; and
// the helpers are best-effort (a missing Common never throws). Auto-restart is intentionally NOT here — the
// "dead" instances the liveness check flags are the ones the supervisor stopped restarting, so alerting is correct.
//
// process.exit(0) at the end: requiring Main.js pulls in modules that may register timers.

const assert = require('assert');
const HubMain = require('../../app/Hub/Main.js');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

function mockShare() {
	const calls = { socket: [], audit: [] };
	return {
		calls,
		Common: {
			sendSocketMsg: (d) => { calls.socket.push(d); },
			auditEvent: (cat, action, target, detail) => { calls.audit.push({ cat, action, target, detail }); }
		}
	};
}

console.log('\nHub operator alerts (Phase 2 Tier A):');

test('notifyOperator pushes to the dashboard + audit and returns true', () => {
	HubMain._resetOperatorAlerts();
	const s = mockShare();
	const did = HubMain.notifyOperator(s, { subject: 'Give-up', message: 'm', action: 'hub.restart_cap_exhausted', target: 'i1', dedupeKey: 'k1', now: 1000, cooldownMs: 1000 });
	assert.strictEqual(did, true, 'alerted');
	assert.strictEqual(s.calls.socket.length, 1, 'exactly one dashboard push');
	assert.strictEqual(s.calls.socket[0].room, 'notifications', 'pushed to the notifications room');
	assert.ok(/Give-up/.test(s.calls.socket[0].message), 'push carries the subject');
	assert.strictEqual(s.calls.audit.length, 1, 'exactly one audit event');
	assert.strictEqual(s.calls.audit[0].action, 'hub.restart_cap_exhausted', 'audit carries the action');
});

test('notifyOperator dedupes the same key within the cooldown', () => {
	HubMain._resetOperatorAlerts();
	const s = mockShare();
	const a = HubMain.notifyOperator(s, { subject: 'X', dedupeKey: 'k', now: 1000, cooldownMs: 1000 });
	const b = HubMain.notifyOperator(s, { subject: 'X', dedupeKey: 'k', now: 1500, cooldownMs: 1000 }); // within cooldown
	assert.strictEqual(a, true, 'first alerts');
	assert.strictEqual(b, false, 'second within cooldown is deduped');
	assert.strictEqual(s.calls.socket.length, 1, 'only one push for the persistent condition');
});

test('notifyOperator re-alerts once the cooldown elapses', () => {
	HubMain._resetOperatorAlerts();
	const s = mockShare();
	HubMain.notifyOperator(s, { subject: 'X', dedupeKey: 'k', now: 1000, cooldownMs: 1000 });
	const c = HubMain.notifyOperator(s, { subject: 'X', dedupeKey: 'k', now: 2001, cooldownMs: 1000 }); // past cooldown
	assert.strictEqual(c, true, 're-alerts after the cooldown window');
	assert.strictEqual(s.calls.socket.length, 2, 'a second push after the window');
});

test('notifyOperator is best-effort — a missing Common never throws', () => {
	assert.strictEqual(HubMain.notifyOperator({}, { subject: 'X', dedupeKey: 'z1', now: 1, cooldownMs: 1 }), false, 'no Common → no alert, no throw');
	assert.strictEqual(HubMain.notifyOperator(null, { subject: 'X', dedupeKey: 'z2' }), false, 'null share (module shareData unset in test) → false');
});

test('alertOnWatchdogFindings alerts only on alert-worthy actions', () => {
	HubMain._resetOperatorAlerts();
	const s = mockShare();
	const findings = [
		{ action: 'watchdog.instance_down', target: 'SymSync 80', detail: 'not running' },
		{ action: 'watchdog.deal_missing_orders', target: '2', detail: 'half-started' },
		{ action: 'watchdog.orphaned_open_deals', target: '1', detail: 'orphan' },
		{ action: 'watchdog.route_gating', target: '', detail: 'not alertable' },
		{ action: 'watchdog.default_password', target: '', detail: 'not alertable' }
	];
	const n = HubMain.alertOnWatchdogFindings(s, findings);
	assert.strictEqual(n, 3, 'exactly the three money-unmanaged findings alerted (instance_down + two deal conditions)');
	assert.strictEqual(s.calls.socket.length, 3, 'three dashboard pushes');
});

test('alertOnWatchdogFindings dedupes a persistent finding across sweeps', () => {
	HubMain._resetOperatorAlerts();
	const s = mockShare();
	const f = [{ action: 'watchdog.deal_missing_orders', target: '2', detail: 'x' }];
	const n1 = HubMain.alertOnWatchdogFindings(s, f);
	const n2 = HubMain.alertOnWatchdogFindings(s, f); // same condition again immediately (next sweep)
	assert.strictEqual(n1, 1, 'first sweep alerts');
	assert.strictEqual(n2, 0, 'the same condition on the next sweep is not re-alerted');
});

test('alertOnWatchdogFindings handles empty / null gracefully', () => {
	const s = mockShare();
	assert.strictEqual(HubMain.alertOnWatchdogFindings(s, []), 0, 'no findings → nothing alerted');
	assert.strictEqual(HubMain.alertOnWatchdogFindings(s, null), 0, 'null → nothing alerted, no throw');
});

console.log('\nHubOperatorAlerts: ' + passed + ' passed' + (failed ? (', ' + failed + ' failed') : ''));
process.exit(failed ? 1 : 0);
