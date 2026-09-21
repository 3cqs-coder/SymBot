'use strict';

// Tests for routeUtils.denyUnauthorized — the one shared "not authenticated" response the instance and
// Hub route layers now use in place of ~70 hand-copied deny branches. The behavior that matters: a plain
// browser navigation still gets the friendly 302 redirect to /login, while an API-key / token client, an
// XHR (the dashboard's own fetches), or a JSON client gets a clean 401 instead of an HTML redirect it can't
// act on. This is what fixes the "a scoped key works on one route but gets a 302 on another" class of bug.

const assert = require('assert');
const { denyUnauthorized } = require('../../webserver/routeUtils.js');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

// Minimal req/res doubles. req.accepts mirrors Express: given a browser Accept it prefers 'html', given
// */* or an explicit application/json it returns the first offered ('json').
function makeReq({ accept, xhr, headers }) {
	headers = headers || {};
	return {
		xhr: !!xhr,
		headers,
		accepts(types) {
			const a = String(accept || '');
			if (a.includes('text/html')) { return types.indexOf('html') !== -1 ? 'html' : types[0]; }
			return types[0];   // */* or application/json → first offered (json)
		}
	};
}
function makeRes() {
	const out = { redirected: null, status: null, body: null };
	return {
		out,
		redirect(loc) { out.redirected = loc; return this; },
		status(code) { out.status = code; return this; },
		json(obj) { out.body = obj; return this; }
	};
}

console.log('\ndenyUnauthorized:');

test('a plain browser navigation is redirected to /login (302, unchanged UX)', () => {
	const res = makeRes();
	denyUnauthorized(makeReq({ accept: 'text/html,application/xhtml+xml' }), res);
	assert.strictEqual(res.out.redirected, '/login', 'browser gets the login redirect');
	assert.strictEqual(res.out.status, null, 'no JSON status was set');
});

test('an XHR (dashboard fetch) gets a 401 JSON, not an HTML redirect', () => {
	const res = makeRes();
	denyUnauthorized(makeReq({ accept: '*/*', xhr: true }), res);
	assert.strictEqual(res.out.redirected, null, 'no redirect for an XHR');
	assert.strictEqual(res.out.status, 401);
	assert.deepStrictEqual(res.out.body, { success: false, error: 'Unauthorized' });
});

test('the X-Requested-With header alone marks an XHR → 401', () => {
	const res = makeRes();
	denyUnauthorized(makeReq({ accept: 'text/html', headers: { 'x-requested-with': 'XMLHttpRequest' } }), res);
	assert.strictEqual(res.out.status, 401, 'html Accept is overridden by the XHR signal');
	assert.strictEqual(res.out.redirected, null);
});

test('an API-key client gets a 401 even if it (mis)sends an HTML Accept', () => {
	const res = makeRes();
	denyUnauthorized(makeReq({ accept: 'text/html', headers: { 'api-key': 'abc:def' } }), res);
	assert.strictEqual(res.out.status, 401, 'a credential-bearing client is never HTML-redirected');
	assert.strictEqual(res.out.redirected, null);
});

test('a webhook api-token client gets a 401', () => {
	const res = makeRes();
	denyUnauthorized(makeReq({ accept: 'text/html', headers: { 'api-token': 'tok' } }), res);
	assert.strictEqual(res.out.status, 401);
});

test('a plain JSON / curl client (Accept */*) gets a 401, not a redirect', () => {
	const res = makeRes();
	denyUnauthorized(makeReq({ accept: '*/*' }), res);
	assert.strictEqual(res.out.status, 401);
	assert.strictEqual(res.out.redirected, null);
});

test('a malformed req (no accepts fn) fails safe to 401, never throws', () => {
	const res = makeRes();
	assert.doesNotThrow(() => denyUnauthorized({ headers: {} }, res));
	assert.strictEqual(res.out.status, 401);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
