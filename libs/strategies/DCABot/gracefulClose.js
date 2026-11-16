'use strict';

// gracefulClose.js — the PURE decision behind a graceful close.
//
// A graceful close must NEVER finalize a deal unless the profit target is genuinely met on a
// trustworthy live price. Two guards decide that, and both already live in their own pure,
// unit-tested modules; this helper is the single place that ORCHESTRATES them, so the decision
// is verifiable end to end without a running engine, a database, or the module-level deal
// tracker. It performs no I/O and places no orders — the caller (DCABot.gracefulCloseDeal) keeps
// the one impure step, delegating an eligible close to the existing panic-sell close path. That
// keeps the money path wrapped, never reimplemented.
//
// Design principles:
//   • Fail-safe: anything we cannot confirm (missing info, implausible price, target not met)
//     returns NOT eligible. Leaving a deal open can never lose money; closing when unsure could
//     dump at a loss. Both underlying guards share this philosophy.
//   • Single source of truth: the price-plausibility rule is PriceGuard.evaluatePriceSanity (the
//     same guard the tick loop uses) and the profit-target rule is SignalBot.evaluateGracefulClose
//     (the same guard the signal `close` command uses). This helper adds no third rule.
//   • Language-agnostic: every outcome carries a stable `reason` CODE for callers/telemetry to key
//     on, separate from the human-readable `data` string, so a future locale layer localizes the
//     string without touching the logic.

const PriceGuard = require(__dirname + '/priceGuard.js');
const SignalBot = require(__dirname + '/signalBot.js');

// Decide whether a deal may be gracefully closed right now.
//
// @param {object}  info              live metrics (from the deal tracker): price_last, price_average,
//                                     price_target, profit_percentage.
// @param {number}  takeProfitPercent the deal's configured take-profit percent.
// @param {object}  cbCfg             circuit-breaker config (price_deviation_high_ratio / _low_ratio).
// @returns {{eligible:boolean, reason:string, data:string, metrics:object}}
//   eligible=false → the caller returns {success:true, closed:false, data, metrics} and leaves the deal open.
//   eligible=true  → the caller delegates to the existing close path (panic-sell gated by this check).
function decideGracefulClose({ info, takeProfitPercent, cbCfg } = {}) {

	info = info || {};
	cbCfg = cbCfg || {};

	// 1) Price plausibility — a garbage-high live price (e.g. during an exchange auth storm) must not
	//    be allowed to clear the take-profit target and finalize a profitable-looking close. Reference
	//    is the deal's DCA average. Same guard, same thresholds the engine uses elsewhere.
	const priceSanity = PriceGuard.evaluatePriceSanity({
		'price': info['price_last'],
		'reference': info['price_average'],
		'maxHighRatio': cbCfg['price_deviation_high_ratio'],
		'maxLowRatio': cbCfg['price_deviation_low_ratio']
	});

	if (!priceSanity['plausible']) {

		return {
			'eligible': false,
			'reason': 'implausible_price',
			'data': 'Live price appears implausible (' + priceSanity['message'] + '); deal left open',
			'metrics': priceSanity
		};
	}

	// 2) Profit target — only close when the live price has reached the take-profit target. This is
	//    the same evaluator the signal `close` command uses, so the two can never drift.
	const decision = SignalBot.evaluateGracefulClose({
		'price_last': info['price_last'],
		'price_target': info['price_target'],
		'profit_percentage': info['profit_percentage'],
		'take_profit_percent': takeProfitPercent
	});

	if (!decision['ready']) {

		// Target not met / not determinable — leave open. Pass the evaluator's own reason code
		// through (no_live_price | target_not_met) rather than flattening it, so callers keep the
		// precise cause.
		return {
			'eligible': false,
			'reason': decision['reason'] || 'target_not_met',
			'data': decision['message'],
			'metrics': decision
		};
	}

	return {
		'eligible': true,
		'reason': 'target_met',
		'data': decision['message'],
		'metrics': decision
	};
}

module.exports = { decideGracefulClose };
