'use strict';

// Integration test for the backup artifact index wired into System.js: recording a stored backup,
// reconciling a directory of pre-existing backups, and index-based retention. The key property proven is
// that retention keeps the newest N by RECORDED creation time — not filesystem mtime — which is the bug the
// old prefix+mtime trim had (a restored/moved file could be pruned out of order).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const System = require('../../app/System.js');
const ArtifactIndex = require('../../app/ArtifactIndex.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'symbot-backupindex-'));
const backupsDir = path.join(TMP, 'backups');
fs.mkdirSync(backupsDir, { recursive: true });

// Inject a Common stub whose instanceDataDir/ensureDataDir point at our temp backups dir, plus appData.
System.init({
	Common: {
		logger: function () {},
		instanceDataDir: function () { return backupsDir; },
		ensureDataDir: function () { fs.mkdirSync(backupsDir, { recursive: true }); return backupsDir; }
	},
	appData: { server_id: 'srv-1', worker_data: { name: 'NE', name_display: 'NE Display' } }
});

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function mkfile(name) { fs.writeFileSync(path.join(backupsDir, name), Buffer.from('backup-bytes-' + name)); }

(async () => {

	try {
		// Five backups on disk. Deliberately give them mtimes in the OPPOSITE order to their logical creation
		// time, then seed the index with the true created_utc, to prove retention uses the record, not mtime.
		const files = [ 'SymBot-NE-backup-1.zip.enc', 'SymBot-NE-backup-2.zip.enc', 'SymBot-NE-backup-3.zip.enc', 'SymBot-NE-backup-4.zip.enc', 'SymBot-NE-backup-5.zip.enc' ];
		files.forEach(mkfile);
		// mtimes: file 1 newest on disk, file 5 oldest on disk (reverse of creation order).
		files.forEach((f, i) => { const t = (Date.parse('2026-08-20T00:00:00Z') - i * 3600_000) / 1000; fs.utimesSync(path.join(backupsDir, f), t, t); });
		// true created_utc: file 1 OLDEST, file 5 NEWEST (ascending).
		files.forEach((f, i) => ArtifactIndex.record(backupsDir, 'backups', { server_id: 'srv-1', instance_name: 'NE Display' },
			{ file: f, created_utc: new Date(Date.parse('2026-08-01T00:00:00Z') + i * 86400_000).toISOString() }));

		// recordBackupArtifact on a fresh file writes a record with size + created_utc.
		mkfile('SymBot-NE-backup-6.zip.enc');
		System.recordBackupArtifact(path.join(backupsDir, 'SymBot-NE-backup-6.zip.enc'));
		let m = ArtifactIndex.load(backupsDir, 'backups');
		const rec6 = m.entries.find(e => e.file === 'SymBot-NE-backup-6.zip.enc');
		ok(rec6 && rec6.size > 0 && rec6.created_utc, 'recordBackupArtifact stores size + created_utc');
		ok(m.instance_name === 'NE Display', 'manifest carries the display name (not the filename)');

		// reconcile is a no-op now (all six already tracked).
		const r = System.reconcileBackupsIndex();
		ok(r && r.changed === false, 'reconcile is idempotent once everything is tracked');

		// Retain the newest 3 by created_utc. Files 4,5,6 are newest (Aug 4, Aug 5, and file 6 = now) → kept.
		// Files 1,2,3 (Aug 1-3) are oldest → deleted, DESPITE file 1 having the newest mtime on disk.
		await System.retainBackups(3);
		const remaining = fs.readdirSync(backupsDir).filter(f => /\.zip\.enc$/.test(f)).sort();
		ok(remaining.length === 3, 'exactly 3 backups remain (got: ' + remaining.join(',') + ')');
		ok(remaining.indexOf('SymBot-NE-backup-1.zip.enc') < 0, 'oldest-by-created_utc deleted even though its mtime was newest (mtime bug fixed)');
		ok(remaining.indexOf('SymBot-NE-backup-6.zip.enc') >= 0 && remaining.indexOf('SymBot-NE-backup-5.zip.enc') >= 0, 'newest kept');

		// The index dropped the deleted records too.
		m = ArtifactIndex.load(backupsDir, 'backups');
		ok(m.entries.length === 3 && m.entries.every(e => fs.existsSync(path.join(backupsDir, e.file))), 'index matches the surviving files');

		// A hand-added backup with no record is picked up by reconcile (directory is the source of truth).
		mkfile('SymBot-NE-backup-manual.zip.enc');
		const r2 = System.reconcileBackupsIndex();
		ok(r2.added.indexOf('SymBot-NE-backup-manual.zip.enc') >= 0, 'a hand-added backup is reconciled into the index');

		console.log('BackupIndex: ' + passed + ' assertions passed');
	}
	catch (e) { console.error('BackupIndex FAIL: ' + (e && e.stack || e)); process.exitCode = 1; }
	finally { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} }

	process.exit(process.exitCode ? 1 : 0);
})();
