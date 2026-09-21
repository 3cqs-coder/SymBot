'use strict';


// Routes that are IDENTICAL on the instance web server and the Hub web server, registered from one place so
// the two can never drift. The caller passes in the few pieces that differ per surface:
//   cap              — that surface's capability-guard factory (routeUtils.capGuard, already bound to shareData)
//   shareData        — the shared services object (Sessions, Common, Authz, …)
//   sendErr          — the shared JSON error responder
//   denyUnauthorized — the shared 401/redirect responder
//   isAuthed(req)    — "is this request authenticated" for the pre-login-gated guide (an instance keys on the
//                      session; the Hub also accepts an API principal)
//   readmeFile       — absolute path to the docs README this surface should serve
//
// Everything registered here is read-only, session-management, or authentication — none of it touches the
// trading path. Routes are grouped below by what they do.
function register(router, deps) {

	const cap = deps.cap;
	const shareData = deps.shareData;
	const sendErr = deps.sendErr;
	const denyUnauthorized = deps.denyUnauthorized;
	const isAuthed = deps.isAuthed;
	const readmeFile = deps.readmeFile;


	// ── In-app guide ──────────────────────────────────────────────────────────
	// The shipped docs/README.md, served for the in-app Help viewer. ONE source of truth — the same file the
	// project ships — so the in-app guide can never drift from the docs. Public documentation, but served only
	// to an authenticated request, and rendered client-side by the vendored markdown library (see symbot-ui.js).
	router.get('/readme.md', (req, res) => {

		// The guide is a large shipped file that changes only on upgrade, so allow revalidated caching rather
		// than no-store: sendFile emits ETag/Last-Modified, so the browser gets a cheap 304 on repeat opens
		// instead of re-downloading the whole guide every time Help is opened. Non-sensitive documentation.
		res.set('Cache-Control', 'no-cache');

		if (!isAuthed(req)) { denyUnauthorized(req, res); return; }

		res.type('text/markdown; charset=utf-8');

		res.sendFile(readmeFile, (err) => {

			if (err && !res.headersSent) { res.status(404).type('text').send('The guide is unavailable.'); }
		});
	});


	// ── Authentication ────────────────────────────────────────────────────────
	// Login page + submit — identical on both surfaces except the isHub render flag and the isHub argument to
	// verifyLogin, both supplied via deps. Registered here so the two can never drift. isHub is always passed
	// (as a boolean) so the login template never sees an undefined variable.
	const isHub = !!deps.isHub;

	router.get('/login', (req, res) => {
		res.set('Cache-Control', 'no-store');
		res.render('loginView', { isHub: isHub, appData: shareData.appData });
	});

	router.post('/login', (req, res) => {
		res.set('Cache-Control', 'no-store');
		shareData.Common.verifyLogin(req, res, isHub);
	});

	// Log out — audited before the session is torn down (so the actor still resolves), then the session is
	// destroyed and the browser is sent to the login page.
	router.get('/logout', (req, res) => {
		res.set('Cache-Control', 'no-store');
		shareData.Common.auditEvent(req, 'auth.logout', '', '');
		req.session.destroy((err) => {});
		res.redirect('/login');
	});


	// ── Logged-in sessions: view + revoke ─────────────────────────────────────
	// Sessions are an access-management concern, so they reuse the user.manage capability rather than
	// introducing new ones. Both viewing and revoking require user.manage (admin/owner) — the active session
	// list exposes each device's source IP, which a read-only viewer should not see. Store-agnostic list/destroy
	// lives in libs/app/Sessions.js. Gated inline, so the default-deny middleware auto-detects the guard.
	router.get('/api/sessions', cap('user.manage'), async (req, res) => {
		try {
			const r = await shareData.Sessions.list(req.sessionID);
			res.status(200).json({ success: true, supported: r.supported, current: req.sessionID, sessions: r.sessions });
		}
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/sessions/revoke', cap('user.manage'), async (req, res) => {
		try {
			// Accept only a STRING session id. The JSON body parser would otherwise let sid be an object/array,
			// and an object like { "$gt": "" } is not === req.sessionID, so it would slip past the self-guard
			// below and reach the store as a Mongo operator. Coercing to a string here closes that and makes the
			// self-guard hold for every input shape.
			const sid = (req.body && typeof req.body.sid === 'string') ? req.body.sid : '';
			if (!sid) { return res.status(400).json({ success: false, error: 'A session id is required.' }); }
			// Ending your OWN session is a logout — route it there so the cookie is cleared and the UI redirects
			// cleanly, rather than a silent store-destroy of the request's own session mid-response.
			if (sid === req.sessionID) { return res.status(400).json({ success: false, error: 'That is your current session — use Log out.', self: true }); }
			const ok = await shareData.Sessions.revoke(sid);
			if (ok) { shareData.Common.auditEvent(req, 'session.revoke', String(sid).slice(0, 12), 'ended one session'); }
			res.status(200).json({ success: ok });
		}
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/sessions/revoke-others', cap('user.manage'), async (req, res) => {
		try {
			const n = await shareData.Sessions.revokeAllExcept(req.sessionID);
			shareData.Common.auditEvent(req, 'session.revoke_others', String(n), 'signed out all other sessions');
			res.status(200).json({ success: true, revoked: n });
		}
		catch (e) { sendErr(res, e); }
	});


	// ── Access-control catalog ────────────────────────────────────────────────
	// The capability catalog + role names, for the Access Control UIs. Read-only, gated by apikey.read.
	router.get('/api/authz/capabilities', cap('apikey.read'), (req, res) => {
		res.status(200).json({ success: true, capabilities: shareData.Authz.CAPABILITIES, roles: shareData.Authz.ROLE_NAMES });
	});


	// ── Access Control: API keys, users, audit log ────────────────────────────
	// This is SECURITY-SENSITIVE authorization CRUD, so it lives here — registered identically on both
	// surfaces — rather than being copied per surface where the capability guards, the privilege-bounding on
	// user creation, and the audit-event names could drift. Each surface supplies the SAME method surface
	// through shareData: the instance backs it with the Mongo ApiKeys/Users/Audit modules (async), the Hub
	// with SQLite HubStore adapters (sync); `await` works for both. Surface-specific key routes that only one
	// side has (a key's IP lists, a key's post-hoc expiry, the caller's own IP, the diagnostics catalog) stay
	// in that surface's own route file.

	// API keys.
	router.get('/api/keys', cap('apikey.read'), async (req, res) => {
		try { res.status(200).json({ success: true, keys: await shareData.ApiKeys.list() }); }
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/keys', cap('apikey.create'), async (req, res) => {
		try {
			const body = req.body || {};
			const r = await shareData.ApiKeys.create({
				name: body.name,
				capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
				signing: body.signing,
				expiresAt: body.expires_at ? new Date(body.expires_at) : null,
				rateLimit: body.rate_limit,
				ipAllowlist: Array.isArray(body.ip_allowlist) ? body.ip_allowlist : [],
				ipBlocklist: Array.isArray(body.ip_blocklist) ? body.ip_blocklist : [],
				ownerUserId: req.principal && req.principal.id,
				ownerCapabilities: (req.principal && req.principal.capabilities) || []   // key scopes ⊆ owner
			});
			if (r.success) { shareData.Common.auditEvent(req, 'apikey.create', r.key.prefix, r.key.name); }
			res.status(200).json(r);   // r.clearKey shown once by the UI
		}
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/keys/:id/rotate', cap('apikey.create'), async (req, res) => {
		try {
			const body = req.body || {};
			const r = await shareData.ApiKeys.rotate(req.params.id, { graceHours: body.grace_hours });
			if (r.success) { shareData.Common.auditEvent(req, 'apikey.rotate', (r.key && r.key.prefix) || req.params.id, 'rotated; predecessor expires in ' + r.grace_hours + 'h'); }
			res.status(200).json(r);   // r.clearKey shown once by the UI
		}
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/keys/:id/status', cap('apikey.revoke'), async (req, res) => {
		try {
			const status = (req.body && req.body.status) || 'revoked';
			const r = await shareData.ApiKeys.setStatus(req.params.id, status);
			if (r.success) { shareData.Common.auditEvent(req, status === 'revoked' ? 'apikey.revoke' : 'apikey.status', req.params.id, status); }
			res.status(200).json(r);
		}
		catch (e) { sendErr(res, e); }
	});

	// Users.
	router.get('/api/users', cap('user.read'), async (req, res) => {
		try { res.status(200).json({ success: true, users: await shareData.Users.list() }); }
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/users', cap('user.invite'), async (req, res) => {
		try {
			const body = req.body || {};
			// Bound the new user's role/grants to the creator's own authority so a non-owner cannot mint an
			// owner (or grant capabilities they lack). The owner ('*') is unaffected. A legacy owner session
			// (loggedIn, no userId) has no scoped principal but is the implicit owner, so treat it as '*'.
			const creatorCaps = (req.principal && Array.isArray(req.principal.capabilities))
				? req.principal.capabilities
				: ((req.session && req.session.loggedIn && !req.session.userId) ? [ '*' ] : []);
			const scoped = shareData.Authz.scopeNewUser(creatorCaps, { role: body.role, grants: body.grants });
			if (scoped.exceeded) { return res.status(403).json({ success: false, error: 'You cannot create a user more privileged than your own account.' }); }
			const r = await shareData.Users.create({ username: body.username, password: body.password, role: scoped.role, grants: scoped.grants });
			if (r.success) { shareData.Common.auditEvent(req, 'user.create', r.user.username, r.user.role); }
			res.status(200).json(r);
		}
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/users/:id/role', cap('user.manage'), async (req, res) => {
		try {
			const requestedRole = (req.body && req.body.role);
			// Bound the target role to the caller's OWN authority, mirroring the create path above (defense in
			// depth). A caller must not promote anyone — including themselves — to a role granting capabilities
			// they do not hold. The owner ('*') is unaffected. Today only the owner can reach this route, so this
			// changes nothing now; it closes the privilege-escalation path if `user.manage` is ever granted to a
			// role that lacks '*'. A legacy owner session (loggedIn, no userId) is the implicit owner → '*'.
			const callerCaps = (req.principal && Array.isArray(req.principal.capabilities))
				? req.principal.capabilities
				: ((req.session && req.session.loggedIn && !req.session.userId) ? [ '*' ] : []);
			if (shareData.Authz.scopeNewUser(callerCaps, { role: requestedRole }).exceeded) {
				return res.status(403).json({ success: false, error: 'You cannot assign a role more privileged than your own account.' });
			}
			const r = await shareData.Users.setRole(req.params.id, requestedRole);
			if (r.success) { shareData.Common.auditEvent(req, 'user.role', req.params.id, requestedRole); }
			res.status(200).json(r);
		}
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/users/:id/status', cap('user.manage'), async (req, res) => {
		try {
			const status = (req.body && req.body.status) || 'active';
			const r = await shareData.Users.setStatus(req.params.id, status);
			if (r.success) { shareData.Common.auditEvent(req, 'user.status', req.params.id, status); }
			res.status(200).json(r);
		}
		catch (e) { sendErr(res, e); }
	});

	// Audit log.
	router.get('/api/audit', cap('audit.read'), async (req, res) => {
		try { res.status(200).json({ success: true, entries: await shareData.Audit.list({ action: req.query.action, actor: req.query.actor, limit: req.query.limit }) }); }
		catch (e) { sendErr(res, e); }
	});
}


module.exports = { register };
