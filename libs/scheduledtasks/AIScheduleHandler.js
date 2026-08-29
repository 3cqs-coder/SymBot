'use strict';


// AI consumer of the central Scheduler.
//
// Registers the 'ai_analysis' job type: when such a schedule fires, its prompt is run
// as a fresh, memory-less read-only AI turn (the same tool-augmented chat path used
// interactively — it can look up deals/logs/balances but can never place or change a
// trade), and the answer is delivered as a notification to Telegram + the browser.
//
// The Scheduler core owns timing, persistence, and run bookkeeping; this module owns
// only "what an AI analysis does when it runs".


function register(scheduler, shareData) {

	scheduler.registerHandler('ai_analysis', async (job) => {

		let status = 'ok';
		let answer = '';

		try {

			// A stable room per schedule, cleared before each run, gives memory-less runs
			// without accumulating a new conversation each time. Clearing is a separate
			// reset call because `reset: true` on the run itself would disable the tool /
			// deal-context paths (they require reset === false) — which is exactly what
			// makes a scheduled prompt like "summarize my deals" able to see live data.
			const room = 'schedule_' + job.schedule_id;

			await shareData.AIClient.streamChat(JSON.stringify({
				message: { room, stream: false, purpose: 'chat', reset: true }
			}));

			const out = await shareData.AIClient.streamChat(JSON.stringify({
				message: { room, content: job.prompt, stream: false, purpose: 'chat' }
			}));

			answer = (out && out.data ? String(out.data) : '').trim();

			if (!answer) { answer = '(no answer produced)'; status = 'error'; }
		}
		catch (e) {

			status = 'error';
			answer = 'Scheduled analysis failed: ' + e.message;
			shareData.Common.logger('Scheduler: ai_analysis run failed for ' + job.schedule_id + ': ' + e.message);
		}

		// Deliver to every configured destination via the shared, reusable notifier. It
		// resolves the schedule's notification targets — the extensible
		// settings.notifications list, or the legacy notify_browser / notify_telegram
		// booleans upgraded automatically — and fans out across channels (browser, one or
		// more Telegram chats, and, once wired, email/webhook). Long results are truncated
		// in the notification (the full text is kept in the schedule's run history) so a big
		// analysis doesn't produce an enormous modal / Telegram message.
		try {

			const targets = shareData.ScheduleNotifier.resolveTargets(job.settings);

			const title = '📅 ' + (job.label || 'Scheduled analysis');

			await shareData.ScheduleNotifier.deliver(targets, {
				message: title + '\n\n' + truncateForNotify(answer),
				type: status === 'ok' ? 'info' : 'warning',
				status: status
			});
		}
		catch (e) { shareData.Common.logger('Scheduler: ai_analysis notify failed for ' + job.schedule_id + ': ' + e.message); }

		// Return the full output so the scheduler records it in the run history.
		return { status, output: answer };
	});
}


const NOTIFY_MAX_CHARS = 800;

function truncateForNotify(text) {

	const s = String(text || '');
	if (s.length <= NOTIFY_MAX_CHARS) { return s; }
	return s.slice(0, NOTIFY_MAX_CHARS).replace(/\s+\S*$/, '') + '…\n\n(truncated — see the full result in Schedules → History)';
}


module.exports = { register };
