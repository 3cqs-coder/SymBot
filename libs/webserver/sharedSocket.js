'use strict';

// Socket.IO bootstrap shared by the instance and Hub web servers. Both create the io server with the SAME
// options and session/no-op middleware, and both resolve a connecting client's principal the same way, so
// that setup lives here once instead of being copy-pasted into each index.js (the same reasoning behind
// sharedRoutes.js and sharedMiddleware.js). Each surface still owns its own 'connect' handler AFTER
// admission — the instance has api_action, AI-generation abort cleanup and legacy-API-key auth; the Hub has
// the memory-room poll — and each composes its OWN final loggedIn decision. This module only supplies the
// identical building blocks; it deliberately does not decide admission, so neither surface's auth rule can
// be accidentally changed by a shared default.


// Create and configure the Socket.IO server: the shared CORS/ping/buffer options, the session-middleware
// bridge, and the no-op passthrough. Returns the io instance; the caller attaches its own 'connect' handler.
function makeServer(server, shareData, sessionMiddleware) {

	const io = require('socket.io')(server, {

		cors: {
			origin: '*',
			methods: [ 'PUT', 'GET', 'POST', 'DELETE', 'OPTIONS' ],
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

	io.use(wrap(sessionMiddleware));
	io.use((client, next) => { return next(); });

	return io;
}


// Resolve a connecting client's principal from its handshake (session OR API key, via AuthMiddleware) and
// attach it to the socket, mirroring the HTTP layer. Returns { principal, deprovisioned, sess } so each
// surface composes its own loggedIn decision. `deprovisioned` is true when a session whose user no longer
// resolves to an active principal (disabled or deleted after login) tries to connect — the HTTP layer 401s
// these same users, and without refusing them here a just-disabled user could keep streaming over an
// already-open socket until the cookie expired. A legacy session with no userId still resolves to the owner
// principal (non-null), so single-user installs are unaffected. Never throws: a resolver error yields
// principal:null (treated as not-admitted by the caller).
async function resolveConnection(client, shareData, ip) {

	let principal = null;

	try {
		if (shareData.AuthMiddleware && typeof shareData.AuthMiddleware.resolvePrincipal === 'function') {
			principal = await shareData.AuthMiddleware.resolvePrincipal({ session: client.request.session, headers: client.handshake.headers, ip: ip });
		}
	}
	catch (e) { principal = null; }

	client.principal = principal;

	const sess = client.request.session || {};
	const deprovisioned = !!(sess.loggedIn && sess.userId && !principal);

	return { principal, deprovisioned, sess };
}


// Join the room named in the connection handshake query, if any. Both surfaces do this identically right after
// admission (a blank or absent room is a no-op). Kept here so the two can't drift.
function joinInitialRoom(client, query) {

	if (query && query.room != null && query.room !== '') {

		client.join(query.room);
	}
}


// Attach the identical leaveRoom listener both surfaces use (a client asking to leave one room by name).
function attachLeaveRoom(client) {

	client.on('leaveRoom', (room) => { client.leave(room); });
}


// Normalize a joinRooms payload into an array of room names. Both surfaces parse the payload identically, so it
// lives here to stay in lockstep. Guards against a missing/malformed payload: a bare `({ rooms })` destructure
// would throw synchronously on a null/undefined arg (and the instance handler runs inside the trading process).
// A single room becomes a one-element array; a missing or falsy `rooms` yields an empty array (a no-op join).
function normalizeRooms(data) {

	const rooms = data && data.rooms;

	if (!rooms) { return []; }

	return Array.isArray(rooms) ? rooms : [ rooms ];
}


module.exports = { makeServer, resolveConnection, joinInitialRoom, attachLeaveRoom, normalizeRooms };
