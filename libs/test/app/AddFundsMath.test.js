'use strict';

// Pins the Add-Funds / projected-order estimator math (AddFundsMath.computeAddFundsForward), which
// feeds the deal estimate and add-funds preview. The invariants below are the ones that had bugs and
// must not regress:
//   * the projected TAKE-PROFIT target uses ONE fee (buy fee only) so it matches where the deal actually
//     targets (calculateTargetPrice = avg x (1 + (takeProfit + fee)/100)) — NOT a round-trip 2x fee;
//   * BREAK-EVEN uses the round-trip 2x fee (recovering cost needs both buy and sell);
//   * the net add amount subtracts the fee, and the new net average is computed from it;
//   * a non-positive add is rejected (valid:false) rather than producing garbage.
// This is a display/estimate helper and never sizes an order or gates a deal — but users read it, so it
// must be correct and internally consistent with the live target/break-even formulas.

const assert = require('assert');
const AddFundsMath = require('../../app/AddFundsMath.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function near(a, b, eps, m) { ok(Math.abs(Number(a) - Number(b)) <= (eps || 1e-6), m + ' (got ' + a + ', want ' + b + ')'); }

// Position: 100 quote invested, 1 base held (avg 100). Add 100 gross at price 100. fee 0.2%, take-profit 1%.
const r = AddFundsMath.computeAddFundsForward({
	sum: 100, qtySum: 1, addAmount: 100, addPrice: 100, price: 100, marketPrice: 100,
	currentAverageReal: 100, currentProfitPercent: 0, exchangeFee: 0.2, targetProfitPercent: 1
});

ok(r.valid === true, 'a real add is valid');

// Fee split: gross 100, fee = 100 * (2 * 0.2 / 100) = 0.4, net = 99.6.
near(r.exchange_fee_total, 0.4, 1e-9, 'round-trip fee on the add is 2x the exchange fee');
near(r.add_amount_net, 99.6, 1e-9, 'net add subtracts the fee');

// Adding at the same price keeps the net average at ~100.
near(r.average_price_net, 100, 1e-9, 'new net average unchanged when adding at the current average');

// TARGET must use ONE fee: 100 * (1 + (1 + 0.2)/100) = 101.2  (NOT 101.4 with a 2x fee).
near(r.target_price_net, 101.2, 1e-9, 'projected target uses a SINGLE fee (matches the live ladder target)');
ok(Math.abs(r.target_price_net - 101.4) > 1e-6, 'projected target is NOT the old 2x-fee value (101.4)');
// Ratio check independent of the avg: target / avg == 1 + (tp + fee)/100.
near(r.target_price_net / r.average_price_net, 1.012, 1e-9, 'target multiplier is 1 + (tp + 1x fee)/100');

// BREAK-EVEN must keep the round-trip 2x fee: 100 * (1 + 2*0.2/100) = 100.4.
near(r.break_even_net, 100.4, 1e-9, 'break-even uses the round-trip 2x fee');

// A different fee to prove the single-vs-double distinction isn't a coincidence of 0.2.
const r2 = AddFundsMath.computeAddFundsForward({
	sum: 200, qtySum: 2, addAmount: 200, addPrice: 100, price: 100, marketPrice: 100,
	currentAverageReal: 100, currentProfitPercent: 0, exchangeFee: 0.5, targetProfitPercent: 2
});
// target/avg = 1 + (2 + 0.5)/100 = 1.025 ; break-even/avg = 1 + 2*0.5/100 = 1.010
near(r2.target_price_net / r2.average_price_net, 1.025, 1e-9, 'target single-fee holds at fee 0.5 / tp 2');
near(r2.break_even_net / r2.average_price_net, 1.010, 1e-9, 'break-even 2x-fee holds at fee 0.5');

// Guard: a non-positive add is rejected, not turned into a bogus target.
const z = AddFundsMath.computeAddFundsForward({
	sum: 100, qtySum: 1, addAmount: 0, addPrice: 100, price: 100, marketPrice: 100,
	currentAverageReal: 100, currentProfitPercent: 0, exchangeFee: 0.2, targetProfitPercent: 1
});
ok(z.valid === false, 'a zero add is rejected (valid:false)');
ok(z.target_price_net === 0, 'a zero add produces no target rather than garbage');

console.log('AddFundsMath: ' + passed + ' assertions passed');
