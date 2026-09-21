'use strict';

// Guard against a whole class of stored XSS: any raw EJS output of `JSON.stringify(...)` emitted into a
// page (nearly always inside an inline <script>) MUST neutralize `<` to `<`, otherwise a value that
// contains `</script>` — e.g. a user-chosen bot name or pair, notification text, or exchange label — breaks
// out of the script tag and executes injected markup on the next page load.
//
// The fix used throughout the views is `<%- JSON.stringify(x).replace(/</g, '\\u003c') %>`. This test walks
// every .ejs view and fails if any `<%- ... JSON.stringify ... %>` block is missing that guard, so a new
// inline data injection can never ship unescaped. Pure/static — reads files, runs nothing.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const VIEWS_DIR = path.resolve(__dirname, '..', '..', 'webserver', 'public', 'views');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

function walk(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) { out.push(...walk(full)); }
		else if (entry.isFile() && entry.name.endsWith('.ejs')) { out.push(full); }
	}
	return out;
}

console.log('\nInline JSON XSS guard (every raw JSON.stringify output escapes "<"):');

test('no view emits an unguarded <%- JSON.stringify(...) %>', () => {
	const files = walk(VIEWS_DIR);
	assert.ok(files.length > 0, 'found EJS views to scan');

	const offenders = [];
	// Match each raw-output EJS tag (`<%- ... %>`), non-greedy so tags don't merge.
	const rawTag = /<%-[\s\S]*?%>/g;

	for (const file of files) {
		const src = fs.readFileSync(file, 'utf8');
		let m;
		while ((m = rawTag.exec(src)) !== null) {
			const block = m[0];
			if (block.indexOf('JSON.stringify') === -1) { continue; }
			// The guard escapes "<" so a JSON string value can never contain a literal "</script>".
			const guarded = block.indexOf('\\u003c') !== -1 || /\.replace\(\s*\/</.test(block);
			if (!guarded) { offenders.push(path.relative(VIEWS_DIR, file) + ': ' + block.replace(/\s+/g, ' ').slice(0, 120)); }
		}
	}

	assert.strictEqual(offenders.length, 0,
		'unguarded inline JSON.stringify output(s) found (add .replace(/</g, "\\\\u003c")):\n         ' + offenders.join('\n         '));
});

console.log('\n' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
process.exit(failed ? 1 : 0);
