'use strict';

// Tests the off-site (SFTP) upload core System.sftpPutAndRotate() against a MOCK sftp client (a simulated
// remote filesystem), so it runs with no server. It proves the safety property the redesign is FOR: each
// instance uploads into its own <remoteDir>/<server_id>/ subfolder and rotation is directory-scoped, so it
// can never delete a sibling instance's off-site backups — and a one-time migration folds pre-existing
// flat-folder backups into the subfolder.

const assert = require('assert');
const System = require('../../app/System.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// A minimal in-memory sftp client. Remote fs = Map of absolute path -> { type:'-'|'d', modifyTime }.
function makeMockSftp(seed) {
	const rfs = new Map();
	const ops = [];
	(seed || []).forEach(([p, meta]) => rfs.set(p, meta || { type: '-', modifyTime: 1 }));
	return {
		rfs, ops,
		async stat(p) { if (rfs.has(p)) { return { type: rfs.get(p).type }; } throw new Error('ENOENT ' + p); },
		async mkdir(p) { ops.push('mkdir:' + p); rfs.set(p, { type: 'd' }); },
		async fastPut(_local, remote) { ops.push('put:' + remote); rfs.set(remote, { type: '-', modifyTime: 1000 }); },
		async list(dir) {
			const out = [];
			for (const [p, meta] of rfs) {
				if (p === dir) { continue; }
				if (p.slice(0, p.lastIndexOf('/')) === dir) { out.push({ name: p.slice(dir.length + 1), type: meta.type, modifyTime: meta.modifyTime || 0 }); }
			}
			return out;
		},
		async delete(p) { ops.push('delete:' + p); rfs.delete(p); },
		async rename(src, dest) { ops.push('rename:' + src + '->' + dest); const m = rfs.get(src); rfs.delete(src); rfs.set(dest, m); },
		async end() {}
	};
}

(async () => {

	try {
		// 1) Upload lands in the per-server_id subfolder, not the flat remote dir.
		{
			const sftp = makeMockSftp([]);
			await System.sftpPutAndRotate(sftp, '/local/backup-new.zip.enc', '/remote', { serverId: 'sid1', namePrefix: 'SymBot-NE-backup-', maxBackups: 5 });
			ok(sftp.rfs.has('/remote/sid1/backup-new.zip.enc'), 'upload goes into <remoteDir>/<server_id>/');
			ok(!sftp.rfs.has('/remote/backup-new.zip.enc'), 'nothing is written to the flat remote dir');
		}

		// 2) One-time migration moves THIS instance's flat backups into the subfolder, leaving a sibling's alone.
		{
			const sftp = makeMockSftp([
				[ '/remote/SymBot-NE-backup-old1.zip.enc', { type: '-', modifyTime: 1 } ],
				[ '/remote/SymBot-NE-backup-old2.zip.enc', { type: '-', modifyTime: 2 } ],
				[ '/remote/SymBot-Other-backup-x.zip.enc',  { type: '-', modifyTime: 3 } ]   // a DIFFERENT instance's flat backup
			]);
			await System.sftpPutAndRotate(sftp, '/local/backup-new.zip.enc', '/remote', { serverId: 'sid1', namePrefix: 'SymBot-NE-backup-', maxBackups: 10 });
			ok(sftp.rfs.has('/remote/sid1/SymBot-NE-backup-old1.zip.enc') && sftp.rfs.has('/remote/sid1/SymBot-NE-backup-old2.zip.enc'), 'this instance\'s flat backups migrated into the subfolder');
			ok(sftp.rfs.has('/remote/SymBot-Other-backup-x.zip.enc'), 'a sibling instance\'s flat backup is NOT migrated or touched');
		}

		// 3) Rotation is directory-scoped (newest N by modifyTime) and CANNOT reach another instance's subfolder.
		{
			const sftp = makeMockSftp([
				[ '/remote/sid1/b1.zip.enc', { type: '-', modifyTime: 10 } ],
				[ '/remote/sid1/b2.zip.enc', { type: '-', modifyTime: 20 } ],
				[ '/remote/sid1/b3.zip.enc', { type: '-', modifyTime: 30 } ],
				[ '/remote/sid2/sibling.zip.enc', { type: '-', modifyTime: 5 } ]   // another instance's off-site backup
			]);
			// Upload a 4th into sid1 (modifyTime 1000, newest), keep newest 2 → delete the 2 oldest (b1, b2).
			await System.sftpPutAndRotate(sftp, '/local/backup-new.zip.enc', '/remote', { serverId: 'sid1', namePrefix: 'SymBot-NE-backup-', maxBackups: 2 });
			ok(!sftp.rfs.has('/remote/sid1/b1.zip.enc') && !sftp.rfs.has('/remote/sid1/b2.zip.enc'), 'oldest two in the subfolder rotated out');
			ok(sftp.rfs.has('/remote/sid1/b3.zip.enc') && sftp.rfs.has('/remote/sid1/backup-new.zip.enc'), 'newest two kept');
			ok(sftp.rfs.has('/remote/sid2/sibling.zip.enc'), 'ANOTHER instance\'s subfolder is never touched by rotation (the core safety win)');
		}

		// 4) isTest uploads then deletes the probe and never rotates.
		{
			const sftp = makeMockSftp([ [ '/remote/sid1/keep.zip.enc', { type: '-', modifyTime: 1 } ] ]);
			await System.sftpPutAndRotate(sftp, '/local/probe.zip.enc', '/remote', { serverId: 'sid1', namePrefix: 'p-', maxBackups: 1, isTest: true });
			ok(!sftp.rfs.has('/remote/sid1/probe.zip.enc'), 'test probe deleted after upload');
			ok(sftp.rfs.has('/remote/sid1/keep.zip.enc'), 'isTest never rotates existing backups');
		}

		// 5) No server_id → falls back to the flat dir (never an empty-id subfolder).
		{
			const sftp = makeMockSftp([]);
			await System.sftpPutAndRotate(sftp, '/local/backup-new.zip.enc', '/remote', { serverId: '', namePrefix: 'p-', maxBackups: 5 });
			ok(sftp.rfs.has('/remote/backup-new.zip.enc') && !sftp.rfs.has('/remote//backup-new.zip.enc'), 'no server_id → flat dir, no "//" subfolder');
		}

		// 6) No server_id → the SHARED flat dir is NEVER rotated. Rotation is gated on having our own
		//    <server_id>/ subfolder precisely because rotating a shared folder could delete a sibling
		//    instance's off-site backups. So even a tiny maxBackups leaves the flat dir untouched.
		{
			const sftp = makeMockSftp([
				[ '/remote/a.zip.enc', { type: '-', modifyTime: 1 } ],
				[ '/remote/b.zip.enc', { type: '-', modifyTime: 2 } ],
				[ '/remote/c.zip.enc', { type: '-', modifyTime: 3 } ]
			]);
			await System.sftpPutAndRotate(sftp, '/local/backup-new.zip.enc', '/remote', { serverId: '', namePrefix: 'p-', maxBackups: 1 });
			ok(sftp.rfs.has('/remote/a.zip.enc') && sftp.rfs.has('/remote/b.zip.enc') && sftp.rfs.has('/remote/c.zip.enc'), 'no server_id → the shared flat dir is not rotated (a sibling\'s backups can never be deleted)');
			ok(sftp.rfs.has('/remote/backup-new.zip.enc'), 'the new upload still lands in the flat dir');
		}

		// 7) Rotation only ever deletes BACKUP archives (*.zip.enc). An unrelated file an operator keeps in
		//    the same remote folder is never a rotation victim, even when the folder is over the cap.
		{
			const sftp = makeMockSftp([
				[ '/remote/sid1/b1.zip.enc', { type: '-', modifyTime: 10 } ],
				[ '/remote/sid1/b2.zip.enc', { type: '-', modifyTime: 20 } ],
				[ '/remote/sid1/notes.txt',  { type: '-', modifyTime: 1 } ]
			]);
			// maxBackups 1: after the upload there are 3 archives (b1, b2, backup-new) → keep the newest, delete b1+b2; notes.txt is not a backup and is untouched.
			await System.sftpPutAndRotate(sftp, '/local/backup-new.zip.enc', '/remote', { serverId: 'sid1', namePrefix: 'p-', maxBackups: 1 });
			ok(sftp.rfs.has('/remote/sid1/notes.txt'), 'a non-backup file is never a rotation victim');
			ok(sftp.rfs.has('/remote/sid1/backup-new.zip.enc'), 'the newest backup is kept');
			ok(!sftp.rfs.has('/remote/sid1/b1.zip.enc') && !sftp.rfs.has('/remote/sid1/b2.zip.enc'), 'older backups rotated out');
		}

		// 8) The caller supplies the friendly "<instance>-<file>" remote name (so a raw remote listing shows
		//    which instance a backup belongs to); this function just uses it, and rotation — being
		//    extension-based — is unaffected by the chosen name.
		{
			const sftp = makeMockSftp([
				[ '/remote/sid1/Acct-A-backup-old.zip.enc', { type: '-', modifyTime: 10 } ],
				[ '/remote/sid1/Acct-A-backup-old2.zip.enc', { type: '-', modifyTime: 20 } ]
			]);
			await System.sftpPutAndRotate(sftp, '/local/backup-new.zip.enc', '/remote', { serverId: 'sid1', remoteName: 'Acct-A-backup-new.zip.enc', maxBackups: 2 });
			ok(sftp.rfs.has('/remote/sid1/Acct-A-backup-new.zip.enc'), 'upload uses the supplied "<instance>-<file>" name off-site');
			ok(!sftp.rfs.has('/remote/sid1/backup-new.zip.enc'), 'the bare local basename is NOT used when a remoteName is given');
			ok(!sftp.rfs.has('/remote/sid1/Acct-A-backup-old.zip.enc'), 'rotation still deletes the oldest prefixed archive');
			ok(sftp.rfs.has('/remote/sid1/Acct-A-backup-old2.zip.enc') && sftp.rfs.has('/remote/sid1/Acct-A-backup-new.zip.enc'), 'the newest two prefixed archives are kept');
		}

		// 9) No remoteName → the bare local basename, exactly as before. Back-compat is preserved.
		{
			const sftp = makeMockSftp([]);
			await System.sftpPutAndRotate(sftp, '/local/backup-new.zip.enc', '/remote', { serverId: 'sid1', maxBackups: 5 });
			ok(sftp.rfs.has('/remote/sid1/backup-new.zip.enc'), 'no remoteName → bare basename (unchanged default)');
		}

		// 10) A remoteName carrying a path separator is basename-guarded, so it can never escape the target
		//     folder even if a caller (or a compromised identity source) produced one.
		{
			const sftp = makeMockSftp([]);
			await System.sftpPutAndRotate(sftp, '/local/backup-new.zip.enc', '/remote', { serverId: 'sid1', remoteName: '../evil.zip.enc', maxBackups: 5 });
			ok(sftp.rfs.has('/remote/sid1/evil.zip.enc'), 'a traversal remoteName is reduced to its basename inside the target folder');
			ok(!sftp.rfs.has('/remote/evil.zip.enc'), 'it never lands outside the per-server_id subfolder');
		}

		// 11) Truncation detection: a real local file + a size-aware mock. When the remote size does NOT match
		//     the local file (a dropped/truncated transfer), the partial is deleted and rotation is SKIPPED so
		//     the prior good copies survive. When it matches, rotation proceeds. When the remote size is
		//     indeterminate (server does not report one), it fails SAFE — the upload is kept and rotation runs.
		{
			const fs = require('fs');
			const os = require('os');
			const path = require('path');
			const localFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'symbot-sftp-')), 'backup-new.zip.enc');
			fs.writeFileSync(localFile, Buffer.alloc(5000, 7));   // a real 5000-byte local archive

			// Size-aware mock: fastPut records a size we control; stat returns it.
			function sizeMock(putSize, reportSize) {
				const rfs = new Map();
				return {
					rfs,
					async stat(p) { if (rfs.has(p)) { const m = rfs.get(p); return { type: m.type, size: (reportSize === 'omit' ? undefined : (m.size != null ? m.size : reportSize)) }; } throw new Error('ENOENT ' + p); },
					async mkdir(p) { rfs.set(p, { type: 'd' }); },
					async fastPut(_local, remote) { rfs.set(remote, { type: '-', modifyTime: 1000, size: putSize }); },
					async list(dir) { const out = []; for (const [p, meta] of rfs) { if (p === dir) { continue; } if (p.slice(0, p.lastIndexOf('/')) === dir) { out.push({ name: p.slice(dir.length + 1), type: meta.type, modifyTime: meta.modifyTime || 0 }); } } return out; },
					async delete(p) { rfs.delete(p); },
					async rename() {},
					async end() {}
				};
			}

			// Truncated: remote is 4000 bytes, local is 5000 → deleted, no rotation.
			const trunc = sizeMock(4000);
			trunc.rfs.set('/remote/sid1/old.zip.enc', { type: '-', modifyTime: 1, size: 5000 });
			await System.sftpPutAndRotate(trunc, localFile, '/remote', { serverId: 'sid1', maxBackups: 1 });
			ok(!trunc.rfs.has('/remote/sid1/backup-new.zip.enc'), 'a truncated upload is deleted');
			ok(trunc.rfs.has('/remote/sid1/old.zip.enc'), 'a truncated upload does NOT rotate out the prior good copy');

			// Matching: remote size equals local → kept and rotation proceeds (old rotated out at maxBackups 1).
			const good = sizeMock(5000);
			good.rfs.set('/remote/sid1/old.zip.enc', { type: '-', modifyTime: 1, size: 5000 });
			await System.sftpPutAndRotate(good, localFile, '/remote', { serverId: 'sid1', maxBackups: 1 });
			ok(good.rfs.has('/remote/sid1/backup-new.zip.enc'), 'a verified upload is kept');
			ok(!good.rfs.has('/remote/sid1/old.zip.enc'), 'a verified upload rotates (maxBackups 1 keeps only the newest)');

			// Indeterminate remote size (server omits it) → fail safe: upload kept, rotation still runs.
			const indet = sizeMock(5000, 'omit');
			indet.rfs.set('/remote/sid1/old.zip.enc', { type: '-', modifyTime: 1 });
			await System.sftpPutAndRotate(indet, localFile, '/remote', { serverId: 'sid1', maxBackups: 1 });
			ok(indet.rfs.has('/remote/sid1/backup-new.zip.enc'), 'an unverifiable upload is kept (fails safe, never deleted)');

			try { fs.rmSync(path.dirname(localFile), { recursive: true, force: true }); } catch (e) {}
		}

		console.log('SftpBackupRotate: ' + passed + ' assertions passed');
	}
	catch (e) { console.error('SftpBackupRotate FAIL: ' + (e && e.stack || e)); process.exitCode = 1; }

	process.exit(process.exitCode ? 1 : 0);
})();
