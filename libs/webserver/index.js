'use strict';

const path = require('path');

const pathRoot = path.resolve(__dirname, ...Array(1).fill('..'));

const bodyParser = require('body-parser');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const MongoStore = require('connect-mongo').default;
const app = express();
const router = express.Router();
const Routes = require(pathRoot + '/webserver/routes.js');
const { sendErr } = require(pathRoot + '/webserver/routeUtils.js');
const SharedMw = require(pathRoot + '/webserver/sharedMiddleware.js');   // bootstrap middleware shared with the Hub
const SharedSocket = require(pathRoot + '/webserver/sharedSocket.js');   // socket.io bootstrap shared with the Hub

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

	// Runtime matcher for inline cap()/capAction()-gated routes, shared with the Hub (built lazily + memoized
	// against this router; see sharedMiddleware.makeInlineGuardResolver). The capability default-deny consults
	// it so an inline-gated route reaches its own guard rather than being blanket-denied.
	const resolveInlineGuard = SharedMw.makeInlineGuardResolver(shareData, router);

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
			// mode 0o600 restricts the secret to the owner on POSIX. On Windows the POSIX mode bits are a
			// no-op (Node does not translate them to an ACL), so there the file's protection comes from the
			// per-user data directory it lives in rather than this mode. Cross-platform hardening beyond that
			// would need a platform-specific ACL call, which is out of scope here.
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

	// Expose the active session store so the session-management feature (libs/app/Sessions.js) can list and
	// revoke logged-in sessions through the standard store contract, whichever store is in use.
	shareData.sessionStore = store;

	// TLS deployments can opt into a hardened session cookie via security.secure_cookie in app.json: it adds
	// the Secure attribute (cookie sent only over HTTPS) and tightens SameSite to 'strict'. Left OFF by
	// default because the common plain-HTTP LAN/VPS install would otherwise never receive the cookie at all
	// (Secure over http = no cookie = cannot log in).
	const secureCookie = !!(shareData.appData && shareData.appData.security && shareData.appData.security.secure_cookie);

	const sessionMiddleware = session({

		'secret': sessionSecret,
		'name': sessionCookieName,
		'resave': false,
		'saveUninitialized': false,
		'store': store,
		'rolling': true,
		'cookie': {
			'maxAge': sessionExpireMins * 60 * 1000,
			'sameSite': secureCookie ? 'strict' : 'lax',
			'secure': secureCookie
		}
	});

	app.disable('x-powered-by');

	// Baseline security response headers on every response. Deliberately conservative so they can't break
	// the authenticated UI, which relies on inline scripts (a full script-src CSP is intentionally NOT set
	// to avoid breaking those). These stop the trading UI from being framed (clickjacking a "panic sell" or
	// "start deal" click — `frame-ancestors 'none'` is the modern, script-safe equivalent of X-Frame-Options),
	// stop MIME-sniffing, and keep the referrer off cross-origin navigations.
	app.use(SharedMw.securityHeaders());

	// Server-wide IP allow/deny — the FIRST thing every request hits, before auth, session, and
	// static files (a built-in firewall). Opt-in via app.json ip_filter.server.enabled. Loopback is
	// ALWAYS allowed so local/console access can never be locked out, and the check fails OPEN on any
	// error so a filter bug can never brick the instance. The console `reset ipfilter` command and
	// the reverse-proxy / OS firewall remain as escape hatches.
	app.use(SharedMw.ipFilter(shareData));

	// Compress all HTTP responses. Placed before the static handlers so public assets are compressed too.
	app.use(compression({

		filter: shouldCompress,
		level: 6,

	}));

	// Static assets are PUBLIC and are served BEFORE the session middleware on purpose: the browser sends the
	// session cookie on same-origin asset requests, so if these sat behind express-session every one of the
	// ~25 vendored JS/CSS files (plus images) on a page load would trigger a session-store read — and, with
	// rolling sessions, a store write (touch) — against Mongo, for files that need no session at all. Serving
	// them ahead of the session layer removes those per-asset DB round-trips (and keeps assets available even
	// during a DB pause). Long-cache the immutable vendored libraries; give app JS/CSS a short revalidated
	// cache since they change between releases (the ETag still yields a 304 when unchanged).
	SharedMw.mountStaticAssets(app, express, pathRoot + '/webserver/public');

	app.use(sessionMiddleware);

	// Keep each logged-in session's recorded source IP and device current (shared with the Hub).
	app.use(SharedMw.noteRequestMeta(shareData));

	app.set('views', pathRoot + '/webserver/public/views');
	app.set('view engine', 'ejs');

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

		// The in-app Help guide (docs/README.md, served at /readme.md) touches no database, so it stays
		// available even while the system is paused for a backup or sitting in a database-error state — the
		// same reason the static /js and /css above are served during a pause. Everything else gets the 503.
		if ((shareData.appData.database_error || shareData.appData.system_pause) && req.path !== '/readme.md') {

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
		// Absolute so uploads always land under the install's uploads/ dir regardless of the process's current
		// working directory (a launch from another cwd would otherwise scatter them).
		dest: pathRoot + '/uploads',
		limits: { fileSize: 262144000 }
	});

	// Body parsing runs BEFORE authentication, so the size limit is a denial-of-service boundary: an
	// unauthenticated caller can send a body this large, and because the instance runs its trading loop in
	// THIS process, an out-of-memory crash here (uncatchable) would take trading down. Keep the global limit
	// small (1 MB covers every config/bot/API body) and grant a larger limit ONLY to the one route that
	// legitimately carries a big payload — the AI-learning corpus import. File uploads (backup restore, chat
	// attachments) use multer/multipart, not these parsers, so they are unaffected.
	const jsonSmall = bodyParser.json({ limit: '1mb' });
	const jsonLargeImport = bodyParser.json({ limit: '20mb' });   // AI-learning corpus packs can be a few MB

	app.use((req, res, next) => {
		if (req.path === '/api/ai/learning/import') { return jsonLargeImport(req, res, next); }
		return jsonSmall(req, res, next);
	});

	app.use(bodyParser.urlencoded({

		limit: "1mb",
		extended: true,
		parameterLimit: 10000

	}));

	// Strip MongoDB operator keys from all user input, then resolve whoever authenticated into one
	// req.principal for the route guards. Both are shared verbatim with the Hub (see sharedMiddleware).
	app.use(SharedMw.stripMongoOperators(shareData));
	app.use(SharedMw.attachPrincipal(shareData));

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

	// Capability enforcement for state-changing routes (the declarative RoutePermissions map), shared verbatim
	// with the Hub so the two authorization pipelines can never drift (see sharedMiddleware.capabilityEnforcement
	// for the full rationale, and SharedMiddleware.test.js for the pinned decision matrix).
	app.use(SharedMw.capabilityEnforcement(shareData, { resolveInlineGuard, sendErr }));

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

	socket = SharedSocket.makeServer(server, shareData, sessionMiddleware);

	// Tracks number of in-flight api_action requests per client.
	// Passed into routesWebSocket.api() so it can enforce the per-client
	// concurrency limit without shared module-level state.
	const inflightMap = new Map();

	socket.on('connect', async function (client) {

		let apiKey = client.handshake.headers['api-key'];
		let query = client.handshake.query;
		const ip = shareData.Common.getClientIp(client);

		// Resolve the principal from the handshake (session OR API key, including new scoped keys) and
		// attach it to the socket so WebSocket API calls carry the caller's capabilities; a deprovisioned
		// session is flagged so it cannot be admitted. Shared with the Hub (see sharedSocket.js).
		const { principal, deprovisioned, sess } = await SharedSocket.resolveConnection(client, shareData, ip);

		// Compose this surface's admission: a real session/principal, plus the legacy-API-key path below.
		let loggedIn = !deprovisioned && (!!principal || sess.loggedIn);

		// Legacy-API-key auth over the socket must honor the API on/off switch, exactly like the HTTP layer
		// (AuthMiddleware gates on api_enabled). Without this, turning the API off would still admit a legacy
		// key on the WebSocket. A real user session (principal/sess.loggedIn above) is unaffected.
		if (!loggedIn && !deprovisioned && apiKey && shareData.appData.api_enabled && (await shareData.Common.validateApiKey(apiKey))) {

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

			SharedSocket.joinInitialRoom(client, query);

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

			client.on('joinRooms', (data) => {

				// Parse via the shared helper so a malformed/missing payload can't throw inside the listener
				// (this server runs in the trading process) and so it stays in lockstep with the Hub handler.
				const roomList = SharedSocket.normalizeRooms(data);

				if (!roomList.length) { return; }

				roomList.forEach(room => {

					if (room === API_ROOM) {

						return;
					}

					client.join(room);

					// Track as a potential AI generation room for disconnect cleanup
					clientGenerationRooms.add(room);
				});
			});

			SharedSocket.attachLeaveRoom(client);

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


// Start the continuous, autonomous watchdog: a verbose boot sweep plus a self-unref'd, quiet periodic sweep
// for the life of the process. Called from the startup flow AFTER the auth subsystem (incl. the audit trail)
// is wired, so findings can be recorded. Non-blocking — it can never block or crash into the trading loop. The
// monitor lives in the Watchdog engine itself (a general "watch anything" system); this only hands it the
// surface's router (for the route-gating checks) and label as an opaque context.
function startWatchdogMonitor(label) {

	return shareData.Watchdog.startMonitor(shareData, { router: router, label: label || 'instance' });
}



module.exports = {

	app,
	start,
	startWatchdogMonitor,
	getSocket,
	disconnectAllClients,

	init: function(obj) {

		shareData = obj;

		Routes.init(shareData);
    }
}