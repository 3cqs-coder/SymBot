'use strict';

// Pins the config-save serialization invariant (Common.withConfigSaveChain). Whole-config saves — app.json and
// bot.json — read the entire config, mutate it, and write it back, with long awaits in between (secret
// re-encryption, a DB connect test, an SFTP test upload). Two overlapping saves from DIFFERENT entry points
// (the /config page, the Exchange-settings save, a password-change re-key) would otherwise interleave and drop
// each other's fields — last writer wins — which can silently lose exchange credentials. withConfigSaveChain is
// a promise-chain mutex that forces these read-modify-writes to run strictly one at a time. This test drives
// the REAL mutex with concurrent read-modify-write closures and asserts (a) they never overlap and (b) no
// field is lost. Pure in-process logic — no files, no network, no DB.

const assert = require('assert');
const Common = require('../../app/Common.js');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok   - ' + msg); } else { failed++; process.exitCode = 1; console.log('  FAIL - ' + msg); } }

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {

	// ── Mutual exclusion: only one section runs at a time ────────────────────────────
	let active = 0;
	let maxConcurrent = 0;

	const section = () => Common.withConfigSaveChain(async () => {
		active++;
		if (active > maxConcurrent) { maxConcurrent = active; }
		await delay(5);              // simulate the awaits a real save has in the middle
		active--;
		return true;
	});

	await Promise.all([section(), section(), section(), section(), section()]);
	ok(maxConcurrent === 1, 'withConfigSaveChain never runs two saves at once (max concurrency was ' + maxConcurrent + ')');

	// ── No lost update: a shared config object read-modified-written concurrently ─────
	// Each closure reads the shared object, yields (the window where a naive last-writer-wins would clobber),
	// sets its own distinct field, and writes back. Under the mutex every field must survive.
	const config = { fields: {} };

	const writeField = (key) => Common.withConfigSaveChain(async () => {
		const snapshot = JSON.parse(JSON.stringify(config));   // read
		await delay(3);                                        // long await (re-encrypt / DB test)
		snapshot.fields[key] = true;                           // mutate one field
		config.fields = snapshot.fields;                       // write back the whole object
	});

	const keys = ['apiKey', 'apiSecret', 'mailer', 'sftp', 'telegram', 'exchange', 'password'];
	await Promise.all(keys.map(writeField));

	const survived = keys.filter((k) => config.fields[k] === true);
	ok(survived.length === keys.length, 'every concurrent field write survived (no lost update) — ' + survived.length + '/' + keys.length);

	// ── A rejection in one save must not deadlock later saves ─────────────────────────
	let afterReject = false;
	try { await Common.withConfigSaveChain(async () => { throw new Error('boom'); }); }
	catch (e) { /* expected */ }
	await Common.withConfigSaveChain(async () => { afterReject = true; });
	ok(afterReject === true, 'a rejected save does not wedge the chain — the next save still runs');

	console.log('\n' + passed + ' passed, ' + failed + ' failed');
	process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ConfigSaveSerialization FAIL: ' + (e && e.stack || e)); process.exit(1); });
