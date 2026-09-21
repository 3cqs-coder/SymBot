'use strict';

// Integration test for the Hub's SQLite-backed storage (libs/app/store/HubStore.js) against a
// real temp database: users (seed/create/auth/roles + self-lockout), scoped API keys
// (create/resolve/scope/revoke), and the audit log — proving the Hub store behaves exactly
// like the Mongo instance side because it reuses the same pure logic.
//
// The password paths (seedOwner with a plaintext, createUser, authenticate) are async — the KDF runs off the
// event loop so a Hub login can't stall the shared process — so tests run sequentially through an async runner.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const HubStore = require('../../app/store/HubStore.js');
const Authz = require('../../app/Authz.js');

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'symbot-hubstore-'));
const r = HubStore.init({ path: path.join(TMP, 'hub.db') });

if (!r.available) {
	console.log('SKIP — node:sqlite unavailable in this runtime');
	process.exit(0);
}

(async () => {

	console.log('\nusers:');

	await test('seedOwner seeds an owner from a plaintext password, idempotently', async () => {
		const s = await HubStore.seedOwner({ username: 'owner', password: 'ownerpass' });
		assert.ok(s.success && s.seeded && s.user.role === 'owner' && s.user.is_initial);
		assert.strictEqual((await HubStore.seedOwner({ username: 'owner', password: 'x' })).seeded, false);
	});

	await test('create user + authenticate (good/bad) + duplicate rejected', async () => {
		const c = await HubStore.createUser({ username: 'reader', password: 'readerpass', role: 'viewer' });
		assert.ok(c.success && c.user.role === 'viewer');
		assert.strictEqual((await HubStore.createUser({ username: 'reader', password: 'y' })).success, false);
		assert.ok(await HubStore.authenticate('reader', 'readerpass'));
		assert.strictEqual(await HubStore.authenticate('reader', 'wrong'), null);
	});

	await test('self-lockout: the initial owner cannot be demoted or disabled', () => {
		const owner = HubStore.listUsersRaw().find(u => u.is_initial);
		assert.strictEqual(HubStore.setUserRole(owner.user_id, 'admin').success, false);
		assert.strictEqual(HubStore.setUserStatus(owner.user_id, 'disabled').success, false);
	});

	await test('a normal user can be re-roled and disabled', async () => {
		const reader = HubStore.listUsersRaw().find(u => u.username === 'reader');
		assert.ok(HubStore.setUserRole(reader.user_id, 'operator').success);
		assert.ok(HubStore.setUserStatus(reader.user_id, 'disabled').success);
		assert.strictEqual(await HubStore.authenticate('reader', 'readerpass'), null, 'disabled user cannot log in');
	});


	console.log('\napi keys:');

	await test('create scoped key, resolve to principal, enforce scope', () => {
		const k = HubStore.createKey({ name: 'ro', capabilities: ['stats.read', 'bot.read'], ownerCapabilities: ['*'] });
		assert.ok(k.success && k.clearKey.startsWith('symb_live_'));
		const p = HubStore.resolveKey(k.clearKey, { ip: '1.2.3.4' });
		assert.ok(p && p.kind === 'apikey');
		assert.ok(Authz.can(p, 'stats.read'));
		assert.ok(!Authz.can(p, 'bot.write'), 'read-only key cannot act');
		assert.ok(HubStore.listKeys().some(x => x.name === 'ro'));
		assert.ok(HubStore.setKeyStatus(k.key.key_id, 'revoked').success);
		assert.strictEqual(HubStore.resolveKey(k.clearKey), null, 'revoked key no longer resolves');
	});

	await test('key scope is clamped to the owner capabilities', () => {
		const k = HubStore.createKey({ name: 'scoped', capabilities: ['bot.write', 'stats.read'], ownerCapabilities: Authz.resolveCapabilities({ role: 'viewer' }) });
		assert.ok(k.success && !k.key.capabilities.includes('bot.write') && k.key.capabilities.includes('stats.read'));
	});

	await test('rotate mints a same-scope successor and grace-expires the old key', () => {
		const orig = HubStore.createKey({ name: 'rotate-me', capabilities: ['stats.read'], ownerCapabilities: ['*'] });
		assert.ok(orig.success);

		const r = HubStore.rotateKey(orig.key.key_id, { graceHours: 24 });
		assert.ok(r.success && r.clearKey.startsWith('symb_live_'), 'rotation returns a new secret');
		assert.notStrictEqual(r.key.key_id, orig.key.key_id, 'successor is a distinct key');
		assert.deepStrictEqual(r.key.capabilities, ['stats.read'], 'successor carries the same scope');
		assert.strictEqual(r.old_key_id, orig.key.key_id);
		assert.ok(r.grace_expires_at > Date.now(), 'old key expiry is in the future (grace window)');

		// The successor resolves; the predecessor is now stamped with rotated_to and cannot be rotated again.
		assert.ok(HubStore.resolveKey(r.clearKey, { ip: '1.2.3.4' }), 'successor resolves');
		assert.strictEqual(HubStore.rotateKey(orig.key.key_id).success, false, 'a key cannot be rotated twice');

		// Guards: unknown key, and a revoked key.
		assert.strictEqual(HubStore.rotateKey('no-such-id').success, false, 'unknown key is rejected');
		const rv = HubStore.createKey({ name: 'to-revoke', capabilities: ['stats.read'], ownerCapabilities: ['*'] });
		HubStore.setKeyStatus(rv.key.key_id, 'revoked');
		assert.strictEqual(HubStore.rotateKey(rv.key.key_id).success, false, 'a revoked key cannot be rotated');
	});

	await test('a forged key resolves to null', () => {
		assert.strictEqual(HubStore.resolveKey('symb_live_deadbeefdead_' + 'a'.repeat(64)), null);
	});


	console.log('\naudit:');

	await test('audit entries are recorded and listed with filtering', () => {
		HubStore.audit('user:owner', 'apikey.create', 'symb_live_ab12', 'ro');
		HubStore.audit('user:owner', 'user.create', 'reader', 'viewer');
		const keyEvents = HubStore.listAudit({ action: 'apikey' });
		assert.ok(keyEvents.length >= 1 && keyEvents.every(e => e.action.indexOf('apikey') === 0));
	});


	console.log('\nresilience:');

	await test('a live backup can be taken', () => {
		const b = HubStore.backup();
		assert.ok(b && fs.existsSync(b), 'backup file written');
	});

	await test('resetTable clears an auth table and rejects unknown tables', () => {
		HubStore.createKey({ name: 'to-wipe', capabilities: ['stats.read'], ownerCapabilities: ['*'] });
		assert.ok(HubStore.listKeys().length > 0, 'a key exists before reset');
		const r = HubStore.resetTable('api_keys');
		assert.ok(r.success, 'api_keys reset succeeds');
		assert.strictEqual(HubStore.listKeys().length, 0, 'no keys remain after reset');
		assert.strictEqual(HubStore.resetTable('secrets').success, false, 'unknown table is rejected');
	});

	await test('listBackups + restore round-trips a snapshot and is reversible', async () => {
		// State A: one user present. Snapshot it.
		await HubStore.createUser({ username: 'snap-user', password: 'snappass1', role: 'viewer' });
		const before = HubStore.listUsers().length;
		const snap = HubStore.backup();
		assert.ok(snap, 'snapshot A written');
		const backups = HubStore.listBackups();
		assert.ok(backups.length > 0 && backups[0].name && backups[0].size >= 0, 'listBackups returns metadata');

		// State B: add another user, diverging from snapshot A.
		await HubStore.createUser({ username: 'later-user', password: 'laterpass1', role: 'viewer' });
		assert.strictEqual(HubStore.listUsers().length, before + 1, 'state B has one more user');

		// Restore snapshot A → later-user is gone, snap-user remains, store still healthy.
		const snapName = require('path').basename(snap);
		const r = HubStore.restore(snapName);
		assert.ok(r.success, 'restore succeeded');
		assert.strictEqual(HubStore.listUsers().length, before, 'restored to state A user count');
		assert.ok(HubStore.listUsers().some(u => u.username === 'snap-user'), 'snap-user present after restore');
		assert.ok(!HubStore.listUsers().some(u => u.username === 'later-user'), 'later-user gone after restore');

		// Guards: traversal / unknown files are rejected.
		assert.strictEqual(HubStore.restore('../hub.db').success, false, 'path traversal rejected');
		assert.strictEqual(HubStore.restore('nope.db').success, false, 'non-snapshot name rejected');
	});


	HubStore.close();
	try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

	console.log('\n' + passed + ' passed, ' + failed + ' failed');
	process.exit(failed ? 1 : 0);
})();
