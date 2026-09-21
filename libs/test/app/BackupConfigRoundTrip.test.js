'use strict';

// Throwaway-instance simulation of the "System Backup with configuration" feature. It exercises the REAL
// System backup/restore helpers end-to-end over disposable temp directories (no Mongo, no live config
// touched) to prove the parts that are new this session:
//
//   1. A backup can bundle config/ (app.json + bot config + hub.json) into the archive.
//   2. The archive round-trips: bundle → manifest → compress → encrypt → (move) → decrypt → decompress.
//   3. verifyBackupManifest PASSES on an intact archive and REFUSES a tampered one BEFORE any destructive
//      restore step (the checksum gate).
//   4. Portability / "clone to a test server": an exchange secret encrypted under the SOURCE app key still
//      decrypts on the TARGET after restoreConfigFromBackup brings the source app.json (and its key) across.
//   5. Safety rails: all-or-nothing (no app.json in config -> copy refused) and a config-less archive does
//      NOT clobber the target's configuration.
//
// The Mongo collection wipe/refill itself is unchanged existing code; the only restore-path addition there
// is the verifyBackupManifest() call, which this simulation drives directly.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const System = require('../../app/System.js');

// Source instance identity: the "app key" is the salt:hash string app.json stores as its password and that
// System.encrypt/decrypt derive the at-rest key from. Two different instances that share this key can read
// each other's secrets — which is exactly what carrying app.json across in the backup arranges.
const SRC_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:sourcehashmaterial';
const BACKUP_PASSWORD = 'archive-pass-2026';

// Capture logger output so the version-mismatch advisory can be asserted (it is logged, not thrown).
const logs = [];
System.init({ Common: { logger: function (m) { logs.push(String(m)); } }, appData: { version: '1.4.0', name: 'source', bot_config: 'bot.json' } });

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) {} }

(async () => {

	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symbot-backup-sim-'));

	try {

		// ── Build a source instance's config, with a REAL encrypted exchange secret ──
		const srcConfig = path.join(root, 'src-config');
		fs.mkdirSync(srcConfig, { recursive: true });

		const encApiSecret = await System.encrypt('SUPER-SECRET-EXCHANGE-KEY', SRC_KEY);
		ok(encApiSecret.success === true, 'source exchange secret encrypts under the source app key');

		fs.writeFileSync(path.join(srcConfig, 'app.json'), JSON.stringify({ name: 'source', password: SRC_KEY, version: '1.4.0' }, null, 2));
		fs.writeFileSync(path.join(srcConfig, 'bot.json'), JSON.stringify({ exchange: 'binance', apiKey: 'PUBLICKEY', apiSecret: encApiSecret.data }, null, 2));

		// ── BACKUP: stage a fake DB dump + bundle config + manifest + compress + encrypt ──
		const staging = path.join(root, 'staging');
		fs.mkdirSync(path.join(staging, 'database'), { recursive: true });
		fs.writeFileSync(path.join(staging, 'database', 'deals.bson'), Buffer.from('fake-bson-deal-bytes-0123456789'));

		const copied = await System.copyConfigIntoBackup(staging, srcConfig);
		ok(copied.indexOf('app.json') >= 0 && copied.indexOf('bot.json') >= 0, 'copyConfigIntoBackup bundles app.json + bot config');
		ok(fs.existsSync(path.join(staging, 'config', 'app.json')), 'the bundled config lands under staging/config');

		await System.logManifest('1.4.0', staging, path.join(staging, '.manifest.json'));
		ok(fs.existsSync(path.join(staging, '.manifest.json')), 'a manifest is written covering every staged file');

		const zipPath = path.join(root, 'backup.zip');
		await System.compress(staging, zipPath);
		const encPath = zipPath + '.enc';
		const encFileRes = await System.encryptFile(zipPath, encPath, BACKUP_PASSWORD);
		ok(encFileRes.success === true && fs.existsSync(encPath), 'the archive encrypts to a .enc under the backup password');

		// ── MOVE the .enc to a fresh "target server" and RESTORE ──
		const decZip = path.join(root, 'restore.zip');
		const decRes = await System.decryptFile(encPath, decZip, BACKUP_PASSWORD);
		ok(decRes.success === true, 'the moved archive decrypts under the backup password');

		const extract = path.join(root, 'extract');
		await System.decompress(decZip, extract);
		ok(fs.existsSync(path.join(extract, 'config', 'app.json')) && fs.existsSync(path.join(extract, 'database', 'deals.bson')), 'decompress restores the archive tree (config + database)');

		// Manifest verification must PASS on the intact archive (would throw on failure).
		await System.verifyBackupManifest(extract);
		ok(true, 'verifyBackupManifest passes on an intact archive');

		// Apply the bundled config onto the TARGET's (empty) config dir.
		const targetConfig = path.join(root, 'target-config');
		fs.mkdirSync(targetConfig, { recursive: true });
		const restored = await System.restoreConfigFromBackup(extract, targetConfig);
		ok(restored.restored === true, 'restoreConfigFromBackup applies the archive config to the target');

		// ── PORTABILITY: the target now holds the source app.json (same key), so the source-encrypted
		//    exchange secret decrypts on the target. This is the "clone to a test server" guarantee. ──
		const targetApp = JSON.parse(fs.readFileSync(path.join(targetConfig, 'app.json'), 'utf8'));
		const targetBot = JSON.parse(fs.readFileSync(path.join(targetConfig, 'bot.json'), 'utf8'));
		ok(targetApp.password === SRC_KEY, 'the target adopts the source app key (app.json carried across)');

		const dec = await System.decrypt(targetBot.apiSecret, targetApp.password);
		ok(dec.success === true && dec.data === 'SUPER-SECRET-EXCHANGE-KEY', 'the exchange secret decrypts on the TARGET under the carried-over key — portability holds');

		// ── TAMPER: corrupt a file after extraction; the manifest gate must REFUSE before any restore ──
		const tampered = path.join(root, 'extract-tampered');
		await System.decompress(decZip, tampered);
		fs.appendFileSync(path.join(tampered, 'database', 'deals.bson'), Buffer.from('X'));
		let refused = false;
		try { await System.verifyBackupManifest(tampered); }
		catch (e) { refused = /checksum|corrupt|altered/i.test(e.message); }
		ok(refused, 'verifyBackupManifest REFUSES a tampered archive (checksum mismatch) before any destructive step');

		// ── EXTRA-FILE GATE: an archive carrying a file not in its manifest is REFUSED before restore ──
		// A crafted archive could try to smuggle an unexpected config file (e.g. a foreign server.json to
		// hijack the instance identity) past the checksum loop, which only proves the LISTED files are intact.
		const withExtra = path.join(root, 'extract-extra');
		await System.decompress(decZip, withExtra);
		fs.writeFileSync(path.join(withExtra, 'config', 'server.json'), JSON.stringify({ evil: true }));
		let extraRefused = false;
		try { await System.verifyBackupManifest(withExtra); }
		catch (e) { extraRefused = /unexpected file|not in its manifest/i.test(e.message); }
		ok(extraRefused, 'verifyBackupManifest REFUSES an archive with a file not listed in its manifest');

		// ── ALLOWLIST RESTORE: restoreConfigFromBackup applies ONLY the known allowlist, ignoring extras ──
		// Even if an unlisted file reached the extract dir (manifest skipped / hand-made archive),
		// restoreConfigFromBackup must apply only app.json + the bot config + hub.json, never the stray file.
		const allowTarget = path.join(root, 'allowlist-target');
		fs.mkdirSync(allowTarget, { recursive: true });
		const r2 = await System.restoreConfigFromBackup(withExtra, allowTarget);
		ok(r2.restored === true, 'restoreConfigFromBackup applies the allowlisted config');
		ok(fs.existsSync(path.join(allowTarget, 'app.json')) && fs.existsSync(path.join(allowTarget, 'bot.json')), 'the allowlisted files landed on the target');
		ok(!fs.existsSync(path.join(allowTarget, 'server.json')), 'the stray non-allowlisted file was NOT applied to the target config');

		// ── SAFETY RAIL 1: all-or-nothing — a config with no app.json cannot be bundled ──
		const noApp = path.join(root, 'noapp-config');
		fs.mkdirSync(noApp, { recursive: true });
		fs.writeFileSync(path.join(noApp, 'bot.json'), JSON.stringify({ exchange: 'binance' }));
		let bundleRefused = false;
		try { await System.copyConfigIntoBackup(path.join(root, 'staging2'), noApp); }
		catch (e) { bundleRefused = /app\.json/.test(e.message); }
		ok(bundleRefused, 'copyConfigIntoBackup refuses to bundle a config set missing app.json (no half-config backup)');

		// ── SAFETY RAIL 2: a config-less archive does NOT clobber the target's existing config ──
		const dbOnly = path.join(root, 'dbonly-extract');
		fs.mkdirSync(dbOnly, { recursive: true });
		const keepTarget = path.join(root, 'keep-config');
		fs.mkdirSync(keepTarget, { recursive: true });
		fs.writeFileSync(path.join(keepTarget, 'app.json'), JSON.stringify({ name: 'target-original', password: 'targetkey:xyz' }));
		const noConfigRestore = await System.restoreConfigFromBackup(dbOnly, keepTarget);
		ok(noConfigRestore.restored === false, 'a config-less archive reports nothing restored');
		const keptApp = JSON.parse(fs.readFileSync(path.join(keepTarget, 'app.json'), 'utf8'));
		ok(keptApp.name === 'target-original', 'the target keeps its own configuration untouched when the archive has none');

		// ── VERSION MISMATCH: a backup made on a DIFFERENT version logs a cross-version advisory and still
		//    PROCEEDS (it is not refused) — you can restore an older backup after an upgrade. Only checksum /
		//    missing / unexpected-file failures abort (covered above). ──
		const verDir = path.join(root, 'ver-mismatch');
		fs.mkdirSync(path.join(verDir, 'database'), { recursive: true });
		fs.writeFileSync(path.join(verDir, 'database', 'deals.bson'), Buffer.from('version-mismatch-bytes'));
		await System.logManifest('9.9.9', verDir, path.join(verDir, '.manifest.json'));   // manifest version != appData 1.4.0
		logs.length = 0;
		await System.verifyBackupManifest(verDir);   // must NOT throw
		ok(logs.some(l => /9\.9\.9/.test(l) && /1\.4\.0/.test(l)), 'a version-mismatch backup logs the cross-version advisory (made on X but instance is Y)');
		ok(logs.some(l => /verified/i.test(l)), 'the manifest still verifies and the restore proceeds — a version mismatch is advisory, not a refusal');

		// Control: a MATCHING version logs NO cross-version advisory.
		const verOk = path.join(root, 'ver-match');
		fs.mkdirSync(path.join(verOk, 'database'), { recursive: true });
		fs.writeFileSync(path.join(verOk, 'database', 'deals.bson'), Buffer.from('matching-version-bytes'));
		await System.logManifest('1.4.0', verOk, path.join(verOk, '.manifest.json'));
		logs.length = 0;
		await System.verifyBackupManifest(verOk);
		ok(!logs.some(l => /made on version/i.test(l)), 'a matching-version backup logs NO cross-version advisory');

		// ── HUB DISASTER RECOVERY: per-instance filenames + shared hub.json is never clobbered ──
		// Re-init as a HUB INSTANCE that runs its OWN app-NE.json / bot-NE.json (not the defaults). The backup
		// must follow those actual names, and a restore must write them back — never a hardcoded app.json —
		// and must NEVER overwrite the shared hub.json that lists every instance.
		System.init({ Common: { logger: function (m) { logs.push(String(m)); } },
			appData: { version: '1.4.0', name: 'NE', app_config: 'app-NE.json', bot_config: 'bot-NE.json' } });

		const neSrc = path.join(root, 'ne-src-config');
		fs.mkdirSync(neSrc, { recursive: true });
		const neSecret = await System.encrypt('NE-EXCHANGE-KEY', SRC_KEY);
		fs.writeFileSync(path.join(neSrc, 'app-NE.json'), JSON.stringify({ name: 'NE', password: SRC_KEY, version: '1.4.0' }, null, 2));
		fs.writeFileSync(path.join(neSrc, 'bot-NE.json'), JSON.stringify({ exchange: 'binance', apiSecret: neSecret.data }, null, 2));
		fs.writeFileSync(path.join(neSrc, 'hub.json'), JSON.stringify({ port: 3100, instances: [ { name: 'NE', app_config: 'app-NE.json' } ] }, null, 2));

		const neStaging = path.join(root, 'ne-staging');
		fs.mkdirSync(neStaging, { recursive: true });
		const neCopied = await System.copyConfigIntoBackup(neStaging, neSrc);
		ok(neCopied.indexOf('app-NE.json') >= 0 && neCopied.indexOf('bot-NE.json') >= 0 && neCopied.indexOf('app.json') < 0,
			'backup follows the instance\'s ACTUAL config names (app-NE.json / bot-NE.json), not a hardcoded app.json');
		ok(neCopied.indexOf('hub.json') >= 0, 'backup still bundles the shared hub.json');

		// Restore onto a target that ALREADY has a live hub.json listing OTHER instances (a running Hub).
		const neTarget = path.join(root, 'ne-target');
		fs.mkdirSync(neTarget, { recursive: true });
		const liveHub = JSON.stringify({ port: 3100, instances: [ { name: 'Binance-Paper' }, { name: 'NE' }, { name: 'NE35' }, { name: 'Coinbase-Real' } ] }, null, 2);
		fs.writeFileSync(path.join(neTarget, 'hub.json'), liveHub);
		logs.length = 0;
		const neRestore = await System.restoreConfigFromBackup(neStaging, neTarget);
		ok(neRestore.restored === true, 'the NE instance config restores');
		ok(fs.existsSync(path.join(neTarget, 'app-NE.json')) && fs.existsSync(path.join(neTarget, 'bot-NE.json')),
			'the instance\'s OWN app-NE.json / bot-NE.json are written on restore');
		ok(!fs.existsSync(path.join(neTarget, 'app.json')), 'restore never creates a stray app.json — a sibling instance\'s app config is untouched');
		ok(fs.readFileSync(path.join(neTarget, 'hub.json'), 'utf8') === liveHub,
			'the LIVE shared hub.json is PRESERVED byte-for-byte — an instance restore never overwrites the Hub topology / sibling entries');
		ok(logs.some(l => /preserved the existing shared hub\.json/i.test(l)), 'the hub.json-preservation is logged');

		// Restore onto a FRESH machine with NO hub.json → it IS seeded, so a from-scratch recovery still works.
		const neFresh = path.join(root, 'ne-fresh');
		fs.mkdirSync(neFresh, { recursive: true });
		await System.restoreConfigFromBackup(neStaging, neFresh);
		ok(fs.existsSync(path.join(neFresh, 'hub.json')), 'on a machine with no hub.json yet, the shared hub.json IS seeded (from-scratch recovery)');

		// ── COUPLING GUARD: an archive with the app config but NOT the bot config applies NEITHER ──
		// (restoring the app config alone would leave the target's old-password bot secrets undecryptable.)
		System.init({ Common: { logger: function (m) { logs.push(String(m)); } },
			appData: { version: '1.4.0', name: 'M2', app_config: 'app-M2.json', bot_config: 'bot-M2.json' } });
		const m2Src = path.join(root, 'm2-src');
		fs.mkdirSync(m2Src, { recursive: true });
		fs.writeFileSync(path.join(m2Src, 'app-M2.json'), JSON.stringify({ name: 'M2', password: SRC_KEY }));   // NO bot-M2.json on purpose
		const m2Staging = path.join(root, 'm2-staging');
		fs.mkdirSync(m2Staging, { recursive: true });
		const m2Copied = await System.copyConfigIntoBackup(m2Staging, m2Src);
		ok(m2Copied.indexOf('app-M2.json') >= 0 && m2Copied.indexOf('bot-M2.json') < 0, 'a source with no bot config bundles the app config only');
		const m2Target = path.join(root, 'm2-target');
		fs.mkdirSync(m2Target, { recursive: true });
		fs.writeFileSync(path.join(m2Target, 'app-M2.json'), JSON.stringify({ name: 'M2-original', password: 'oldkey:xyz' }));
		fs.writeFileSync(path.join(m2Target, 'bot-M2.json'), JSON.stringify({ apiSecret: 'encrypted-under-old-key' }));
		logs.length = 0;
		const m2Restore = await System.restoreConfigFromBackup(m2Staging, m2Target);
		ok(m2Restore.restored === false, 'config restore is refused when the bot config is missing from the archive (app + bot must travel together)');
		ok(JSON.parse(fs.readFileSync(path.join(m2Target, 'app-M2.json'), 'utf8')).name === 'M2-original', 'the target app config is left UNTOUCHED — the app config is never applied without its bot config');
		ok(logs.some(l => /bot configuration|app config alone/i.test(l)), 'the coupling refusal is logged clearly');

		// ── CROSS-INSTANCE: a backup whose config is under a DIFFERENT instance name is not applied, and the
		//    log says so precisely rather than claiming the backup has "no configuration". ──
		System.init({ Common: { logger: function (m) { logs.push(String(m)); } },
			appData: { version: '1.4.0', name: 'OTHER', app_config: 'app-OTHER.json', bot_config: 'bot-OTHER.json' } });
		const m1Target = path.join(root, 'm1-target');
		fs.mkdirSync(m1Target, { recursive: true });
		fs.writeFileSync(path.join(m1Target, 'app-OTHER.json'), JSON.stringify({ name: 'OTHER-original', password: 'otherkey:xyz' }));
		logs.length = 0;
		const m1Restore = await System.restoreConfigFromBackup(m2Staging, m1Target);   // archive holds app-M2.json
		ok(m1Restore.restored === false, 'a backup saved under a different instance name is not applied');
		ok(JSON.parse(fs.readFileSync(path.join(m1Target, 'app-OTHER.json'), 'utf8')).name === 'OTHER-original', 'the target keeps its own config on a cross-instance restore');
		ok(logs.some(l => /different instance's filenames/i.test(l)), 'the cross-instance case logs a precise message, not "no configuration"');

		// ── DEDUPE: colliding config names (or one literally 'hub.json') never yield a duplicate in the set. ──
		System.init({ Common: { logger: function () {} }, appData: { app_config: 'hub.json', bot_config: 'hub.json' } });
		const dnames = System.backupConfigFileNames();
		ok(dnames.filter(n => n === 'hub.json').length === 1, 'backupConfigFileNames dedupes hub.json even when a config is (mis)named after it');
		ok(new Set(dnames).size === dnames.length, 'backupConfigFileNames never returns a duplicate entry');

		console.log('BackupConfigRoundTrip: ' + passed + ' assertions passed');
	}
	finally {

		rmrf(root);
	}

	process.exit(0);
})().catch((e) => { console.error('BackupConfigRoundTrip simulation error:', e); process.exit(1); });
