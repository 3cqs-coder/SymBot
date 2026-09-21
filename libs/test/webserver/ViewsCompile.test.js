'use strict';

// Every EJS view/partial must COMPILE — a template that only fails at render time ships a hard 500 to
// users (a stray "<%= %>" written inside a scriptlet comment once broke partialsFileList.ejs, and with it
// the Logs and Backups pages of every install, standalone and Hub). EJS's tokenizer scans for the raw
// delimiters and does not understand JS comments or strings, so a literal "<%"/"%>" anywhere in a
// scriptlet silently corrupts the parse. This gate compiles all templates up front so that class of bug
// is caught in dev, not in production.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

const viewsDir = path.join(__dirname, '..', '..', 'webserver', 'public', 'views');

function walk(dir) {
	let out = [];
	for (const entry of fs.readdirSync(dir)) {
		const p = path.join(dir, entry);
		const st = fs.statSync(p);
		if (st.isDirectory()) { out = out.concat(walk(p)); }
		else if (entry.endsWith('.ejs')) { out.push(p); }
	}
	return out;
}

console.log('\nEJS templates compile:');

const templates = walk(viewsDir);

test('found a non-trivial set of .ejs templates to check', () => {
	assert.ok(templates.length >= 10, 'expected the views directory to hold the app templates, found ' + templates.length);
});

for (const file of templates) {
	const rel = file.slice(file.indexOf('views' + path.sep) + 6);
	test(rel + ' compiles', () => {
		const src = fs.readFileSync(file, 'utf8');
		// filename is required so include() resolves and error messages point at the right file.
		ejs.compile(src, { filename: file });
	});
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
