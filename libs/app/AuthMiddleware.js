'use strict';

// ── AuthMiddleware — the single enforcement seam ─────────────────────────────
//
// Every protected route (UI, HTTP/API/curl, WebSocket) authorizes the same way:
//   1. attachPrincipal() normalizes whoever authenticated — an API key OR a session — into
//      ONE `req.principal` (Authz principal). Authentication is thus fully separated from
//      authorization.
//   2. requireCap('bot.write') / requireAuth guard the route by checking that principal with
//      Authz.can(), deny-by-default.
//
// Backwards compatibility / never-lock-out: a legacy session (loggedIn boolean, no user id —
// i.e. today's single-password install) resolves to the implicit OWNER principal, so a
// fresh/existing single-operator install keeps full access with zero ceremony. A migrated
// single API key carries capabilities ['*'] and behaves identically. Real users/roles and
// scoped keys only narrow access once they exist.

const Authz = require('./Authz.js');

let shareData;

// Constant-time token comparison lives in one place: shareData.Common.safeEqual (canonical
// length-independent hash-first compare), so this webhook-token check stays identical to the
// one in webserver/routes.js instead of drifting.

function apiKeys() { return shareData && shareData.ApiKeys; }
function users() { return shareData && shareData.Users; }
function appData() { return (shareData && shareData.appData) || {}; }


// Extract a presented API key from the request (either the `api-key` header or an
// `Authorization: Bearer <key>`). Single exit.
function keyFromRequest(req) {
	let key = null;
	if (req && req.headers) {
		if (req.headers['api-key']) { key = req.headers['api-key']; }
		else {
			const auth = req.headers['authorization'] || '';
			if (/^Bearer\s+/i.test(auth)) { key = auth.replace(/^Bearer\s+/i, '').trim(); }
		}
	}
	return key;
}

// Resolve the client's source IP, honoring `security.trust_proxy`. By default SymBot trusts the
// proxy forwarding headers (cf-connecting-ip / x-forwarded-for) so it sees the real client behind
// NGINX / Apache / Cloudflare — the standard deployment. A deployment reachable DIRECTLY (no
// trusted proxy) can set `security.trust_proxy: false` so those client-supplied headers are IGNORED
// and the real socket address is used — otherwise an attacker could spoof x-forwarded-for to dodge
// the IP allow/deny filters and the login throttle. This mirrors Common.getClientIp so every
// enforcement point (server-wide filter, per-key filter, login, WebSocket, webhook) agrees.
function clientIp(req) {
	// Delegate to the ONE canonical resolver (Common.getClientIp) so every enforcement point sees
	// the identical, normalized IP. The local computation below is only a fallback for the brief
	// window before Common is wired; in normal request handling Common is always available.
	const common = shareData && shareData.Common;
	if (common && typeof common.getClientIp === 'function') { return common.getClientIp(req); }

	if (!req || !req.headers) { return (req && req.ip) || ''; }
	const app = appData();
	const trustProxy = !(app && app.security && app.security.trust_proxy === false);
	const socketIp = req.ip || (req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress) || '';
	let raw = (
		(trustProxy ? (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) : '') || socketIp || ''
	).split(',')[0].trim();
	let ip = raw.startsWith('::ffff:') ? raw.substring(7) : raw;
	if (ip === '::1') { ip = '127.0.0.1'; }   // IPv6 loopback → IPv4 loopback, consistent with getClientIp
	return ip;
}


// Resolve a request to an Authz principal (or null). Order: API key → session user →
// legacy loggedIn session (implicit owner). Never throws. Single exit.
async function resolvePrincipal(req) {
	let principal = null;

	// 1. API key — only when the API is enabled (matches the existing gate).
	const key = keyFromRequest(req);

	if (key && appData().api_enabled && apiKeys() && typeof apiKeys().resolve === 'function') {

		try { principal = await apiKeys().resolve(key, { ip: clientIp(req) }); }
		catch (e) { principal = null; }
	}

	// Legacy single API key (pbkdf2-hashed in app config, pre-multi-key). Its plaintext is not
	// recoverable, so it can't be migrated into a hashed api_keys row — instead it keeps
	// working via the existing validator and resolves to the implicit OWNER, so an existing
	// install/integration never breaks on upgrade.
	if (!principal && key && appData().api_enabled && shareData && shareData.Common && typeof shareData.Common.validateApiKey === 'function') {

		try { if (await shareData.Common.validateApiKey(key)) { principal = Authz.ownerPrincipal('legacy-api-key'); } }
		catch (e) { /* ignore — fall through */ }
	}

	// 1c. Legacy shared webhook api-token → a scoped principal (Authz.webhookPrincipal). Resolving it
	// HERE means it flows through the same capability enforcement as every other credential instead of
	// bypassing it (previously it authenticated but produced no principal, so the capability middleware
	// never ran for it). Its scope matches exactly what it can reach today. New setups should use a
	// scoped API key instead.
	if (!principal && appData().webhook_enabled && appData().api_token) {

		const token = req && req.headers && req.headers['api-token'];
		if (token && shareData.Common.safeEqual(token, appData().api_token)) { principal = Authz.webhookPrincipal(); }
	}

	// 2. Session — a real user record, else the implicit owner for a legacy loggedIn session.
	if (!principal && req && req.session) {

		if (req.session.userId && users() && typeof users().getById === 'function') {

			try {
				const u = await users().getById(req.session.userId);
				if (u && u.status === 'active') { principal = users().toPrincipal(u); }
			}
			catch (e) { principal = null; }
		}

		// Fall back to the implicit owner ONLY for a legacy session that carries no userId. If a
		// userId IS present but did not resolve to an ACTIVE user above (disabled/demoted/deleted),
		// deny — never silently upgrade a de-provisioned user back to owner.
		if (!principal && req.session.loggedIn && !req.session.userId) { principal = Authz.ownerPrincipal(); }
	}

	return principal;
}


// Express middleware: attach req.principal to every request (never rejects — guards decide).
function attachPrincipal() {
	return async (req, res, next) => {
		try { req.principal = await resolvePrincipal(req); }
		catch (e) { req.principal = null; }
		next();
	};
}


// Whether the client wants a JSON error (API/XHR) vs an HTML redirect (browser). Single exit.
function wantsJson(req) {
	const accept = (req && req.headers && req.headers['accept']) || '';
	const xrw = (req && req.headers && req.headers['x-requested-with']) || '';
	const path = (req && req.path) || '';
	return path.indexOf('/api/') >= 0 || /json/i.test(accept) || /xmlhttprequest/i.test(xrw) || !!keyFromRequest(req);
}

// Deny: 401 (unauthenticated) or 403 (authenticated but lacks the capability). JSON for
// API/XHR, redirect to /login for a browser. Single exit.
function deny(req, res) {
	const authed = !!(req && req.principal);
	if (wantsJson(req)) { res.status(authed ? 403 : 401).json({ success: false, error: authed ? 'Forbidden — missing permission' : 'Unauthorized' }); }
	else { res.redirect('/login'); }
}

// Guard: require a specific capability. `resourceIdFn(req)` optionally supplies the resource
// id for per-resource scoping. Single exit per call.
function requireCap(capability, resourceIdFn) {
	return (req, res, next) => {
		const resourceId = (typeof resourceIdFn === 'function') ? resourceIdFn(req) : undefined;
		if (req.principal && Authz.can(req.principal, capability, resourceId)) { next(); }
		else { deny(req, res); }
	};
}

// Guard: require any authenticated principal (used where a specific capability isn't mapped
// yet — preserves today's "authenticated = allowed" behavior during migration).
function requireAuth(req, res, next) {
	if (req && req.principal) { next(); }
	else { deny(req, res); }
}

// Boolean check for inline use in a handler (returns true/false, does not respond).
function can(req, capability, resourceId) {
	return !!(req && req.principal && Authz.can(req.principal, capability, resourceId));
}


// ── Per-key rate limiting ─────────────────────────────────────────────────────
// A scoped API key may carry a `rate_limit` (requests per minute). This enforces it with a simple
// fixed-window-per-minute counter keyed by the key id, returns 429 + Retry-After when exceeded,
// and emits X-RateLimit-* headers on every throttled key's response. Sessions, the owner, and the
// legacy key have no rateLimit on their principal, so they are never throttled. In-memory only —
// resets on restart, adds no storage.
const RATE_WINDOW_MS = 60000;
const rateWindows = new Map();   // apiKeyId -> { windowStart, count }

const _rateCleanup = setInterval(() => {
	const now = Date.now();
	for (const [ k, w ] of rateWindows) { if (now - w.windowStart >= RATE_WINDOW_MS * 2) { rateWindows.delete(k); } }
}, RATE_WINDOW_MS * 5);
if (_rateCleanup.unref) { _rateCleanup.unref(); }

function rateLimit(req, res, next) {

	const p = req.principal;
	const limit = p && p.rateLimit;

	if (!limit || !p.apiKeyId) { return next(); }   // only scoped keys that set a limit are throttled

	const now = Date.now();
	let w = rateWindows.get(p.apiKeyId);
	if (!w || now - w.windowStart >= RATE_WINDOW_MS) { w = { windowStart: now, count: 0 }; rateWindows.set(p.apiKeyId, w); }
	w.count++;

	const remaining = Math.max(0, limit - w.count);
	const resetSec = Math.max(1, Math.ceil((w.windowStart + RATE_WINDOW_MS - now) / 1000));

	res.set('X-RateLimit-Limit', String(limit));
	res.set('X-RateLimit-Remaining', String(remaining));
	res.set('X-RateLimit-Reset', String(resetSec));

	if (w.count > limit) {

		res.set('Retry-After', String(resetSec));

		if (wantsJson(req)) { return res.status(429).json({ success: false, error: 'Rate limit exceeded (' + limit + '/min)' }); }
		return res.status(429).send('Rate limit exceeded (' + limit + '/min). Retry after ' + resetSec + 's.');
	}

	next();
}


// ── System-control throttle ───────────────────────────────────────────────────
// rateLimit() above is a no-op for sessions/the owner (only scoped keys carry a rateLimit), yet
// the disruptive system-control endpoints (/system/restore, /system/update, /system/rollback,
// /system/shutdown) are reachable by any authenticated principal. This applies a small fixed
// per-minute cap to EVERY principal on those routes, keyed by apiKeyId/user id (falling back to
// client IP for the legacy/owner session), reusing the same fixed-window mechanics as rateLimit().
const SYSTEM_CONTROL_LIMIT = 5;   // requests/min per identity for system-control endpoints
const systemControlWindows = new Map();

function systemControlLimit(req, res, next) {

	const p = req.principal;
	const id = (p && (p.apiKeyId || p.id)) || clientIp(req);

	const now = Date.now();
	let w = systemControlWindows.get(id);
	if (!w || now - w.windowStart >= RATE_WINDOW_MS) { w = { windowStart: now, count: 0 }; systemControlWindows.set(id, w); }
	w.count++;

	if (w.count > SYSTEM_CONTROL_LIMIT) {

		const resetSec = Math.max(1, Math.ceil((w.windowStart + RATE_WINDOW_MS - now) / 1000));
		res.set('Retry-After', String(resetSec));

		if (wantsJson(req)) { return res.status(429).json({ success: false, error: 'Rate limit exceeded (' + SYSTEM_CONTROL_LIMIT + '/min)' }); }
		return res.status(429).send('Rate limit exceeded (' + SYSTEM_CONTROL_LIMIT + '/min).');
	}

	next();
}


module.exports = {
	init: function (obj) { shareData = obj; },
	keyFromRequest,
	clientIp,
	resolvePrincipal,
	attachPrincipal,
	wantsJson,
	requireCap,
	requireAuth,
	rateLimit,
	systemControlLimit,
	can
};