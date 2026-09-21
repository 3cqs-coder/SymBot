'use strict';

// Tests the Diagnostics catalog: lookups, graceful fallback for unknown codes, console annotation
// shape, and — importantly — that EVERY watchdog action code the codebase can emit has an entry, so
// a real finding is never printed without an explanation.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Diagnostics = require('../../app/Diagnostics.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// explain() returns a well-formed entry for a known code.
const drift = Diagnostics.explain('watchdog.capability_drift');
ok(drift && typeof drift.meaning === 'string' && drift.meaning.length > 20, 'known code returns a meaning');
ok(drift && typeof drift.fix === 'string' && drift.fix.length > 10, 'known code returns a fix');

// Unknown / empty codes fall back to null (caller keeps its bare message).
ok(Diagnostics.explain('watchdog.does_not_exist') === null, 'unknown code returns null');
ok(Diagnostics.explain('') === null, 'empty code returns null');
ok(Diagnostics.explain(undefined) === null, 'undefined code returns null');

// annotate() returns two indented lines for a known code, and [] for an unknown one.
const lines = Diagnostics.annotate('watchdog.capability_drift');
ok(Array.isArray(lines) && lines.length === 2, 'annotate returns two lines for a known code');
ok(/What it means:/.test(lines[0]) && /How to fix:/.test(lines[1]), 'annotate lines are labeled');
ok(Diagnostics.annotate('nope').length === 0, 'annotate returns [] for an unknown code');
ok(Diagnostics.annotate().length === 0, 'annotate handles no argument');

// catalog() is a copy — mutating it must not corrupt the source.
const cat = Diagnostics.catalog();
cat['watchdog.capability_drift'].meaning = 'MUTATED';
ok(Diagnostics.explain('watchdog.capability_drift').meaning !== 'MUTATED', 'catalog() returns a copy, not the live map');

// Coverage guard: every 'watchdog.*' action string that appears anywhere under libs/ must have a
// catalog entry, so no finding is ever logged without an explanation. Scans source text so a NEW
// check added later without a diagnostics entry trips this test. The regex tolerates either key- or
// value-quote style ('action'/action, 'watchdog.x'/"watchdog.x") so a check written in a different
// house style is not silently missed by the scan.
function walk(dir, acc) {
	for (const name of fs.readdirSync(dir)) {
		const full = path.join(dir, name);
		const st = fs.statSync(full);
		if (st.isDirectory()) { if (name !== 'test' && name !== 'node_modules') { walk(full, acc); } }
		else if (name.endsWith('.js')) { acc.push(full); }
	}
	return acc;
}
const libsDir = path.join(__dirname, '..', '..');
const codes = new Set();
for (const file of walk(libsDir, [])) {
	const txt = fs.readFileSync(file, 'utf8');
	const re = /["']?action["']?\s*:\s*["'](watchdog\.[a-z_]+)["']/g;
	let m;
	while ((m = re.exec(txt))) { codes.add(m[1]); }
}
// 'watchdog.check_failed' is emitted by the runner itself (not via an `action:` literal in a check).
codes.add('watchdog.check_failed');
const uncovered = [ ...codes ].filter(c => !Diagnostics.explain(c));
ok(uncovered.length === 0, 'every watchdog action code has a catalog entry — missing: ' + uncovered.join(', '));

console.log('Diagnostics: ' + passed + ' assertions passed (' + codes.size + ' watchdog codes all covered)');
