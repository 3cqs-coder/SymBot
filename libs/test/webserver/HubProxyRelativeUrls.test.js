'use strict';

// Drift-guard for Hub reverse-proxy URL correctness. Under the Hub, an instance's UI is served beneath
// /instance/<id>/, and relative client URLs resolve against a <base href="/instance/<id>/"> so they reach the
// instance. An ABSOLUTE client request path (fetch('/api/...'), fetch('/app-version'), etc.) ignores <base>
// and therefore hits the HUB origin instead of the instance — a silent wrong-server bug that only shows up
// under the Hub. This exact class has bitten twice (the late <base> injection, and fetch('/app-version')), so
// this test pins the rule: client-side fetch() calls must be relative. Vendored ASSETS (/js, /css, /images)
// are intentionally absolute (the Hub serves the same static tree at its root and <base> does not affect them),
// and those load via <script>/<link>/<img>, not fetch(), so they are out of scope here.
//
// Scans every browser JS file and every inline <script> in the EJS views.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..', '..');
const publicDir = path.join(root, 'libs', 'webserver', 'public');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok   - ' + msg); } else { failed++; process.exitCode = 1; console.log('  FAIL - ' + msg); } }

function walk(dir, exts) {
	let out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === 'vendor') { continue; }   // third-party libraries are not ours to constrain
			out = out.concat(walk(p, exts));
		}
		else if (exts.some((x) => e.name.endsWith(x))) { out.push(p); }
	}
	return out;
}

// An absolute fetch to a path: fetch('/...') or fetch("/...") but NOT fetch('//host') (protocol-relative) and
// NOT a full URL. This is the wrong-under-Hub pattern.
const ABS_FETCH = /fetch\(\s*['"]\/(?!\/)/g;

const files = walk(publicDir, [ '.js', '.ejs' ]);
let offenders = [];

for (const f of files) {
	const txt = fs.readFileSync(f, 'utf8');
	const matches = txt.match(ABS_FETCH);
	if (matches) { offenders.push(path.relative(root, f) + ' (' + matches.length + ')'); }
}

ok(files.length > 20, 'scanned the browser JS + view files (' + files.length + ' files)');
ok(offenders.length === 0,
	'no client-side absolute fetch(\'/...\') that would bypass the Hub /instance/<id>/ base — use a relative path. Offenders: ' + JSON.stringify(offenders));

console.log('\n' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
process.exit(failed ? 1 : 0);
