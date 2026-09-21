'use strict';

// Tests for the pure (DB-free) API-key helpers in libs/app/ApiKeys.js: generation, the
// format-dispatching parser (the future-proofing seam), scope-to-owner, constant-time
// verification, and the safe public projection. DB-backed create/resolve/list/revoke are
// exercised in the live/integration pass.

const assert = require('assert');
const ApiKeys = require('../../app/ApiKeys.js');
const Authz = require('../../app/Authz.js');

let passed = 0, failed = 0;
function test(name, fn) {
	try { fn(); passed++; console.log('  ok   - ' + name); }
	catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); }
}


console.log('\ngenerate / parseKey:');

test('generate produces symb_live_ prefix, hex secret, and a joined clear key', () => {
	const g = ApiKeys.generate();
	assert.ok(g.prefix.startsWith('symb_live_'), 'prefix head');
	assert.strictEqual(g.prefix.length, 'symb_live_'.length + 12, '12-hex prefix');
	assert.strictEqual(g.secret.length, 64, '64-hex secret');
	assert.strictEqual(g.clearKey, g.prefix + '_' + g.secret);
});

test('generate is unique each call', () => {
	assert.notStrictEqual(ApiKeys.generate().clearKey, ApiKeys.generate().clearKey);
});

test('parseKey round-trips a generated key', () => {
	const g = ApiKeys.generate();
	const p = ApiKeys.parseKey(g.clearKey);
	assert.strictEqual(p.prefix, g.prefix);
	assert.strictEqual(p.secret, g.secret);
});

test('parseKey dispatches on the format head (symb_test_ too) and rejects junk', () => {
	const g = ApiKeys.generate('symb_test_');
	assert.ok(g.prefix.startsWith('symb_test_'));
	assert.strictEqual(ApiKeys.parseKey(g.clearKey).prefix, g.prefix);
	assert.strictEqual(ApiKeys.parseKey('not-a-key'), null);
	assert.strictEqual(ApiKeys.parseKey('sk_live_abc_def'), null);       // foreign head
	assert.strictEqual(ApiKeys.parseKey('symb_live_onlyprefix'), null);  // no secret segment
	assert.strictEqual(ApiKeys.parseKey(null), null);
});


console.log('\nscopeCapabilities (key ⊆ owner):');

test('owner (*) lets a key take any requested capability', () => {
	const caps = ApiKeys.scopeCapabilities(['bot.write', 'deal.close'], ['*']);
	assert.deepStrictEqual(caps, ['bot.write', 'deal.close']);
});

test('a viewer owner cannot mint a write-capable key', () => {
	const ownerCaps = Authz.resolveCapabilities({ role: 'viewer' });
	const caps = ApiKeys.scopeCapabilities(['bot.write', 'stats.read'], ownerCaps);
	assert.ok(!caps.includes('bot.write'), 'write dropped — exceeds owner');
	assert.ok(caps.includes('stats.read'), 'read kept — within owner');
});

test('an operator owner keeps trade caps but not management', () => {
	const ownerCaps = Authz.resolveCapabilities({ role: 'operator' });
	const caps = ApiKeys.scopeCapabilities(['deal.close', 'user.invite'], ownerCaps);
	assert.ok(caps.includes('deal.close'));
	assert.ok(!caps.includes('user.invite'), 'management dropped — exceeds operator');
});


console.log('\nsecretMatchesHash (constant-time verify):');

test('correct secret matches, wrong secret does not', () => {
	const g = ApiKeys.generate();
	const crypto = require('crypto');
	const hash = crypto.createHash('sha256').update(g.secret).digest('hex');
	assert.ok(ApiKeys.secretMatchesHash(g.secret, hash));
	assert.ok(!ApiKeys.secretMatchesHash('wrong', hash));
	assert.ok(!ApiKeys.secretMatchesHash(g.secret, 'deadbeef'));   // length mismatch, no throw
});


console.log('\npublicView (never leaks the secret):');

test('publicView omits key_hash and never contains the raw secret', () => {
	const g = ApiKeys.generate();
	const crypto = require('crypto');
	const row = { key_id: 'k1', name: 'svc', prefix: g.prefix, key_hash: crypto.createHash('sha256').update(g.secret).digest('hex'),
		capabilities: ['stats.read'], signing: 'bearer', status: 'active', created_at: new Date() };
	const view = ApiKeys.publicView(row);
	assert.ok(!('key_hash' in view), 'no hash in projection');
	const json = JSON.stringify(view);
	assert.ok(json.indexOf(g.secret) < 0, 'secret never present');
	assert.ok(json.indexOf(row.key_hash) < 0, 'hash never present');
	assert.strictEqual(view.prefix, g.prefix);   // display handle is fine
});


console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
