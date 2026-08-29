'use strict';

const { toNum } = require('../../app/Common.js');

/**
 * Price sanity guard — pure, dependency-free, unit-testable.
 *
 * The engine's tick loop rejects a price of exactly 0 / null / '' before it is
 * used. That guard does NOT catch a nonzero-but-wildly-wrong price. During an
 * exchange auth/connectivity disruption, `fetchTicker` can RETURN (without
 * throwing) a nonzero garbage bid — observed 2026-08-12 when a Binance auth
 * storm made recovery ticker reads come back at random wrong magnitudes per pair
 * (e.g. WAL $0.0238 → $65.11, ~2735×). Such a price sails past the zero check,
 * `calculateProfit` correctly computes a huge profit, the price crosses the
 * take-profit target, and the deal closes at an impossible profit.
 *
 * This module answers one question: is a freshly-fetched price plausible next to
 * the deal's own known-good anchor (its DCA average)? It is a pure decision — no
 * I/O, no exchange, no DB — so the money-path logic is trivially testable.
 *
 * Fail-safe by construction:
 *   - It never rejects a non-positive price (that is the separate zero/invalid
 *     guard's job); it returns plausible=true so it only ADDS rejection of
 *     nonzero-implausible prices, never weakens the existing behavior.
 *   - When it has no valid reference to compare against (e.g. the base order,
 *     before any order has filled) it returns plausible=true — it cannot judge,
 *     so it defers rather than blocking.
 *
 * A price it rejects must be treated EXACTLY like an invalid price: hold the
 * deal, do not compute profit against it, do not buy or sell on it. Holding a
 * deal can never lose money; acting on a garbage price can.
 */


// Reject a price more than this multiple ABOVE the reference. A legitimate
// take-profit sell happens at ~1.0–1.05× the average (target = average × (1 +
// takeProfit%)), so 2× leaves generous headroom for any realistic take-profit
// config while still catching the smallest observed garbage ratio (2.8×). Raise
// this above your largest configured take-profit multiple if you run very high
// take-profit percentages.
const DEFAULT_HIGH_RATIO = 2;

// Reject a price more than this multiple BELOW the reference (price < reference /
// this). Deliberately generous so a deeply-averaged-down deal is never blocked
// from placing a legitimate safety order: 10 allows the price to fall to 10% of
// the average (a 90% drawdown) before a fetch is treated as garbage.
const DEFAULT_LOW_RATIO = 10;


/**
 * Coerce to a finite number, or null if missing / non-numeric.
 */
/**
 * Decide whether a fetched price is plausible relative to a known-good reference.
 *
 * @param {object} data
 * @param {number}  data.price          The freshly-fetched price to judge.
 * @param {number} [data.reference]     Known-good reference (the deal's DCA average).
 * @param {number} [data.maxHighRatio]  Reject if price > reference × this. Default 2.
 * @param {number} [data.maxLowRatio]   Reject if price < reference / this. Default 10.
 * @returns {{plausible:boolean, reason:string, message:string, price:(number|null),
 *            reference:(number|null), ratio:(number|null), high_ratio:number, low_ratio:number}}
 */
function evaluatePriceSanity(data) {

	data = data || {};

	const price = toNum(data['price']);
	const reference = toNum(data['reference']);

	let highRatio = toNum(data['maxHighRatio']);
	let lowRatio = toNum(data['maxLowRatio']);

	// A ratio must be > 1 to describe a band; anything else falls back to default.
	if (highRatio === null || highRatio <= 1) { highRatio = DEFAULT_HIGH_RATIO; }
	if (lowRatio === null || lowRatio <= 1) { lowRatio = DEFAULT_LOW_RATIO; }

	const result = {
		'plausible': true,
		'reason': 'ok',
		'message': '',
		'price': price,
		'reference': reference,
		'ratio': null,
		'high_ratio': highRatio,
		'low_ratio': lowRatio
	};

	// Non-positive price is handled by the existing invalid-price guard. Defer to
	// it (plausible stays true) so this module never overrides the zero check.
	if (price === null || price <= 0) {

		result['reason'] = 'invalid_price';
		result['message'] = 'Non-positive price; deferred to the invalid-price guard';

		return result;
	}

	// No usable reference yet (e.g. base order before anything has filled) — cannot
	// judge plausibility, so allow it rather than block.
	if (reference === null || reference <= 0) {

		result['reason'] = 'no_reference';
		result['message'] = 'No known-good reference price yet; plausibility not judged';

		return result;
	}

	const ratio = price / reference;
	result['ratio'] = ratio;

	if (ratio > highRatio) {

		result['plausible'] = false;
		result['reason'] = 'above_band';
		result['message'] = 'Fetched price ' + price + ' is ' + ratio.toFixed(2) + '× the known-good reference ' + reference + ' (max ' + highRatio + '×); holding deal';

		return result;
	}

	if (ratio < (1 / lowRatio)) {

		result['plausible'] = false;
		result['reason'] = 'below_band';
		result['message'] = 'Fetched price ' + price + ' is 1/' + (1 / ratio).toFixed(2) + ' of the known-good reference ' + reference + ' (min 1/' + lowRatio + '); holding deal';

		return result;
	}

	return result;
}


module.exports = {

	evaluatePriceSanity,
	toNum,
	DEFAULT_HIGH_RATIO,
	DEFAULT_LOW_RATIO
};