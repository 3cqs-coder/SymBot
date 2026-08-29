'use strict';

const os = require('os');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const bson = require('bson');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { ZipArchive: ArchiverZip } = require('archiver');
const unzipper = require('unzipper');
const fetch = require('node-fetch-commonjs');
// Worker→Hub wire message types. Use the shared constants (never raw strings) so a future rename of a
// wire value updates every call site at once, per the convention in Hub/MessageTypes.js.
const { WORKER_TO_HUB } = require('./Hub/MessageTypes.js');
const ArtifactIndex = require('./ArtifactIndex.js');
const sftpClient = require('ssh2-sftp-client');
const { exec, spawn } = require('child_process');

const prompt = require('prompt-sync')({
	sigint: true
});

const pathRoot = path.resolve(__dirname, ...Array(2).fill('..'));

let shareData;
let shutDownFunction;
let dbUrl;


const tempDir = pathRoot + '/temp';
const rollbackDir = pathRoot + '/rollbacks';
const MAX_ROLLBACKS = 3;

// A collision-proof path in the SHARED temp dir. Several Hub instances run from ONE install and share this
// directory, so ANY fixed name collides when two instances act at the same moment — most importantly the
// daily System backup, which fires on every instance at once: whichever finished first would unlink the
// shared file and the others would fail to encrypt it (ENOENT) or compress over each other into a corrupt,
// short archive. A uuid prefix isolates every instance's (and every run's) in-flight file. The `label` is
// kept only for readability while debugging; callers keep the clean, instance-agnostic STORED name separately.
// Use this for EVERY new write into tempDir so this class of bug can never come back.
function uniqueTempPath(label) {
	// basename the label defensively: it is only a readability tag, so a future caller passing a path (or a
	// separator) can never steer the result out of tempDir or create nested dirs. Empty → "tmp".
	const tag = path.basename(String(label == null ? 'tmp' : label)) || 'tmp';
	return tempDir + '/' + shareData.Common.uuidv4() + '-' + tag;
}

// Directories an automatic upgrade must neither snapshot (they are not shipped code) nor overwrite
// (they hold the user's data and runtime state). Kept as ONE list so the rollback-snapshot step and
// the file-copy step can never drift apart and silently drop something — e.g. the Hub database
// (data/hub/hub.db), the logs an operator may need to diagnose an issue, or the login sessions.
// config/ and data/ are additionally merge-preserved by updateSystem, so a rollback restores code
// without reverting configuration; node_modules is rebuilt by the post-copy `npm install`.
const UPGRADE_PRESERVE_DIRS = new Set([
	'backups', 'config', 'data', 'uploads', 'rollbacks',
	'logs', 'sessions', 'node_modules', 'temp', 'downloads'
]);

// First version that encrypts config secrets at rest. Rolling back to anything OLDER means the
// restored code has no decryption, so its config secrets must be handed back as plaintext.
const ENCRYPTION_MIN_VERSION = '7.0';

// Numeric, dot-segment version compare: -1 / 0 / 1. Tolerates missing/short versions.
function compareVersions(a, b) {
	const pa = String(a == null ? '0' : a).split('.').map(n => parseInt(n, 10) || 0);
	const pb = String(b == null ? '0' : b).split('.').map(n => parseInt(n, 10) || 0);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const d = (pa[i] || 0) - (pb[i] || 0);
		if (d !== 0) { return d < 0 ? -1 : 1; }
	}
	return 0;
}

// After a rollback restores older code, decrypt the at-rest config secrets IF the target version
// predates encryption support (or the snapshot records no version — i.e. an old one). The current,
// encryption-aware code performs this, so the restored older version — which cannot decrypt — can
// still read exchange/provider credentials. A same-era rollback is left encrypted (both understand
// it). Never throws: rollback safety must not break the rollback itself.
async function maybeDecryptSecretsForRollback(snapshotDir) {
	try {
		let version = null;
		try {
			const raw = fs.readFileSync(path.join(snapshotDir, '.rollback-manifest.json'), 'utf8');
			version = (JSON.parse(raw) || {}).version || null;
		}
		catch (e) { version = null; }   // no/unreadable manifest ⇒ treat as a pre-encryption snapshot

		if (version && compareVersions(version, ENCRYPTION_MIN_VERSION) >= 0) { return; }   // same era ⇒ keep encrypted

		if (shareData.Common && typeof shareData.Common.decryptConfigSecretsForRollback === 'function') {
			const r = await shareData.Common.decryptConfigSecretsForRollback();
			if (r && r.changed > 0) {
				shareData.Common.logger('Rollback: decrypted config secrets for compatibility with the older version (' + (version || 'unknown') + ').');
			}
		}
	}
	catch (e) { /* never break the rollback */ }
}


const connectDb = async (url) => {

	if (url == undefined || url == null || url == '') {

		url = dbUrl;
	}

	try {

		const connection = mongoose.createConnection(url, {});

		// Ensure the connection is fully established
		await new Promise((resolve, reject) => {

			connection.once('open', resolve);
			connection.once('error', reject);
		});

		return connection;
	}
	catch (err) {

		shareData.Common.logger('Could not connect to MongoDB: ' + err);

		throw err;
	}
};


const resetDatabase = async (resetDb, resetServerId, resetAiChats = false) => {

	let success = true;

	let isErr;
	let collectionBots;
	let collectionDeals;
	let collectionSessions;
	let collectionServer;
	let collectionAiChats;

	try {

		const dbConnection = await connectDb();
		const db = dbConnection.db;

		if (resetDb) {

			collectionBots = await db.dropCollection('bots');
			collectionDeals = await db.dropCollection('deals');
			collectionSessions = await db.dropCollection('sessions');

			// Auth stores and observational logs are part of a full database reset. The initial owner
			// re-seeds from the config password on the next start, so a full reset leaves a clean, usable
			// login. `signal_activity` is the inbound-signal log (like `audit_log`) — cleared so a full reset
			// is a true clean slate. Tolerate absence on installs that predate any of these features.
			for (const name of ['users', 'api_keys', 'audit_log', 'signal_activity']) {

				try { await db.dropCollection(name); } catch (e) {}
			}
		}

		if (resetAiChats) {

			try { collectionAiChats = await db.dropCollection('ai_conversations'); } catch(e) {}
		}

		if (resetServerId) {

			collectionServer = await db.dropCollection('server');

			// Blank the server_id in THIS instance's OWN server config file, not a hardcoded
			// 'server.json'. A running instance may use an alternate --server-config (e.g.
			// server-authtest.json); hardcoding 'server.json' here would wipe a *different*
			// instance's identity. In a Hub setup that shared file backs other instances, so the
			// stray blank makes the Hub abort at boot ("server_id is missing"). A fresh id is
			// generated for the correct instance on its next start (verifyServerId).
			const serverConfigFile = (shareData.appData && shareData.appData.server_config) ? shareData.appData.server_config : 'server.json';

			await shareData.Common.saveConfig(serverConfigFile, { 'server_id': ''});
		}

		await dbConnection.close();
	}
	catch(e) {

		success = false;
		isErr = e;
	}

	const resObj =  {
						'success': success,
						'error': isErr,
						'collectionBots': collectionBots,
						'collectionDeals': collectionDeals,
						'collectionServer': collectionServer,
						'collectionSessions': collectionSessions,
						'collectionAiChats': collectionAiChats
					};

	return resObj;
};


const resetSessions = async () => {

	let success = true;
	let isErr;
	let collectionSessions;

	const collection = 'sessions';

	try {

		const dbConnection = await connectDb();
		const db = dbConnection.db;

		const collections = await db.listCollections({
			'name': collection
		}).toArray();

		if (collections.length > 0) {

			collectionSessions = await db.collection(collection).drop();
		}

		await dbConnection.close();
	}
	catch (e) {

		success = false;
		isErr = e;
	}

	const resObj = {
		'success': success,
		'error': isErr,
		'collectionSessions': collectionSessions
	};

	return resObj;
};


// Drop a specific set of collections (used by the auth-store console reset commands). Missing
// collections are tolerated so the command works on installs that predate the permissions
// system. Returns per-collection drop results.
const resetAuthCollections = async (collections) => {

	let success = true;
	let isErr;

	const dropped = {};

	try {

		const dbConnection = await connectDb();
		const db = dbConnection.db;

		for (const name of collections) {

			try {

				const exists = await db.listCollections({ 'name': name }).toArray();

				dropped[name] = exists.length > 0 ? await db.collection(name).drop() : false;
			}
			catch (e) {

				dropped[name] = false;
			}
		}

		await dbConnection.close();
	}
	catch (e) {

		success = false;
		isErr = e;
	}

	return { 'success': success, 'error': isErr, 'dropped': dropped };
};


const backupAllCollections = async (dbConnection, dir, includeChats = true, includeSchedules = true) => {

    let success = true;
	let isErr;

    try {
        const db = dbConnection.db;
        const collections = await db.listCollections().toArray();

        if (!fs.existsSync(dir)) {

			fs.mkdirSync(dir, { recursive: true });
        }

		const dbDir = dir + '/database';

		fs.mkdirSync(dbDir, { recursive: true });

        for (const collection of collections) {

            const collectionName = collection.name;

			// The AI learning corpus is agnostic, patterns-only know-how — not per-deal
			// data. It is deliberately kept OUT of the database backup/restore cycle so a
			// restore of old deal data can never wipe or fragment learning; it travels via
			// its own validated export/import pack instead.
			if (collectionName === 'ai_learning') {
				continue;
			}
			// The 'server' collection is this host's IDENTITY (serverId), not portable data. It must never
			// travel in a backup: the target host keeps its own identity (server.json + verifyServerId), and
			// scoped rows are re-homed to it on restore. Backing it up would only risk overwriting a
			// different host's identity and blocking its next boot with a Server ID mismatch.
			if (collectionName === 'server') {
				continue;
			}
			if (collectionName === 'ai_conversations' && !includeChats) {
				shareData.Common.logger('Skipping ai_conversations backup (include_chats is false).');
				continue;
			}
			if (collectionName === 'schedules' && !includeSchedules) {
				shareData.Common.logger('Skipping schedules backup (include_schedules is false).');
				continue;
			}
            // Scope server_id-bearing collections (schedules, audit, api keys, users, ai_conversations,
            // recipe_state, …) to THIS instance, so a backup taken against a database shared by several
            // instances (Hub app.json sharing) captures only this instance's rows — never a sibling's.
            // Collections with no server_id (deals, bots) live in a per-instance database and back up whole.
            const serverId = shareData.appData.server_id;
            const isScoped = serverId != undefined && serverId !== '' && (await db.collection(collectionName).findOne({ server_id: { $exists: true } })) != null;
            const backupQuery = isScoped ? { 'server_id': serverId } : {};

            const cursor = db.collection(collectionName).find(backupQuery);
            const filePath = path.join(dbDir, `${collectionName}.bson`);
            const fileStream = fs.createWriteStream(filePath);

            // Drain the cursor into the stream, then AWAIT the flush ('finish') before moving on, so the
            // archive step never compresses a half-written .bson (a silently-truncated, unrestorable
            // backup). A cursor or stream error rejects this promise and is caught by the surrounding
            // try/catch (success:false) — never a process-killing throw from an async 'error' callback.
            await new Promise((resolve, reject) => {

                fileStream.on('error', reject);
                fileStream.on('finish', resolve);

                (async () => {
                    while (await cursor.hasNext()) {
                        const doc = await cursor.next();
                        const serializedData = bson.serialize(doc);
                        const dataSizeBuffer = Buffer.alloc(4);
                        dataSizeBuffer.writeInt32LE(serializedData.length);
                        fileStream.write(dataSizeBuffer);
                        fileStream.write(serializedData);
                    }
                    fileStream.end();
                })().catch(reject);
            });

			shareData.Common.logger(`Backup of ${collectionName} successful.`);
        }
    }
	catch (err) {
 
		success = false;
		isErr = err.message;

		shareData.Common.logger('Backup failed: ' + isErr);
    }

    return { 'success': success, 'error': isErr };
};


// Collections the identity re-home must NOT touch. Two groups:
//   • scoped-but-special — 'server' is the host identity (never portable); 'audit_log' / 'audit_checkpoint'
//     carry a per-server_id hash chain that changing server_id would invalidate (a false tamper alarm), so the
//     old chain stays valid under the old id; 'schedules' is re-homed separately by the Scheduler (its unique
//     {server_id, type:'backup'} index needs singleton-aware handling); 'ai_learning' is deliberately
//     server_id-agnostic know-how.
//   • money-path — 'deals' and 'bots' are UNSCOPED (they carry no server_id; one database is one instance's
//     trading data) and are the trading collections. The $exists guard below already skips them, but they are
//     named here too so this best-effort boot task can NEVER issue a write to trading data — not even to a
//     stray server_id an older build's sweep may have left on them, which a later reset would otherwise move.
// Every other (genuinely scoped) collection re-homes via the foreign-id sweep below.
const REHOME_SKIP = new Set([ 'server', 'audit_log', 'audit_checkpoint', 'schedules', 'ai_learning', 'deals', 'bots' ]);

// Re-home this instance's OWN database rows onto the CURRENT server_id. A SymBot database always holds exactly
// ONE live server_id: it is derived from the database's own `server` collection, and the Hub refuses to start a
// second live worker on an id already in use (Hub/Main.js), so two live instances never share one database.
// Therefore ANY scoped row under a FOREIGN id — neither the current id nor blank — is this instance's own, left
// behind by a PREVIOUS id (a "Reset server ID", or a restore that re-minted it), and belongs on the current id.
// That invariant holds identically for a standalone and a Hub worker, so ONE unconditional sweep serves both —
// no need to know the exact previous id. Blank rows are left for each collection's own blank→current adoption at
// init. Runs on EVERY boot (idempotent — a no-op when nothing is stranded), so it also recovers a change a
// previous boot did not finish, making the Watchdog's "a restart re-homes them" true. Mirrors the Scheduler's
// adoptOrphanSchedules. Boot-time and best-effort (off the trading path); a failure logs and continues, never
// throwing into startup.
async function rehomeScopedIdentity(newId) {

	if (!newId) { return { moved: 0 }; }

	try {

		const dbConnection = await connectDb();

		try { return await rehomeScopedIdentityOnDb(dbConnection.db, newId); }
		finally { await dbConnection.close(); }
	}
	catch (e) {

		shareData.Common.logger('Identity re-home skipped (→ ' + newId + '): ' + ((e && e.message) ? e.message : e));
		return { moved: 0 };
	}
}

// The re-home core, operating on an injected db handle (exposed for tests). Iterates every collection, skips the
// special ones, and moves every row whose server_id is a FOREIGN id (present, but neither the current id nor
// blank) to newId. The `$exists: true` is load-bearing: WITHOUT it, `{ $nin: ['', newId] }` would also match
// documents that have NO server_id field at all — Mongo treats a missing field as "not in" the list — so the
// `$set` would ADD a stray server_id to unscoped collections (deals, bots, sessions), a needless mass write to
// trading data. With it, only genuinely scoped rows move; a collection with no server_id field is a true no-op,
// and a brand-new scoped collection is covered automatically. One collection failing never aborts the rest.
async function rehomeScopedIdentityOnDb(db, newId) {

	let moved = 0;
	const collections = await db.listCollections().toArray();

	for (const collection of collections) {

		if (REHOME_SKIP.has(collection.name)) { continue; }

		try {
			const r = await db.collection(collection.name).updateMany(
				{ server_id: { $exists: true, $nin: [ '', newId ] } },
				{ $set: { server_id: newId } }
			);

			if (r && r.modifiedCount) {
				moved += r.modifiedCount;
				shareData.Common.logger('Identity re-home: moved ' + r.modifiedCount + ' row(s) in ' + collection.name + ' to ' + newId + '.');
			}
		}
		catch (e) { /* one collection failing must not abort the rest */ }
	}

	if (moved) { shareData.Common.logger('Identity re-home complete: ' + moved + ' scoped row(s) carried to ' + newId + '.'); }

	return { moved };
}


// Watchdog backstop for rehomeScopedIdentity: warn if a scoped collection still holds rows under a PREVIOUS
// server_id (neither the current one nor blank) — a server_id change that did not fully re-home, which would
// hide those rows from the instance and drop them from its backups. Runs for BOTH a standalone and a Hub
// worker: a SymBot database holds exactly one live server_id (see rehomeScopedIdentity), so a foreign id is
// unambiguously stranded in either topology — never a live sibling. Reuses REHOME_SKIP so it checks exactly the
// collections rehomeScopedIdentity is responsible for, reads off the app's WARM connection (never opens its
// own), and is warn-only like every Watchdog check — it returns a finding, never blocks startup.
async function strandedScopedRowsCheck() {

	try {

		const sid = shareData && shareData.appData && shareData.appData.server_id;
		if (!sid) { return null; }

		let db;
		try { db = shareData.DB && shareData.DB.mongoose && shareData.DB.mongoose.connection && shareData.DB.mongoose.connection.db; }
		catch (e) { return null; }
		if (!db) { return null; }

		const stranded = [];
		const collections = await db.listCollections().toArray();

		for (const collection of collections) {

			if (REHOME_SKIP.has(collection.name)) { continue; }

			try {
				const n = await db.collection(collection.name).countDocuments({ server_id: { $exists: true, $nin: [ '', sid ] } });
				if (n) { stranded.push(collection.name + '(' + n + ')'); }
			}
			catch (e) { /* a collection absent / unreadable is not a finding */ }
		}

		return stranded.length
			? { action: 'watchdog.stranded_scoped_rows', target: String(stranded.length), detail: 'scoped rows remain under a previous server_id (a server_id change that did not fully re-home): ' + stranded.join(', ') + '. A restart re-homes them; if it persists, report it.' }
			: null;
	}
	catch (e) { return null; }   // best-effort; a check error is never itself a finding
}


const restoreAllCollections = async (dbConnection, dir, includeSchedules = false) => {

    let success = true;
	let isErr;
	let destructive = false;   // becomes true once PHASE 2 starts modifying live collections

	const dbDir = dir + '/database';

    try {
        const db = dbConnection.db;

        // Verify the archive against its manifest BEFORE reading or touching anything. A checksum mismatch
        // or a missing file throws here, while destructive is still false, so the live database is never
        // emptied for a corrupted or altered backup. (No-op for older archives without a manifest.)
        await verifyBackupManifest(dir);

        const files = fs.readdirSync(dbDir);

		if (files.length < 1) {

			const msg = 'No database files found';

			throw new Error(msg);
		}

// ── PHASE 1: parse & validate EVERY document from EVERY .bson into memory BEFORE touching the
        // live database. A truncated or corrupt backup (the dominant failure mode — an interrupted or
        // partially-flushed archive) throws HERE, so live collections are never emptied for a backup that
        // cannot be fully read. Nothing is written to the database until this phase completes cleanly.
        const staged = [];   // [{ collectionName, docs }]

        for (const file of files) {

            if (!file.endsWith('.bson')) { continue; }

            const collectionName = path.basename(file, '.bson');

            // Never let a restore touch the AI learning corpus — agnostic know-how that must persist
            // across restores, not per-deal data. (Also excluded from backups; defensive for old archives.)
            if (collectionName === 'ai_learning') { continue; }

            // Leave the current instance's schedules (and their credentials) untouched when the operator
            // chose not to restore them.
            if (collectionName === 'schedules' && !includeSchedules) {
                shareData.Common.logger('Skipping schedules restore (include_schedules is false).');
                continue;
            }

            const dataBuffer = fs.readFileSync(path.join(dbDir, file));

            const docs = [];
            let offset = 0;

            while (offset < dataBuffer.length) {

                // Bounds-check the size header and the document body so a truncated file is detected as an
                // error rather than reading past the buffer or deserializing garbage.
                if (offset + 4 > dataBuffer.length) {
                    throw new Error('Truncated backup file ' + file + ' (incomplete document header) — restore aborted, no data changed.');
                }

                const documentSize = dataBuffer.readInt32LE(offset);
                offset += 4;

                if (documentSize <= 0 || offset + documentSize > dataBuffer.length) {
                    throw new Error('Truncated or corrupt backup file ' + file + ' (document overruns the file) — restore aborted, no data changed.');
                }

                const docBuffer = dataBuffer.slice(offset, offset + documentSize);
                docs.push(bson.deserialize(docBuffer));   // throws on corrupt BSON → aborts before any delete
                offset += documentSize;
            }

            staged.push({ collectionName, docs });
        }

        if (!staged.length) {
            throw new Error('No restorable collections found in the backup.');
        }

        // ── PHASE 2: the whole backup parsed cleanly — now apply it. Each collection is cleared and
        // refilled with a single bulk insert. (Full cross-collection atomicity would need a temp-collection
        // swap; parse-all-first already removes the dominant “wipe then find the backup unreadable” path.)
        // From here on the live database is being mutated — a failure past this point means the data may be
        // partial, so the caller must fail-safe (shut down) rather than resume trading on it.
        destructive = true;

        const serverId = shareData.appData.server_id;

        for (const { collectionName, docs } of staged) {

            // The 'server' collection is this host's IDENTITY (serverId), not portable data. Never restore
            // it from a backup — overwriting it would make the database serverId disagree with this host's
            // server.json and the next boot would refuse to start (Server ID mismatch). verifyServerId
            // re-seeds it from server.json when absent. (It is also excluded from new backups; this skip
            // additionally protects a restore from an older backup that still contains it.)
            if (collectionName === 'server') {

                shareData.Common.logger('Restore: skipping the server identity collection (host identity is not restored).');
                continue;
            }

            const collection = db.collection(collectionName);

            // Scope the wipe-and-refill for server_id-bearing collections to THIS instance, so a restore
            // against a shared database never deletes or overwrites a sibling instance's rows. Collections
            // with no server_id (deals, bots) live in a per-instance database and are replaced whole.
            const isScoped = serverId != undefined && serverId !== '' && docs.some(d => d && d.server_id !== undefined);

            if (isScoped) {

                // Adopt the backup's scoped rows under THIS host's identity. A backup is scoped to a single
                // source server_id (see backupAllCollections), which differs from this host's server_id when
                // restoring onto a fresh or different host. Rewrite every row's server_id to the target's so
                // schedules, users, API keys, the audit log, AI conversations and recipe state actually
                // restore on a new host instead of being silently dropped (they would never match the
                // target's server_id otherwise). On a same-host restore this remap is a no-op; a sibling
                // instance's rows in a shared database are untouched (we only delete/insert under the target).
                const mine = docs.filter(Boolean).map(d => { d.server_id = serverId; return d; });

                await collection.deleteMany({ 'server_id': serverId });

                if (mine.length) { await collection.insertMany(mine, { 'ordered': false }); }

                shareData.Common.logger(`Restore of ${collectionName} successful (${mine.length} document(s), adopted under this instance).`);
            }
            else {

                await collection.deleteMany();

                if (docs.length) { await collection.insertMany(docs, { 'ordered': false }); }

                shareData.Common.logger(`Restore of ${collectionName} successful (${docs.length} document(s)).`);
            }
        }
    }
	catch (err) {

        success = false;
		isErr = err.message;

		shareData.Common.logger('Restore failed: ' + isErr);
    }

    return { 'success': success, 'error': isErr, 'destructive': destructive };
};


const backupDb = async (includeChats, includeSchedules) => {

	// Default to the backup schedule's settings for cron backups; manual backups pass explicit values
	if (includeChats === undefined) {
		includeChats = !(shareData.appData.cron_backup && shareData.appData.cron_backup.include_chats === false);
	}
	if (includeSchedules === undefined) {
		includeSchedules = !(shareData.appData.cron_backup && shareData.appData.cron_backup.include_schedules === false);
	}

	let res;

	const dir = tempDir + '/' + shareData.Common.uuidv4();

	shareData.Common.logger('System backup started');

	const dbConnection = await connectDb();

	try {

		res = await backupAllCollections(dbConnection, dir, includeChats, includeSchedules);
	}
	finally {

		await dbConnection.close();
	}

	return { 'success': res.success, 'error': res.error, 'dir': dir };
};


const restoreDb = async (dir, includeSchedules = false, restoreConfig = false) => {

	let res;

	shareData.Common.logger('Database restore started');

	const dbConnection = await connectDb();

	try {

		res = await restoreAllCollections(dbConnection, dir, includeSchedules);

		// Apply the archive's bundled configuration only after the database restored cleanly, and only when
		// asked. It runs within the extract dir's lifetime (before processRestoreDb cleans it up). A failure
		// here marks the restore failed AFTER the destructive DB phase, so the caller fail-safes (shuts down)
		// rather than resume trading on a database/config it could not fully apply.
		if (res && res.success && restoreConfig) {

			try { await restoreConfigFromBackup(dir); }
			catch (e) { res.success = false; res.error = 'Configuration restore failed: ' + e.message; }
		}
	}
	finally {

		await dbConnection.close();
	}

	return { 'success': res.success, 'error': res.error, 'destructive': res.destructive, 'dir': dir };
};


async function routeBackupDb(req, res) {

	if (await appStarting(req, res)) {

		return;
	}

	shareData.Common.auditEvent(req, 'system.backup', '', 'database backup');

	const body = req.body;

	let password = body.password;
	let includeChats = shareData.Common.convertBoolean(body.include_chats, true);
	let includeSchedules = shareData.Common.convertBoolean(body.include_schedules, true);
	// Including configuration (app.json + bot config + hub.json) is OPT-IN and off by default: it makes the
	// backup a portable, self-contained recovery unit, but it also means the archive carries your exchange
	// keys and app-password hash, so it is only ever bundled when the operator explicitly asks.
	let includeConfig = shareData.Common.convertBoolean(body.include_config, false);

	// The backup archive is encrypted with a password the user chooses (so they can restore it later).
	// Validate it up front and return a CLEAR message — otherwise a missing password reached the crypto
	// layer and surfaced a cryptic "The data argument must be … Received undefined". Reject BEFORE
	// processBackupDb, which pauses processing, so a missing password never pauses the system.
	if (typeof password !== 'string' || password.trim() === '') {

		res.status(400).send('A password is required to encrypt the backup. Choose a password (you will need the same password to restore this backup).');
		return;
	}

	try {

		const resBackup = await processBackupDb(password, includeChats, includeSchedules, includeConfig);

		const msg = resBackup.msg;
		const outFileEnc = resBackup.full_path;
		const fileNameEnc = resBackup.file_name;

		if (resBackup.success) {

			// Serve the on-demand archive under a friendly "<instance>-<file>" name (same resolver as the stored
			// backups list and the off-site SFTP upload), so a manually-downloaded backup also says which
			// instance it came from. This is always THIS instance's own manual backup, so the resolver falls
			// back to its own display name; it degrades to the bare name and never throws.
			const dlName = shareData.Common.friendlyArtifactName(outFileEnc, fileNameEnc, 'backups', false);

			res.download(outFileEnc, dlName, (err) => {

				// Always remove the temp .enc once the download settles (success or error) so manual backups
				// don't accumulate in the temp dir and slowly fill the disk.
				fs.unlink(outFileEnc, () => {});

				// Only send an error status if nothing was written yet — once the download has begun the
				// headers are already sent and res.status()/send() would throw.
				if (err && !res.headersSent) {

					res.status(500).send('Error sending file');
				}
			});
		}
		else {

			res.status(500).send(msg);
		}
	}
	catch (e) {

		// processBackupDb lifts its own pause in a finally, but a thrown backup (disk full, fs error) would
		// otherwise leave this request hanging with no response. Reply with a clear 500 (mirrors routeRestoreDb).
		const emsg = (e && e.message) ? e.message : String(e);
		shareData.Common.logger('Database backup failed: ' + emsg);
		if (!res.headersSent) { res.status(500).send('Database backup failed: ' + emsg); }
	}
}


async function routeRestoreDb(req, res) {

	if (await appStarting(req, res)) {

		return;
	}

	shareData.Common.auditEvent(req, 'system.restore', '', 'database restore');

	const tempPath = req.file.path;
	// Use ONLY the basename of the uploaded filename: a crafted multipart name ("../../…") must never
	// steer the rename/unlink below outside tempDir. The rollback path guards the same way; mirror it here.
	// uuid-unique too (uniqueTempPath): under the Hub two instances could otherwise restore same-named
	// uploads into the shared temp dir at once and clobber each other.
	const targetPath = uniqueTempPath(path.basename(String(req.file.originalname || 'restore.upload')));

	const body = req.body;

	let password = body.password;
	let convertData = shareData.Common.convertBoolean(body.convertData, false);
	let resetServerId = shareData.Common.convertBoolean(body.resetServerId, false);
	let resetAiChats  = shareData.Common.convertBoolean(body.resetAiChats, false);
	// Restoring schedules is opt-in: by default a restore does NOT overwrite the running
	// instance's own schedules and their stored credentials.
	let includeSchedules = shareData.Common.convertBoolean(body.includeSchedules, false);
	// Restoring configuration is opt-in and off by default: when on (and the archive carries config), it
	// overwrites this server's app.json + bot config + hub.json with the backup's, so the instance becomes a
	// clone of the source. All-or-nothing and confirmed in the UI; applied only after a clean DB restore.
	let restoreConfig = shareData.Common.convertBoolean(body.restoreConfig, false);

	try {

		// Check if a file with the same name already exists
		try {

			await fsp.access(targetPath, fs.constants.F_OK);

			// File exists, remove it
			await fsp.unlink(targetPath);
		}
		catch (err) {

			// If the error is anything other than file not existing, rethrow
			if (err.code !== 'ENOENT') throw err;
		}

		// Process restore
		await processRestoreDb(tempPath, targetPath, password, convertData, resetServerId, resetAiChats, includeSchedules, restoreConfig);

		// Send a success response
		res.status(200).send('File uploaded and database restored successfully.');
	}
	catch (err) {

		//console.error('File processing error:', err);

		res.status(500).send('An error occurred during the file processing: ' + err.message);
	}
}


async function processBackupDb(password, includeChats = true, includeSchedules = true, includeConfig = false) {

	let msg;
	let outFileEnc;
	let fileNameEnc;
	let success = false;
	let dir = null;

	const dateParts = shareData.Common.getDateParts(new Date());

	let dateNow = dateParts.date
	let timeNow = dateParts.time;

	dateNow = dateNow.replace(/[^a-zA-Z0-9]/g, '');
	timeNow = timeNow.replace(/[^a-zA-Z0-9]/g, '');

	// The backup lives in this instance's own per-server_id folder (and off-site, in its own server_id
	// subfolder), so the filename no longer needs the instance name or product token to stay distinct —
	// identity is the folder + the manifest. Legacy "SymBot-<name>-backup-…" archives still list, download
	// and prune fine (matched by the ".zip.enc" shape); only NEW files use this simplified name.
	const fileName = 'backup-' + dateNow + '_' + timeNow + '.zip';

	// STAGING path is uuid-unique in the shared temp dir (see uniqueTempPath) so simultaneous per-instance
	// backups can't collide; the STORED/downloaded name stays the clean, instance-agnostic fileName (it lands
	// in this instance's own per-server_id backups folder, so it needs no prefix there).
	const outFile = uniqueTempPath(fileName);

	await pause(true, 'System Backup Processing');

	// Everything between pausing and unpausing runs inside try/finally so the pause is ALWAYS lifted,
	// even if a step throws (a disk-full compress, a manifest read error). Otherwise system_pause would
	// stick and the trading loop would stall until the next successful backup or a restart — trading must
	// never stall on a best-effort maintenance task.
	try {

		// Wait short delay for data to stop processing
		await shareData.Common.delay(5000);

		const resBackup = await backupDb(includeChats, includeSchedules);

		success = resBackup['success'];
		dir = resBackup['dir'];

		// Bundle configuration into the staging dir BEFORE the manifest is written, so the manifest checksums
		// cover the config files too. A failure here fails the whole backup (a backup is non-destructive, so
		// failing is safe) rather than quietly producing a config-less archive the operator believes has config.
		if (success && includeConfig) {

			try {

				const copied = await copyConfigIntoBackup(dir);
				shareData.Common.logger('Included configuration in backup: ' + copied.join(', '));
			}
			catch (e) {

				success = false;
				msg = 'Include configuration failed: ' + e.message;
				shareData.Common.logger(msg);
			}
		}

		if (success) {

			const manifestFile = dir + '/.manifest.json';

			// Create manifest
			await logManifest(shareData.appData.version, dir, manifestFile);

			shareData.Common.logger('Compressing: ' + fileName);

			await compress(dir, outFile);

			removeDirectorySync(dir);
			dir = null;   // staging removed — the finally must not try to remove it again

			outFileEnc = outFile + '.enc';
			fileNameEnc = fileName + '.enc';

			shareData.Common.logger('Encrypting: ' + fileName);

			const encryptObj = await encryptFile(outFile, outFileEnc, password);

			// Delete the unencrypted staging file. Guarded: the encrypted archive is already written, so the
			// backup has SUCCEEDED — a failure to remove a throwaway temp file (e.g. it's already gone) must
			// never turn a good backup into a failed one, as the shared-temp-name collision used to.
			try { fs.unlinkSync(outFile); } catch (e) { /* temp already gone / unremovable — backup still succeeded */ }

			if (!encryptObj.success) {

				success = false;

				msg = 'Encryption failed: ' + encryptObj.error;

				shareData.Common.logger(msg);
			}
		}
	}
	finally {

		// Remove the staging dir if a failure left it behind (on the success path it was already removed
		// and dir set to null), then ALWAYS lift the pause so trading can never be left frozen.
		if (dir) { try { removeDirectorySync(dir); } catch (e) {} }

		await pause(false);
	}

	return { 'success': success, 'msg': msg, 'full_path': outFileEnc, 'file_name': fileNameEnc };
}


async function processRestoreDb(tempPath, targetPath, password, convertData, resetServerId, resetAiChats = false, includeSchedules = false, restoreConfig = false) {

	await pause(true, 'Database Restore Processing');
	await shareData.Common.delay(5000);

	const dir = tempDir + '/' + shareData.Common.uuidv4();

	let targetPathDec;
	let success = true;
	let caughtError = null;
	let destructive = false;   // did the restore get far enough to modify live collections?

	try {

		await fsp.rename(tempPath, targetPath);

		targetPathDec = targetPath + '.zip';

		shareData.Common.logger('Decrypting: ' + targetPath);

		const decryptObj = await decryptFile(targetPath, targetPathDec, password);

		if (!decryptObj.success) {

			let msg = 'Decryption failed: ' + decryptObj.error;
			shareData.Common.logger(msg);

			throw new Error(msg);
		}

		shareData.Common.logger('Decompressing: ' + targetPathDec);

		await decompress(targetPathDec, dir);

		let res = await restoreDb(dir, includeSchedules, restoreConfig);

		destructive = !!res.destructive;   // capture BEFORE the throw so the finally can decide fail-safe

		if (!res.success) {

			throw new Error(res.error);
		}
	}
	catch (err) {

		success = false;

		caughtError = new Error('An error occurred during restore: ' + err.message);
	}
	finally {

		removeDirectorySync(dir);

		// Guard each cleanup: if restore threw early (before the .zip / decrypted file was created, or
		// with targetPathDec still undefined), an unguarded unlinkSync would throw ENOENT/TypeError from
		// the finally and MASK the real restore error in the response.
		try { if (targetPath && fs.existsSync(targetPath)) { fs.unlinkSync(targetPath); } } catch (e) {}
		try { if (targetPathDec && fs.existsSync(targetPathDec)) { fs.unlinkSync(targetPathDec); } } catch (e) {}

		if (success) {

			if (convertData) {

				await shareData.DCABot.convertDataToSandBox();
			}

			if (resetAiChats) {

				await resetDatabase(false, false, true);
			}

			if (resetServerId) {

				await resetDatabase(false, true);
			}

			shutDownFunction();
		}
		else if (destructive) {

			// The restore failed AFTER it began modifying live collections — the database may be partial.
			// Resuming trading here would run against emptied/half-restored deals and bots. Fail-safe:
			// shut down so the operator retries from the intact backup file instead of trading on bad data.
			shareData.Common.logger('Restore failed after it began writing to the database — shutting down to avoid trading on partially restored data. Restore again from a good backup, then restart.');
			shutDownFunction();
		}
		else {

			// Failed before any write (bad/corrupt backup, decrypt/decompress error) — the live database
			// was never touched, so it is safe to resume trading unchanged.
			await pause(false);
		}
	}

	if (caughtError) throw caughtError;
}


async function generateChecksum(filePath) {

	const hash = crypto.createHash('sha256');
	const stream = fs.createReadStream(filePath);

	return new Promise((resolve, reject) => {
		stream.on('data', (data) => hash.update(data));
		stream.on('end', () => resolve(hash.digest('hex')));
		stream.on('error', reject);
	});
}


// The basename of one of this instance's OWN config filenames. Under the Hub an instance can run per-instance
// config files (e.g. app-NE.json / bot-NE.json) instead of the defaults, so backup/restore must follow the
// ACTUAL names this instance uses — read from shareData.appData — or it would capture, and on restore
// overwrite, the WRONG file (a sibling's config). basename() also keeps a crafted value from escaping config/.
function configBaseName(key, dflt) {

	return path.basename(String((shareData.appData && shareData.appData[key]) || dflt));
}

function appConfigBaseName() { return configBaseName('app_config', 'app.json'); }
function botConfigBaseName() { return configBaseName('bot_config', 'bot.json'); }


// The config files that make a backup a complete, portable recovery unit. The app config is the identity /
// app-password / provider-secret anchor; the bot config carries the (encrypted) exchange credentials;
// hub.json carries Hub-level settings when present. They travel together so the at-rest secrets, which
// are encrypted with a key derived from the app password, still decrypt on the target. Both the app and
// bot config are taken by their ACTUAL per-instance names (see appConfigBaseName), so a Hub instance using
// app-NE.json / bot-NE.json backs up and restores those, not a hardcoded app.json / bot.json. Every entry is
// deduped so an unusual config named after a sibling (or literally 'hub.json') can't be listed twice.
function backupConfigFileNames() {

	const names = [];

	for (const name of [ appConfigBaseName(), botConfigBaseName(), 'hub.json' ]) {
		if (names.indexOf(name) < 0) { names.push(name); }
	}

	return names;
}


// Copy the instance's config into the backup staging dir so an opt-in "include configuration" backup is
// self-contained. The files are ALREADY at-rest encrypted (exchange creds, provider secrets) and the
// archive itself is separately password-encrypted, so this introduces no new plaintext. app.json must be
// present — it is the identity/password anchor without which the other secrets could not decrypt on
// restore — so its absence is a hard error rather than a silently config-less "include config" backup.
async function copyConfigIntoBackup(dir, configDir) {

	const srcDir = configDir || (pathRoot + '/config');
	const outDir = dir + '/config';

	fs.mkdirSync(outDir, { recursive: true });

	const copied = [];

	for (const name of backupConfigFileNames()) {

		const src = srcDir + '/' + name;
		if (fs.existsSync(src)) { fs.copyFileSync(src, outDir + '/' + name); copied.push(name); }
	}

	const appBase = appConfigBaseName();
	if (copied.indexOf(appBase) < 0) {

		throw new Error('config/' + appBase + ' not found — cannot include configuration in the backup');
	}

	return copied;
}


// Apply an archive's bundled config over the live config, all-or-nothing: only when the app config is
// present (the identity/password anchor), and then every bundled config file together, so the running
// instance never ends up with a mismatched app + bot config whose secrets can't decrypt. Basename-only
// writes keep a crafted entry from escaping config/. On success the operator must sign in with the SOURCE
// server's app password — its hash came across in the app config — which the secret-decryptability
// watchdog also verifies on the next boot.
async function restoreConfigFromBackup(dir, configDir) {

	const srcDir = dir + '/config';
	const destDir = configDir || (pathRoot + '/config');

	// The app config is the required identity/password anchor. Match it by this instance's ACTUAL app-config
	// name (app.json, or a per-instance app-NE.json under the Hub) — a backup made by the same instance
	// carries that exact name — so a config-bearing backup is not mistaken for a config-less one.
	const appBase = appConfigBaseName();
	const botBase = botConfigBaseName();

	if (!fs.existsSync(srcDir + '/' + appBase)) {

		// Distinguish a genuinely config-less archive from one whose config was saved under a DIFFERENT
		// instance's filenames (a cross-instance restore): the latter IS present, just not applicable here.
		// Either way nothing is applied — a configuration restore requires the target to use the same config
		// filenames as the backup — but say WHICH so the operator isn't told a config-bearing backup is empty.
		let foreign = false;
		try { foreign = fs.existsSync(srcDir) && fs.readdirSync(srcDir).some(f => /\.json$/i.test(f) && f !== 'hub.json'); }
		catch (e) {}
		shareData.Common.logger(foreign
			? 'Restore: this backup\'s configuration was saved under a different instance\'s filenames (this instance expects ' + appBase + '), so it was NOT applied — a configuration restore requires the target to use the same config filenames. The database was restored; configuration left unchanged.'
			: 'Restore configuration was requested, but this backup does not include configuration — the database was restored and configuration was left unchanged.');
		return { restored: false };
	}

	// app.json + the bot config are COUPLED: the bot config's exchange secrets are encrypted with a key
	// derived from the app password in app.json. Restoring the app config WITHOUT the matching bot config
	// would leave the target's existing (old-password) bot secrets undecryptable — so require both together.
	// If the bot config isn't in the archive under this instance's name, apply NEITHER and leave the live
	// config untouched (the database was already restored; the operator can retry with a matching backup).
	if (!fs.existsSync(srcDir + '/' + botBase)) {

		shareData.Common.logger('Restore: this backup contains the app configuration but not this instance\'s bot configuration (' + botBase + '), so configuration was NOT applied — restoring the app config alone would leave the encrypted exchange secrets undecryptable. The database was restored; configuration left unchanged.');
		return { restored: false };
	}

	// Apply ONLY the known config allowlist (the app config + bot config + hub.json), never a wildcard of
	// whatever .json the archive happens to carry — so a crafted archive can't drop an unexpected config file
	// (e.g. a foreign server.json to hijack the instance identity) into the live config. Basename-only writes
	// keep a crafted entry from escaping config/.
	//
	// hub.json is SHARED, Hub-owned state — it lists EVERY instance. An instance restore must never overwrite
	// a LIVE hub.json, or it would revert the Hub topology and drop sibling instances' entries. So hub.json is
	// restored ONLY to SEED a machine that has none yet (a from-scratch recovery); an existing one is left
	// untouched. The instance's OWN app + bot config are always restored (to their per-instance names) and
	// stay coupled — they carry the matching app password so the bot config's encrypted secrets still decrypt.
	const names = backupConfigFileNames().filter(n => {
		const base = path.basename(n);
		if (!fs.existsSync(srcDir + '/' + base)) { return false; }
		if (base === 'hub.json' && fs.existsSync(destDir + '/' + base)) {
			shareData.Common.logger('Restore: preserved the existing shared hub.json (Hub topology / other instances\' entries) — an instance restore never overwrites it.');
			return false;
		}
		return true;
	});

	// Clear any orphaned .restore-tmp files left beside the live config by a previously interrupted restore,
	// so stale temps never accumulate or get confused with a live file.
	try {
		for (const f of fs.readdirSync(destDir)) {
			if (f.endsWith('.restore-tmp')) { try { fs.unlinkSync(destDir + '/' + f); } catch (_) {} }
		}
	}
	catch (_) {}

	// Two-phase apply: copy every file to a .restore-tmp beside its target FIRST, and only once ALL copies
	// have succeeded rename them into place (rename-over is atomic on the same filesystem). A mid-COPY failure
	// (disk full, a transient AV/file lock on Windows) leaves nothing renamed, so the live config is entirely
	// unchanged rather than a mismatched app.json + bot config. The rename phase itself is a short sequence of
	// individually-atomic renames — a crash BETWEEN them is a narrow window that could leave a mismatched set;
	// the orphaned-temp sweep above plus the restore fail-safe (shutdown on partial restore) and the boot
	// secret-decryptability watchdog catch that case. Any staged temp is cleaned up on a copy failure.
	const staged = [];

	try {

		for (const name of names) {

			const base = path.basename(name);
			const tmp = destDir + '/' + base + '.restore-tmp';
			fs.copyFileSync(srcDir + '/' + base, tmp);
			staged.push({ tmp: tmp, dest: destDir + '/' + base });
		}

		for (const s of staged) {
			// Final guard for the shared hub.json: if the Hub created a live hub.json in the narrow window
			// since we decided to seed it, do NOT clobber it — drop the staged copy and skip. Closes the
			// TOCTOU on the "an instance restore never overwrites a live shared hub.json" guarantee.
			if (path.basename(s.dest) === 'hub.json' && fs.existsSync(s.dest)) {
				try { fs.unlinkSync(s.tmp); } catch (_) {}
				continue;
			}
			fs.renameSync(s.tmp, s.dest);
		}
	}
	catch (e) {

		for (const s of staged) { try { if (fs.existsSync(s.tmp)) { fs.unlinkSync(s.tmp); } } catch (_) {} }
		throw new Error('configuration files could not be applied (' + ((e && e.message) ? e.message : e) + ') — configuration left unchanged');
	}

	shareData.Common.logger('Configuration restored from backup (' + names.join(', ') + '). Sign in with the app password from the SOURCE server — its exchange keys and settings are now in place; the boot secret check will confirm they decrypt.');

	return { restored: true, files: names };
}


// Verify a backup against its manifest BEFORE the destructive restore phase. A checksum mismatch (in-band
// corruption or tampering that still deserializes) or a missing file aborts the restore while the live
// database is still untouched. A version mismatch is a warning, not a refusal — restoring an older backup
// after an upgrade is legitimate; it is logged so a cross-version restore is at least visible. Older or
// hand-made archives with no manifest simply skip this extra check (the per-document BSON bounds checks
// still guard truncation).
async function verifyBackupManifest(dir) {

	const manifestPath = dir + '/.manifest.json';

	if (!fs.existsSync(manifestPath)) {

		shareData.Common.logger('Backup has no manifest — skipping checksum verification (older or hand-made archive; document bounds checks still apply).');
		return;
	}

	let manifest;

	try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
	catch (e) { throw new Error('Backup manifest is unreadable (' + e.message + ') — restore aborted, no data changed.'); }

	const backupVersion = manifest && manifest.version;
	const runningVersion = shareData.appData && shareData.appData.version;

	if (backupVersion && runningVersion && String(backupVersion) !== String(runningVersion)) {

		shareData.Common.logger('Note: this backup was made on version ' + backupVersion + ' but this instance is version ' + runningVersion + ' — proceeding with the restore; verify your data afterward.');
	}

	let checked = 0;

	for (const entry of ((manifest && manifest.files) || [])) {

		if (!entry || entry.type === 'directory' || !entry.checksum) { continue; }

		const filePath = dir + '/' + entry.filename;

		if (!fs.existsSync(filePath)) {

			throw new Error('Backup is incomplete — "' + entry.filename + '" is listed in the manifest but missing from the archive. Restore aborted, no data changed.');
		}

		const sum = await generateChecksum(filePath);

		if (sum !== entry.checksum) {

			throw new Error('Backup file "' + entry.filename + '" failed its checksum — the archive is corrupted or was altered. Restore aborted, no data changed.');
		}

		checked++;
	}

	// Defense-in-depth: reject any file present in the archive but NOT listed in the manifest. The checksum
	// loop above only proves the LISTED files are intact; without this, a crafted archive could smuggle an
	// extra config file (e.g. a foreign server.json) or a stray collection past verification. The manifest
	// never lists itself, so .manifest.json is the one allowed extra. Filenames are separator-normalized so a
	// backup taken on one OS verifies on another.
	const norm = (p) => String(p).split(/[\\/]/).join('/');
	const listed = new Set(((manifest && manifest.files) || []).filter(e => e && e.type !== 'directory' && e.checksum).map(e => norm(e.filename)));

	const walk = (base) => {
		for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
			const full = base + '/' + ent.name;
			if (ent.isDirectory()) { walk(full); continue; }
			const rel = norm(path.relative(dir, full));
			if (rel === '.manifest.json') { continue; }
			if (!listed.has(rel)) {
				throw new Error('Backup contains an unexpected file not in its manifest ("' + rel + '") — restore aborted, no data changed.');
			}
		}
	};
	walk(dir);

	shareData.Common.logger('Backup manifest verified — ' + checked + ' file checksum(s) match, no unexpected files.');
}


async function logManifest(version, directory, manifestFile) {

	const manifest = {
		date: new Date().toISOString(),
		version: version,
		files: []
	};

	async function processDirectory(dir) {

		const files = await fsp.readdir(dir);

		for (const file of files) {

			const filePath = path.join(dir, file);
			const stats = await fsp.lstat(filePath);

			const fileEntry = {
				filename: path.relative(directory, filePath),
				permissions: stats.mode.toString(8), // File permissions in octal format
				timestamp: stats.mtime.toISOString(), // Modification timestamp,
				size: stats.size // File size in bytes
			};

			if (stats.isFile()) {

				fileEntry.checksum = await generateChecksum(filePath);
				manifest.files.push(fileEntry);
			}
			else if (stats.isDirectory()) {

				fileEntry.type = 'directory';
				manifest.files.push(fileEntry);
				await processDirectory(filePath); // Recursively process the directory
			}
		}
	}

	await processDirectory(directory);

	await fsp.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
}


async function compress(source, out) {

    return new Promise((resolve, reject) => {

		const output = fs.createWriteStream(out);
        const archive = new ArchiverZip({ zlib: { level: 9 } });

        output.on('close', () => resolve(archive.pointer()));

		// Handle errors from the write stream
		output.on('error', err => reject(err));

		// Handle errors from archiver
        archive.on('error', err => reject(err));

        archive.pipe(output);

        const sourcePath = path.resolve(source);

        try {

			if (fs.lstatSync(sourcePath).isDirectory()) {

				archive.directory(sourcePath, false, { dot: true });
            }
			else {

				archive.file(sourcePath, { name: path.basename(sourcePath) });
            }

            archive.finalize();
        }
		catch (err) {
 
			reject(err); // Handle errors related to sourcePath or archiving setup
        }
    });
}


async function decompress(zipPath, outDir) {

	try {

		const directory = await unzipper.Open.file(zipPath);

		// Resolve the extraction root once so every entry can be checked against it. A backup archive
		// is operator-supplied (the uploader also chooses its encryption password), so entry paths are
		// untrusted input — a crafted entry like "../../symbot.js" would otherwise escape outDir and
		// overwrite live application code (zip-slip). Any entry that resolves outside the root is skipped.
		const rootResolved = path.resolve(outDir);
		const rootPrefix = rootResolved + path.sep;

		const failedEntries = [];

		for (const entry of directory.files) {

			try {

				const fullPath = path.join(outDir, entry.path);

				const entryResolved = path.resolve(fullPath);

				if (entryResolved !== rootResolved && !entryResolved.startsWith(rootPrefix)) {

					// Path traversal attempt — refuse to write outside the extraction directory.
					continue;
				}

				if (entry.type === 'Directory') {

					await fsp.mkdir(fullPath, {
						recursive: true
					});
				}
				else {

					await fsp.mkdir(path.dirname(fullPath), {
						recursive: true
					});

					await new Promise((resolve, reject) => {

						// Bind 'error' on BOTH the source entry stream and the write stream. A corrupt or
						// truncated archive errors on the SOURCE; without a handler there it emits on a
						// listener-less stream and this Promise never settles, hanging the restore/update.
						const source = entry.stream();
						source.on('error', reject);
						source
							.pipe(fs.createWriteStream(fullPath))
							.on('finish', resolve)
							.on('error', reject);
					});
				}
			}
			catch (entryErr) {

				// Record and continue so we attempt every entry, then fail the whole extraction below.
				// Silently skipping a corrupt entry would let the caller apply an INCOMPLETE tree — on the
				// update path (no manifest check) that means a codebase missing a file; on restore it is
				// caught downstream by verifyBackupManifest, but failing here is clearer and safer.
				failedEntries.push(entry && entry.path ? entry.path : '(unknown)');
			}
		}

		if (failedEntries.length > 0) {

			throw new Error('Extraction failed for ' + failedEntries.length + ' entr(ies): ' + failedEntries.slice(0, 5).join(', ') + (failedEntries.length > 5 ? ' …' : ''));
		}

	}
	catch (err) {

		//console.error(`Failed to decompress "${zipPath}" to "${outDir}":`, err);
		throw err;
	}
}


async function encrypt(data, password) {

	let success = false, encryptedData = null, error = null;

	try {
	
		const key = crypto.createHash('sha256').update(password).digest();
		const iv = crypto.randomBytes(16);
		// Authenticated encryption (AES-256-GCM) so a tampered secret or backup is DETECTED on decrypt
		// rather than silently returning garbage (CBC is unauthenticated and malleable). The stored shape
		// stays "ivHex:…" so the isEncrypted() prefix check keeps recognizing it; the extra auth-tag field
		// makes it a THREE-part "ivHex:tagHex:base64ct" (a legacy CBC value is two-part "ivHex:base64ct"),
		// which decrypt() tells apart by colon-count.
		const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

		const serialized = Buffer.from(JSON.stringify({ data }));
		const encrypted = Buffer.concat([cipher.update(serialized), cipher.final()]);
		const tag = cipher.getAuthTag();

		encryptedData = iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('base64');

		success = true;
	}
	catch (err) {

		error = 'Unexpected error: ' + err.message;
	}

	return { success, data: encryptedData, error };
}


async function decrypt(data, password) {

	let success = false, decryptedData = null, error = null;

	try {

		const key = crypto.createHash('sha256').update(password).digest();
		const parts = String(data).split(':');

		let decryptedBuffer;

		if (parts.length === 3) {

			// Authenticated AES-256-GCM: ivHex:tagHex:base64ct. setAuthTag before final() so a tampered
			// ciphertext (or wrong key) throws instead of returning forged plaintext.
			const iv  = Buffer.from(parts[0], 'hex');
			const tag = Buffer.from(parts[1], 'hex');
			const ct  = Buffer.from(parts[2], 'base64');

			if (!parts[0] || !parts[1] || !parts[2]) { throw new Error('Invalid encrypted format'); }

			const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
			decipher.setAuthTag(tag);
			decryptedBuffer = Buffer.concat([decipher.update(ct), decipher.final()]);
		}
		else {

			// Legacy unauthenticated AES-256-CBC: ivHex:base64ct. Still decrypts so secrets and backups
			// written before this change keep working; each is upgraded to GCM the next time it is written.
			const [ ivHex, encryptedBase64 ] = parts;

			if (!ivHex || !encryptedBase64) { throw new Error('Invalid encrypted format'); }

			const iv = Buffer.from(ivHex, 'hex');
			const encryptedBuffer = Buffer.from(encryptedBase64, 'base64');

			const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
			decryptedBuffer = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
		}

		const {	data: originalData } = JSON.parse(decryptedBuffer.toString());

		decryptedData = originalData;

		success = true;
	}
	catch (err) {

		error = 'Unexpected error: ' + err.message;
	}

	return { success, data: decryptedData, error };
}


// Authenticated backup-archive encryption (AES-256-GCM) with a salted, memory-hard scrypt key
// derivation over the user-chosen backup password (a plain single SHA-256 is fast and rainbow-tableable
// for a low-entropy password). New backups carry an 8-byte magic marker so decryptFile can tell them
// from legacy CBC archives, which stay restorable. File layout (new):
//   [magic:8][salt:16][iv:12][ciphertext…][gcm tag:16]
const BACKUP_MAGIC = Buffer.from('SYMBKGV1');

async function encryptFile(inputPath, outputPath, password) {

	try {

		const salt = crypto.randomBytes(16);
		const iv   = crypto.randomBytes(12);
		// scryptSync is fine here: one derivation per backup, an infrequent operation. Default cost params
		// keep memory modest so it also runs on small VPS hosts, while being far stronger than sha256.
		const key = crypto.scryptSync(password, salt, 32);
		const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

		const input = fs.createReadStream(inputPath);
		const output = fs.createWriteStream(outputPath);

		return await new Promise((resolve, reject) => {

			input.on('error',  (error) => reject({ success: false, error: 'Read stream error: ' + error.message }));
			cipher.on('error', (error) => reject({ success: false, error: 'Encryption failed: ' + error.message }));
			output.on('error', (error) => reject({ success: false, error: 'Write stream error: ' + error.message }));
			output.on('finish', () => resolve({ success: true }));

			// Header first. The GCM auth tag is only known once encryption finishes, so it is APPENDED after
			// the ciphertext — which means the cipher output is written manually (a plain pipe would end the
			// output stream before the tag could be written). Backpressure is honored via pause/drain.
			output.write(Buffer.concat([ BACKUP_MAGIC, salt, iv ]));

			cipher.on('data', (chunk) => {

				if (!output.write(chunk)) { cipher.pause(); output.once('drain', () => cipher.resume()); }
			});

			cipher.on('end', () => {

				output.write(cipher.getAuthTag());
				output.end();
			});

			input.pipe(cipher);
		});
	}
	catch (error) {

		return { success: false, error: 'Unexpected error: ' + ((error && (error.error || error.message)) || String(error)) };
	}
}


// Stream the legacy (unauthenticated AES-256-CBC, sha256 key) restore path — used for archives written
// before authenticated backups, so an existing .enc file always restores. iv = first 16 bytes.
function decryptFileLegacyCbc(inputPath, outputPath, password) {

	const key = crypto.createHash('sha256').update(password).digest();

	return (async () => {

		const iv = Buffer.alloc(16);
		const ivFile = await fs.promises.open(inputPath, 'r');
		try { await ivFile.read(iv, 0, 16, 0); } finally { await ivFile.close(); }

		const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
		const input = fs.createReadStream(inputPath, { start: 16 });
		const output = fs.createWriteStream(outputPath);

		return await new Promise((resolve, reject) => {

			input.on('error',    (error) => reject({ success: false, error: 'Read stream error: ' + error.message }));
			decipher.on('error', (error) => reject({ success: false, error: 'Decryption failed: ' + error.message }));
			output.on('error',   (error) => reject({ success: false, error: 'Write stream error: ' + error.message }));
			output.on('finish', () => resolve({ success: true }));

			input.pipe(decipher).pipe(output);
		});
	})();
}


async function decryptFile(inputPath, outputPath, password) {

	try {

		// Peek the header: a new authenticated archive starts with BACKUP_MAGIC; a legacy one begins with a
		// 16-byte CBC IV. Read the marker, then dispatch.
		const marker = Buffer.alloc(BACKUP_MAGIC.length);
		const fh = await fs.promises.open(inputPath, 'r');
		let isNew = false, salt = null, iv = null, tag = null, fileSize = 0;

		try {

			const r = await fh.read(marker, 0, BACKUP_MAGIC.length, 0);
			isNew = r.bytesRead === BACKUP_MAGIC.length && marker.equals(BACKUP_MAGIC);

			if (isNew) {

				const stat = await fh.stat();
				fileSize = stat.size;

				const meta = Buffer.alloc(28);                 // salt(16) + iv(12)
				await fh.read(meta, 0, 28, BACKUP_MAGIC.length);
				salt = meta.subarray(0, 16);
				iv   = meta.subarray(16, 28);

				tag = Buffer.alloc(16);
				await fh.read(tag, 0, 16, fileSize - 16);       // auth tag is the last 16 bytes
			}
		}
		finally { await fh.close(); }

		if (!isNew) { return await decryptFileLegacyCbc(inputPath, outputPath, password); }

		const key = crypto.scryptSync(password, salt, 32);
		const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
		decipher.setAuthTag(tag);                            // final() throws if the archive was tampered with

		const dataStart = BACKUP_MAGIC.length + 28;          // 8 + 28 = 36
		const input = fs.createReadStream(inputPath, { start: dataStart, end: fileSize - 16 - 1 });   // exclude tag
		const output = fs.createWriteStream(outputPath);

		return await new Promise((resolve, reject) => {

			input.on('error',    (error) => reject({ success: false, error: 'Read stream error: ' + error.message }));
			decipher.on('error', (error) => reject({ success: false, error: 'Decryption failed: ' + error.message }));
			output.on('error',   (error) => reject({ success: false, error: 'Write stream error: ' + error.message }));
			output.on('finish', () => resolve({ success: true }));

			input.pipe(decipher).pipe(output);
		});
	}
	catch (error) {

		return { success: false, error: 'Unexpected error: ' + ((error && (error.error || error.message)) || String(error)) };
	}
}


function removeDirectorySync(directoryPath) {

    function deleteRecursiveSync(dir) {

        if (fs.existsSync(dir)) {

            const files = fs.readdirSync(dir);

            for (const file of files) {

				const filePath = path.join(dir, file);

				if (fs.statSync(filePath).isDirectory()) {

					deleteRecursiveSync(filePath);
                }
				else {

					fs.unlinkSync(filePath);
                }
            }

            fs.rmdirSync(dir);
        }
    }

    try {

		deleteRecursiveSync(directoryPath);
    }
	catch (error) {
 
		//console.error(`Error removing ${directoryPath}:`, error);
    }
}


async function appStarting(req, res) {

	if (shareData.appData.starting_dca) {

		const msg = 'DCA bots start in progress. Please wait until it finishes.';

		shareData.Common.logger(msg);

		try {

			res.status(500).send(msg);
		}
		catch(e) {

		}

		return true;
	}

	return false;
}


async function pause(bool, msg) {

	if (msg == undefined || msg == null || msg == '') {

		msg = 'Paused';
	}

	if (bool) {

		shareData.appData.system_pause = msg;
	}
	else {

		delete shareData.appData.system_pause;
	}
}


async function createRollbackSnapshot(version) {

	let success = false;
	let snapshotNameResult = null;
	let error = null;

	const dateParts = shareData.Common.getDateParts(new Date());
	const dateStr = dateParts.date.replace(/[^a-zA-Z0-9]/g, '') + '_' + dateParts.time.replace(/[^a-zA-Z0-9]/g, '');
	const snapshotName = `${version}_${dateStr}`;
	const snapshotDir = rollbackDir + '/' + snapshotName;

	if (!fs.existsSync(rollbackDir)) fs.mkdirSync(rollbackDir, { recursive: true });

	// 'data' holds runtime state (e.g. the Hub's SQLite database data/hub/hub.db) and 'uploads'
	// holds user files — neither is code, so a code snapshot must never capture them, or a later
	// rollback would clobber the live Hub database and lose users/keys/audit created since.
	const exclude = UPGRADE_PRESERVE_DIRS;

	try {

		const items = fs.readdirSync(pathRoot);

		for (const item of items) {

			if (exclude.has(item)) continue;

			const src = path.join(pathRoot, item);
			const dest = path.join(snapshotDir, item);
			const stats = fs.statSync(src);

			if (stats.isDirectory()) {

				await fsp.cp(src, dest, { recursive: true });
			}
			else {

				await fsp.mkdir(path.dirname(dest), { recursive: true });
				await fsp.copyFile(src, dest);
			}
		}

		// Write manifest
		const manifest = { version, date: new Date().toISOString(), snapshotName };
		await fsp.writeFile(snapshotDir + '/.rollback-manifest.json', JSON.stringify(manifest, null, 2));

		shareData.Common.logger(`Rollback snapshot created: ${snapshotName}`);

		// Trim old rollbacks — keep only MAX_ROLLBACKS
		const snapshots = fs.readdirSync(rollbackDir)
			.filter(f => fs.statSync(path.join(rollbackDir, f)).isDirectory())
			.map(f => ({ name: f, mtime: fs.statSync(path.join(rollbackDir, f)).mtime }))
			.sort((a, b) => a.mtime - b.mtime);

		while (snapshots.length > MAX_ROLLBACKS) {

			const oldest = snapshots.shift();
			removeDirectorySync(path.join(rollbackDir, oldest.name));
			shareData.Common.logger(`Removed old rollback snapshot: ${oldest.name}`);
		}

		success = true;
		snapshotNameResult = snapshotName;
	}
	catch (err) {

		shareData.Common.logger('Failed to create rollback snapshot: ' + err.message);
		error = err.message;
	}

	return { success, snapshotName: snapshotNameResult, error };
}


async function listRollbacks() {

	if (!fs.existsSync(rollbackDir)) return [];

	const snapshots = fs.readdirSync(rollbackDir)
		.filter(f => fs.statSync(path.join(rollbackDir, f)).isDirectory())
		.map(f => {

			let manifest = { version: 'unknown', date: null, snapshotName: f };

			try {

				const raw = fs.readFileSync(path.join(rollbackDir, f, '.rollback-manifest.json'), 'utf8');
				manifest = { ...manifest, ...JSON.parse(raw) };
			}
			catch(e) {}

			return manifest;
		})
		.sort((a, b) => new Date(b.date) - new Date(a.date));

	return snapshots;
}


async function routeListRollbacks(req, res) {

	const rollbacks = await listRollbacks();

	res.json({ success: true, data: rollbacks });
}


async function routeRollbackSystem(req, res) {

	const { snapshotName } = req.body;

	if (!snapshotName) {

		return res.status(400).json({ success: false, error: 'No snapshot name provided.' });
	}

	// Path-traversal guard: the snapshot name must be a plain basename (no "..", no slashes), so a
	// crafted name can never point copyFiles() outside the rollbacks directory and overwrite app code.
	// Mirrors the console rollback path and the Hub restore's strict name check.
	if (snapshotName !== path.basename(snapshotName)) {

		return res.status(400).json({ success: false, error: 'Invalid snapshot name.' });
	}

	shareData.Common.auditEvent(req, 'system.rollback', String(snapshotName), 'system code rollback');

	const snapshotDir = path.join(rollbackDir, snapshotName);

	if (!fs.existsSync(snapshotDir)) {

		return res.status(404).json({ success: false, error: 'Snapshot not found.' });
	}

	let success = false;
	let error;

	try {

		shareData.Common.logger(`Rolling back to snapshot: ${snapshotName}`);

		await copyFiles(snapshotDir, pathRoot);

		// If rolling back to a pre-encryption version, hand its config secrets back as plaintext so
		// the restored older code can read them (done by the current, encryption-aware process).
		await maybeDecryptSecretsForRollback(snapshotDir);

		// Run npm install to restore node_modules to the rolled-back state
		await new Promise((resolve, reject) => {

			exec('npm install', { cwd: pathRoot }, (err, stdout, stderr) => {

				if (err) return reject(err);
				resolve();
			});
		});

		success = true;

		shareData.Common.logger(`Rollback to ${snapshotName} complete. Shutting down.`);
	}
	catch (err) {

		error = err.message;
		shareData.Common.logger('Rollback failed: ' + error);
	}

	res.json({ success, error });

	if (success) {

		// Shutdown so process manager restarts with rolled-back code
		const resParent = await shareData.Common.sendParentMsg({
			'type': WORKER_TO_HUB.SHUTDOWN_HUB,
			'data': ''
		});

		if (!resParent.success) {

			shutDownFunction();
		}
	}
}


async function rollbackConsole(snapshotName) {

	let selected = null;
	let exitCode = 0;
	let message = '';

	if (!fs.existsSync(rollbackDir)) {

		message = '\nNo rollback snapshots found in: ' + rollbackDir + '\nSnapshots are created automatically before each update.';
		exitCode = 1;
	}
	else {

		// Reuse the single snapshot-listing implementation (read manifests, newest first) rather than
		// re-deriving it here, so the console and the API can never drift.
		const snapshots = await listRollbacks();

		if (snapshots.length === 0) {

			message = '\nNo rollback snapshots available.';
			exitCode = 1;
		}
		else if (snapshotName) {

			selected = snapshots.find(s => s.snapshotName === snapshotName);

			if (!selected) {

				message = '\nSnapshot not found: ' + snapshotName + '\n\nAvailable snapshots:\n' +
					snapshots.map(s => '  ' + s.snapshotName).join('\n');
				exitCode = 1;
			}
		}
		else if (snapshots.length === 1) {

			selected = snapshots[0];
		}
		else {

			console.log('\nAvailable rollback snapshots:\n');

			snapshots.forEach((s, i) => {

				const date = s.date ? new Date(s.date).toLocaleString() : 'Unknown date';
				console.log('  [' + (i + 1) + '] v' + s.version + ' — ' + date + ' (' + s.snapshotName + ')');
			});

			console.log('');

			const input = prompt('Select snapshot [1-' + snapshots.length + ']: ');
			const idx   = parseInt(input, 10) - 1;

			if (isNaN(idx) || idx < 0 || idx >= snapshots.length) {

				message = 'Invalid selection. Exiting.';
				exitCode = 1;
			}
			else {

				selected = snapshots[idx];
			}
		}

		if (selected && exitCode === 0) {

			const date = selected.date ? new Date(selected.date).toLocaleString() : 'Unknown date';

			console.log('\nSelected: v' + selected.version + ' — ' + date);
			console.log('\n*** CAUTION *** This will restore code files from the snapshot.');
			console.log('The database will NOT be affected.\n');

			const confirm = prompt('Do you want to continue? (Y/n): ');

			if (confirm !== 'Y') {

				message = 'Rollback canceled.';
			}
			else {

				const snapshotDir = path.join(rollbackDir, selected.snapshotName);

				try {

					console.log('\nRestoring files from: ' + selected.snapshotName);

					await copyFiles(snapshotDir, pathRoot);

					// If rolling back to a pre-encryption version, hand its config secrets back as
					// plaintext so the restored older code can read them.
					await maybeDecryptSecretsForRollback(snapshotDir);

					console.log('Files restored.');
					console.log('\nRunning npm install...');

					await new Promise((resolve, reject) => {

						exec('npm install', { cwd: pathRoot }, (err) => {

							if (err) return reject(err);
							resolve();
						});
					});

					message = 'npm install complete.\n\nRollback complete. Start SymBot normally with: npm start';
				}
				catch (err) {

					message = '\nRollback failed: ' + err.message;
					exitCode = 1;
				}
			}
		}
	}

	if (message) console.log(message);

	if (exitCode !== 0) process.exit(exitCode);
}


async function routeUpdateSystem(req, res) {

	shareData.Common.auditEvent(req, 'system.update', '', 'system update initiated');

	const dataUpdate = await updateSystem();

	if (dataUpdate.success) {

		res.status(200).send('System update complete.');
	}
	else {

		res.status(500).send('An error occurred during update: ' + dataUpdate.error);
	}
}


async function updateSystem() {

	let success = false;
	let systemMsg = 'System Updating';

	const outputDir = pathRoot + '/downloads';
	// One uuid per update run, shared by the downloaded zip AND its extract dir, so two instances upgrading
	// at the same moment can never collide in this shared staging dir (mirrors the backup's uniqueTempPath).
	const runId = shareData.Common.uuidv4();
	const extractDir = outputDir + '/' + runId;

	const appVersion = shareData.appData.version;
	const appConfigFile = shareData.appData.app_config;
	const botConfigFile = shareData.appData.bot_config;

	let isErr;
	let cmdError = '';
	let cmdStdError = '';
	let cmdStdOut = '';
	let extractDirName = '';

	const getFirstDir = rootPath => fs.readdirSync(rootPath).find(f => fs.statSync(path.join(rootPath, f)).isDirectory()) || null;

	const mergeConfigs = (param, data, configs) => {

		const instanceConfigs = new Set(data.instances.map(instance => instance[param]));

		configs.forEach(config => instanceConfigs.add(config));

		return Array.from(instanceConfigs);
	};

	// If Hub is running, send system pause to all instances
	const resParent = await shareData.Common.sendParentMsg({

		'type': WORKER_TO_HUB.SYSTEM_PAUSE_ALL,
		'data': { 'pause': true, 'message': systemMsg }
	});

	if (!resParent.success) {

		await pause(true, systemMsg);
	}

	shareData.Common.logger(systemMsg);

	try {

		let appConfigs = [];
		let botConfigs = [];

		appConfigs.push(appConfigFile);
		botConfigs.push(botConfigFile);

		const appInfo = await shareData.Common.validateAppVersion();

		const owner = appInfo.owner;
		const repo = appInfo.repo;
		const latestTag = appInfo.remote;

		if (!appInfo.success || !appInfo.update_available) {

			throw new Error('You already have the latest version');
		}

		// Wait short delay for data to stop processing
		await shareData.Common.delay(5000);

		// Download latest tag zip file
		const downloadUrl = `https://github.com/${owner}/${repo}/archive/refs/tags/${latestTag}.zip`;
		const zipResponse = await fetch(downloadUrl);

		if (!zipResponse.ok) throw new Error(`Failed to download zip: ${zipResponse.statusText}`);

		// Create output directory if it doesn't exist
		if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

		const filename = `${repo}-${latestTag}.zip`;
		const outFile = outputDir + '/' + runId + '-' + filename;   // uuid-unique (see runId above)

		// Write the zip file to disk
		const fileStream = fs.createWriteStream(outFile);

		await new Promise((resolve, reject) => {
			zipResponse.body.pipe(fileStream);
			zipResponse.body.on('error', reject);
			// Also handle a write-side failure (disk full / permission); otherwise it emits on a
			// listener-less stream and this Promise never settles, hanging the update download.
			fileStream.on('error', reject);
			fileStream.on('finish', resolve);
		});

		await decompress(outFile, extractDir);

		try {

			extractDirName = getFirstDir(extractDir);
		}
		catch(e) {

			throw new Error(e.message);
		}

		let appConfigNew = await shareData.Common.getData(extractDir + '/' + extractDirName + '/config/app.json');
		let botConfigNew = await shareData.Common.getData(extractDir + '/' + extractDirName + '/config/bot.json');
		let hubConfigNew = await shareData.Common.getData(extractDir + '/' + extractDirName + '/config/hub.json');

		let hubConfigOld = await shareData.Common.getData(pathRoot + '/config/hub.json');

		// Check for new hub.json params
		if (hubConfigOld.success && hubConfigNew.success) {

			let diffs = await findMissingParameters(JSON.parse(hubConfigOld.data), JSON.parse(hubConfigNew.data));
			let configCombined = diffs.combined;

			// Save new hub config
			await shareData.Common.saveConfig('hub.json', configCombined, true);
		}

		// Reload hub config
		let hubConfig = await shareData.Common.getData(pathRoot + '/config/hub.json');

		if (hubConfig.success) {

			appConfigs = mergeConfigs('app_config', JSON.parse(hubConfig.data), appConfigs);
			botConfigs = mergeConfigs('bot_config', JSON.parse(hubConfig.data), botConfigs);
		}

		// Combine configs
		const allConfigs = [
			...appConfigs.map(file => ({ file, updated: true, newData: appConfigNew.data })),
			...botConfigs.map(file => ({ file, updated: false, newData: botConfigNew.data }))
		];

		// Update all config files
		for (let { file, updated, newData } of allConfigs) {

			let configOld = await shareData.Common.getData(pathRoot + '/config/' + file);

			let diffs = await findMissingParameters(JSON.parse(configOld.data), JSON.parse(newData));
			let configCombined = diffs.combined;

			// Save new config
			await shareData.Common.saveConfig(file, configCombined, updated);
		}

		// Create rollback snapshot before overwriting files
		const snapshotResult = await createRollbackSnapshot(appVersion);

		if (!snapshotResult.success) {

			shareData.Common.logger('Warning: Could not create rollback snapshot: ' + snapshotResult.error);
		}

		// Remove existing files except backups and config folders and replace with new 
		await moveFiles(pathRoot, extractDir + '/' + extractDirName);

		// Cleanup files
		fs.unlinkSync(outFile);
		removeDirectorySync(extractDir);

		// Execute "npm install" in the original directory
		await new Promise((resolve, reject) => {

			exec('npm install', {
				'cwd': pathRoot
			}, (error, stdout, stderr) => {

				if (error) {

					cmdError = error.message;
					reject(error);

					return;
				}

				if (stderr && !stderr.includes('warning')) {

					cmdStdError = stderr;
					reject(new Error(stderr));

					return;
				}
		
				cmdStdOut += stdout;

				resolve();
			});
		});

		if (!cmdError && !cmdStdError) {

			success = true;
		}
	}
	catch (error) {

		isErr = error.message;
	}

	const resObj = {
		'success': success,
		'error': isErr,
		'cmd': {
			'stdout': cmdStdOut,
			'stderr': cmdStdError,
			'error': cmdError
		}
	};

	shareData.Common.logger('System Update Complete: ' + JSON.stringify(resObj));

	if (success) {

		// If Hub is running, shutdown all instances
		const resParent = await shareData.Common.sendParentMsg({

			'type': WORKER_TO_HUB.SHUTDOWN_HUB,
			'data': ''
		});

		if (!resParent.success) {

			shutDownFunction();
		}
	}
	else {

		// If Hub is running, send system unpause to all instances
		const resParent = await shareData.Common.sendParentMsg({

			'type': WORKER_TO_HUB.SYSTEM_PAUSE_ALL,
			'data': { 'pause': false, 'message': '' }
		});

		if (!resParent.success) {

			await pause(false, '');
		}
	}

	return resObj;
}


async function copyFiles(sourceDir, destDir) {

	try {

		const items = await fsp.readdir(sourceDir);

		for (const item of items) {

			// Preserve live data and runtime dirs — never overwrite the user's data (including the
			// Hub database under data/), config, logs, sessions, or backups on an upgrade.
			if (UPGRADE_PRESERVE_DIRS.has(item)) {

				continue;
			}

			// Skip the manifest file
			if (item === '.rollback-manifest.json') {

				continue;
			}

			const src   = path.join(sourceDir, item);
			const dest  = path.join(destDir, item);
			const stats = await fsp.stat(src);

			if (stats.isDirectory()) {

				// Copy directory atomically via temp path
				const tmp = dest + '.new';

				if (fs.existsSync(tmp)) {

					removeDirectorySync(tmp);
				}

				await fsp.cp(src, tmp, { recursive: true });
				removeDirectorySync(dest);
				await fsp.rename(tmp, dest);
			}
			else {

				// Copy file safely
				const tmp = dest + '.new';

				await fsp.copyFile(src, tmp);
				await fsp.rename(tmp, dest);
			}
		}
	}
	catch (e) {

		throw new Error(`copyFiles failed: ${e.message}`);
	}
}


async function moveFiles(originalDir, newDir) {

	try {

		const items = await fsp.readdir(newDir);

		for (const item of items) {

			// Preserve live data and runtime dirs — never overwrite the user's data (including the
			// Hub database under data/), config, logs, sessions, or backups on an upgrade.
			if (UPGRADE_PRESERVE_DIRS.has(item)) {

				continue;
			}

			const src = path.join(newDir, item);
			const dest = path.join(originalDir, item);
			const stats = await fsp.stat(src);

			if (stats.isDirectory()) {

				// Replace whole directory atomically
				const tmp = dest + '.new';

				if (fs.existsSync(tmp)) {

					removeDirectorySync(tmp);
				}

				await fsp.rename(src, tmp);
				removeDirectorySync(dest);
				await fsp.rename(tmp, dest);
			}
			else {

				// Replace file safely even if running
				const tmp = dest + '.new';

				await fsp.copyFile(src, tmp);
				await fsp.rename(tmp, dest);
			}
		}
	}
	catch (e) {

		throw new Error(`moveFiles failed: ${e.message}`);
	}
}


// ── Backup artifact index ────────────────────────────────────────────────────
// The instance's backups directory (data/instances/<server_id>/backups) is tracked by a per-directory
// manifest (ArtifactIndex) so listing, retention and (later) off-site rotation key on stable records with a
// real creation time and display name, not on parsing the instance name out of the filename. The directory
// stays the source of truth: reconcile() rebuilds the manifest from it, so an existing install's backups,
// a hand-copied file, or a restore are all picked up automatically. Everything here is best-effort and
// wrapped — a backup or its retention must never throw into the caller, and a failed index write just gets
// rebuilt on the next reconcile.

const BACKUPS_KIND = 'backups';

// A backup archive, identified by its extension only — no instance-name or product-token coupling, so it
// keeps matching whatever the filename prefix is. Delegates to Common's single definition of the shape so
// the writer, retention and off-site rotation can never disagree; falls back to the local pattern when
// Common isn't wired yet (early boot / unit tests), mirroring how logDir/logFileName are resolved here.
function isBackupArtifact(name) {
	if (shareData && shareData.Common && typeof shareData.Common.isBackupArtifact === 'function') {
		return shareData.Common.isBackupArtifact(name);
	}
	return /\.zip\.enc$/i.test(String(name));
}

// Display/identity context stored in the manifest — the SAME identity (server_id + display name) that logs
// record, so it is defined once in Common. Delegates there, falling back to a local read when Common isn't
// wired yet (early boot / unit tests), mirroring how logDir/logFileName are resolved in this module.
function backupsIndexMeta() {
	if (shareData && shareData.Common && typeof shareData.Common.instanceIndexMeta === 'function') {
		return shareData.Common.instanceIndexMeta();
	}
	const ad = (shareData && shareData.appData) ? shareData.appData : {};
	const wd = ad.worker_data || {};
	const name = (wd.name_display && String(wd.name_display).trim()) || wd.name || ad.name || '';
	return { server_id: ad.server_id != null ? String(ad.server_id) : '', instance_name: String(name) };
}

// Record a just-stored backup file in its directory's manifest (best-effort).
function recordBackupArtifact(fullPath) {
	try {
		const dir = path.dirname(fullPath);
		let size = 0;
		try { size = fs.statSync(fullPath).size; } catch (e) {}
		ArtifactIndex.record(dir, BACKUPS_KIND, backupsIndexMeta(), { file: path.basename(fullPath), size: size, created_utc: new Date().toISOString() });
	}
	catch (e) {}
}

// Reconcile the instance's backups manifest against the directory (boot / before retention / before a listing).
function reconcileBackupsIndex() {
	try { return ArtifactIndex.reconcile(shareData.Common.instanceDataDir('backups'), { kind: BACKUPS_KIND, meta: backupsIndexMeta(), isArtifact: isBackupArtifact }); }
	catch (e) { return null; }
}

// Index-based LOCAL retention: keep the newest `max` backups by RECORDED creation time (the old trim sorted
// by filesystem mtime, which a restore/move can scramble), deleting the file and its record together.
// Reconciles first so pre-index or hand-added backups are included. Best-effort; never throws.
async function retainBackups(max) {
	try {
		const dir = shareData.Common.instanceDataDir('backups');
		const r = ArtifactIndex.reconcile(dir, { kind: BACKUPS_KIND, meta: backupsIndexMeta(), isArtifact: isBackupArtifact });
		const victims = ArtifactIndex.selectExcess(r.manifest, { keep: Number(max) });
		for (const v of victims) {
			try { await fsp.unlink(path.join(dir, v.file)); } catch (e) {}
			ArtifactIndex.dropByFile(r.manifest, v.file);
		}
		if (victims.length) { ArtifactIndex.save(dir, r.manifest); }
	}
	catch (e) {}
}


// The database backup is a first-class scheduled job (type 'backup') stored in the
// `schedules` collection, exactly like any other schedule. The central Scheduler arms
// it and, when it fires, runs the 'backup' handler below. The backup's configuration
// (schedule, retention, encryption password, SFTP, include flags) lives on the schedule
// row's `settings`; at runtime it is mirrored into shareData.appData.cron_backup so the
// existing backup code (cronBackup, manual backups, the config UI) keeps its shape.

// Mirror a backup schedule row into the runtime cron_backup shape.
function hydrateCronBackup(sched) {

	const s = (sched && sched.settings) || {};

	shareData.appData.cron_backup = {
		'schedule':          sched ? sched.cron : '',
		'timezone':          sched ? (sched.timezone || '') : '',
		'enabled':           sched ? !!sched.enabled : false,
		'max':               s.max,
		'password':          s.password || '',
		'include_chats':     s.include_chats !== false,
		'include_schedules': s.include_schedules !== false,
		'include_config':    s.include_config === true,
		'sftp':              s.sftp || {}
	};
}


// Register the 'backup' job handler with the Scheduler. When a backup schedule fires,
// hydrate the runtime config from the row and run the existing backup routine.
function registerBackupHandler(scheduler) {

	scheduler.registerHandler('backup', async (job) => {

		hydrateCronBackup(job);

		try {
			// Surface a human-readable summary as the run OUTPUT so the schedule's run history is informative
			// (a bare "ok" with no output reads like a failure), and reflect a real internal failure — a missing
			// password or a file error that never threw — as 'error' so the history and the backup Watchdog agree.
			const res = await cronBackup();
			return { 'status': (res && res.success) ? 'ok' : 'error', 'output': (res && res.summary) || '' };
		}
		catch (e) { shareData.Common.logger('Scheduled backup handler failed: ' + e.message); return { 'status': 'error', 'output': 'Backup failed: ' + ((e && e.message) ? e.message : e) }; }
	});
}


// Create or update this instance's single backup schedule row, then mirror it into the
// runtime cron_backup config. Called from the config-save path.
async function saveBackupSchedule(settings, schedule, enabled, timezone) {

	const res = await shareData.Scheduler.upsertSingleton('backup', {
		'kind': 'cron',
		'cron': schedule || '',
		'enabled': !!enabled,
		'label': 'System backup',
		'timezone': timezone || '',
		// The database backup is the platform's safety net, so if the process was down when a
		// backup was due, make up exactly ONE run on restart ('once') rather than skipping it
		// entirely (the default) or replaying every miss.
		'catchup': 'once',
		'settings': settings || {}
	});

	if (res.success) { hydrateCronBackup(res.schedule); }

	shareData.Common.logger('Backup schedule saved: ' + JSON.stringify({ 'enabled': !!enabled, 'schedule': schedule || '', 'ok': res.success }));

	return res;
}


// Re-encrypt the backup schedule's stored secrets under a new app password. Called from
// the config-save path when the password changes, alongside the app.json re-encryption.
async function reEncryptBackupSecrets(oldKey, newKey) {

	const row = await shareData.Scheduler.getSingleton('backup');
	if (!row) { return; }

	const s = row.settings || {};
	if (!s.sftp) { s.sftp = {}; }

	const fields = [ [ s, 'password' ], [ s.sftp, 'password' ], [ s.sftp, 'passphrase' ], [ s.sftp, 'private_key' ] ];

	let changed = false;

	for (const [ obj, key ] of fields) {

		const val = obj[key];
		if (!val) { continue; }

		const dec = await decrypt(val, oldKey);
		if (!dec.success) { continue; }

		const enc = await encrypt(dec.data, newKey);
		if (!enc.success) { continue; }

		// Verify the re-encrypted value decrypts back under the NEW key before committing it — the same
		// round-trip guard the app.json / bot-config / console re-key paths use, so this last re-key site
		// can never write a secret it cannot recover. On a verify miss the old ciphertext is left in place
		// and the decryptability watchdog surfaces it on the next boot.
		const check = await decrypt(enc.data, newKey);
		if (check.success && check.data === dec.data) { obj[key] = enc.data; changed = true; }
	}

	if (changed) {

		row.settings = s;
		if (typeof row.markModified === 'function') { row.markModified('settings'); }
		await row.save();
		hydrateCronBackup(shareData.Scheduler.publicRow(row));
	}
}


// One-time migration: if the backup lives in app.json (pre-scheduler installs), move it
// into the `schedules` collection so it works like every other schedule and no longer
// depends on the shared app.json (which decouples Hub instances). Idempotent.
async function migrateBackupToScheduler() {

	const scheduler = shareData.Scheduler;

	// Already a scheduler-managed backup → just mirror it into the runtime config.
	let row = await scheduler.getSingleton('backup');
	if (row) { hydrateCronBackup(scheduler.publicRow(row)); return { 'migrated': false, 'hydrated': true }; }

	// This instance has no backup row yet. Seed one from the legacy app.json config if
	// present. IMPORTANT: app.json is treated as read-only here and is never modified —
	// under the Hub several instances may share one app.json but keep separate databases,
	// so each instance must be able to read the same seed and create its own backup row.
	// Re-migration is prevented simply by the presence of this instance's own row (the
	// backup row is never user-deletable through the UI), so no on-disk marker is needed.
	const appCfg = shareData.appData.cron_backup || {};

	const hasConfig = appCfg.schedule || appCfg.password || (appCfg.sftp && appCfg.sftp.host) || appCfg.max != null || appCfg.enabled != null;
	if (!hasConfig) { return { 'migrated': false }; }

	const settings = {
		'max':               appCfg.max,
		'password':          appCfg.password || '',
		'include_chats':     appCfg.include_chats !== false,
		'include_schedules': appCfg.include_schedules !== false,
		'sftp':              appCfg.sftp || {}
	};

	const res = await scheduler.upsertSingleton('backup', {
		'kind': 'cron',
		'cron': appCfg.schedule || '',
		'enabled': !!appCfg.enabled,
		'label': 'System backup',
		'catchup': 'once',   // make up one missed backup on restart (the safety net must not be skipped)
		'settings': settings
	});

	if (!res.success) { return { 'migrated': false, 'error': res.error }; }

	hydrateCronBackup(res.schedule);

	shareData.Common.logger('Migrated database backup from app.json into the scheduler (schedules collection).');

	return { 'migrated': true };
}


async function cronBackup() {

	let error;
	let backupFile;
	let attempts = 0;
	let success = false;
	let appStillStarting = true;

	// Verify if app is starting before allowing backup
	while (attempts < 30) {

		if (await appStarting(null, null)) {

			await shareData.Common.delay(5000);

			attempts++;
		}
		else {
		
			appStillStarting = false;
		
			break;
		}
	}

	if (appStillStarting) {

		shareData.Common.logger('Unable to perform scheduled database backup. App is still starting.');

		return { 'success': success };
	}

	const cronBackupPasswordEnc = shareData['appData']['cron_backup']['password'];

	if (cronBackupPasswordEnc) {

		const cronBackupPasswordDecObj = await decrypt(cronBackupPasswordEnc, shareData.appData.password);

		if (cronBackupPasswordDecObj.success) {

			const password = cronBackupPasswordDecObj.data;

			if (password) {

				shareData.Common.logger('Performing scheduled database backup');

				const includeChats = !(shareData.appData.cron_backup && shareData.appData.cron_backup.include_chats === false);
				const includeSchedules = !(shareData.appData.cron_backup && shareData.appData.cron_backup.include_schedules === false);
				// Scheduled/off-site backups NEVER bundle configuration unless it was explicitly opted in —
				// otherwise a routine SFTP upload would ship exchange credentials off the box by default.
				const includeConfig = !!(shareData.appData.cron_backup && shareData.appData.cron_backup.include_config === true);

				const resBackup = await processBackupDb(password, includeChats, includeSchedules, includeConfig);

				if (resBackup.success) {

					try {

						backupFile = shareData.Common.ensureDataDir('backups') + '/' + resBackup.file_name;

						await fsp.rename(resBackup.full_path, backupFile);
						recordBackupArtifact(backupFile);   // track the stored backup in its directory manifest

						success = true;
					}
					catch (err) {

						error  = 'Failed to move file: ' + err;
					}
				}

				const logData = { 'backup_result': resBackup, 'error': error };

				shareData.Common.logger('Completed scheduled database backup: ' + JSON.stringify(logData));
			}
		}
	}

	let maxFiles = Number(shareData['appData']['cron_backup']['max']);

	// Clamp to at least 1. Written as "not >= 1" (rather than "< 1") so a non-numeric config value — Number()
	// yields NaN, and NaN < 1 is false — is also caught and normalised, instead of flowing through as NaN.
	if (!(maxFiles >= 1)) {

		maxFiles = 1;
	}

	// Keep only the newest `maxFiles` backups. Retention now keys on the directory manifest (recorded
	// creation time), so it no longer depends on the filename prefix or on filesystem mtime ordering.
	await retainBackups(maxFiles);

	// Only upload when a backup was actually produced and stored — otherwise backupFile is undefined and the
	// upload would connect pointlessly and log a misleading "SFTP upload failed" every scheduled run.
	if (success && backupFile && shareData.appData['cron_backup']['sftp']['enabled'] && shareData.appData['cron_backup']['sftp']['host']) {

		// Upload backup file in the background. The outcome is recorded onto the backup schedule (best-effort) so
		// the offsite_backup_last_upload_failed Watchdog can surface a persistently failing off-site copy — this
		// upload never fails the local backup, so without that it would have no standing surface.
		sftpUploadFile(backupFile, false)
			.then(() => {

				shareData.Common.logger('SFTP upload success: ' + backupFile);
				if (shareData.Scheduler && typeof shareData.Scheduler.recordBackupSftpResult === 'function') { shareData.Scheduler.recordBackupSftpResult(true); }
			})
			.catch(err => {

				// Report the actual reason: JSON.stringify(err) renders an Error as "{}" (its message is
				// non-enumerable), so a failed off-site upload would otherwise log a meaningless empty object.
				const reason = (err && err.message) ? err.message : err;
				shareData.Common.logger('SFTP upload failed for ' + backupFile + ': ' + reason + ((err && err.code) ? ' (' + err.code + ')' : ''));
				if (shareData.Scheduler && typeof shareData.Scheduler.recordBackupSftpResult === 'function') { shareData.Scheduler.recordBackupSftpResult(false); }
			});
	}

	// A concise, human-readable summary for the schedule run history (so a successful run shows what it did
	// rather than an empty "(no output)"). The off-site upload is fire-and-forget, so its final result is not
	// known here — the summary reports whether it was STARTED; a persistent off-site failure is surfaced by its
	// own Watchdog. On failure the summary carries the reason.
	let summary = '';
	if (success) {
		let sizeStr = '';
		try { sizeStr = ' (' + (fs.statSync(backupFile).size / (1024 * 1024)).toFixed(2) + ' MB)'; } catch (e) {}
		const sftpCfg = (shareData.appData['cron_backup'] && shareData.appData['cron_backup']['sftp']) || {};
		const offsite = (sftpCfg.enabled && sftpCfg.host) ? 'off-site upload started' : 'no off-site destination configured';
		summary = 'Backup created: ' + (backupFile ? path.basename(backupFile) : '(file)') + sizeStr + '. ' + offsite + '. Keeping the newest ' + maxFiles + '.';
	}
	else {
		summary = error ? ('Backup did not complete: ' + error) : 'Backup did not complete — check that a backup password is set in Configuration → System Backups.';
	}

	return { 'success': success, 'error': error, 'summary': summary };
}


// (Removed) cronJobToggle / activeCrons: cron scheduling now lives entirely in the
// central Scheduler (libs/app/Scheduler.js). The database backup, previously the only
// consumer of this helper, is a scheduler-managed 'backup' job.


async function sftpUploadBackup(configObj, localFile, remoteDir, maxBackups, isTest) {

	let success = false;
	let error = null;

	const sftp = new sftpClient();

	try {

		let config = JSON.parse(JSON.stringify(configObj));

		// privateKey is already decrypted content passed in via config.privateKey.
		// Remove it from the config object if empty so ssh2-sftp-client
		// falls back to password auth cleanly.
		if (!config.privateKey) {

			delete config.privateKey;
		}

		await sftp.connect(config);

		await sftpPutAndRotate(sftp, localFile, remoteDir, {
			serverId: shareData.Common.getServerId(),
			namePrefix: shareData.appData.name + '-backup-',
			// Prefix the off-site file with THIS instance's name — e.g. "Coinbase-Real-backup-<date>_<time>.zip.enc"
			// — so a remote listing is legible (the subfolder is the internal server_id, which is not human-
			// readable). The name is instanceNameSync(), the instance's stable identifier, present with or without
			// a Hub display name; if that is ever unavailable, the server_id data-folder marker (.instance.json,
			// tied to the data being backed up) supplies it. A standalone with no instance name uploads the bare
			// filename. Rotation is folder-scoped, so the filename never affects retention.
			remoteName: shareData.Common.instanceBackupFileName(localFile),
			maxBackups: Number(maxBackups),
			isTest: isTest
		});

		success = true;
	}
	catch (err) {

		success = false;
		error = err.message;

		//console.error("SFTP Error:", error);
	}
	finally {

		await sftp.end();
	}

	const resObj = { success, error };

	shareData.Common.logger('SFTP Backup: ' + JSON.stringify(resObj));

	return resObj;
}


// Upload a backup into this instance's OWN per-server_id subfolder of the (shared) remote directory, then
// rotate that subfolder. Isolating each instance's off-site backups in <remoteDir>/<server_id>/ makes
// rotation a plain directory listing — it no longer matches a shared filename prefix on a flat folder that
// every instance uploads into, so it can NEVER delete a sibling instance's off-site backups (the single
// most dangerous coupling in the old design). Instances that legitimately share a server_id share the
// subfolder, which is correct — they back up the same data. A one-time best-effort migration moves any of
// THIS instance's pre-existing flat-folder backups (the last remaining use of the name prefix) into the
// subfolder so upgrading doesn't strand them. Operates on the INJECTED sftp client, so it is unit-testable
// against a mock. Rotation runs only after a confirmed upload, so a failed upload never deletes an old one.
async function sftpPutAndRotate(sftp, localFile, remoteDir, opts) {

	opts = opts || {};
	const sid = opts.serverId ? String(opts.serverId) : '';
	const namePrefix = opts.namePrefix || '';
	const maxBackups = Number(opts.maxBackups);
	const isTest = !!opts.isTest;

	// Normalise a trailing slash so "<remoteDir>/<sid>" never becomes a "//".
	remoteDir = String(remoteDir).replace(/\/+$/, '');

	// Each instance uploads into its OWN <remoteDir>/<server_id>/ subfolder, which is what makes rotation
	// safe (a plain directory listing, never a shared-folder prefix match). If server_id is somehow absent
	// (very early boot / config mode — off-site backups normally run well after it resolves), fall back to
	// uploading into the flat directory but DO NOT rotate there: rotating a shared folder could delete a
	// sibling instance's off-site backups. So rotation is gated on having our own subfolder.
	const targetDir = sid ? (remoteDir + '/' + sid) : remoteDir;

	try { await sftp.stat(targetDir); }
	catch (e) { try { await sftp.mkdir(targetDir, true); } catch (e2) {} }   // recursive: also creates remoteDir

	if (sid && targetDir !== remoteDir && namePrefix) {
		try { await sftpMigrateFlatBackups(sftp, remoteDir, targetDir, namePrefix); } catch (e) {}
	}

	// The remote filename. The caller supplies the friendly "<instance>-<file>" name (so a raw directory
	// listing shows which instance a backup belongs to); this function stays naming-agnostic and just uses
	// it, defaulting to the bare basename. basename-guarded so a name can never carry a path separator and
	// escape the target folder. Rotation is extension-based, so the chosen name never affects it.
	const remoteName = path.basename(opts.remoteName ? String(opts.remoteName) : path.basename(localFile));
	const remotePath = targetDir + '/' + remoteName;
	await sftp.fastPut(localFile, remotePath);

	if (isTest) { try { await sftp.delete(remotePath); } catch (e) {} return; }

	// Only rotate our OWN per-server_id subfolder — never the shared flat directory (the empty-sid fallback).
	if (maxBackups > 0 && sid && targetDir !== remoteDir) { await sftpRotateDir(sftp, targetDir, maxBackups); }
}


// Keep only the newest `maxBackups` BACKUP archives in a remote directory. Filters to ".zip.enc" so a
// non-backup file the operator happens to keep in the same remote folder can never be a rotation victim,
// and every file in the per-server_id subfolder is one of this instance's own backups anyway — the
// directory scope IS the isolation. Sorts by the server's modify time. Best-effort; never throws.
async function sftpRotateDir(sftp, dir, maxBackups) {

	try {

		const list = await sftp.list(dir);
		// Guard the server-supplied name: only a plain basename (no path separators) may ever be deleted, so a
		// hostile/compromised SFTP server can't return "../<sibling>/x.zip.enc" and escape the target folder.
		const files = list.filter(f => f.type === '-' && f.name === path.posix.basename(String(f.name)) && isBackupArtifact(f.name));

		if (files.length <= Number(maxBackups)) { return; }

		files.sort((a, b) => a.modifyTime - b.modifyTime);

		const victims = files.slice(0, files.length - Number(maxBackups));
		for (const f of victims) { try { await sftp.delete(dir + '/' + f.name); } catch (e) {} }
	}
	catch (e) {}
}


// One-time: move this instance's pre-existing flat-folder backups (matched by the legacy "<name>-backup-"
// prefix — the ONLY remaining use of name matching, and only during this migration) into its per-server_id
// subfolder, so rotation covers them. Idempotent (already-moved files are simply not present) and
// best-effort per file, so a server that refuses a rename just leaves that file where it is. Never throws.
async function sftpMigrateFlatBackups(sftp, remoteDir, targetDir, namePrefix) {

	let list = [];
	try { list = await sftp.list(remoteDir); }
	catch (e) { return; }

	for (const f of list) {
		if (f.type !== '-' || f.name !== path.posix.basename(String(f.name)) || !f.name.startsWith(namePrefix)) { continue; }   // basename-only: a server-returned "../x" can't be renamed out of scope
		try { await sftp.rename(remoteDir + '/' + f.name, targetDir + '/' + f.name); } catch (e) {}
	}
}


async function findMissingParameters(obj1, obj2, path = '') {

	const missing = {};
	const combined = Array.isArray(obj1) ? [...obj1] : {
		...obj1
	};

	// Check for missing properties in obj2
	for (const key in obj2) {

		const fullPath = path ? `${path}.${key}` : key;

		if (!(key in obj1)) {

			missing[fullPath] = 'Missing in obj1'; // Key exists in obj2 but not in obj1
			combined[key] = obj2[key]; // Include the missing key from obj2 in the combined object
		}
		else if (typeof obj2[key] === 'object' && obj2[key] !== null) {

			if (Array.isArray(obj2[key])) {

				// If it's an array, we need to ensure it's merged appropriately
				if (!Array.isArray(obj1[key])) {

					combined[key] = obj2[key];
				}
				else {

					// Both are arrays: KEEP the user's array as-is — do NOT union in the shipped defaults.
					// These are user-curated lists (pair_blacklist / pair_buttons, hub.json instances). A union
					// cannot represent a deliberate DELETION of a default — it would silently re-add it every
					// upgrade (e.g. re-blacklisting a pair the user un-listed) — and for arrays of OBJECTS, Set
					// dedupes by reference, so each release's template object would accumulate as a duplicate.
					// The user's curation wins; a brand-new key absent from the user's config is still added by
					// the `!(key in obj1)` branch above.
					combined[key] = obj1[key];
				}
			}
			else {

				// Recursive check for nested objects
				const nestedResult = await findMissingParameters(obj1[key], obj2[key], fullPath);

				Object.assign(missing, nestedResult.missing); // Merge missing keys

				combined[key] = nestedResult.combined; // Combine objects
			}
		}
	}

	// Check for missing properties in obj1
	for (const key in obj1) {

		const fullPath = path ? `${path}.${key}` : key;

		if (!(key in obj2)) {

			missing[fullPath] = 'Missing in obj2'; // Key exists in obj1 but not in obj2
		}
	}

	return {
		missing,
		combined
	};
}


// Shared confirmation flow for the destructive console reset commands: a Y/n, then a one-time
// numeric reset code the operator must retype, then a final Y/n. Returns true only when all
// three pass. Exported so the Hub (SQLite) reset path reuses the exact same guardrails.
function confirmResetPrompt(warnMsg) {

	console.log(warnMsg);

	let confirm = prompt('Do you want to continue? (Y/n): ');

	if (confirm != 'Y') {

		console.log('\nReset aborted.');
		return false;
	}

	const resetCode = Math.floor(Math.random() * 1000000000);

	console.log('\nReset code: ' + resetCode);

	confirm = prompt('Enter the reset code above to confirm: ');

	if (String(confirm) != String(resetCode)) {

		console.log('\nReset code did not match. Aborted.');
		return false;
	}

	confirm = prompt('Final warning before reset. Do you want to continue? (Y/n): ');

	if (confirm != 'Y') {

		console.log('\nReset aborted.');
		return false;
	}

	return true;
}


// Console recovery for the instance auth stores (Mongo). `kind`:
//   'users'    — clear users/roles; the initial owner re-seeds from the config password on next start
//   'apikeys'  — clear all scoped API keys
//   'password' — reset the login password to the default 'admin' AND clear users so the owner re-seeds
// This is the lockout escape hatch: an operator who loses web access resets from the server console.
async function resetAuthConsole(kind, appConfigFile) {

	let success = false;
	let isErr;

	let collections = [];
	let label;

	if (kind == 'users') {

		collections = ['users'];
		label = 'ALL users and roles (the initial owner re-seeds from your config password on next start)';
	}
	else if (kind == 'apikeys') {

		collections = ['api_keys'];
		label = 'ALL API keys';
	}
	else if (kind == 'password') {

		collections = ['users'];
		label = 'the login password back to the default "admin" and clear ALL users (the owner re-seeds from the new password on next start)';
	}
	else {

		console.log('Unknown auth reset target: ' + kind);
		return { 'success': false };
	}

	const warnMsg = '\n*** CAUTION *** You are about to reset ' + label + ' for ' + shareData.appData.name + '!\n\n' +
					'Database: ' + shareData.appData['mongo_db_url'] + '\n';

	if (!confirmResetPrompt(warnMsg)) {

		return { 'success': false };
	}

	try {

		if (kind == 'password') {

			const cfgFile = appConfigFile || 'app.json';
			const cfg = await shareData.Common.getConfig(cfgFile);

			// The CURRENT password hash is the key every at-rest secret is encrypted under.
			const oldKey = cfg['data'] && cfg['data']['password'];

			const dataPass = await shareData.Common.genPasswordHash({ 'data': 'admin' });
			const newKey = dataPass['salt'] + ':' + dataPass['hash'];

			// Re-key all secrets from the old password to the new one BEFORE overwriting the password.
			// Without this, resetting the password here orphans the exchange credentials, so the bot
			// cannot connect and trading stops on the next start. Best-effort per secret.
			//
			// Crash safety: rekeyAllSecrets writes the bot-config (exchange creds) first and the app.json
			// anchor is written last, so a crash between them could leave the two disagreeing. Record a
			// re-key journal before the first write and clear it after the last, so recoverRekeyJournal()
			// finishes or safely discards an interrupted reset on the next boot (see Common.js).
			if (oldKey && oldKey !== newKey) {

				try { shareData.Common.writeRekeyJournal({ old: oldKey, new: newKey, app_config: cfgFile, bot_config: cfg['data'] && cfg['data']['bot_config'] }); } catch (e) {}

				await rekeyAllSecrets(cfg['data'], oldKey, newKey);
			}

			cfg['data']['password'] = newKey;

			await shareData.Common.saveConfig(cfgFile, JSON.parse(JSON.stringify(cfg['data'])));

			try { shareData.Common.clearRekeyJournal(); } catch (e) {}

			console.log('\nLogin password reset to default: admin');
		}

		const resetData = await resetAuthCollections(collections);

		success = resetData['success'];
		isErr = resetData['error'];

		for (const name of collections) {

			console.log(name + ' reset: ' + resetData['dropped'][name]);
		}
	}
	catch (e) {

		isErr = e.message;
	}

	if (!success) {

		console.log('Error occurred: ', isErr);
	}

	console.log('\nReset finished.');

	return { 'success': success, 'error': isErr };
}


// Lockout escape hatch: disable BOTH IP filters (server-wide and login) in the app config so a
// user who accidentally locked themselves out with an IP rule can regain access. The allow/block
// lists are preserved (not wiped) so they can review and correct them, but are no longer enforced
// until re-enabled. No confirmation prompt — this only relaxes restrictions, it destroys nothing.
async function resetIpFilterConsole(appConfigFile) {

	let success = false;

	try {

		const cfgFile = appConfigFile || 'app.json';
		const cfg = await shareData.Common.getConfig(cfgFile);

		if (!cfg || !cfg['success']) {

			console.log('Could not read ' + cfgFile + ' to clear IP filters.');
			return { 'success': false };
		}

		const data = cfg['data'];

		data.ip_filter = data.ip_filter || {};
		data.ip_filter.server = Object.assign({ 'allowlist': [], 'blocklist': [] }, data.ip_filter.server || {}, { 'enabled': false });
		data.ip_filter.login  = Object.assign({ 'allowlist': [], 'blocklist': [] }, data.ip_filter.login  || {}, { 'enabled': false });

		await shareData.Common.saveConfig(cfgFile, JSON.parse(JSON.stringify(data)));

		console.log('\nIP filters DISABLED for ' + shareData.appData.name + ' (server-wide and login).');
		console.log('Your allow/block lists are preserved but no longer enforced. Restart ' + shareData.appData.name + ', then correct and re-enable them from the configuration page.\n');

		success = true;
	}
	catch (e) { console.log('IP filter reset error: ' + e.message); }

	return { 'success': success };
}


async function resetAiChatsConsole() {

	let success = false;
	let isErr;

	console.log('\n*** CAUTION *** You are about to reset all AI chat conversations for ' + shareData.appData.name + '!\n');
	console.log('Database: ' + shareData.appData['mongo_db_url'] + '\n');

	const confirm = prompt('Do you want to continue? (Y/n): ');

	if (confirm === 'Y') {

		const resetCode = Math.floor(Math.random() * 1000000000);
		console.log('\nReset code: ' + resetCode);

		const code = prompt('Enter the reset code above to reset AI chat history: ');

		if (code == resetCode) {

			try {

				const resetData = await resetDatabase(false, false, true);

				success = resetData['success'];
				isErr   = resetData['error'];

				console.log('\nAI conversations reset: ' + resetData['collectionAiChats']);
			}
			catch(e) {

				isErr = e.message;
			}
		}
		else {

			console.log('\nReset code did not match. Aborted.');
		}
	}
	else {

		console.log('\nReset aborted.');
	}

	return { 'success': success, 'error': isErr };
}


async function resetConsole(serverIdError, resetServerId) {

	// Reset database from command line

	let success = false;

	let isErr;
	let confirm;
	let resetCode = Math.floor(Math.random() * 1000000000);

	let warnMsg = '\n*** CAUTION *** You are about to reset ' + shareData.appData.name + ' ';

	if (resetServerId) {

		warnMsg += 'server ID!'
	}
	else {

		warnMsg += 'database!';
	}

	warnMsg += '\n\n';
	warnMsg += 'Database to reset: ' + shareData.appData['mongo_db_url'] + '\n';

	console.log(warnMsg);

	if (serverIdError) {

		console.log('\n*** WARNING *** Your server ID does not match! Confirm you are connected to the correct database!\n');
	}

	confirm = prompt('Do you want to continue? (Y/n): ');

	if (confirm == 'Y') {

		console.log('\nReset code: ' + resetCode);

		confirm = prompt('Enter the reset code above to reset ' + shareData.appData.name + ': ');

		if (confirm == resetCode) {

			confirm = prompt('Final warning before reset. Do you want to continue? (Y/n): ');

			if (confirm == 'Y') {

				success = true;

				if (resetServerId) {

					const resetData = await resetDatabase(false, true);

					if (!resetData['success']) {

						success = false;
						isErr = resetData['error'];
					}

					console.log('Server reset: ' + resetData['collectionServer']);
				}
				else {

					const resetData = await resetDatabase(true, false);

					if (!resetData['success']) {

						success = false;
						isErr = resetData['error'];
					}

					console.log('Bots reset: ' + resetData['collectionBots']);
					console.log('Deals reset: ' + resetData['collectionDeals']);
					console.log('Sessions reset: ' + resetData['collectionSessions']);
				}

				if (!success) {

					console.log('Error occurred: ', isErr);
				}

				console.log('\nReset finished.');
			}
		}
		else {

			console.log('\nReset code incorrect.');
		}
	}

	if (!success) {

		console.log('\nReset aborted.');
	}

	process.exit(1);
}


// RESERVED SEAM — intentionally not yet wired to any route or handler.
// spawnCommand is the foundation for a future "run an external service" capability (an
// external-tool-execution path for the trade/external-action tier). It is kept deliberately even
// though nothing calls it yet; do NOT treat it as dead code. When it is wired up it MUST be
// owner-configured, capability-gated, and vetted — never invokable from a shared/community rule (that
// would be arbitrary code execution, which the scheduled-task security boundary forbids).
async function spawnCommand(command, options = {}) {

	const {
		logFile = null,
		timeout = null,
		onData = null,
		capture = false,
		killSignal = 'SIGTERM'
	} = options;

	let p, logStream;

	if (logFile) {

		logStream = fs.createWriteStream(logFile, {
			flags: 'a'
		});
	}

	try {

		if (Array.isArray(command)) {

			const [cmd, ...args] = command;

			p = spawn(cmd, args, {
				stdio: ['ignore', 'pipe', 'pipe']
			});
		}
		else {

			const shell = os.platform() === 'win32' ? 'cmd.exe' : 'sh';
			const args = os.platform() === 'win32' ? ['/c', command] : ['-c', command];

			p = spawn(shell, args, {
				stdio: ['ignore', 'pipe', 'pipe']
			});
		}
	}
	catch (err) {
	
		if (logStream) logStream.end();

		return {
			success: false,
			code: 'SPAWN_FAILED',
			stdout: '',
			stderr: '',
			error: err.message
		};
	}

	// Only buffer output if explicitly requested
	let stdoutData = capture ? '' : null;
	let stderrData = capture ? '' : null;
	let timer = null;

	return new Promise(resolve => {

		if (timeout) {

			timer = setTimeout(() => {

				p.kill(killSignal);

				setTimeout(() => {

					if (!p.killed) p.kill('SIGKILL');

				}, 500);

				if (logStream) logStream.end();

				resolve({
					success: false,
					code: 'ETIMEDOUT',
					stdout: stdoutData,
					stderr: stderrData,
					error: `Command timed out after ${timeout}ms`
				});
			}, timeout);
		}

		const handleChunk = (chunk, type) => {

			const text = chunk.toString();

			if (capture) {

				if (type === 'stdout') stdoutData += text;
				else stderrData += text;
			}

			if (logStream) logStream.write(text);
			if (onData) onData(text, type);
		};

		p.stdout.on('data', chunk => handleChunk(chunk, 'stdout'));
		p.stderr.on('data', chunk => handleChunk(chunk, 'stderr'));

		p.on('error', err => {

			if (timer) clearTimeout(timer);
			if (logStream) logStream.end();

			resolve({
				success: false,
				code: 'SPAWN_ERROR',
				stdout: stdoutData,
				stderr: stderrData,
				error: err.message
			});
		});

		p.on('exit', code => {

			if (timer) clearTimeout(timer);
			if (logStream) logStream.end();

			resolve({
				success: code === 0,
				code,
				stdout: stdoutData,
				stderr: stderrData,
				error: code === 0 ? null : `Command failed with exit code ${code}`
			});
		});
	});
}


async function sftpUploadFile(localFile, isTest) {

	let password = '';
	let passphrase = '';

	const sftpPasswordEnc = shareData['appData']['cron_backup']['sftp']['password'];
	const sftpPassphraseEnc = shareData['appData']['cron_backup']['sftp']['passphrase'];

	if (sftpPasswordEnc) {

		const sftpPasswordDecObj = await decrypt(sftpPasswordEnc, shareData.appData.password);

		if (sftpPasswordDecObj.success) {

			password = sftpPasswordDecObj.data;
		}
	}

	if (sftpPassphraseEnc) {

		const sftpPassphraseDecObj = await decrypt(sftpPassphraseEnc, shareData.appData.password);

		if (sftpPassphraseDecObj.success) {

			passphrase = sftpPassphraseDecObj.data;
		}
	}

	// Decrypt the stored private key content.
	// The value in app.json is now an encrypted blob, not a file path.
	let privateKey = '';

	const sftpPrivateKeyEnc = shareData['appData']['cron_backup']['sftp']['private_key'];

	if (sftpPrivateKeyEnc) {

		const sftpPrivateKeyDecObj = await decrypt(sftpPrivateKeyEnc, shareData.appData.password);

		if (sftpPrivateKeyDecObj.success) {

			privateKey = sftpPrivateKeyDecObj.data;
		}
	}

	const config = {
        'host': shareData.appData['cron_backup']['sftp']['host'],
        'port': shareData.appData['cron_backup']['sftp']['port'],
        'username': shareData.appData['cron_backup']['sftp']['username'],
        'password': password,
        'privateKey': privateKey,
        'passphrase': passphrase
    };

    const remoteDir = shareData.appData['cron_backup']['sftp']['remote_directory'];
    const maxBackups = shareData.appData['cron_backup']['max'];

	const res = await sftpUploadBackup(config, localFile, remoteDir, maxBackups, isTest);

	return res;
}


async function start(url) {

	dbUrl = url;

	// The database backup is now a scheduler-managed job (type 'backup'). It is migrated
	// from app.json and armed by the central Scheduler at boot (see symbot.js), so nothing
	// is started here.
}


// ── Integrity checks (Watchdog) ──────────────────────────────────────────────────

// Encrypted values are stored as `<32-hex-iv>:<base64>` (see encrypt). This recognizes that shape so
// the decryptability check only tests values that are ACTUALLY encrypted — never a plaintext or empty
// one, which would otherwise look like a false failure.
function looksEncrypted(v) { return typeof v === 'string' && /^[0-9a-f]{32}:.+/.test(v); }

// Re-key ONE secret from oldKey to newKey, in place, round-trip-verified: decrypt under the old key,
// re-encrypt under the new key, and only accept the result if it decrypts back to the exact plaintext.
// A value that isn't encrypted, or that can't be recovered under the old key, is left untouched (never
// double-encrypted / corrupted). Returns true if it rewrote the value. Mirrors the web password-change
// re-key so the console recovery path is no longer the odd one out.
async function rekeySecretInPlace(container, key, oldKey, newKey) {

	try {
		const val = container && container[key];
		if (!looksEncrypted(val)) { return false; }

		const dec = await decrypt(val, oldKey);
		if (!dec || dec.success !== true || dec.data == null) { return false; }

		const enc = await encrypt(dec.data, newKey);
		if (!enc || enc.success !== true || !enc.data) { return false; }

		const check = await decrypt(enc.data, newKey);
		if (check && check.success === true && check.data === dec.data) { container[key] = enc.data; return true; }
	}
	catch (e) { /* leave the value as-is on any failure */ }

	return false;
}

// The at-rest ENCRYPTED secret paths inside app.json, as key-path arrays. This is the SINGLE source of
// truth for that set: the console/web re-key (rekeyAllSecrets), the web password-change flow (Common.js
// updateConfig), and the decryptability watchdog all derive from it, so a newly-added encrypted app.json
// secret is re-keyed AND verified everywhere by editing one list. (Exchange credentials live in the
// bot-config file, and the backup secrets in the DB schedules row — both handled separately.)
const APP_SECRET_PATHS = [
	[ 'cron_backup', 'password' ], [ 'cron_backup', 'sftp', 'password' ], [ 'cron_backup', 'sftp', 'passphrase' ], [ 'cron_backup', 'sftp', 'private_key' ],
	[ 'mailer', 'password' ], [ 'ai', 'openai', 'api_key' ], [ 'ai', 'ollama', 'api_key' ], [ 'signals', '3CQS', 'api_key' ]
];


// Re-key EVERY at-rest secret from the old app password to the new one, BEFORE the password is
// overwritten. Covers app.json provider/backup/mailer secrets and the bot-config exchange credentials
// (the highest-value ones — orphaning them stops the exchange connection and therefore trading). Used
// by the console password-reset recovery path, which previously changed the password WITHOUT re-keying,
// silently orphaning every secret. Best-effort and self-contained: a secret that can't be recovered is
// left untouched and surfaced by the decryptability watchdog on the next boot.
async function rekeyAllSecrets(appData, oldKey, newKey) {

	// app.json secrets (the shared single list; the web password-change flow and the decryptability
	// watchdog derive from the same APP_SECRET_PATHS so they can never drift).
	for (const p of APP_SECRET_PATHS) {
		let obj = appData;
		for (let i = 0; i < p.length - 1; i++) { obj = obj && obj[p[i]]; }
		if (obj) { await rekeySecretInPlace(obj, p[p.length - 1], oldKey, newKey); }
	}

	// bot-config exchange credentials (separate file).
	try {
		const botConfigFile = appData && appData.bot_config;
		if (botConfigFile && shareData.Common && typeof shareData.Common.getConfig === 'function') {
			const botData = await shareData.Common.getConfig(botConfigFile);
			const botCfg = botData && botData.data;
			if (botCfg) {
				let changed = false;
				for (const f of [ 'apiKey', 'apiSecret', 'apiPassphrase', 'apiPassword' ]) {
					if (await rekeySecretInPlace(botCfg, f, oldKey, newKey)) { changed = true; }
				}
				if (changed) { await shareData.Common.saveConfig(botConfigFile, JSON.parse(JSON.stringify(botCfg))); }
			}
		}
	}
	catch (e) { /* bot-config re-key is best-effort; the watchdog warns if a cred can't decrypt */ }

	// Backup-schedule secrets (archive password + SFTP credentials) live in the DB schedules collection,
	// NOT app.json — the web password-change path re-keys them via reEncryptBackupSecrets, so the console
	// recovery path must too, or a lockout recovery would silently orphan them and the next scheduled
	// backup would fail. Best-effort and DB-guarded: it queries the schedules row directly (no Scheduler
	// start needed), but if the DB isn't ready this is a harmless no-op.
	try { await reEncryptBackupSecrets(oldKey, newKey); }
	catch (e) { /* best-effort; the decryptability watchdog warns if a backup secret can't decrypt */ }
}

// If an IP allow/deny filter is in use BUT SymBot is trusting client-supplied forwarded-IP headers
// (the default), the filter can be defeated by spoofing those headers unless a trusted reverse proxy
// (that overwrites/strips them) sits in front. Warn-only: this is a configuration hazard, not a fault.
function ipFilterSpoofableCheck() {

	const app = shareData && shareData.appData;
	if (!app) { return null; }

	// Default (absent or not exactly false) = SymBot trusts x-forwarded-for / cf-connecting-ip.
	const trustsHeaders = !(app.security && app.security.trust_proxy === false);
	if (!trustsHeaders) { return null; }   // headers already ignored — filtering is not spoofable

	const ipf = app.ip_filter || {};
	const serverOn = !!(ipf.server && ipf.server.enabled);
	const loginOn  = !!(ipf.login && ipf.login.enabled);
	if (!serverOn && !loginOn) { return null; }   // no IP filter configured — nothing to spoof around

	const which = [ serverOn ? 'server-wide' : null, loginOn ? 'login' : null ].filter(Boolean).join(' and ');

	return {
		action: 'watchdog.ip_filter_spoofable',
		target: which,
		detail: 'an IP allow/deny filter (' + which + ') is enabled while SymBot trusts client-supplied forwarded-IP headers — if this instance is reachable directly (not only through a trusted reverse proxy), the filter can be bypassed by spoofing those headers'
	};
}

// Every ENCRYPTED secret in app.json must decrypt with the CURRENT app password. Catches a secret
// orphaned by a password change — it would silently fail only when the feature that needs it runs.
async function secretDecryptabilityCheck() {

	const app = shareData && shareData.appData;
	if (!app || !app.password) { return null; }

	// Cover exactly the app.json paths rekeyAllSecrets re-keys — derived from the SAME APP_SECRET_PATHS
	// list so a newly-added encrypted secret is verified here automatically rather than failing silently
	// when its feature next runs. A path whose parent object is absent resolves to undefined and is simply
	// skipped below (looksEncrypted(undefined) is false).
	const candidates = APP_SECRET_PATHS.map((p) => [ p.join('.'), p.reduce((o, k) => (o == null ? o : o[k]), app) ]);

	// Exchange credentials live in the bot-config file, encrypted under the SAME app password. They are
	// the highest-value secret here: if they can't decrypt, connectExchange fails and order placement /
	// cancellation break — the exact silent, trading-affecting failure this warn-only check exists to
	// surface (e.g. after an app-password change that didn't re-key them). Read-only: we attempt the
	// decrypt below and discard the result, never echoing the value. Absent on the Hub (no bot_config),
	// so this adds nothing there.
	try {
		const botConfigFile = app.bot_config;
		if (botConfigFile && shareData.Common && typeof shareData.Common.getConfig === 'function') {
			const botData = await shareData.Common.getConfig(botConfigFile);
			const botCfg = botData && botData.data;
			if (botCfg) {
				for (const f of [ 'apiKey', 'apiSecret', 'apiPassphrase', 'apiPassword' ]) {
					candidates.push([ 'bot_config.' + f, botCfg[f] ]);
				}
			}
		}
	}
	catch (e) { /* a config-read hiccup must never fail the check itself */ }

	// Backup-schedule secrets (archive password + SFTP credentials) live in the DB schedules row, not
	// app.json, and rekeyAllSecrets re-keys them via reEncryptBackupSecrets — so an orphaned one would
	// silently break the next scheduled off-site backup, defeating the very safety net a backup is. Read
	// the backup singleton directly (no Scheduler start needed); DB-guarded so a not-ready DB is a no-op.
	try {
		if (shareData.Scheduler && typeof shareData.Scheduler.getSingleton === 'function') {
			const row = await shareData.Scheduler.getSingleton('backup');
			const s = (row && row.settings) || null;
			if (s) {
				const sftp = s.sftp || {};
				candidates.push([ 'backup.password', s.password ], [ 'backup.sftp.password', sftp.password ], [ 'backup.sftp.passphrase', sftp.passphrase ], [ 'backup.sftp.private_key', sftp.private_key ]);
			}
		}
	}
	catch (e) { /* a DB hiccup must never fail the check itself */ }
	// (extend with other known encrypted config paths as they are introduced)

	const bad = [];
	for (const pair of candidates) {
		const name = pair[0], val = pair[1];
		if (!looksEncrypted(val)) { continue; }   // plaintext / empty ⇒ nothing to verify
		try { const d = await decrypt(val, app.password); if (!d || d.success !== true) { bad.push(name); } }
		catch (e) { bad.push(name); }
	}

	return bad.length
		? { action: 'watchdog.undecryptable_secret', target: String(bad.length), detail: 'encrypted config secret(s) will not decrypt with the current app password — re-enter them in Configuration: ' + bad.join(', ') }
		: null;
}

// The critical database indexes the app relies on must exist. A missing index is a silent performance
// cliff (full collection scans), not an error, so it never surfaces on its own.
const REQUIRED_INDEXES = [
	{ collection: 'schedules',    keys: { schedule_id: 1 } },
	{ collection: 'schedules',    keys: { server_id: 1 } },
	{ collection: 'recipe_state', keys: { server_id: 1, recipe_id: 1 } },
	{ collection: 'deals',        keys: { dealId: 1 } },
	{ collection: 'deals',        keys: { status: 1 } },
	{ collection: 'deals',        keys: { botId: 1, status: 1 } },
	{ collection: 'deals',        keys: { botId: 1, pair: 1, status: 1 } },
	{ collection: 'deals',        keys: { 'sellData.date': 1, status: 1 } },
	{ collection: 'bots',         keys: { botId: 1 } }
];
function indexKeyString(keys) { return Object.keys(keys).map(k => k + ':' + keys[k]).join(','); }

async function dbIndexPresenceCheck() {

	// Read indexes off the app's ALREADY-OPEN connection rather than opening (and leaking) a fresh one
	// — connectDb() creates a new connection every call, and this warm read never needs its own.
	let db;
	try { db = shareData && shareData.DB && shareData.DB.mongoose && shareData.DB.mongoose.connection && shareData.DB.mongoose.connection.db; }
	catch (e) { return null; }
	if (!db) { return null; }

	const missing = [];
	for (const req of REQUIRED_INDEXES) {
		try {
			const idx = await db.collection(req.collection).indexes();
			const want = indexKeyString(req.keys);
			if (!(idx || []).some(i => indexKeyString(i.key || {}) === want)) { missing.push(req.collection + '{' + want + '}'); }
		}
		catch (e) { /* a collection absent on a fresh install is not a finding */ }
	}

	return missing.length
		? { action: 'watchdog.missing_db_index', target: String(missing.length), detail: 'expected database index(es) are missing (queries may full-scan): ' + missing.join(', ') }
		: null;
}


// Log secret scan — a defense-in-depth DETECTOR that complements the write-time scrubbing in
// Common.logger(). It samples the tail of the recently-written log files and warns (warn-only) if
// any line still looks like it holds a live credential — catching a redactor gap, or a code path
// that reached a log by some route other than the central logger. Crucially the finding NEVER
// echoes the matched value (that would re-log the secret it is warning about): it reports only
// which shape matched and on how many lines, so the operator can go review, rotate, and report it.
const LOG_SCAN_MAX_FILES  = 8;
const LOG_SCAN_TAIL_BYTES = 262144;                 // read at most the last 256 KB of each file
const LOG_SCAN_MAX_AGE_MS = 26 * 60 * 60 * 1000;    // only logs written in roughly the last day

const LOG_SECRET_PATTERNS = [
	{ label: 'default api key',   re: /symb_auto_[0-9a-f]{16,}/ },
	{ label: 'scoped api key',    re: /symb_(?:live|test)_[0-9a-f]{6,}_[0-9a-f]{16,}/ },
	{ label: 'url credentials',   re: /:\/\/[^\s/@:]+:[^\s/@]+@/ },
	{ label: 'bearer token',      re: /\bBearer\s+[A-Za-z0-9._\-]{12,}/ },
	{ label: 'url secret param',  re: /[?&](?:token|secret|api[_-]?key|password|pass)=(?!\[REDACTED\])[^&\s"']{8,}/i },
	{ label: 'credential field',  re: /\b(?:password|passwd|api_?secret|secret_key|access_key|private_?key|token_id)\b["']?\s*[:=]\s*["']?(?!\[REDACTED\])[^\s"',}]{8,}/i }
];

function readFileTail(file, maxBytes) {

	let fd;

	try {
		fd = fs.openSync(file, 'r');
		const size = fs.fstatSync(fd).size;
		const len  = Math.min(size, maxBytes);
		const buf  = Buffer.alloc(len);
		if (len > 0) { fs.readSync(fd, buf, 0, len, size - len); }
		return buf.toString('utf8');
	}
	catch (e) { return ''; }
	finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} } }
}

function logSecretScanCheck() {

	// Resolve the logs dir through the single source of truth so this scanner follows the instance's
	// real log location (flat today; data/instances/<server_id>/logs later) without a second copy of
	// the path logic.
	const dir = (shareData.Common && typeof shareData.Common.logDir === 'function')
		? shareData.Common.logDir()
		: pathRoot + '/logs';

	let files;
	try { files = fs.readdirSync(dir); }
	catch (e) { return null; }   // no logs directory yet ⇒ nothing to scan

	const now = Date.now();

	const recent = files
		.filter(f => f.endsWith('.log'))
		.map(f => { let m = 0; try { m = fs.statSync(path.join(dir, f)).mtimeMs; } catch (e) {} return { f: f, m: m }; })
		.filter(x => x.m && (now - x.m) <= LOG_SCAN_MAX_AGE_MS)
		.sort((a, b) => b.m - a.m)
		.slice(0, LOG_SCAN_MAX_FILES);

	const hits = {};
	let totalLines = 0;

	for (const entry of recent) {

		const text = readFileTail(path.join(dir, entry.f), LOG_SCAN_TAIL_BYTES);
		if (!text) { continue; }

		const lines = text.split('\n');

		for (let i = 0; i < lines.length; i++) {
			for (let p = 0; p < LOG_SECRET_PATTERNS.length; p++) {
				if (LOG_SECRET_PATTERNS[p].re.test(lines[i])) {
					hits[LOG_SECRET_PATTERNS[p].label] = (hits[LOG_SECRET_PATTERNS[p].label] || 0) + 1;
					totalLines++;
					break;   // one hit per line is enough
				}
			}
		}
	}

	const labels = Object.keys(hits);
	if (!labels.length) { return null; }

	const summary = labels.map(l => l + ' ×' + hits[l]).join(', ');

	return {
		action: 'watchdog.log_secret_detected',
		target: String(totalLines),
		detail: 'one or more recent log lines look like they hold an unredacted credential (' + summary + '). Review the logs, rotate the exposed secret, and report it so the redactor can be extended. Values are withheld here so this warning does not re-log the secret.'
	};
}


// Writable data directories — the platform must be able to WRITE to a handful of directories or
// core features fail quietly: config saves (Settings), logging, and backups. A read-only mount, a
// permissions mistake, or a full disk turns those into silent no-ops. This probes writability with
// fs.accessSync(W_OK) — it never creates or deletes anything — and only flags a directory that
// EXISTS but is not writable, so a not-yet-created dir on a fresh install is never a false positive.
function dataDirWritableCheck() {

	// Resolve the logs dir through the same single source of truth the log scanner uses, so this
	// follows the instance's real location without a second copy of the path logic.
	const logsDir = (shareData.Common && typeof shareData.Common.logDir === 'function')
		? shareData.Common.logDir()
		: pathRoot + '/logs';

	const targets = [
		{ label: 'config',  dir: pathRoot + '/config' },   // Settings / config saves
		{ label: 'logs',    dir: logsDir },                // logging
		{ label: 'backups', dir: (shareData.Common && typeof shareData.Common.instanceDataDir === 'function') ? shareData.Common.instanceDataDir('backups') : (pathRoot + '/backups') }
	];

	const unwritable = [];
	for (const t of targets) {
		if (!t.dir) { continue; }
		try {
			// Only a directory that already exists is a candidate — a missing one is created on demand.
			if (!fs.existsSync(t.dir)) { continue; }
			fs.accessSync(t.dir, fs.constants.W_OK);
		}
		catch (e) { unwritable.push(t.label); }
	}

	return unwritable.length
		? { action: 'watchdog.data_dir_unwritable', target: String(unwritable.length), detail: 'these data directories are not writable (config saves, logs, or backups will fail): ' + unwritable.join(', ') }
		: null;
}


module.exports = {

	start,
	pause,
	resetConsole,
	resetAiChatsConsole,
	resetAuthConsole,
	resetIpFilterConsole,
	resetAuthCollections,
	confirmResetPrompt,
	resetDatabase,
	resetSessions,
	updateSystem,
	connectDb,
	backupDb,
	encrypt,
	decrypt,
	encryptFile,
	decryptFile,
	restoreDb,
	// Exposed for the backup/restore round-trip simulation (config bundling + manifest verification).
	compress,
	decompress,
	logManifest,
	verifyBackupManifest,
	copyConfigIntoBackup,
	restoreConfigFromBackup,
	backupConfigFileNames,
	// backup artifact index (exposed for tests + boot reconcile)
	recordBackupArtifact,
	reconcileBackupsIndex,
	retainBackups,
	// Exposed for tests: the collision-proof shared-temp path helper. Every write into tempDir must go
	// through this so simultaneous per-instance backups/restores under the Hub can never share a filename.
	uniqueTempPath,

	// Re-home this instance's DB rows onto the current server_id: one unconditional foreign-id sweep that self-
	// heals any stranded row every boot, for standalone and Hub alike. Called from boot; core exposed for tests.
	rehomeScopedIdentity,
	rehomeScopedIdentityOnDb,   // exposed for tests — the re-home core, operating on an injected db handle
	strandedScopedRowsCheck,    // exposed for tests — the Watchdog backstop for the re-home

	// off-site (SFTP) upload core (exposed for tests — operates on an injected sftp client)
	sftpPutAndRotate,
	backupAllCollections,
	restoreAllCollections,
	routeBackupDb,
	routeRestoreDb,
	routeUpdateSystem,
	rollbackConsole,
	routeListRollbacks,
	routeRollbackSystem,
	hydrateCronBackup,
	registerBackupHandler,
	saveBackupSchedule,
	migrateBackupToScheduler,
	reEncryptBackupSecrets,
	rekeyAllSecrets,
	APP_SECRET_PATHS,
	spawnCommand,
	sftpUploadFile,
	get shutDown() {
        return shutDownFunction;
    },

	secretDecryptabilityCheck,
	dbIndexPresenceCheck,
	logSecretScanCheck,

	init: function(obj, shutDown) {

		shareData = obj;
		shutDownFunction = shutDown;

		// Self-policing integrity checks (warn-only, logged to the audit): encrypted config secrets
		// still decrypt with the current app password, the critical DB indexes exist, and no recent
		// log line looks like it leaked an unredacted credential.
		if (obj && obj.Watchdog && typeof obj.Watchdog.register === 'function') {
			obj.Watchdog.register('config_secret_decryptable', secretDecryptabilityCheck);
			obj.Watchdog.register('db_index_presence', dbIndexPresenceCheck);
			obj.Watchdog.register('log_secret_scan', logSecretScanCheck);
			obj.Watchdog.register('stranded_scoped_rows', strandedScopedRowsCheck);
			obj.Watchdog.register('data_dir_writable', dataDirWritableCheck);
			obj.Watchdog.register('ip_filter_spoofable', ipFilterSpoofableCheck);
		}
	},
};