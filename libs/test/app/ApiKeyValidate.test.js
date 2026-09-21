'use strict';

// Common.validateApiKey — legacy API-key authentication. It moved from a synchronous pbkdf2 to the async
// pbkdf2 (run on the libuv thread pool) so it can never stall the event loop on the API-request path — which
// includes webhook/signal traffic and, on the Hub, the loop shared by every instance. These tests pin the
// behavior that must not regress: it is genuinely async, a correct key verifies, and a wrong key, a
// non-string key, and a malformed/absent api_key config are all rejected without throwing.

const assert = require('assert');
const crypto = require('crypto');
const Common = require('../../app/Common.js');

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

// Build a "salt:hash" api_key exactly as SymBot stores it (pbkdf2, 1000 iters, sha256, 64 bytes, hex).
function makeApiKey(key) {
	const salt = crypto.randomBytes(16).toString('hex');
	const hash = crypto.pbkdf2Sync(key, salt, 1000, 64, 'sha256').toString('hex');
	return salt + ':' + hash;
}

(async () => {

	console.log('\nCommon.validateApiKey (async, off the event loop):');

	const KEY = 'the-secret-api-key';
	Common.init({ appData: { api_enabled: true, api_key: makeApiKey(KEY) } });

	await test('returns a Promise (runs off the event loop)', () => {
		const p = Common.validateApiKey(KEY);
		assert.ok(p && typeof p.then === 'function', 'expected a thenable');
		return p;   // settle it
	});

	await test('a correct key validates', async () => {
		assert.strictEqual(await Common.validateApiKey(KEY), true);
	});

	await test('a wrong key is rejected', async () => {
		assert.strictEqual(await Common.validateApiKey('not-the-key'), false);
	});

	await test('a non-string key fails safely (false, no throw)', async () => {
		assert.strictEqual(await Common.validateApiKey({ $gt: '' }), false);
		assert.strictEqual(await Common.validateApiKey(undefined), false);
		assert.strictEqual(await Common.validateApiKey(''), false);
	});

	await test('a malformed/absent api_key config is rejected', async () => {
		Common.init({ appData: {} });
		assert.strictEqual(await Common.validateApiKey(KEY), false);
	});

	console.log('\nvalidateApiKey: ' + passed + ' passed' + (failed ? (', ' + failed + ' failed') : ''));
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
