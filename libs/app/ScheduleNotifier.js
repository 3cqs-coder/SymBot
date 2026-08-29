'use strict';

// Reusable notification dispatch for scheduled jobs.
//
// A schedule can notify several destinations across channels. Destinations are modelled
// as an extensible list — `settings.notifications: [ { type, target, on } ]` — rather
// than a fixed pair of booleans, so adding another Telegram chat, an email recipient, or
// a webhook later needs no schema migration (only, for a brand-new channel, a sender in
// the registry below). This mirrors how mature schedulers and alerting tools model
// notification targets: Alertmanager receivers, Healthchecks integrations, Airflow
// notifier lists — always a list of typed channel objects, each with its own address and
// trigger conditions, never a fixed set of flags.
//
// Backward compatible: rows that still carry the old `settings.notify_browser` /
// `settings.notify_telegram` booleans are upgraded to the list on read by resolveTargets,
// so existing schedules keep working unchanged and no data migration is needed.
//
// Delivery is a channel registry keyed by `type`. Telegram fans out to every configured
// chat id; the browser + notification-history path reuses Common.sendNotification (so
// history is written exactly once and the browser behavior is unchanged). Email (wrapped in
// the shared Mailer.renderEmail template) and webhook (a fire-and-forget JSON POST) are both
// delivered — an email target names recipients only (never transport/SMTP credentials), so its
// mailer is
// resolved at send time following the platform convention: an instance uses its own
// mailer when enabled and set, otherwise the Hub-level mailer shared by all instances
// (see resolveMailer). Either can be wired later without any change to stored schedules.

let shareData;

// A target's `on` list may contain: 'always', 'success', 'failure', 'missed' (an absent/empty `on`
// means "always"). Channel types understood: 'browser', 'telegram', 'email', 'webhook'. These are
// applied inline where targets are resolved/delivered below.


let log = function () {};   // assigned in init() via Common.makeLogger


// Resolve the mailer to use for email delivery. The Mailer resolves its own delivery mode
// internally — its own SMTP when configured, otherwise relaying to the Hub's shared mailer
// over the worker channel — and reports `ready` when either path can deliver. So the whole
// instance-vs-Hub precedence lives in the Mailer now: use it when ready, else return null
// and the email target is skipped. `ready !== false` keeps a mailer stub without a ready
// getter backward-compatible. Single exit.
function resolveMailer() {

	const sd = shareData || {};

	let mailer = null;

	if (sd.Mailer && typeof sd.Mailer.send === 'function' && sd.Mailer.ready !== false) {

		mailer = sd.Mailer;
	}

	return mailer;
}


// Whether a target should fire for a given run status. Single exit.
function conditionMatches(on, status) {

	const set = (Array.isArray(on) && on.length) ? on : [ 'always' ];

	let match = false;

	if (set.indexOf('always') >= 0) { match = true; }
	else if (status === 'ok' && set.indexOf('success') >= 0) { match = true; }
	// A run the scheduler abandons as 'timed_out' is a failure everywhere else in the scheduler
	// (FAILURE_STATUSES, consecutive-failure escalation), so it must satisfy a 'failure' target too —
	// otherwise "notify me on failure" silently misses a single timed-out run.
	else if ((status === 'error' || status === 'timed_out') && set.indexOf('failure') >= 0) { match = true; }
	else if (status === 'missed' && set.indexOf('missed') >= 0) { match = true; }

	return match;
}


// Normalize a schedule's settings into a clean target list. The new-style
// `settings.notifications` array wins when present; otherwise the legacy booleans are
// upgraded (browser on unless explicitly false; Telegram to the single global id, and
// only when that id is configured — matching the previous behavior exactly). Single exit.
function resolveTargets(settings) {

	const s = settings || {};

	let targets = [];

	if (Array.isArray(s.notifications)) {

		targets = s.notifications
			.filter(t => t && typeof t.type === 'string' && t.type !== '')
			.map(t => ({
				'type': t.type,
				'target': (t.target && typeof t.target === 'object') ? t.target : {},
				'on': (Array.isArray(t.on) && t.on.length) ? t.on.slice() : [ 'always' ]
			}));
	}
	else {

		if (s.notify_browser !== false) {

			targets.push({ 'type': 'browser', 'target': {}, 'on': [ 'always' ] });
		}

		if (s.notify_telegram !== false) {

			const gid = shareData && shareData.appData && shareData.appData.telegram_id;

			if (gid) { targets.push({ 'type': 'telegram', 'target': { 'chatId': gid }, 'on': [ 'always' ] }); }
		}
	}

	return targets;
}


// Per-channel senders. Each takes (target, message) and delivers to ONE target. Adding a
// channel means adding an entry here — no schedule-document change, because documents only
// carry the channel `type` string. `browser` is null because deliver() routes the browser
// + notification-history path through Common.sendNotification once (below).
const channels = {

	browser: null,

	telegram: function(target, message) {

		// An explicit chat id on the target wins; a blank target falls back to the global
		// notify id from Configuration, so a "Telegram (default account)" row needs no id.
		const id = (target && (target.chatId || target.id)) || (shareData && shareData.appData && shareData.appData.telegram_id);

		if (!id) { log('telegram target has no chat id and no global id configured; skipped'); return; }

		if (!(shareData && shareData.Telegram && typeof shareData.Telegram.sendMessage === 'function')) { return; }

		try { shareData.Telegram.sendMessage(id, message); }
		catch (e) { log('telegram send failed: ' + e.message); }
	},

	email: function(target, message) {

		// Recipients only — never transport credentials — so the mailer is resolved at
		// delivery time (see resolveMailer): an instance uses its OWN mailer when it is
		// enabled and set, otherwise the Hub-level mailer shared by all instances. Until a
		// mailer exists, log once and skip so a schedule configured for email still runs and
		// still delivers its other channels.
		const mailer = resolveMailer();

		if (mailer) {

			const to = (target && target.to) || [];

			// Wrap the plain message in the shared branded email template (subject + HTML body,
			// with the text kept as the plain-text fallback) so notification emails are consistent
			// and readable. Building it here means the templated payload is what gets relayed to the
			// Hub too, so a Hub-sent email looks identical to an instance-sent one.
			const sd = shareData || {};
			const rendered = (sd.Mailer && typeof sd.Mailer.renderEmail === 'function')
				? sd.Mailer.renderEmail(message)
				: { subject: undefined, text: message, html: undefined };

			// Fire-and-forget, but catch BOTH a synchronous throw and an async rejection so a
			// failing send can never become an unhandled promise rejection.
			try { Promise.resolve(mailer.send({ 'to': to, 'subject': rendered.subject, 'text': rendered.text, 'html': rendered.html })).catch(e => log('email send failed: ' + (e && e.message ? e.message : e))); }
			catch (e) { log('email send failed: ' + e.message); }
		}
		else {

			log('email target configured but no mailer is available yet; skipped');
		}
	},

	webhook: function(target, message) {

		const url = target && target.url;

		if (!url) { log('webhook target has no url; skipped'); return; }

		if (typeof fetch !== 'function') { log('webhook delivery unavailable (fetch not present); skipped'); return; }

		// Fire-and-forget POST of the message as JSON. Must never block delivery, so the
		// promise is not awaited; a timeout guards a hung endpoint and failures are logged.
		const controller = (typeof AbortController === 'function') ? new AbortController() : null;
		const timer = controller ? setTimeout(function() { try { controller.abort(); } catch (e) {} }, 10000) : null;

		Promise.resolve()
			.then(function() {

				return fetch(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ 'text': message }),
					signal: controller ? controller.signal : undefined
				});
			})
			.then(function(res) {
				if (!res.ok) {
					// Log the host only — a notification webhook (Discord/Slack/etc.) frequently
					// carries a secret token in its URL path, which must not reach the log.
					let host; try { host = new URL(url).host; } catch (e) { host = '(invalid url)'; }
					log('webhook POST to ' + host + ' returned HTTP ' + res.status);
				}
			})
			.catch(function(e) { log('webhook POST failed: ' + e.message); })
			.then(function() { if (timer) { clearTimeout(timer); } });
	}
};


// Deliver a notification to every target whose conditions match the run status. Reuses
// Common.sendNotification for the browser + notification-history path (history is written
// once; the browser socket send only when a browser target fires), and the per-channel
// senders for everything else. Never throws — a failing channel is logged and the rest
// still deliver. Single exit.
async function deliver(targets, payload) {

	const list = Array.isArray(targets) ? targets : [];
	const message = (payload && payload.message) || '';
	const type = (payload && payload.type) || 'info';
	const status = payload && payload.status;

	const firing = list.filter(t => conditionMatches(t.on, status));

	const hasBrowser = firing.some(t => t.type === 'browser');

	// Notification-history log + browser socket in one shared call. telegram_id is null so
	// this never sends Telegram itself — Telegram fan-out is handled per target below, so
	// multiple chat ids each get the message.
	if (shareData && shareData.Common && typeof shareData.Common.sendNotification === 'function') {

		try { await shareData.Common.sendNotification({ 'message': message, 'type': type, 'browser': hasBrowser, 'telegram_id': null }); }
		catch (e) { log('history/browser notify failed: ' + e.message); }
	}

	for (const t of firing) {

		if (t.type === 'browser') { continue; }   // handled above

		const sender = channels[t.type];

		if (typeof sender === 'function') { sender(t.target || {}, message); }
		else { log('unknown notification channel "' + t.type + '"; skipped'); }
	}

	return { 'delivered': firing.length };
}


// Deliver the standard "this scheduled run failed" notice to a schedule's failure/always targets. Owned
// centrally (called by the Scheduler) so EVERY failed run notifies consistently — including the two cases a
// handler cannot notify for itself: a TIMED-OUT run (the handler was abandoned mid-await, so its own
// error-path notify never executes) and a run with NO registered handler. The status flows straight
// through to deliver(), whose conditionMatches treats 'timed_out' as a failure, so a "notify me on failure"
// target hears about a stalled or unhandled job. Never throws. `row` is a schedule row (settings + label).
async function notifyFailure(row, status, output) {

	try {

		const label = (row && (row.label || row.type || row.schedule_id)) || 'Scheduled task';
		const verb = status === 'timed_out' ? 'timed out' : 'failed';
		const detail = output ? ('\n\n' + String(output)) : '';

		await deliver(resolveTargets(row && row.settings), {
			'message': '⚠️ Scheduled task "' + label + '" ' + verb + '.' + detail,
			'type': 'warning',
			'status': status || 'error'
		});
	}
	catch (e) { log('notifyFailure skipped: ' + (e && e.message ? e.message : e)); }
}


// Deliver ONE email to a recipient list, reusing the same email channel (mailer resolution + branded
// template) used for scheduled-job emails. This is the single email path shared by the granular
// notification router (Common.sendNotification) so instance-vs-Hub mailer precedence lives in one place.
// Fire-and-forget; never throws. Recipients name addresses only — never SMTP credentials.
function sendEmail(recipients, message) {
	try {
		const to = Array.isArray(recipients) ? recipients : (recipients ? [recipients] : []);
		if (!to.length) { return; }
		channels.email({ 'to': to }, message);
	}
	catch (e) { log('sendEmail failed: ' + (e && e.message ? e.message : e)); }
}


module.exports = {
	init: function(obj) { shareData = obj; log = obj.Common.makeLogger('ScheduleNotifier: '); },
	resolveTargets,
	conditionMatches,
	deliver,
	notifyFailure,
	sendEmail
};