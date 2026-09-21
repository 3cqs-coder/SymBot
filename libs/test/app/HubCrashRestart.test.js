'use strict';

// Pins the money-adjacent crash-restart backoff of the Hub supervisor (libs/app/Hub/Main.js). When an instance
// worker crashes, the Hub reschedules it with exponential backoff, capped, and gives up after a fixed ceiling.
// Getting this wrong is a real-money risk in both directions: too-aggressive restarts hammer a crashing engine
// (and could resurrect one that should stay down), while a broken ceiling would let a hopeless instance flap
// forever. The delay/give-up decisions are pure functions (no shareData, no timers), so this locks the formula
// and the caps directly. Requiring Main.js has no side effects until init() is called, which this never does.

const assert = require('assert');
const Main = require('../../app/Hub/Main.js');

const BASE = Main.CRASH_RESTART_BASE_DELAY_MS;
const MAX = Main.CRASH_RESTART_MAX_DELAY_MS;
const CEIL = Main.CRASH_RESTART_MAX_ATTEMPTS;

let passed = 0;
function eq(a, b, m) { assert.strictEqual(a, b, m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); passed++; }
function ok(c, m) { assert.ok(c, m); passed++; }

// ── Tuning constants are the documented values ───────────────────────────────────
eq(BASE, 5000, 'base delay is 5s');
eq(MAX, 300000, 'max delay is 5 minutes');
eq(CEIL, 10, 'give-up ceiling is 10 attempts');

// ── Exponential backoff: BASE * 2^(attempt-1) ────────────────────────────────────
eq(Main.crashRestartDelay(1), 5000,  'attempt 1 → 5s');
eq(Main.crashRestartDelay(2), 10000, 'attempt 2 → 10s');
eq(Main.crashRestartDelay(3), 20000, 'attempt 3 → 20s');
eq(Main.crashRestartDelay(4), 40000, 'attempt 4 → 40s');
eq(Main.crashRestartDelay(5), 80000, 'attempt 5 → 80s');
eq(Main.crashRestartDelay(6), 160000, 'attempt 6 → 160s');

// ── The backoff is capped at MAX and never exceeds it, however high the attempt ───
eq(Main.crashRestartDelay(7), 300000, 'attempt 7 → capped at 5 min (320s would exceed MAX)');
eq(Main.crashRestartDelay(10), MAX, 'attempt 10 → still capped at MAX');
eq(Main.crashRestartDelay(50), MAX, 'a very high attempt is still capped at MAX (no overflow past the cap)');
ok(Main.crashRestartDelay(100) <= MAX, 'delay never exceeds MAX');

// The delay is monotonic up to the cap, then flat — never decreasing (a decreasing delay would restart a
// crashing engine faster the longer it fails).
let prev = 0;
for (let a = 1; a <= 20; a++) {
	const d = Main.crashRestartDelay(a);
	ok(d >= prev, 'delay is non-decreasing at attempt ' + a);
	prev = d;
}

// ── Give-up ceiling: attempts beyond the max stop the supervisor ─────────────────
eq(Main.crashRestartShouldGiveUp(1), false, 'attempt 1 does not give up');
eq(Main.crashRestartShouldGiveUp(CEIL), false, 'the ceiling attempt itself still runs (not > max)');
eq(Main.crashRestartShouldGiveUp(CEIL + 1), true, 'one past the ceiling gives up');
eq(Main.crashRestartShouldGiveUp(100), true, 'far past the ceiling gives up');

console.log('HubCrashRestart: ' + passed + ' assertions passed');
process.exit(0);
