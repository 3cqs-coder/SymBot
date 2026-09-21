'use strict';

// Session management — the store-agnostic list/revoke over the express-session store contract.
//
// libs/app/Sessions.js lists and revokes logged-in sessions for BOTH an instance (connect-mongo, which
// implements all()) and the Hub / a fresh config-mode install (session-file-store, which implements
// list()+get() instead). These tests pin: store-shape agnosticism (all() array, all() object-map,
// list()+get()), login-metadata rendering, the expired / not-logged-in / no-sid filters, the newest-first
// sort, the current-session marker, revoke + revoke-all-except-current, and the graceful
// "unsupported store" / error fallbacks — none of which may ever throw. No network, no real store.

const assert = require('assert');
const Sessions = require('../../app/Sessions.js');

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

const MAXAGE = 3600000;
const future = () => new Date(Date.now() + 1000000).toISOString();
const past   = () => new Date(Date.now() - 1000).toISOString();
const use = (store) => Sessions.init({ sessionStore: store });

// connect-mongo shape: all() returns an ARRAY of session data (no store key).
function allArrayStore(sessions, destroyed) {
	return { all: (cb) => cb(null, sessions), destroy: (sid, cb) => { destroyed.push(sid); cb(null); } };
}
// A store whose all() returns an OBJECT keyed by sid.
function allObjectStore(map, destroyed) {
	return { all: (cb) => cb(null, map), destroy: (sid, cb) => { destroyed.push(sid); cb(null); } };
}
// session-file-store shape: list() ids (carrying .json) + get() per id.
function listGetStore(map, destroyed) {
	return {
		list: (cb) => cb(null, Object.keys(map).map((k) => k + '.json')),
		get: (sid, cb) => cb(null, map[sid] || null),
		destroy: (sid, cb) => { destroyed.push(sid); cb(null); }
	};
}

(async () => {

	console.log('\nSessions.list — store-shape agnosticism:');

	await test('all() ARRAY: lists logged-in sessions, newest login first, marks current, renders meta', async () => {
		use(allArrayStore([
			{ loggedIn: true, meta: { sid: 's1', user: '', loginAt: 1000 }, cookie: { expires: future(), originalMaxAge: MAXAGE } },
			{ loggedIn: true, meta: { sid: 's2', user: 'bob', loginAt: 2000 }, cookie: { expires: future(), originalMaxAge: MAXAGE } }
		], []));
		const r = await Sessions.list('s1');
		assert.strictEqual(r.supported, true);
		assert.deepStrictEqual(r.sessions.map((s) => s.sid), ['s2', 's1']);   // newest login first
		assert.strictEqual(r.sessions.find((s) => s.sid === 's1').current, true);
		assert.strictEqual(r.sessions.find((s) => s.sid === 's2').current, false);
		assert.strictEqual(r.sessions.find((s) => s.sid === 's2').user, 'bob');
		assert.strictEqual(typeof r.sessions[0].lastSeen, 'number');
	});

	await test('all() OBJECT map: uses the map key as sid when meta has none', async () => {
		use(allObjectStore({ k1: { loggedIn: true, cookie: { expires: future(), originalMaxAge: MAXAGE } } }, []));
		const r = await Sessions.list('x');
		assert.deepStrictEqual(r.sessions.map((s) => s.sid), ['k1']);
	});

	await test('list()+get(): strips .json, reads each session (session-file-store shape)', async () => {
		use(listGetStore({
			a: { loggedIn: true, meta: { sid: 'a', loginAt: 10 }, cookie: { expires: future(), originalMaxAge: MAXAGE } },
			b: { loggedIn: true, meta: { sid: 'b', loginAt: 20 }, cookie: { expires: future(), originalMaxAge: MAXAGE } }
		}, []));
		const r = await Sessions.list('a');
		assert.strictEqual(r.supported, true);
		assert.deepStrictEqual(r.sessions.map((s) => s.sid), ['b', 'a']);
		assert.strictEqual(r.sessions.find((s) => s.sid === 'a').current, true);
	});

	console.log('\nSessions.list — filters (only real, active, targetable sessions):');

	await test('lists a session the store returned even with a stale embedded cookie.expires (rolling touch)', async () => {
		// Liveness is the store's call — connect-mongo's all() filters on its top-level TTL, file-store's get() on
		// last-access — and a store's rolling touch() leaves the embedded cookie.expires frozen at the last full
		// save. So an actively-used session can legitimately carry a PAST cookie.expires; it must still be listed,
		// never dropped here. (This is the regression that made a day-old session vanish while in active use.)
		use(allArrayStore([
			{ loggedIn: true, meta: { sid: 'fresh', loginAt: 2 }, cookie: { expires: future(), originalMaxAge: MAXAGE } },
			{ loggedIn: true, meta: { sid: 'stale', loginAt: 1 }, cookie: { expires: past(), originalMaxAge: MAXAGE } }
		], []));
		const r = await Sessions.list('fresh');
		assert.deepStrictEqual(r.sessions.map((s) => s.sid), ['fresh', 'stale']);   // both listed, newest login first
	});

	await test('skips a not-logged-in session', async () => {
		use(allArrayStore([{ loggedIn: false, meta: { sid: 'anon' } }], []));
		assert.strictEqual((await Sessions.list('x')).sessions.length, 0);
	});

	await test('skips a logged-in session with neither a stored sid nor a store key', async () => {
		use(allArrayStore([{ loggedIn: true, cookie: { expires: future() } }], []));   // array form → no key, no meta.sid
		assert.strictEqual((await Sessions.list('x')).sessions.length, 0);
	});

	console.log('\nSessions.list — graceful degradation (never throws):');

	await test('a store with neither all() nor list()/get() → unsupported, empty', async () => {
		use({ destroy: (sid, cb) => cb(null) });
		assert.deepStrictEqual(await Sessions.list('x'), { supported: false, sessions: [] });
	});

	await test('no store configured → unsupported, empty', async () => {
		Sessions.init({});
		assert.deepStrictEqual(await Sessions.list('x'), { supported: false, sessions: [] });
	});

	await test('a store.all() that errors → supported, empty (no throw)', async () => {
		use({ all: (cb) => cb(new Error('boom')), destroy: (sid, cb) => cb(null) });
		assert.deepStrictEqual(await Sessions.list('x'), { supported: true, sessions: [] });
	});

	console.log('\nSessions.revoke / revokeAllExcept:');

	await test('revoke() destroys the given sid', async () => {
		const destroyed = [];
		use(allArrayStore([], destroyed));
		assert.strictEqual(await Sessions.revoke('sX'), true);
		assert.deepStrictEqual(destroyed, ['sX']);
	});

	await test('revoke() with no sid → false, no destroy', async () => {
		const destroyed = [];
		use(allArrayStore([], destroyed));
		assert.strictEqual(await Sessions.revoke(''), false);
		assert.deepStrictEqual(destroyed, []);
	});

	await test('revokeAllExcept() destroys every session except the current one', async () => {
		const destroyed = [];
		use(allArrayStore([
			{ loggedIn: true, meta: { sid: 'me', loginAt: 3 }, cookie: { expires: future(), originalMaxAge: MAXAGE } },
			{ loggedIn: true, meta: { sid: 'o1', loginAt: 2 }, cookie: { expires: future(), originalMaxAge: MAXAGE } },
			{ loggedIn: true, meta: { sid: 'o2', loginAt: 1 }, cookie: { expires: future(), originalMaxAge: MAXAGE } }
		], destroyed));
		const n = await Sessions.revokeAllExcept('me');
		assert.strictEqual(n, 2);
		assert.deepStrictEqual(destroyed.slice().sort(), ['o1', 'o2']);
		assert.strictEqual(destroyed.includes('me'), false);
	});

	console.log('\nSessions.noteRequestMeta (updates IP + device on change; backfills a session with no meta):');

	// No store needed — it operates on the request/session directly; AuthMiddleware.clientIp supplies the IP.
	const withIp = (ip) => Sessions.init({ AuthMiddleware: { clientIp: () => ip } });
	// A request whose session already carries meta (with a sid) — exercises the cheap change-only path. lastSeen
	// defaults to "now" so the throttle is satisfied and the test isolates the IP/UA behavior it means to check.
	const reqMeta = (ua, metaIp, metaUa, lastSeen = Date.now()) => ({ sessionID: 'sid1', session: { loggedIn: true, meta: { sid: 'sid1', user: '', ip: metaIp, ua: metaUa, lastSeen: lastSeen } }, headers: { 'user-agent': ua } });

	await test('updates the recorded IP when the source IP changes (Wi-Fi → mobile data)', async () => {
		withIp('5.6.7.8');
		const req = reqMeta('UA1', '1.2.3.4', 'UA1');
		Sessions.noteRequestMeta(req);
		assert.strictEqual(req.session.meta.ip, '5.6.7.8');
		assert.strictEqual(req.session.meta.ua, 'UA1');   // unchanged
	});

	await test('updates the recorded user-agent when it changes', async () => {
		withIp('1.2.3.4');
		const req = reqMeta('UA2', '1.2.3.4', 'UA1');
		Sessions.noteRequestMeta(req);
		assert.strictEqual(req.session.meta.ua, 'UA2');
		assert.strictEqual(req.session.meta.ip, '1.2.3.4');   // unchanged
	});

	await test('no change when IP/UA are unchanged and lastSeen is recent (idempotent, no write)', async () => {
		withIp('1.2.3.4');
		const recent = Date.now();
		const req = reqMeta('UA1', '1.2.3.4', 'UA1', recent);
		Sessions.noteRequestMeta(req);
		assert.deepStrictEqual(req.session.meta, { sid: 'sid1', user: '', ip: '1.2.3.4', ua: 'UA1', lastSeen: recent });
	});

	await test('stamps lastSeen when it is missing (session predating the lastSeen field)', async () => {
		withIp('1.2.3.4');
		const req = { sessionID: 'sid1', session: { loggedIn: true, meta: { sid: 'sid1', user: '', ip: '1.2.3.4', ua: 'UA1' } }, headers: { 'user-agent': 'UA1' } };
		Sessions.noteRequestMeta(req);
		assert.strictEqual(typeof req.session.meta.lastSeen, 'number');   // now trackable / forces a full save
	});

	await test('refreshes lastSeen once it is stale, but leaves a recent one untouched (throttle)', async () => {
		withIp('1.2.3.4');
		const stale = Date.now() - (10 * 60 * 1000);   // older than the write interval
		const reqStale = reqMeta('UA1', '1.2.3.4', 'UA1', stale);
		Sessions.noteRequestMeta(reqStale);
		assert.ok(reqStale.session.meta.lastSeen > stale, 'a stale lastSeen is advanced');

		const fresh = Date.now() - 1000;   // within the write interval
		const reqFresh = reqMeta('UA1', '1.2.3.4', 'UA1', fresh);
		Sessions.noteRequestMeta(reqFresh);
		assert.strictEqual(reqFresh.session.meta.lastSeen, fresh, 'a recent lastSeen is not rewritten');
	});

	await test('backfills meta (sid + IP + device) for a pre-feature session that has none', async () => {
		withIp('9.9.9.9');
		const req = { sessionID: 'sidNew', session: { loggedIn: true }, headers: { 'user-agent': 'UAx' } };   // no meta at all
		Sessions.noteRequestMeta(req);
		assert.strictEqual(req.session.meta.sid, 'sidNew');   // now targetable + listable (fixes the drop on connect-mongo)
		assert.strictEqual(req.session.meta.ip, '9.9.9.9');
		assert.strictEqual(req.session.meta.ua, 'UAx');
		assert.strictEqual(req.session.meta.loginAt, null);   // original login time is unknown
		assert.strictEqual(typeof req.session.meta.lastSeen, 'number');   // last-active starts now
	});

	await test('backfills a session whose meta lacks a sid, preserving a known user', async () => {
		withIp('9.9.9.9');
		const req = { sessionID: 'sidNew', session: { loggedIn: true, meta: { user: 'alice' } }, headers: { 'user-agent': 'UAx' } };
		Sessions.noteRequestMeta(req);
		assert.strictEqual(req.session.meta.sid, 'sidNew');
		assert.strictEqual(req.session.meta.user, 'alice');
	});

	await test('does not backfill a not-logged-in session, and never throws on odd input', async () => {
		withIp('1.2.3.4');
		const anon = { sessionID: 's', session: { loggedIn: false }, headers: {} };
		Sessions.noteRequestMeta(anon);
		assert.strictEqual(anon.session.meta, undefined);   // no meta for an unauthenticated session
		assert.doesNotThrow(() => Sessions.noteRequestMeta({}));
		assert.doesNotThrow(() => Sessions.noteRequestMeta(null));
	});

	console.log('\n' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
})();
