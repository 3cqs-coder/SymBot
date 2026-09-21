#!/usr/bin/env node
'use strict';

// Test runner for SymBot's own suite, kept beside the tests in libs/test/. It is committed to the repo so
// CI (`npm test`) can run it, but the test corpus is excluded from deployed Docker images — so on a checkout
// without the tests, `npm test` prints a friendly note and exits 0 rather than failing. In the dev repo it
// finds every *.test.js under libs/test/, runs each in its own Node process (isolation + real exit codes),
// and reports pass/fail. Cross-platform: pure Node, no shell globbing, so it works the same on Linux/macOS/
// Windows. Lives in libs/test/, so ROOT is two levels up from here.
//
// Usage:
//   node libs/test/run-tests.js               # run all *.test.js
//   node libs/test/run-tests.js AIGuardrails   # only files whose path contains "AIGuardrails"
//   npm test                                  # same as the first form
//
// It runs the assertion tests (*.test.js). The eval harnesses (*.eval.js, AIEval.js) drive a LIVE model /
// running instance, so they are not part of this suite — run those separately by hand.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST_DIR = path.join(ROOT, 'libs', 'test');
const PER_FILE_TIMEOUT_MS = 180000;

function collect(dir, out) {
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
	catch (e) { return out; }
	for (const e of entries) {
		const full = path.join(dir, e.name);
		if (e.isDirectory()) { collect(full, out); }
		else if (e.name.endsWith('.test.js')) { out.push(full); }
	}
	return out;
}

const filters = process.argv.slice(2).filter(a => !a.startsWith('-'));
let files = collect(TEST_DIR, []).sort();
if (filters.length) { files = files.filter(f => filters.some(s => f.includes(s))); }

if (!fs.existsSync(TEST_DIR) || files.length === 0) {
	process.stdout.write('No test files bundled in this distribution (SymBot tests are dev/CI-only). Nothing to run.\n');
	process.exit(0);
}

let passed = 0;
let failed = 0;
const failures = [];
const started = Date.now();

for (const f of files) {

	const rel = path.relative(ROOT, f);
	const r = cp.spawnSync(process.execPath, [ f ], { encoding: 'utf8', timeout: PER_FILE_TIMEOUT_MS, cwd: ROOT });
	const ok = !r.error && r.status === 0;

	if (ok) {
		passed++;
		process.stdout.write('  ✓ ' + rel + '\n');
	}
	else {
		failed++;
		const detail = ((r.error ? r.error.message + '\n' : '') + (r.stderr || '') + (r.stdout || '')).trim();
		failures.push({ rel: rel, detail: detail.split('\n').slice(-8).join('\n') });
		process.stdout.write('  ✗ ' + rel + '\n');
	}
}

process.stdout.write('\n');
for (const fl of failures) { process.stdout.write('── FAIL ' + fl.rel + '\n' + fl.detail + '\n\n'); }

const secs = ((Date.now() - started) / 1000).toFixed(1);
process.stdout.write((failed ? '✗' : '✓') + ' ' + passed + ' passed, ' + failed + ' failed  (' + files.length + ' files, ' + secs + 's)\n');
process.exit(failed ? 1 : 0);
