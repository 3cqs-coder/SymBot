'use strict';

// Trust-gate tests for DCABot.creditPartialBuyFill (#66) — the function that books an actual (partial) safety
// BUY fill onto its ladder rung so coin the exchange executed is recorded instead of stranded.
//
// SCOPE OF THIS FILE (deliberate): only the fail-closed guards that return BEFORE recalculateOrders. Those
// guards are pure — no exchange, no DB — and they encode the single most important money-path invariant for
// this function: when the inputs are not trustworthy, it MUST refuse and leave the ladder untouched, so the
// caller falls back to the existing safe behavior (pause + reconcile alert) rather than writing a bad rung.
//
// NOT covered here, and why:
//   • The happy path recomputes the whole ladder through recalculateOrders, which reads and writes the deal via
//     a live Mongoose model (it hardcodes dryRun:false). That needs a database, so it belongs in the
//     integration/harness layer, not a pure assertion test.
//   • The fee convention (whether the exchange-reported fill is treated as gross or grossed-up for fees) is an
//     open cross-exchange question (#66 item 2) pending confirmation of CCXT fill/fee semantics across all
//     exchanges. Once that is settled, pin it with its own test against an extracted pure helper — do NOT
//     assert a specific gross/net number here while the convention is still undecided.
//
// Guards under test (DCABot.js creditPartialBuyFill):
//   (a) !(filledQtyNet > 0) || !(fillPrice > 0)  -> { success:false, msg:'no usable fill quantity/price' }
//   (b) orders[orderIndex] missing               -> { success:false, msg:'rung not found' }

const assert = require('assert');
const DCABot = require('../../../strategies/DCABot/DCABot.js');

const credit = DCABot.creditPartialBuyFill;

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// creditPartialBuyFill is exported and callable without DCABot.init(): the guards below run before any code
// that reads shareData, the exchange, or the database.
ok(typeof credit === 'function', 'creditPartialBuyFill is exported');

// A minimal two-rung ladder. Only its identity matters here — the guards never mutate it, and we assert that.
function makeOrders() {
	return [
		{ orderNo: 1, filled: 1, qty: '1000', amount: '20', qtySum: '1000', sum: '20', price: '0.02', manual: false, orderMetadata: { minimum_movement_amount: 0 } },
		{ orderNo: 2, filled: 0, qty: '2000', amount: '40', qtySum: '3000', sum: '60', price: '0.02' }
	];
}

// Run a guard case and assert BOTH the refusal AND that the ladder is byte-for-byte unchanged (fail closed).
async function expectRefused(label, args, expectMsg) {

	const orders = makeOrders();
	const before = JSON.stringify(orders);

	const res = await credit({ exchange: null, pair: 'ZORVX/USDT', config: {}, dealId: 'eval', orders, ...args });

	ok(res && res.success === false, label + ' -> success:false');
	if (expectMsg) { ok(res.msg === expectMsg, label + ' -> msg "' + expectMsg + '" (got "' + (res && res.msg) + '")'); }
	ok(JSON.stringify(orders) === before, label + ' -> ladder untouched');
}

(async () => {

	// (a) Non-usable fill quantity — every shape that must fail closed. A zero/negative/NaN quantity reaching
	// average = sum/qtySum would poison the deal (Infinity/NaN), so this guard is the primary safety net.
	await expectRefused('zero quantity',      { orderIndex: 1, filledQtyNet: 0,     fillPrice: 0.0225 }, 'no usable fill quantity/price');
	await expectRefused('negative quantity',  { orderIndex: 1, filledQtyNet: -5,    fillPrice: 0.0225 }, 'no usable fill quantity/price');
	await expectRefused('NaN quantity',       { orderIndex: 1, filledQtyNet: 'abc', fillPrice: 0.0225 }, 'no usable fill quantity/price');
	await expectRefused('null quantity',      { orderIndex: 1, filledQtyNet: null,  fillPrice: 0.0225 }, 'no usable fill quantity/price');

	// (a) Non-usable fill price — same guard, price side. A zero/negative price would corrupt the credited
	// rung's price/average/target.
	await expectRefused('zero price',         { orderIndex: 1, filledQtyNet: 2169.8, fillPrice: 0 },     'no usable fill quantity/price');
	await expectRefused('negative price',     { orderIndex: 1, filledQtyNet: 2169.8, fillPrice: -1 },    'no usable fill quantity/price');
	await expectRefused('NaN price',          { orderIndex: 1, filledQtyNet: 2169.8, fillPrice: 'x' },   'no usable fill quantity/price');

	// (b) Rung not found — a valid fill but an orderIndex that does not address a rung. Must refuse rather than
	// create or corrupt a rung. Covers out-of-range and a null hole in the array.
	await expectRefused('orderIndex out of range', { orderIndex: 99,  filledQtyNet: 2169.8, fillPrice: 0.0225 }, 'rung not found');
	{
		const orders = makeOrders();
		orders[1] = null;                       // a hole where the target rung should be
		const before = JSON.stringify(orders);
		const res = await credit({ exchange: null, pair: 'ZORVX/USDT', config: {}, dealId: 'eval', orders, orderIndex: 1, filledQtyNet: 2169.8, fillPrice: 0.0225 });
		ok(res && res.success === false && res.msg === 'rung not found', 'null rung at orderIndex -> rung not found');
		ok(JSON.stringify(orders) === before, 'null rung -> ladder untouched');
	}

	console.log('CreditPartialBuyFill: ' + passed + ' assertions passed');
	process.exit(0);

})().catch((e) => { console.error('CreditPartialBuyFill test error:', e); process.exit(1); });
