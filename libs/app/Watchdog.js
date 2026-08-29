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
// Eleven built-in checks are registered at the bottom of this file (route_gating, route_gate_strength,
// capability_integrity, ai_read_only, capability_drift, auth_admin_present, orphaned_open_deals,
// duplicate_open_deals_per_pair, deal_missing_orders, over_privileged_user, default_password).
// Other modules register their own by calling Watchdog.register(...) — currently ai_learning_drift +
// tool_schema_parity + tool_guide_coverage (AIClient), schedule_handler_coverage + schedule_heartbeat
// (Scheduler), recipe_file_integrity (ScheduleRecipes), audit_chain_integrity (Audit),
// signal_activity_recognizer (SignalActivity), and config_secret_decryptable + db_index_presence +
// log_secret_scan + data_dir_writable + ip_filter_spoofable (System) — twenty-four checks in all.

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
		else {
			logger('Watchdog' + label + ': all integrity checks passed (' + checks.length + ' checks).', true);
			audit('watchdog', 'watchdog.ok', String(checks.length), 'startup integrity checks passed' + label);
		}
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
// never be able to place/modify a trade). `explore` is the allowed read-only orchestrator.
const MUTATING_SEGMENTS = new Set([
	'create', 'update', 'delete', 'close', 'cancel', 'pause', 'panic', 'sell', 'buy',
	'enable', 'disable', 'remove', 'write', 'save', 'add', 'start', 'set', 'stop'
]);
register('ai_read_only', function () {
	const tools = (AITools && Array.isArray(AITools.TOOLS)) ? AITools.TOOLS : [];
	const mutating = tools
		.map(t => (t && t.name) || '')
		.filter(name => name && name !== 'explore' && String(name).split('_').some(seg => MUTATING_SEGMENTS.has(seg)));
	return mutating.length ? { action: 'watchdog.mutating_ai_tool', target: String(mutating.length), detail: mutating.join(', ') } : null;
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
	if (!Common || typeof Common.verifyPasswordHash !== 'function' || !appData || !appData.password) { return null; }

	const parts = String(appData.password).split(':');
	if (parts.length !== 2) { return null; }

	try {

		const isDefault = await Common.verifyPasswordHash({ salt: parts[0], hash: parts[1], data: 'admin' });

		return isDefault ? { action: 'watchdog.default_password', target: 'owner', detail: 'the owner login password is still the default — change it before exposing SymBot to any network' } : null;
	}
	catch (e) { return null; }
});


module.exports = { register, list, run };
