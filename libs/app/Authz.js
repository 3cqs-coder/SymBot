'use strict';

// ── Authz — the central authorization core ───────────────────────────────────
//
// One place owns the permission model, so every gate in the app (UI socket path, the
// HTTP/API/curl path, WebSocket, and the Hub) checks the same way. The design rules:
//
//   • Capabilities are the source of truth; roles are just named bundles of them. Code
//     always checks a capability string ("bot.write"), never a role name — so adding
//     roles/keys/scopes later never re-plumbs call sites.
//   • Deny by default: can() returns false unless a capability explicitly matches.
//   • Authentication is separate from authorization: whoever authenticated (a user
//     session OR an API key) is first normalized into ONE principal, and every check
//     runs against that principal identically.
//   • Trivial for one user, enterprise-capable underneath: a single operator is an
//     implicit `owner` (capabilities ['*']) with no ceremony; roles/users/grants only
//     surface when a fleet or a second user actually exists.
//   • Everything is add/disable/remove-able: the capability vocabulary is append-only,
//     roles are editable bundles, and keys/users/grants carry a status so they can be
//     turned off without deletion.
//
// This module is PURE logic (no DB, no network) so it is fully unit-testable; the storage
// layers (ApiKeys, Users, the audit log) build on top and feed principals into can().

let shareData;


// ── Capability vocabulary (append-only) ──────────────────────────────────────
// Each entry is { key: 'resource.action', label } — the label drives the permission UI
// so there is no second enum to keep in sync. Adding a
// capability is one line here; nothing else migrates. Group by resource; keep `resource`
// and `action` to two segments.
const CAPABILITIES = [
	// Read surface
	{ key: 'account.read',   label: 'View account & connection info' },
	{ key: 'bot.read',       label: 'View bots' },
	{ key: 'deal.read',      label: 'View deals' },
	{ key: 'stats.read',     label: 'View performance & statistics' },
	{ key: 'logs.read',      label: 'View logs' },
	{ key: 'settings.read',  label: 'View configuration' },
	{ key: 'apikey.read',    label: 'View API keys' },
	{ key: 'user.read',      label: 'View users' },
	{ key: 'instance.read',  label: 'View instances' },

	// Trade / bot actions
	{ key: 'bot.write',      label: 'Edit bot settings' },
	{ key: 'bot.create',     label: 'Create bots' },
	{ key: 'bot.delete',     label: 'Delete bots' },
	{ key: 'bot.start',      label: 'Start bots' },
	{ key: 'bot.stop',       label: 'Stop bots' },
	{ key: 'deal.create',    label: 'Start deals' },
	{ key: 'deal.pause',     label: 'Pause / resume deals' },
	{ key: 'deal.close',     label: 'Close / cancel deals' },

	// Management
	{ key: 'settings.write', label: 'Change configuration' },
	{ key: 'apikey.create',  label: 'Create API keys' },
	{ key: 'apikey.revoke',  label: 'Revoke API keys' },
	{ key: 'user.invite',    label: 'Add users' },
	{ key: 'user.manage',    label: 'Change users’ roles & permissions' },
	{ key: 'audit.read',     label: 'View the audit log' },
	{ key: 'instance.manage',label: 'Manage instances (Hub)' }
];

const CAPABILITY_KEYS = CAPABILITIES.map(c => c.key);
const CAPABILITY_SET = new Set(CAPABILITY_KEYS);

// The resource half of every capability (for `resource.*` wildcards and read/write pairing).
const RESOURCES = Array.from(new Set(CAPABILITY_KEYS.map(k => k.split('.')[0])));


// ── Roles: ordered ladder, each an explicit superset ─────────────────────────
// Stored as resolved capability sets so a role is self-contained; the ladder rank is used
// only for lockout/comparison guards, not to imply capabilities.
const READ_CAPS = CAPABILITY_KEYS.filter(k => k.endsWith('.read'));
// Everyday read caps every role gets. `audit.read` is deliberately excluded — the audit log
// is an admin/security surface, granted only to admin and owner below.
const EVERYDAY_READ = READ_CAPS.filter(k => k !== 'audit.read');
const TRADE = [ 'bot.write', 'bot.start', 'bot.stop', 'deal.create', 'deal.pause', 'deal.close' ];

const ROLE_CAPS = {
	viewer:   EVERYDAY_READ.slice(),
	operator: EVERYDAY_READ.concat(TRADE),
	admin:    EVERYDAY_READ.concat(TRADE).concat([ 'bot.create', 'bot.delete', 'settings.write', 'apikey.create', 'apikey.revoke', 'user.invite', 'audit.read' ]),
	owner:    [ '*' ]
};

const ROLE_RANK = { viewer: 1, operator: 2, admin: 3, owner: 4 };
const ROLE_NAMES = Object.keys(ROLE_RANK);
const DEFAULT_ROLE = 'viewer';   // least privilege — never default to owner/admin


// True if `granted` (a single held capability string) satisfies a `required` capability.
// Honors the super-wildcard '*', a resource wildcard 'bot.*', and write-implies-read
// (holding 'bot.write' satisfies 'bot.read'). Single exit.
function grantSatisfies(granted, required) {

	let ok = false;

	if (granted === '*' || granted === required) {

		ok = true;
	}
	else {

		const [ gRes, gAct ] = granted.split('.');
		const [ rRes, rAct ] = required.split('.');

		if (gRes === rRes && gAct === '*') {

			ok = true;                          // 'bot.*' covers any bot action
		}
		else if (gRes === rRes && rAct === 'read' && gAct === 'write') {

			ok = true;                          // write implies read
		}
	}

	return ok;
}


// Whether a set/array of held capabilities satisfies a required capability. Single exit.
function hasCapability(capabilities, required) {

	let ok = false;

	if (required && capabilities) {

		const list = Array.isArray(capabilities) ? capabilities : Array.from(capabilities);

		for (let i = 0; i < list.length; i++) {

			if (grantSatisfies(list[i], required)) { ok = true; break; }
		}
	}

	return ok;
}


// Resolve a set of role names + optional explicit capability grants into a flat, unique
// capability array. Unknown roles contribute nothing. Single exit.
function resolveCapabilities(opts) {

	opts = opts || {};

	const roles = Array.isArray(opts.roles) ? opts.roles : (opts.role ? [ opts.role ] : []);
	const grants = Array.isArray(opts.grants) ? opts.grants : [];

	const set = new Set();

	for (const role of roles) {

		const caps = ROLE_CAPS[role];

		if (caps) { caps.forEach(c => set.add(c)); }
	}

	// Explicit grants may only be real capability keys or a recognized wildcard — never
	// arbitrary strings, so a typo can't silently widen access.
	for (const g of grants) {

		if (g === '*' || CAPABILITY_SET.has(g) || (typeof g === 'string' && g.endsWith('.*') && RESOURCES.indexOf(g.split('.')[0]) >= 0)) {

			set.add(g);
		}
	}

	return Array.from(set);
}


// Normalize anything that authenticated into ONE principal shape. `capabilities` is
// resolved from roles+grants unless passed directly (e.g. an API key carries its own
// scoped capability list). `resourceScopes` (optional, Phase 3) restricts a capability to
// specific resource ids: { bot: Set<id>, instance: Set<id> }; absent = unscoped (blanket).
// Single exit.
function makePrincipal(input) {

	input = input || {};

	const capabilities = Array.isArray(input.capabilities)
		? input.capabilities.slice()
		: resolveCapabilities({ roles: input.roles, role: input.role, grants: input.grants });

	const principal = {
		id:            input.id || null,
		kind:          input.kind || 'user',          // 'user' | 'apikey'
		roles:         Array.isArray(input.roles) ? input.roles.slice() : (input.role ? [ input.role ] : []),
		capabilities:  capabilities,
		resourceScopes: input.resourceScopes || null,
		apiKeyId:      input.apiKeyId || null,         // set for kind 'apikey' — for audit attribution
		rateLimit:     (input.rateLimit != null && !isNaN(input.rateLimit) && Number(input.rateLimit) > 0) ? Number(input.rateLimit) : null   // requests/min for a scoped key, or null = unlimited
	};

	return principal;
}


// Bound a NEW user's role + explicit grants to what the CREATOR can actually confer, so a non-owner
// cannot mint a user more privileged than themselves. This mirrors the API-key path's scopeCapabilities:
//   • a role is assignable only if the creator holds EVERY capability that role would grant (so an admin,
//     lacking '*', cannot create an 'owner'); otherwise it is clamped to the least-privilege role;
//   • explicit grants are filtered to just the capabilities the creator holds (so a grant of '*' or of a
//     capability the creator lacks is dropped).
// `exceeded` is true when the request asked for more than the creator holds — the caller should reject
// with a clear error rather than silently create a lower-privileged user. The owner ('*') is unaffected
// (holds every capability), so the single-operator default keeps full power.
function scopeNewUser(creatorCapabilities, spec) {

	spec = spec || {};

	const creator = Array.isArray(creatorCapabilities) ? creatorCapabilities : [];

	const requestedRole = (ROLE_NAMES.indexOf(spec.role) >= 0) ? spec.role : DEFAULT_ROLE;
	const roleCaps = ROLE_CAPS[requestedRole] || [];
	const roleOk = roleCaps.every(c => hasCapability(creator, c));

	const requestedGrants = Array.isArray(spec.grants) ? spec.grants : [];
	const grants = requestedGrants.filter(c => hasCapability(creator, c));

	return {
		role:     roleOk ? requestedRole : DEFAULT_ROLE,
		grants:   grants,
		exceeded: !roleOk || grants.length !== requestedGrants.length
	};
}


// THE gate. can(principal, 'bot.write' [, resourceId]) → boolean. Deny by default:
//   1. the principal must hold the capability (via hasCapability), else deny;
//   2. if a resourceId is given AND the principal is scoped for that resource type, the
//      id must be in the scope set (blanket/no-scope = allow). Single exit.
function can(principal, capability, resourceId) {

	let allowed = false;

	if (principal && capability && hasCapability(principal.capabilities, capability)) {

		const scopes = principal.resourceScopes;
		const resource = String(capability).split('.')[0];

		if (!scopes || !scopes[resource]) {

			allowed = true;                             // unscoped → blanket allow
		}
		else if (resourceId != null) {

			const set = scopes[resource];
			allowed = (set instanceof Set) ? set.has(resourceId) : (Array.isArray(set) && set.indexOf(resourceId) >= 0);
		}
		// scoped but no resourceId supplied on a resource-specific check → deny (can't prove scope)
	}

	return allowed;
}


// Rank comparison for lockout/UI guards (e.g. only an admin+ may change roles). Single exit.
function roleAtLeast(role, minRole) {

	return (ROLE_RANK[role] || 0) >= (ROLE_RANK[minRole] || Infinity);
}


// Synthetic principal ids that are NOT backed by a user record in the users collection: the
// implicit single-operator ('owner'), the internal/system actor ('system'), and the legacy shared
// webhook token. These are sentinels, not real accounts, so anything that reconciles a key's owner
// against the users store (e.g. the capability-drift Watchdog) must treat them as "no user owner"
// rather than a missing/removed user. Centralized here so every caller agrees on the set.
const RESERVED_PRINCIPAL_IDS = [ 'owner', 'system', 'webhook-token', 'legacy-webhook' ];

// True if `id` is a reserved synthetic principal id (see RESERVED_PRINCIPAL_IDS) or empty — i.e.
// it can never correspond to a real user record. Single exit.
function isReservedPrincipalId(id) {

	return !id || RESERVED_PRINCIPAL_IDS.indexOf(String(id)) !== -1;
}


// The implicit single-operator principal: full access, no ceremony. Used to keep today's
// single-password / single-key install working unchanged until real users/roles exist.
function ownerPrincipal(id) {

	return makePrincipal({ id: id || 'owner', kind: 'user', role: 'owner' });
}


// The legacy shared webhook api-token, resolved to a principal so it flows through the SAME capability
// enforcement as every other credential instead of bypassing it. New integrations should use a scoped API
// key for least privilege; this only governs the single legacy token.
// A valid legacy webhook token is minted as a limited principal. A webhook is a SIGNAL source — its only
// job is to open, fund, pause, and close deals (entry / add_funds / close / panic_sell / close_all all map
// to deal.create / deal.pause / deal.close). So scope the token to exactly the deal actions and nothing
// else. Earlier it carried the whole `operator` bundle, which also granted bot.write / bot.start / bot.stop
// and every *.read — meaning a leaked webhook token could edit bot config, toggle sandbox/live, and read
// the whole book. Those are not signal operations; a caller that genuinely needs them must use a scoped API
// key (least privilege). This narrows the blast radius of a leaked legacy token to deal actions alone.
const WEBHOOK_CAPS = ROLE_CAPS.operator.filter(c => /^deal\.(create|pause|close)$/.test(c));

function webhookPrincipal(id) {

	return makePrincipal({ id: id || 'webhook-token', kind: 'apikey', apiKeyId: 'legacy-webhook', capabilities: WEBHOOK_CAPS.slice() });
}


module.exports = {
	init: function (obj) { shareData = obj; },
	CAPABILITIES,
	CAPABILITY_KEYS,
	RESOURCES,
	ROLE_CAPS,
	ROLE_RANK,
	ROLE_NAMES,
	DEFAULT_ROLE,
	hasCapability,
	grantSatisfies,
	resolveCapabilities,
	scopeNewUser,
	makePrincipal,
	can,
	roleAtLeast,
	ownerPrincipal,
	webhookPrincipal,
	RESERVED_PRINCIPAL_IDS,
	isReservedPrincipalId
};