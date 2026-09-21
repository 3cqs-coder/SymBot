'use strict';

// v7.0 upgrade guard: the one-time migration that moves an existing install's LEGACY FLAT logs and backups
// into the per-instance tree (data/instances/<server_id>/<kind>/). This is what makes an in-place upgrade —
// and specifically a Docker upgrade, where logs/, backups/ and data/ are SEPARATE named volumes — carry a
// user's history across intact. Because those volumes are different mounts, a plain fs.renameSync throws
// EXDEV; migrateDataLayout must fall back to copy+verify+unlink so nothing is stranded. This test drives the
// REAL migrateDataLayout() over a seeded flat layout, asserts the files land in the per-instance tree, and
// forces the EXDEV path to prove the cross-volume (Docker) case works too.
//
// It writes under the real project root (that is where pathRoot resolves), namespaced with a throwaway
// "zz-migtest" identity and removed in a finally, so it never disturbs real data.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const Common = require('../../app/Common.js');

const pathRoot = path.resolve(__dirname, '..', '..', '..');
const SID = 'zz-migtest-sid';
const NAME = 'zz-migtest';                         // instance identifier (worker_data.name)
const PRODUCT_NAME = 'SymBot-' + NAME;             // appData.name → backup prefix "SymBot-zz-migtest-backup-"
const DATED = '2026-08-27';

const flatLogs = path.join(pathRoot, 'logs');
const flatBackups = path.join(pathRoot, 'backups');
const instBase = path.join(pathRoot, 'data', 'instances', SID);

const logName = DATED + '-' + NAME + '.log';                 // legacy "<date>-<name>.log"
const bakName = PRODUCT_NAME + '-backup-' + DATED + '_000000.zip.enc';   // legacy "SymBot-<name>-backup-…"
const bakName2 = PRODUCT_NAME + '-backup-' + DATED + '_111111.zip.enc';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok   - ' + msg); } else { failed++; process.exitCode = 1; console.log('  FAIL - ' + msg); } }

const seeded = [];
function seed(dir, name, content) {
	fs.mkdirSync(dir, { recursive: true });
	const p = path.join(dir, name);
	fs.writeFileSync(p, content);
	seeded.push(p);
	return p;
}

(async () => {

	Common.init({ appData: { server_id: SID, name: PRODUCT_NAME, worker_data: { name: NAME } } });

	const realRename = fs.renameSync;

	try {
		// ── Legacy flat files an existing (pre-v7) install would have ──────────────────────────────────
		seed(flatLogs, logName, 'legacy log line\n');
		seed(flatBackups, bakName, 'encrypted-backup-bytes');

		// ── Run the REAL boot migration step ───────────────────────────────────────────────────────────
		await Common.migrateDataLayout();

		ok(fs.existsSync(path.join(instBase, 'logs', logName)), 'legacy flat log migrated into data/instances/<server_id>/logs/');
		ok(!fs.existsSync(path.join(flatLogs, logName)), '…and removed from the old flat logs/ dir (not left stranded)');
		ok(fs.existsSync(path.join(instBase, 'backups', bakName)), 'legacy flat backup migrated into data/instances/<server_id>/backups/');
		ok(!fs.existsSync(path.join(flatBackups, bakName)), '…and removed from the old flat backups/ dir');
		// Content is preserved byte-for-byte.
		ok(fs.readFileSync(path.join(instBase, 'backups', bakName), 'utf8') === 'encrypted-backup-bytes', 'migrated backup content is intact');

		// ── Idempotent: a second boot moves nothing and does not throw ──────────────────────────────────
		await Common.migrateDataLayout();
		ok(fs.existsSync(path.join(instBase, 'backups', bakName)), 'second migrateDataLayout() is a safe no-op (file still present, once)');

		// ── Docker cross-volume case: force EXDEV so the copy+verify+unlink fallback is exercised ───────
		// On Docker, backups/ and data/ are different volumes (mounts), so the CROSS-VOLUME rename (source →
		// destination) throws EXDEV. The fallback copies to a temp file in the DESTINATION dir and renames it
		// into place — that final rename is same-filesystem and must still succeed — so simulate EXDEV only for
		// the cross-volume move (source is the flat layout), and let the same-dir temp→final rename work.
		seed(flatBackups, bakName2, 'second-backup-bytes');
		fs.renameSync = function (from, to) {
			if (String(from).indexOf('.tmp-') !== -1) { return realRename(from, to); }   // same-fs temp→final
			const e = new Error('cross-device link'); e.code = 'EXDEV'; throw e;           // cross-volume src→dest
		};
		try {
			await Common.migrateDataLayout();
		}
		finally {
			fs.renameSync = realRename;
		}
		ok(fs.existsSync(path.join(instBase, 'backups', bakName2)), 'EXDEV (cross-volume) backup still migrated via copy+verify+unlink — the Docker case');
		ok(!fs.existsSync(path.join(flatBackups, bakName2)), '…and the source was removed only after the verified copy');
		ok(fs.readFileSync(path.join(instBase, 'backups', bakName2), 'utf8') === 'second-backup-bytes', 'EXDEV-migrated backup content is intact');
	}
	finally {
		fs.renameSync = realRename;
		// Remove the throwaway per-instance tree and any seeded flat files.
		try { fs.rmSync(path.join(pathRoot, 'data', 'instances', SID), { recursive: true, force: true }); } catch (e) {}
		for (const p of seeded) { try { fs.rmSync(p, { force: true }); } catch (e) {} }
	}

	console.log('\n' + passed + ' passed, ' + failed + ' failed');
	process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('DataLayoutMigration FAIL: ' + (e && e.stack || e)); process.exit(1); });
