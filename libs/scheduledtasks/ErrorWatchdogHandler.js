'use strict';


// The user-facing "error_watchdog" scheduled RECIPE (the first pre-defined task recipe).
// NAME NOTE: this is NOT the boot-time integrity registry in libs/app/Watchdog.js — that one
// self-checks the platform's invariants at startup; this one is a user-scheduled log-error
// scanner. Same word, two different jobs.
//
// Registers the 'error_watchdog' job type: when such a schedule fires, it runs the deterministic
// error-baseline analysis (today's error mix vs the immediately-preceding days) over the logs and,
// ONLY when an error type is NEW or SPIKING versus that baseline, delivers a concise, detailed alert
// to the schedule's notification targets. A clean scan is silent — no-news-is-good-news — so a
// healthy instance is never spammed. The scan is read-only: it looks at logs, it can never place,
// pause, cancel, or change a trade.
//
// The Scheduler core owns timing, persistence, retries and run bookkeeping; this module owns only
// "what a watchdog scan does when it runs". Every knob (which window, how sensitive, where to alert)
// is read from the schedule row's own `settings`, so ONE static handler serves any number of
// user-created watchdog schedules — users add / enable / disable / remove them as data, never by
// editing code here.


const aiTools = require('../ai/AITools');
const LogScan = require('../queries/LogScan');


function register(scheduler, shareData) {

	scheduler.registerHandler('error_watchdog', async (job) => {

		const settings = (job && job.settings) || {};

		try {

			// Frame the comparison exactly as the analyze_error_baseline tool does — one shared
			// definition of "the target window vs the prior N days" — from this schedule's settings.
			const { targetDates, baselineDates } = aiTools.errorBaselineWindows({
				days: settings.target_days,
				date: settings.date,
				baseline_days: settings.baseline_days
			});

			const instanceName = await shareData.Common.getInstanceName();
			const diff = await LogScan.getErrorBaselineDiff(targetDates, baselineDates, instanceName);

			const flagged = (diff.anomalies || []).filter(a => a.status === 'new' || a.status === 'spiking');

			// Alert ONLY on something new or spiking. `status:'error'` so targets set to fire on
			// 'failure' (or 'always') deliver, while a routine clean run stays quiet.
			if (flagged.length > 0) {

				const targets = shareData.ScheduleNotifier.resolveTargets(job.settings);

				await shareData.ScheduleNotifier.deliver(targets, {
					message: formatAlert(job, diff, flagged),
					type: 'warning',
					status: 'error'
				});
			}

			// Record a human-readable summary in the run history (not raw JSON) — the same detail the
			// alert carries when something is flagged, or a plain "all normal" line when it is quiet.
			return { status: 'ok', output: runSummary(job, diff, flagged, targetDates, baselineDates) };
		}
		catch (e) {

			shareData.Common.logger('Scheduler: error_watchdog run failed for ' + (job && job.schedule_id) + ': ' + e.message);

			// A broken watchdog must be visible rather than silently failing to warn — surface the
			// failure itself as an alert (best-effort; never let notify failure mask the run error).
			try {
				const targets = shareData.ScheduleNotifier.resolveTargets(job.settings);
				await shareData.ScheduleNotifier.deliver(targets, {
					message: '⚠️ ' + (job.label || 'Watchdog') + ' scan failed: ' + e.message,
					type: 'warning',
					status: 'error'
				});
			}
			catch (e2) { /* notify is best-effort */ }

			return { status: 'error', output: 'Watchdog scan failed: ' + e.message };
		}
	});
}


// A concise, DETAILED alert built straight from the pre-computed anomaly fields — no re-counting.
// Leads with the summary, then one line per flagged type carrying its status, target-vs-baseline
// counts and per-day rates, when it was first/last seen, and one example log line, so the reader
// gets real evidence, not just "something spiked". Bounded to a handful of types (the rest are in
// the run history) so a notification / Telegram message never balloons.
const MAX_TYPES_IN_ALERT = 6;
const EXAMPLE_MAX_CHARS = 200;


// Human-readable text for the run history: the full alert when something is flagged, or a plain
// "all normal" line when it is quiet — plus the window scanned and the error totals either way, so a
// clean run is still informative. Never raw JSON; an average user reads this, not a machine.
function runSummary(job, diff, flagged, targetDates, baselineDates) {

	const windowLine = 'Scanned ' + (targetDates || []).join(', ') + ' against baseline ' + (baselineDates || []).join(', ') + '.';
	const totalsLine = 'Errors: ' + (diff.target_total_errors || 0) + ' in the target window, ' + (diff.baseline_total_errors || 0) + ' in the baseline.';

	const body = flagged.length > 0
		? formatAlert(job, diff, flagged)
		: '✓ ' + (job.label || 'Watchdog') + ': nothing unusual — no error type is new or spiking versus the baseline.';

	return body + '\n\n' + windowLine + '\n' + totalsLine;
}

function formatAlert(job, diff, flagged) {

	const header = '🚨 ' + (job.label || 'Watchdog alert');
	const lines = [ header, '', (diff.summary || (flagged.length + ' error type(s) are new or spiking versus the baseline.')) ];

	for (const a of flagged.slice(0, MAX_TYPES_IN_ALERT)) {

		lines.push('');
		lines.push('• ' + a.type + '  [' + String(a.status).toUpperCase() + ']  —  '
			+ a.target_count + ' now vs ' + a.baseline_count + ' baseline'
			+ ' (' + a.target_per_day + '/day vs ' + a.baseline_per_day + '/day)');

		if (a.first_seen) { lines.push('   seen ' + a.first_seen + ' → ' + a.last_seen); }

		const example = a.examples && a.examples[0];
		if (example) { lines.push('   e.g. ' + String(example).slice(0, EXAMPLE_MAX_CHARS)); }
	}

	if (flagged.length > MAX_TYPES_IN_ALERT) {
		lines.push('', '…and ' + (flagged.length - MAX_TYPES_IN_ALERT) + ' more (see Schedules → History for the full breakdown).');
	}

	return lines.join('\n');
}


module.exports = { register };
