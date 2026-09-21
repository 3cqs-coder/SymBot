'use strict';

// Contract tests for the small numeric helpers that live in Common (toNum, countDecimals) — the
// shared math home DCABot and the pure DCA strategy helpers (signalBot / priceGuard / stopLoss) use.

const assert = require('assert');
const { toNum, countDecimals } = require('../../app/Common.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// ── toNum ──────────────────────────────────────────────────────────────────────
ok(toNum(5) === 5, 'a number passes through');
ok(toNum('3.14') === 3.14, 'a decimal string is coerced');
ok(toNum(0) === 0, 'zero is a valid number (not null)');
ok(toNum(-2.5) === -2.5, 'a negative decimal is coerced');
ok(toNum(undefined) === null, 'undefined → null');
ok(toNum(null) === null, 'null → null');
ok(toNum('') === null, 'empty string → null');
ok(toNum('abc') === null, 'a non-numeric string → null');
ok(toNum(NaN) === null, 'NaN → null');
ok(toNum(Infinity) === null, 'Infinity → null');
ok(toNum(-Infinity) === null, '-Infinity → null');

// ── countDecimals — robust to exponential string form (the filterMinMovement crash fix) ──
ok(countDecimals(0.0025) === 4, '0.0025 → 4 decimals (matches the old non-exponential behavior)');
ok(countDecimals(0.1) === 1, '0.1 → 1');
ok(countDecimals(0.000001) === 6, '0.000001 → 6 (still decimal notation at 1e-6)');
ok(countDecimals(5) === 0, 'an integer → 0');
ok(countDecimals(0) === 0, 'zero → 0');
// the bug case: sub-1e-6 magnitudes stringify as "2e-7" — the old code threw here
ok((2e-7).toString().split('.')[1] === undefined, 'sanity: 2e-7 stringifies with NO decimal point (why the old code threw)');
ok(countDecimals(2e-7) === 7, '2e-7 → 7 decimals (no throw)');
ok(countDecimals(9e-7) === 7, '9e-7 → 7');
ok(countDecimals(1.5e-8) === 9, '1.5e-8 → 9 (mantissa fraction + exponent)');
ok(countDecimals(3.2e-7) === 8, '3.2e-7 → 8');
ok(countDecimals(NaN) === 0, 'NaN → 0 (never throws)');
ok(countDecimals(null) === 0, 'null → 0');
ok(countDecimals(Infinity) === 0, 'Infinity → 0');

console.log('CommonMath: ' + passed + ' assertions passed');

// Common holds no lingering handle at require time, but exit explicitly to be safe.
process.exit(0);