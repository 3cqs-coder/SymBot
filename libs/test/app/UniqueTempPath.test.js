'use strict';

// Regression guard for the shared-temp-dir COLLISION class.
//
// Several Hub instances run from one install and share the temp directory, and the daily System backup fires
// on every instance at the same second. Before this guard the backup wrote a temp file named only from the
// (instance-agnostic) date/time — "backup-<date>_<time>.zip" — so two instances produced the IDENTICAL path
// and collided: one unlinked the shared file and the other failed to encrypt it (ENOENT), or they compressed
// over each other into a corrupt, short archive (a live incident: one instance's backup shrank from 59M to
// 18M, another's failed outright). uniqueTempPath prefixes every shared-temp write with a uuid so no two
// in-flight files can ever share a name. Every write into tempDir must route through it.

const assert = require('assert');
const crypto = require('crypto');
const System = require('../../app/System.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

// Inject a real unique-id generator (the same contract Common.uuidv4 provides).
System.init({ Common: { uuidv4: () => crypto.randomUUID() } });

const label = 'backup-20260828_060000.zip';
const a = System.uniqueTempPath(label);
const b = System.uniqueTempPath(label);

ok(a !== b, 'two calls with the SAME label produce DIFFERENT paths — the collision can never recur');
ok(a.endsWith('-' + label), 'the clean, instance-agnostic label is preserved as the suffix (stored name is unaffected)');
ok(/\/temp\/[0-9a-f-]{36}-backup-20260828_060000\.zip$/.test(a), 'path is tempDir/<uuid>-<label>');

// A batch of simultaneous calls (mimicking N Hub instances backing up at once) are ALL distinct.
const many = new Set();
for (let i = 0; i < 200; i++) { many.add(System.uniqueTempPath(label)); }
ok(many.size === 200, '200 concurrent same-label calls yield 200 distinct paths (no collisions at scale)');

// A missing label never throws and still yields a unique path.
ok(/-tmp$/.test(System.uniqueTempPath()), 'no label → safe "-tmp" suffix');
ok(System.uniqueTempPath() !== System.uniqueTempPath(), 'even label-less calls are unique');

// The label is basenamed defensively: a caller passing a path (or a traversal) can never nest a dir or
// escape tempDir — only the final filename survives, still uuid-prefixed inside tempDir.
const evil = System.uniqueTempPath('../../etc/evil.zip');
ok(evil.endsWith('-evil.zip') && evil.indexOf('..') === -1 && evil.indexOf('/etc/') === -1, 'a path-like label is reduced to its basename (no traversal, no nested dir)');
ok(/\/temp\/[0-9a-f-]{36}-evil\.zip$/.test(evil), 'the result stays tempDir/<uuid>-<basename>');

console.log('UniqueTempPath: ' + passed + ' assertions passed');
process.exit(0);
