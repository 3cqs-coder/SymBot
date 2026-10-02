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

// "Expected to be running" mirrors what the Hub auto-starts on boot: enabled AND start_boot. An auto-start
// instance with no live worker and not mid-restart → flagged.
let f = E([{ id: 'a', name: 'Alpha', enabled: true, start_boot: true }], new Set(), new Set());
ok(f.length === 1 && f[0].action === 'watchdog.instance_down' && f[0].target === 'Alpha', 'enabled + start_boot + no worker + not pending → flagged as down');

// Running instance → not flagged.
f = E([{ id: 'a', name: 'Alpha', enabled: true, start_boot: true }], new Set(['a']), new Set());
ok(f.length === 0, 'a live worker → not flagged');

// Mid restart-backoff → not flagged (the supervisor is handling it).
f = E([{ id: 'a', name: 'Alpha', enabled: true, start_boot: true }], new Set(), new Set(['a']));
ok(f.length === 0, 'scheduled for restart → not flagged');

// Disabled instance → never flagged even with no worker.
f = E([{ id: 'a', name: 'Alpha', enabled: false, start_boot: true }], new Set(), new Set());
ok(f.length === 0, 'disabled instance → not flagged');

// Enabled but start_boot=false → the Hub does NOT auto-start it on boot, so it is intentionally not running
// after a restart and must NOT be flagged. (This is the false-alarm the fix removes: a paper/standby instance
// left enabled but not set to start on boot was flagged as "down" on every Hub restart.)
f = E([{ id: 'a', name: 'Paper', enabled: true, start_boot: false }], new Set(), new Set());
ok(f.length === 0, 'enabled but start_boot=false → not auto-started, not flagged');

// start_boot omitted (falsy) → also not auto-started → not flagged.
f = E([{ id: 'a', name: 'Alpha', enabled: true }], new Set(), new Set());
ok(f.length === 0, 'start_boot omitted → treated as not-auto-started and not flagged');

// Mixed set: an auto-start down instance, one up, one disabled, one in backoff, and one enabled-but-not-start_boot
// → exactly one finding (only the genuinely-down auto-start instance).
f = E([
	{ id: 'a', name: 'Down',      enabled: true,  start_boot: true },
	{ id: 'b', name: 'Up',        enabled: true,  start_boot: true },
	{ id: 'c', name: 'Disabled',  enabled: false, start_boot: true },
	{ id: 'd', name: 'Backoff',   enabled: true,  start_boot: true },
	{ id: 'e', name: 'Paper',     enabled: true,  start_boot: false }
], new Set(['b']), new Set(['d']));
ok(f.length === 1 && f[0].target === 'Down', 'mixed fleet → only the genuinely-down auto-start instance is flagged');

// Robustness: bad inputs never throw and never false-alarm.
ok(E(null, new Set(), new Set()).length === 0, 'non-array instances → no findings');
ok(E([{ enabled: true, start_boot: true }], new Set(), new Set()).length === 0, 'instance with no id → skipped');
ok(E([{ id: 'a', enabled: true, start_boot: true }], ['a'], []).length === 0, 'liveIds accepts a plain array too');

// A spawned-but-not-yet-online instance is handed to the check in the "not down" set (the Hub merges spawn-
// pending workers with crash-restart-pending), so it is not flagged while it is still booting.
f = E([{ id: 'a', name: 'Booting', enabled: true, start_boot: true }], new Set(), new Set(['a']));
ok(f.length === 0, 'a spawned-but-not-online instance (in the not-down set) → not flagged');

// ── livenessStartupGraceMs — the boot window during which a not-yet-up instance is treated as booting, not down.
const G = Watchdog.livenessStartupGraceMs;
ok(G(0) === 30000, 'grace with no instances → base buffer');
ok(G(2) === 32000, 'grace scales ~1s per instance (the boot stagger): 2 instances → base + 2s');
ok(G(30) === 60000, '30 instances → base + 30s');
ok(G('x') === 30000 && G(-5) === 30000, 'invalid/negative count → base buffer, never below it');

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
