'use strict';

// Pins the take-profit tick STEP-UP branch in calculateTargetPrice (DCABot.js). On a coarse-tick or low-priced
// pair, exchange precision can round the take-profit target BELOW the exact price×(1 + (TP + fee)/100), which
// would make the deal sell short of the configured take-profit unless slippage happened to cover the gap. The
// code steps the target up one exchange tick so it is always >= the exact target. targetLadder.test.js uses an
// identity priceToPrecision, so that branch never runs there; this test drives it with a truncating stub in both
// precision modes, plus the fail-safe and the no-op regression guard. Pure: only a stub exchange is needed.

const assert = require('assert');
const DCABot = require('../../../strategies/DCABot/DCABot.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// Truncate helpers (real ccxt truncates price precision by default), float-guarded.
const truncDp = (p, dp) => Math.floor(Number(p) * Math.pow(10, dp) + 1e-9) / Math.pow(10, dp);
const truncTick = (p, tick) => Math.floor(Number(p) / tick + 1e-9) * tick;

(async () => {

	// price 0.68, TP 1%, fee 0 → exact target 0.6868. Truncating to 2 dp gives 0.68 (< exact), so the branch
	// must step up one tick (0.01) to 0.69, which is >= 0.6868.
	const EXACT = 0.68 * 1.01;   // 0.6868

	// ── Decimal-places precision (precisionMode != 4) ──
	const decEx = {
		precisionMode: 2,
		priceToPrecision: (pair, price) => truncDp(price, 2),
		market: () => ({ precision: { price: 2 } })
	};
	const decTarget = Number(await DCABot.calculateTargetPrice({ exchange: decEx, pair: 'AAA/USDT', price: 0.68, takeProfit: 1, exchangeFee: 0 }));
	ok(decTarget >= EXACT - 1e-9, 'decimal mode: stepped target is >= the exact take-profit target (' + decTarget + ' >= ' + EXACT + ')');
	ok(Math.abs(decTarget - 0.69) < 1e-9, 'decimal mode: target stepped up exactly one tick to 0.69');

	// ── TICK_SIZE precision (precisionMode 4, precision IS the tick) ──
	const tickEx = {
		precisionMode: 4,
		priceToPrecision: (pair, price) => truncTick(price, 0.01),
		market: () => ({ precision: { price: 0.01 } })
	};
	const tickTarget = Number(await DCABot.calculateTargetPrice({ exchange: tickEx, pair: 'AAA/USDT', price: 0.68, takeProfit: 1, exchangeFee: 0 }));
	ok(tickTarget >= EXACT - 1e-9, 'tick mode: stepped target is >= the exact target (' + tickTarget + ')');

	// ── Fail-safe: if market(pair) throws, the original filtered target is returned unchanged (no throw) ──
	const throwEx = {
		precisionMode: 2,
		priceToPrecision: (pair, price) => truncDp(price, 2),
		market: () => { throw new Error('no market'); }
	};
	const safeTarget = Number(await DCABot.calculateTargetPrice({ exchange: throwEx, pair: 'AAA/USDT', price: 0.68, takeProfit: 1, exchangeFee: 0 }));
	ok(Math.abs(safeTarget - 0.68) < 1e-9, 'fail-safe: a market() error leaves the original filtered target (0.68) unchanged');

	// ── Regression guard: when the filtered target already >= exact, NO step-up happens ──
	const identEx = {
		precisionMode: 2,
		priceToPrecision: (pair, price) => Number(price),   // identity → filtered == exact
		market: () => ({ precision: { price: 2 } })
	};
	const noStep = Number(await DCABot.calculateTargetPrice({ exchange: identEx, pair: 'AAA/USDT', price: 100, takeProfit: 1, exchangeFee: 0.2 }));
	ok(Math.abs(noStep - 101.2) < 1e-6, 'no step-up when the filtered target already meets the exact target (stays 101.2)');

	console.log('targetTickStepUp: ' + passed + ' assertions passed');
	process.exit(0);
})().catch((e) => { console.error('targetTickStepUp test error:', e && e.stack || e); process.exit(1); });
