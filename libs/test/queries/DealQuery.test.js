'use strict';

// The DealQuery aggregation layer must NEVER sum realized profit across different quote currencies into
// one number (0.01 BTC + 100 USDT is not 100.01). Every reporting function collapses a per-currency
// bucket the same way: a single total_profit ONLY when one quote currency is present, otherwise
// total_profit:null with a per-currency breakdown and an explanatory note. These tests pin that contract
// on the two aggregation entry points whose collapse is pure JavaScript over DB-aggregated rows
// (getDealStatsOverTime and getPerformanceSummary), by injecting a fake getDeals that returns the rows a
// $group would produce. This is the boundary the code owns; MongoDB's own grouping is not under test.

const assert = require('assert');
const Common = require('../../app/Common.js');
const DealQuery = require('../../queries/DealQuery.js');

// The fake getDeals reads its behavior from this slot, so each test sets the rows it wants back. The
// signature mirrors the real DCABot.getDeals(query, options, projection, aggregatePipeline).
let dealsImpl = async () => [];

// The fake live deal tracker (a per-dealId snapshot the trading engine normally owns) plus a call counter,
// so the open-deal/risk tests can assert getDealTracker is deep-cloned exactly ONCE per request.
let trackerImpl = async () => ({});
let trackerCalls = 0;

// The fake balance cache (per exchange -> per currency -> { free }), for the exposure/shortfall test.
let balanceImpl = () => ({});

DealQuery.init({
	Common: {
		logger: () => {},
		// Delegate to the ONE canonical quote-currency helper, exactly as the app wires it at runtime.
		quoteCurrency: Common.quoteCurrency
	},
	DCABot: {
		getDeals: (...args) => dealsImpl(...args),
		getDealTracker: (...args) => { trackerCalls++; return trackerImpl(...args); },
		getBalanceCache: (...args) => balanceImpl(...args)
	},
	// getPerformanceSummary needs a processed-deals function to run its sample-extras pass; an empty
	// result is enough (the headline currency figures come from the aggregation, not the sample).
	DCABotManager: { getProcessedDeals: async () => [] }
});

let passed = 0, failed = 0;
function test(name, fn) {
	return Promise.resolve().then(fn).then(
		() => { passed++; console.log('  ok   - ' + name); },
		(e) => { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); }
	);
}

const FROM = new Date('2026-09-01T00:00:00Z');
const TO   = new Date('2026-09-30T23:59:59Z');

async function run() {

	console.log('\nDealQuery currency-bucketing contract:');

	// ── getDealStatsOverTime ──────────────────────────────────────────────────
	// Rows are shaped like the (period, pair) $group the pipeline produces.

	await test('getDealStatsOverTime: single quote currency -> scalar total per bucket and grand total', async () => {
		dealsImpl = async () => [
			{ _id: { period: '2026-09-01', pair: 'BTC/USDT' }, count: 3, profit: 30, wins: 2, losses: 1 },
			{ _id: { period: '2026-09-02', pair: 'ETH/USDT' }, count: 1, profit: -5, wins: 0, losses: 1 }
		];
		const r = await DealQuery.getDealStatsOverTime(FROM, TO, 'day', 'UTC');
		assert.strictEqual(r.success, true);
		assert.strictEqual(r.periods, 2);

		const b0 = r.buckets[0];
		assert.strictEqual(b0.period, '2026-09-01');
		assert.strictEqual(b0.total_profit, 30);
		assert.strictEqual(b0.profit_currency, 'USDT');
		assert.ok(!('profit_by_currency' in b0), 'single-currency bucket must not carry a breakdown');
		assert.strictEqual(b0.deals, 3);
		assert.strictEqual(b0.wins, 2);
		assert.strictEqual(b0.losses, 1);
		assert.strictEqual(b0.break_even, 0);

		// Grand totals: both pairs are USDT-quoted, so still a single scalar.
		assert.strictEqual(r.totals.total_profit, 25);
		assert.strictEqual(r.totals.profit_currency, 'USDT');
		assert.strictEqual(r.totals.deals, 4);
		assert.strictEqual(r.totals.wins, 2);
		assert.strictEqual(r.totals.losses, 2);
	});

	await test('getDealStatsOverTime: break-even deals bucket separately (not counted as losses)', async () => {
		// 4 deals: 1 win, 1 loss, 2 break-even (profit exactly 0). break_even must be its own bucket and
		// losses must NOT absorb the flat closes (deals = wins + losses + break_even).
		dealsImpl = async () => [
			{ _id: { period: '2026-09-01', pair: 'BTC/USDT' }, count: 4, profit: 12, wins: 1, losses: 1 }
		];
		const r = await DealQuery.getDealStatsOverTime(FROM, TO, 'day', 'UTC');
		const b = r.buckets[0];
		assert.strictEqual(b.deals, 4);
		assert.strictEqual(b.wins, 1);
		assert.strictEqual(b.losses, 1);
		assert.strictEqual(b.break_even, 2, 'two exact-zero closes are break-even, not losses');
		assert.strictEqual(r.totals.break_even, 2);
	});

	await test('getDealStatsOverTime: mixed quote currencies -> total_profit null, never summed', async () => {
		dealsImpl = async () => [
			{ _id: { period: '2026-09-01', pair: 'BTC/USDT' }, count: 2, profit: 100, wins: 2, losses: 0 },
			{ _id: { period: '2026-09-01', pair: 'ETH/BTC' }, count: 1, profit: 0.01, wins: 1, losses: 0 }
		];
		const r = await DealQuery.getDealStatsOverTime(FROM, TO, 'day', 'UTC');
		assert.strictEqual(r.success, true);
		assert.strictEqual(r.periods, 1);

		const b = r.buckets[0];
		assert.strictEqual(b.total_profit, null, 'a multi-currency bucket must not produce one total');
		assert.strictEqual(b.profit_currency, null);
		assert.deepStrictEqual(b.profit_by_currency, { USDT: 100, BTC: 0.01 });
		assert.ok(typeof b.note === 'string' && b.note.includes('USDT') && b.note.includes('BTC'), 'note must name the currencies');
		// Counts are currency-agnostic and still aggregate.
		assert.strictEqual(b.deals, 3);
		assert.strictEqual(b.wins, 3);

		// The grand total must also refuse to collapse across currencies.
		assert.strictEqual(r.totals.total_profit, null);
		assert.deepStrictEqual(r.totals.profit_by_currency, { USDT: 100, BTC: 0.01 });
		// Guard against the exact regression: 100 + 0.01 must never appear as a single total anywhere.
		assert.notStrictEqual(r.totals.total_profit, 100.01);
	});

	await test('getDealStatsOverTime: no matching deals -> empty series, zeroed totals', async () => {
		dealsImpl = async () => [];
		const r = await DealQuery.getDealStatsOverTime(FROM, TO, 'day', 'UTC');
		assert.strictEqual(r.success, true);
		assert.strictEqual(r.periods, 0);
		assert.deepStrictEqual(r.buckets, []);
		assert.strictEqual(r.totals.deals, 0);
		assert.strictEqual(r.totals.total_profit, 0);
		assert.strictEqual(r.totals.profit_currency, null);
	});

	// ── getPerformanceSummary ─────────────────────────────────────────────────
	// The pipeline call returns one row per pair; the later sample-docs call returns [] (extras are null).

	await test('getPerformanceSummary: single quote currency -> scalar total_profit', async () => {
		dealsImpl = async (q, o, p, pipeline) => (pipeline ? [
			{ _id: 'BTC/USDT', count: 2, profitSum: 40, pctSum: 6, wins: 2 },
			{ _id: 'SOL/USDT', count: 1, profitSum: 10, pctSum: 3, wins: 1 }
		] : []);
		const r = await DealQuery.getPerformanceSummary(null, null, null);
		assert.strictEqual(r.success, true);
		assert.strictEqual(r.completed_deals, 3);
		assert.strictEqual(r.total_profit, 50);
		assert.strictEqual(r.profit_currency, 'USDT');
		assert.ok(!('profit_by_currency' in r), 'single-currency summary must not carry a breakdown');
		assert.strictEqual(r.wins, 3);
	});

	await test('getPerformanceSummary: mixed quote currencies -> total_profit null with breakdown + note', async () => {
		dealsImpl = async (q, o, p, pipeline) => (pipeline ? [
			{ _id: 'BTC/USDT', count: 2, profitSum: 100, pctSum: 5, wins: 2 },
			{ _id: 'ETH/BTC', count: 1, profitSum: 0.01, pctSum: 2, wins: 1 }
		] : []);
		const r = await DealQuery.getPerformanceSummary(null, null, null);
		assert.strictEqual(r.success, true);
		assert.strictEqual(r.total_profit, null, 'must not sum USDT and BTC into one total');
		assert.strictEqual(r.profit_currency, null);
		assert.deepStrictEqual(r.profit_by_currency, { USDT: 100, BTC: 0.01 });
		assert.ok(typeof r.note === 'string' && r.note.length > 0, 'multi-currency summary must explain itself');
		assert.strictEqual(r.completed_deals, 3);
	});

	await test('getPerformanceSummary: realized aggregation EXCLUDES canceled deals (unrealized sellData must not count)', async () => {
		// A cancel is written with status:1 AND a full sellData whose profitQuote is unrealized, so realized
		// aggregations must filter it out. Capture the $match handed to the aggregation and assert the guard.
		let seenMatch = null;
		dealsImpl = async (q, o, p, pipeline) => { if (pipeline && pipeline[0] && pipeline[0].$match) { seenMatch = pipeline[0].$match; } return []; };
		await DealQuery.getPerformanceSummary(null, null, null);
		assert.ok(seenMatch, 'the aggregation ran with a $match');
		assert.strictEqual(seenMatch.status, 1, 'realized match still requires completed status');
		assert.deepStrictEqual(seenMatch.canceled, { '$ne': true }, 'realized match must exclude canceled deals');
	});

	// ── getOpenRiskSummary (exercises computeOpenDealsLive + openUnrealizedFields on the live path) ──
	// This is the risk surface a user acts on: underwater band counts, the stop-loss "near" list, and the
	// unrealized-P/L total that must be null (never 0) across currencies. Fixtures: getDeals returns the open
	// deal docs; getDealTracker returns the per-dealId live snapshot (price_last, profit, profit_percentage,
	// and stop-loss fields). Helper to build a deal doc + its tracker entry together.
	function openDeal(dealId, pair, info) {
		return { doc: { dealId: dealId, pair: pair, exchange: 'test', orders: [ { orderNo: 1, price: 100, filled: 1 } ] }, info: info };
	}
	function loadOpen(deals) {
		dealsImpl = async (q) => (q && q.status === 0) ? deals.map(d => d.doc) : [];
		const trackers = {};
		for (const d of deals) { trackers[d.doc.dealId] = { info: d.info }; }
		trackerImpl = async () => trackers;
	}

	await test('getOpenRiskSummary: single currency -> scalar total_unrealized_pnl; tracker cloned exactly once', async () => {
		loadOpen([
			openDeal('d1', 'BTC/USDT', { price_last: 100, profit: -30, profit_percentage: -3 }),
			openDeal('d2', 'SOL/USDT', { price_last: 10, profit: 20, profit_percentage: 5 })
		]);
		trackerCalls = 0;
		const r = await DealQuery.getOpenRiskSummary(3);
		assert.strictEqual(r.success, true);
		assert.strictEqual(r.total_unrealized_pnl, -10, 'single currency: the one rounded net total (-30 + 20)');
		assert.ok(!('unrealized_by_currency' in r), 'single currency: no per-currency breakdown');
		assert.strictEqual(r.open_deals, 2);
		// The single-clone contract: getOpenRiskSummary clones the tracker once and passes the snapshot into
		// computeOpenDealsLive, which must NOT fetch it again.
		assert.strictEqual(trackerCalls, 1, 'the live tracker must be cloned exactly once per request');
	});

	await test('getOpenRiskSummary: mixed currencies -> total_unrealized_pnl null (never summed) + breakdown', async () => {
		loadOpen([
			openDeal('d1', 'BTC/USDT', { price_last: 100, profit: 100, profit_percentage: 4 }),
			openDeal('d2', 'ETH/BTC', { price_last: 0.05, profit: 0.01, profit_percentage: 2 })
		]);
		const r = await DealQuery.getOpenRiskSummary(3);
		assert.strictEqual(r.total_unrealized_pnl, null, 'must NOT sum across currencies (the round2(null)=0 trap)');
		assert.deepStrictEqual(r.unrealized_by_currency, { USDT: 100, BTC: 0.01 });
		assert.ok(typeof r.unrealized_note === 'string' && r.unrealized_note.length > 0, 'a multi-currency note is surfaced');
	});

	await test('getOpenRiskSummary: underwater band counters use <= boundaries', async () => {
		loadOpen([
			openDeal('a', 'BTC/USDT', { price_last: 1, profit: -1, profit_percentage: -2 }),    // exactly -2: band2 only
			openDeal('b', 'BTC/USDT', { price_last: 1, profit: -1, profit_percentage: -5 }),    // exactly -5: band2 + band5
			openDeal('c', 'BTC/USDT', { price_last: 1, profit: -1, profit_percentage: -10 }),   // exactly -10: all three
			openDeal('d', 'BTC/USDT', { price_last: 1, profit: 1, profit_percentage: 3 })       // in profit: none
		]);
		const r = await DealQuery.getOpenRiskSummary(3);
		assert.strictEqual(r.underwater_over_2pct, 3, '<= -2 catches -2, -5, -10');
		assert.strictEqual(r.underwater_over_5pct, 2, '<= -5 catches -5, -10');
		assert.strictEqual(r.underwater_over_10pct, 1, '<= -10 catches only -10');
	});

	await test('getOpenRiskSummary: a bad nearStopLossPct is clamped to the 3% default', async () => {
		// currentPrice 100, stop 98 -> 2% above stop. With a nonsense nearPct (0) it must clamp to 3 and still
		// list the deal (2% <= 3%), rather than using 0 and listing nothing.
		loadOpen([
			openDeal('d1', 'BTC/USDT', { price_last: 100, profit: -1, profit_percentage: -1, stop_loss_enabled: true, stop_loss_price: 98, stop_loss_armed: true })
		]);
		const r = await DealQuery.getOpenRiskSummary(0);
		assert.strictEqual(r.near_stop_loss_threshold_pct, 3, 'a nonsense nearPct clamps to the 3% default');
		assert.strictEqual(r.near_stop_loss.length, 1, 'the deal 2% above its stop is within the clamped 3% band');
		assert.strictEqual(r.near_stop_loss[0].dealId, 'd1');
	});

	await test('getOpenRiskSummary: a deal far above its stop is NOT listed as near', async () => {
		loadOpen([
			openDeal('d1', 'BTC/USDT', { price_last: 100, profit: 5, profit_percentage: 5, stop_loss_enabled: true, stop_loss_price: 80, stop_loss_armed: true })   // 20% above stop
		]);
		const r = await DealQuery.getOpenRiskSummary(3);
		assert.strictEqual(r.near_stop_loss.length, 0, '20% above the stop is outside the 3% near band');
		assert.strictEqual(r.stop_loss_armed_count, 1, 'an armed stop-loss is still reported in the armed count');
	});

	// ── summarizeDeal (via getDeal) — the reducer behind eight deal-list entry points ──────────────
	// Drive it through getDeal(dealId): getDeals returns the one doc, getProcessedDeals stub returns []
	// so getOutcome is null and the pure fields are exercised. Pins the load-bearing behaviors that have
	// each fixed a real bug: ladderExhausted (SymBot's own >= orders.length-1 test, null for no orders),
	// string-boolean paused flags, pause-reason normalization, and the lastActivity close-day guard.
	function loadOneDeal(doc) { dealsImpl = async (q) => (q && q.dealId === doc.dealId) ? [ doc ] : []; }

	await test('summarizeDeal: ladderExhausted uses filled >= orders.length - 1', async () => {
		// 3 orders (base + 2 SO), base + SO1 filled -> filled(2) >= 3-1 (2) -> exhausted.
		loadOneDeal({ dealId: 'd1', pair: 'BTC/USDT', status: 0, orders: [
			{ orderNo: 1, filled: 1 }, { orderNo: 2, filled: 1 }, { orderNo: 3, filled: 0 }
		] });
		const r = await DealQuery.getDeal('d1');
		assert.strictEqual(r.deals[0].ladderExhausted, true, 'spent when filled >= orders.length - 1');
		assert.strictEqual(r.deals[0].safetyOrdersUsed, 1, 'filled.length - 1 fallback');
	});

	await test('summarizeDeal: ladderExhausted is false while rungs remain, null with no orders', async () => {
		loadOneDeal({ dealId: 'd2', pair: 'BTC/USDT', status: 0, orders: [
			{ orderNo: 1, filled: 1 }, { orderNo: 2, filled: 1 }, { orderNo: 3, filled: 0 }, { orderNo: 4, filled: 0 }
		] });
		const withRungs = await DealQuery.getDeal('d2');
		assert.strictEqual(withRungs.deals[0].ladderExhausted, false, '2 filled < 4-1 (3): not exhausted');

		loadOneDeal({ dealId: 'd3', pair: 'BTC/USDT', status: 0, orders: [] });
		const noOrders = await DealQuery.getDeal('d3');
		assert.strictEqual(noOrders.deals[0].ladderExhausted, null, 'no orders -> null, never a misleading false');
	});

	await test('summarizeDeal: string-stored boolean flags are read as booleans', async () => {
		loadOneDeal({ dealId: 'd4', pair: 'BTC/USDT', status: 0, orders: [ { orderNo: 1, filled: 1 } ],
			paused: 'true', pausedBuy: false, pausedSell: 'false' });
		const r = await DealQuery.getDeal('d4');
		assert.strictEqual(r.deals[0].paused, true, 'the string "true" reads as paused');
		assert.strictEqual(r.deals[0].pausedSell, false, 'the string "false" reads as not paused');
		assert.strictEqual(r.deals[0].pausedBuy, false);
	});

	await test('summarizeDeal: a meaningless pause reason collapses to empty', async () => {
		loadOneDeal({ dealId: 'd5', pair: 'BTC/USDT', status: 0, orders: [ { orderNo: 1, filled: 1 } ], pauseReason: 'false' });
		const junk = await DealQuery.getDeal('d5');
		assert.strictEqual(junk.deals[0].pauseReason, '', 'the string "false" is not a real reason');

		loadOneDeal({ dealId: 'd6', pair: 'BTC/USDT', status: 0, orders: [ { orderNo: 1, filled: 1 } ], pauseReason: 'waiting for signal' });
		const real = await DealQuery.getDeal('d6');
		assert.strictEqual(real.deals[0].pauseReason, 'waiting for signal', 'a genuine reason is kept');
	});

	await test('summarizeDeal: lastActivity uses the close date for a completed deal, not updatedAt', async () => {
		// updatedAt is deliberately much later than the close date (simulating a fleet-wide re-save); the
		// close date must win so log lookups keyed off lastActivity still land on the right day.
		loadOneDeal({ dealId: 'd7', pair: 'BTC/USDT', status: 1, orders: [ { orderNo: 1, filled: 1 } ],
			date: '2026-01-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', sellData: { date: '2026-01-05T00:00:00Z' } });
		const r = await DealQuery.getDeal('d7');
		assert.strictEqual(r.deals[0].lastActivity, new Date('2026-01-05T00:00:00Z').toISOString(), 'close date wins over a later updatedAt');
	});

	// ── getDrawdownRisk — threshold clamp + underwater comparator ───────────────────────────────────
	await test('getDrawdownRisk: filters unrealizedPct <= -threshold, worst-first', async () => {
		loadOpen([
			openDeal('a', 'BTC/USDT', { price_last: 1, profit: -1, profit_percentage: -5 }),
			openDeal('b', 'BTC/USDT', { price_last: 1, profit: -1, profit_percentage: -12 }),
			openDeal('c', 'BTC/USDT', { price_last: 1, profit: -1, profit_percentage: -20 })
		]);
		const r = await DealQuery.getDrawdownRisk(10);   // 10% underwater threshold
		assert.strictEqual(r.success, true);
		assert.strictEqual(r.underwater_threshold_pct, 10);
		assert.strictEqual(r.underwater_count, 2, 'only -12 and -20 are <= -10');
		assert.deepStrictEqual(r.underwater.map(d => d.dealId), [ 'c', 'b' ], 'worst (most negative) first');
	});

	await test('getDrawdownRisk: a bad threshold clamps to the 10% default', async () => {
		loadOpen([ openDeal('a', 'BTC/USDT', { price_last: 1, profit: -1, profit_percentage: -11 }) ]);
		const zero = await DealQuery.getDrawdownRisk(0);          // nonsense -> default 10
		assert.strictEqual(zero.underwater_threshold_pct, 10, '0 clamps to 10, not 0');
		assert.strictEqual(zero.underwater_count, 1, '-11 is <= -10');
		const huge = await DealQuery.getDrawdownRisk(500);        // > 100 -> default 10
		assert.strictEqual(huge.underwater_threshold_pct, 10);
	});

	// ── getOpenOrdersSummary — safety/base tallies + the query-failure guard ────────────────────────
	await test('getOpenOrdersSummary: tallies safety/base and ranks by safety-order count', async () => {
		dealsImpl = async (q, o, p, pipeline) => (pipeline ? [
			{ dealId: 'd1', pair: 'BTC/USDT', safety: 3, base: 1 },
			{ dealId: 'd2', pair: 'ETH/USDT', safety: 1, base: 1 }
		] : []);
		const r = await DealQuery.getOpenOrdersSummary(5);
		assert.strictEqual(r.success, true);
		assert.strictEqual(r.open_deals, 2);
		assert.strictEqual(r.total_safety_orders, 4);
		assert.strictEqual(r.total_base_orders, 2);
		assert.strictEqual(r.total_orders, 6);
		assert.strictEqual(r.max_safety_orders, 3);
		assert.strictEqual(r.avg_safety_orders_per_deal, 2);
		assert.strictEqual(r.by_deal[0].dealId, 'd1', 'ranked by safety-order count, highest first');
	});

	await test('getOpenOrdersSummary: a failed query (undefined) is reported, not read as zero orders', async () => {
		dealsImpl = async (q, o, p, pipeline) => (pipeline ? undefined : []);
		const r = await DealQuery.getOpenOrdersSummary(5);
		assert.strictEqual(r.success, false, 'undefined rows means the query failed — must not report success');

		dealsImpl = async (q, o, p, pipeline) => (pipeline ? [] : []);
		const empty = await DealQuery.getOpenOrdersSummary(5);
		assert.strictEqual(empty.success, true);
		assert.strictEqual(empty.open_deals, 0, 'a genuine empty result is zero open orders');
	});

	// ── getExposureSummary — filled-order detection + shortfall flag ─────────────────────────────────
	await test('getExposureSummary: splits deployed vs max, and flags a shortfall against the balance', async () => {
		// One BTC/USDT deal: 100 deployed (filled), 200 more if the unfilled SO fills -> 300 max, 200 additional.
		dealsImpl = async (q) => (q && q.status === 0) ? [
			{ dealId: 'd1', pair: 'BTC/USDT', orders: [ { amount: 100, filled: 1 }, { amount: 200, filled: 0 } ] }
		] : [];

		balanceImpl = () => ({ myexchange: { USDT: { free: 1000 } } });
		const ok = await DealQuery.getExposureSummary();
		assert.strictEqual(ok.success, true);
		const g = ok.groups[0];
		assert.strictEqual(g.deployed_now, 100);
		assert.strictEqual(g.max_if_all_fill, 300);
		assert.strictEqual(g.additional_needed_if_all_fill, 200);
		assert.strictEqual(g.potential_shortfall, false, '1000 available covers the 200 additional');

		balanceImpl = () => ({ myexchange: { USDT: { free: 150 } } });
		const short = await DealQuery.getExposureSummary();
		assert.strictEqual(short.groups[0].potential_shortfall, true, '150 available cannot cover the 200 additional');
	});

	// ── currency-aware money rounding ────────────────────────────────────────────────────────────────
	// A fixed 2-decimal round silently destroys crypto-quoted amounts (0.0049 BTC -> 0.00). Money figures
	// must keep more precision for a non-fiat quote, while fiat/stablecoin quotes still read at 2dp.
	await test('getPerformanceSummary: a sub-cent BTC-quote profit is preserved, not rounded to zero', async () => {
		dealsImpl = async (q, o, p, pipeline) => (pipeline ? [
			{ _id: 'ETH/BTC', count: 3, profitSum: 0.0049, pctSum: 2, wins: 2 }
		] : []);
		const r = await DealQuery.getPerformanceSummary(null, null, null);
		assert.strictEqual(r.profit_currency, 'BTC');
		assert.strictEqual(r.total_profit, 0.0049, 'the BTC amount must survive (not collapse to 0.00)');
	});

	await test('getPerformanceSummary: a fiat/stablecoin quote still rounds to 2 decimals', async () => {
		dealsImpl = async (q, o, p, pipeline) => (pipeline ? [
			{ _id: 'BTC/USDT', count: 2, profitSum: 12.3456, pctSum: 3, wins: 2 }
		] : []);
		const r = await DealQuery.getPerformanceSummary(null, null, null);
		assert.strictEqual(r.profit_currency, 'USDT');
		assert.strictEqual(r.total_profit, 12.35, 'USDT rounds to 2dp as before');
	});

	await test('getDealStatsOverTime: a sub-cent BTC-quote period profit is preserved', async () => {
		dealsImpl = async () => [ { _id: { period: '2026-09-01', pair: 'ETH/BTC' }, count: 1, profit: 0.00123456, wins: 1 } ];
		const r = await DealQuery.getDealStatsOverTime(FROM, TO, 'day', 'UTC');
		assert.strictEqual(r.buckets[0].total_profit, 0.00123456, 'BTC bucket keeps 8dp precision');
		assert.strictEqual(r.buckets[0].profit_currency, 'BTC');
	});

	// ── getPairPerformance cross-currency ranking ────────────────────────────────────────────────────
	// When pairs span more than one quote currency, best/worst and profit ordering must use avg_profit_percent
	// (currency-agnostic), never raw total_profit across currencies (0.5 BTC is not less than 100 USDT).
	await test('getPairPerformance: multi-currency best/worst ranks by percent, not raw amount', async () => {
		dealsImpl = async (q, o, p, pipeline) => (pipeline ? [
			{ _id: 'BTC/USDT', deals: 5, profitSum: 100, pctSum: 10, wins: 3 },   // big USDT amount, low % (2%/deal)
			{ _id: 'ETH/BTC',  deals: 2, profitSum: 0.5, pctSum: 100, wins: 2 }    // small BTC amount, high % (50%/deal)
		] : []);
		const r = await DealQuery.getPairPerformance(null, null, null, null, 'most_profitable');
		assert.strictEqual(r.success, true);
		assert.strictEqual(r.best_pair.pair, 'ETH/BTC', 'best is the higher-% pair, not the larger raw amount in another currency');
		assert.strictEqual(r.worst_pair.pair, 'BTC/USDT');
		assert.ok(typeof r.note === 'string' && r.note.length > 0, 'a multi-currency ranking note is surfaced');
	});

	await test('getPairPerformance: single-currency ranking still uses total_profit', async () => {
		dealsImpl = async (q, o, p, pipeline) => (pipeline ? [
			{ _id: 'BTC/USDT', deals: 5, profitSum: 100, pctSum: 10, wins: 3 },
			{ _id: 'SOL/USDT', deals: 2, profitSum: 5, pctSum: 40, wins: 2 }
		] : []);
		const r = await DealQuery.getPairPerformance(null, null, null, null, 'most_profitable');
		assert.strictEqual(r.best_pair.pair, 'BTC/USDT', 'single currency: highest total_profit wins');
		assert.ok(!('note' in r), 'no cross-currency note when all pairs share one quote currency');
	});

	// ── getOpenDealsStatus — model-size budget + slimmed shape ──────────────────────────────────────
	// This result feeds the AI's get_open_deals_status tool. It must stay under the model result-size cap
	// (AITools MAX_RESULT_CHARS, 12000) even at the top of the open-deal range, or the model receives a
	// truncated stub and fabricates. The worst-first `deals` array (redundant per-deal detail) is dropped;
	// closest_to_take_profit is the single per-deal list and must still carry the next-safety-order fields.
	await test('getOpenDealsStatus: many open deals stay under the 12000-char model cap, with the slimmed shape', async () => {
		const many = [];
		for (let i = 0; i < 60; i++) {
			// Long pair / deal-id strings so the measured size is a conservative (large) estimate of production.
			many.push(openDeal('LONGCOIN_USDT-ABCDEFG-17600000' + (10 + i), 'LONGCOIN' + (100 + i) + '/USDT',
				{ price_last: 1 + i, price_average: 1.1 + i, price_target: 1.2 + i, profit: (i % 2 ? -2.71 : 3.14), profit_percentage: (i % 2 ? -1.3 : 1.5), safety_orders_used: i % 6 }));
		}
		loadOpen(many);
		const r = await DealQuery.getOpenDealsStatus();
		assert.strictEqual(r.success, true);
		assert.strictEqual(r.open_deals_total, 60, 'every open deal is counted');
		assert.ok(JSON.stringify(r).length < 12000, 'serialized result stays under the model result-size cap');
		assert.ok(!('deals' in r) && !('deals_shown' in r), 'the redundant worst-first deals array is removed');
		assert.ok(Array.isArray(r.closest_to_take_profit) && r.closest_to_take_profit.length === 25, 'the per-deal list is present and capped');
		assert.ok(r.biggest_gain && r.biggest_loss, 'the authoritative single extremes are present');
		assert.ok(typeof r.note === 'string' && /get_top_deals/.test(r.note), 'the note points the model to the full worst-ranking tool');
		const e = r.closest_to_take_profit[0];
		assert.ok('pctToNextSafetyOrder' in e && 'nextSafetyOrderReady' in e, 'the next-safety-order capability is preserved on the per-deal entries');
		assert.ok('currentPrice' in e && 'averagePrice' in e && 'targetPrice' in e, 'full per-deal detail is preserved for the model and the breakdown render');
	});

	console.log('\nDealQuery: ' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
}

run();
