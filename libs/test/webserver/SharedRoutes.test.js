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
			Common: { auditEvent: () => {} },
			// One scoped key, so the whoami enrichment lookup (list → find by key_id) has something to match.
			ApiKeys: { list: async () => ([ { key_id: 'k1', name: 'CI Key', capabilities: [ 'deal.create' ], rate_limit: 60, ip_allowlist: [ '1.2.3.4' ], expires_at: '2099-01-01', signing: 'bearer' } ]) }
		},
		sendErr: (res, e) => { res.status(500).json({ success: false, error: String((e && e.message) || e) }); },
		denyUnauthorized: (req, res) => { res.status(401).json({ success: false }); },
		isAuthed: () => true,
		readmeFile: '/nonexistent/README.md'
	};

	const router = makeRouter();
	SharedRoutes.register(router, deps);

	await test('registers all shared routes', () => {
		for (const key of [ 'GET /readme.md', 'GET /api/whoami', 'GET /api/sessions', 'POST /api/sessions/revoke', 'POST /api/sessions/revoke-others', 'GET /logout', 'GET /api/authz/capabilities' ]) {
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

	// ── Credential self-test (GET /api/whoami) ────────────────────────────────────────────────────────
	const whoami = router._routes['GET /api/whoami'];

	await test('whoami returns the apikey principal, enriched from the key store, with no secret', async () => {
		const res = makeRes();
		await whoami({ principal: { kind: 'apikey', apiKeyId: 'k1', capabilities: [ 'deal.create' ], rateLimit: 60 } }, res);
		assert.strictEqual(res.statusCode, 200);
		const b = res.body || {};
		assert.strictEqual(b.valid, true);
		assert.strictEqual(b.kind, 'apikey');
		assert.deepStrictEqual(b.capabilities, [ 'deal.create' ]);
		assert.strictEqual(b.rate_limit, 60);
		assert.strictEqual(b.name, 'CI Key', 'name enriched from the key store lookup');
		assert.strictEqual(b.expires_at, '2099-01-01');
		assert.strictEqual(b.ip_scoped, true, 'a non-empty ip_allowlist reports ip_scoped:true');
		assert.ok(!/hash|secret|clearkey|key_hash/i.test(JSON.stringify(b)), 'whoami must never expose a secret');
	});

	await test('whoami returns the owner shape for a session principal, without key enrichment', async () => {
		const res = makeRes();
		await whoami({ principal: { kind: 'user', id: 'owner', capabilities: [ '*' ] } }, res);
		assert.strictEqual(res.statusCode, 200);
		assert.strictEqual(res.body.kind, 'user');
		assert.deepStrictEqual(res.body.capabilities, [ '*' ]);
		assert.strictEqual(res.body.rate_limit, null);
		assert.ok(!('name' in res.body), 'a user principal carries no key metadata');
	});

	await test('whoami on an unauthenticated request is denied (401)', async () => {
		// A second registration whose isAuthed → false, so the gate rejects before any principal is read.
		const r2 = makeRouter();
		SharedRoutes.register(r2, Object.assign({}, deps, { isAuthed: () => false, denyUnauthorized: (req, res) => res.status(401).json({ success: false }) }));
		const res = makeRes();
		await r2._routes['GET /api/whoami']({}, res);
		assert.strictEqual(res.statusCode, 401);
	});

	console.log('\nSharedRoutes: ' + passed + ' passed' + (failed ? (', ' + failed + ' failed') : ''));
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
