'use strict';

// Common.genPasswordHash / verifyPasswordHash — the shared password (and API-key/token) key derivation.
// These moved from a synchronous pbkdf2 to the async pbkdf2 (run on the libuv thread pool) so a login can
// never block the event loop — which in the Hub is shared by every instance and the trading loop. These
// tests pin the behavior that must not regress: the functions are genuinely async, a hash round-trips, a
// wrong password is rejected, and BOTH the strong and the legacy iteration factors verify (so no stored
// hash needs migrating).

const assert = require('assert');
const Common = require('../../app/Common.js');

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

const STRONG = 600000;   // the factor Users.js stores human passwords at (PASSWORD_PBKDF2_ITERATIONS)

(async () => {

	console.log('\nCommon password hashing (async pbkdf2):');

	await test('genPasswordHash returns a Promise (runs off the event loop)', () => {
		const p = Common.genPasswordHash({ data: 'whatever' });
		assert.ok(p && typeof p.then === 'function', 'expected a thenable');
		return p;   // settle it so no unhandled rejection
	});

	await test('a generated hash round-trips and carries its own random salt', async () => {
		const a = await Common.genPasswordHash({ data: 'correct horse', iterations: STRONG });
		assert.ok(a.salt && a.hash, 'salt and hash present');
		const b = await Common.genPasswordHash({ data: 'correct horse', iterations: STRONG });
		assert.notStrictEqual(a.salt, b.salt, 'each call salts independently');
		const ok = await Common.verifyPasswordHash({ salt: a.salt, hash: a.hash, data: 'correct horse' });
		assert.strictEqual(ok, true);
	});

	await test('a wrong password is rejected', async () => {
		const a = await Common.genPasswordHash({ data: 'right', iterations: STRONG });
		const ok = await Common.verifyPasswordHash({ salt: a.salt, hash: a.hash, data: 'wrong' });
		assert.strictEqual(ok, false);
	});

	await test('the STRONG factor verifies', async () => {
		const a = await Common.genPasswordHash({ data: 'pw', iterations: STRONG });
		assert.strictEqual(await Common.verifyPasswordHash({ salt: a.salt, hash: a.hash, data: 'pw' }), true);
	});

	await test('the LEGACY factor (default iterations) still verifies — no stored hash needs migrating', async () => {
		const a = await Common.genPasswordHash({ data: 'pw' });   // default = legacy factor
		assert.strictEqual(await Common.verifyPasswordHash({ salt: a.salt, hash: a.hash, data: 'pw' }), true);
	});

	// isDefaultPassword drives the "change your default password" nudge (and the watchdog). It MUST be
	// exported (a missing export once made it silently undefined, killing the nudge on default installs) and
	// must correctly recognize only the shipped default ('admin'), never throwing on odd input.
	console.log('\nCommon.isDefaultPassword (default-credential nudge):');

	await test('is exported as a function', () => {
		assert.strictEqual(typeof Common.isDefaultPassword, 'function');
	});

	await test('returns true for a stored hash of the default password "admin"', async () => {
		const a = await Common.genPasswordHash({ data: 'admin' });
		assert.strictEqual(await Common.isDefaultPassword(a.salt + ':' + a.hash), true);
	});

	await test('returns false for a non-default password, and false (never throws) on malformed/empty input', async () => {
		const a = await Common.genPasswordHash({ data: 'a real password' });
		assert.strictEqual(await Common.isDefaultPassword(a.salt + ':' + a.hash), false);
		assert.strictEqual(await Common.isDefaultPassword(''), false);
		assert.strictEqual(await Common.isDefaultPassword('no-colon'), false);
		assert.strictEqual(await Common.isDefaultPassword(null), false);
	});

	console.log('\n' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
})();
