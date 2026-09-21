'use strict';

// Syntax / data-integrity guard for the AI modules and their data files.
//
// AIClient.js is loaded only by the running webserver (requiring it here would keep timers alive
// and hang the test), so a syntax error in it — e.g. a stray backtick inside a template literal —
// used to slip past the whole suite and only surface when the live instance failed to boot.
// `node --check` parses without executing, catching exactly that. The prompt/guardrail TEXT now
// lives under libs/ai/data/ (plain .txt for prose, .json for structured lists); this also checks
// that the JSON there is valid and the .txt prose files are present and non-empty, since the chat
// loads them at startup.

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const aiDir = path.resolve(__dirname, '..', '..', 'ai');
const dataDir = path.join(aiDir, 'data');

let passed = 0, failed = 0;
function ok(name) { passed++; console.log('  ok   - ' + name); }
function fail(name, detail) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + detail); }

// 1. Every AI JavaScript module parses.
for (const file of fs.readdirSync(aiDir).filter(f => f.endsWith('.js'))) {
	try { execFileSync(process.execPath, [ '--check', path.join(aiDir, file) ], { stdio: 'pipe' }); ok(file + ' parses'); }
	catch (e) { fail(file + ' has a syntax error', (e.stderr ? e.stderr.toString() : e.message)); }
}

// 2. Every data JSON is valid.
for (const file of fs.readdirSync(dataDir).filter(f => f.endsWith('.json'))) {
	try { JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8')); ok('data/' + file + ' is valid JSON'); }
	catch (e) { fail('data/' + file + ' is invalid JSON', e.message); }
}

// 3. The prose .txt prompt files the chat loads at startup are present and non-empty.
for (const file of [ 'persona.txt', 'tool-system-note.txt', 'guardrail-trust-boundary.txt', 'guardrail-advice.txt', 'guardrail-provenance.txt' ]) {
	const full = path.join(dataDir, file);
	if (fs.existsSync(full) && fs.readFileSync(full, 'utf8').trim().length > 0) { ok('data/' + file + ' present and non-empty'); }
	else { fail('data/' + file + ' missing or empty', full); }
}

assert.ok(passed > 0);
console.log('\n' + passed + ' checks passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
