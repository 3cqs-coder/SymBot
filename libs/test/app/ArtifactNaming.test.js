'use strict';

// Friendly artifact naming — the "<instance>-<file>" download name and its shared sanitizer.
//
// The v7 per-instance layout dropped the instance name from log/backup FILENAMES (bare "<date>.log",
// name-free "…​.zip.enc") and moved identity into each folder's .index.json. That is correct for storage
// but leaves a downloaded or SFTP'd file with no instance identity. friendlyArtifactName() rebuilds a
// friendly name at serve time from that index, with a fail-safe fallback chain so it degrades to today's
// bare name and NEVER throws. These tests pin every branch, for both the Hub and a single instance.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ArtifactIndex = require('../../app/ArtifactIndex.js');
const Common = require('../../app/Common.js');
const { safeInstanceLabel, friendlyArtifactName } = Common;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

// ── safeInstanceLabel (pure) ─────────────────────────────────────────────────
console.log('\nsafeInstanceLabel:');
test('keeps a clean name', () => assert.strictEqual(safeInstanceLabel('Binance-Paper'), 'Binance-Paper'));
test('collapses unsafe chars to a single dash', () => assert.strictEqual(safeInstanceLabel('My Bot / v2:live'), 'My-Bot-v2-live'));
test('trims edge dashes/dots', () => assert.strictEqual(safeInstanceLabel('--x.--'), 'x'));
test('empty / null → empty string (caller falls back to bare name)', () => {
	assert.strictEqual(safeInstanceLabel(''), '');
	assert.strictEqual(safeInstanceLabel(null), '');
	assert.strictEqual(safeInstanceLabel(undefined), '');
});
test('caps length at 60', () => assert.ok(safeInstanceLabel('a'.repeat(200)).length === 60));

// ── friendlyArtifactName ─────────────────────────────────────────────────────
console.log('\nfriendlyArtifactName:');

// Hub case: the instance name comes from the resolved folder's .index.json (what the Hub actually does).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artnaming-'));
try {
	ArtifactIndex.record(tmp, 'logs', { server_id: 'abc123', instance_name: 'Binance-Paper' },
		{ file: '2026-08-27.log', size: 10, created_utc: '2026-08-27T00:00:00.000Z' });

	test('Hub: reads the instance name from the folder index', () => {
		assert.strictEqual(
			friendlyArtifactName(path.join(tmp, '2026-08-27.log'), '2026-08-27.log', 'logs', true),
			'Binance-Paper-2026-08-27.log');
	});

	test('an unsafe index name is sanitized into the download name', () => {
		const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'artnaming2-'));
		ArtifactIndex.record(dir2, 'logs', { server_id: 's2', instance_name: 'Acct / Live:1' },
			{ file: '2026-08-27.log', size: 1, created_utc: '2026-08-27T00:00:00.000Z' });
		assert.strictEqual(
			friendlyArtifactName(path.join(dir2, '2026-08-27.log'), '2026-08-27.log', 'logs', true),
			'Acct-Live-1-2026-08-27.log');
		fs.rmSync(dir2, { recursive: true, force: true });
	});
}
finally { fs.rmSync(tmp, { recursive: true, force: true }); }

// Fallback chain (no index present — an empty temp dir).
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'artnaming-empty-'));
try {
	test('fallback: legacy "<date>-<name>.log" carries the name in the filename', () => {
		assert.strictEqual(
			friendlyArtifactName(path.join(empty, '2026-08-27-Coinbase-Real.log'), '2026-08-27-Coinbase-Real.log', 'logs', true),
			'Coinbase-Real-2026-08-27-Coinbase-Real.log');
	});
	test('fallback: legacy "SymBot-<name>-backup-…" carries the name', () => {
		assert.strictEqual(
			friendlyArtifactName(path.join(empty, 'SymBot-Kraken-backup-123.zip.enc'), 'SymBot-Kraken-backup-123.zip.enc', 'backups', true),
			'Kraken-SymBot-Kraken-backup-123.zip.enc');
	});
	test('fail-safe: no name resolvable → the bare filename (today\'s behavior)', () => {
		assert.strictEqual(
			friendlyArtifactName(path.join(empty, '2026-08-27.log'), '2026-08-27.log', 'logs', true),
			'2026-08-27.log');
	});
	test('never throws on a bad path', () => {
		assert.strictEqual(friendlyArtifactName(null, '2026-08-27.log', 'logs', true), '2026-08-27.log');
	});
}
finally { fs.rmSync(empty, { recursive: true, force: true }); }

// ── instanceBackupFileName (the OFF-SITE/SFTP backup filename, from the instance's OWN identity) ──────
// The off-site subfolder is the internal server_id (not human-readable), so the FILENAME must carry the
// instance name. It comes from the instance's stable identifier (instanceNameSync), NOT the manifest-first
// friendly resolver — so it is the instance's name identically however the backup was triggered, and it does
// not depend on a Hub display name being set. Falls back to the server_id .instance.json marker, then bare.
console.log('\ninstanceBackupFileName:');
const localBak = '/data/instances/abc-uuid/backups/backup-20260828_161257.zip.enc';

test('Hub worker → "<instance>-backup-<date>" from the identifier (NO display name needed)', () => {
	Common.init({ appData: { worker_data: { name: 'Coinbase-Real' } } });
	assert.strictEqual(Common.instanceBackupFileName(localBak), 'Coinbase-Real-backup-20260828_161257.zip.enc');
});
test('a Hub DISPLAY name does not change it — the stable identifier is used', () => {
	Common.init({ appData: { worker_data: { name: 'Coinbase-Real', name_display: 'My Fancy Bot' } } });
	assert.strictEqual(Common.instanceBackupFileName(localBak), 'Coinbase-Real-backup-20260828_161257.zip.enc');
});
test('an unsafe instance name is sanitized', () => {
	Common.init({ appData: { worker_data: { name: 'Acct / Live:1' } } });
	assert.strictEqual(Common.instanceBackupFileName(localBak), 'Acct-Live-1-backup-20260828_161257.zip.enc');
});
test('standalone (no worker_data, no marker) → bare filename', () => {
	Common.init({ appData: {} });
	assert.strictEqual(Common.instanceBackupFileName(localBak), 'backup-20260828_161257.zip.enc');
});
test('fallback: no live identity but a server_id .instance.json marker → the marker name', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instbak-'));
	const backups = path.join(root, 'backups');
	fs.mkdirSync(backups, { recursive: true });
	fs.writeFileSync(path.join(root, '.instance.json'), JSON.stringify({ instance_name: 'Kraken-Live' }));
	Common.init({ appData: {} });   // no worker_data → falls back to the marker tied to the backed-up data
	assert.strictEqual(
		Common.instanceBackupFileName(path.join(backups, 'backup-20260828_161257.zip.enc')),
		'Kraken-Live-backup-20260828_161257.zip.enc');
	fs.rmSync(root, { recursive: true, force: true });
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
