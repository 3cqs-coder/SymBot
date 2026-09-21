'use strict';

// Tests the 'performance_report' recipe handler in isolation by stubbing DealQuery.getPerformanceSummary
// (the realized-performance aggregation) and getPortfolioSummary (the open snapshot). Verifies: a normal
// period delivers ONE informational digest with the realized figures + open snapshot; multi-currency profit
// is shown per-currency (never summed); an empty period still reports by default but is SKIPPED when
// skip_when_empty is set; and a data-fetch failure delivers a failure notice and returns an error status.
// It also pins the pure formatters. No DB, no model, no scheduler.

const assert = require('assert');
const DealQuery = require('../../queries/DealQuery.js');
const Handler = require('../../scheduledtasks/PerformanceReportHandler.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; console.log('  ok   - ' + m); }

const PERF = {
	success: true, error: null, completed_deals: 12,
	total_profit: 345.67, profit_currency: 'USDT',
	avg_profit_percent: 1.8, win_rate_percent: 75, wins: 9, losses: 3,
	total_safety_orders: 40, avg_duration_mins: 1500,
	best_deal: { dealId: 'SOL_USDT-1', pair: 'SOL/USDT', profit_percent: 3.2, profit: 90 },
	worst_deal: { dealId: 'ADA_USDT-2', pair: 'ADA/USDT', profit_percent: -1.1, profit: -20 }
};
const PERF_MULTI = {
	success: true, error: null, completed_deals: 5, total_profit: null, profit_currency: null,
	profit_by_currency: { USDT: 120.5, BTC: 0.004 }, avg_profit_percent: 0.9, win_rate_percent: 60, wins: 3, losses: 2,
	note: 'Completed deals span multiple quote currencies.'
};
const PERF_EMPTY = { success: true, error: null, completed_deals: 0, total_profit: 0, profit_currency: 'USDT', wins: 0, losses: 0 };
const PORTFOLIO = { success: true, open_deals: 4, deployed_funds: 800.25, quote_currency: 'USDT' };

function makeShareData(cap, opts) {
	opts = opts || {};
	return {
		Common: { logger: () => {}, getInstanceName: async () => (opts.name != null ? opts.name : 'Coinbase-Real') },
		appData: {},
		ScheduleNotifier: {
			resolveTargets: (s) => (s && s.notifications) || [ { type: 'browser', target: {}, on: [ 'always' ] } ],
			deliver: async (t, p) => { cap.push(p); return { delivered: 1 }; }
		}
	};
}
function registerAndGet(sd) {
	let fn = null;
	Handler.register({ registerHandler: (type, h) => { assert.strictEqual(type, 'performance_report'); fn = h; } }, sd);
	assert.ok(typeof fn === 'function');
	return fn;
}

(async () => {

	const origPerf = DealQuery.getPerformanceSummary, origPort = DealQuery.getPortfolioSummary;
	DealQuery.getPortfolioSummary = async () => PORTFOLIO;

	// (1) Normal period → one informational digest with realized figures + open snapshot + instance name.
	DealQuery.getPerformanceSummary = async () => PERF;
	{
		const cap = [];
		const fn = registerAndGet(makeShareData(cap));
		const res = await fn({ schedule_id: 's1', label: 'Performance report', settings: { period_hours: 24 } });
		ok(res.status === 'ok', 'normal run returns ok');
		ok(cap.length === 1 && cap[0].type === 'info' && cap[0].status === 'ok', 'one informational digest delivered');
		const msg = cap[0].message;
		ok(/Coinbase-Real/.test(msg), 'digest is titled with the instance name (so Hub instances are distinguishable)');
		ok(/last 24 hours/.test(msg), 'digest states the look-back window');
		ok(/Closed deals: 12/.test(msg) && /\+345\.67 USDT/.test(msg), 'digest shows closed-deal count and realized profit');
		ok(/Win rate: 75%\s*\(9W \/ 3L\)/.test(msg), 'digest shows win rate and W/L');
		ok(/SOL\/USDT 3\.2%/.test(msg) && /ADA\/USDT -1\.1%/.test(msg), 'digest shows best and worst deal');
		ok(/4 open deals/.test(msg) && /deployed 800\.25 USDT/.test(msg), 'digest shows the current open snapshot');
	}

	// (2) Multi-currency period → per-currency profit, no nonsensical single total, includes the note.
	DealQuery.getPerformanceSummary = async () => PERF_MULTI;
	{
		const cap = [];
		const fn = registerAndGet(makeShareData(cap));
		await fn({ schedule_id: 's2', label: 'Performance report', settings: { period_hours: 168 } });
		const msg = cap[0].message;
		ok(/last 7 days/.test(msg), 'a 168h window reads as "last 7 days"');
		ok(/\+120\.5 USDT/.test(msg) && /\+0\.004 BTC/.test(msg), 'multi-currency profit is shown per-currency, never summed');
		ok(/multiple quote currencies/.test(msg), 'the multi-currency note is included');
	}

	// (3) Empty period → still delivered by default (a scheduled report is predictable).
	DealQuery.getPerformanceSummary = async () => PERF_EMPTY;
	{
		const cap = [];
		const fn = registerAndGet(makeShareData(cap));
		const res = await fn({ schedule_id: 's3', label: 'Performance report', settings: {} });
		ok(cap.length === 1 && /No deals closed in this period/.test(cap[0].message), 'an empty period still delivers a digest by default');
		ok(res.status === 'ok', 'empty run returns ok');
	}

	// (4) Empty period + skip_when_empty → nothing delivered (opt-in quiet mode).
	{
		const cap = [];
		const fn = registerAndGet(makeShareData(cap));
		const res = await fn({ schedule_id: 's4', label: 'Performance report', settings: { skip_when_empty: true } });
		ok(cap.length === 0 && res.status === 'ok', 'skip_when_empty suppresses delivery when nothing closed');
		ok(/report skipped/.test(res.output), 'the skipped run says so in its output');
	}

	// (5) Data-fetch failure → failure notice delivered, error status returned.
	DealQuery.getPerformanceSummary = async () => ({ success: false, error: 'db down' });
	{
		const cap = [];
		const fn = registerAndGet(makeShareData(cap));
		const res = await fn({ schedule_id: 's5', label: 'Performance report', settings: {} });
		ok(res.status === 'error', 'a data failure returns error status');
		ok(cap.length === 1 && cap[0].status === 'error' && /failed: db down/.test(cap[0].message), 'a failure notice is delivered');
	}

	// (6) Missing instance name → falls back to the bare label, still delivers.
	DealQuery.getPerformanceSummary = async () => PERF;
	{
		const cap = [];
		const fn = registerAndGet(makeShareData(cap, { name: '' }));
		await fn({ schedule_id: 's6', label: 'Performance report', settings: {} });
		ok(cap.length === 1 && /📊 Performance report\n/.test(cap[0].message), 'with no instance name the digest uses the bare label');
	}

	// ── Pure formatters ──
	ok(Handler.clampPeriod(0) === 24 && Handler.clampPeriod('bad') === 24 && Handler.clampPeriod(168) === 168, 'clampPeriod defaults to 24 and passes valid values');
	ok(Handler.clampPeriod(99999) === 24 * 366, 'clampPeriod caps at ~1 year');
	ok(Handler.periodLabel(1) === 'last 1 hour' && Handler.periodLabel(48) === 'last 2 days', 'periodLabel pluralizes hours/days');
	ok(Handler.formatMins(1500) === '1d 1h' && Handler.formatMins(45) === '45m' && Handler.formatMins(0) === '0m', 'formatMins is compact');
	ok(Handler.formatProfit({ total_profit: -5, profit_currency: 'USDT' }) === '-5 USDT', 'formatProfit signs a loss');
	ok(Handler.formatProfit({ profit_by_currency: { USDT: 10, BTC: -0.1 } }) === '+10 USDT, -0.1 BTC', 'formatProfit lists per-currency');
	ok(Handler.formatProfit({}) === 'n/a', 'formatProfit is safe when no figure is present');

	DealQuery.getPerformanceSummary = origPerf; DealQuery.getPortfolioSummary = origPort;
	console.log('\nPerformanceReportHandler: ' + passed + ' assertions passed');
	process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
