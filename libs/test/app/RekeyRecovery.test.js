'use strict';

// Isolated simulation of the password re-key crash-recovery (recoverRekeyJournal). Uses the REAL
// System.encrypt/decrypt for authentic ciphertext and the REAL Common recovery logic; only the DB-backed
// backup-secret re-key is a no-op (guarded). Crafts each on-disk crash state, runs recovery, asserts.

const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '../../..');
const Common = require(ROOT + '/libs/app/Common.js');
const System = require(ROOT + '/libs/app/System.js');

const SID = 'rekey-sim-' + process.pid;
const INST_DIR = ROOT + '/data/instances/' + SID;
// getConfig/saveConfig resolve names under <root>/config/, so use uniquely-prefixed test filenames there.
const appName = '.rekey-sim-' + process.pid + '-app.json';
const botName = '.rekey-sim-' + process.pid + '-bot.json';
const appFile = ROOT + '/config/' + appName;
const botFile = ROOT + '/config/' + botName;

fs.mkdirSync(INST_DIR, { recursive: true });

const shareData = {
	appData: { name: '', server_id: SID, app_config: appName, bot_config: botName, password: '' },
	logger: () => {},
};
Common.init(shareData);
System.init(shareData, () => {});
shareData.System = System;
shareData.Common = Common;

const OLD = 'old-anchor-aaaa';
const NEW = 'new-anchor-bbbb';

const enc = async (plain, key) => (await System.encrypt(plain, key)).data;
const journalPath = INST_DIR + '/.rekey.json';

let passed = 0, failed = 0;
function ok(cond, name) { if (cond) { passed++; console.log('  ok   - ' + name); } else { failed++; console.log('  FAIL - ' + name); } }

function writeJournal() { fs.writeFileSync(journalPath, JSON.stringify({ old: OLD, new: NEW, app_config: appName, bot_config: botName })); }
function readApp() { return JSON.parse(fs.readFileSync(appFile, 'utf8')); }
function journalExists() { return fs.existsSync(journalPath); }

async function scenarioHalf() {
	// bot-config already re-keyed to NEW, app.json still OLD, journal present → recovery COMPLETES.
	fs.writeFileSync(appFile, JSON.stringify({ password: OLD, mailer: { password: await enc('smtp-secret', OLD) }, bot_config: botName }));
	fs.writeFileSync(botFile, JSON.stringify({ apiKey: await enc('EXCHANGE-KEY', NEW), apiSecret: await enc('EXCHANGE-SECRET', NEW) }));
	shareData.appData.password = OLD;
	writeJournal();

	await Common.recoverRekeyJournal();

	const app = readApp();
	ok(app.password === NEW, 'HALF: app.json anchor advanced to NEW');
	const m = await System.decrypt(app.mailer.password, NEW);
	ok(m.success && m.data === 'smtp-secret', 'HALF: app.json secret re-keyed to NEW (decrypts to plaintext)');
	ok(shareData.appData.password === NEW, 'HALF: runtime anchor updated to NEW');
	ok(!journalExists(), 'HALF: journal cleared');
}

async function scenarioRollback() {
	// bot-config still OLD (change never reached the first commit), app.json OLD, journal present → DISCARD.
	fs.writeFileSync(appFile, JSON.stringify({ password: OLD, mailer: { password: await enc('smtp-secret', OLD) }, bot_config: botName }));
	fs.writeFileSync(botFile, JSON.stringify({ apiKey: await enc('EXCHANGE-KEY', OLD) }));
	shareData.appData.password = OLD;
	writeJournal();

	await Common.recoverRekeyJournal();

	const app = readApp();
	ok(app.password === OLD, 'ROLLBACK: app.json anchor stays OLD (consistent, nothing committed)');
	ok(!journalExists(), 'ROLLBACK: journal cleared');
}

async function scenarioDone() {
	// Both already NEW, crash was just before the journal delete → clear, no rewrite.
	fs.writeFileSync(appFile, JSON.stringify({ password: NEW, mailer: { password: await enc('smtp-secret', NEW) }, bot_config: botName }));
	fs.writeFileSync(botFile, JSON.stringify({ apiKey: await enc('EXCHANGE-KEY', NEW) }));
	shareData.appData.password = NEW;
	writeJournal();

	await Common.recoverRekeyJournal();

	ok(readApp().password === NEW, 'DONE: app.json anchor stays NEW');
	ok(!journalExists(), 'DONE: journal cleared');
}

async function scenarioAmbiguous() {
	// bot creds decrypt under NEITHER anchor → recovery must NOT guess: leave everything, keep journal.
	fs.writeFileSync(appFile, JSON.stringify({ password: OLD, mailer: { password: await enc('smtp-secret', OLD) }, bot_config: botName }));
	fs.writeFileSync(botFile, JSON.stringify({ apiKey: await enc('EXCHANGE-KEY', 'some-unrelated-key') }));
	shareData.appData.password = OLD;
	writeJournal();

	await Common.recoverRekeyJournal();

	ok(readApp().password === OLD, 'AMBIGUOUS: app.json left untouched (OLD)');
	ok(journalExists(), 'AMBIGUOUS: journal left for the watchdog (not cleared, not guessed)');
	fs.unlinkSync(journalPath);   // tidy for cleanup
}

async function scenarioNoCreds() {
	// Bot-config read cleanly with NO encrypted exchange credentials (fresh install / paper bot). There is
	// nothing trading-critical to orphan, so recovery COMPLETES the re-key forward — advancing the anchor and
	// re-keying app.json's own secrets (and any already-advanced DB backup secret) to the new key — rather
	// than leaving a stale journal to log forever.
	fs.writeFileSync(appFile, JSON.stringify({ password: OLD, mailer: { password: await enc('smtp-secret', OLD) }, bot_config: botName }));
	fs.writeFileSync(botFile, JSON.stringify({ apiKey: 'plaintext-not-encrypted' }));   // no encrypted cred fields
	shareData.appData.password = OLD;
	writeJournal();

	await Common.recoverRekeyJournal();

	const app = readApp();
	ok(app.password === NEW, 'NO-CREDS: re-key completed forward (anchor advanced to NEW)');
	const m = await System.decrypt(app.mailer.password, NEW);
	ok(m.success && m.data === 'smtp-secret', 'NO-CREDS: app.json own secret re-keyed to NEW');
	ok(!journalExists(), 'NO-CREDS: journal cleared after completion');
}

async function scenarioReadFailure() {
	// A half-applied re-key (creds under NEW, anchor OLD) but the bot-config cannot be READ this boot (a
	// transient FS error). Recovery must NOT guess: it must leave the journal so a later boot that can read
	// the bot-config completes it — clearing here would orphan the re-keyed creds with no recovery path.
	fs.writeFileSync(appFile, JSON.stringify({ password: OLD, mailer: { password: await enc('smtp-secret', OLD) }, bot_config: botName }));
	try { fs.unlinkSync(botFile); } catch (e) {}   // bot-config unreadable (ENOENT) this boot
	shareData.appData.password = OLD;
	writeJournal();

	await Common.recoverRekeyJournal();

	ok(readApp().password === OLD, 'READ-FAILURE: anchor NOT advanced (creds could not be proven)');
	ok(journalExists(), 'READ-FAILURE: journal preserved for a later boot / the watchdog');
	fs.unlinkSync(journalPath);   // tidy for cleanup
}

async function scenarioNoJournal() {
	fs.writeFileSync(appFile, JSON.stringify({ password: OLD }));
	if (journalExists()) fs.unlinkSync(journalPath);
	let threw = false;
	try { await Common.recoverRekeyJournal(); } catch (e) { threw = true; }
	ok(!threw, 'NO-JOURNAL: recovery is a clean no-op');
	ok(readApp().password === OLD, 'NO-JOURNAL: nothing changed');
}

(async () => {
	console.log('\nre-key crash recovery simulation:');
	try {
		await scenarioHalf();
		await scenarioRollback();
		await scenarioDone();
		await scenarioAmbiguous();
		await scenarioNoCreds();
		await scenarioReadFailure();
		await scenarioNoJournal();
	}
	catch (e) { console.log('  SIM ERROR: ' + (e && e.stack || e)); failed++; }
	finally {
		try { fs.rmSync(INST_DIR, { recursive: true, force: true }); } catch (e) {}
		try { fs.unlinkSync(appFile); } catch (e) {}
		try { fs.unlinkSync(botFile); } catch (e) {}
	}
	console.log('\n' + passed + ' passed, ' + failed + ' failed');
	process.exit(failed ? 1 : 0);
})();
