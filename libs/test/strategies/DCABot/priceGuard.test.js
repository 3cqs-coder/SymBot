'use strict';

/**
 * Tests for the price sanity guard.
 *
 * Covers the exact bug (2026-08-12): a nonzero-but-implausible price returned by
 * fetchTicker during an exchange auth storm must be rejected so the deal HOLDS
 * instead of closing at an impossible profit. Also proves the fail-safe cases:
 * the zero/invalid price still defers to the existing invalid-price guard, and a
 * legitimately deep-averaged-down price is NOT blocked.
 */

const assert = require('assert');
const { evaluatePriceSanity, DEFAULT_HIGH_RATIO, DEFAULT_LOW_RATIO } = require('../../../strategies/DCABot/priceGuard.js');

let passed = 0;

function test(name, fn) {

	try {

		fn();
		passed++;
		console.log('  ok   - ' + name);
	}
	catch (e) {

		process.exitCode = 1;
		console.log('  FAIL - ' + name + '\n         ' + e.message);
	}
}


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nNormal prices pass (deal follows / closes as usual):');

test('price ~= average (following) -> plausible', () => {
	const r = evaluatePriceSanity({ price: 100, reference: 100 });
	assert.strictEqual(r.plausible, true);
	assert.strictEqual(r.reason, 'ok');
});

test('take-profit price just above average (~1%) -> plausible (closes normally)', () => {
	const r = evaluatePriceSanity({ price: 101, reference: 100 });
	assert.strictEqual(r.plausible, true);
});

test('high take-profit config (1.5x average) -> plausible', () => {
	const r = evaluatePriceSanity({ price: 150, reference: 100 });
	assert.strictEqual(r.plausible, true);
});

test('exactly at the high band (2.0x) -> plausible (boundary inclusive)', () => {
	const r = evaluatePriceSanity({ price: 200, reference: 100 });
	assert.strictEqual(r.plausible, true);
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nImplausible HIGH prices rejected (the bug — deal must hold, not close):');

test('smallest observed garbage ratio (2.8x) -> REJECTED', () => {
	const r = evaluatePriceSanity({ price: 280, reference: 100 });
	assert.strictEqual(r.plausible, false);
	assert.strictEqual(r.reason, 'above_band');
});

test('100x spike -> REJECTED', () => {
	const r = evaluatePriceSanity({ price: 10000, reference: 100 });
	assert.strictEqual(r.plausible, false);
	assert.strictEqual(r.reason, 'above_band');
});

test('1000x spike -> REJECTED', () => {
	const r = evaluatePriceSanity({ price: 100000, reference: 100 });
	assert.strictEqual(r.plausible, false);
	assert.strictEqual(r.reason, 'above_band');
});

test('real WAL incident: 0.0238 -> 65.11 (~2735x) -> REJECTED', () => {
	const r = evaluatePriceSanity({ price: 65.11, reference: 0.0238 });
	assert.strictEqual(r.plausible, false);
	assert.strictEqual(r.reason, 'above_band');
	assert.ok(r.ratio > 2000);
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nImplausible LOW prices rejected (garbage-low would trigger a bad safety buy):');

test('price at 1/100 of average -> REJECTED', () => {
	const r = evaluatePriceSanity({ price: 1, reference: 100 });
	assert.strictEqual(r.plausible, false);
	assert.strictEqual(r.reason, 'below_band');
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nLegitimate deep averaging-down is NOT blocked:');

test('50% drawdown (0.5x average) -> plausible', () => {
	const r = evaluatePriceSanity({ price: 50, reference: 100 });
	assert.strictEqual(r.plausible, true);
});

test('85% drawdown (0.15x average) -> plausible (still within low band)', () => {
	const r = evaluatePriceSanity({ price: 15, reference: 100 });
	assert.strictEqual(r.plausible, true);
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nFail-safe: never overrides the existing zero/invalid-price guard:');

test('price 0 -> plausible=true, reason invalid_price (defers to zero guard)', () => {
	const r = evaluatePriceSanity({ price: 0, reference: 100 });
	assert.strictEqual(r.plausible, true);
	assert.strictEqual(r.reason, 'invalid_price');
});

test('price null -> plausible=true, deferred', () => {
	const r = evaluatePriceSanity({ price: null, reference: 100 });
	assert.strictEqual(r.plausible, true);
	assert.strictEqual(r.reason, 'invalid_price');
});

test('no reference yet (base order) -> plausible=true, reason no_reference', () => {
	const r = evaluatePriceSanity({ price: 12345, reference: null });
	assert.strictEqual(r.plausible, true);
	assert.strictEqual(r.reason, 'no_reference');
});

test('reference 0 -> plausible=true, not judged', () => {
	const r = evaluatePriceSanity({ price: 12345, reference: 0 });
	assert.strictEqual(r.plausible, true);
	assert.strictEqual(r.reason, 'no_reference');
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nConfigurable band:');

test('custom high ratio 5x: 3x passes, 6x rejected', () => {
	assert.strictEqual(evaluatePriceSanity({ price: 300, reference: 100, maxHighRatio: 5 }).plausible, true);
	assert.strictEqual(evaluatePriceSanity({ price: 600, reference: 100, maxHighRatio: 5 }).plausible, false);
});

test('invalid ratio config falls back to defaults', () => {
	const r = evaluatePriceSanity({ price: 280, reference: 100, maxHighRatio: 0 });
	assert.strictEqual(r.high_ratio, DEFAULT_HIGH_RATIO);
	assert.strictEqual(r.plausible, false);
});

test('defaults are 2x (high) and 10x (low)', () => {
	assert.strictEqual(DEFAULT_HIGH_RATIO, 2);
	assert.strictEqual(DEFAULT_LOW_RATIO, 10);
});


// ─────────────────────────────────────────────────────────────────────────────
// Model the engine's sell gate so the fix's behavior is asserted, not just the
// pure predicate: the auto-sell fires only when price >= target AND the price is
// trusted (!cancelOnly). An implausible price sets cancelOnly, so the deal holds.
console.log('\nSell-gate decision (implausible -> hold; normal -> close):');

function wouldAutoSell({ price, reference, target }) {
	const sanity = evaluatePriceSanity({ price, reference });
	const cancelOnly = !sanity.plausible;           // engine sets cancelOnly on implausible price
	return (price >= target) && !cancelOnly;        // the guarded auto-sell condition
}

test('garbage high price crosses target but is HELD (no sell)', () => {
	// WAL: target ~= 0.024, garbage price 65.11 crosses it, but must not sell
	assert.strictEqual(wouldAutoSell({ price: 65.11, reference: 0.0238, target: 0.0241 }), false);
});

test('normal take-profit still closes (price >= target, plausible)', () => {
	assert.strictEqual(wouldAutoSell({ price: 101, reference: 100, target: 100.5 }), true);
});

test('normal below-target price does not sell (unchanged behavior)', () => {
	assert.strictEqual(wouldAutoSell({ price: 99, reference: 100, target: 100.5 }), false);
});


console.log('\n' + passed + ' assertions passed' + (process.exitCode ? ' (with failures above)' : ', all green'));