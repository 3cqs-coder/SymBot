'use strict';

// The routes shared by the instance and Hub web servers (libs/webserver/sharedRoutes.js) — the in-app Help
// guide plus session view/revoke — registered from ONE module so the two surfaces can never drift. These
// tests pin: all four routes register, and the revoke handler's input hardening holds — a non-string sid is
// rejected and never reaches the store (closing the operator-injection / self-guard-bypass path), and a
// request to revoke your OWN current session is refused (that is a logout, not a revoke).

const assert = require('assert');
const SharedRoutes = require('../../webserver/sharedRoutes.js');

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

// Minimal router that captures the final handler for each METHOD+path.
function makeRouter() {
	const routes = {};
	const add = (method) => (path, ...handlers) => { routes[method + ' ' + path] = handlers[handlers.length - 1]; };
	return { get: add('GET'), post: add('POST'), _routes: routes };
}
function makeRes() {
	const r = { statusCode: 200, body: null };
	r.status = (c) => { r.statusCode = c; return r; };
	r.json = (o) => { r.body = o; return r; };
	r.type = () => r; r.set = () => r; r.sendFile = () => r;
	return r;
}

(async () => {

	console.log('\nSharedRoutes (instance + Hub session/guide routes):');

	let revokedWith = 'UNSET';   // records what the store's revoke() actually received
	const deps = {
		cap: () => (req, res, next) => next(),   // passthrough guard for the handler-level test
		shareData: {
			Sessions: {
				list: async () => ({ supported: true, sessions: [] }),
				revoke: async (sid) => { revokedWith = sid; return true; },
				revokeAllExcept: async () => 0
			},
			Common: { auditEvent: () => {} }
		},
		sendErr: (res, e) => { res.status(500).json({ success: false, error: String((e && e.message) || e) }); },
		denyUnauthorized: (req, res) => { res.status(401).json({ success: false }); },
		isAuthed: () => true,
		readmeFile: '/nonexistent/README.md'
	};

	const router = makeRouter();
	SharedRoutes.register(router, deps);

	await test('registers all shared routes', () => {
		for (const key of [ 'GET /readme.md', 'GET /api/sessions', 'POST /api/sessions/revoke', 'POST /api/sessions/revoke-others', 'GET /logout', 'GET /api/authz/capabilities' ]) {
			assert.ok(typeof router._routes[key] === 'function', 'missing route: ' + key);
		}
	});

	const revoke = router._routes['POST /api/sessions/revoke'];

	await test('a non-string sid is rejected and never reaches the store', async () => {
		revokedWith = 'UNSET';
		const res = makeRes();
		await revoke({ body: { sid: { $gt: '' } }, sessionID: 'cur' }, res);
		assert.strictEqual(res.statusCode, 400, 'object sid should 400');
		assert.strictEqual(revokedWith, 'UNSET', 'store.revoke must not be called with a non-string sid');
	});

	await test('an empty sid is rejected', async () => {
		revokedWith = 'UNSET';
		const res = makeRes();
		await revoke({ body: {}, sessionID: 'cur' }, res);
		assert.strictEqual(res.statusCode, 400);
		assert.strictEqual(revokedWith, 'UNSET');
	});

	await test('revoking your OWN current session is refused (use logout)', async () => {
		revokedWith = 'UNSET';
		const res = makeRes();
		await revoke({ body: { sid: 'cur' }, sessionID: 'cur' }, res);
		assert.strictEqual(res.statusCode, 400);
		assert.ok(res.body && res.body.self === true, 'should flag self:true');
		assert.strictEqual(revokedWith, 'UNSET', 'must not destroy the current session');
	});

	await test('a valid other-session sid is revoked', async () => {
		revokedWith = 'UNSET';
		const res = makeRes();
		await revoke({ body: { sid: 'other-sid' }, sessionID: 'cur' }, res);
		assert.strictEqual(res.statusCode, 200);
		assert.ok(res.body && res.body.success === true);
		assert.strictEqual(revokedWith, 'other-sid', 'the string sid reaches the store');
	});

	console.log('\nSharedRoutes: ' + passed + ' passed' + (failed ? (', ' + failed + ' failed') : ''));
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
