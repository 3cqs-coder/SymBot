'use strict';

// Pins the encryption round-trip the console password-reset re-key depends on. The recovery path
// (resetAuthConsole -> rekeyAllSecrets -> rekeySecretInPlace) decrypts each secret under the OLD app
// password and re-encrypts it under the NEW one so a lockout recovery does not orphan the exchange
// credentials / provider / backup secrets. The core invariant that makes that safe:
//   * a value re-keyed (decrypt-under-old, encrypt-under-new) decrypts correctly under the NEW key;
//   * the re-keyed ciphertext is REJECTED by the old key;
//   * the ORIGINAL ciphertext is rejected by the NEW key (this is exactly the orphaning the re-key fixes —
//     if this test ever fails to reject, the password change would silently keep decrypting old data);
//   * encrypt/decrypt round-trips cleanly and a wrong key fails rather than returning garbage.
// System.encrypt/decrypt take an explicit key, so this needs no engine init.

const assert = require('assert');
const System = require('../../app/System.js');

if (typeof System.init === 'function') { try { System.init({ Common: { logger: function () {} }, appData: {} }); } catch (e) {} }

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

(async () => {

	const oldKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:oldhashmaterial';
	const newKey = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:newhashmaterial';
	const secret = 'EXCHANGE-API-SECRET-9f3a-xyz';

	// Encrypt under the old key.
	const encOld = await System.encrypt(secret, oldKey);
	ok(encOld && encOld.success === true && typeof encOld.data === 'string', 'encrypt succeeds');
	ok(/^[0-9a-f]{32}:.+/.test(encOld.data), 'ciphertext has the <32-hex-iv>:<data> shape looksEncrypted expects');

	// Round-trip under the same key.
	const decSame = await System.decrypt(encOld.data, oldKey);
	ok(decSame && decSame.success === true && decSame.data === secret, 'decrypt under the same key returns the plaintext');

	// The re-key: decrypt under old, re-encrypt under new.
	const encNew = await System.encrypt(decSame.data, newKey);
	ok(encNew && encNew.success === true, 're-encrypt under the new key succeeds');

	const decNew = await System.decrypt(encNew.data, newKey);
	ok(decNew && decNew.success === true && decNew.data === secret, 're-keyed value decrypts under the NEW key and matches');

	// The re-keyed ciphertext must NOT be readable under the old key.
	const decNewWithOld = await System.decrypt(encNew.data, oldKey);
	ok(!decNewWithOld || decNewWithOld.success !== true, 're-keyed ciphertext is REJECTED by the old key');

	// The ORIGINAL ciphertext must NOT decrypt under the new key — this is the orphaning the re-key exists
	// to repair. If this ever succeeds, a password change would silently keep reading old-key data.
	const decOldWithNew = await System.decrypt(encOld.data, newKey);
	ok(!decOldWithNew || decOldWithNew.success !== true, 'original ciphertext is rejected by the new key (proves re-key is required)');

	// A garbage ciphertext fails cleanly (no throw, success:false).
	const bad = await System.decrypt('not-encrypted-plaintext', oldKey);
	ok(bad && bad.success !== true, 'a non-ciphertext input fails cleanly, never throws');

	console.log('SecretRekey: ' + passed + ' assertions passed');
	process.exit(0);
})().catch((e) => { console.error('SecretRekey test error:', e); process.exit(1); });
