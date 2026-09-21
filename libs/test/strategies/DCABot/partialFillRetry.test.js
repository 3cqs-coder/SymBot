'use strict';

// Simulation of the SHARED partial-fill retry logic that both the buy and sell paths now use
// (retryPartialFill + partialFillShortfallPercent in DCABot.js). The loop is driven with a MOCK exchange
// (injected via the `io` hook) so every branch is exercised deterministically, with no network or DB:
// genuine partial that completes, partial that lands within threshold, remainder below the exchange
// minimum, retry cap reached, cancel/panic mid-retry, empty fill firing onEmptyFill (the NSF settle-wait),
// buy-vs-sell price side, and value accumulation via onFill. Also pins the shortfall math and the buy
// "effectively complete despite a partial status" gate (the Coinbase 100%-but-"partial" case).

const assert = require('assert');
const DCABot = require('../../../strategies/DCABot/DCABot.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function near(a, b, m) { ok(Math.abs(Number(a) - Number(b)) <= 1e-9, m + ' (got ' + a + ', want ' + b + ')'); }

const shortfall = DCABot.partialFillShortfallPercent;
const retry = DCABot.retryPartialFill;

// ── Mock exchange I/O ────────────────────────────────────────────────────────
// filterAmount returns 0 (below minimum) for anything under `minAmount`, else identity — models an
// exchange minimum. filterPrice / getSymbol are identity/scripted. delay + log are no-ops.
function makeIo({ ask = 100, bid = 100, minAmount = 0 } = {}) {
	return {
		getSymbol: async () => ({ data: { ask, bid } }),
		filterPrice: async (_e, _p, price) => price,
		filterAmount: async (_e, _p, qty) => (Number(qty) < minAmount ? 0 : Number(qty)),
		orderFilledQty: (o) => Number(o && o.filled) || 0,
		delay: async () => {},
		log: () => {}
	};
}
// placeOrder that fills a scripted amount per attempt (array), defaulting to `fill` each time.
function scriptedPlaceOrder(fills, opts = {}) {
	let n = 0;
	const captured = [];
	const fn = async ({ qty, price }) => {
		captured.push({ qty, price });
		const filled = Array.isArray(fills) ? (fills[n] !== undefined ? fills[n] : 0) : fills;
		n++;
		return { filled, data: { id: 'ord' + n }, data_order: { price, average: price, quantity: filled }, ...(opts.extra ? opts.extra(n) : {}) };
	};
	fn.captured = captured;
	return fn;
}

(async () => {

	// ── partialFillShortfallPercent ──
	near(shortfall(90, 100), 10, 'shortfall 90/100 = 10%');
	near(shortfall(100, 100), 0, 'full fill = 0% shortfall');
	near(shortfall(99.5, 100), 0.5, 'near-full = 0.5% shortfall');
	near(shortfall(0, 100), 0, 'no fill reported = 0 (treated as its own case, not a partial)');
	near(shortfall(100, 0), 0, 'zero requested = 0 (guard)');

	// ── The buy "effectively complete" gate mirrors the sell gate (threshold = 1%) ──
	const THRESH = 1;
	ok(shortfall(100, 100) <= THRESH, '100% fill → effectively complete (Coinbase 100%-but-partial case)');
	ok(shortfall(99.5, 100) <= THRESH, '99.5% fill → effectively complete');
	ok(!(shortfall(98, 100) <= THRESH), '98% fill (2% shortfall) → GENUINE partial, not complete');

	const base = { side: 'buy', exchange: {}, pair: 'X/USD', dealId: 'D1', fallbackPrice: 100, isAborted: () => false };

	// 1. Genuine partial that COMPLETES on the first retry (90 → +10 = 100).
	{
		const r = await retry({ ...base, requestedQty: 100, initialFilledQty: 90, placeOrder: scriptedPlaceOrder([10]), io: makeIo() });
		near(r.totalFilled, 100, '1: retry completes the fill'); near(r.qtyRemaining, 0, '1: nothing remaining'); ok(r.retryCount === 1, '1: one retry');
	}

	// 2. Partial that lands WITHIN threshold and stops (90 → +9 = 99, 1% remaining ≤ 1% → break).
	{
		const r = await retry({ ...base, requestedQty: 100, initialFilledQty: 90, placeOrder: scriptedPlaceOrder([9, 9, 9]), io: makeIo() });
		near(r.totalFilled, 99, '2: stops within threshold'); ok(r.retryCount === 1, '2: stopped after first retry hit threshold');
	}

	// 3. Remainder falls BELOW the exchange minimum → halt, accept fill (99.6 filled, 0.4 remaining < min 0.5).
	{
		const r = await retry({ ...base, requestedQty: 100, initialFilledQty: 99.6, placeOrder: scriptedPlaceOrder([0]), io: makeIo({ minAmount: 0.5 }) });
		near(r.totalFilled, 99.6, '3: halts on below-minimum remainder, accepts fill'); ok(r.retryCount === 1, '3: incremented then halted, no double-buy');
	}

	// 4. Retry CAP reached (fills 1 each attempt, never within threshold) → stops at maxRetries (10).
	{
		const po = scriptedPlaceOrder(Array(20).fill(1));
		const r = await retry({ ...base, requestedQty: 100, initialFilledQty: 50, placeOrder: po, io: makeIo() });
		ok(r.retryCount === 10, '4: stops at the retry cap (10)'); near(r.totalFilled, 60, '4: 50 + 10×1'); ok(po.captured.length === 10, '4: exactly 10 orders placed');
	}

	// 5. Cancel / panic mid-retry → loop breaks immediately.
	{
		let calls = 0;
		const r = await retry({ ...base, requestedQty: 100, initialFilledQty: 50, placeOrder: scriptedPlaceOrder([1,1,1,1]), isAborted: () => (++calls > 2), io: makeIo() });
		ok(r.retryCount <= 2, '5: cancel/panic stops the loop early (retryCount ' + r.retryCount + ')');
	}

	// 6. Empty fill fires onEmptyFill (the NSF settle-wait hook) and does not advance the total.
	{
		let empties = 0;
		const r = await retry({ ...base, requestedQty: 100, initialFilledQty: 50, placeOrder: scriptedPlaceOrder([0, 0, 50]),
			onEmptyFill: async () => { empties++; }, io: makeIo() });
		ok(empties === 2, '6: onEmptyFill fired for each zero-fill attempt'); near(r.totalFilled, 100, '6: only real fills accumulate (50 + 50)');
	}

	// 7. Price side: a BUY uses the ask, a SELL uses the bid.
	{
		const poBuy = scriptedPlaceOrder([10]);
		await retry({ ...base, side: 'buy', requestedQty: 100, initialFilledQty: 90, placeOrder: poBuy, io: makeIo({ ask: 111, bid: 99 }) });
		near(poBuy.captured[0].price, 111, '7: buy retry lifts the ask');
		const poSell = scriptedPlaceOrder([10]);
		await retry({ ...base, side: 'sell', requestedQty: 100, initialFilledQty: 90, placeOrder: poSell, io: makeIo({ ask: 111, bid: 99 }) });
		near(poSell.captured[0].price, 99, '7: sell retry hits the bid');
	}

	// 8. Value accumulation via onFill (volume-weighted price), as the buy caller uses.
	{
		let value = 0;
		const r = await retry({ ...base, requestedQty: 100, initialFilledQty: 0, placeOrder: scriptedPlaceOrder([50, 50]),
			onFill: async (filled, orderResult, priceUsed) => { value += filled * priceUsed; }, io: makeIo({ ask: 2 }) });
		near(r.totalFilled, 100, '8: full fill across two retries'); near(value, 200, '8: onFill accumulated value 100×2');
	}

	console.log('partialFillRetry: ' + passed + ' assertions passed');
	process.exit(0);
})().catch((e) => { console.error('partialFillRetry test error:', e); process.exit(1); });
