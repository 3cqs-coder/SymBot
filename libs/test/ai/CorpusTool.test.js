'use strict';

// Tests the `corpus` maintenance command's engine: the shipped seed corpus must pass its own integrity
// check, its checksum must match a fresh recomputation, and every registered tool that needs coverage
// must have at least one pattern. regen() is exercised in compute-only mode (write:false) so the test
// never mutates the shipped file.

const assert = require('assert');
const CorpusTool = require('../../ai/CorpusTool.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// The shipped corpus verifies cleanly against the current tool registry.
const v = CorpusTool.check();
ok(v.ok === true, 'shipped seed corpus passes integrity verification');
ok(v.records > 0, 'corpus has records (' + v.records + ')');
ok(v.rejected === 0, 'no records are rejected against the current registry');
ok(v.manifest_checksum === v.expected_checksum, 'manifest checksum matches a fresh recomputation');
ok(v.tools_version_file === v.tools_version_now, 'tools_version reflects the current tool set (run "corpus regen" if this fails)');
ok(Array.isArray(v.uncovered) && v.uncovered.length === 0, 'every tool that needs a pattern has one — uncovered: ' + (v.uncovered || []).join(', '));

// regen (compute-only) reproduces the SAME checksum the file already carries — i.e. the shipped file is
// already in its regenerated form, so the command is idempotent on a clean corpus.
const r = CorpusTool.regen({ write: false });
ok(r.after === v.manifest_checksum, 'regen recomputes the same checksum the shipped file carries (idempotent)');
ok(r.changed === false, 'regen reports no change needed on the clean shipped corpus');
ok(r.dropped === 0, 'regen drops no records from the clean corpus');

console.log('CorpusTool: ' + passed + ' assertions passed (' + v.records + ' records, all tools covered)');
