'use strict';

// Regression guard for a subtle navigation bug. The app's sidebar links are RELATIVE (e.g. ./deals/history)
// and resolve against the document's <base href>. That base is computed at runtime (it must include the Hub
// reverse-proxy prefix /instance/<id>/, which is only knowable from the URL), and it is injected by an inline
// script in the <head> of partialsHeaderView.ejs. The base MUST be injected SYNCHRONOUSLY, before the vendor
// <script src> tags and before the <body>, so it exists the instant any nav link becomes clickable. It used to
// be added later, in $(document).ready — leaving a window where a click during page load on a multi-segment
// path (e.g. /logs/live) resolved a relative link to the wrong path (/logs/deals/history) and returned 404.
// This test pins the ordering so the early injection can never regress back to a late one.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const header = fs.readFileSync(path.join(__dirname, '..', '..', 'webserver', 'public', 'views', 'partialsHeaderView.ejs'), 'utf8');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; console.log('  ok   - ' + msg); }

// The synchronous base-injection: an inline script that creates a <base> element.
const injectIdx = header.indexOf("createElement('base')");
ok(injectIdx !== -1, 'partialsHeaderView injects a <base> element via an inline script');

// It must appear before the first external vendor script (so the base exists before jQuery et al. and, being in
// <head>, before the body/nav is parsed and clickable).
const firstVendorScript = header.indexOf('<script src=');
ok(firstVendorScript !== -1, 'header has external vendor scripts');
ok(injectIdx < firstVendorScript, 'the <base> is injected BEFORE the first vendor <script src> (synchronous, not deferred)');

// It must be in the <head>.
const headEnd = header.indexOf('</head>');
ok(headEnd !== -1 && injectIdx < headEnd, 'the <base> injection is inside <head>');

// The runtime base computation still handles the Hub reverse-proxy prefix.
ok(/segs\[0\]\s*===\s*'instance'/.test(header) || header.indexOf("=== 'instance'") !== -1,
	'the base computation still handles the Hub /instance/<id>/ proxy prefix');

// setBasePath must not blindly append a second <base> (it is guarded to avoid a duplicate).
ok(/if\s*\(\s*!document\.querySelector\('base'\)\s*\)/.test(header),
	'setBasePath only appends a <base> when none exists (no duplicate)');

console.log('\n✓ ' + passed + ' passed\n');
process.exit(0);
