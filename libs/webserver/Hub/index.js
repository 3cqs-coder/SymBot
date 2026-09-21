'use strict';

const path = require('path');

const pathRoot = path.resolve(__dirname, ...Array(1).fill('..'));

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bodyParser = require('body-parser');
const Routes = require(pathRoot + '/Hub/routes.js');
const { sendErr } = require(pathRoot + '/routeUtils.js');
const SharedMw = require(pathRoot + '/sharedMiddleware.js');   // bootstrap middleware shared with the instance
const SharedSocket = require(pathRoot + '/sharedSocket.js');   // socket.io bootstrap shared with the instance
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
	const resolveInlineGuard = SharedMw.makeInlineGuardResolver(shareData, router);

	const sessionExpireMins = 60 * 24;
	const sessionCookieName = 'SymBotHub';

	const hashPassword = crypto.createHash('sha256').update(shareData.appData.password).digest('hex');

	const sessionStore = new FileStore({
		'path': shareData.appData.path_root + '/sessions',
		'ttl': sessionExpireMins * 60,
		'reapInterval': sessionExpireMins * 60,
		'reapAsync': true,
		'logFn': function() {}
	});

	// Expose the store so the session-management feature (libs/app/Sessions.js) can list and revoke sessions.
	shareData.sessionStore = sessionStore;

	// Opt-in hardened cookie for TLS deployments (security.secure_cookie in the Hub config) — same behavior and
	// default as the instance web server (off by default so a plain-HTTP install still receives the cookie).
	const secureCookie = !!(shareData.appData && shareData.appData.security && shareData.appData.security.secure_cookie);

	const sessionMiddleware = session({

		'secret': hashPassword,
		'name': sessionCookieName,
		'resave': false,
		'saveUninitialized': false,
		'rolling': true,
		'store': sessionStore,
		'cookie': {
			'maxAge': (sessionExpireMins * 60) * 1000,
			'sameSite': secureCookie ? 'strict' : 'lax',
			'secure': secureCookie
		}
	});

	// Server-wide IP allow/deny for the Hub — runs before the instance proxy and everything else.
	// Opt-in via the Hub config ip_filter.server.enabled. Loopback is ALWAYS allowed and the check
	// fails OPEN on error, so a filter mistake can never lock the operator out of the Hub. The
	// console `reset ipfilter` command clears it.
	app.use(SharedMw.ipFilter(shareData));

	// Reverse proxy to a managed instance's own web server. This is DELIBERATELY unauthenticated at the Hub
	// layer (it sits ahead of the Hub session/principal/capability middleware and carries no cap() guard):
	// each instance authenticates the forwarded request against its OWN separate session store and enforces its
	// own login and capabilities, so a Hub cookie is not a valid instance session. Only the server-wide IP
	// filter precedes it. Do NOT ever share a session store or signing secret across the Hub and instances —
	// that would turn this delegated-auth boundary into a cross-privilege hole.
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

	app.disable('x-powered-by');

	// Baseline security headers (parity with the instance webserver), set BEFORE the static handlers so
	// assets receive them too: prevent framing/clickjacking of the Hub control plane, MIME-sniffing, and
	// referrer leakage. Script-safe (no script-src CSP). Placed after the /instance proxy so proxied instance
	// responses keep their own headers.
	app.use(SharedMw.securityHeaders({ serverHeader: 'SymBot Hub' }));

	// Static assets are PUBLIC and served BEFORE the session middleware (shared helper — same rationale and
	// cache policy as the instance webserver, so the two can never drift).
	SharedMw.mountStaticAssets(app, express, pathRoot + '/public');

	app.use(sessionMiddleware);

	// Keep each logged-in session's recorded source IP and device current (shared with the instance).
	app.use(SharedMw.noteRequestMeta(shareData));

	// Default (~100 KB) body limits are deliberate on the Hub — it takes only small control-plane payloads,
	// so it needs no large-body allowance. One JSON parser (the redundant second bodyParser.json() was dropped).
	app.use(express.json());

	app.use(bodyParser.urlencoded({
		extended: true
	}));

	// Strip MongoDB operator keys from all user input (shared with the instance — closes NoSQL operator
	// injection on the Hub control plane too).
	app.use(SharedMw.stripMongoOperators(shareData));

	app.set('views', pathRoot + '/public/views');
	app.set('view engine', 'ejs');

	// Resolve whoever authenticated (Hub session OR Hub API key) into one req.principal (shared with the instance).
	app.use(SharedMw.attachPrincipal(shareData));

	// Per-key rate limiting (see AuthMiddleware.rateLimit) — no-op for sessions / unlimited keys.
	app.use((req, res, next) => {
		if (shareData.AuthMiddleware && typeof shareData.AuthMiddleware.rateLimit === 'function') { return shareData.AuthMiddleware.rateLimit(req, res, next); }
		next();
	});

	// Capability enforcement for state-changing routes — shared verbatim with the instance web server so route
	// gating behaves the SAME on the Hub (see sharedMiddleware.capabilityEnforcement and SharedMiddleware.test.js).
	app.use(SharedMw.capabilityEnforcement(shareData, { resolveInlineGuard, sendErr }));

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

	socket = SharedSocket.makeServer(server, shareData, sessionMiddleware);

	socket.on('connect', async (client) => {

		let query = client.handshake.query;

		// Resolve the principal from the handshake and attach it, flagging a deprovisioned session so it
		// cannot be admitted. Shared with the instance (see sharedSocket.js).
		const ip = (shareData.Common && typeof shareData.Common.getClientIp === 'function') ? shareData.Common.getClientIp(client) : '';
		const { deprovisioned, sess } = await SharedSocket.resolveConnection(client, shareData, ip);

		let loggedIn = !deprovisioned && sess.loggedIn;

		if (!loggedIn) {

			client.emit('error', 'Unauthorized');
			client.disconnect();
		}
		else {

			SharedSocket.joinInitialRoom(client, query);

			client.on('joinRooms', (data) => {

				// Parse via the shared helper so this stays in lockstep with the instance handler and a bad
				// client emit can't throw inside the listener.
				const roomList = SharedSocket.normalizeRooms(data);

				if (!roomList.length) { return; }

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

			SharedSocket.attachLeaveRoom(client);

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


// Start the continuous, autonomous watchdog on the Hub: a verbose boot sweep plus a self-unref'd, quiet
// periodic sweep for the life of the process. Non-blocking — mirrors the instance web server exactly. The
// monitor lives in the Watchdog engine; this only supplies the Hub's router + label as an opaque context.
function startWatchdogMonitor(label) {

	return shareData.Watchdog.startMonitor(shareData, { router: router, label: label || 'hub' });
}


module.exports = {

	app,
	start,
	startWatchdogMonitor,
	getSocket,
	clearProxyCache,

	init: function(obj) {

		shareData = obj;
		Routes.init(shareData);
	}
}