'use strict';

// Tests for libs/app/AuthMiddleware.js — the enforcement seam. The critical properties:
// a legacy single-password session resolves to the implicit OWNER (never locked out); an
// API key resolves to its scoped principal; guards are deny-by-default and content-negotiate
// 401/403 vs redirect.

const assert = require('assert');
const Authz = require('../../app/Authz.js');
const Auth = require('../../app/AuthMiddleware.js');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }
async function testAsync(name, fn) { try { await fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

// A fake shareData: API key 'GOODKEY' resolves to a read-only scoped principal; user 'u-op'
// is an active operator.
function wire(apiEnabled) {
	Auth.init({
		appData: { api_enabled: apiEnabled !== false },
		ApiKeys: { resolve: async (key) => key === 'GOODKEY' ? Authz.makePrincipal({ id: 'k1', kind: 'apikey', apiKeyId: 'k1', capabilities: ['stats.read', 'bot.read'] }) : null },
		Users:   { getById: async (id) => id === 'u-op' ? { user_id: 'u-op', role: 'operator', grants: [], status: 'active' } : null,
		           toPrincipal: (u) => Authz.makePrincipal({ id: u.user_id, kind: 'user', role: u.role, grants: u.grants }) }
	});
}

function mockRes() {
	return { _status: 200, _json: null, _redirect: null,
		status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; }, redirect(u) { this._redirect = u; return this; } };
}


(async () => {

	console.log('\nresolvePrincipal:');

	await testAsync('legacy loggedIn session (no userId) → implicit OWNER (never locked out)', async () => {
		wire();
		const p = await Auth.resolvePrincipal({ session: { loggedIn: true } });
		assert.ok(p && Authz.can(p, 'settings.write') && Authz.can(p, 'deal.close'), 'owner has full access');
	});

	await testAsync('session userId → the user\'s role principal', async () => {
		wire();
		const p = await Auth.resolvePrincipal({ session: { userId: 'u-op' } });
		assert.ok(Authz.can(p, 'deal.close'), 'operator can act');
		assert.ok(!Authz.can(p, 'settings.write'), 'operator cannot change settings');
	});

	await testAsync('session with a userId that no longer resolves (disabled/deleted) is DENIED, not upgraded to owner', async () => {
		wire();
		const p = await Auth.resolvePrincipal({ session: { loggedIn: true, userId: 'u-gone' } });
		assert.strictEqual(p, null, 'a de-provisioned user with a live session must not become owner');
	});

	await testAsync('a valid API key resolves to its scoped principal', async () => {
		wire();
		const p = await Auth.resolvePrincipal({ headers: { 'api-key': 'GOODKEY' } });
		assert.strictEqual(p.kind, 'apikey');
		assert.ok(Authz.can(p, 'stats.read'));
		assert.ok(!Authz.can(p, 'bot.write'), 'read-only key cannot act');
	});

	await testAsync('an API key is ignored when the API is disabled', async () => {
		wire(false);
		const p = await Auth.resolvePrincipal({ headers: { 'api-key': 'GOODKEY' } });
		assert.strictEqual(p, null);
	});

	await testAsync('a bad key + no session → null (anonymous)', async () => {
		wire();
		assert.strictEqual(await Auth.resolvePrincipal({ headers: { 'api-key': 'nope' }, session: {} }), null);
	});

	await testAsync('Bearer header is accepted', async () => {
		wire();
		const p = await Auth.resolvePrincipal({ headers: { authorization: 'Bearer GOODKEY' } });
		assert.ok(p && p.kind === 'apikey');
	});


	console.log('\nguards (deny by default, content-negotiated):');

	await testAsync('requireCap allows the owner, denies a read-only key with 403', async () => {
		wire();
		// owner path
		let req = { session: { loggedIn: true }, headers: {}, path: '/api/x' };
		req.principal = await Auth.resolvePrincipal(req);
		let res = mockRes(); let nexted = false;
		Auth.requireCap('deal.close')(req, res, () => { nexted = true; });
		assert.ok(nexted, 'owner passes');

		// read-only key path
		let req2 = { headers: { 'api-key': 'GOODKEY' }, path: '/api/x' };
		req2.principal = await Auth.resolvePrincipal(req2);
		let res2 = mockRes(); let nexted2 = false;
		Auth.requireCap('deal.close')(req2, res2, () => { nexted2 = true; });
		assert.ok(!nexted2, 'read-only key blocked');
		assert.strictEqual(res2._status, 403, 'authenticated-but-forbidden → 403');
		assert.ok(res2._json && /permission/i.test(res2._json.error));
	});

	await testAsync('no principal on an API path → 401 JSON; on a browser path → redirect', async () => {
		wire();
		let apiRes = mockRes();
		Auth.requireAuth({ path: '/api/schedules', headers: {} }, apiRes, () => {});
		assert.strictEqual(apiRes._status, 401);

		let webRes = mockRes();
		Auth.requireAuth({ path: '/dashboard', headers: { accept: 'text/html' } }, webRes, () => {});
		assert.strictEqual(webRes._redirect, '/login');
	});

	await testAsync('can() is an inline boolean that never responds', async () => {
		wire();
		const req = { session: { loggedIn: true } };
		req.principal = await Auth.resolvePrincipal(req);
		assert.strictEqual(Auth.can(req, 'bot.delete'), true);
		assert.strictEqual(Auth.can({ principal: null }, 'bot.read'), false);
	});


	console.log('\nlegacy webhook api-token → scoped principal (unification):');

	function wireWebhook() {
		Auth.init({ appData: { webhook_enabled: true, api_token: 'secret-token' }, Authz, Common: require('../../app/Common.js') });
	}

	await testAsync('a matching webhook api-token resolves to the scoped webhook principal', async () => {
		wireWebhook();
		const p = await Auth.resolvePrincipal({ headers: { 'api-token': 'secret-token' } });
		assert.ok(p, 'a valid token produces a principal');
		assert.strictEqual(p.apiKeyId, 'legacy-webhook', 'attributed as the legacy webhook token in audit');
		// A webhook is a signal source: it may open / fund / pause / close deals…
		assert.ok(Authz.can(p, 'deal.create') && Authz.can(p, 'deal.pause') && Authz.can(p, 'deal.close'), 'deal (signal) actions reachable');
		// …but NOTHING else. A leaked webhook token must not be able to edit bot config, toggle
		// sandbox/live, start/stop bots, or read the book — it is confined to deal actions. Anything
		// broader requires a scoped API key.
		assert.ok(!Authz.can(p, 'bot.write') && !Authz.can(p, 'bot.start') && !Authz.can(p, 'bot.stop') && !Authz.can(p, 'bot.read'), 'bot management/read are out of reach');
		assert.ok(!Authz.can(p, 'bot.create') && !Authz.can(p, 'bot.delete') && !Authz.can(p, 'settings.write') && !Authz.can(p, 'account.read') && !Authz.can(p, 'stats.read'), 'config/read caps are out of reach (least privilege)');
		assert.ok(!Authz.can(p, 'apikey.create') && !Authz.can(p, 'user.invite') && !Authz.can(p, 'audit.read') && !Authz.can(p, 'instance.manage'), 'access-control stays out of reach');
	});

	await testAsync('a wrong webhook token resolves to no principal', async () => {
		wireWebhook();
		const p = await Auth.resolvePrincipal({ headers: { 'api-token': 'WRONG' } });
		assert.strictEqual(p, null, 'a bad token must not authenticate');
	});

	await testAsync('the webhook token is ignored when webhooks are disabled', async () => {
		Auth.init({ appData: { webhook_enabled: false, api_token: 'secret-token' }, Authz, Common: require('../../app/Common.js') });
		const p = await Auth.resolvePrincipal({ headers: { 'api-token': 'secret-token' } });
		assert.strictEqual(p, null, 'no webhook principal when webhook_enabled is false');
	});


	console.log('\n' + passed + ' passed, ' + failed + ' failed');
	process.exit(failed ? 1 : 0);
})();
