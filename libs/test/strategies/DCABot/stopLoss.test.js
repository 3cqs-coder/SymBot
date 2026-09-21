'use strict';

/**
 * Tests for the stop-loss + move-to-breakeven guard.
 *
 * Proves the money decision in isolation: a stop fires only when price falls
 * to/through the effective level; the deal is NEVER stopped on missing/invalid
 * inputs (fail-safe); the break-even ratchet arms only at/above its profit trigger
 * and, once armed, never re-lowers the stop (monotonic). Also proves the disabled
 * path is inert — the regression anchor for wiring this into the engine.
 */

const assert = require('assert');
const { evaluate, DEFAULT_REFERENCE } = require('../../../strategies/DCABot/stopLoss.js');

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
console.log('\nDisabled / fail-safe: never stops on missing or off inputs:');

test('disabled (enabled=false) -> not triggered, inert', () => {
	const r = evaluate({ enabled: false, price: 1, average: 100, stopLossPercent: 10 });
	assert.strictEqual(r.triggered, false);
	assert.strictEqual(r.reason, 'disabled');
	assert.strictEqual(r.level, null);
});

test('enabled but stopLossPercent 0 -> not triggered', () => {
	const r = evaluate({ enabled: true, price: 1, average: 100, stopLossPercent: 0 });
	assert.strictEqual(r.triggered, false);
	assert.strictEqual(r.reason, 'disabled');
});

test('no live price -> not triggered (no_reference)', () => {
	const r = evaluate({ enabled: true, price: 0, average: 100, stopLossPercent: 10 });
	assert.strictEqual(r.triggered, false);
	assert.strictEqual(r.reason, 'no_reference');
});

test('reference=average but no average -> not triggered (no_reference)', () => {
	const r = evaluate({ enabled: true, price: 90, average: null, stopLossPercent: 10 });
	assert.strictEqual(r.triggered, false);
	assert.strictEqual(r.reason, 'no_reference');
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nBase stop (reference = average): fires at/below level, not above:');

test('price above stop level -> not triggered', () => {
	// stop = 100 * (1 - 0.10) = 90; price 95 is above
	const r = evaluate({ enabled: true, price: 95, average: 100, stopLossPercent: 10 });
	assert.strictEqual(r.triggered, false);
	assert.strictEqual(r.level, 90);
});

test('price exactly at stop level -> triggered (boundary inclusive)', () => {
	const r = evaluate({ enabled: true, price: 90, average: 100, stopLossPercent: 10 });
	assert.strictEqual(r.triggered, true);
	assert.strictEqual(r.reason, 'stop_hit');
});

test('price below stop level -> triggered', () => {
	const r = evaluate({ enabled: true, price: 85, average: 100, stopLossPercent: 10 });
	assert.strictEqual(r.triggered, true);
	assert.strictEqual(r.reason, 'stop_hit');
});

test('base stop rides down with the average (averaged-down deal)', () => {
	// After safety orders the average fell to 80; stop = 80*(1-0.10) = 72
	const r = evaluate({ enabled: true, price: 75, average: 80, stopLossPercent: 10 });
	assert.strictEqual(r.level, 72);
	assert.strictEqual(r.triggered, false);
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nReference = lastSafetyOrder (backstop below the ladder):');

test('level computed off the deepest SO, not the average', () => {
	// last SO price 60, stop = 60*(1-0.05) = 57 (NOT average-based)
	const r = evaluate({ enabled: true, price: 58, average: 100, stopLossPercent: 5, reference: 'lastSafetyOrder', lastSafetyOrderPrice: 60 });
	assert.strictEqual(r.level, 57);
	assert.strictEqual(r.triggered, false);
});

test('price through the below-ladder stop -> triggered', () => {
	const r = evaluate({ enabled: true, price: 56, average: 100, stopLossPercent: 5, reference: 'lastSafetyOrder', lastSafetyOrderPrice: 60 });
	assert.strictEqual(r.triggered, true);
});

test('reference=lastSafetyOrder without a SO price -> not triggered (no_reference)', () => {
	const r = evaluate({ enabled: true, price: 50, average: 100, stopLossPercent: 5, reference: 'lastSafetyOrder' });
	assert.strictEqual(r.triggered, false);
	assert.strictEqual(r.reason, 'no_reference');
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nMove-to-breakeven ratchet:');

test('does NOT arm below the profit trigger', () => {
	const r = evaluate({ enabled: true, price: 100.5, average: 100, stopLossPercent: 10, moveBreakeven: true, breakevenTrigger: 1, profitPercentage: 0.4, feeRate: 0.65 });
	assert.strictEqual(r.breakevenArmed, false);
	assert.strictEqual(r.reason, 'ok');
});

test('arms at/above the profit trigger; level moves to break-even (incl. fees)', () => {
	// break-even = 100 * (1 + 2*0.65/100) = 101.3
	const r = evaluate({ enabled: true, price: 102, average: 100, stopLossPercent: 10, moveBreakeven: true, breakevenTrigger: 1, profitPercentage: 1.2, feeRate: 0.65 });
	assert.strictEqual(r.breakevenArmed, true);
	assert.strictEqual(r.reason, 'armed_breakeven');
	assert.ok(Math.abs(r.level - 101.3) < 1e-9, 'level should be break-even 101.3, got ' + r.level);
});

test('armed and price falls back through break-even -> triggered (break-even stop)', () => {
	const r = evaluate({ enabled: true, price: 101, average: 100, stopLossPercent: 10, moveBreakeven: true, breakevenTrigger: 1, profitPercentage: 1.2, feeRate: 0.65 });
	assert.strictEqual(r.triggered, true);
	assert.strictEqual(r.breakevenArmed, true);
	assert.ok(r.message.indexOf('Break-even') === 0, 'message should mark a break-even stop');
});

test('already-armed stop is MONOTONIC: recomputed break-even lower must not lower the locked level', () => {
	// Persisted stop 101.3 from arming; average later dropped to 90 (break-even would
	// recompute to ~91.17). The locked, persisted level must win.
	const r = evaluate({ enabled: true, price: 102, average: 90, stopLossPercent: 10, moveBreakeven: true, breakevenTrigger: 1, profitPercentage: 0.5, breakevenArmed: true, activeStopLossPrice: 101.3, feeRate: 0.65 });
	assert.strictEqual(r.breakevenArmed, true);
	assert.strictEqual(r.level, 101.3);
	assert.strictEqual(r.triggered, false);
});

test('master switch off ignores break-even entirely', () => {
	const r = evaluate({ enabled: false, price: 50, average: 100, stopLossPercent: 10, moveBreakeven: true, breakevenTrigger: 1, profitPercentage: 5, feeRate: 0.65 });
	assert.strictEqual(r.triggered, false);
	assert.strictEqual(r.reason, 'disabled');
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nRobustness:');

test('string-typed numeric inputs are coerced', () => {
	const r = evaluate({ enabled: 'true', price: '85', average: '100', stopLossPercent: '10' });
	assert.strictEqual(r.triggered, true);
	assert.strictEqual(r.level, 90);
});

test('unknown reference falls back to the average default', () => {
	const r = evaluate({ enabled: true, price: 95, average: 100, stopLossPercent: 10, reference: 'nonsense' });
	assert.strictEqual(r.level, 90);
	assert.strictEqual(DEFAULT_REFERENCE, 'average');
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nTrailing stop (#104b) — trails the peak, ratchets up, exits on pullback:');

// Trailing base config: a deep base stop (sl 50) so it never interferes; trailing at
// 5% below the peak, activating at +2% profit.
const trailBase = { enabled: true, stopLossPercent: 50, average: 100, feeRate: 0.65 };

test('below activation profit -> trailing NOT active', () => {
	const r = evaluate({ ...trailBase, price: 101, profitPercentage: 1.0, trailingEnabled: true, trailingDistance: 5, trailingActivateProfit: 2, trailHighPrice: 101 });
	assert.strictEqual(r.trailingActive, false);
});

test('at/above activation -> trailing active; level = peak x (1 - dist)', () => {
	const r = evaluate({ ...trailBase, price: 110, profitPercentage: 10, trailingEnabled: true, trailingDistance: 5, trailingActivateProfit: 2, trailHighPrice: 110 });
	assert.strictEqual(r.trailingActive, true);
	assert.ok(Math.abs(r.level - 104.5) < 1e-9, 'level should be 110 x 0.95 = 104.5, got ' + r.level);
	assert.strictEqual(r.reason, 'trailing_active');
});

test('level rises as the peak rises', () => {
	const low  = evaluate({ ...trailBase, price: 110, profitPercentage: 10, trailingEnabled: true, trailingDistance: 5, trailingActivateProfit: 2, trailHighPrice: 110 });
	const high = evaluate({ ...trailBase, price: 120, profitPercentage: 20, trailingEnabled: true, trailingDistance: 5, trailingActivateProfit: 2, trailHighPrice: 120 });
	assert.ok(high.level > low.level, 'higher peak must give a higher trailing stop');
	assert.ok(Math.abs(high.level - 114) < 1e-9, 'level should be 120 x 0.95 = 114, got ' + high.level);
});

test('MONOTONIC: a persisted floor above the current trail level wins (peak-based stop never drops)', () => {
	// Peak fell back to 110 (trailLevel 104.5) but a higher stop (108) was already locked.
	const r = evaluate({ ...trailBase, price: 112, profitPercentage: 12, trailingEnabled: true, trailingDistance: 5, trailingActivateProfit: 2, trailHighPrice: 110, activeStopLossPrice: 108 });
	assert.strictEqual(r.level, 108);
	assert.strictEqual(r.triggered, false);
});

test('pullback through the trail level -> triggered, labeled a trailing stop', () => {
	const r = evaluate({ ...trailBase, price: 104, profitPercentage: 4, trailingEnabled: true, trailingDistance: 5, trailingActivateProfit: 2, trailHighPrice: 110 });
	assert.strictEqual(r.triggered, true);
	assert.ok(r.message.indexOf('Trailing stop hit') === 0, 'message should mark a trailing stop, got: ' + r.message);
});

test('composes with break-even via max(): the higher of the two wins', () => {
	// break-even ~101.3; trailing peak 110 -> 104.5. Trailing is higher, so it governs.
	const r = evaluate({ enabled: true, stopLossPercent: 50, average: 100, feeRate: 0.65, price: 108, profitPercentage: 8, moveBreakeven: true, breakevenTrigger: 1, breakevenArmed: true, activeStopLossPrice: 101.3, trailingEnabled: true, trailingDistance: 5, trailingActivateProfit: 2, trailHighPrice: 110 });
	assert.ok(Math.abs(r.level - 104.5) < 1e-9, 'trailing 104.5 should beat break-even 101.3, got ' + r.level);
	assert.strictEqual(r.trailingActive, true);
});

test('trailing disabled -> inert (no trailingActive, base logic only)', () => {
	const r = evaluate({ ...trailBase, price: 110, profitPercentage: 10, trailingEnabled: false, trailingDistance: 5, trailingActivateProfit: 2, trailHighPrice: 110 });
	assert.strictEqual(r.trailingActive, false);
});

test('trailing works with the hard stop-loss OFF (standalone trailing stop)', () => {
	// enabled:false, no average — trailing alone governs.
	const r = evaluate({ enabled: false, price: 110, profitPercentage: 10, trailingEnabled: true, trailingDistance: 5, trailingActivateProfit: 2, trailHighPrice: 110 });
	assert.strictEqual(r.trailingActive, true);
	assert.ok(Math.abs(r.level - 104.5) < 1e-9, 'level should be 104.5, got ' + r.level);
});

test('trailing enabled but not yet activated, no stop-loss -> inactive, never triggers', () => {
	const r = evaluate({ enabled: false, price: 100, profitPercentage: 1, trailingEnabled: true, trailingDistance: 5, trailingActivateProfit: 2, trailHighPrice: 100 });
	assert.strictEqual(r.triggered, false);
	assert.strictEqual(r.reason, 'inactive');
});


// ─────────────────────────────────────────────────────────────────────────────
// Model the engine's stop-out gate (dcaFollow) so the money-path decision is
// asserted, not just the pure predicate: the deal stops out only when the guard
// triggers AND the price is trusted (!cancelOnly) AND no explicit user close /
// paused-or-verifying sell is in effect. Mirrors the sell-gate model in
// priceGuard.test.js.
console.log('\nEngine stop-out gate (trigger + trust + no user-close override):');

function wouldStopOut({ price, average, stopLossPercent, cancelOnly, panic, cancel, pauseSell, verifying }) {
	const d = evaluate({ enabled: true, price, average, stopLossPercent });
	return d.triggered && !cancelOnly && !panic && !cancel && !pauseSell && !verifying;
}

test('price below stop, feed sane, no user close -> STOP OUT', () => {
	assert.strictEqual(wouldStopOut({ price: 85, average: 100, stopLossPercent: 10 }), true);
});

test('implausible price (cancelOnly) HELD -> no stop-out even below stop', () => {
	assert.strictEqual(wouldStopOut({ price: 85, average: 100, stopLossPercent: 10, cancelOnly: true }), false);
});

test('explicit panic in flight -> deferred (panic path owns the close + label)', () => {
	assert.strictEqual(wouldStopOut({ price: 85, average: 100, stopLossPercent: 10, panic: true }), false);
});

test('sell paused / verifying -> stop-out suppressed (respects the sell gate)', () => {
	assert.strictEqual(wouldStopOut({ price: 85, average: 100, stopLossPercent: 10, pauseSell: true }), false);
	assert.strictEqual(wouldStopOut({ price: 85, average: 100, stopLossPercent: 10, verifying: true }), false);
});

test('price above stop -> no stop-out (normal following)', () => {
	assert.strictEqual(wouldStopOut({ price: 95, average: 100, stopLossPercent: 10 }), false);
});


console.log('\n' + passed + ' assertions passed' + (process.exitCode ? ' (with failures above)' : ', all green'));
