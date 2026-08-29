'use strict';

// ── SqliteDriver — crash-proof embedded storage for the control plane ────────
//
// A hardened wrapper around Node's built-in `node:sqlite` (zero external/native dependency),
// used for the Hub's own state (users, API keys, audit). SymBot and the Hub are trading
// platforms — they cannot go down or corrupt their state — so this driver follows a proven
// resilience playbook for embedded SQLite:
//
//   • WAL journal mode — concurrent readers never block the single writer, and an app crash
//     mid-write leaves the database consistent (the WAL is replayed on next open).
//   • synchronous = FULL + busy_timeout — durable across OS/power loss, and a briefly-locked
//     database waits instead of erroring. A withRetry() wrapper additionally retries the rare
//     SQLITE_BUSY/LOCKED so a burst of writers never surfaces a "database is locked" error.
//   • Integrity check + AUTO-RECOVERY on open — a corrupt file is never fatal: the driver
//     salvages it (VACUUM INTO a fresh file), else restores the newest good backup, else
//     starts clean — and always keeps the damaged file aside for forensics. It never throws
//     the process down over storage.
//   • Live VACUUM INTO snapshots — a consistent, defragmented backup taken WHILE the database
//     is in use (no stop-the-world, no torn copy), rotated so recovery always has a good one.
//   • wal_checkpoint(TRUNCATE) on graceful shutdown and on a timer, so the WAL can't grow
//     unbounded and the main file stays current.
//
// The surface is deliberately generic (exec/run/get/all/transaction) so repositories build on
// top and a different backend (Postgres, …) could implement the same surface later.

// node:sqlite is built into Node — no external/native dependency. It exists from Node 22.5.0
// and loads WITHOUT the --experimental-sqlite flag from Node 22.13.0+ (the 22 LTS line) and
// 24+. Require it defensively so an older/flagged Node can never crash the process at load:
// availability is reported via SqliteDriver.available and the Store facade falls back to the
// file driver when it is false.
let DatabaseSync = null;
let SQLITE_AVAILABLE = false;
try { ({ DatabaseSync } = require('node:sqlite')); SQLITE_AVAILABLE = typeof DatabaseSync === 'function'; }
catch (e) { SQLITE_AVAILABLE = false; }

const fs = require('fs');
const path = require('path');


// Synchronous sleep (node:sqlite is synchronous, so retry backoff must be too). Uses Atomics
// so it truly yields the CPU rather than spinning. Single exit.
function sleepSync(ms) {
	try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0)); }
	catch (e) { /* SharedArrayBuffer unavailable — skip the backoff */ }
}


function SqliteDriver(opts) {

	opts = opts || {};

	const dbPath     = opts.path;                                   // main database file
	const backupDir  = opts.backupDir || (dbPath ? path.join(path.dirname(dbPath), 'backups') : null);
	const backupKeep = opts.backupKeep != null ? opts.backupKeep : 14;
	const logger     = typeof opts.logger === 'function' ? opts.logger : function () {};

	let db = null;
	let checkpointTimer = null;

	function log(msg) { logger('SqliteDriver: ' + msg); }


	// Open + harden a database file. Applies the durability pragmas and verifies integrity;
	// throws only if the file is genuinely unusable (the caller's open() handles recovery).
	function openHardened(file) {

		const d = new DatabaseSync(file);

		// Durability + concurrency pragmas. WAL: readers don't block the writer and a crash is
		// recoverable. FULL: fsync on commit — safe across power loss. busy_timeout: wait on a
		// lock rather than error. foreign_keys: enforce referential integrity.
		d.exec('PRAGMA journal_mode = WAL;');
		d.exec('PRAGMA synchronous = FULL;');
		d.exec('PRAGMA busy_timeout = 5000;');
		d.exec('PRAGMA foreign_keys = ON;');

		return d;
	}


	// Fast structural check. Returns true if the database reports healthy.
	function isHealthy(d) {
		try {
			const row = d.prepare('PRAGMA quick_check;').get();
			const val = row && (row.quick_check || row['quick_check'] || Object.values(row)[0]);
			return String(val).toLowerCase() === 'ok';
		}
		catch (e) { return false; }
	}


	// Newest backup file, or null.
	function latestBackup() {
		try {
			if (!backupDir || !fs.existsSync(backupDir)) { return null; }
			const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).map(f => path.join(backupDir, f))
				.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
			return files[0] || null;
		}
		catch (e) { return null; }
	}


	// Open the database, recovering automatically from corruption. Order of recovery:
	//   1. open + integrity check — if healthy, done;
	//   2. move the damaged file aside, try to SALVAGE it (VACUUM INTO a fresh file);
	//   3. else RESTORE the newest good backup;
	//   4. else start CLEAN.
	// Never throws for a recoverable condition — storage must not take the process down.
	function open() {

		if (!dbPath) { db = new DatabaseSync(':memory:'); openPragmas(db); return db; }

		fs.mkdirSync(path.dirname(dbPath), { recursive: true });

		// 1. Normal open.
		try {
			const d = openHardened(dbPath);
			if (isHealthy(d)) { db = d; startCheckpointTimer(); return db; }
			try { d.close(); } catch (e) {}
			log('integrity check FAILED for ' + dbPath + ' — entering recovery');
		}
		catch (e) { log('open failed (' + e.message + ') — entering recovery'); }

		// Preserve the damaged file for forensics.
		const stamp = String(fsSafeTimestamp());
		const corruptPath = dbPath + '.corrupt-' + stamp;
		try { if (fs.existsSync(dbPath)) { fs.renameSync(dbPath, corruptPath); log('moved damaged file to ' + corruptPath); } } catch (e) {}
		[ '-wal', '-shm' ].forEach(ext => { try { if (fs.existsSync(dbPath + ext)) { fs.renameSync(dbPath + ext, corruptPath + ext); } } catch (e) {} });

		// 2. Salvage the damaged copy.
		try {
			if (fs.existsSync(corruptPath)) {
				const src = new DatabaseSync(corruptPath);
				src.exec("VACUUM INTO '" + dbPath.replace(/'/g, "''") + "';");
				src.close();
				const d = openHardened(dbPath);
				if (isHealthy(d)) { db = d; log('SALVAGED database via VACUUM INTO'); startCheckpointTimer(); return db; }
				try { d.close(); } catch (e) {}
				try { fs.unlinkSync(dbPath); } catch (e) {}
			}
		}
		catch (e) { log('salvage failed: ' + e.message); try { fs.unlinkSync(dbPath); } catch (e2) {} }

		// 3. Restore the newest good backup.
		const backup = latestBackup();
		if (backup) {
			try {
				fs.copyFileSync(backup, dbPath);
				const d = openHardened(dbPath);
				if (isHealthy(d)) { db = d; log('RESTORED from backup ' + backup); startCheckpointTimer(); return db; }
				try { d.close(); } catch (e) {}
				try { fs.unlinkSync(dbPath); } catch (e) {}
			}
			catch (e) { log('restore-from-backup failed: ' + e.message); }
		}

		// 4. Start clean (last resort — never crash).
		db = openHardened(dbPath);
		log('started a CLEAN database (no salvage or backup available)');
		startCheckpointTimer();
		return db;
	}


	function openPragmas(d) {
		try { d.exec('PRAGMA journal_mode = WAL;'); d.exec('PRAGMA synchronous = FULL;'); d.exec('PRAGMA busy_timeout = 5000;'); d.exec('PRAGMA foreign_keys = ON;'); } catch (e) {}
	}


	// A filesystem-safe timestamp without Date formatting quirks.
	function fsSafeTimestamp() { return Date.now(); }


	// Retry a synchronous DB operation on transient lock errors. Single exit.
	function withRetry(fn, attempts) {
		attempts = attempts || 6;
		let lastErr;
		for (let i = 0; i < attempts; i++) {
			try { return fn(); }
			catch (e) {
				lastErr = e;
				if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(e.message) && i < attempts - 1) { sleepSync(40 * (i + 1)); continue; }
				throw e;
			}
		}
		throw lastErr;
	}


	// ── Generic query surface (retry-wrapped) ────────────────────────────────
	function exec(sql) { return withRetry(() => db.exec(sql)); }
	function run(sql, params) { return withRetry(() => db.prepare(sql).run(...(params || []))); }
	function get(sql, params) { return withRetry(() => db.prepare(sql).get(...(params || []))); }
	function all(sql, params) { return withRetry(() => db.prepare(sql).all(...(params || []))); }

	// Run fn() inside a transaction (atomic unit-of-work). Rolls back on any throw. Single exit.
	function transaction(fn) {
		return withRetry(() => {
			db.exec('BEGIN IMMEDIATE;');
			try { const r = fn(api); db.exec('COMMIT;'); return r; }
			catch (e) { try { db.exec('ROLLBACK;'); } catch (e2) {} throw e; }
		});
	}


	// ── Maintenance: checkpoint + live backup ────────────────────────────────

	// Fold the WAL back into the main file so it can't grow unbounded. Best-effort.
	function checkpoint() { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (e) { log('checkpoint failed: ' + e.message); } }

	function startCheckpointTimer() {
		if (checkpointTimer || !dbPath) { return; }
		checkpointTimer = setInterval(checkpoint, 5 * 60 * 1000);   // every 5 minutes
		if (checkpointTimer.unref) { checkpointTimer.unref(); }
	}

	// Take a consistent, defragmented snapshot WHILE the database is live (VACUUM INTO takes a
	// read snapshot — no torn copy, no stop-the-world), then prune old snapshots. Returns the
	// backup path or null. Never throws. Single exit.
	function backup() {
		let out = null;
		if (dbPath && backupDir) {
			try {
				fs.mkdirSync(backupDir, { recursive: true });
				// Two backups in the same millisecond would produce the same name, and VACUUM INTO fails if
				// the target already exists — so add a short counter suffix until the name is free. Rare
				// (backups are minutes apart in practice), but this makes a burst safe instead of failing.
				const stamp = fsSafeTimestamp();
				let file = path.join(backupDir, 'hub-' + stamp + '.db');
				for (let i = 1; fs.existsSync(file) && i < 1000; i++) { file = path.join(backupDir, 'hub-' + stamp + '-' + i + '.db'); }
				withRetry(() => db.exec("VACUUM INTO '" + file.replace(/'/g, "''") + "';"));
				out = file;
				// Rotate: keep the newest `backupKeep` (the optional -N suffix keeps same-ms snapshots matched).
				const files = fs.readdirSync(backupDir).filter(f => /^hub-\d+(?:-\d+)?\.db$/.test(f)).map(f => path.join(backupDir, f))
					.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
				files.slice(backupKeep).forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
				log('backup written: ' + file);
			}
			catch (e) { log('backup failed: ' + e.message); out = null; }
		}
		return out;
	}


	// List the available backup snapshots (newest first) with basic metadata.
	function listBackups() {
		const out = [];
		try {
			if (backupDir && fs.existsSync(backupDir)) {
				fs.readdirSync(backupDir).filter(f => /^hub-\d+\.db$/.test(f)).forEach(f => {
					const p = path.join(backupDir, f);
					const st = fs.statSync(p);
					out.push({ name: f, size: st.size, modified: st.mtime });
				});
				out.sort((a, b) => b.modified - a.modified);
			}
		}
		catch (e) { log('listBackups failed: ' + e.message); }
		return out;
	}


	// Restore the database from one of its own backup snapshots (by file name within backupDir).
	// Safety: only a plain `hub-<ts>.db` name is accepted (no path traversal), the snapshot is
	// integrity-checked before it is trusted, and the CURRENT database is snapshotted first so a
	// restore is itself reversible. Never throws. Single exit.
	function restore(fileName) {
		let result = { success: false, error: 'Restore unavailable' };
		try {
			if (!dbPath || !backupDir) { result = { success: false, error: 'No database path' }; }
			else {
				const base = path.basename(String(fileName || ''));
				if (!/^hub-\d+\.db$/.test(base)) { result = { success: false, error: 'Invalid backup file' }; }
				else {
					const src = path.join(backupDir, base);
					if (!fs.existsSync(src)) { result = { success: false, error: 'Backup not found' }; }
					else {
						let ok = false;
						try { const probe = new DatabaseSync(src); ok = isHealthy(probe); probe.close(); } catch (e) { ok = false; }
						if (!ok) { result = { success: false, error: 'Backup failed its integrity check' }; }
						else {
							try { backup(); } catch (e) {}   // snapshot current state first (reversible)
							close();

							let copyErr = null;
							try {
								fs.copyFileSync(src, dbPath);
								[ '-wal', '-shm' ].forEach(ext => { try { if (fs.existsSync(dbPath + ext)) { fs.unlinkSync(dbPath + ext); } } catch (e) {} });
							}
							catch (e) { copyErr = e; }

							// ALWAYS reopen after closing — even if the copy failed — so a failed restore
							// degrades to "store still usable" rather than a dead null handle that makes every
							// subsequent users/keys/audit call throw until the process is restarted.
							open();

							if (copyErr) { result = { success: false, error: 'Restore copy failed: ' + copyErr.message }; }
							else { log('RESTORED from snapshot ' + base); result = { success: true }; }
						}
					}
				}
			}
		}
		catch (e) { log('restore failed: ' + e.message); result = { success: false, error: e.message }; }
		return result;
	}


	// Graceful close: checkpoint so the main file is current, stop the timer, close the handle.
	function close() {
		if (checkpointTimer) { clearInterval(checkpointTimer); checkpointTimer = null; }
		if (db) { checkpoint(); try { db.close(); } catch (e) {} db = null; }
	}


	const api = {
		open, close, exec, run, get, all, transaction,
		checkpoint, backup, listBackups, restore, isHealthy: () => isHealthy(db), latestBackup,
		backupDir: backupDir,
		get raw() { return db; }
	};

	return api;
}


// Whether Node's built-in SQLite is usable in this runtime (see the require note above). The
// Store facade checks this and falls back to the file driver when false, so the Hub starts on
// any supported Node.
SqliteDriver.available = SQLITE_AVAILABLE;

module.exports = SqliteDriver;
