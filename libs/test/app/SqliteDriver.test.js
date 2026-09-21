'use strict';

// Resilience tests for the hardened SQLite driver (libs/app/store/SqliteDriver.js). These use
// real files in a temp dir and deliberately CORRUPT the database to prove the crash-proof
// guarantees a trading platform needs: WAL, atomic transactions, live VACUUM INTO backups,
// and auto-recovery (restore-from-backup / start-clean) that never throws the process down.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SqliteDriver = require('../../app/store/SqliteDriver.js');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'symbot-sqlite-'));
// Each db gets its OWN directory so its backups/ subdir is isolated from other tests.
function freshPath(name) {
	const dir = path.join(TMP, name + '-' + Math.floor(Math.random() * 1e9));
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, 'db.db');
}


console.log('\ncore + durability:');

test('opens in WAL mode with the durability pragmas', () => {
	const dbPath = freshPath('wal');
	const d = SqliteDriver({ path: dbPath });
	d.open();
	assert.strictEqual(String(d.get('PRAGMA journal_mode;').journal_mode).toLowerCase(), 'wal');
	assert.ok(d.isHealthy(), 'quick_check ok');
	d.close();
});

test('basic CRUD survives a close/reopen (WAL replayed)', () => {
	const dbPath = freshPath('crud');
	let d = SqliteDriver({ path: dbPath });
	d.open();
	d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);');
	d.run('INSERT INTO t (v) VALUES (?)', ['hello']);
	d.close();
	d = SqliteDriver({ path: dbPath });
	d.open();
	assert.strictEqual(d.get('SELECT v FROM t WHERE id = 1').v, 'hello');
	d.close();
});

test('transaction commits, and rolls back atomically on throw', () => {
	const dbPath = freshPath('txn');
	const d = SqliteDriver({ path: dbPath });
	d.open();
	d.exec('CREATE TABLE t (v TEXT);');
	d.transaction((tx) => { tx.run('INSERT INTO t (v) VALUES (?)', ['a']); tx.run('INSERT INTO t (v) VALUES (?)', ['b']); });
	assert.strictEqual(d.get('SELECT COUNT(*) c FROM t').c, 2, 'commit persisted both');
	try { d.transaction((tx) => { tx.run('INSERT INTO t (v) VALUES (?)', ['c']); throw new Error('boom'); }); } catch (e) {}
	assert.strictEqual(d.get('SELECT COUNT(*) c FROM t').c, 2, 'rolled back the failed txn');
	d.close();
});


console.log('\nlive backup:');

test('VACUUM INTO backup produces a consistent, readable copy of the live data', () => {
	const dbPath = freshPath('bk');
	const d = SqliteDriver({ path: dbPath });
	d.open();
	d.exec('CREATE TABLE t (v TEXT);');
	d.run('INSERT INTO t (v) VALUES (?)', ['live']);
	const backupFile = d.backup();
	assert.ok(backupFile && fs.existsSync(backupFile), 'backup file created while live');

	// The backup opens independently and holds the data.
	const b = SqliteDriver({ path: backupFile });
	b.open();
	assert.ok(b.isHealthy(), 'backup passes integrity check');
	assert.strictEqual(b.get('SELECT v FROM t').v, 'live');
	b.close();
	d.close();
});

test('backup rotation keeps only the newest N', () => {
	const dbPath = freshPath('rot');
	const d = SqliteDriver({ path: dbPath, backupKeep: 2 });
	d.open();
	d.exec('CREATE TABLE t (v TEXT);');
	for (let i = 0; i < 4; i++) { d.run('INSERT INTO t (v) VALUES (?)', ['x']); d.backup(); }
	const dir = path.join(path.dirname(dbPath), 'backups');
	const count = fs.readdirSync(dir).filter(f => /^hub-\d+\.db$/.test(f)).length;
	assert.ok(count <= 2, 'kept at most 2 backups, saw ' + count);
	d.close();
});


console.log('\nauto-recovery (crash-proof):');

test('a corrupt database is RESTORED from the newest backup — no throw', () => {
	const dbPath = freshPath('corrupt-restore');
	let d = SqliteDriver({ path: dbPath });
	d.open();
	d.exec('CREATE TABLE t (v TEXT);');
	d.run('INSERT INTO t (v) VALUES (?)', ['precious']);
	d.backup();
	d.close();

	// Simulate on-disk corruption of the main file.
	fs.writeFileSync(dbPath, 'this is not a sqlite database at all');
	[ '-wal', '-shm' ].forEach(ext => { try { fs.unlinkSync(dbPath + ext); } catch (e) {} });

	// Reopen — must recover, not crash, and the data must be back.
	d = SqliteDriver({ path: dbPath });
	assert.doesNotThrow(() => d.open(), 'recovery must never throw');
	assert.ok(d.isHealthy(), 'recovered database is healthy');
	assert.strictEqual(d.get('SELECT v FROM t').v, 'precious', 'restored the data from backup');

	// The damaged file was preserved for forensics.
	const damaged = fs.readdirSync(path.dirname(dbPath)).some(f => f.indexOf('.corrupt-') >= 0);
	assert.ok(damaged, 'corrupt file kept aside');
	d.close();
});

test('recovery falls THROUGH a corrupt newest backup to an older GOOD one (not a clean start)', () => {
	const dbPath = freshPath('corrupt-newest-backup');
	let d = SqliteDriver({ path: dbPath });
	d.open();
	d.exec('CREATE TABLE t (v TEXT);');
	d.run('INSERT INTO t (v) VALUES (?)', ['older-good']);
	const goodBackup = d.backup();   // the good (older) snapshot
	d.close();

	// Drop a NEWER but corrupt snapshot into the backups dir, and force its mtime to be the newest.
	const backupsDir = path.dirname(goodBackup);
	const corruptNewest = path.join(backupsDir, 'hub-' + (Date.now() + 1) + '.db');
	fs.writeFileSync(corruptNewest, 'not a sqlite database');
	const future = new Date(Date.now() + 3600 * 1000);
	fs.utimesSync(corruptNewest, future, future);

	// Corrupt the main file.
	fs.writeFileSync(dbPath, 'garbage, not sqlite');
	[ '-wal', '-shm' ].forEach(ext => { try { fs.unlinkSync(dbPath + ext); } catch (e) {} });

	d = SqliteDriver({ path: dbPath });
	assert.doesNotThrow(() => d.open(), 'recovery must never throw');
	assert.ok(d.isHealthy(), 'recovered database is healthy');
	assert.strictEqual(d.get('SELECT v FROM t').v, 'older-good', 'restored from the older GOOD backup after skipping the corrupt newest one');
	d.close();
});

test('a same-millisecond hub-<ts>-N snapshot is listed and restorable', () => {
	const dbPath = freshPath('dash-n');
	const d = SqliteDriver({ path: dbPath });
	d.open();
	d.exec('CREATE TABLE t (v TEXT);');
	d.run('INSERT INTO t (v) VALUES (?)', ['dashn']);
	const realBackup = d.backup();
	const backupsDir = path.dirname(realBackup);
	// Simulate the collision case backup() handles: two snapshots in the same ms → hub-<ts>-1.db.
	const dashN = path.join(backupsDir, 'hub-' + Date.now() + '-1.db');
	fs.copyFileSync(realBackup, dashN);

	const names = d.listBackups().map(b => b.name);
	assert.ok(names.includes(path.basename(dashN)), 'listBackups includes the -N snapshot (was previously invisible)');

	const r = d.restore(path.basename(dashN));
	assert.ok(r && r.success, 'restore accepts the -N snapshot: ' + JSON.stringify(r));
	d.close();
});

test('a corrupt database with NO backup starts CLEAN — no throw', () => {
	const dbPath = freshPath('corrupt-clean');
	// Write a garbage file with no backups dir at all.
	fs.writeFileSync(dbPath, 'garbage, definitely not sqlite');
	const d = SqliteDriver({ path: dbPath });
	assert.doesNotThrow(() => d.open(), 'must recover to a clean db, not crash');
	assert.ok(d.isHealthy(), 'clean db is healthy');
	d.exec('CREATE TABLE t (v TEXT);');   // usable
	d.run('INSERT INTO t (v) VALUES (?)', ['fresh']);
	assert.strictEqual(d.get('SELECT v FROM t').v, 'fresh');
	d.close();
});


// Cleanup
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
