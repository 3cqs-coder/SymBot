'use strict';

// Guards against the exact bug fixed in the fourth audit pass: aiGuardrails.spotlight() returns an OBJECT
// { wrapped, note, tag }, so using its result directly in a string (concatenation or template interpolation)
// silently produces "[object Object]" and drops the grounding data plus its prompt-injection wrapper. Correct
// usage always assigns the result to a variable first, then reads .wrapped / .note. This is a source scan (the
// same style as the other guard tests) because the misuse is a rendering bug that unit tests would not catch.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const AI_DIR = path.join(__dirname, '..', '..', 'ai');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; process.exitCode = 1; console.log('  FAIL - ' + msg); } }

console.log('\nspotlight() usage guard:');

const files = fs.readdirSync(AI_DIR).filter(f => f.endsWith('.js'));

for (const file of files) {

	const src = fs.readFileSync(path.join(AI_DIR, file), 'utf8');
	const lines = src.split('\n');

	lines.forEach((line, i) => {

		// Skip the definition itself and comments.
		const trimmed = line.trim();
		if (trimmed.startsWith('//') || trimmed.startsWith('*') || /function\s+spotlight\s*\(/.test(line)) { return; }

		if (line.indexOf('spotlight(') < 0) { return; }

		// Misuse A: the call result is concatenated directly, e.g. spotlight(...) + '...'
		ok(!/spotlight\([^;]*\)\s*\+/.test(line),
			file + ':' + (i + 1) + ' concatenates the spotlight() object directly — assign it and use .wrapped/.note');

		// Misuse B: the call is interpolated into a template literal, e.g. `...${spotlight(...)}...`
		ok(!/\$\{[^}]*spotlight\(/.test(line),
			file + ':' + (i + 1) + ' interpolates the spotlight() object into a template — use .wrapped/.note');
	});
}

console.log('spotlight usage: ' + (failed ? ('✗ ' + failed + ' failed') : ('✓ ' + passed + ' checks passed')) + '\n');
