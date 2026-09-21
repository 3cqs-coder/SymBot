'use strict';

// Pins the CONTINUOUS-monitoring behavior of the Watchdog, which is designed to run autonomously for the life
// of the process, not only once at boot. The continuous driver lives in the Watchdog engine itself (a general
// "watch anything" system), not in a webserver-layer wrapper:
//   * Watchdog.resolveIntervalMs — the periodic cadence (default, operator override, safe guards).
//   * Watchdog.run periodic quiet mode — a clean periodic sweep reports nothing (so continuous monitoring never
//     floods the log/audit), while a clean boot sweep still logs its all-clear confirmation.
//   * Watchdog.evaluateInstanceLiveness — the Hub liveness decision that catches an enabled instance which is
//     silently not running (crashed out of restart, nothing rescheduling it), while excluding disabled, live,
//     and mid-restart-backoff instances.

const assert = require('assert');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok   - ' + msg); } else { failed++; process.exitCode = 1; console.log('  FAIL - ' + msg); } }

const Watchdog = require('../../app/Watchdog.js');

// ── Watchdog.resolveIntervalMs (continuous cadence) ──────────────────────────────
ok(Watchdog.resolveIntervalMs({}) === Watchdog.DEFAULT_INTERVAL_MS, 'no override → default interval');
ok(Watchdog.resolveIntervalMs() === Watchdog.DEFAULT_INTERVAL_MS, 'no shareData → default interval (safe)');
ok(Watchdog.resolveIntervalMs({ appData: { watchdog_interval_secs: 120 } }) === 120000, 'override of 120s → 120000ms');
ok(Watchdog.resolveIntervalMs({ appData: { watchdog_interval_secs: 0 } }) === Watchdog.DEFAULT_INTERVAL_MS, 'zero override → default (never 0)');
ok(Watchdog.resolveIntervalMs({ appData: { watchdog_interval_secs: -5 } }) === Watchdog.DEFAULT_INTERVAL_MS, 'negative override → default');
ok(Watchdog.resolveIntervalMs({ appData: { watchdog_interval_secs: 'nope' } }) === Watchdog.DEFAULT_INTERVAL_MS, 'non-numeric override → default');
ok(typeof Watchdog.startMonitor === 'function', 'Watchdog owns the continuous startMonitor (no separate webserver-layer driver)');

// ── evaluateInstanceLiveness ─────────────────────────────────────────────────────
const E = Watchdog.evaluateInstanceLiveness;

// An enabled instance with no live worker and not mid-restart → flagged.
let f = E([{ id: 'a', name: 'Alpha', enabled: true }], new Set(), new Set());
ok(f.length === 1 && f[0].action === 'watchdog.instance_down' && f[0].target === 'Alpha', 'enabled + no worker + not pending → flagged as down');

// Running instance → not flagged.
f = E([{ id: 'a', name: 'Alpha', enabled: true }], new Set(['a']), new Set());
ok(f.length === 0, 'a live worker → not flagged');

// Mid restart-backoff → not flagged (the supervisor is handling it).
f = E([{ id: 'a', name: 'Alpha', enabled: true }], new Set(), new Set(['a']));
ok(f.length === 0, 'scheduled for restart → not flagged');

// Disabled instance → never flagged even with no worker.
f = E([{ id: 'a', name: 'Alpha', enabled: false }], new Set(), new Set());
ok(f.length === 0, 'disabled instance → not flagged');

// enabled omitted defaults to "expected running" (only enabled === false is excluded).
f = E([{ id: 'a', name: 'Alpha' }], new Set(), new Set());
ok(f.length === 1, 'enabled flag omitted → treated as enabled and flagged when down');

// Mixed set: one down, one up, one disabled, one pending → exactly one finding (the down one).
f = E([
	{ id: 'a', name: 'Down',     enabled: true },
	{ id: 'b', name: 'Up',       enabled: true },
	{ id: 'c', name: 'Disabled', enabled: false },
	{ id: 'd', name: 'Backoff',  enabled: true }
], new Set(['b']), new Set(['d']));
ok(f.length === 1 && f[0].target === 'Down', 'mixed fleet → only the genuinely-down enabled instance is flagged');

// Robustness: bad inputs never throw and never false-alarm.
ok(E(null, new Set(), new Set()).length === 0, 'non-array instances → no findings');
ok(E([{ enabled: true }], new Set(), new Set()).length === 0, 'instance with no id → skipped');
ok(E([{ id: 'a', enabled: true }], ['a'], []).length === 0, 'liveIds accepts a plain array too');

// ── Watchdog.run periodic quiet mode vs verbose boot ─────────────────────────────
(async () => {

	// A shareData with NO checks-relevant wiring: every built-in check guards on missing pieces and returns
	// null/[], so a clean sweep is produced. We capture what gets logged/audited.
	function makeShareData(sink) {
		return {
			appData: {},   // no hub_config, no password → liveness + default_password + others no-op
			Common: {
				logger: function (m) { sink.logs.push(String(m)); },
				auditEvent: function (a, ac) { sink.audits.push(String(ac)); }
			}
			// no workerMap / HubMain → liveness no-ops; no Mongo → deal checks guard out
		};
	}

	const bootSink = { logs: [], audits: [] };
	await Watchdog.run(makeShareData(bootSink), { label: 'test', periodic: false });
	const bootOk = bootSink.audits.some((a) => a === 'watchdog.ok') || bootSink.logs.some((l) => /all integrity checks passed/.test(l));
	ok(bootOk, 'a clean BOOT sweep logs/audits its all-clear confirmation');

	const periodicSink = { logs: [], audits: [] };
	await Watchdog.run(makeShareData(periodicSink), { label: 'test', periodic: true });
	const periodicQuiet = !periodicSink.audits.includes('watchdog.ok') && !periodicSink.logs.some((l) => /all integrity checks passed/.test(l));
	ok(periodicQuiet, 'a clean PERIODIC sweep stays quiet (no all-clear spam)');

	console.log('\n' + passed + ' passed, ' + failed + ' failed');
	process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('WatchdogContinuous FAIL: ' + (e && e.stack || e)); process.exit(1); });
