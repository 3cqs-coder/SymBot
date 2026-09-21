'use strict';

// Pins the LIVE money-decision pricing math that drives take-profit and the safety-order ladder:
//   * calculateTargetPrice — where a deal actually closes: price x (1 + (takeProfit + ONE fee)/100).
//     This is the live counterpart of the estimator's projected target (see AddFundsMath.test); the two
//     must agree, both single-fee. A regression here directly mis-times real sells.
//   * getDeviationDca — the cumulative price deviation of the ladder: linear (max * step) when the step
//     multiplier is 1, geometric otherwise. This sets how far below entry the safety orders reach.
// Both are pure of engine state (calculateTargetPrice only needs exchange.priceToPrecision, mocked here as
// identity so the raw math is asserted). They are exported from DCABot.js for exactly this kind of test.

const assert = require('assert');
const DCABot = require('../../../strategies/DCABot/DCABot.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function near(a, b, m) { ok(Math.abs(Number(a) - Number(b)) <= 1e-6, m + ' (got ' + a + ', want ' + b + ')'); }

// Identity precision filter so we assert the pricing formula itself, not exchange rounding.
const ex = { priceToPrecision: (pair, price) => price };

(async () => {

	// ── Take-profit target: SINGLE fee (matches the estimator's projected target) ──
	near(await DCABot.calculateTargetPrice({ exchange: ex, pair: 'BTC/USDT', price: 100, takeProfit: 1, exchangeFee: 0.2 }),
		101.2, 'target = price x (1 + (takeProfit + 1x fee)/100) = 100 * 1.012');
	// Different numbers to prove it's the formula, not a coincidence.
	near(await DCABot.calculateTargetPrice({ exchange: ex, pair: 'ETH/USDT', price: 2000, takeProfit: 1.5, exchangeFee: 0.1 }),
		2000 * (1 + (1.5 + 0.1) / 100), 'target holds at price 2000, tp 1.5, fee 0.1');
	// Zero fee -> pure take-profit markup.
	near(await DCABot.calculateTargetPrice({ exchange: ex, pair: 'BTC/USDT', price: 100, takeProfit: 1, exchangeFee: 0 }),
		101, 'zero fee -> exactly the take-profit markup');
	// The target must NOT be the round-trip 2x-fee value (would be 101.4 at fee 0.2) — the estimator/live
	// consistency that was fixed this session.
	ok(Math.abs(Number(await DCABot.calculateTargetPrice({ exchange: ex, pair: 'BTC/USDT', price: 100, takeProfit: 1, exchangeFee: 0.2 })) - 101.4) > 1e-6,
		'target is single-fee, NOT the 2x-fee value');

	// ── Ladder deviation ──
	near(await DCABot.getDeviationDca(1, 1, 3), 3, 'linear ladder: max * step (3 * 1%)');
	near(await DCABot.getDeviationDca(2, 1, 5), 10, 'linear ladder scales with step (5 * 2%)');
	// Geometric: step * (1 - mult^max)/(1 - mult).  1 * (1-2^3)/(1-2) = 7.
	near(await DCABot.getDeviationDca(1, 2, 3), 7, 'geometric ladder: step * (1 - mult^max)/(1 - mult)');
	// Deeper geometric with a 1.5 multiplier: 1 * (1 - 1.5^4)/(1 - 1.5) = (1 - 5.0625)/(-0.5) = 8.125.
	near(await DCABot.getDeviationDca(1, 1.5, 4), (1 - Math.pow(1.5, 4)) / (1 - 1.5), 'geometric ladder holds at mult 1.5');
	// A larger step is deeper than a smaller one for the same shape (monotonic sanity).
	ok(Number(await DCABot.getDeviationDca(2, 2, 3)) > Number(await DCABot.getDeviationDca(1, 2, 3)),
		'a larger step yields a deeper ladder');

	console.log('targetLadder: ' + passed + ' assertions passed');
	process.exit(0);
})().catch((e) => { console.error('targetLadder test error:', e); process.exit(1); });
