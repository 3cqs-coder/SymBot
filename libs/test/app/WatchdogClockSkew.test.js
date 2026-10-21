'use strict';

// Pure tests for Watchdog.evaluateClockSkew — the clock-drift decision behind the clock_skew watchdog. A
// drifted clock gets signed exchange requests rejected (Binance -1021 "timestamp ahead of server time"), which
// is what paused real buys/sells on a WSL machine whose clock ran ~1s fast. Offline/deterministic: an offset
// in ms goes in, a verdict comes out. Covers both directions, the threshold boundary, and custom thresholds.

const assert = require('assert');
const Watchdog = require('../../app/Watchdog.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

const f = Watchdog.evaluateClockSkew;

// ── within tolerance → null (no finding) ──
ok(f(0) === null, '0ms → null');
ok(f(500) === null, '+500ms (within 1000) → null');
ok(f(-800) === null, '-800ms (within 1000) → null');
ok(f(1000) === null, 'exactly 1000ms → null (boundary is inclusive-tolerant)');

// ── ahead beyond tolerance → finding, ahead:true (the Binance -1021 case) ──
let r = f(1500);
ok(r && r.ahead === true, '+1500ms → finding, ahead:true');
ok(r && r.severe === false, '+1500ms is not "severe" (<= 3×)');
ok(/AHEAD of/.test(r.detail) && /1500ms/.test(r.detail), 'detail names the direction and magnitude');

// ── behind beyond tolerance → finding, ahead:false ──
r = f(-2000);
ok(r && r.ahead === false, '-2000ms → finding, ahead:false');
ok(/behind/.test(r.detail), 'detail says behind');

// ── severe when far past the limit (> 3×) ──
r = f(4000);
ok(r && r.severe === true, '+4000ms (> 3×1000) → severe:true');

// ── custom threshold ──
ok(f(600, 500) !== null, '+600ms with a 500ms threshold → finding');
ok(f(600, 1000) === null, '+600ms with a 1000ms threshold → null');
ok(f(1500, 0) !== null && f(1500, -5) !== null, 'a non-positive custom threshold falls back to the 1000ms default (still flags +1500)');

// ── non-finite / garbage → null, never throws ──
ok(f(NaN) === null, 'NaN → null');
ok(f('abc') === null, 'non-numeric string → null');
ok(f(undefined) === null, 'undefined → null');
ok(f(null) === null, 'null → null');

console.log('WatchdogClockSkew: ' + passed + ' assertions passed');
process.exit(0);
