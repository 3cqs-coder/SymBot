'use strict';

// The bootstrap middleware shared by the instance and Hub web servers (libs/webserver/sharedMiddleware.js).
// This is the request-authorization pipeline (the webhook path that fires trades authenticates through the same
// principal resolution + capability enforcement), so it is pinned hard here. Each middleware is driven with mock
// req/res/next; no server is started.

const assert = require('assert');
const Mw = require('../../webserver/sharedMiddleware.js');

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

function makeRes() {
	const r = { statusCode: 200, sent: false, body: null };
	r.status = (c) => { r.statusCode = c; return r; };
	r.send = (b) => { r.sent = true; r.body = b; return r; };
	r.json = (o) => { r.sent = true; r.body = o; return r; };
	return r;
}
// Run one middleware; resolves { res, nexted } once it settles (handles sync and async middleware).
function run(mw, req) {
	return new Promise((resolve) => {
		const res = makeRes();
		let nexted = false;
		const ret = mw(req, res, () => { nexted = true; });
		Promise.resolve(ret).then(() => resolve({ res, nexted }));
	});
}
// A sendErr like routeUtils.sendErr: it writes the response and returns (the middleware `return sendErr(...)`s).
const sendErr = (res, msg, code) => { res.status(code || 500).json({ success: false, error: msg }); };

function makeShare(opts) {
	opts = opts || {};
	return {
		appData: opts.appData || {},
		Common: { auditEvent: () => {}, stripMongoOperators: opts.strip || (() => {}) },
		Sessions: opts.Sessions,
		AuthMiddleware: opts.AuthMiddleware,
		Authz: opts.Authz || { can: () => true },
		RoutePermissions: opts.RP || {}
	};
}

(async () => {

	console.log('\nShared bootstrap middleware:');

	// ── MUTATING_METHOD ──
	await test('MUTATING_METHOD marks write methods and not GET', () => {
		assert.ok(Mw.MUTATING_METHOD.POST && Mw.MUTATING_METHOD.PUT && Mw.MUTATING_METHOD.PATCH && Mw.MUTATING_METHOD.DELETE);
		assert.ok(!Mw.MUTATING_METHOD.GET);
	});

	// ── capabilityEnforcement ──
	const capMw = (opts) => Mw.capabilityEnforcement(makeShare(opts), { resolveInlineGuard: () => ((m, p) => !!opts.inline), sendErr });

	await test('mapped route: principal HAS the capability -> next()', async () => {
		const { res, nexted } = await run(capMw({ RP: { required: () => 'bot.write' }, Authz: { can: () => true } }), { method: 'POST', path: '/x', principal: { capabilities: ['bot.write'] } });
		assert.ok(nexted && !res.sent, 'should pass through');
	});

	await test('mapped route: principal LACKS the capability -> 403', async () => {
		const { res, nexted } = await run(capMw({ RP: { required: () => 'bot.write' }, Authz: { can: () => false } }), { method: 'POST', path: '/x', principal: { capabilities: ['bot.read'] } });
		assert.ok(!nexted && res.statusCode === 403, 'should 403');
	});

	await test('de-provisioned session (loggedIn + userId, null principal) -> 401', async () => {
		const { res, nexted } = await run(capMw({ RP: { required: () => null } }), { method: 'GET', path: '/x', session: { loggedIn: true, userId: 'u1' }, principal: null });
		assert.ok(!nexted && res.statusCode === 401, 'should 401');
	});

	await test('unmapped MUTATING route + scoped principal + not public + not inline -> 403 (default-deny)', async () => {
		const { res, nexted } = await run(capMw({ RP: { required: () => null, isPublic: () => false }, inline: false }), { method: 'POST', path: '/new-write', principal: { capabilities: ['bot.read'] } });
		assert.ok(!nexted && res.statusCode === 403, 'unmapped write should fail closed for a scoped key');
	});

	await test('unmapped MUTATING route + OWNER principal (["*"]) -> next()', async () => {
		const { res, nexted } = await run(capMw({ RP: { required: () => null, isPublic: () => false }, inline: false }), { method: 'POST', path: '/new-write', principal: { capabilities: ['*'] } });
		assert.ok(nexted && !res.sent, 'owner always passes');
	});

	await test('unmapped MUTATING route that IS inline-guarded -> next() (passed to its own guard)', async () => {
		const { res, nexted } = await run(capMw({ RP: { required: () => null, isPublic: () => false }, inline: true }), { method: 'POST', path: '/inline-gated', principal: { capabilities: ['bot.read'] } });
		assert.ok(nexted && !res.sent, 'inline-gated route must reach its own guard');
	});

	await test('unmapped MUTATING route that is PUBLIC -> next() (webhook/login do own auth)', async () => {
		const { res, nexted } = await run(capMw({ RP: { required: () => null, isPublic: () => true }, inline: false }), { method: 'POST', path: '/webhook/api/bots/x', principal: { capabilities: ['bot.read'] } });
		assert.ok(nexted && !res.sent, 'public route must pass through');
	});

	await test('unauthenticated request (no principal) on a mapped route -> next() (left to route gate)', async () => {
		const { res, nexted } = await run(capMw({ RP: { required: () => 'bot.write' } }), { method: 'POST', path: '/x' });
		assert.ok(nexted && !res.sent, 'no principal -> route handles its own auth');
	});

	await test('unmapped GET (non-mutating) + scoped principal -> next() (default-deny is write-only)', async () => {
		const { res, nexted } = await run(capMw({ RP: { required: () => null, isPublic: () => false }, inline: false }), { method: 'GET', path: '/read', principal: { capabilities: ['bot.read'] } });
		assert.ok(nexted && !res.sent, 'reads are not default-denied');
	});

	await test('enforcement ERROR on a mapped route with a principal -> 403 (fail closed)', async () => {
		const throwingAuthz = { can: () => { throw new Error('boom'); } };
		const { res, nexted } = await run(capMw({ RP: { required: () => 'bot.write' }, Authz: throwingAuthz }), { method: 'POST', path: '/x', principal: { capabilities: ['bot.write'] } });
		assert.ok(!nexted && res.statusCode === 403, 'must fail closed when the check itself errors on a mapped+principal request');
	});

	// ── stripMongoOperators ──
	await test('stripMongoOperators sanitizes body/query/params and always next()s', async () => {
		let calls = 0;
		const { nexted } = await run(Mw.stripMongoOperators(makeShare({ strip: () => { calls++; } })), { body: {}, query: {}, params: {} });
		assert.ok(nexted && calls === 3, 'should strip all three and continue');
	});
	await test('stripMongoOperators never fails the request even if the stripper throws', async () => {
		const { nexted } = await run(Mw.stripMongoOperators(makeShare({ strip: () => { throw new Error('x'); } })), { body: {}, query: {}, params: {} });
		assert.ok(nexted, 'defensive: still next()s');
	});

	// ── attachPrincipal ──
	await test('attachPrincipal sets req.principal from resolvePrincipal', async () => {
		const req = { method: 'GET', path: '/x' };
		const { nexted } = await run(Mw.attachPrincipal(makeShare({ AuthMiddleware: { resolvePrincipal: async () => ({ capabilities: ['*'] }) } })), req);
		assert.ok(nexted && req.principal && req.principal.capabilities[0] === '*');
	});
	await test('attachPrincipal sets null and continues if resolvePrincipal throws', async () => {
		const req = { method: 'GET', path: '/x' };
		const { nexted } = await run(Mw.attachPrincipal(makeShare({ AuthMiddleware: { resolvePrincipal: async () => { throw new Error('x'); } } })), req);
		assert.ok(nexted && req.principal === null);
	});

	// ── noteRequestMeta ──
	await test('noteRequestMeta calls Sessions.noteRequestMeta and continues', async () => {
		let noted = false;
		const { nexted } = await run(Mw.noteRequestMeta(makeShare({ Sessions: { noteRequestMeta: () => { noted = true; } } })), { method: 'GET', path: '/x' });
		assert.ok(nexted && noted);
	});
	await test('noteRequestMeta is a no-op (still next) when Sessions is absent', async () => {
		const { nexted } = await run(Mw.noteRequestMeta(makeShare({})), { method: 'GET', path: '/x' });
		assert.ok(nexted);
	});

	// ── ipFilter ── (uses the real IpFilter engine)
	await test('ipFilter passes through when the filter is disabled', async () => {
		const { res, nexted } = await run(Mw.ipFilter(makeShare({ appData: {} })), { ip: '9.9.9.9' });
		assert.ok(nexted && !res.sent);
	});
	await test('ipFilter denies a blocklisted IP with 403', async () => {
		const share = makeShare({ appData: { ip_filter: { server: { enabled: true, allowlist: [], blocklist: ['9.9.9.9'] } } }, AuthMiddleware: { clientIp: () => '9.9.9.9' } });
		const { res, nexted } = await run(Mw.ipFilter(share), {});
		assert.ok(!nexted && res.statusCode === 403, 'blocklisted IP should be denied');
	});
	await test('ipFilter always allows loopback even with a filter enabled', async () => {
		const share = makeShare({ appData: { ip_filter: { server: { enabled: true, allowlist: ['1.2.3.4'], blocklist: [] } } }, AuthMiddleware: { clientIp: () => '127.0.0.1' } });
		const { res, nexted } = await run(Mw.ipFilter(share), {});
		assert.ok(nexted && !res.sent, 'loopback is never locked out');
	});

	// ── makeInlineGuardResolver ── (lazy + memoized)
	await test('makeInlineGuardResolver builds lazily once and memoizes', async () => {
		let builds = 0;
		const share = makeShare({ RP: { buildInlineGuardMatcher: () => { builds++; return (m, p) => true; } } });
		const resolve = Mw.makeInlineGuardResolver(share, {});
		const a = resolve(); const b = resolve();
		assert.ok(builds === 1 && a === b && a('POST', '/x') === true, 'built once, same matcher, works');
	});

	console.log('\nSharedMiddleware: ' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
