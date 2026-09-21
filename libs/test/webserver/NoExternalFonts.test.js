'use strict';

// Fonts must be served locally, never from a CDN (the app already vendors its JS libraries the same way). An
// earlier version loaded Heebo from fonts.googleapis.com / fonts.gstatic.com; this guard pins that those CDN
// references are gone, the woff2 files are vendored under css/vendor/fonts/, and style.css points at the local
// files — so a future edit cannot silently reintroduce a CDN font (a privacy and offline-availability
// regression). It intentionally checks only the app's own views and stylesheets, not third-party vendor CSS.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', '..', 'webserver', 'public');
const CSS = path.join(PUB, 'css');
const VIEWS = path.join(PUB, 'views');
const FONTS = path.join(CSS, 'vendor', 'fonts');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

function walk(dir, ext, out) {
	out = out || [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) { walk(p, ext, out); }
		else if (e.name.endsWith(ext)) { out.push(p); }
	}
	return out;
}

console.log('\nFonts are vendored locally (no CDN):');

test('no app view or app stylesheet references a font CDN (googleapis/gstatic)', () => {
	const files = walk(VIEWS, '.ejs')
		.concat([ path.join(CSS, 'style.css'), path.join(CSS, 'style-news.css') ].filter(fs.existsSync));
	const offenders = [];
	for (const f of files) {
		if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(fs.readFileSync(f, 'utf8'))) { offenders.push(path.relative(PUB, f)); }
	}
	assert.deepStrictEqual(offenders, [], 'these still reference a font CDN — vendor the font locally: ' + JSON.stringify(offenders));
});

test('the vendored Heebo woff2 files exist and are non-empty', () => {
	for (const name of [ 'heebo-latin.woff2', 'heebo-hebrew.woff2' ]) {
		const p = path.join(FONTS, name);
		assert.ok(fs.existsSync(p) && fs.statSync(p).size > 0, 'missing vendored font: ' + name);
	}
});

test('style.css @font-face points at the local vendored files', () => {
	const css = fs.readFileSync(path.join(CSS, 'style.css'), 'utf8');
	assert.ok(css.includes('vendor/fonts/heebo-latin.woff2'), 'style.css does not reference the local latin font');
	assert.ok(css.includes('vendor/fonts/heebo-hebrew.woff2'), 'style.css does not reference the local hebrew font');
});

console.log('\nNoExternalFonts: ' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
