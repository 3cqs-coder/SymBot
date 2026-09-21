'use strict';

// Tests for the pure (DB-free) helpers in libs/app/Users.js — the self-lockout guards (an
// install must never be able to demote/disable its way to zero owners), least-privilege
// role defaulting, the safe projection, and the user→principal mapping. DB-backed
// create/authenticate/seed are exercised in the live pass.

const assert = require('assert');
const Users = require('../../app/Users.js');
const Authz = require('../../app/Authz.js');

let passed = 0, failed = 0;
function test(name, fn) {
	try { fn(); passed++; console.log('  ok   - ' + name); }
	catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); }
}

const owner   = { user_id: 'u-own', username: 'owner', role: 'owner', status: 'active', is_initial: true };
const owner2  = { user_id: 'u-o2', username: 'co',    role: 'owner', status: 'active', is_initial: false };
const admin   = { user_id: 'u-adm', username: 'adm',  role: 'admin', status: 'active', is_initial: false };
const viewer  = { user_id: 'u-vw',  username: 'vw',   role: 'viewer',status: 'active', is_initial: false };


console.log('\nself-lockout guards — role changes:');

test('the initial owner can never be demoted', () => {
	const r = Users.guardRoleChange([owner, owner2], 'u-own', 'admin');
	assert.ok(!r.ok && /initial owner/i.test(r.error));
});

test('the last remaining owner cannot be demoted', () => {
	const r = Users.guardRoleChange([owner], 'u-own', 'admin');   // also initial, but the point is last-owner
	assert.ok(!r.ok);
});

test('a non-last, non-initial owner CAN be demoted', () => {
	const r = Users.guardRoleChange([owner, owner2], 'u-o2', 'admin');
	assert.ok(r.ok, r.error);
});

test('an admin can be freely re-roled', () => {
	assert.ok(Users.guardRoleChange([owner, admin], 'u-adm', 'viewer').ok);
	assert.ok(Users.guardRoleChange([owner, admin], 'u-adm', 'operator').ok);
});

test('unknown user is rejected', () => {
	assert.ok(!Users.guardRoleChange([owner], 'nope', 'admin').ok);
});


console.log('\nself-lockout guards — status changes:');

test('the initial owner cannot be disabled', () => {
	const r = Users.guardStatusChange([owner, owner2], 'u-own', 'disabled');
	assert.ok(!r.ok && /initial owner/i.test(r.error));
});

test('the last remaining active owner cannot be disabled', () => {
	// owner2 is the only *active* owner here (owner is disabled)
	const disabledOwner = Object.assign({}, owner, { status: 'disabled' });
	const r = Users.guardStatusChange([disabledOwner, owner2], 'u-o2', 'disabled');
	assert.ok(!r.ok, 'must keep at least one active owner');
});

test('a non-last owner and a regular user can be disabled', () => {
	assert.ok(Users.guardStatusChange([owner, owner2], 'u-o2', 'disabled').ok);
	assert.ok(Users.guardStatusChange([owner, viewer], 'u-vw', 'disabled').ok);
});


console.log('\nrole defaulting & projection:');

test('normalizeRole defaults unknown/empty to least privilege (viewer)', () => {
	assert.strictEqual(Users.normalizeRole('admin'), 'admin');
	assert.strictEqual(Users.normalizeRole('nonsense'), 'viewer');
	assert.strictEqual(Users.normalizeRole(undefined), 'viewer');
});

test('publicView never exposes the password hash', () => {
	const view = Users.publicView({ user_id: 'x', username: 'a', role: 'admin', status: 'active', password_hash: 'salt:hash', grants: [] });
	assert.ok(!('password_hash' in view));
	assert.ok(JSON.stringify(view).indexOf('salt:hash') < 0);
});

test('toPrincipal yields a working principal (role + grants)', () => {
	const p = Users.toPrincipal({ user_id: 'x', role: 'operator', grants: ['bot.delete'] });
	assert.strictEqual(p.kind, 'user');
	assert.ok(Authz.can(p, 'deal.close'), 'operator can close deals');
	assert.ok(Authz.can(p, 'bot.delete'), 'extra grant applied');
	assert.ok(!Authz.can(p, 'user.invite'), 'not granted → denied');
});


console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);