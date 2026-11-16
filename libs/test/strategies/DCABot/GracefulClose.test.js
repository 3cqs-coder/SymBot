'use strict';

// Pure tests for gracefulClose.decideGracefulClose (#133) — the decision behind a graceful close,
// extracted from DCABot.gracefulCloseDeal so the full wiring (price-plausibility gate THEN
// profit-target gate) is verifiable without the engine, a database, or the module-level deal
// tracker. No I/O, no orders: metrics in, {eligible, reason, data, metrics} out.
//
// Covers both directions and the fail-safe cases: a plausible price with the target met is
// ELIGIBLE; an implausible-high (or -low) live price is NOT eligible even when the target looks
// "met" (the garbage-high-price class a close must never finalize on); target not met, no live
// price, and a missing tracker all fail safe to NOT eligible (leaving a deal open can never lose
// money). Also pins the stable, language-agnostic reason codes.

const assert = require('assert');
const { decideGracefulClose } = require('../../../strategies/DCABot/gracefulClose.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// A circuit-breaker config with an explicit plausibility band (price must stay within 3× / 1/3 of
// the DCA average). Shared across cases so the band is one value, not repeated magic numbers.
const CB = { 'price_deviation_high_ratio': 3, 'price_deviation_low_ratio': 3 };

// ── Direction 1: plausible price + target met → ELIGIBLE ──
{
	const d = decideGracefulClose({
		info: { 'price_last': 110, 'price_average': 100, 'price_target': 105, 'profit_percentage': 10 },
		takeProfitPercent: 1,
		cbCfg: CB
	});
	ok(d.eligible === true, 'plausible price + price>=target → eligible');
	ok(d.reason === 'target_met', 'eligible reason is target_met');
	ok(d.metrics && d.metrics.ready === true, 'eligible carries the target evaluator result as metrics');
}

// ── Direction 2: plausible price + target NOT met → not eligible ──
{
	const d = decideGracefulClose({
		info: { 'price_last': 100, 'price_average': 100, 'price_target': 105, 'profit_percentage': 0 },
		takeProfitPercent: 1,
		cbCfg: CB
	});
	ok(d.eligible === false, 'price below target → not eligible');
	ok(d.reason === 'target_not_met', 'reason is target_not_met');
	ok(/not met/i.test(d.data), 'data explains the target was not met');
	ok(d.metrics && d.metrics.ready === false, 'metrics carries the not-ready evaluator result');
}

// ── The core #133 guard: implausible-HIGH live price must block even when target looks "met" ──
// price_last 100000 is 1000× the DCA average of 100 — the garbage-high class that, unchecked, would
// clear the take-profit target and finalize a fake-profitable close (+154921%). The sanity gate runs
// FIRST, so the deal is held open despite price_last >= price_target.
{
	const d = decideGracefulClose({
		info: { 'price_last': 100000, 'price_average': 100, 'price_target': 105, 'profit_percentage': 999999 },
		takeProfitPercent: 1,
		cbCfg: CB
	});
	ok(d.eligible === false, 'implausible-high price → NOT eligible even though price>=target');
	ok(d.reason === 'implausible_price', 'reason is implausible_price');
	ok(/implausible/i.test(d.data), 'data flags the implausible price');
	ok(d.metrics && d.metrics.plausible === false, 'metrics is the price-sanity result (plausible:false)');
}

// ── Implausible-LOW live price also blocks (below the band) ──
{
	const d = decideGracefulClose({
		info: { 'price_last': 0.001, 'price_average': 100, 'price_target': 0.0005, 'profit_percentage': 0 },
		takeProfitPercent: 1,
		cbCfg: CB
	});
	ok(d.eligible === false, 'implausible-low price → NOT eligible');
	ok(d.reason === 'implausible_price', 'low-band reason is implausible_price');
}

// ── No live price → fail-safe not eligible (no_live_price), via the target guard ──
// price_last 0 is non-positive: the sanity gate defers (plausible stays true, that is the invalid-price
// guard's job), so the decision flows to the target guard, which cannot confirm a profit without a
// live price and refuses to close.
{
	const d = decideGracefulClose({
		info: { 'price_last': 0, 'price_average': 100, 'price_target': 105 },
		takeProfitPercent: 1,
		cbCfg: CB
	});
	ok(d.eligible === false, 'no live price → not eligible');
	ok(d.reason === 'no_live_price', 'reason is no_live_price (fail-safe)');
}

// ── Missing info / tracker → fail-safe not eligible, never throws ──
{
	const d1 = decideGracefulClose({});                 // nothing at all
	ok(d1.eligible === false, 'empty args → not eligible (fail-safe)');
	const d2 = decideGracefulClose();                   // no args object
	ok(d2.eligible === false, 'no args → not eligible (fail-safe)');
	const d3 = decideGracefulClose({ info: {}, takeProfitPercent: 1 });  // empty info, default cbCfg
	ok(d3.eligible === false, 'empty info → not eligible (fail-safe)');
}

// ── Band comes from cbCfg (single source of truth): a 1.5× move is eligible under a 3× band ──
{
	const d = decideGracefulClose({
		info: { 'price_last': 150, 'price_average': 100, 'price_target': 140, 'profit_percentage': 50 },
		takeProfitPercent: 1,
		cbCfg: CB
	});
	ok(d.eligible === true, '1.5× move within a 3× band + target met → eligible');
}

console.log('GracefulClose: ' + passed + ' assertions passed');
process.exit(0);
