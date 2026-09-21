'use strict';


// Express middleware that MUST behave identically on the instance web server (libs/webserver/index.js) and the
// Hub web server (libs/webserver/Hub/index.js). Both bootstraps used to carry their own copies, and the Hub's
// own comments said the capability enforcement "behaves the SAME on the Hub" — a comment-enforced invariant.
// Registering the same factory functions from both bootstraps makes that invariant CODE-enforced, so the two
// authorization pipelines can never drift.
//
// These sit on the request-authorization path (the webhook path that fires trades authenticates through the
// same principal resolution + capability enforcement), so the logic here is copied verbatim from the proven
// instance implementation and is covered by libs/test/webserver/SharedMiddleware.test.js. Each function is a
// FACTORY: it takes the per-surface pieces it needs and returns the (req, res, next) middleware. Nothing here
// touches the trading loop directly.


const IpFilter = require(__dirname + '/../app/IpFilter.js');   // shared IP firewall engine (also used elsewhere)


// State-changing HTTP methods — used by the capability middleware's default-deny for unmapped routes.
const MUTATING_METHOD = { POST: true, PUT: true, PATCH: true, DELETE: true };


// Server-level IP firewall. Opt-in via appData.ip_filter.server.enabled. Loopback is ALWAYS allowed so local/
// console access can never be locked out, and the check fails OPEN on any error so a filter bug can never brick
// the server. The console `reset ipfilter` command and the reverse-proxy / OS firewall remain escape hatches.
function ipFilter(shareData) {
	return (req, res, next) => {
		try {
			const cfg = shareData.appData && shareData.appData.ip_filter && shareData.appData.ip_filter.server;
			if (cfg && cfg.enabled) {
				const ip = (shareData.AuthMiddleware && typeof shareData.AuthMiddleware.clientIp === 'function') ? shareData.AuthMiddleware.clientIp(req) : (req.ip || '');
				const decision = IpFilter.evaluate(ip, { allow: cfg.allowlist || [], deny: cfg.blocklist || [] }, { allowLoopback: true });
				if (!decision.allowed) { return res.status(403).send('Access denied.'); }
			}
		}
		catch (e) { /* fail open — never lock out on a filter error */ }
		next();
	};
}


// Keep each logged-in session's recorded source IP and device current (e.g. a phone moving from Wi-Fi to mobile
// data, or a browser update), so the Sessions view reflects where it is used now. Best-effort; writes only on a
// real change.
function noteRequestMeta(shareData) {
	return (req, res, next) => {
		if (shareData.Sessions && typeof shareData.Sessions.noteRequestMeta === 'function') { shareData.Sessions.noteRequestMeta(req); }
		next();
	};
}


// Strip MongoDB operator keys ($ne/$gt/$regex/…) from all user input before any handler builds a query, closing
// NoSQL operator injection globally at the boundary. Best-effort: never blocks the request.
function stripMongoOperators(shareData) {
	return (req, res, next) => {
		try {
			shareData.Common.stripMongoOperators(req.body);
			shareData.Common.stripMongoOperators(req.query);
			shareData.Common.stripMongoOperators(req.params);
		}
		catch (e) { /* sanitization is defensive — never fail a request over it */ }
		next();
	};
}


// Authorization: normalize whoever authenticated (API key OR session) into ONE req.principal for the route
// guards. Fully non-breaking — a legacy loggedIn session becomes the implicit owner, and if the auth subsystem
// isn't wired the request simply proceeds with no principal (existing gates still apply). A named-user session
// whose user no longer resolves to an ACTIVE user yields a NULL principal ON PURPOSE (see capabilityEnforcement).
function attachPrincipal(shareData) {
	return async (req, res, next) => {
		try {
			if (shareData && shareData.AuthMiddleware && typeof shareData.AuthMiddleware.resolvePrincipal === 'function') {
				req.principal = await shareData.AuthMiddleware.resolvePrincipal(req);
			}
		}
		catch (e) { req.principal = null; }
		next();
	};
}


// Runtime matcher for routes gated by an inline cap()/capAction() guard. Built LAZILY and memoised on first use:
// the routes are attached to `router` by Routes.start() which runs AFTER the bootstrap, so building it eagerly
// would see an empty stack. By the time any request arrives the routes are registered. The capability
// default-deny consults this so an inline-gated route is passed to its own guard rather than blanket-denied
// (which would wrongly lock out non-owner admins and scoped keys). Returns the resolver function.
function makeInlineGuardResolver(shareData, router) {
	let inlineGuarded = null;
	return () => {
		if (inlineGuarded === null) {
			try {
				const RP = shareData && shareData.RoutePermissions;
				inlineGuarded = (RP && typeof RP.buildInlineGuardMatcher === 'function')
					? RP.buildInlineGuardMatcher(router)
					: function () { return false; };
			}
			catch (e) { inlineGuarded = function () { return false; }; }
		}
		return inlineGuarded;
	};
}


// Capability enforcement for state-changing routes (the declarative map in RoutePermissions). Only a request
// whose resolved principal LACKS the mapped capability is denied — an unauthenticated request is left to the
// route's own gate, an unmapped route is untouched, and the owner / legacy key (['*']) always pass. So a scoped
// read-only key is blocked from money/write routes while the single operator is unaffected. deps: the
// resolveInlineGuard from makeInlineGuardResolver (bound to this surface's router) and the shared sendErr.
function capabilityEnforcement(shareData, deps) {

	const resolveInlineGuard = deps.resolveInlineGuard;
	const sendErr = deps.sendErr;

	return (req, res, next) => {
		let capability = null;
		try {
			const RP = shareData && shareData.RoutePermissions;

			// De-provisioned-session guard. A named-user session whose userId no longer resolves to an ACTIVE
			// user (disabled / demoted / deleted) yields a NULL principal — attachPrincipal deliberately does NOT
			// fall back to owner for it. Route handlers authorize on req.session.loggedIn alone, so without this a
			// de-provisioned user would keep access until session expiry. Deny (401). Not destroying the session,
			// so a transient user-store hiccup just 401s this one request and recovers on the next.
			if (req.session && req.session.loggedIn && req.session.userId && !req.principal) {

				try { shareData.Common.auditEvent(req, 'authz.deny', req.path, 'session-user-not-active'); } catch (e) {}
				return sendErr(res, 'Your account is no longer active — please sign in again.', 401);
			}

			capability = RP && typeof RP.required === 'function' ? RP.required(req.method, req.path) : null;

			if (capability && req.principal && shareData.Authz && !shareData.Authz.can(req.principal, capability)) {

				shareData.Common.auditEvent(req, 'authz.deny', req.path, capability);
				return sendErr(res, 'Forbidden — missing permission (' + capability + ')', 403);
			}

			// Default-deny for UNMAPPED mutating routes. A scoped (non-full-access) principal cannot reach a
			// POST/PUT/PATCH/DELETE that has no gate — so a new write route a developer forgets to map fails
			// closed for API keys instead of being silently exposed. BUT a route gated by an inline cap()/
			// capAction() guard is not in RULES either, and required() can't see it; letting those through to
			// their own guard is essential, or a non-owner admin or a scoped key would be wrongly blanket-denied.
			// So only a route with NEITHER a RULES rule NOR an inline guard is a genuinely-forgotten gate and
			// fails closed here. A PUBLIC route (login/logout/webhook) does its own auth in-handler — the webhook
			// path resolves a header token into a non-'*' principal, which would otherwise trip this. The owner /
			// legacy key (['*']) always passes. (auditCoverage still flags a truly ungated route at boot.)
			else if (!capability && req.principal && MUTATING_METHOD[req.method]
				&& !(Array.isArray(req.principal.capabilities) && req.principal.capabilities.includes('*'))
				&& !(RP && typeof RP.isPublic === 'function' && RP.isPublic(req.method, req.path))
				&& !resolveInlineGuard()(req.method, req.path)) {

				shareData.Common.auditEvent(req, 'authz.deny', req.path, 'unmapped:' + req.method);
				return sendErr(res, 'Forbidden — this key is not permitted for this route', 403);
			}
		}
		catch (e) {
			// Fail CLOSED: if the enforcement check itself errors on a MAPPED (capability-required) route that
			// carries a resolved principal, deny rather than let a scoped principal reach a money/write route
			// unchecked. An unmapped route or an unauthenticated request is left to the route's own gate.
			if (capability && req.principal) {
				return sendErr(res, 'Forbidden — enforcement error', 403);
			}
		}
		next();
	};
}


// Baseline security response headers, identical on the instance and Hub control planes so a hardening change
// (a stricter CSP, an added header) can never land on one surface and lag on the other. These stop the trading
// UI / Hub control plane from being framed (clickjacking a "panic sell" or "start deal" click —
// `frame-ancestors 'none'` is the modern, script-safe X-Frame-Options equivalent), stop MIME-sniffing, and
// keep the referrer off cross-origin navigations. A script-src CSP is intentionally NOT set — the authenticated
// UI relies on inline scripts. Set BEFORE the static handlers so assets receive them too. opts.serverHeader,
// when provided, is appended as the Server header (the Hub advertises itself; the instance passes nothing).
function securityHeaders(opts) {
	const serverHeader = opts && opts.serverHeader;
	return (req, res, next) => {
		res.set('X-Frame-Options', 'DENY');
		res.set('Content-Security-Policy', "frame-ancestors 'none'");
		res.set('X-Content-Type-Options', 'nosniff');
		res.set('Referrer-Policy', 'no-referrer');
		if (serverHeader) { res.append('Server', serverHeader); }
		next();
	};
}


// Mount the PUBLIC static-asset tree with one cache policy shared by both web servers, so the asset list and
// the immutable/maxAge policy are a single maintenance unit (add a dir or change caching once, not twice). The
// vendored libraries are long-cached and immutable; app JS/CSS/data/images get a short revalidated cache (the
// ETag still yields a 304 when unchanged). Mounted BEFORE the session middleware on purpose: the browser sends
// the session cookie on same-origin asset requests, so behind express-session every vendored file on a page
// load would trigger a session-store read (and, with rolling sessions, a touch write) for files that need no
// session at all — and assets stay available even during a DB pause. `publicDir` is the surface's own public
// root (the instance and Hub differ only in that base path).
function mountStaticAssets(app, express, publicDir) {
	const vendorCache = { maxAge: '30d', immutable: true };
	const appAssetCache = { maxAge: '1h' };
	const staticFor = (dir) => express.static(dir, appAssetCache);
	app.use('/js/vendor', express.static(publicDir + '/js/vendor', vendorCache));
	app.use('/css/vendor', express.static(publicDir + '/css/vendor', vendorCache));
	app.use('/js', staticFor(publicDir + '/js'));
	app.use('/css', staticFor(publicDir + '/css'));
	app.use('/data', staticFor(publicDir + '/data'));
	app.use('/images', staticFor(publicDir + '/images'));
}


module.exports = { MUTATING_METHOD, ipFilter, noteRequestMeta, stripMongoOperators, attachPrincipal, makeInlineGuardResolver, capabilityEnforcement, securityHeaders, mountStaticAssets };
