'use strict';

// Pins calculateMaxFunds — the worst-case capital estimate shown in the create-bot preview and per-bot
// exposure figures. It is DISPLAY-ONLY (never sizes an order or gates a deal start), but it must be
// correct and consistent with the actual capital deployed:
//   * ONE fee (buy side only) — the capital you must deploy is the buy legs; the sell fee comes out of
//     proceeds later and does not increase cash-on-hand. (A round-trip 2x fee over-stated it.)
//   * the safety-order ladder is a geometric series scaled by dcaOrderSizeMultiplier;
//   * max_deviation is the cumulative price deviation of the ladder;
//   * the pair / pair-deals multipliers scale bot_max_funds.
// calculateMaxFunds is a pure function of config (no shareData), so it runs without engine init.

const assert = require('assert');
const DCABot = require('../../../strategies/DCABot/DCABot.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function near(a, b, m) { ok(Math.abs(Number(a) - Number(b)) <= 1e-6, m + ' (got ' + a + ', want ' + b + ')'); }

(async () => {

	// Base 100 + 2 safety orders of 100 (no volume scaling), fee 0.2%, one pair, one deal per pair.
	// Gross ladder = 300; with a SINGLE fee -> 300 * 1.002 = 300.6 (NOT 300.6* ... the 2x-fee value 301.2).
	const a = await DCABot.calculateMaxFunds({
		dcaMaxOrder: 2, dcaOrderAmount: 100, dcaOrderSizeMultiplier: 1,
		dcaOrderStepPercent: 1, dcaOrderStepPercentMultiplier: 1,
		firstOrderAmount: 100, exchangeFee: 0.2, pairMax: 1, pairDealsMax: 1, pair: [ 'BTC/USDT' ]
	});
	near(a.max_funds, 300.6, 'max_funds uses a SINGLE (buy-side) fee: 300 * 1.002');
	ok(Math.abs(a.max_funds - 301.2) > 1e-6, 'max_funds is NOT the old round-trip 2x-fee value (301.2)');
	near(a.max_deviation, 2, 'max_deviation is the cumulative ladder deviation (2 * 1%)');
	near(a.bot_max_funds, 300.6, 'bot_max_funds = max_funds with pairMax=1, pairDealsMax=1');

	// Zero fee -> exactly the gross ladder, proving the multiplier is (1 + fee/100) and nothing else.
	const zeroFee = await DCABot.calculateMaxFunds({
		dcaMaxOrder: 2, dcaOrderAmount: 100, dcaOrderSizeMultiplier: 1,
		dcaOrderStepPercent: 1, dcaOrderStepPercentMultiplier: 1,
		firstOrderAmount: 100, exchangeFee: 0, pairMax: 1, pairDealsMax: 1, pair: [ 'BTC/USDT' ]
	});
	near(zeroFee.max_funds, 300, 'zero fee -> exactly the gross ladder sum');

	// Volume scaling: SO sizes 100 * 2^0, 100 * 2^1 = 100, 200 -> base 100 + 100 + 200 = 400 gross.
	const scaled = await DCABot.calculateMaxFunds({
		dcaMaxOrder: 2, dcaOrderAmount: 100, dcaOrderSizeMultiplier: 2,
		dcaOrderStepPercent: 1, dcaOrderStepPercentMultiplier: 1,
		firstOrderAmount: 100, exchangeFee: 0, pairMax: 1, pairDealsMax: 1, pair: [ 'BTC/USDT' ]
	});
	near(scaled.max_funds, 400, 'safety-order volume scales geometrically by dcaOrderSizeMultiplier');

	// Pair / pair-deals multipliers scale bot_max_funds (2 pairs, 3 deals each -> x6).
	const multi = await DCABot.calculateMaxFunds({
		dcaMaxOrder: 1, dcaOrderAmount: 100, dcaOrderSizeMultiplier: 1,
		dcaOrderStepPercent: 1, dcaOrderStepPercentMultiplier: 1,
		firstOrderAmount: 100, exchangeFee: 0, pairMax: 2, pairDealsMax: 3, pair: [ 'BTC/USDT', 'ETH/USDT' ]
	});
	// per-deal max_funds = 100 (base) + 100 (1 SO) = 200 ; bot = 200 * min(2,2) * 3 = 1200.
	near(multi.max_funds, 200, 'per-deal max_funds for a 1-SO ladder');
	near(multi.bot_max_funds, 1200, 'bot_max_funds scales by pairMax and pairDealsMax');

	console.log('maxFunds: ' + passed + ' assertions passed');

	// calculateMaxFunds is pure but requiring DCABot.js may register background timers — exit explicitly.
	process.exit(0);
})().catch((e) => { console.error('maxFunds test error:', e); process.exit(1); });
