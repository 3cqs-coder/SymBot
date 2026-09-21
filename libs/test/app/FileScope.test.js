'use strict';

// Tests Common.fileInScope — the predicate that gates BOTH the logs/backups listing and their download.
// Its job is now (a) a basename/traversal guard and (b) an artifact-TYPE check (a real dated log or an
// encrypted backup, never the manifest, a marker, or a stray file). It is deliberately NAME-AGNOSTIC:
// cross-instance isolation is provided by the DIRECTORY (a non-Hub download resolves only within the
// instance's own data/instances/<server_id>/<kind>/ folder via resolveDataFilePath, so a sibling's
// filename simply isn't found there). This removed the old per-name regex and its hardcoded "SymBot-"
// coupling, which broke listing/download if the product token ever changed.

const assert = require('assert');
const Common = require('../../app/Common.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; console.log('  ok   - ' + m); }

const f = Common.fileInScope;

// ── Artifact TYPE is accepted, regardless of the instance name in the filename ──
ok(f('2026-08-15-Binance-Paper.log', 'logs') === true, 'a dated log is in scope');
ok(f('2026-08-15.log', 'logs') === true, 'an unnamed standalone dated log is in scope');
ok(f('2026-08-26-hub.log', 'logs') === true, 'a hub log is in scope');
ok(f('2026-08-14-.log', 'logs') === true, 'a "<date>-.log" trailing-dash log is still in scope');
ok(f('SymBot-Coinbase-Real-backup-20260815_120000.zip.enc', 'backups') === true, 'an encrypted backup is in scope');
ok(f('AnyProduct-Whatever-backup-x.zip.enc', 'backups') === true, 'a backup is matched by shape, not a hardcoded product token (the fixed bug)');

// ── Name-agnostic: fileInScope no longer isolates by name — the DIRECTORY does ──
ok(f('2026-08-15-Coinbase-Real.log', 'logs') === true, "fileInScope accepts any valid artifact name; isolation is the folder, not the name");

// ── Non-artifacts are rejected (manifest, markers, unrelated files) ──
ok(f('.index.json', 'logs') === false, 'the artifact manifest is not a downloadable artifact');
ok(f('.instance.json', 'backups') === false, 'the folder marker is not a downloadable artifact');
ok(f('notes.txt', 'logs') === false, 'an unrelated file is rejected');
ok(f('server.log', 'logs') === false, 'a .log without a date prefix is not a tracked log');
ok(f('backup.txt', 'backups') === false, 'a non-.zip.enc file is not a backup');
ok(f('2026-08-15-Binance.log', 'backups') === false, 'a log is not in scope for the backups type');

// ── Traversal / basename guard (unchanged) ──
ok(f('..', 'logs') === false, 'a bare ".." is blocked');
ok(f('.', 'logs') === false, 'a bare "." is blocked');
ok(f('../../app.json', 'logs') === false, 'parent-directory traversal is blocked');
ok(f('sub/dir.log', 'logs') === false, 'a nested path is blocked');
ok(f('', 'logs') === false, 'an empty filename is blocked');
ok(f(null, 'logs') === false, 'a null filename is blocked');
ok(f('2026-08-15-x.log/../../secret', 'logs') === false, 'a traversal disguised after a valid-looking prefix is blocked');

console.log('\nFileScope: ' + passed + ' assertions passed');
process.exit(0);
