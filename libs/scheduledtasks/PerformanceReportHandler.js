'use strict';


// Performance report — a scheduled reporting recipe. Registers the 'performance_report' job type: when it
// fires it builds a concise digest of REALIZED trading performance over a look-back window (deals closed,
// realized profit, win rate, average result, best/worst deal, average duration) plus a light snapshot of the
// current open positions, and delivers it. Read-only: it reads closed-deal history and cached portfolio
// figures, and NEVER places or changes a trade.
//
// It reuses the exact figures the rest of the app and the AI assistant already use — DealQuery
// getPerformanceSummary (an indexed DB aggregation) and getPortfolioSummary (active deals + cached balance) —
// so the report can never drift from what those surfaces show, and it makes no exchange round-trips on the
// schedule. Every step is DB/cache-only and best-effort, wrapped so an error is contained and can never block
// or stall the trading loop.
//
// It runs per-instance (registered in the shared instance boot, symbot.js), so on the Hub each managed
// instance reports its own performance, titled with the instance name so a fleet operator can tell them apart.


const DealQuery = require('../queries/DealQuery');

const DEFAULT_PERIOD_HOURS = 24;
const MS_PER_HOUR = 3600 * 1000;


function register(scheduler, shareData) {

	scheduler.registerHandler('performance_report', async (job) => {

		const settings = (job && job.settings) || {};

		try {

			const periodHours = clampPeriod(settings.period_hours);
			const dateTo = new Date();
			const dateFrom = new Date(dateTo.getTime() - periodHours * MS_PER_HOUR);

			const perf = await DealQuery.getPerformanceSummary(dateFrom, dateTo);

			if (!perf || perf.success !== true) {
				// Route a data-fetch failure through the SAME catch below (which delivers the failure notice),
				// rather than returning silently — otherwise "notify me on failure" would miss it.
				throw new Error((perf && perf.error) || 'no data');
			}

			// Opt-in quiet mode: when nothing closed in the window, skip delivery entirely rather than sending a
			// "nothing happened" digest. Off by default (a scheduled report is predictable and arrives on time).
			if (!perf.completed_deals && settings.skip_when_empty === true) {
				return { status: 'ok', output: 'No deals closed in the ' + periodLabel(periodHours) + '; report skipped (skip_when_empty).' };
			}

			// The current open snapshot is a nice-to-have; never let it fail the report (best-effort, DB/cache-only).
			let portfolio = null;
			try {
				const p = await DealQuery.getPortfolioSummary();
				if (p && p.success === true) { portfolio = p; }
			}
			catch (e) { /* snapshot is optional */ }

			const label = await instanceLabel(shareData, job);
			const message = formatReport(label, periodHours, perf, portfolio);

			const targets = shareData.ScheduleNotifier.resolveTargets(job.settings);
			await shareData.ScheduleNotifier.deliver(targets, { message: message, type: 'info', status: 'ok' });

			return { status: 'ok', output: message };
		}
		catch (e) {

			shareData.Common.logger('Scheduler: performance_report run failed for ' + (job && job.schedule_id) + ': ' + e.message);

			try {
				const targets = shareData.ScheduleNotifier.resolveTargets(job.settings);
				await shareData.ScheduleNotifier.deliver(targets, { message: '⚠️ ' + (job.label || 'Performance report') + ' failed: ' + e.message, type: 'warning', status: 'error' });
			}
			catch (e2) { /* notify is best-effort */ }

			return { status: 'error', output: 'Performance report failed: ' + e.message };
		}
	});
}


// Clamp the look-back window to a sane range (1 hour … ~1 year), defaulting to 24h. Pure.
function clampPeriod(hours) {
	const n = parseInt(hours, 10);
	if (!Number.isFinite(n) || n <= 0) { return DEFAULT_PERIOD_HOURS; }
	return Math.min(n, 24 * 366);
}


// A human label for the window (e.g. "last 24 hours", "last 7 days"). Whole numbers of days read as days
// only from two days up — a 24-hour window reads more naturally as "last 24 hours" than "last 1 day". Pure.
function periodLabel(hours) {
	if (hours % 24 === 0 && hours >= 48) { return 'last ' + (hours / 24) + ' days'; }
	return 'last ' + hours + ' hour' + (hours === 1 ? '' : 's');
}


// Title the report with the instance name so a Hub operator can tell instances apart. Best-effort:
// getInstanceName is async and may be unavailable, so fall back to the job label alone.
async function instanceLabel(shareData, job) {
	const base = (job && job.label) || 'Performance report';
	try {
		if (shareData && shareData.Common && typeof shareData.Common.getInstanceName === 'function') {
			const name = await shareData.Common.getInstanceName();
			if (name) { return base + ' — ' + name; }
		}
	}
	catch (e) { /* fall back to base */ }
	return base;
}


// Format the realized-profit figure, honoring single- vs multi-currency (a single total is meaningful only
// within one quote currency; otherwise show the per-currency breakdown, never a nonsensical mixed sum). Pure.
function formatProfit(perf) {
	if (perf.total_profit != null) {
		return (perf.total_profit >= 0 ? '+' : '') + perf.total_profit + (perf.profit_currency ? ' ' + perf.profit_currency : '');
	}
	if (perf.profit_by_currency && typeof perf.profit_by_currency === 'object') {
		const parts = Object.keys(perf.profit_by_currency).map(function (c) { return (perf.profit_by_currency[c] >= 0 ? '+' : '') + perf.profit_by_currency[c] + ' ' + c; });
		if (parts.length) { return parts.join(', '); }
	}
	return 'n/a';
}


// Compact duration formatter (minutes → "2d 3h" / "45m"). Pure.
function formatMins(mins) {
	const m = Math.round(Number(mins) || 0);
	const d = Math.floor(m / 1440);
	const h = Math.floor((m % 1440) / 60);
	const r = m % 60;
	const out = [];
	if (d) { out.push(d + 'd'); }
	if (h) { out.push(h + 'h'); }
	if (r || !out.length) { out.push(r + 'm'); }
	return out.join(' ');
}


// Build the digest message from the query results. Pure, so it is unit-tested without a DB or scheduler.
function formatReport(label, periodHours, perf, portfolio) {

	const lines = [ '📊 ' + label, '', 'Performance — ' + periodLabel(periodHours) + ':' ];

	if (!perf.completed_deals) {
		lines.push('', 'No deals closed in this period.');
	}
	else {
		lines.push('', 'Closed deals: ' + perf.completed_deals + '  ·  Realized: ' + formatProfit(perf));

		if (perf.win_rate_percent != null) {
			lines.push('Win rate: ' + perf.win_rate_percent + '%  (' + perf.wins + 'W / ' + perf.losses + 'L)');
		}
		if (perf.avg_profit_percent != null) { lines.push('Average result: ' + perf.avg_profit_percent + '% per deal'); }
		if (perf.avg_duration_mins != null) { lines.push('Average duration: ' + formatMins(perf.avg_duration_mins)); }
		if (perf.best_deal && perf.best_deal.pair) { lines.push('Best: ' + perf.best_deal.pair + ' ' + perf.best_deal.profit_percent + '%'); }
		if (perf.worst_deal && perf.worst_deal.pair) { lines.push('Worst: ' + perf.worst_deal.pair + ' ' + perf.worst_deal.profit_percent + '%'); }

		if (perf.note) { lines.push('', perf.note); }
	}

	if (portfolio && portfolio.open_deals != null) {
		const parts = [ portfolio.open_deals + ' open deal' + (portfolio.open_deals === 1 ? '' : 's') ];
		if (portfolio.deployed_funds != null) { parts.push('deployed ' + portfolio.deployed_funds + (portfolio.quote_currency ? ' ' + portfolio.quote_currency : '')); }
		lines.push('', 'Currently: ' + parts.join('  ·  ') + '.');
	}

	return lines.join('\n');
}


module.exports = { register, formatReport, formatProfit, formatMins, clampPeriod, periodLabel };
