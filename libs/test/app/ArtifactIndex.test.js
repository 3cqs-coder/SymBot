'use strict';

// Tests for the per-directory artifact manifest (libs/app/ArtifactIndex.js). They exercise the pure
// selectors and the atomic filesystem I/O over disposable temp dirs, and prove the self-healing invariant:
// the directory is the source of truth, and reconcile() rebuilds a lost/corrupt/stale index from it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AI = require('../../app/ArtifactIndex.js');

let passed = 0, failed = 0;
function test(name, fn) {
	try { fn(); passed++; console.log('  ok   - ' + name); }
	catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + (e && e.message)); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'symbot-artifactindex-'));
function freshDir(name) { const d = path.join(TMP, name + '-' + Math.floor(Math.random() * 1e9)); fs.mkdirSync(d, { recursive: true }); return d; }
function touch(dir, name, bytes, mtimeMs) {
	const p = path.join(dir, name);
	fs.writeFileSync(p, Buffer.alloc(bytes || 1, 'x'));
	if (mtimeMs) { const t = mtimeMs / 1000; fs.utimesSync(p, t, t); }
	return p;
}

console.log('\npure helpers:');

test('emptyManifest has the versioned shape', () => {
	const m = AI.emptyManifest('backups', { server_id: 's1', instance_name: 'NE' });
	assert.strictEqual(m.version, AI.SCHEMA_VERSION);
	assert.strictEqual(m.kind, 'backups');
	assert.strictEqual(m.server_id, 's1');
	assert.strictEqual(m.instance_name, 'NE');
	assert.deepStrictEqual(m.entries, []);
});

test('normalize upgrades version, preserves unknown fields, mints id/created_utc, dedupes by file', () => {
	const raw = {
		version: 0, kind: 'backups', future_top_field: 'keep-me',
		entries: [
			{ file: 'b-1.enc', size: 10, custom: 'x' },                 // no id/created_utc
			{ file: 'b-1.enc', size: 20 },                              // duplicate file → last wins
			{ file: 'sub/../evil.enc' },                                // path stripped to basename
			{ nope: true },                                             // no file → dropped
			{ file: '.index.json' }                                     // the index itself → dropped
		]
	};
	const m = AI.normalize(raw, 'backups', { server_id: 's', instance_name: 'N' });
	assert.strictEqual(m.version, AI.SCHEMA_VERSION);
	assert.strictEqual(m.future_top_field, 'keep-me', 'unknown top-level field preserved');
	const files = m.entries.map(e => e.file).sort();
	assert.deepStrictEqual(files, [ 'b-1.enc', 'evil.enc' ], 'basename-only + dropped bad/index entries');
	const b1 = m.entries.find(e => e.file === 'b-1.enc');
	assert.strictEqual(b1.size, 20, 'last duplicate wins');
	assert.ok(b1.id && b1.created_utc, 'id + created_utc minted');
});

test('normalize never DOWNGRADES a higher version (rollback safety) but stamps at least the current one', () => {
	// A newer build wrote version 99 with an extra field; this (older) build must keep both, so the file
	// still reads as "last touched by a newer schema" instead of being silently stamped back to 1.
	const newer = AI.normalize({ version: 99, future_field: 'x', entries: [ { file: 'b.enc' } ] }, 'backups', null);
	assert.strictEqual(newer.version, 99, 'higher version preserved on rewrite');
	assert.strictEqual(newer.future_field, 'x', 'unknown field from the newer schema preserved');
	// An older/absent/garbage version is brought UP to the current one.
	assert.strictEqual(AI.normalize({ version: 0, entries: [] }, 'logs', null).version, AI.SCHEMA_VERSION, 'older version upgraded');
	assert.strictEqual(AI.normalize({ version: 'nope', entries: [] }, 'logs', null).version, AI.SCHEMA_VERSION, 'non-numeric version → current');
});

test('upsert adds, then replaces by file while keeping the id and merging fields', () => {
	const m = AI.emptyManifest('logs');
	AI.upsert(m, { file: '2026-08-14.log', size: 5 });
	const id1 = m.entries[0].id;
	AI.upsert(m, { file: '2026-08-14.log', size: 99, utc_start: 'T' });   // replace/merge
	assert.strictEqual(m.entries.length, 1);
	assert.strictEqual(m.entries[0].id, id1, 'id preserved across replace');
	assert.strictEqual(m.entries[0].size, 99);
	assert.strictEqual(m.entries[0].utc_start, 'T', 'kind-specific field preserved');
});

test('dropByFile removes only the named entry', () => {
	const m = AI.emptyManifest('backups');
	AI.upsert(m, { file: 'a.enc' }); AI.upsert(m, { file: 'b.enc' });
	AI.dropByFile(m, 'a.enc');
	assert.deepStrictEqual(m.entries.map(e => e.file), [ 'b.enc' ]);
});

test('selectExpired: only entries older than maxAgeDays; missing created_utc kept; <=0 disables', () => {
	const now = Date.parse('2026-08-20T00:00:00.000Z');
	const m = AI.emptyManifest('logs');
	m.entries = [
		{ file: 'old.log',   created_utc: '2026-08-01T00:00:00.000Z' },   // 19 days
		{ file: 'fresh.log', created_utc: '2026-08-19T00:00:00.000Z' },   // 1 day
		{ file: 'nostamp.log' }                                            // no created_utc
	];
	const expired = AI.selectExpired(m, { maxAgeDays: 10, now }).map(e => e.file);
	assert.deepStrictEqual(expired, [ 'old.log' ]);
	assert.deepStrictEqual(AI.selectExpired(m, { maxAgeDays: 0, now }), [], 'maxAgeDays<=0 disables');
});

test('selectExcess: oldest beyond keep; keep<=0 keeps everything', () => {
	const m = AI.emptyManifest('backups');
	m.entries = [
		{ file: 'b3.enc', created_utc: '2026-08-03T00:00:00.000Z' },
		{ file: 'b1.enc', created_utc: '2026-08-01T00:00:00.000Z' },
		{ file: 'b2.enc', created_utc: '2026-08-02T00:00:00.000Z' }
	];
	assert.deepStrictEqual(AI.selectExcess(m, { keep: 2 }).map(e => e.file), [ 'b1.enc' ], 'oldest one dropped');
	assert.deepStrictEqual(AI.selectExcess(m, { keep: 0 }), [], 'keep<=0 keeps all (safety)');
	assert.deepStrictEqual(AI.selectExcess(m, { keep: 5 }), [], 'keep>=count drops none');
});

console.log('\nfilesystem I/O:');

test('save then load round-trips and writes the dotfile', () => {
	const dir = freshDir('roundtrip');
	const m = AI.emptyManifest('backups', { server_id: 's', instance_name: 'N' });
	AI.upsert(m, { file: 'b.enc', size: 7 });
	assert.strictEqual(AI.save(dir, m), true);
	assert.ok(fs.existsSync(path.join(dir, '.index.json')), 'index dotfile written');
	const back = AI.load(dir, 'backups');
	assert.strictEqual(back.entries.length, 1);
	assert.strictEqual(back.entries[0].file, 'b.enc');
});

test('load of a missing or corrupt index yields a fresh empty manifest (no throw)', () => {
	const dir = freshDir('corrupt');
	assert.deepStrictEqual(AI.load(dir, 'logs').entries, [], 'missing → empty');
	fs.writeFileSync(path.join(dir, '.index.json'), '{ this is not json');
	assert.deepStrictEqual(AI.load(dir, 'logs').entries, [], 'corrupt → empty');
});

test('save leaves no temp file behind', () => {
	const dir = freshDir('notemp');
	AI.save(dir, AI.emptyManifest('logs'));
	assert.ok(!fs.readdirSync(dir).some(f => f.includes('.tmp')), 'no .tmp residue');
});

console.log('\nreconcile (self-healing):');

test('reconcile ADDS untracked artifact files, skipping the index, dotfiles and non-artifacts', () => {
	const dir = freshDir('recon-add');
	touch(dir, 'backup-100.zip.enc', 10, Date.parse('2026-08-10T00:00:00Z'));
	touch(dir, 'backup-200.zip.enc', 20, Date.parse('2026-08-11T00:00:00Z'));
	touch(dir, 'notes.txt', 5);                 // not an artifact
	touch(dir, '.hidden', 5);                   // dotfile
	const isArtifact = (n) => /\.zip\.enc$/.test(n);
	const r = AI.reconcile(dir, { kind: 'backups', isArtifact });
	assert.deepStrictEqual(r.added.sort(), [ 'backup-100.zip.enc', 'backup-200.zip.enc' ]);
	assert.strictEqual(r.changed, true);
	const e = r.manifest.entries.find(x => x.file === 'backup-100.zip.enc');
	assert.strictEqual(e.size, 10);
	assert.ok(e.created_utc.startsWith('2026-08-10'), 'created_utc seeded from mtime');
});

test('reconcile DROPS entries whose file is gone, and is idempotent (no change second time)', () => {
	const dir = freshDir('recon-drop');
	touch(dir, 'a.zip.enc', 1);
	const isArtifact = (n) => /\.zip\.enc$/.test(n);
	AI.reconcile(dir, { kind: 'backups', isArtifact });
	// now delete the file out-of-band and reconcile again
	fs.unlinkSync(path.join(dir, 'a.zip.enc'));
	const r1 = AI.reconcile(dir, { kind: 'backups', isArtifact });
	assert.deepStrictEqual(r1.removed, [ 'a.zip.enc' ]);
	assert.strictEqual(r1.manifest.entries.length, 0);
	const r2 = AI.reconcile(dir, { kind: 'backups', isArtifact });
	assert.strictEqual(r2.changed, false, 'idempotent: nothing to do the second time');
});

test('reconcile REBUILDS a deleted index from the directory (the core invariant)', () => {
	const dir = freshDir('recon-rebuild');
	touch(dir, 'x.zip.enc', 3); touch(dir, 'y.zip.enc', 4);
	const isArtifact = (n) => /\.zip\.enc$/.test(n);
	AI.reconcile(dir, { kind: 'backups', isArtifact });
	fs.unlinkSync(path.join(dir, '.index.json'));            // lose the index entirely
	const r = AI.reconcile(dir, { kind: 'backups', isArtifact });
	assert.deepStrictEqual(r.manifest.entries.map(e => e.file).sort(), [ 'x.zip.enc', 'y.zip.enc' ]);
});

test('reconcile deriveEntry seeds kind-specific fields on new entries only', () => {
	const dir = freshDir('recon-derive');
	touch(dir, '2026-08-14.log', 8);
	const r = AI.reconcile(dir, {
		kind: 'logs',
		isArtifact: (n) => /^\d{4}-\d{2}-\d{2}\.log$/.test(n),
		deriveEntry: (name) => ({ date: name.slice(0, 10) })
	});
	assert.strictEqual(r.manifest.entries[0].date, '2026-08-14');
});

test('record + forget wrappers persist across reload', () => {
	const dir = freshDir('record');
	AI.record(dir, 'backups', { server_id: 's', instance_name: 'N' }, { file: 'b.zip.enc', size: 12 });
	assert.strictEqual(AI.load(dir, 'backups').entries.length, 1);
	AI.forget(dir, 'b.zip.enc');
	assert.strictEqual(AI.load(dir, 'backups').entries.length, 0);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
