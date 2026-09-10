'use strict';

// ── Session management ────────────────────────────────────────────────────────
// List and revoke the logged-in browser sessions of a SymBot instance or the Hub. Deliberately
// store-AGNOSTIC: it drives only standard express-session store methods — `all()` (connect-mongo) or
// `list()`+`get()` (session-file-store) to enumerate, and `destroy()` to revoke — so it works unchanged
// over an instance with a database, the Hub, and an instance in config mode / a fresh install, plus any
// future compliant store (a store providing none of those degrades to an empty, "unsupported" list, never
// an error). The web server exposes its active
// store as `shareData.sessionStore`; the login path (Common.verifyLogin) stamps a small `meta` object
// into each session — { sid, user, ip, ua, loginAt } — which is what this module reads back to render
// the list and to target a revoke. Never throws into a caller: every method fails safe (empty list /
// false / 0) so a session-store hiccup can never surface as a request error. Web layer only; it has no
// bearing on trading.

let shareData;

// How often an actively-used session re-stamps its "last active" time (and, as a side effect, forces a full
// save that re-serializes the session). Throttled so a busy session never writes on every request, yet often
// enough to keep the displayed last-active fresh and to keep the stored session from ever drifting far behind
// its live TTL. Web-layer bookkeeping only — nothing on the trading path depends on it.
const LASTSEEN_WRITE_MS = 5 * 60 * 1000;


function init(obj) { shareData = obj; }


function getStore() {

	return (shareData && shareData.sessionStore) || null;
}


// Keep a live session's recorded fingerprint current: on each authenticated request, if the source IP or
// the user-agent differs from what the session holds, update it — so the Sessions view shows where and on
// what device a session is used NOW. A phone moving from Wi-Fi to mobile data changes the IP; a browser
// update, or the cookie being used from a different client, changes the user-agent. Writes only on an
// ACTUAL change, so a stable connection adds no per-request write (express-session persists the session
// only when it is modified). Best-effort: never throws, never blocks a request. The original login IP and
// agent stay in the audit log's auth.login event, so no forensic history is lost. Called from a small
// middleware on both surfaces.
function noteRequestMeta(req) {

	try {

		if (!req || !req.session || !req.session.loggedIn) { return; }

		const am = shareData && shareData.AuthMiddleware;
		const ip = (am && typeof am.clientIp === 'function') ? am.clientIp(req) : '';
		const ua = (req.headers && req.headers['user-agent']) || '';
		const meta = req.session.meta;
		const now = Date.now();

		// Backfill (self-heal) a session that has no usable metadata — one that logged in BEFORE this feature
		// existed and has been kept alive indefinitely by rolling sessions, so it never re-logged-in to acquire
		// a meta stamp. Without a stored sid such a session is INVISIBLE in the list on connect-mongo (whose
		// all() exposes no store key to fall back on) and shows as "Unknown device" on the file store. Stamp it
		// from the current request so it lists correctly and is revocable, and gets its real device/IP. The
		// original login time is unknown, so leave loginAt null; the user label follows the session's own login
		// (blank = the owner). One write, then subsequent requests take the cheap change-only path below.
		if (!meta || !meta.sid) {

			req.session.meta = {
				'sid': req.sessionID,
				'user': (meta && meta.user) || '',
				'ip': ip,
				'ua': ua,
				'loginAt': (meta && meta.loginAt) || null,
				'lastSeen': now
			};

			return;
		}

		if (ip && ip !== meta.ip) { meta.ip = ip; }
		if (ua && ua !== meta.ua) { meta.ua = ua; }

		// Record "last active". A store's rolling touch() refreshes only its OWN expiry (connect-mongo's top-level
		// TTL field), NOT the session's embedded cookie.expires — a documented, deliberate express-session /
		// connect-mongo behavior (the session hash ignores the cookie, so nothing forces a resave). So a
		// last-active derived from the cookie would freeze at the last full save for an actively-used session, and
		// once maxAge elapsed since that save the session would look "expired" and drop out of the list even while
		// it is being used perfectly fine. Stamping lastSeen here forces a periodic full save that BOTH keeps the
		// displayed last-active truthful AND re-serializes the session so its stored copy can never drift behind
		// its live TTL. Throttled to once per LASTSEEN_WRITE_MS — the same write-only-when-it-matters discipline as
		// the IP/UA updates above — so an active session never writes on every request.
		if (!meta.lastSeen || (now - meta.lastSeen) >= LASTSEEN_WRITE_MS) { meta.lastSeen = now; }
	}
	catch (e) {}
}


// The session cookie's absolute expiry as epoch ms, or null — parsed one way in one place, then reused
// by both the last-active derivation and the expired-session filter.
function cookieExpiryMs(sess) {

	try {

		const c = sess && sess.cookie;
		const e = c && (c.expires || c._expires);

		if (e) { const t = new Date(e).getTime(); if (!isNaN(t)) { return t; } }
	}
	catch (x) {}

	return null;
}


// "Last active" for a session. Preferred source is the lastSeen timestamp noteRequestMeta stamps on each
// active request (throttled): it is accurate on EVERY store, including one whose rolling touch() leaves the
// embedded cookie.expires stale. For a session predating lastSeen (until its next request heals it), fall
// back to the cookie: with rolling sessions the cookie's expiry is refreshed to now + maxAge each request, so
// (expires − originalMaxAge) ≈ the last request time — exact on session-file-store (whose touch re-writes the
// cookie), only as fresh as the last full save on connect-mongo. Falls back once more to the login time.
function deriveLastSeen(sess) {

	const stamped = sess && sess.meta && sess.meta.lastSeen;
	if (stamped) { return stamped; }

	const expires = cookieExpiryMs(sess);
	const maxAge = sess && sess.cookie && sess.cookie.originalMaxAge;

	if (expires && maxAge) {

		const t = expires - maxAge;
		if (t > 0) { return t; }
	}

	return (sess && sess.meta && sess.meta.loginAt) || null;
}


// Turn a set of { sid, sess } entries into display rows, newest login first. A session with no stored
// sid AND no store key (a pre-feature session) is skipped because it cannot be targeted for a revoke —
// those expire on their own.
function buildRows(entries, currentSid) {

	const rows = [];

	for (const entry of entries) {

		const sess = entry && entry.sess;

		if (!sess || !sess.loggedIn) { continue; }   // only authenticated sessions

		// Liveness is the STORE's call, not the session's embedded cookie.expires. connect-mongo's all() already
		// returns only sessions whose top-level TTL is still in the future, and session-file-store's get() returns
		// null for one past its last-access + ttl — so anything that reaches here is a session the store considers
		// alive. The embedded cookie.expires is NOT a reliable signal: a store's rolling touch() refreshes its own
		// TTL but leaves that nested value frozen at the last full save (a documented connect-mongo / express-
		// session behavior), so filtering on it here wrongly hid an actively-used session once maxAge elapsed
		// since its last save. Trust the enumeration instead.

		const meta = sess.meta || {};
		const sid = meta.sid || entry.sid || null;

		if (!sid) { continue; }

		rows.push({
			sid: sid,
			current: sid === currentSid,
			user: meta.user || '',            // '' = the owner login
			ip: meta.ip || '',
			ua: meta.ua || '',
			loginAt: meta.loginAt || null,
			lastSeen: deriveLastSeen(sess)
		});
	}

	rows.sort((a, b) => (b.loginAt || 0) - (a.loginAt || 0));

	return rows;
}


// All authenticated sessions as display rows. `currentSid` (the caller's own req.sessionID) marks that
// row so the UI can protect it from a "sign out everywhere". Store-agnostic across the two shapes the
// express-session ecosystem actually uses: connect-mongo (the instance with a database) implements
// `all()`; session-file-store (the Hub, and an instance in config mode) implements `list()` + `get()`
// instead. Revoke needs only `destroy()`, which both provide.
function list(currentSid) {

	return new Promise((resolve) => {

		const store = getStore();

		if (!store) { resolve({ supported: false, sessions: [] }); return; }

		let settled = false;
		let guard = null;
		let partial = [];   // accumulator, so the hang-guard below can still return whatever was gathered
		const ok = (entries) => { if (!settled) { settled = true; if (guard) { clearTimeout(guard); } resolve({ supported: true, sessions: buildRows(entries || partial, currentSid) }); } };
		const unsupported = () => { if (!settled) { settled = true; if (guard) { clearTimeout(guard); } resolve({ supported: false, sessions: [] }); } };

		// Hang protection: a misbehaving store (a get() that never fires its callback, a stalled all())
		// must never leave the request without a response. If nothing has settled within a generous budget,
		// resolve with what was collected (empty if nothing). A normal list settles in well under 100ms.
		guard = setTimeout(() => ok(null), 5000);
		if (guard.unref) { guard.unref(); }

		// Preferred path: store.all() returns an array of session data (connect-mongo) or an object keyed
		// by sid (some stores). No per-session round trip.
		if (typeof store.all === 'function') {

			try {

				store.all((err, data) => {

					if (err || !data) { ok([]); return; }

					partial = Array.isArray(data)
						? data.map((s) => ({ sid: null, sess: s }))
						: Object.keys(data).map((k) => ({ sid: k, sess: data[k] }));

					ok(partial);
				});
			}
			catch (e) { ok([]); }

			return;
		}

		// Fallback path: list the session ids then read each (session-file-store). Its list() returns file
		// ids that may carry a `.json` suffix, so strip it to the real sid for both get() and display.
		if (typeof store.list === 'function' && typeof store.get === 'function') {

			try {

				store.list((err, ids) => {

					if (err || !Array.isArray(ids) || !ids.length) { ok([]); return; }

					const sids = ids.map((id) => String(id).replace(/\.json$/i, ''));
					let pending = sids.length;
					const finish = () => { if (--pending <= 0) { ok(partial); } };

					sids.forEach((sid) => {

						let one = false;
						const record = (sess) => { if (!one) { one = true; if (sess) { partial.push({ sid: sid, sess: sess }); } finish(); } };

						try { store.get(sid, (e, sess) => record(e ? null : sess)); }
						catch (e) { record(null); }
					});
				});
			}
			catch (e) { ok([]); }

			return;
		}

		unsupported();
	});
}


// Destroy one session by sid. Resolves true on success.
function revoke(sid) {

	return new Promise((resolve) => {

		const store = getStore();

		if (!store || !sid || typeof store.destroy !== 'function') { resolve(false); return; }

		try { store.destroy(sid, (err) => resolve(!err)); }
		catch (e) { resolve(false); }
	});
}


// Destroy every authenticated session EXCEPT the caller's own. Returns the number revoked. Used by the
// "sign out everywhere else" action, which must never end the session issuing the request.
async function revokeAllExcept(currentSid) {

	const { sessions } = await list(currentSid);

	let revoked = 0;

	for (const s of sessions) {

		if (s.sid && s.sid !== currentSid) {

			if (await revoke(s.sid)) { revoked++; }
		}
	}

	return revoked;
}


module.exports = {

	init,
	noteRequestMeta,
	list,
	revoke,
	revokeAllExcept
};
