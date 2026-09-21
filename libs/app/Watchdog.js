'use strict';

// ── Watchdog — central self-policing registry ────────────────────────────────
//
// NAME NOTE: this is the boot-time INTEGRITY registry (self-checks of the platform's own
// invariants). It is unrelated to the user-facing "error_watchdog" scheduled recipe
// (libs/scheduledtasks/ErrorWatchdogHandler.js), which scans the logs for error spikes. Two
// different jobs that happen to share the word "watchdog".
//
// One place that runs the platform's boot-time integrity checks and records any finding to the
// audit log, so a broken invariant is caught immediately instead of being hunted down later. It
// works like the other registries in the app: checks REGISTER themselves, and `run()` executes
// every registered check. Adding a new safeguard later is one `Watchdog.register(name, fn)` call —
// no edits to the runner.
//
// Design rules:
//   • WARN-ONLY. A check never blocks startup or trading; it reports and the platform continues.
//   • Every finding goes to BOTH the normal log AND the audit log (actor "watchdog"), so it
//     surfaces in Access Control → Audit Log. A clean run records one "watchdog.ok" entry so you
//     can confirm the checks actually ran.
//   • A check is `fn(shareData, context) -> finding | finding[] | null`, where a finding is
//     `{ action, target?, detail? }`. Throwing is caught and ignored (a check must never break boot).
//
// Twelve built-in checks are registered at the bottom of this file (route_gating, route_gate_strength,
// capability_integrity, ai_read_only, guide_present, capability_drift, auth_admin_present,
// orphaned_open_deals, duplicate_open_deals_per_pair, deal_missing_orders, over_privileged_user,
// default_password). Many more are registered by other modules that call Watchdog.register(...) at boot —
// the AIClient (learning-drift, tool-schema/guide parity, and the answer-integrity family), the Scheduler
// (handler coverage, shipped-recipe handler coverage, heartbeat, backup health), ScheduleRecipes, Audit,
// SignalActivity, and System (secret, index, disk and IP-filter checks). Each module owns and documents
// its own; the authoritative catalog of what every finding means and how to fix it lives in Diagnostics.js.

const fs = require('fs');
const path = require('path');
const Authz = require('./Authz.js');
const RoutePermissions = require('./RoutePermissions.js');
const AITools = require('./../ai/AITools.js');
const Diagnostics = require('./Diagnostics.js');


// ── Registry ─────────────────────────────────────────────────────────────────

const checks = [];   // { name, fn }

// Register a named check. Idempotent by name (re-registering replaces), so requiring this module
// twice never double-runs a check. Single exit.
function register(name, fn) {
	if (name && typeof fn === 'function') {
		const i = checks.findIndex(c => c.name === name);
		if (i >= 0) { checks[i] = { name: name, fn: fn }; } else { checks.push({ name: name, fn: fn }); }
	}
	return checks.length;
}

function list() { return checks.map(c => c.name); }


// Run every registered check. `context` carries per-run inputs (e.g. { router, label }). Returns a
// promise for the flattened findings array (empty when everything passed). Never throws. A check may
// be synchronous OR async (return a promise) — each is awaited — so a check can query the database
// (e.g. "does every schedule's type have a handler?"). The boot caller fires this without awaiting;
// findings are logged/audited when it settles. Single exit.
async function run(shareData, context) {

	context = context || {};

	const label = context.label ? ' (' + context.label + ')' : '';
	const logger = (shareData && shareData.Common && typeof shareData.Common.logger === 'function') ? shareData.Common.logger : function () {};
	const audit = (shareData && shareData.Common && typeof shareData.Common.auditEvent === 'function') ? shareData.Common.auditEvent : function () {};

	const findings = [];

	for (let i = 0; i < checks.length; i++) {
		try {
			const res = await Promise.resolve().then(() => checks[i].fn(shareData, context));
			const arr = Array.isArray(res) ? res : (res ? [ res ] : []);
			arr.filter(Boolean).forEach(f => findings.push({ check: checks[i].name, action: f.action || ('watchdog.' + checks[i].name), target: f.target || '', detail: f.detail || '' }));
		}
		catch (e) {
			// A check that throws is itself a finding (never silently swallowed), but it can never
			// break startup.
			findings.push({ check: checks[i].name, action: 'watchdog.check_failed', target: checks[i].name, detail: (e && e.message) ? e.message : String(e) });
		}
	}

	try {
		if (findings.length) {
			// Count DISTINCT failing checks (one check can emit several findings) so "passed" is accurate.
			const failedChecks = new Set(findings.map(f => f.check)).size;
			const passedChecks = Math.max(0, checks.length - failedChecks);
			// ALWAYS lead with a one-line sweep summary, even when there are findings — otherwise a single
			// warning (e.g. the default password) hides the fact that the sweep ran at all and that the other
			// checks passed. Without it the operator can't tell "one thing to fix" from "the checks stopped
			// running". The individual findings (with their fix guidance) follow below.
			logger('Watchdog' + label + ': ' + checks.length + ' integrity checks ran — ' + passedChecks + ' passed, ' + failedChecks + ' with finding(s):', true);
			findings.forEach(f => {
				logger('WATCHDOG' + label + ' — ' + f.action + ': ' + f.detail, true);
				// Follow the bare finding with a clear-language "what it means / how to fix" so the log is
				// self-explanatory instead of leaving the reader to decode a machine code. Unknown codes
				// annotate to nothing, leaving the line above to stand alone.
				Diagnostics.annotate(f.action).forEach(line => logger(line, true));
				audit('watchdog', f.action, f.target, f.detail);
			});
			// Record the sweep summary to the audit log too, so "the checks ran, with N finding(s)" is visible
			// in Access Control → Audit Log alongside the individual findings — parity with the clean-run ok.
			audit('watchdog', 'watchdog.summary', String(checks.length), failedChecks + ' check(s) with finding(s), ' + passedChecks + ' passed' + label);
		}
		else if (!context.periodic) {
			// Boot / on-demand run: confirm the clean sweep in the log and audit trail.
			logger('Watchdog' + label + ': all integrity checks passed (' + checks.length + ' checks).', true);
			audit('watchdog', 'watchdog.ok', String(checks.length), 'startup integrity checks passed' + label);
		}
		// A periodic (continuous-monitoring) run that finds nothing stays silent — it reports only when there is
		// a finding, so ongoing monitoring never floods the log or audit trail with routine all-clear entries.
	}
	catch (e) {}

	return findings;
}


// ── Built-in checks ──────────────────────────────────────────────────────────

// 1. Route gating coverage — every state-changing route must have a capability gate.
register('route_gating', function (shareData, context) {
	const router = context && context.router;
	if (!router) { return null; }
	const uncovered = RoutePermissions.auditCoverage(router);
	return uncovered.length ? { action: 'watchdog.ungated_routes', target: String(uncovered.length), detail: uncovered.join(', ') } : null;
});

// 1b. Route gate STRENGTH — a state-changing route mapped to a *.read capability is under-gated
// (a write a read-only key could perform). Coverage alone treats it as gated, so this catches the
// class where a new POST/DELETE route is wired to a read scope by mistake.
register('route_gate_strength', function () {
	const weak = (typeof RoutePermissions.auditGateStrength === 'function') ? RoutePermissions.auditGateStrength() : [];
	return weak.length ? { action: 'watchdog.undergated_routes', target: String(weak.length), detail: weak.join(', ') } : null;
});

// 2. Capability integrity — every capability named in RULES and the role bundles must exist in the
// Authz catalog (a typo silently breaks a gate or a role grant).
register('capability_integrity', function () {
	const valid = new Set((Authz.CAPABILITIES || []).map(c => c.key).concat('*'));
	const unknown = [];
	(RoutePermissions.RULES || []).forEach(r => { if (r && !valid.has(r.cap)) { unknown.push('RULES:' + r.cap); } });
	const roleCaps = Authz.ROLE_CAPS || {};
	Object.keys(roleCaps).forEach(role => { (roleCaps[role] || []).forEach(c => { if (!valid.has(c)) { unknown.push('role ' + role + ':' + c); } }); });
	return unknown.length ? { action: 'watchdog.unknown_capability', target: String(unknown.length), detail: unknown.join(', ') } : null;
});

// 3. AI read-only invariant — no registered AI tool may have a mutating-sounding name (the AI must
// never be able to place/modify a trade). `explore` is the allowed read-only orchestrator. The list covers the
// trade-mutation vocabulary (place/modify/execute/submit plus money movement) on top of the original set, and
// matching is case-insensitive, so a future tool like `Place_Order` or `execute_trade` is caught even though
// the invariant holds by construction today. Deliberately EXCLUDED: `open` and `trade` — those are nouns in
// legitimate read-only tools (`get_open_deals`, `list_open_deals`, a `trade_history` reader), and a genuinely
// mutating "open a deal" tool would already trip `create`/`start`, so including them would only false-positive.
const MUTATING_SEGMENTS = new Set([
	'create', 'update', 'delete', 'close', 'cancel', 'pause', 'panic', 'sell', 'buy',
	'enable', 'disable', 'remove', 'write', 'save', 'add', 'start', 'set', 'stop',
	'place', 'modify', 'execute', 'submit', 'transfer', 'withdraw', 'deposit', 'liquidate'
]);
// A tool name "looks mutating" if any underscore-separated segment is a mutation verb (case-insensitive).
// `explore` is the allowed read-only orchestrator. Exported (pure) so the safety net is unit-tested.
function isMutatingToolName(name) {
	if (!name || name === 'explore') { return false; }
	return String(name).toLowerCase().split('_').some(seg => MUTATING_SEGMENTS.has(seg));
}
register('ai_read_only', function () {
	const tools = (AITools && Array.isArray(AITools.TOOLS)) ? AITools.TOOLS : [];
	const mutating = tools.map(t => (t && t.name) || '').filter(isMutatingToolName);
	return mutating.length ? { action: 'watchdog.mutating_ai_tool', target: String(mutating.length), detail: mutating.join(', ') } : null;
});

// 3b. In-app guide present — the Help panel serves the shipped docs/README.md at /readme.md (both on an
// instance and on the Hub). A trimmed deployment (a partial install, or an image built without docs/)
// would leave the Help button fetching a 404. Warn-only, so it can never affect trading or startup; it
// just flags that the guide is missing or empty before a user discovers it.
register('guide_present', function () {
	const guide = path.join(__dirname, '..', '..', 'docs', 'README.md');
	let ok = false;
	try { ok = fs.statSync(guide).size > 0; } catch (e) { ok = false; }
	return ok ? null : { action: 'watchdog.guide_missing', target: 'docs/README.md', detail: 'the in-app Help guide file is missing or empty; the Help panel would fail to load' };
});

// 4. Capability drift — an API key must never carry a capability its CURRENT owner can no longer grant.
// Keys are scoped to the owner's capabilities at creation; if that owner's role is later narrowed, the
// key would keep the broader access (privilege that outlives the grant). This async check reads keys +
// users from the DB and flags any active key whose capabilities exceed what its owner could grant now.
register('capability_drift', async function (shareData) {

	const ApiKeys = shareData && shareData.ApiKeys;
	const Users   = shareData && shareData.Users;
	if (!ApiKeys || typeof ApiKeys.listRaw !== 'function' || !Users || typeof Users.listRaw !== 'function' || typeof Users.toPrincipal !== 'function') { return null; }

	const [ keys, users ] = await Promise.all([ ApiKeys.listRaw(), Users.listRaw() ]);

	const usersById = {};
	for (const u of (users || [])) { if (u && u.user_id) { usersById[u.user_id] = u; } }

	const drifted = [];

	for (const k of (keys || [])) {

		if (!k || k.status !== 'active') { continue; }
		if (k.is_internal) { continue; }                              // the self-provisioned internal signals key
		const ownerId = k.owner_user_id;
		// A reserved synthetic id ('owner' = the implicit single-operator, 'system', the legacy
		// webhook) is NOT a user record — it can never be "removed", so it is not drift. Only a
		// real user_id that has since disappeared counts.
		if (Authz.isReservedPrincipalId(ownerId)) { continue; }

		const owner = usersById[ownerId];
		if (!owner) { drifted.push((k.name || k.prefix || k.key_id) + ' (owner removed)'); continue; }

		const principal = Users.toPrincipal(owner);
		const caps = Array.isArray(k.capabilities) ? k.capabilities : [];
		const over = caps.filter(c => c && !Authz.can(principal, c));   // capabilities the owner can no longer grant

		if (over.length) { drifted.push((k.name || k.prefix || k.key_id) + ' [' + over.join(',') + ']'); }
	}

	return drifted.length ? { action: 'watchdog.capability_drift', target: String(drifted.length), detail: drifted.join('; ') } : null;
});

// 5. Admin lockout safety — once real user accounts exist, at least one must be an ACTIVE admin (or
// owner), or nobody can reach Access Control and the operator can lock themselves out. Skipped in
// single-operator mode (no user records), where the implicit owner always has full access. Read-only.
register('auth_admin_present', async function (shareData) {

	const Users = shareData && shareData.Users;
	if (!Users || typeof Users.listRaw !== 'function') { return null; }

	const users = await Users.listRaw();
	if (!Array.isArray(users) || users.length === 0) { return null; }   // single-operator mode — implicit owner has access

	const hasActiveAdmin = users.some(u => u && u.status === 'active' && Authz.roleAtLeast(u.role, 'admin'));

	return hasActiveAdmin ? null : { action: 'watchdog.no_active_admin', target: String(users.length), detail: 'user accounts exist but none is an active admin or owner — no one can manage Access Control' };
});

// 6. Orphaned open deals — an OPEN deal (status 0) whose bot record no longer exists. The trading
// loop iterates bots→deals, so a deal whose bot was deleted is never advanced (its funds can sit in
// limbo). Read-only: it only reads deals and bots and reports; it never touches the trading path.
register('orphaned_open_deals', async function (shareData) {

	const DCABot = shareData && shareData.DCABot;
	if (!DCABot || typeof DCABot.getDeals !== 'function' || typeof DCABot.getBots !== 'function') { return null; }

	const [ openDeals, bots ] = await Promise.all([ DCABot.getDeals({ status: 0 }), DCABot.getBots({}) ]);
	if (!Array.isArray(openDeals) || openDeals.length === 0) { return null; }

	const botIds = new Set((bots || []).map(b => b && b.botId).filter(Boolean));

	const orphans = [];
	for (const d of openDeals) {
		const bid = d && d.botId;
		if (bid && !botIds.has(bid)) { orphans.push((d && d.dealId) || bid); }
	}
	if (orphans.length === 0) { return null; }

	const shown = orphans.slice(0, 10).join(', ') + (orphans.length > 10 ? ', …' : '');
	return { action: 'watchdog.orphaned_open_deals', target: String(orphans.length), detail: 'open deal(s) reference a bot that no longer exists: ' + shown };
});

// 6b. Duplicate open deals per pair — more than one OPEN deal (status 0) for the same bot + pair. SymBot's
// single-deal-start gate (canStartDeal) admits at most one open deal per (bot, pair) at a time, so two is an
// invariant violation: something bypassed the gate or crashed mid-start, and the trading loop would then
// advance two deals against one pair. Read-only — reads deals only and reports; never touches the trading path.
register('duplicate_open_deals_per_pair', async function (shareData) {

	const DCABot = shareData && shareData.DCABot;
	if (!DCABot || typeof DCABot.getDeals !== 'function') { return null; }

	const openDeals = await DCABot.getDeals({ status: 0 });
	if (!Array.isArray(openDeals) || openDeals.length < 2) { return null; }

	const seen = Object.create(null);
	const dupes = [];

	for (const d of openDeals) {
		if (!d || !d.botId || !d.pair) { continue; }
		const key = d.botId + '|' + d.pair;
		if (seen[key]) { dupes.push(d.pair + ' (bot ' + d.botId + ')'); } else { seen[key] = true; }
	}
	if (dupes.length === 0) { return null; }

	const uniq = Array.from(new Set(dupes));
	const shown = uniq.slice(0, 10).join(', ') + (uniq.length > 10 ? ', …' : '');
	return { action: 'watchdog.duplicate_open_deals', target: String(uniq.length), detail: 'more than one open deal for the same bot + pair (the single-deal-start gate allows only one): ' + shown };
});

// 6c. Stuck deal with no orders — an OPEN deal (status 0) older than a short grace window that has NO filled
// orders. A healthy deal places its base order at creation, so an old open deal with nothing filled is a
// half-created deal occupying its bot's per-pair slot without ever having entered. Read-only — reads deals
// only. The grace window means a deal that is mid-creation right now is never flagged.
register('deal_missing_orders', async function (shareData) {

	const DCABot = shareData && shareData.DCABot;
	if (!DCABot || typeof DCABot.getDeals !== 'function') { return null; }

	const openDeals = await DCABot.getDeals({ status: 0 });
	if (!Array.isArray(openDeals) || openDeals.length === 0) { return null; }

	const GRACE_MS = 10 * 60 * 1000;
	const now = Date.now();
	const stuck = [];

	for (const d of openDeals) {
		if (!d) { continue; }
		const orders = Array.isArray(d.orders) ? d.orders : [];
		const filled = orders.filter(o => o && o.filled == 1);
		const started = d.date ? new Date(d.date).getTime() : now;
		if (filled.length === 0 && (now - started) > GRACE_MS) { stuck.push(d.dealId || d.pair || '?'); }
	}
	if (stuck.length === 0) { return null; }

	const shown = stuck.slice(0, 10).join(', ') + (stuck.length > 10 ? ', …' : '');
	return { action: 'watchdog.deal_missing_orders', target: String(stuck.length), detail: 'open deal(s) older than 10 min with no filled orders — a half-started deal holding a pair slot: ' + shown };
});

// 7. Over-privileged user — a NON-owner account that holds the '*' (owner) wildcard. Only the owner role
// should ever carry '*'; a non-owner with it has owner-level power without the owner role — the shape a
// privilege-escalation (or direct DB tampering) would leave behind. User creation now bounds role/grants
// to the creator's authority, so this is a detective control for anything created before that guard or
// edited out-of-band. Read-only, warn-only. Works wherever a Users-compatible store is present.
register('over_privileged_user', async function (shareData) {

	const Users = shareData && shareData.Users;
	if (!Users || typeof Users.listRaw !== 'function' || typeof Users.toPrincipal !== 'function') { return null; }

	const users = await Users.listRaw();
	if (!Array.isArray(users) || users.length === 0) { return null; }

	const flagged = [];

	for (const u of users) {

		if (!u || u.role === 'owner') { continue; }   // the owner role legitimately holds '*'

		if (Authz.hasCapability(Users.toPrincipal(u).capabilities, '*')) {

			flagged.push((u.username || u.user_id) + ' (' + u.role + ')');
		}
	}

	return flagged.length ? { action: 'watchdog.over_privileged_user', target: String(flagged.length), detail: 'non-owner account holds owner-level (*) access: ' + flagged.join(', ') } : null;
});

// 8. Default owner password — warn if the owner login password is still the seeded default ('admin').
// Combined with a network-exposed instance this is a trivially-known credential. Warn-only; never blocks
// login or trading. Verifies 'admin' against the stored salt:hash rather than assuming any format.
register('default_password', async function (shareData) {

	const Common  = shareData && shareData.Common;
	const appData = shareData && shareData.appData;
	if (!Common || typeof Common.isDefaultPassword !== 'function' || !appData || !appData.password) { return null; }

	try {

		// One shared predicate (Common.isDefaultPassword) so the watchdog and the boot nudge can't diverge on
		// what counts as the default password. It never throws (resolves false on any malformed hash).
		const isDefault = await Common.isDefaultPassword(appData.password);

		return isDefault ? { action: 'watchdog.default_password', target: 'owner', detail: 'the owner login password is still the default — change it before exposing SymBot to any network' } : null;
	}
	catch (e) { return null; }
});


// 9. Hub instance liveness — is every ENABLED instance actually running? When an instance worker crashes and
// exhausts its restart attempts (or otherwise dies with nothing rescheduling it), it leaves no live worker and
// nothing else re-surfaces it: it is silently not trading. Under continuous monitoring this check catches that
// class of silent failure. Read-only (emits a finding, never acts). Instances mid-restart-backoff are excluded
// (they are already being handled). No-ops on a standalone instance — the guard requires the Hub's workerMap
// and supervisor — and fails safe (returns nothing) on any read error, so it can never raise a false alarm.
register('instance_liveness', async function (shareData) {

	try {

		if (!shareData || !(shareData.workerMap instanceof Map) || !shareData.HubMain
			|| !shareData.appData || !shareData.appData.hub_config
			|| !shareData.Common || typeof shareData.Common.getConfig !== 'function') {

			return [];   // not a Hub (or not wired) — nothing to check here
		}

		const hubData = await shareData.Common.getConfig(shareData.appData.hub_config);
		const instances = (hubData && hubData.success && hubData.data && Array.isArray(hubData.data.instances))
			? hubData.data.instances : null;

		if (!instances) { return []; }

		// IDs of instances that currently have a live worker.
		const liveIds = new Set();
		for (const [, info] of shareData.workerMap.entries()) {
			if (info && info.instance && info.instance.id != null) { liveIds.add(info.instance.id); }
		}

		// IDs the supervisor is already restarting / backing off — don't flag those.
		let pending = [];
		try {
			if (typeof shareData.HubMain.getScheduledRestartInstanceIds === 'function') {
				pending = shareData.HubMain.getScheduledRestartInstanceIds();
			}
		}
		catch (e) { /* if we can't read it, err toward not flagging */ }

		return evaluateInstanceLiveness(instances, liveIds, pending);
	}
	catch (e) { return []; }   // fail safe — never a false alarm on a read error
});


// Pure liveness decision, factored out (and exported) so it can be unit-tested without a live Hub. Given the
// configured instances, the set of instance IDs with a live worker, and the IDs currently scheduled for a
// crash-restart, return a finding for every ENABLED instance that is neither running nor mid-restart. Disabled
// instances and instances with no id are ignored. No side effects.
function evaluateInstanceLiveness(instances, liveIds, pendingIds) {

	if (!Array.isArray(instances)) { return []; }

	const live = (liveIds instanceof Set) ? liveIds : new Set(liveIds || []);
	const pending = (pendingIds instanceof Set) ? pendingIds : new Set(pendingIds || []);

	const findings = [];

	for (const cfg of instances) {

		if (!cfg || cfg.id == null) { continue; }
		if (cfg.enabled === false) { continue; }   // disabled → not expected to be running
		if (live.has(cfg.id)) { continue; }         // running
		if (pending.has(cfg.id)) { continue; }      // mid restart-backoff — being handled

		const name = cfg.name || cfg.id;
		findings.push({ action: 'watchdog.instance_down', target: String(name),
			detail: 'enabled instance "' + name + '" has no live worker and is not scheduled for restart — it is not running' });
	}

	return findings;
}


// ── Autonomous continuous monitor ──────────────────────────────────────────────
// The watchdog is a general "watch anything" system, so it OWNS its own scheduling here rather than relying on
// a caller's loop: it runs one verbose sweep at startup and then keeps re-running on a self-unref'd interval for
// the life of the process. A periodic sweep is QUIET on a clean run (reports only findings) so ongoing
// monitoring never floods the log or audit trail. Everything is best-effort and NON-BLOCKING — run() never
// rejects, each tick is fire-and-forget with its own catch, and the timer is unref'd so it never holds the
// process open. Surface-specific inputs (for example the Express `router` the route-gating checks need) are
// passed through as an opaque `context` value, so this file stays dependency-free and surface-agnostic.

// Default cadence for the continuous sweep; an operator can override it with appData.watchdog_interval_secs (a
// positive number of seconds). A value <= 0, absent, or non-numeric falls back to the default.
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;   // 15 minutes

function resolveIntervalMs(shareData) {

	const secs = (shareData && shareData.appData) ? Number(shareData.appData.watchdog_interval_secs) : NaN;

	return (Number.isFinite(secs) && secs > 0) ? (secs * 1000) : DEFAULT_INTERVAL_MS;
}

// Run one sweep and never reject. `opts.periodic` marks a quiet continuous sweep; omit it (or pass false) for
// the verbose boot / on-demand run. `context` is merged with the periodic flag and passed to run().
function runOnce(shareData, context, opts) {

	opts = opts || {};

	const ctx = Object.assign({}, context || {}, { periodic: !!opts.periodic });

	return Promise.resolve(run(shareData, ctx)).catch(function () {});
}

// Run the verbose boot sweep and arm the continuous, quiet monitor. `context` carries per-surface inputs such
// as { router, label }. Returns the boot run's promise so a caller may await the first sweep; the interval keeps
// running afterward. Call once per surface at startup.
function startMonitor(shareData, context) {

	const boot = runOnce(shareData, context, { periodic: false });

	const timer = setInterval(function () { runOnce(shareData, context, { periodic: true }); }, resolveIntervalMs(shareData));

	if (timer && typeof timer.unref === 'function') { timer.unref(); }

	return boot;
}


module.exports = { register, list, run, runOnce, startMonitor, resolveIntervalMs, DEFAULT_INTERVAL_MS, evaluateInstanceLiveness, isMutatingToolName };
