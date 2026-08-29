'use strict';

// ── RoutePermissions — declarative route → capability map ─────────────────────
//
// One reviewable place that states which capability each state-changing (money/write) route
// requires. A single middleware (wired in the web server) enforces it, so the ~56 route
// handlers are not edited individually. Enforcement is deliberately narrow and safe:
//
//   • Only a request that HAS a resolved principal lacking the capability is denied (403).
//   • A request with no principal is left to the route's own gate (login redirect / 401).
//   • An unmapped route keeps its existing behavior (authenticated = allowed).
//   • The owner (capabilities ['*']) and the legacy single key always pass — so the single
//     operator and existing integrations are never affected. Worst case for a *scoped* key
//     is over-restriction (safe), never accidental access.
//
// Read routes are intentionally NOT mapped here (any authenticated principal may read); this
// map is the enforcement surface for the actions a read-only key/viewer must be denied.
// Paths are matched against req.path; Express :params are covered by the regexes.
//
// ── CONTRACT FOR ADDING ROUTES (so nothing slips through ungated) ─────────────
// Every state-changing route (POST / PUT / PATCH / DELETE) must be EITHER:
//   (a) listed in RULES below with the capability it needs, OR
//   (b) listed in PUBLIC below (a route that legitimately needs no capability — e.g. login, or
//       the webhook passthrough which does its own token/scoped-key + capability check).
// `auditCoverage(router)` walks the registered routes at startup and LOGS A WARNING for any
// mutating route covered by neither list, so a newly-added handler that forgot its gate is
// caught immediately instead of being hunted down later. `auditGateStrength()` additionally warns
// when a mutating route is mapped to a *.read capability (an under-gated write a read-only key
// could perform); a route that is genuinely a READ done over POST (credentials in the body) opts
// out with `read: true` on its rule. Both run as Watchdog checks at boot AND as dev-time tests in
// libs/test/app. In short: this file is the one place to look to see how every write route is
// gated, and the audits guarantee the list stays both complete AND correctly scoped.

let shareData;

// Routes that are state-changing but LEGITIMATELY need no capability gate. Each entry must be
// justified — this is the deliberate exception list the coverage audit trusts.
const PUBLIC = [
	{ m: 'POST',   re: /^\/login$/,          why: 'the credential check itself' },
	{ m: 'POST',   re: /^\/logout$/,         why: 'ends the caller\'s own session' },
	{ m: 'POST',   re: /^\/webhook\//,       why: 'webhook passthrough — authenticates + capability-checks inside processWebHook' }
];

const RULES = [
	// Configuration
	{ m: 'POST',   re: /^\/config$/,                               cap: 'settings.write' },

	// Account balances are a READ, but the routes are POST (exchange/credentials in the body), so
	// they need an explicit rule to be covered. Gate at account.read (viewers/read keys may read).
	// `read: true` marks this as a DELIBERATE read-over-POST so the gate-strength audit (which flags
	// a mutating route mapped to a *.read capability) does not treat it as an under-gated write.
	{ m: 'POST',   re: /^\/api\/accounts(\/[^/]+)?\/balances$/,     cap: 'account.read', read: true },

	// Deals — modify / fund / start
	{ m: 'POST',   re: /^\/api\/deals\/[^/]+\/update_deal$/,        cap: 'deal.create' },
	{ m: 'POST',   re: /^\/api\/(deals|bots)\/[^/]+\/add_funds$/,   cap: 'deal.create' },
	{ m: 'POST',   re: /^\/api\/bots\/[^/]+\/start_deal$/,          cap: 'deal.create' },
	{ m: 'POST',   re: /^\/api\/signal\/[^/]+$/,                    cap: 'deal.create' },
	// Deals — pause / close / cancel / emergency
	{ m: 'POST',   re: /^\/api\/deals\/[^/]+\/pause$/,              cap: 'deal.pause' },
	{ m: 'POST',   re: /^\/api\/deals\/[^/]+\/cancel$/,             cap: 'deal.close' },
	{ m: 'POST',   re: /^\/api\/(deals|bots)\/[^/]+\/panic_sell$/,  cap: 'deal.close' },
	{ m: 'POST',   re: /^\/api\/(deals|bots)\/[^/]+\/close$/,       cap: 'deal.close' },

	// Bots
	{ m: 'POST',   re: /^\/api\/bots\/(create|update)$/,            cap: 'bot.write' },
	{ m: 'POST',   re: /^\/api\/bots\/[^/]+\/(enable|disable)$/,    cap: 'bot.write' },
	{ m: 'POST',   re: /^\/api\/bots\/update-exchange$/,            cap: 'bot.write' },
	{ m: 'POST',   re: /^\/api\/bot-config(\/sandbox)?$/,           cap: 'bot.write' },
	{ m: 'DELETE', re: /^\/api\/bots\/[^/]+$/,                      cap: 'bot.delete' },

	// Journal (notes / mood / narrative / delete) — writes to the user's records; the narrative
	// route also triggers a paid AI generation. Gate all journal writes.
	{ m: 'POST',   re: /^\/api\/journal\/.+$/,                     cap: 'settings.write' },

	// Schedules — create / update / run / delete. These can launch backups and paid AI runs.
	{ m: 'POST',   re: /^\/api\/schedules(\/.+)?$/,                cap: 'settings.write' },
	{ m: 'DELETE', re: /^\/api\/schedules\/.+$/,                   cap: 'settings.write' },

	// Recipe library — adding a pre-defined recipe creates a schedule the user manages, same class
	// of change as creating a schedule directly.
	{ m: 'POST',   re: /^\/api\/recipes\/[^/]+\/add$/,             cap: 'settings.write' },
	{ m: 'POST',   re: /^\/api\/recipes\/[^/]+\/reset$/,           cap: 'settings.write' },

	// System / operations — backup, restore, update, rollback, shutdown are highly privileged and
	// would otherwise be reachable by any resolved key or non-owner session. Gate behind settings.write.
	{ m: 'POST',   re: /^\/(api\/)?system\/backup$/,               cap: 'settings.write' },
	{ m: 'POST',   re: /^\/system\/restore$/,                      cap: 'settings.write' },
	{ m: 'POST',   re: /^\/system\/update$/,                       cap: 'settings.write' },
	{ m: 'POST',   re: /^\/system\/rollback$/,                     cap: 'settings.write' },
	{ m: 'POST',   re: /^\/system\/shutdown$/,                     cap: 'settings.write' },

	// Circuit-breaker override (re-enables deal opening) and the SMTP test send.
	{ m: 'POST',   re: /^\/api\/circuit-breaker\/clear$/,          cap: 'settings.write' },
	{ m: 'POST',   re: /^\/api\/mailer\/test$/,                    cap: 'settings.write' },

	// Learning-corpus writes need a write scope, not the generic AI read scope below (first match
	// wins). Import adds patterns; rate mutates a pattern's 👍/👎 quality signal; aggregate merges
	// contributed packs into the shared corpus (commit:true persists via importPack) — all of which
	// steer what gets surfaced, so a read-only key must not be able to poison the corpus. (The Hub gates
	// its own /api/hub/learning/aggregate at settings.write too; this keeps the instance consistent.)
	{ m: 'POST',   re: /^\/api\/ai\/learning\/import$/,            cap: 'settings.write' },
	{ m: 'POST',   re: /^\/api\/ai\/learning\/rate$/,             cap: 'settings.write' },
	{ m: 'POST',   re: /^\/api\/ai\/learning\/aggregate$/,        cap: 'settings.write' },

	// AI features are read-only for trading (they can never place/modify a trade) but consume
	// paid generations, so require at least a read scope rather than admitting any key. Covers the
	// GET history/conversation reads and the POST/DELETE generate + persistence routes. The
	// POST/DELETE routes are read-scoped BY DESIGN (chat/conversation actions are non-trading and a
	// stats.read viewer should be able to use them) — `read: true` records that deliberate choice so
	// the gate-strength audit doesn't flag them; the genuinely mutating corpus routes (import/rate)
	// are elevated to settings.write above and are matched first.
	{ m: 'GET',    re: /^\/api\/ai\//,                             cap: 'stats.read' },
	{ m: 'POST',   re: /^\/api\/ai\//,                             cap: 'stats.read', read: true },
	{ m: 'DELETE', re: /^\/api\/ai\//,                             cap: 'stats.read', read: true },

	// ── Read scoping (GET data endpoints) ─────────────────────────────────────────────────────
	// So a scoped key can be genuinely least-privilege: a key must hold the matching *.read (or a
	// wider write/wildcard) to read that resource, mirroring the write side. The owner, the legacy
	// single key ('*') and every user role (viewer upward holds all *.read) are unaffected, so the
	// web UI and existing integrations keep working; only a narrowly-scoped API key is restricted.
	// The Access-Control reads (/api/keys, /api/users, /api/audit, /api/authz/capabilities) are
	// already gated inline, and /api/ai/* is covered above, so they are intentionally not repeated.
	// /api/system/health is left open on purpose (load-balancer / uptime probes).
	{ m: 'GET',    re: /^\/api\/bots$/,                            cap: 'bot.read' },
	{ m: 'GET',    re: /^\/api\/bot-config$/,                      cap: 'bot.read' },
	{ m: 'GET',    re: /^\/api\/deals$/,                           cap: 'deal.read' },
	{ m: 'GET',    re: /^\/api\/deals\/completed$/,                cap: 'deal.read' },
	{ m: 'GET',    re: /^\/api\/deals\/[^/]+\/show$/,              cap: 'deal.read' },
	{ m: 'GET',    re: /^\/api\/deals\/export\/transactions$/,     cap: 'deal.read' },
	{ m: 'GET',    re: /^\/api\/deals\/export\/deals$/,            cap: 'deal.read' },
	{ m: 'GET',    re: /^\/api\/signals\/activity$/,              cap: 'deal.read' },
	{ m: 'GET',    re: /^\/api\/recipes(\/.*)?$/,                  cap: 'settings.read' },
	{ m: 'GET',    re: /^\/api\/journal(\/stats)?$/,               cap: 'stats.read' },
	{ m: 'GET',    re: /^\/api\/markets(\/.+)?$/,                  cap: 'stats.read' },
	{ m: 'GET',    re: /^\/api\/tradingview$/,                     cap: 'stats.read' },
	{ m: 'GET',    re: /^\/api\/exchanges$/,                       cap: 'account.read' },
	{ m: 'GET',    re: /^\/api\/schedules(\/.+)?$/,                cap: 'settings.read' },
	{ m: 'GET',    re: /^\/api\/schedule-runs\/export$/,           cap: 'settings.read' },
	// Not a pure read: it drives an outbound update-check fetch and flips shared update state, so a
	// least-privilege read-only key should not be able to trigger it. Its only caller is the (post-login)
	// config page, which is a settings context — gate at settings.read.
	{ m: 'GET',    re: /^\/app-version$/,                          cap: 'settings.read' }
];

// The capability required for a method+path, or null if the route is unmapped. Single exit.
function required(method, path) {
	let capability = null;
	if (method && path) {
		for (let i = 0; i < RULES.length; i++) {
			if (RULES[i].m === method && RULES[i].re.test(path)) { capability = RULES[i].cap; break; }
		}
	}
	return capability;
}

// True if a mutating route is on the deliberate no-capability allowlist. Single exit.
function isPublic(method, path) {
	let pub = false;
	if (method && path) {
		for (let i = 0; i < PUBLIC.length; i++) {
			if (PUBLIC[i].m === method && PUBLIC[i].re.test(path)) { pub = true; break; }
		}
	}
	return pub;
}

const MUTATING = { POST: true, PUT: true, PATCH: true, DELETE: true };

// A route is also considered gated if one of its own handlers is a capability guard tagged with
// `__capGuard` (the instance Access-Control routes and all Hub routes gate this way, inline,
// rather than through the app-level RULES middleware). This lets the audit recognize both styles.
function routeHasCapGuard(route) {
	const st = (route && route.stack) || [];
	for (let i = 0; i < st.length; i++) {
		if (st[i] && st[i].handle && st[i].handle.__capGuard) { return true; }
	}
	return false;
}

// Walk an Express router's registered routes and return every MUTATING route that is covered by
// neither RULES nor PUBLIC — i.e. a state-changing endpoint with no capability gate. Registered
// paths carry :params (e.g. /api/deals/:dealId/close); the RULES regexes' [^/]+ segments match a
// ":param" literal, so coverage is detected without needing a concrete request. Never throws.
function auditCoverage(router) {
	const uncovered = [];
	try {
		const stack = (router && router.stack) || [];
		for (const layer of stack) {
			if (!layer || !layer.route) { continue; }
			const route = layer.route;
			const paths = Array.isArray(route.path) ? route.path : [ route.path ];
			const methods = Object.keys(route.methods || {}).map(m => m.toUpperCase()).filter(m => MUTATING[m]);
			for (const method of methods) {
				for (const p of paths) {
					if (typeof p !== 'string') { continue; }
					if (isPublic(method, p) || required(method, p) || routeHasCapGuard(route)) { continue; }
					uncovered.push(method + ' ' + p);
				}
			}
		}
	}
	catch (e) { /* auditing must never break startup */ }
	return uncovered;
}

// Gate-STRENGTH audit: a mutating route (POST/PUT/PATCH/DELETE) mapped to a *.read capability is
// almost always under-gated — a write reachable by a read-only key. This is a different failure
// from a MISSING gate (auditCoverage): the route IS covered, just at too weak a scope, which
// coverage happily passes. The one legitimate case is a READ performed over POST because
// credentials go in the body (e.g. account balances) — those rules set `read: true` to opt out.
// Returns the list of suspicious "METHOD pattern → cap" strings. Never throws. Single exit.
function auditGateStrength() {
	const weak = [];
	try {
		for (const r of RULES) {
			if (r && MUTATING[r.m] && typeof r.cap === 'string' && r.cap.endsWith('.read') && r.read !== true) {
				weak.push(r.m + ' ' + (r.re && r.re.source ? r.re.source : '?') + ' → ' + r.cap);
			}
		}
	}
	catch (e) { /* auditing must never break startup */ }
	return weak;
}

// Canonical per-action → capability map for the Hub's multiplexed action routes (/bots/action and
// /deals/action), which dispatch by an `action` name instead of a REST path so the RULES regexes
// above can't match them. The Hub builds BOTH its action gates from this one table (see
// libs/webserver/Hub/routes.js) instead of hand-copying the literals, so the instance and Hub can
// never silently diverge on what a scoped key may do across instances. The WRITE actions here MUST
// agree with the RULES regexes above; auditActionCaps() proves that at boot and in tests. The READ
// actions (get_*) aren't in RULES — GET data isn't path-gated to a write scope — but are listed so
// the Hub gates cross-instance reads at the right *.read scope too.
const ACTION_CAPS = {
	bot: {
		'create':               'bot.write',
		'update':               'bot.write',
		'delete':               'bot.delete',
		'bot_enable':           'bot.write',
		'bot_disable':          'bot.write',
		'start_deal':           'deal.create',
		'get_defaults':         'bot.read',
		'get_sc_strings':       'bot.read',
		'get_start_conditions': 'bot.read',
		'get_symbols':          'bot.read',
		'get_bot':              'bot.read'
	},
	deal: {
		'cancel':      'deal.close',
		'stop':        'deal.close',
		'panic_sell':  'deal.close',
		'pause':       'deal.pause',
		'update_deal': 'deal.create'
	}
};

// Representative instance HTTP route for each WRITE action, so auditActionCaps() can prove the
// ACTION_CAPS capability equals what the RULES map enforces for the same operation over HTTP (the Hub
// must never under-gate a cross-instance action relative to the instance itself). Read actions have no
// write route to compare against, so they are intentionally absent here.
const ACTION_CAP_ROUTES = {
	bot: {
		'create':      [ 'POST',   '/api/bots/create' ],
		'update':      [ 'POST',   '/api/bots/update' ],
		'delete':      [ 'DELETE', '/api/bots/b1' ],
		'bot_enable':  [ 'POST',   '/api/bots/b1/enable' ],
		'bot_disable': [ 'POST',   '/api/bots/b1/disable' ],
		'start_deal':  [ 'POST',   '/api/bots/b1/start_deal' ]
	},
	deal: {
		'cancel':      [ 'POST', '/api/deals/d1/cancel' ],
		'stop':        [ 'POST', '/api/deals/d1/close' ],   // the Hub "stop" action is a deal close
		'panic_sell':  [ 'POST', '/api/deals/d1/panic_sell' ],
		'pause':       [ 'POST', '/api/deals/d1/pause' ],
		'update_deal': [ 'POST', '/api/deals/d1/update_deal' ]
	}
};

// Cross-check: every WRITE action's ACTION_CAPS capability must equal the capability the RULES map
// requires for the same operation over HTTP. Returns a list of "group.action: hub=<cap> http=<cap>"
// mismatches (empty when consistent). Never throws — auditing must not break startup.
function auditActionCaps() {
	const drift = [];
	try {
		for (const group of Object.keys(ACTION_CAP_ROUTES)) {
			for (const action of Object.keys(ACTION_CAP_ROUTES[group])) {
				const [ m, p ] = ACTION_CAP_ROUTES[group][action];
				const httpCap = required(m, p);
				const hubCap  = ACTION_CAPS[group] && ACTION_CAPS[group][action];
				if (httpCap !== hubCap) { drift.push(group + '.' + action + ': hub=' + hubCap + ' http=' + httpCap); }
			}
		}
	}
	catch (e) { /* auditing must never break startup */ }
	return drift;
}

// Build a runtime matcher for routes gated by an inline `__capGuard` (a cap()/capAction() guard).
// These routes are INVISIBLE to `required()` (which only consults RULES), so the app-level
// default-deny must consult this to avoid blanket-denying a non-owner principal on an inline-gated
// route (the instance Access-Control routes and ALL Hub action routes gate this way) before that
// route's own guard can allow it. Build it ONCE, after the router's routes are registered — the
// returned function takes (method, path) and is safe to call per request. Never throws.
function buildInlineGuardMatcher(router) {
	const guarded = [];
	try {
		const stack = (router && router.stack) || [];
		for (const layer of stack) {
			if (!layer || !layer.route) { continue; }
			if (!routeHasCapGuard(layer.route)) { continue; }
			const methods = new Set(Object.keys(layer.route.methods || {}).map(m => m.toUpperCase()));
			// Keep the Express Layer itself and use its own path matcher — Layer.match(path) is the
			// stable API across Express versions (layer.regexp is not always present), and it handles
			// :param segments correctly.
			if (methods.size) { guarded.push({ layer, methods }); }
		}
	}
	catch (e) { /* matcher building must never break startup */ }

	return function (method, path) {
		for (let i = 0; i < guarded.length; i++) {
			const g = guarded[i];
			if (!g.methods.has(method)) { continue; }
			let hit = false;
			try {
				if (typeof g.layer.match === 'function') { hit = g.layer.match(path); }
				else if (g.layer.regexp && typeof g.layer.regexp.test === 'function') { hit = g.layer.regexp.test(path); }
			}
			catch (e) { hit = false; }
			if (hit) { return true; }
		}
		return false;
	};
}

// Run the coverage audit against a registered router and log a prominent warning for anything
// ungated, so a forgotten gate is visible at boot. Returns the uncovered list. Single exit.
module.exports = {
	init: function (obj) { shareData = obj; },
	RULES,
	PUBLIC,
	ACTION_CAPS,
	required,
	isPublic,
	auditCoverage,
	auditGateStrength,
	auditActionCaps,
	buildInlineGuardMatcher,
	MUTATING_METHOD: MUTATING
};