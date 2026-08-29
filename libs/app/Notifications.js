'use strict';

// Central notification routing.
//
// Decides which delivery channels (browser panel, Telegram, email) each notification EVENT reaches,
// from the operator's per-instance `notifications` preferences in app.json. This is what turns the
// old all-or-nothing behavior ("enable Telegram and you get everything") into per-event, per-channel
// control, with an optional per-channel minimum severity and quiet hours.
//
// Upgrade-safe by construction, following the same pattern used elsewhere in SymBot (defaulted fields
// + read-time upgrade of the legacy shape + a schema_version stamp — see ScheduleNotifier.resolveTargets):
// when no `notifications` block is configured at all, delivery is UNCHANGED — every event still reaches
// the browser panel and Telegram exactly as before (email is a new, opt-in channel, so it stays off).
// Existing installs behave identically until the operator opts into filtering. Because the reader
// defaults every missing field, the block can gain new events, channels, severities and quiet-hours
// rules later without a breaking migration.
//
// This module is PURE (no shareData, no I/O) so it is trivially unit-testable; the caller
// (Common.sendNotification) owns actual delivery and reuses ScheduleNotifier's channel senders.

const SCHEMA_VERSION = 1;

// Delivery channels, in display order.
const CHANNELS = ['browser', 'telegram', 'email'];

// Ordered severity vocabulary. A single global axis (not a parallel one) so a per-channel "minimum
// severity" is a simple ordinal compare. The existing notification `type` maps onto this.
const SEVERITY = { debug: 0, info: 1, warning: 2, error: 3, critical: 4 };

// Canonical event catalog. Each event has a severity, a grouping category + human label (for the
// config UI), and the CURATED default channel choices used to seed a fresh config form. (The resolver
// itself defaults to "all on" when NO block exists — the curated defaults only shape the first save.)
const EVENTS = {
	deal_open:       { severity: 'info',     category: 'Deals',   label: 'New deal started',              def: { browser: true,  telegram: false, email: false } },
	deal_close:      { severity: 'info',     category: 'Deals',   label: 'Deal closed / take-profit',      def: { browser: true,  telegram: true,  email: false } },
	bot_status:      { severity: 'info',     category: 'Bots',    label: 'Bot enabled / disabled',         def: { browser: true,  telegram: true,  email: false } },
	bot_start:       { severity: 'info',     category: 'Bots',    label: 'Start command received',         def: { browser: true,  telegram: false, email: false } },
	deal_error:      { severity: 'error',    category: 'Errors',  label: 'Deal / order error',             def: { browser: true,  telegram: true,  email: true  } },
	exchange_error:  { severity: 'error',    category: 'Errors',  label: 'Exchange connection error',      def: { browser: true,  telegram: true,  email: true  } },
	circuit_breaker: { severity: 'critical', category: 'Safety',  label: 'Circuit breaker',                def: { browser: true,  telegram: true,  email: false } },
	warning:         { severity: 'warning',  category: 'Safety',  label: 'Warnings (price, held deals)',   def: { browser: true,  telegram: true,  email: false } },
	signal:          { severity: 'info',     category: 'Signals', label: 'Signal provider events',         def: { browser: false, telegram: false, email: false } },
	system:          { severity: 'info',     category: 'System',  label: 'System (database, shutdown)',    def: { browser: true,  telegram: true,  email: true  } },
	// A recurring scheduled task failing repeatedly is exactly the message that must not be silenced by
	// muting generic "system" events — so it gets its own key (and is always written to the audit log by
	// the scheduler). Defaults to every channel on.
	schedule_failure: { severity: 'error',   category: 'System',  label: 'Scheduled task failures',        def: { browser: true,  telegram: true,  email: true  } }
};

// Legacy `type` string → event. Most sendNotification call sites only pass `type`, so this keeps them
// working with no change; a few overloaded 'warning' sites (circuit breaker) pass an explicit `event`.
const TYPE_TO_EVENT = {
	deal_open: 'deal_open',
	deal_close: 'deal_close',
	deal_error: 'deal_error',
	bot_start: 'bot_start',
	error: 'exchange_error',
	warning: 'warning',
	signal: 'signal',
	database: 'system',
	info: 'system'
};

function severityRank(s) {
	const r = SEVERITY[String(s == null ? '' : s).toLowerCase()];
	return (r == null) ? SEVERITY.info : r;
}

// Resolve { event, severity } from a sendNotification payload. An explicit `event`/`severity` wins;
// otherwise derive from the legacy `type` (`bot_<status>` → bot_status; anything unrecognized →
// system/info, which is delivered by default so nothing is ever silently dropped).
function resolveEvent(payload) {

	const p = payload || {};

	let event = (p.event != null && p.event !== '') ? String(p.event) : '';

	if (event === '') {
		const t = String(p.type == null ? '' : p.type).toLowerCase();
		if (t && TYPE_TO_EVENT[t]) { event = TYPE_TO_EVENT[t]; }
		else if (t.indexOf('bot_') === 0) { event = 'bot_status'; }
		else { event = 'system'; }
	}

	const cat = EVENTS[event];
	const severity = (p.severity != null && p.severity !== '') ? String(p.severity) : (cat ? cat.severity : 'info');

	return { 'event': event, 'severity': severity };
}

// Read-time normalization: fill every missing field with a permissive default so a partial or absent
// block is always safe. `configured` is false only when there is no `events` map at all — that is the
// signal to preserve legacy "deliver everywhere" behavior.
function normalize(cfg) {

	const c = (cfg && typeof cfg === 'object') ? cfg : {};

	return {
		'configured': !!(c.events && typeof c.events === 'object'),
		'events': (c.events && typeof c.events === 'object') ? c.events : {},
		'min_severity': Object.assign({ browser: 'info', telegram: 'info', email: 'info' }, (c.min_severity && typeof c.min_severity === 'object') ? c.min_severity : {}),
		'quiet_hours': Object.assign({ enabled: false, start: '22:00', end: '07:00', tz: 'local', min_severity_override: 'critical' }, (c.quiet_hours && typeof c.quiet_hours === 'object') ? c.quiet_hours : {}),
		'email_to': Array.isArray(c.email_to) ? c.email_to.filter(x => typeof x === 'string' && x.trim() !== '') : []
	};
}

function hhmmToMinutes(v) {
	const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? '' : v).trim());
	if (!m) { return null; }
	const h = Number(m[1]), min = Number(m[2]);
	if (h > 23 || min > 59) { return null; }
	return h * 60 + min;
}

// Current minute-of-day in the given IANA timezone ('local'/'' = server local). Never throws — an
// unknown zone falls back to server local. Uses the real clock at delivery time.
function nowMinutesInTz(tz) {
	const now = new Date();
	if (!tz || tz === 'local') { return now.getHours() * 60 + now.getMinutes(); }
	try {
		const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
		let h = 0, min = 0;
		for (const p of parts) { if (p.type === 'hour') { h = Number(p.value); } else if (p.type === 'minute') { min = Number(p.value); } }
		return (h % 24) * 60 + min;
	}
	catch (e) { return now.getHours() * 60 + now.getMinutes(); }
}

// Is the current time within the quiet-hours window? Handles a window that wraps past midnight
// (start > end). A zero-length or unparseable window is treated as "not quiet".
function inQuietHours(qh) {
	const s = hhmmToMinutes(qh && qh.start);
	const e = hhmmToMinutes(qh && qh.end);
	if (s == null || e == null || s === e) { return false; }
	const cur = nowMinutesInTz(qh && qh.tz);
	return (s < e) ? (cur >= s && cur < e) : (cur >= s || cur < e);
}

// The routing decision for one event at one severity → { browser, telegram, email } booleans.
// A channel fires only when ALL hold: its per-event toggle is on, the severity meets that channel's
// minimum, and it is not suppressed by quiet hours (a severity at/above the quiet-hours override —
// critical by default — always passes, so a risk halt is never silenced). `scope` is accepted and
// reserved for future per-instance/per-bot rules; v1 routes globally.
function routing(cfg, event, severity, scope) {

	const N = normalize(cfg);
	const sevRank = severityRank(severity);
	const quiet = (N.quiet_hours && N.quiet_hours.enabled) ? inQuietHours(N.quiet_hours) : false;
	const quietOverride = severityRank(N.quiet_hours.min_severity_override || 'critical');

	const out = { browser: false, telegram: false, email: false };

	for (const ch of CHANNELS) {

		// Per-event channel toggle. With no block at all, preserve legacy behavior: browser + Telegram
		// on, email off (email never delivered before, so it stays opt-in). With a block, an unknown
		// event defaults ON so a newly-added event type is never silently dropped.
		let on;
		if (!N.configured) { on = (ch !== 'email'); }
		else {
			const ev = N.events[event];
			on = ev ? (ev[ch] !== false) : true;
		}
		if (!on) { continue; }

		// Per-channel minimum severity.
		if (sevRank < severityRank(N.min_severity[ch])) { continue; }

		// Quiet hours (per channel is not split today — one window applies to all channels).
		if (quiet && sevRank < quietOverride) { continue; }

		out[ch] = true;
	}

	return out;
}

// Build a fresh, fully-populated config from the curated per-event defaults (used to seed the config
// form so the operator's first save writes sensible choices rather than a blank matrix).
function defaultConfig() {
	const events = {};
	for (const k of Object.keys(EVENTS)) { events[k] = Object.assign({}, EVENTS[k].def); }
	return {
		'schema_version': SCHEMA_VERSION,
		'min_severity': { browser: 'info', telegram: 'warning', email: 'error' },
		'quiet_hours': { enabled: false, start: '22:00', end: '07:00', tz: 'local', min_severity_override: 'critical' },
		'email_to': [],
		'events': events
	};
}

// The event catalog as an ordered list for the UI, grouped by category.
function catalog() {
	return Object.keys(EVENTS).map(k => ({
		'event': k,
		'severity': EVENTS[k].severity,
		'category': EVENTS[k].category,
		'label': EVENTS[k].label,
		'def': Object.assign({}, EVENTS[k].def)
	}));
}

module.exports = {
	SCHEMA_VERSION,
	CHANNELS,
	SEVERITY,
	EVENTS,
	severityRank,
	resolveEvent,
	routing,
	inQuietHours,
	defaultConfig,
	catalog
};