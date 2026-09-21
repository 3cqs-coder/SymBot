'use strict';

// Tests for libs/app/Audit.js pure helpers (actor + IP resolution) and the critical
// never-throw guarantee: an audit write must never break the request it audits.

const assert = require('assert');
const Audit = require('../../app/Audit.js');

let passed = 0, failed = 0;
function test(name, fn) {
	try { fn(); passed++; console.log('  ok   - ' + name); }
	catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); }
}


console.log('\nresolveActor:');

test('a bare string actor is used as-is', () => { assert.strictEqual(Audit.resolveActor('system'), 'system'); });
test('a request with a user principal → user:<id>', () => {
	assert.strictEqual(Audit.resolveActor({ principal: { kind: 'user', id: 'u-1' } }), 'user:u-1');
});
test('a request with an api-key principal → apikey:<id>', () => {
	assert.strictEqual(Audit.resolveActor({ principal: { kind: 'apikey', apiKeyId: 'k-9' } }), 'apikey:k-9');
});
test('a bare principal object works too', () => {
	assert.strictEqual(Audit.resolveActor({ kind: 'user', id: 'owner' }), 'user:owner');
});
test('a legacy loggedIn session with no principal reads as the implicit owner', () => {
	assert.strictEqual(Audit.resolveActor({ session: { loggedIn: true } }), 'user:owner');
});
test('an unauthenticated request reads as anonymous', () => {
	assert.strictEqual(Audit.resolveActor({ session: {} }), 'anonymous');
});


console.log('\nresolveIp:');

test('explicit ip wins', () => { assert.strictEqual(Audit.resolveIp({}, '1.2.3.4'), '1.2.3.4'); });
test('cf-connecting-ip is preferred', () => {
	assert.strictEqual(Audit.resolveIp({ headers: { 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '8.8.8.8' } }), '9.9.9.9');
});
test('first x-forwarded-for hop is used', () => {
	assert.strictEqual(Audit.resolveIp({ headers: { 'x-forwarded-for': '8.8.8.8, 10.0.0.1' } }), '8.8.8.8');
});
test('falls back to req.ip', () => {
	assert.strictEqual(Audit.resolveIp({ headers: {}, ip: '7.7.7.7' }), '7.7.7.7');
});


console.log('\naudit() never throws:');

test('audit() returns without throwing even with no DB / before init', () => {
	assert.doesNotThrow(() => {
		const r = Audit.audit('user:test', 'test.action', 'target-1', 'a note');
		assert.strictEqual(r, true);
	});
});
test('audit() tolerates a malformed actor', () => {
	assert.doesNotThrow(() => Audit.audit(undefined, 'x.y'));
	assert.doesNotThrow(() => Audit.audit(12345, 'x.y'));
});


console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
