'use strict';

const { toNum } = require('../../app/Common.js');

/**
 * Stop-loss + move-to-breakeven — pure, dependency-free, unit-testable.
 *
 * This module answers ONE question per tick: given the deal's live price and its
 * known-good anchor (the DCA average, or the deepest safety-order price), has the
 * price fallen to/through the stop level — and, if the move-to-breakeven ratchet
 * is enabled, has the deal earned enough profit to lock the stop at break-even?
 *
 * It is a pure decision — no I/O, no exchange, no DB — mirroring priceGuard.js and
 * signalBot.js, so the money decision is trivially testable in isolation. The
 * ENGINE (DCABot.js) owns the consequences: when this returns `triggered`, the
 * engine reuses the existing market-close path (the same one panic_sell uses) and
 * records the close with a distinct `stopLoss` reason. When this reports the
 * break-even ratchet advanced (`breakevenArmed` newly true), the engine persists
 * the new level on the deal so it survives a restart.
 *
 * Fail-safe by construction (identical philosophy to priceGuard / evaluateGracefulClose):
 *   - Disabled, or no positive stop distance, or no valid live price/reference ->
 *     `triggered:false`. A deal is NEVER stopped out on missing/invalid inputs;
 *     leaving it open can only forgo a stop, never dump at a fake price.
 *   - The plausibility guard runs upstream in the engine: an implausible price sets
 *     cancelOnly and the engine does not even call this on such a tick, so a garbage
 *     down-tick can never fire a stop-loss.
 *
 * The stop level only ever ratchets UP once break-even is armed (the persisted
 * `activeStopLossPrice` is the monotonic memory); this is the substrate a future
 * trailing stop (#104b) extends.
 */


// Default reference for the base (loss) stop level. 'average' mirrors the
// take-profit model (target = average x (1 + tp); stop = average x (1 - sl)) and is
// always defined once a position exists. 'lastsafetyorder' makes the stop a
// backstop below the fully-deployed ladder.
const DEFAULT_REFERENCE = 'average';


/**
 * Coerce a loosely-typed boolean (true / 'true' / 1) to a real boolean.
 */
function toBool(value) {

	return value === true || value === 'true' || value === 1 || value === '1';
}


/**
 * Decide whether a stop-loss should fire this tick, and advance the break-even
 * ratchet if its profit trigger is met.
 *
 * @param {object} data
 * @param {boolean} data.enabled              dcaStopLossEnabled — master switch.
 * @param {number}  data.price                Live price (the same bid the tick loop uses).
 * @param {number}  data.average              Deal's DCA average entry (currentOrder.average).
 * @param {number}  data.stopLossPercent      dcaStopLossPercent — distance below the reference.
 * @param {string} [data.reference]           'average' (default) | 'lastSafetyOrder'.
 * @param {number} [data.lastSafetyOrderPrice] Deepest safety-order price (for reference='lastSafetyOrder').
 * @param {number} [data.feeRate]             One-leg fee % (config.exchangeFee); doubled internally for break-even.
 * @param {boolean}[data.moveBreakeven]       dcaStopLossMoveBreakeven — enable the ratchet.
 * @param {number} [data.breakevenTrigger]    dcaStopLossBreakevenTrigger — net profit % that arms the ratchet.
 * @param {number} [data.profitPercentage]    Live net profit % (from calculateProfit).
 * @param {boolean}[data.breakevenArmed]      Persisted per-deal state: has the ratchet already fired.
 * @param {number} [data.activeStopLossPrice] Persisted per-deal state: the current monotonic stop level.
 * @returns {{triggered:boolean, level:(number|null), breakevenArmed:boolean,
 *            breakevenLevel:(number|null), reason:string, message:string}}
 */
function evaluate(data) {

	data = data || {};

	const enabled = toBool(data['enabled']);
	const moveBreakeven = toBool(data['moveBreakeven']);
	const breakevenArmedIn = toBool(data['breakevenArmed']);

	const price = toNum(data['price']);
	const average = toNum(data['average']);
	const stopLossPercent = toNum(data['stopLossPercent']);
	const feeRate = toNum(data['feeRate']);
	const breakevenTrigger = toNum(data['breakevenTrigger']);
	const profitPercentage = toNum(data['profitPercentage']);
	const activeStopLossPrice = toNum(data['activeStopLossPrice']);
	const lastSafetyOrderPrice = toNum(data['lastSafetyOrderPrice']);

	let reference = String(data['reference'] == undefined ? '' : data['reference']).trim().toLowerCase();

	if (reference !== 'lastsafetyorder') { reference = DEFAULT_REFERENCE; }

	const result = {
		'triggered': false,
		'level': null,
		'breakevenArmed': breakevenArmedIn,
		'breakevenLevel': null,
		'trailingActive': false,
		'trailLevel': null,
		'reason': 'ok',
		'message': ''
	};

	// Which mechanisms are usable this call? The hard stop-loss needs a positive
	// distance; the trailing stop is independent and can run with the stop-loss off.
	const slUsable = enabled && stopLossPercent !== null && stopLossPercent > 0;

	const trailingEnabled = toBool(data['trailingEnabled']);
	const trailingDistance = toNum(data['trailingDistance']);
	const trailingActivateProfit = toNum(data['trailingActivateProfit']);
	const trailHighPrice = toNum(data['trailHighPrice']);

	const trailingConfigured = trailingEnabled && trailingDistance !== null && trailingDistance > 0;

	// Neither the hard stop-loss nor a trailing stop is enabled -> not evaluated.
	// Fail-safe: never stop.
	if (!slUsable && !trailingConfigured) {

		result['reason'] = 'disabled';
		result['message'] = 'Stop-loss and trailing stop disabled (or no positive distance); not evaluated';

		return result;
	}

	// Need a valid positive live price to compare against.
	if (price === null || price <= 0) {

		result['reason'] = 'no_reference';
		result['message'] = 'No valid live price; not evaluated';

		return result;
	}

	// Base (loss) stop level — only when the hard stop-loss is usable AND has a valid
	// reference (its average, or the deepest safety order). Trailing does not need it.
	let baseStopLevel = null;

	if (slUsable) {

		const refPrice = (reference === 'lastsafetyorder') ? lastSafetyOrderPrice : average;

		if (refPrice !== null && refPrice > 0) {

			// With reference='average' this moves down as the deal averages down.
			baseStopLevel = refPrice * (1 - (stopLossPercent / 100));
		}
		else if (!trailingConfigured) {

			// Stop-loss on but no reference yet, and no trailing to fall back on.
			result['reason'] = 'no_reference';
			result['message'] = 'No valid reference price (' + reference + '); not evaluated';

			return result;
		}
	}

	// Break-even level: the average lifted by both fee legs, so closing here recovers
	// cost incl. fees rather than at a small loss. A missing/zero fee falls back to
	// the raw average (no cushion) — degenerate but safe; bot.json always carries a fee.
	const feeFrac = (feeRate === null || feeRate <= 0) ? 0 : (2 * (feeRate / 100));
	const breakevenLevel = (average !== null && average > 0) ? average * (1 + feeFrac) : null;

	// Break-even ratchet: arm when the stop-loss is on, move-to-breakeven is enabled,
	// not yet armed, and the profit trigger is met.
	let armed = breakevenArmedIn;
	let newlyArmed = false;

	if (enabled && moveBreakeven && !breakevenArmedIn && breakevenLevel !== null
		&& breakevenTrigger !== null && profitPercentage !== null
		&& profitPercentage >= breakevenTrigger) {

		armed = true;
		newlyArmed = true;
	}

	// Trailing stop (#104b): once profit reaches the activation threshold, the stop
	// trails a configured distance below the running price peak (trailHighPrice, which
	// the engine maintains and persists). Ratchets the stop UP only.
	let trailingActive = false;
	let trailLevel = null;

	if (trailingConfigured
		&& trailingActivateProfit !== null && profitPercentage !== null
		&& profitPercentage >= trailingActivateProfit
		&& trailHighPrice !== null && trailHighPrice > 0) {

		trailingActive = true;
		trailLevel = trailHighPrice * (1 - (trailingDistance / 100));
	}

	// Effective stop level = the HIGHEST (most protective) applicable stop: base
	// loss-cut, armed break-even floor, trailing level, and the persisted monotonic
	// floor (activeStopLossPrice, which the engine only ever raises). The max keeps the
	// stop up-only across ticks and composes break-even + trailing without special-casing.
	const candidates = [];

	if (baseStopLevel !== null && Number.isFinite(baseStopLevel)) { candidates.push(baseStopLevel); }
	if (armed && breakevenLevel !== null && Number.isFinite(breakevenLevel)) { candidates.push(breakevenLevel); result['breakevenLevel'] = breakevenLevel; }
	if (trailingActive && trailLevel !== null && Number.isFinite(trailLevel)) { candidates.push(trailLevel); }
	if (activeStopLossPrice !== null && activeStopLossPrice > 0) { candidates.push(activeStopLossPrice); }

	result['breakevenArmed'] = armed;
	result['trailingActive'] = trailingActive;
	result['trailLevel'] = trailLevel;

	// No stop level applies yet (e.g. trailing enabled but not activated, and no base
	// stop). Nothing to trigger on — hold.
	if (candidates.length === 0) {

		result['reason'] = 'inactive';
		result['message'] = 'No stop level active yet; not evaluated';

		return result;
	}

	const level = Math.max.apply(null, candidates);
	result['level'] = level;

	if (price <= level) {

		// Label reflects which stop the effective level came from (trailing > break-even > base).
		let hitLabel;

		if (trailingActive && trailLevel !== null && level === trailLevel) { hitLabel = 'Trailing stop hit'; }
		else if (armed) { hitLabel = 'Break-even stop hit'; }
		else { hitLabel = 'Stop-loss hit'; }

		result['triggered'] = true;
		result['reason'] = 'stop_hit';
		result['message'] = hitLabel + ': price ' + price + ' <= stop level ' + level.toFixed(8);

		return result;
	}

	if (newlyArmed) {

		result['reason'] = 'armed_breakeven';
		result['message'] = 'Break-even stop armed at ' + level.toFixed(8) + '; deal protected';

		return result;
	}

	if (trailingActive) {

		result['reason'] = 'trailing_active';
		result['message'] = 'Trailing stop active at ' + level.toFixed(8) + ' (peak ' + trailHighPrice + '); not hit';

		return result;
	}

	result['message'] = 'Stop-loss active at ' + level.toFixed(8) + '; not hit';

	return result;
}


module.exports = {

	evaluate,
	toNum,
	toBool,
	DEFAULT_REFERENCE
};
