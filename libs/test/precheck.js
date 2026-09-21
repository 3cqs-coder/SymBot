#!/usr/bin/env node
'use strict';

// Syntax gate for SymBot's own JavaScript.
//
// Runs `node --check` (parse without executing) over the given files, or over the whole source tree
// under libs/ plus the repo-root files when none are given. A single stray character — most infamously
// a backtick typed inside a backtick template literal, which silently closes the string — turns a whole
// file into a SyntaxError that only surfaces when the process fails to boot. This catches exactly that,
// and is wired into the git pre-commit hook (.githooks/pre-commit) and `npm run check` (which CI runs as
// its syntax gate). Uses only Node built-ins — no deps, cross-platform. Lives beside the suite in
// libs/test/, so ROOT is two levels up from here.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SKIP_DIRS = new Set([ 'node_modules', '.git', 'logs' ]);

function collect(dir, out) {

	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
	catch (e) { return out; }

	for (const e of entries) {

		if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) { continue; }

		const full = path.join(dir, e.name);

		if (e.isDirectory()) { collect(full, out); }
		else if (e.name.endsWith('.js') || e.name.endsWith('.json')) { out.push(full); }
	}

	return out;
}

// Files to check: explicit args (the pre-commit hook passes the staged .js/.json files), else the whole
// source tree under libs/ (which includes this test tree) plus any root-level files. JS is parsed with
// `node --check`; JSON is validated with JSON.parse (a broken data file — e.g. libs/ai/data/*.json — must
// be caught too).
let files = process.argv.slice(2).filter(f => f.endsWith('.js') || f.endsWith('.json'));

if (files.length === 0) {
	files = collect(path.join(ROOT, 'libs'), []);
	for (const f of fs.readdirSync(ROOT)) { if (f.endsWith('.js') || f.endsWith('.json')) { files.push(path.join(ROOT, f)); } }
}

let bad = 0;
let checked = 0;

for (const f of files) {

	if (!fs.existsSync(f)) { continue; }   // a staged path that was deleted
	checked++;

	try {
		if (f.endsWith('.json')) { JSON.parse(fs.readFileSync(f, 'utf8')); }
		else { execFileSync(process.execPath, [ '--check', f ], { stdio: 'pipe' }); }
	}
	catch (e) {
		bad++;
		process.stderr.write((f.endsWith('.json') ? 'INVALID JSON: ' : 'SYNTAX ERROR: ') + path.relative(ROOT, f) + '\n' + (e.stderr ? e.stderr.toString() : e.message) + '\n');
	}
}

if (bad > 0) {
	process.stderr.write('\n✗ precheck failed: ' + bad + ' file(s) with syntax errors.\n');
	process.exit(1);
}

process.stdout.write('✓ precheck: ' + checked + ' JavaScript file(s) parse cleanly.\n');
process.exit(0);
