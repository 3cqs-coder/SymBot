'use strict';

const path = require('path');

const pathRoot = path.resolve(__dirname, ...Array(1).fill('..'));

// State-changing HTTP methods — used by the capability middleware's default-deny for unmapped routes.
const MUTATING_METHOD = { POST: true, PUT: true, PATCH: true, DELETE: true };

const bodyParser = require('body-parser');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const MongoStore = require('connect-mongo').default;
const IpFilter = require(pathRoot + '/app/IpFilter.js');
const app = express();
const router = express.Router();
const Routes = require(pathRoot + '/webserver/routes.js');
const { sendErr } = require(pathRoot + '/webserver/routeUtils.js');

const serverTimeoutMins = 3;

let shareData;
let socket;



const shouldCompress = (req, res) => {

	if (req.headers['x-no-compression']) {

		return false;
	}

	return compression.filter(req, res);
}



function initApp() {

	// Runtime matcher for routes gated by an inline cap()/capAction() guard. Built LAZILY and
	// memoised on first use: the routes are attached to `router` by Routes.start() which runs AFTER
	// this function, so building it here (or right after app.use) would see an empty stack. By the
	// time any request arrives the server is already listening and the routes are registered. The
	// default-deny consults this so an inline-gated route is passed to its own guard rather than
	// being blanket-denied (which would wrongly lock out non-owner admins and scoped keys).
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
	const sessionCookieName = 'SymBot' + shareData.appData.instance_name;

	// A dedicated, persisted, high-entropy session-signing secret, kept SEPARATE from server_id (a
	// semi-public instance identifier that is also reused as the webhook-token salt). Generated once per
	// instance and reused across restarts (so sessions survive a restart), stored 0600 in the per-instance
	// sessions directory. Best-effort: any filesystem problem falls back to server_id so a session secret
	// can never block startup. On the first boot after this change existing sessions are invalidated (a
	// one-time re-login), which is the expected outcome of rotating a signing secret.
	let sessionSecret = shareData.appData.server_id;

	try {

		const fs = require('fs');
		const crypto = require('crypto');
		const secretDir  = path.join(pathRoot, '..', 'sessions');
		const secretFile = path.join(secretDir, 'session-secret-' + (shareData.appData.instance_name || 'default'));

		if (fs.existsSync(secretFile)) {

			const saved = String(fs.readFileSync(secretFile, 'utf8')).trim();
			if (saved) { sessionSecret = saved; }
		}
		else {

			const fresh = crypto.randomBytes(32).toString('hex');
			try { fs.mkdirSync(secretDir, { recursive: true }); } catch (e) {}
			fs.writeFileSync(secretFile, fresh, { mode: 0o600 });
			sessionSecret = fresh;
		}
	}
	catch (e) { /* keep the server_id fallback — a session secret must never block startup */ }

	let store;

	if (!shareData.appData.config_mode) {

		store = MongoStore.create({
			'mongoUrl': shareData.appData.mongo_db_url,
			'collectionName': 'sessions',
			'ttl': sessionExpireMins * 60,
			'autoRemove': 'native'
		});

		// With rolling sessions, express-session refreshes a session's expiry on every request by calling
		// the store's touch(). A session can expire (native TTL removal) or be cleared in the brief window
		// between when the request is read and when touch() runs, so connect-mongo finds nothing to update
		// and returns "Unable to find the session to touch". express-session forwards that as a request
		// error, which would otherwise log a stack trace and 500 that single request. A vanished session is
		// nothing to refresh — so treat that specific case as a no-op success. No security impact: a session
		// that no longer exists cannot be refreshed into existence; the visitor simply has no session and
		// logs in again (the correct outcome for an expired session). Web layer only — never trading.
		const touchOriginal = store.touch.bind(store);

		store.touch = function(sid, sess, callback) {

			return touchOriginal(sid, sess, function(err) {

				if (err && /find the session to touch/i.test(err.message || '')) {

					return callback(null);
				}

				return callback(err);
			});
		};
	}
	else {

		// Config mode (fresh install / no DB) signs its session with a cryptographically-random secret
		// instead of a low-entropy 'SymBot'+Math.random() value, so a session cookie cannot be forged to
		// reach the initial /config screen (where exchange keys and the owner password are set). Regenerated
		// per process start, which is fine for the transient setup phase.
		sessionSecret = require('crypto').randomBytes(32).toString('hex');

		const FileStore = require('session-file-store')(session);

		store = new FileStore({
			'path': path.join(pathRoot, '..', 'sessions'),
			'logFn': function() {}
		});
	}

	const sessionMiddleware = session({

		'secret': sessionSecret,
		'name': sessionCookieName,
		'resave': false,
		'saveUninitialized': false,
		'store': store,
		'rolling': true,
		'cookie': {
			'maxAge': sessionExpireMins * 60 * 1000,
			'sameSite': 'lax'
		}
	});

	app.disable('x-powered-by');

	// Server-wide IP allow/deny — the FIRST thing every request hits, before auth, session, and
	// static files (a built-in firewall). Opt-in via app.json ip_filter.server.enabled. Loopback is
	// ALWAYS allowed so local/console access can never be locked out, and the check fails OPEN on any
	// error so a filter bug can never brick the instance. The console `reset ipfilter` command and
	// the reverse-proxy / OS firewall remain as escape hatches.
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

	app.use(sessionMiddleware);

	// Compress all HTTP responses
	app.use(compression({

		filter: shouldCompress,
		level: 6,

	}));

	app.set('views', pathRoot + '/webserver/public/views');
	app.set('view engine', 'ejs');

	app.use('/js', express.static(pathRoot + '/webserver/public/js'));
	app.use('/css', express.static(pathRoot + '/webserver/public/css'));
	app.use('/data', express.static(pathRoot + '/webserver/public/data'));
	app.use('/images', express.static(pathRoot + '/webserver/public/images'));

	app.use(cookieParser());

	app.use((req, res, next) => {

		const allowedRoutes = ['/login', '/config'];

		const timeOut = (60 * 1000) * serverTimeoutMins;

		req.setTimeout((timeOut - (1000 * 5)));
		res.append('Server', shareData.appData.name + ' v' + shareData.appData.version);

		if (shareData.appData.config_mode && allowedRoutes.length > 0 && !allowedRoutes.includes(req.path)) {

			res.redirect('/login');

			return;
		}

		if (shareData.appData.database_error || shareData.appData.system_pause) {

			let obj = {
				'date': new Date(),
				'error': shareData.appData.database_error || shareData.appData.system_pause
			};
		
			res.status(503).send(obj);
		}
		else {

			next();
		}
	});

	const upload = multer({
		dest: 'uploads/',
		limits: { fileSize: 262144000 }
	});

	app.use(bodyParser.json({

		limit: "100mb",
		extended: true

	}));

	app.use(bodyParser.urlencoded({

		limit: "100mb",
		extended: true,
		parameterLimit: 500000

	}));

	// Strip MongoDB operator keys ($ne/$gt/$regex/…) from all user input before any handler builds a query,
	// closing NoSQL operator injection globally at the boundary. Best-effort: never blocks the request.
	app.use((req, res, next) => {

		try {

			shareData.Common.stripMongoOperators(req.body);
			shareData.Common.stripMongoOperators(req.query);
			shareData.Common.stripMongoOperators(req.params);
		}
		catch (e) { /* sanitization is defensive — never fail a request over it */ }

		next();
	});

	// Authorization: normalize whoever authenticated (API key OR session) into ONE
	// req.principal for the route guards. Resolved at request time and fully non-breaking —
	// a legacy loggedIn session becomes the implicit owner, and if the auth subsystem isn't
	// wired the request simply proceeds with no principal (existing gates still apply).
	app.use(async (req, res, next) => {
		try {
			if (shareData && shareData.AuthMiddleware && typeof shareData.AuthMiddleware.resolvePrincipal === 'function') {
				req.principal = await shareData.AuthMiddleware.resolvePrincipal(req);
			}
		}
		catch (e) { req.principal = null; }
		next();
	});

	// Per-key rate limiting: enforces a scoped key's optional requests/min limit (429 +
	// X-RateLimit-* headers). No-op for sessions, the owner, and keys with no limit set. The
	// disruptive, session-gated system-control endpoints below get a separate, small fixed
	// per-identity cap instead (defense-in-depth — see AuthMiddleware.systemControlLimit),
	// since the per-key limit above is a no-op for sessions/the owner. Enforced here ONLY —
	// do not duplicate this check at the route level, or the effective cap becomes inconsistent.
	const SYSTEM_CONTROL_PATHS = [ '/system/restore', '/system/update', '/system/rollback', '/system/shutdown' ];
	app.use((req, res, next) => {
		if (SYSTEM_CONTROL_PATHS.indexOf(req.path) !== -1 && shareData.AuthMiddleware && typeof shareData.AuthMiddleware.systemControlLimit === 'function') { return shareData.AuthMiddleware.systemControlLimit(req, res, next); }
		if (shareData.AuthMiddleware && typeof shareData.AuthMiddleware.rateLimit === 'function') { return shareData.AuthMiddleware.rateLimit(req, res, next); }
		next();
	});

	// Capability enforcement for state-changing routes (the declarative map in
	// RoutePermissions). Only a request whose resolved principal LACKS the mapped capability
	// is denied — an unauthenticated request is left to the route's own gate, an unmapped
	// route is untouched, and the owner / legacy key (['*']) always pass. So a scoped
	// read-only key is blocked from money/write routes while the single operator is unaffected.
	app.use((req, res, next) => {
		let capability = null;
		try {
			const RP = shareData && shareData.RoutePermissions;

			// De-provisioned-session guard. A named-user session whose userId no longer resolves to an ACTIVE
			// user (disabled / demoted / deleted) yields a NULL principal — attachPrincipal deliberately does
			// NOT fall back to owner for it. The capability checks below only act when a principal is present,
			// and route handlers authorize on req.session.loggedIn alone, so without this a de-provisioned user
			// would keep access until session expiry and a disabled viewer would even gain write access. Deny
			// (401) every such request. Not destroying the session, so a transient user-store hiccup just 401s
			// this one request and recovers on the next instead of force-logging-out an active user.
			if (req.session && req.session.loggedIn && req.session.userId && !req.principal) {

				try { shareData.Common.auditEvent(req, 'authz.deny', req.path, 'session-user-not-active'); } catch (e) {}
				return sendErr(res, 'Your account is no longer active — please sign in again.', 401);
			}

			capability = RP && typeof RP.required === 'function' ? RP.required(req.method, req.path) : null;

			if (capability && req.principal && shareData.Authz && !shareData.Authz.can(req.principal, capability)) {

				shareData.Common.auditEvent(req, 'authz.deny', req.path, capability);
				return sendErr(res, 'Forbidden — missing permission (' + capability + ')', 403);
			}

			// Default-deny for UNMAPPED mutating routes. A scoped (non-full-access) principal cannot
			// reach a POST/PUT/PATCH/DELETE that has no gate — so a new write route a developer forgets
			// to map fails closed for API keys instead of being silently exposed. BUT a route gated by
			// an inline cap()/capAction() guard is not in RULES either, and `required()` can't see it;
			// letting those through to their own guard is essential, otherwise a non-owner admin (key/
			// user management) or a scoped key (Hub actions) would be wrongly blanket-denied. So only a
			// route with NEITHER a RULES rule NOR an inline guard is a genuinely-forgotten gate and
			// fails closed here. The owner / legacy key (['*']) always passes. (auditCoverage still
			// flags a truly ungated route at boot.)
			else if (!capability && req.principal && MUTATING_METHOD[req.method]
				&& !(Array.isArray(req.principal.capabilities) && req.principal.capabilities.includes('*'))
				&& !(RP && typeof RP.isPublic === 'function' && RP.isPublic(req.method, req.path))
				&& !resolveInlineGuard()(req.method, req.path)) {

				// ...and NOT a PUBLIC route. A PUBLIC endpoint (login/logout/webhook) deliberately carries no
				// RULES capability and does its own auth inside the handler — the webhook path in particular
				// resolves a header api-token/scoped key into a non-'*' principal, which would otherwise trip
				// this default-deny and 403 the request before processWebHook's own gate ever runs.
				shareData.Common.auditEvent(req, 'authz.deny', req.path, 'unmapped:' + req.method);
				return sendErr(res, 'Forbidden — this key is not permitted for this route', 403);
			}
		}
		catch (e) {
			// Fail CLOSED: if the enforcement check itself errors on a MAPPED (capability-required)
			// route that carries a resolved principal, deny rather than let a scoped principal reach
			// a money/write route unchecked. An unmapped route or an unauthenticated request is left
			// to the route's own gate.
			if (capability && req.principal) {
				return sendErr(res, 'Forbidden — enforcement error', 403);
			}
		}
		next();
	});

	app.use('/', router);

	// Error handler — MUST be registered last (after the router) to catch errors thrown by route
	// handlers. Logs the stack and returns a clean 500 instead of hanging or leaking internals.
	app.use(function(err, req, res, next) {

		try { shareData.Common.logger('Web Server Error: ' + (err && err.stack ? err.stack : err)); } catch (e) {}

		if (res.headersSent) { return next(err); }

		sendErr(res, 'Internal server error', 500);
	});

	return { sessionMiddleware, upload };
}


function initSocket(sessionMiddleware, server) {

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

	// Tracks number of in-flight api_action requests per client.
	// Passed into routesWebSocket.api() so it can enforce the per-client
	// concurrency limit without shared module-level state.
	const inflightMap = new Map();

	socket.on('connect', async function (client) {

		let apiKey = client.handshake.headers['api-key'];
		let query = client.handshake.query;
		const ip = shareData.Common.getClientIp(client);

		// Resolve the principal from the handshake (session OR API key, including new scoped
		// keys) and attach it to the socket so WebSocket API calls carry the caller's
		// capabilities. Falls back to the legacy session/key check so nothing that worked
		// before breaks.
		let principal = null;

		try {
			if (shareData.AuthMiddleware && typeof shareData.AuthMiddleware.resolvePrincipal === 'function') {
				principal = await shareData.AuthMiddleware.resolvePrincipal({ session: client.request.session, headers: client.handshake.headers, ip });
			}
		}
		catch (e) { principal = null; }

		client.principal = principal;

		// A session whose user no longer resolves to an active principal (disabled or deleted after
		// login) must NOT be admitted on the socket — the HTTP layer already 401s these same users on
		// every request, and without this a just-disabled user could keep streaming notification history
		// over an already-open socket until the cookie expired. A legacy session with no userId still
		// resolves to the owner principal (non-null), so single-user installs are unaffected.
		const sess = client.request.session || {};
		const deprovisioned = !!(sess.loggedIn && sess.userId && !principal);

		let loggedIn = !deprovisioned && (!!principal || sess.loggedIn);

		// Legacy-API-key auth over the socket must honor the API on/off switch, exactly like the HTTP layer
		// (AuthMiddleware gates on api_enabled). Without this, turning the API off would still admit a legacy
		// key on the WebSocket. A real user session (principal/sess.loggedIn above) is unaffected.
		if (!loggedIn && !deprovisioned && apiKey && shareData.appData.api_enabled && shareData.Common.validateApiKey(apiKey)) {

			loggedIn = true;
		}

		if (!loggedIn) {

			if (apiKey) {

				const msg = `Invalid API KEY used by ${ip} (WebSocket)`;

				shareData.Common.sendNotification({ 'message': msg, 'type': 'info', 'telegram_id': shareData.appData.telegram_id });
			}

			client.emit('error', 'Unauthorized');
			client.disconnect();			
		}
		else {

			const API_ROOM = 'api';

			if (query.room == undefined || query.room == null || query.room == '') {

				//const roomAuth = 'notifications';

				//client.join(roomAuth);
			}
			else {

				client.join(query.room);
			}

			client.on('register_client', (data, ack) => {

				client.join(API_ROOM);

				// Acknowledge so the client knows the join succeeded
				if (typeof ack === 'function') {

					ack({ success: true });
				}
			});

			// Track rooms with active AI generations so disconnect can clean them up
			const clientGenerationRooms = new Set();

			client.on('disconnect', () => {

				inflightMap.delete(client.id);

				// Abort any in-progress AI generation when the client disconnects
				if (shareData.AIClient) {

					clientGenerationRooms.forEach(room => shareData.AIClient.abortGeneration(room));
				}

				clientGenerationRooms.clear();
			});

			client.on('joinRooms', ({ rooms }) => {

				if (!rooms) return;

				const roomList = Array.isArray(rooms) ? rooms : [rooms];

				roomList.forEach(room => {

					if (room === API_ROOM) {

						return;
					}

					client.join(room);

					// Track as a potential AI generation room for disconnect cleanup
					clientGenerationRooms.add(room);
				});
			});

			client.on('leaveRoom', (room) => {

				client.leave(room);
			});

			client.on('stopGeneration', (room) => {

				if (room && shareData.AIClient) {

					shareData.AIClient.abortGeneration(room);
					clientGenerationRooms.delete(room);
				}
			});

			client.on('notifications_history', function (data) {

				shareData.Common.getNotificationHistory(client, data);
			});

			client.on('api_action', async (data) => {

				Routes.processWebSocketApi(client, data, inflightMap);
			});
		}
	});
}


async function disconnectAllClients() {

	try {

		socket.disconnectSockets();
	}
	catch(e) {

	}
}


async function getSocket() {

	return socket;
}


function start(port) {

	let isError;

	const { sessionMiddleware, upload } = initApp();

	let server = app.listen(port, () => {

		shareData.Common.logger(`${shareData.appData.name} v${shareData.appData.version} listening on port ${port}`, true);

	}).on('error', function(err) {

		isError = err;

		if (err.code === 'EADDRINUSE') {

			shareData.Common.logger(`Port ${port} already in use`, true);

			shareData.System.shutDown();
		}
		else {

			shareData.Common.logger('Web Server Error: ' + err, true);
		}
	});

	if (isError == undefined || isError == null) {

		const serverTimeout = (60 * 1000) * serverTimeoutMins;

		const keepAliveTimeout = serverTimeout - (1000 * 5);
		const headersTimeout = keepAliveTimeout + (1000 * 3);

		server.setTimeout(serverTimeout);

		server.keepAliveTimeout = keepAliveTimeout;
		server.headersTimeout = headersTimeout;

		initSocket(sessionMiddleware, server);

		Routes.start(router, upload);
	}
}


// Run the central self-policing watchdog against the registered routes. Called from the startup
// flow AFTER the auth subsystem (incl. the audit trail) is wired, so findings can be recorded to
// the audit log. Safe to call once routes are registered.
function runWatchdog(label) {

	if (shareData && shareData.Watchdog && typeof shareData.Watchdog.run === 'function') {

		// run() is async (checks may query the DB) and never rejects (each check is isolated, findings
		// are logged/audited inside). Fire-and-forget from boot; return the promise so a caller can
		// await it if it wants, and attach a defensive catch so it can never surface as an unhandled
		// rejection even if that contract ever changes.
		return Promise.resolve(shareData.Watchdog.run(shareData, { router: router, label: label || 'instance' })).catch(function () {});
	}

	return Promise.resolve();
}



module.exports = {

	app,
	start,
	runWatchdog,
	getSocket,
	disconnectAllClients,

	init: function(obj) {

		shareData = obj;

		Routes.init(shareData);
    }
}