'use strict';

const path = require('path');

const pathRoot = path.resolve(__dirname, ...Array(1).fill('..'));

// State-changing HTTP methods — used by the capability middleware's default-deny for unmapped routes.
const MUTATING_METHOD = { POST: true, PUT: true, PATCH: true, DELETE: true };

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bodyParser = require('body-parser');
const Routes = require(pathRoot + '/Hub/routes.js');
const { sendErr } = require(pathRoot + '/routeUtils.js');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const router = express.Router();

const httpProxyMap = new Map();
const wsProxyMap = new Map();

let socket;
let shareData;



async function initApp() {

	// Matcher for inline cap()/capAction()-gated Hub routes, built LAZILY on first use (routes are
	// attached to `router` by Routes.start() which runs AFTER this function). The default-deny
	// consults it so a correctly-scoped Hub key or a non-owner Hub user reaches those guards instead
	// of being blanket-denied.
	let inlineGuarded = null;

	const resolveInlineGuard = () => {
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

	const sessionExpireMins = 60 * 24;
	const sessionCookieName = 'SymBotHub';

	const hashPassword = crypto.createHash('sha256').update(shareData.appData.password).digest('hex');

	const sessionMiddleware = session({

		'secret': hashPassword,
		'name': sessionCookieName,
		'resave': false,
		'saveUninitialized': false,
		'rolling': true,
		'store': new FileStore({
			'path': shareData.appData.path_root + '/sessions',
			'ttl': sessionExpireMins * 60,
			'reapInterval': sessionExpireMins * 60,
			'reapAsync': true,
			'logFn': function() {}
		}),
		'cookie': {
			'maxAge': (sessionExpireMins * 60) * 1000,
			'sameSite': 'lax'
		}
	});

	// Server-wide IP allow/deny for the Hub — runs before the instance proxy and everything else.
	// Opt-in via the Hub config ip_filter.server.enabled. Loopback is ALWAYS allowed and the check
	// fails OPEN on error, so a filter mistake can never lock the operator out of the Hub. The
	// console `reset ipfilter` command clears it.
	const IpFilter = require(pathRoot + '/../app/IpFilter.js');

	app.use((req, res, next) => {
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
	});

	// Middleware to handle incoming requests
	app.use('/instance/:appId', async (req, res, next) => {

		const { appId } = req.params;

		const proxy = await getHttpProxy(appId);

		if (!proxy) {

			const msg = `No matching port found for appId: ${appId}`;
			
			shareData.Hub.logger('error', msg);
			
			return res.status(500).send(msg);
		}

		return proxy(req, res, next);
	});

	app.use(sessionMiddleware);

	app.disable('x-powered-by');

	app.use((req, res, next) => {

		res.append('Server', 'SymBot Hub');
		next();
	});

	app.use(express.json());

	app.use(bodyParser.urlencoded({
		extended: true
	}));

	app.use(bodyParser.json());

	// Strip MongoDB operator keys from all user input before any handler runs (see the instance webserver
	// for the rationale) — closes NoSQL operator injection on the Hub control plane too. Best-effort.
	app.use((req, res, next) => {

		try {

			shareData.Common.stripMongoOperators(req.body);
			shareData.Common.stripMongoOperators(req.query);
			shareData.Common.stripMongoOperators(req.params);
		}
		catch (e) { /* defensive — never fail a request */ }

		next();
	});

	app.set('views', pathRoot + '/public/views');
	app.set('view engine', 'ejs');

	app.use('/js', express.static(pathRoot + '/public/js'));
	app.use('/css', express.static(pathRoot + '/public/css'));
	app.use('/data', express.static(pathRoot + '/public/data'));
	app.use('/images', express.static(pathRoot + '/public/images'));

	// Authorization: resolve whoever authenticated (Hub session OR a Hub API key, via
	// HubStore) into one req.principal for the route guards — a logged-in session becomes the
	// implicit owner. Non-breaking: if the auth subsystem isn't wired the request proceeds and
	// the existing session gate applies.
	app.use(async (req, res, next) => {
		try {
			if (shareData && shareData.AuthMiddleware && typeof shareData.AuthMiddleware.resolvePrincipal === 'function') {
				req.principal = await shareData.AuthMiddleware.resolvePrincipal(req);
			}
		}
		catch (e) { req.principal = null; }
		next();
	});

	// Per-key rate limiting (see AuthMiddleware.rateLimit) — no-op for sessions / unlimited keys.
	app.use((req, res, next) => {
		if (shareData.AuthMiddleware && typeof shareData.AuthMiddleware.rateLimit === 'function') { return shareData.AuthMiddleware.rateLimit(req, res, next); }
		next();
	});

	// Capability enforcement for state-changing routes — identical to the instance web server
	// (libs/webserver/index.js) so route gating behaves the SAME on the Hub. Without this the
	// declarative RoutePermissions.RULES map (and the startup watchdog's coverage guarantee) would
	// be decorative on the Hub. Only a request whose resolved principal LACKS the mapped capability
	// is denied; an unauthenticated request is left to the route's own gate, an unmapped route is
	// untouched, and the owner / legacy key (['*']) always pass.
	app.use((req, res, next) => {
		let capability = null;
		try {
			const RP = shareData && shareData.RoutePermissions;

			// De-provisioned-session guard (same as the instance server): a named-user session whose userId
			// no longer resolves to an ACTIVE user yields a null principal; deny it (401) so a disabled Hub
			// user can't keep reaching session-only Hub read routes until session expiry.
			if (req.session && req.session.loggedIn && req.session.userId && !req.principal) {

				try { shareData.Common.auditEvent(req, 'authz.deny', req.path, 'session-user-not-active'); } catch (e) {}
				return sendErr(res, 'Your account is no longer active — please sign in again.', 401);
			}

			capability = RP && typeof RP.required === 'function' ? RP.required(req.method, req.path) : null;

			if (capability && req.principal && shareData.Authz && !shareData.Authz.can(req.principal, capability)) {

				shareData.Common.auditEvent(req, 'authz.deny', req.path, capability);
				return sendErr(res, 'Forbidden — missing permission (' + capability + ')', 403);
			}

			// Default-deny for UNMAPPED mutating routes (see instance server for the rationale). On the
			// Hub EVERY action route is gated by an inline cap()/capAction() guard rather than RULES, so
			// the inline-guard check is what lets a correctly-scoped Hub key or a non-owner Hub user
			// reach those guards; only a route with neither a RULES rule nor an inline guard fails
			// closed here. Owner/legacy (['*']) always passes.
			else if (!capability && req.principal && MUTATING_METHOD[req.method]
				&& !(Array.isArray(req.principal.capabilities) && req.principal.capabilities.includes('*'))
				&& !(RP && typeof RP.isPublic === 'function' && RP.isPublic(req.method, req.path))
				&& !resolveInlineGuard()(req.method, req.path)) {

				// ...and NOT a PUBLIC route (login/logout/webhook) — those do their own auth in-handler.
				shareData.Common.auditEvent(req, 'authz.deny', req.path, 'unmapped:' + req.method);
				return sendErr(res, 'Forbidden — this key is not permitted for this route', 403);
			}
		}
		catch (e) {
			// Fail CLOSED on a mapped route that carries a resolved principal (see instance server).
			if (capability && req.principal) {
				return sendErr(res, 'Forbidden — enforcement error', 403);
			}
		}
		next();
	});

	app.use('/', router);

	return { sessionMiddleware };
}


async function getHttpProxy(appId) {

	if (httpProxyMap.has(appId)) {

		return httpProxyMap.get(appId);
	}

	const port = await getAppPort(appId);

	if (!port) return null;

	const targetUrl = `http://127.0.0.1:${port}`;
	const proxy = createBaseProxy(appId, targetUrl, false); // ws: false

	httpProxyMap.set(appId, proxy);

	return proxy;
}


async function getWsProxy(appId) {

	if (wsProxyMap.has(appId)) {

		return wsProxyMap.get(appId);
	}

	const port = await getAppPort(appId);

	if (!port) return null;

	const targetUrl = `http://127.0.0.1:${port}`;
	const proxy = createBaseProxy(appId, targetUrl, true); // ws: true

	wsProxyMap.set(appId, proxy);

	return proxy;
}


function clearProxyCache(appId) {

	// The proxy maps are keyed by the /instance/:appId URL param (a string). Callers may pass the port
	// as a number (from instance config), so clear both the value and its string form to be robust.
	const keys = (appId === null || appId === undefined) ? [] : [ appId, String(appId) ];

	for (const key of keys) {

		if (httpProxyMap.has(key)) { httpProxyMap.delete(key); }
		if (wsProxyMap.has(key)) { wsProxyMap.delete(key); }
	}
}


function createBaseProxy(appId, targetUrl, ws) {

	return createProxyMiddleware({
		target: targetUrl,
		changeOrigin: true,
		xfwd: true,
		ws,
		followRedirects: false,
		autoRewrite: true,
		hostRewrite: true,
		cookieDomainRewrite: true,
		// A proxied request may be a long, bounded AI deep-analysis on a slow local model. Without a
		// generous ceiling the proxy severs it mid-flight (the same "socket hang up" the instance's own
		// server timeout caused). This is a MAXIMUM, not a delay — fast requests still return at their
		// own speed; only the cutoff is raised, matching the per-request extension on the instance side.
		proxyTimeout: 6 * 60 * 1000,
		timeout:      6 * 60 * 1000,
		pathRewrite: (path) => path.replace(`/instance/${appId}`, ''),
		on: {
			proxyReq: (proxyReq, req) => {

				// Prevent MaxListenersExceededWarning on reused keep-alive sockets.
				if (req.socket) {

					req.socket.setMaxListeners(0);
				}

				if (req.headers.cookie) {

					proxyReq.setHeader('Cookie', req.headers.cookie);
				}

				// OVERWRITE the client-IP forwarding headers toward the instance with the IP the HUB
				// authoritatively resolved. The underlying proxy only sets x-forwarded-for when it is ABSENT,
				// so a caller-supplied header would otherwise pass straight through and let an attacker spoof
				// the instance's per-IP login throttle / allowlists. clientIp() honors the Hub's own
				// trust_proxy (real client behind a proxy; socket address on a direct-exposed Hub with
				// trust_proxy:false). Also drop any caller-supplied cf-connecting-ip — the Hub is not
				// Cloudflare, and the instance consults that header BEFORE x-forwarded-for, so leaving it would
				// bypass the overwrite. Best-effort: never break the proxy on a header operation.
				try {

					const am = shareData && shareData.AuthMiddleware;
					const clientIp = (am && typeof am.clientIp === 'function') ? am.clientIp(req) : '';

					if (clientIp) {

						proxyReq.setHeader('x-forwarded-for', clientIp);
						proxyReq.removeHeader('cf-connecting-ip');
					}
				}
				catch (e) { /* best-effort — a header set must never break the proxy */ }
			},
			proxyRes: (proxyRes, req, res) => {

				// Re-root an instance redirect under this instance path and answer it directly with
				// res.redirect(). Ending the response HERE is deliberate: it makes the proxy skip its
				// built-in outgoing Location-rewrite passes, which (with hostRewrite enabled) would
				// otherwise rewrite the redirect host to a wrong value. The proxy then tries to pipe the
				// original body into the ended response, surfacing a harmless ERR_HTTP_HEADERS_SENT that
				// the error handler below intentionally ignores.
				if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {

					// Reduce to the path (+query/hash) so a relative path OR an absolute URL from the instance
					// re-roots correctly; any leading host is dropped.
					let pathPart = proxyRes.headers.location;
					try { const u = new URL(pathPart); pathPart = u.pathname + u.search + u.hash; } catch (e) {}

					if (pathPart.charAt(0) !== "/") { pathPart = "/" + pathPart; }

					const target = (pathPart.indexOf(`/instance/${appId}`) === 0) ? pathPart : `/instance/${appId}${pathPart}`;

					return res.redirect(proxyRes.statusCode, target);
				}
			},
			error: (err, req, res) => {

				// A 3xx we already answered via res.redirect() above leaves the proxy piping the original
				// body into an ended response — a benign ERR_HTTP_HEADERS_SENT. The redirect already reached
				// the client, so do not log it as an error.
				if ((res && res.headersSent) || (err && err.code === "ERR_HTTP_HEADERS_SENT")) { return; }

				const msg = 'Proxy Error: ' + err.message;
				shareData.Hub.logger('error', msg);

				try {

					if (res && !res.headersSent) {

						res.status(500).send(msg);
					}
				}
				catch(e) {}
			}
		}
	});
}


async function getAppPort(appId) {

	const ports = shareData.appData['web_server_ports'];

	for (let port of ports) {

		if (port == appId) {

			return port;
		}
	}

	return undefined;
}


async function initSocket(sessionMiddleware, server) {

	socket = require('socket.io')(server, {

		cors: {
			origin: '*',
			methods: ['PUT', 'GET', 'POST', 'DELETE', 'OPTIONS'],
			credentials: false
		},
		path: '/' + shareData.appData['web_socket_path'],
		serveClient: true,
		pingInterval: 10000,
		pingTimeout: 5000,
		maxHttpBufferSize: 1e6,
		cookie: false
	});

	const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);

	socket.use(wrap(sessionMiddleware));

	socket.use((client, next) => {

		return next();
	});

	socket.on('connect', async (client) => {

		let query = client.handshake.query;

		// Resolve the principal from the handshake and attach it, mirroring the HTTP layer. A session
		// whose user no longer resolves to an active principal (disabled or deleted after login) must NOT
		// be admitted on the socket, so a just-disabled user can't keep receiving instance/memory data
		// over an already-open socket. A legacy session with no userId still resolves to the owner
		// principal (non-null), so it is unaffected.
		let principal = null;

		try {
			if (shareData.AuthMiddleware && typeof shareData.AuthMiddleware.resolvePrincipal === 'function') {
				const ip = (shareData.Common && typeof shareData.Common.getClientIp === 'function') ? shareData.Common.getClientIp(client) : '';
				principal = await shareData.AuthMiddleware.resolvePrincipal({ session: client.request.session, headers: client.handshake.headers, ip });
			}
		}
		catch (e) { principal = null; }

		client.principal = principal;

		const sess = client.request.session || {};
		const deprovisioned = !!(sess.loggedIn && sess.userId && !principal);
		let loggedIn = !deprovisioned && sess.loggedIn;

		if (!loggedIn) {

			client.emit('error', 'Unauthorized');
			client.disconnect();
		}
		else {

			if (query.room == undefined || query.room == null || query.room == '') {

				//const roomAuth = 'notifications';

				//client.join(roomAuth);
			}
			else {

				client.join(query.room);
			}

			client.on('joinRooms', (data) => {

				// Guard against a missing/malformed payload so a bad client emit can't throw inside the
				// listener; normalize to an array (mirrors the instance server's joinRooms handler).
				const rooms = data && data.rooms;
				if (!rooms) { return; }

				const roomList = Array.isArray(rooms) ? rooms : [rooms];

				roomList.forEach(room => {

					client.join(room);
				});

				// If the client is joining the memory room, fire an immediate poll
				// so instance status and memory data appear right away rather than
				// waiting for the next scheduled interval to elapse
				if (roomList.includes('memory')) {

					shareData.Hub.logMemoryUsage();
				}
			});

			client.on('leaveRoom', (room) => {

				client.leave(room);
			});

			client.on('notifications_history', function(data) {

				//shareData.Common.getNotificationHistory(client, data);
			});
		}
	});
}


async function getSocket() {

	return socket;
}


async function start(port) {

	let isError;

	const { sessionMiddleware } = await initApp();

	let server = app.listen(port, () => {

		shareData.Hub.logger('info', `SymBot Hub running on port ${port}`);

	}).on('error', function(err) {

		isError = err;

		if (err.code === 'EADDRINUSE') {

			shareData.Hub.logger('error', `Port ${port} already in use`);

			process.exit(1);
		}
		else {

			shareData.Hub.logger('error', 'Web Server Error: ' + err);
		}
	});

	server.on('upgrade', async (req, socket, head) => {

		try {

			// Only proxy WS connections for /instance/*
			if (!req.url.startsWith('/instance/')) {
		
				return;
			}

			const segments = req.url.split('/');
			const appId = segments[2];

			if (!appId) {

				socket.destroy();
				return;
			}

			const proxy = await getWsProxy(appId);

			if (!proxy) {

				socket.destroy();
				return;
			}

			proxy.upgrade(req, socket, head);
		}
		catch (err) {

			shareData.Hub.logger('error', 'WS Upgrade Error: ' + err.message);
			socket.destroy();
		}
	});

	if (isError == undefined || isError == null) {

		await initSocket(sessionMiddleware, server);

		Routes.start(router);
	}
}


// Run the central self-policing watchdog against the Hub's registered routes. Called from the
// startup flow after the audit trail is wired so findings can be recorded to the audit log.
function runWatchdog(label) {

	if (shareData && shareData.Watchdog && typeof shareData.Watchdog.run === 'function') {

		// Fire-and-forget; run() never rejects (each check is isolated), but attach a defensive catch so
		// it can never surface as an unhandled rejection even if that contract ever changes — mirroring
		// the instance boot caller.
		return Promise.resolve(shareData.Watchdog.run(shareData, { router: router, label: label || 'hub' })).catch(function () {});
	}

	return Promise.resolve();
}


module.exports = {

	app,
	start,
	runWatchdog,
	getSocket,
	clearProxyCache,

	init: function(obj) {

		shareData = obj;
		Routes.init(shareData);
	}
}