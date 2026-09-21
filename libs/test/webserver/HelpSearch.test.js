'use strict';

// Pins the pure, DOM-free helpers behind the in-app guide (Help panel) — the parts that have regressed before
// and would silently break navigation or search if they drifted:
//   * SymBot.UI.helpSlugger()    — GitHub-compatible heading slugger (must match GitHub or a doc's own TOC
//                                  links fail to jump). Covers the "&"→double-hyphen case and repeat de-dupe.
//   * SymBot.UI.helpFlexPattern()— space/hyphen-flexible, regex-safe search pattern source (phrase matching and
//                                  the multi-word fallback both build on it).
// symbot-ui.js is browser code, so it is loaded with a minimal window shim; its Help DOM glue is guarded behind
// `typeof document === 'undefined'` and never runs here, while these helpers live on SymBot.UI and always load.

const assert = require('assert');

global.window = global.window || {};
require('../../webserver/public/js/symbot-ui.js');
const UI = global.window.SymBot.UI;

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function eq(a, b, m) { assert.strictEqual(a, b, m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); passed++; }

// ── helpSlugger: GitHub-compatible ids ────────────────────────────────────────
(function () {
	const slug = UI.helpSlugger();

	eq(slug('Requirements'), 'requirements', 'single word lowercased');
	eq(slug('Understanding SymBot'), 'understanding-symbot', 'spaces become hyphens');

	// The regression that started this: a removed "&" leaves two spaces, which GitHub renders as a DOUBLE hyphen.
	// The TOC link is #access-control-users-api-keys--audit, so the id must match exactly.
	eq(slug('Access Control (Users, API Keys & Audit)'), 'access-control-users-api-keys--audit',
		'removed "&" between spaces yields a double hyphen (matches GitHub / the doc TOC link)');

	eq(slug('Stop-Loss'), 'stop-loss', 'existing hyphens are kept');
	eq(slug('  Trailing   Stop  '), 'trailing---stop', 'trimmed; each interior space is its own hyphen');
	eq(slug('Reset or Configure SymBot?'), 'reset-or-configure-symbot', 'trailing punctuation stripped');
})();

// De-dupe: repeated headings get -1, -2 … (the first keeps the bare slug), so several same-named sections
// (this README has multiple "Configuration" sections) still produce unique, resolvable ids.
(function () {
	const slug = UI.helpSlugger();
	eq(slug('Configuration'), 'configuration', 'first occurrence keeps the bare slug');
	eq(slug('Configuration'), 'configuration-1', 'second occurrence gets -1');
	eq(slug('Configuration'), 'configuration-2', 'third occurrence gets -2');
	eq(slug('Other'), 'other', 'an unrelated heading is unaffected by the counter');
	eq(slug('Configuration'), 'configuration-3', 'the counter continues for the repeated base');
})();

// Each slugger instance is independent (counters reset per render, so re-opening the guide is deterministic).
(function () {
	const a = UI.helpSlugger(), b = UI.helpSlugger();
	eq(a('Dupe'), 'dupe', 'slugger A first is bare');
	eq(a('Dupe'), 'dupe-1', 'slugger A second is -1');
	eq(b('Dupe'), 'dupe', 'slugger B is independent — its first is bare, not -2');
})();

// Null / undefined are safe (both normalize to the empty base; a fresh slugger confirms each yields '').
eq(UI.helpSlugger()(null), '', 'null → empty slug');
eq(UI.helpSlugger()(undefined), '', 'undefined → empty slug');
(function () {
	const slug = UI.helpSlugger();
	eq(slug(''), '', 'first empty base is bare');
	eq(slug(null), '-1', 'a second empty-base heading dedupes to -1 rather than colliding');
})();

// ── helpFlexPattern: space/hyphen-flexible, regex-safe search ──────────────────
function matchCount(patternSrc, text) { return (text.match(new RegExp(patternSrc, 'gi')) || []).length; }

(function () {
	const p = UI.helpFlexPattern('take profit');
	ok(new RegExp(p, 'i').test('take profit'), 'phrase matches the spaced form');
	ok(new RegExp(p, 'i').test('take-profit'), 'phrase matches the hyphenated form');
	ok(new RegExp(p, 'i').test('TAKE   PROFIT'), 'case-insensitive and tolerant of multiple spaces');
	ok(!new RegExp(p, 'i').test('profit take'), 'phrase is contiguous — reversed words do NOT match');
})();

// Global matching finds EVERY occurrence (the search counts and highlights all of them).
eq(matchCount(UI.helpFlexPattern('order'), 'order Order ORDER not-ordered'), 4, 'global/case-insensitive counts all occurrences');
eq(matchCount(UI.helpFlexPattern('safety order'), 'a safety order and a safety-order here'), 2, 'phrase counts both spacing variants');

// Regex metacharacters in a query are escaped (matched literally, never throwing).
(function () {
	let threw = false; try { new RegExp(UI.helpFlexPattern('c++ (v2)'), 'gi'); } catch (e) { threw = true; }
	ok(!threw, 'a query with regex metacharacters compiles without throwing');
	eq(matchCount(UI.helpFlexPattern('a|b'), 'a|b a b'), 1, '"a|b" is matched literally, not as the alternation a OR b');
	eq(matchCount(UI.helpFlexPattern('c++'), 'c++ code and c code'), 1, '"c++" matches literally once');
})();

// The multi-word fallback: split into terms, each flex-escaped, combined as an alternation — matches ANY word,
// so a near-miss (wrong order, extra word) still surfaces matches when the exact phrase found none.
(function () {
	const terms = 'trailing stop-loss'.split(/\s+/).map(UI.helpFlexPattern);
	const rxSrc = terms.join('|');
	eq(matchCount(rxSrc, 'the trailing feature and the stop loss guard'), 2, 'fallback matches each word independently (incl. hyphen/space flex)');
	ok(new RegExp(rxSrc, 'i').test('stop loss'), 'fallback term "stop-loss" also matches the spaced "stop loss"');
})();

console.log('HelpSearch: ' + passed + ' assertions passed');
