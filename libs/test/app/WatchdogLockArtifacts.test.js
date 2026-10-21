'use strict';

// Pure-helper tests for Watchdog.evaluateLockArtifacts — the orphaned-lock / temp-buildup monitor's decision
// logic. No filesystem and no real processes: `entries` and `now` are passed directly and isAlive/host are
// injected, so the test is deterministic and offline. Both directions are covered (flags AND stays quiet).

const assert = require('assert');
const Watchdog = require('../../app/Watchdog.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

const HOST = 'test-host';
const now = 1000000000000;
const TTL = 30 * 1000;

// pid 111 is "alive"; every other pid is dead.
const isAlive = (pid) => pid === 111;
const base = { isAlive, host: HOST, lockStaleMs: TTL * 4, tempCountMax: 5, tempStaleMs: 5 * 60 * 1000 };

// 1. All-clear: this host's lock held by a LIVE pid with a fresh timestamp, no temps → no finding.
ok(Watchdog.evaluateLockArtifacts(
	[ { name: 'a.lock', isLock: true, isTemp: false, mtimeMs: now, holder: { pid: 111, host: HOST, at: now - 5000 } } ],
	now, base
).length === 0, 'live same-host holder, fresh timestamp → no finding');

// 2. Orphaned lock: same host, DEAD pid, well past the stale window → one orphaned_lock finding.
const orphan = Watchdog.evaluateLockArtifacts(
	[ { name: 'b.lock', isLock: true, isTemp: false, mtimeMs: now, holder: { pid: 222, host: HOST, at: now - (TTL * 10) } } ],
	now, base
);
ok(orphan.length === 1 && orphan[0].action === 'watchdog.orphaned_lock' && orphan[0].target === 'b.lock', 'dead same-host holder past the stale window → orphaned_lock finding');

// 3. A dead-pid lock still WITHIN the stale window → no finding (a just-crashed holder a restart will reclaim).
ok(Watchdog.evaluateLockArtifacts(
	[ { name: 'c.lock', isLock: true, isTemp: false, mtimeMs: now, holder: { pid: 222, host: HOST, at: now - 1000 } } ],
	now, base
).length === 0, 'recent dead-pid lock (within stale window) → no finding');

// 4. A dead-pid lock on a DIFFERENT host is not this host's concern.
ok(Watchdog.evaluateLockArtifacts(
	[ { name: 'd.lock', isLock: true, isTemp: false, holder: { pid: 222, host: 'other-host', at: now - (TTL * 10) } } ],
	now, base
).length === 0, 'foreign-host lock → no finding');

// 5. Temp buildup: more than tempCountMax STALE temp files → one lock_temp_buildup finding.
const temps = [];
for (let i = 0; i < 7; i++) { temps.push({ name: '.beat.' + i, isLock: false, isTemp: true, mtimeMs: now - (10 * 60 * 1000) }); }
const buildup = Watchdog.evaluateLockArtifacts(temps, now, base);
ok(buildup.length === 1 && buildup[0].action === 'watchdog.lock_temp_buildup' && buildup[0].target === '7', '7 stale temps (>5) → lock_temp_buildup finding');

// 6. Fresh temps within the stale window never trip the buildup alert.
const freshTemps = [];
for (let i = 0; i < 7; i++) { freshTemps.push({ name: '.beat.' + i, isLock: false, isTemp: true, mtimeMs: now - 1000 }); }
ok(Watchdog.evaluateLockArtifacts(freshTemps, now, base).length === 0, 'fresh temps within the window → no buildup finding');

// 7. Empty / malformed input → no findings, never throws.
ok(Watchdog.evaluateLockArtifacts([], now, base).length === 0, 'empty entries → no findings');
ok(Watchdog.evaluateLockArtifacts(null, now, base).length === 0, 'null entries → no findings (guarded)');

console.log('WatchdogLockArtifacts: ' + passed + ' assertions passed');
process.exit(0);
