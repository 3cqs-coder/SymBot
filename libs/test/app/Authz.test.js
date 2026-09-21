'use strict';

// Tests for the central authorization core (libs/app/Authz.js).
//
// The load-bearing invariant is SAFETY: deny-by-default, a read-only (viewer) principal can
// never hold a trade/write/manage capability, and resource scoping restricts rather than
// widens. Also pins the capability/role vocabulary and the write-implies-read / wildcard
// matching the whole app relies on.

const assert = require('assert');
const Authz = require('../../app/Authz.js');

let passed = 0, failed = 0;
function test(name, fn) {
	try { fn(); passed++; console.log('  ok   - ' + name); }
	catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); }
}


console.log('\nVocabulary:');

test('every capability is a two-segment resource.action with a label', () => {
	Authz.CAPABILITIES.forEach(c => {
		assert.ok(c.key && typeof c.key === 'string', 'has key');
		assert.strictEqual(c.key.split('.').length, 2, 'two segments: ' + c.key);
		assert.ok(c.label && typeof c.label === 'string', 'has label: ' + c.key);
	});
});


console.log('\ngrantSatisfies / hasCapability:');

test('exact match', () => { assert.ok(Authz.grantSatisfies('bot.write', 'bot.write')); });
test('super-wildcard * satisfies anything', () => { assert.ok(Authz.grantSatisfies('*', 'deal.close')); });
test('resource wildcard bot.* satisfies bot.write', () => { assert.ok(Authz.grantSatisfies('bot.*', 'bot.write')); });
test('resource wildcard does NOT cross resources', () => { assert.ok(!Authz.grantSatisfies('bot.*', 'deal.close')); });
test('write implies read', () => { assert.ok(Authz.grantSatisfies('bot.write', 'bot.read')); });
test('read does NOT imply write', () => { assert.ok(!Authz.grantSatisfies('bot.read', 'bot.write')); });
test('unrelated caps do not match', () => { assert.ok(!Authz.grantSatisfies('deal.read', 'bot.write')); });
test('hasCapability works over an array and a Set', () => {
	assert.ok(Authz.hasCapability(['stats.read', 'bot.write'], 'bot.read'));  // via write-implies-read
	assert.ok(Authz.hasCapability(new Set(['deal.close']), 'deal.close'));
	assert.ok(!Authz.hasCapability(['stats.read'], 'bot.write'));
});


console.log('\nresolveCapabilities & roles:');

test('viewer is read-only — no write/trade/manage capabilities', () => {
	const caps = Authz.resolveCapabilities({ role: 'viewer' });
	assert.ok(caps.length > 0);
	caps.forEach(c => assert.ok(c.endsWith('.read'), 'viewer must be read-only, saw: ' + c));
	['bot.write','bot.start','deal.create','deal.close','settings.write','apikey.create','user.invite']
		.forEach(w => assert.ok(!Authz.hasCapability(caps, w), 'viewer must NOT have ' + w));
});

test('operator adds trade/bot actions but not management', () => {
	const caps = Authz.resolveCapabilities({ role: 'operator' });
	['bot.read','deal.close','bot.start','deal.create'].forEach(c => assert.ok(Authz.hasCapability(caps, c), 'operator has ' + c));
	['bot.delete','settings.write','apikey.create','user.invite'].forEach(c => assert.ok(!Authz.hasCapability(caps, c), 'operator must NOT have ' + c));
});

test('the legacy webhook token is scoped to deal actions ONLY — not bot management or reads', () => {
	// A webhook is a signal source: it opens / funds / pauses / closes deals and nothing else. A leaked
	// legacy token must therefore be unable to edit bot config, toggle sandbox/live, or read the book.
	const p = Authz.webhookPrincipal();
	assert.ok(p && Array.isArray(p.capabilities), 'webhook principal exposes capabilities');
	[ 'deal.create', 'deal.pause', 'deal.close' ].forEach(c => assert.ok(Authz.hasCapability(p.capabilities, c), 'webhook token must have ' + c));
	[ 'bot.write', 'bot.start', 'bot.stop', 'bot.create', 'bot.delete', 'settings.write', 'account.read', 'stats.read', 'apikey.create' ]
		.forEach(c => assert.ok(!Authz.hasCapability(p.capabilities, c), 'webhook token must NOT have ' + c));
});

test('admin adds management but is not owner-all', () => {
	const caps = Authz.resolveCapabilities({ role: 'admin' });
	['bot.create','settings.write','apikey.create','user.invite'].forEach(c => assert.ok(Authz.hasCapability(caps, c), 'admin has ' + c));
	assert.ok(!Authz.hasCapability(caps, 'user.manage'), 'admin should not manage roles unless granted');
	assert.ok(!Authz.hasCapability(caps, 'instance.manage'), 'admin is not owner');
});

test('audit.read is an admin surface — admin/owner only, not viewer/operator', () => {
	assert.ok(Authz.hasCapability(Authz.resolveCapabilities({ role: 'admin' }), 'audit.read'), 'admin sees audit');
	assert.ok(Authz.hasCapability(Authz.resolveCapabilities({ role: 'owner' }), 'audit.read'), 'owner sees audit');
	assert.ok(!Authz.hasCapability(Authz.resolveCapabilities({ role: 'viewer' }), 'audit.read'), 'viewer must not see audit');
	assert.ok(!Authz.hasCapability(Authz.resolveCapabilities({ role: 'operator' }), 'audit.read'), 'operator must not see audit');
});

test('owner is *', () => {
	const caps = Authz.resolveCapabilities({ role: 'owner' });
	assert.deepStrictEqual(caps, ['*']);
	assert.ok(Authz.hasCapability(caps, 'anything.at.all'.split('.').slice(0,2).join('.')));
});

test('explicit grants are filtered to real capabilities (typos rejected)', () => {
	const caps = Authz.resolveCapabilities({ role: 'viewer', grants: ['bot.write', 'bot.delete', 'not.real', 'bogus'] });
	assert.ok(Authz.hasCapability(caps, 'bot.write'));
	assert.ok(Authz.hasCapability(caps, 'bot.delete'));
	assert.ok(!caps.includes('not.real'), 'typo grant must be dropped');
	assert.ok(!caps.includes('bogus'));
});

test('a resource wildcard grant is accepted', () => {
	const caps = Authz.resolveCapabilities({ grants: ['bot.*'] });
	assert.ok(Authz.hasCapability(caps, 'bot.delete'));
	assert.ok(!Authz.hasCapability(caps, 'deal.close'));
});

test('ladder ranks and roleAtLeast', () => {
	assert.ok(Authz.roleAtLeast('admin', 'operator'));
	assert.ok(Authz.roleAtLeast('owner', 'owner'));
	assert.ok(!Authz.roleAtLeast('viewer', 'operator'));
	assert.strictEqual(Authz.DEFAULT_ROLE, 'viewer');   // least-privilege default
});


console.log('\ncan() — the gate:');

test('deny by default (empty principal)', () => {
	assert.ok(!Authz.can(Authz.makePrincipal({}), 'bot.read'));
	assert.ok(!Authz.can(null, 'bot.read'));
});

test('capability match allows', () => {
	const p = Authz.makePrincipal({ role: 'operator' });
	assert.ok(Authz.can(p, 'deal.close'));
	assert.ok(Authz.can(p, 'bot.read'));
	assert.ok(!Authz.can(p, 'bot.delete'));
});

test('owner principal can do everything', () => {
	const p = Authz.ownerPrincipal();
	['bot.delete','settings.write','user.manage','instance.manage','deal.close'].forEach(c => assert.ok(Authz.can(p, c), 'owner can ' + c));
});

test('an API-key principal carries its own scoped capabilities', () => {
	const p = Authz.makePrincipal({ kind: 'apikey', apiKeyId: 'k1', capabilities: ['stats.read', 'bot.read'] });
	assert.strictEqual(p.kind, 'apikey');
	assert.strictEqual(p.apiKeyId, 'k1');
	assert.ok(Authz.can(p, 'stats.read'));
	assert.ok(!Authz.can(p, 'bot.write'), 'a read-only key must not be able to act');
});

test('resource scope: blanket allow when unscoped', () => {
	const p = Authz.makePrincipal({ role: 'operator' });   // no resourceScopes
	assert.ok(Authz.can(p, 'bot.stop', 'bot-42'));
});

test('resource scope: scoped principal allowed only for in-scope ids', () => {
	const p = Authz.makePrincipal({ capabilities: ['bot.write'], resourceScopes: { bot: new Set(['bot-42']) } });
	assert.ok(Authz.can(p, 'bot.write', 'bot-42'), 'in-scope allowed');
	assert.ok(!Authz.can(p, 'bot.write', 'bot-99'), 'out-of-scope denied');
	assert.ok(!Authz.can(p, 'bot.write'), 'scoped but no id → cannot prove scope → deny');
});

test('resource scope on one resource does not restrict another', () => {
	const p = Authz.makePrincipal({ capabilities: ['bot.write', 'deal.close'], resourceScopes: { bot: new Set(['bot-1']) } });
	assert.ok(Authz.can(p, 'deal.close', 'deal-7'), 'deal is unscoped → allowed');
	assert.ok(!Authz.can(p, 'bot.write', 'bot-7'), 'bot is scoped → denied');
});

// scopeNewUser — a creator can never mint a user more privileged than themselves (privilege escalation).
test('scopeNewUser: non-owner admin cannot create an owner or grant capabilities it lacks', () => {
	const adminCaps = Authz.resolveCapabilities({ role: 'admin' });   // holds no '*'
	const asOwner = Authz.scopeNewUser(adminCaps, { role: 'owner' });
	assert.strictEqual(asOwner.role, 'viewer', 'owner role clamped to least privilege');
	assert.ok(asOwner.exceeded, 'flagged as exceeding the creator');
	const grantStar = Authz.scopeNewUser(adminCaps, { role: 'viewer', grants: ['*'] });
	assert.deepStrictEqual(grantStar.grants, [], "'*' grant is dropped");
	assert.ok(grantStar.exceeded, 'flagged as exceeding the creator');
});

test('scopeNewUser: a creator can assign a role/grants within its own authority', () => {
	const adminCaps = Authz.resolveCapabilities({ role: 'admin' });
	const ok = Authz.scopeNewUser(adminCaps, { role: 'operator', grants: ['settings.write'] });
	assert.strictEqual(ok.role, 'operator', 'sub-role allowed');
	assert.deepStrictEqual(ok.grants, ['settings.write'], 'held grant kept');
	assert.ok(!ok.exceeded, 'not flagged');
});

test('scopeNewUser: owner (*) is unaffected — full authority', () => {
	const r = Authz.scopeNewUser(['*'], { role: 'owner', grants: ['*'] });
	assert.strictEqual(r.role, 'owner');
	assert.deepStrictEqual(r.grants, ['*']);
	assert.ok(!r.exceeded);
});


console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
