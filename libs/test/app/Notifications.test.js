'use strict';

// Tests Notifications routing: legacy behavior preserved when unconfigured, per-event/channel
// toggles, per-channel minimum severity, and quiet hours with the critical override.

const assert = require('assert');
const N = require('../../app/Notifications.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// ── resolveEvent: legacy type → event/severity ──────────────────────────────
ok(N.resolveEvent({ type: 'deal_open' }).event === 'deal_open', 'type deal_open → deal_open');
ok(N.resolveEvent({ type: 'error' }).event === 'exchange_error', 'type error → exchange_error');
ok(N.resolveEvent({ type: 'bot_enabled' }).event === 'bot_status', 'bot_<status> → bot_status');
ok(N.resolveEvent({ type: 'totally_unknown' }).event === 'system', 'unknown type → system (never dropped)');
ok(N.resolveEvent({ event: 'circuit_breaker' }).severity === 'critical', 'explicit event carries catalog severity');
ok(N.resolveEvent({ event: 'deal_open', severity: 'critical' }).severity === 'critical', 'explicit severity wins');

// ── unconfigured: legacy behavior (browser + telegram on, email off) ────────
(() => {
	const r = N.routing(undefined, 'deal_open', 'info');
	ok(r.browser === true && r.telegram === true && r.email === false, 'no block → browser+telegram on, email off (legacy)');
	const r2 = N.routing({}, 'deal_error', 'error');
	ok(r2.browser === true && r2.telegram === true && r2.email === false, 'empty block → same legacy routing');
})();

// ── configured matrix: per-event/channel toggles honored ────────────────────
(() => {
	const cfg = { events: { deal_open: { browser: true, telegram: false, email: false }, deal_error: { browser: true, telegram: true, email: true } } };
	const open = N.routing(cfg, 'deal_open', 'info');
	ok(open.browser === true && open.telegram === false, 'configured: deal_open telegram OFF honored');
	const err = N.routing(cfg, 'deal_error', 'error');
	ok(err.telegram === true && err.email === true, 'configured: deal_error telegram+email ON');
	const unknown = N.routing(cfg, 'some_new_event', 'info');
	ok(unknown.browser === true && unknown.telegram === true, 'configured: unknown event defaults ON (not dropped)');
})();

// ── per-channel minimum severity ─────────────────────────────────────────────
(() => {
	const cfg = { events: { deal_open: { browser: true, telegram: true, email: true } }, min_severity: { browser: 'info', telegram: 'warning', email: 'critical' } };
	const info = N.routing(cfg, 'deal_open', 'info');
	ok(info.browser === true && info.telegram === false && info.email === false, 'info event: only browser passes (telegram≥warning, email≥critical)');
	const crit = N.routing(cfg, 'deal_open', 'critical');
	ok(crit.browser === true && crit.telegram === true && crit.email === true, 'critical event passes all severity floors');
})();

// ── quiet hours with critical override ───────────────────────────────────────
(() => {
	// A window covering the whole day so "now" is always inside it, tz local.
	const cfg = {
		events: { deal_open: { browser: true, telegram: true, email: false }, circuit_breaker: { browser: true, telegram: true, email: false } },
		quiet_hours: { enabled: true, start: '00:00', end: '23:59', tz: 'local', min_severity_override: 'critical' }
	};
	const info = N.routing(cfg, 'deal_open', 'info');
	ok(info.telegram === false && info.browser === false, 'quiet hours suppress an info event on all channels');
	const crit = N.routing(cfg, 'circuit_breaker', 'critical');
	ok(crit.telegram === true && crit.browser === true, 'critical event overrides quiet hours');
})();

// ── inQuietHours wrap-past-midnight logic (pure, tz local) ────────────────────
(() => {
	// Can't control the clock, but a full-day window is always inside and a zero-length never is.
	ok(N.inQuietHours({ start: '00:00', end: '23:59', tz: 'local' }) === true, 'full-day window is always quiet');
	ok(N.inQuietHours({ start: '10:00', end: '10:00', tz: 'local' }) === false, 'zero-length window is never quiet');
	ok(N.inQuietHours({ start: 'bad', end: '07:00' }) === false, 'unparseable window is never quiet');
})();

// ── defaults / catalog shape ───────────────────────────────────────────────
(() => {
	const d = N.defaultConfig();
	ok(d.schema_version === N.SCHEMA_VERSION && d.events && d.events.deal_open, 'defaultConfig has schema_version + events');
	ok(N.catalog().length === Object.keys(N.EVENTS).length, 'catalog lists every event');
})();

console.log('Notifications: ' + passed + ' assertions passed');