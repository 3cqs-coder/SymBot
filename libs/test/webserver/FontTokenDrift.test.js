'use strict';

// Drift-guard for the typography scale. Font sizes and weights are single-sourced as CSS custom properties
// (--fs-* / --fw-* in style.css) so the whole app renders on ONE universal scale that can be tuned in one
// place. This test scans the stylesheet and every EJS view for raw font-size (rem) and font-weight literals
// that bypass those tokens. A small, explicit allowlist covers the intentional exceptions — display/glyph/hero
// sizes and sub-micro badges that legitimately sit outside the readable-text scale, the light 300 weight that
// has no token, and the @font-face descriptors (where a var() is invalid and a literal is required). Anything
// else is drift: a new hardcoded size/weight that should reference a token. Keeping this green keeps the scale
// consistent as the UI grows.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..', '..');
const cssPath = path.join(root, 'libs', 'webserver', 'public', 'css', 'style.css');
const viewsDir = path.join(root, 'libs', 'webserver', 'public', 'views');

// Intentional font-size rem literals that are NOT part of the readable-text scale (icon glyphs, hero titles,
// mood/emoji chips, and deliberately tiny sub-micro badges). Add a value here only for a genuine new exception.
const ALLOWED_FS_REM = new Set(['2.5', '1.9', '1.5', '1.4', '0.72', '0.7', '0.65']);
// Font-weight literals allowed outside @font-face: the light 300 (no token exists for it).
const ALLOWED_FW = new Set(['300']);

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok   - ' + msg); } else { failed++; process.exitCode = 1; console.log('  FAIL - ' + msg); } }

// Remove @font-face { ... } blocks so their required literal font-weight descriptors are not counted as drift.
function stripFontFace(css) {
	return css.replace(/@font-face\s*\{[^}]*\}/g, '');
}

function scanFontSize(text) {
	const out = [];
	const re = /font-size:\s*([0-9.]+)rem\b/g;
	let m;
	while ((m = re.exec(text)) !== null) { if (!ALLOWED_FS_REM.has(m[1])) { out.push(m[1] + 'rem'); } }
	return out;
}

function scanFontWeight(text) {
	const out = [];
	const re = /font-weight:\s*(\d+|bold|normal)\b/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		const v = m[1];
		if (v === 'bold' || v === 'normal') { out.push(v); continue; }   // should be var(--fw-bold/normal)
		if (!ALLOWED_FW.has(v)) { out.push(v); }
	}
	return out;
}

// ── style.css ────────────────────────────────────────────────────────────────
const css = fs.readFileSync(cssPath, 'utf8');
const cssNoFace = stripFontFace(css);

const cssFsDrift = scanFontSize(cssNoFace);
ok(cssFsDrift.length === 0, 'style.css has no non-token font-size rem literals (drift: ' + JSON.stringify([...new Set(cssFsDrift)]) + ')');

const cssFwDrift = scanFontWeight(cssNoFace);
ok(cssFwDrift.length === 0, 'style.css has no non-token font-weight literals outside @font-face (drift: ' + JSON.stringify([...new Set(cssFwDrift)]) + ')');

// ── EJS views (recursively) ────────────────────────────────────────────────────
function walk(dir) {
	let files = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) { files = files.concat(walk(p)); }
		else if (e.name.endsWith('.ejs')) { files.push(p); }
	}
	return files;
}

let viewFsDrift = 0, viewFwDrift = 0;
for (const f of walk(viewsDir)) {
	const t = fs.readFileSync(f, 'utf8');
	const fsD = scanFontSize(t);
	const fwD = scanFontWeight(t);
	if (fsD.length) { viewFsDrift += fsD.length; console.log('  FAIL - ' + path.basename(f) + ' font-size literals: ' + JSON.stringify(fsD)); }
	if (fwD.length) { viewFwDrift += fwD.length; console.log('  FAIL - ' + path.basename(f) + ' font-weight literals: ' + JSON.stringify(fwD)); }
}
ok(viewFsDrift === 0, 'no view has a non-token font-size rem literal');
ok(viewFwDrift === 0, 'no view has a non-token font-weight literal');

console.log('\n' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
process.exit(failed ? 1 : 0);
