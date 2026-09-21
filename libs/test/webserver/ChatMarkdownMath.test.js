'use strict';

// Pins SymBot.UI.plainifyMath — the pure transform that turns the LaTeX math a model sometimes emits into
// readable plain text BEFORE markdown parsing. The chat renders markdown, not LaTeX, so without this the raw
// \text{...}, \frac{...}{...} and \[ ... \] delimiters would show through as literal backslash commands.
// symbot-ui.js is browser code; it is loaded with a minimal window shim and its DOM glue stays dormant.

const assert = require('assert');

global.window = global.window || {};
require('../../webserver/public/js/symbot-ui.js');
const UI = global.window.SymBot.UI;

let passed = 0;
function eq(a, b, m) { assert.strictEqual(a, b, m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); passed++; }
function has(hay, needle, m) { assert.ok(String(hay).indexOf(needle) >= 0, m + ' (missing ' + JSON.stringify(needle) + ' in ' + JSON.stringify(hay) + ')'); passed++; }
function hasNot(hay, needle, m) { assert.ok(String(hay).indexOf(needle) < 0, m + ' (unexpected ' + JSON.stringify(needle) + ' in ' + JSON.stringify(hay) + ')'); passed++; }

console.log('\nChat markdown math normalization (plainifyMath):');

// ── display / inline delimiters ──
eq(UI.plainifyMath('\\[ x = 1 \\]').trim(), 'x = 1', 'display \\[ \\] delimiters removed, contents kept');
eq(UI.plainifyMath('\\( y = 2 \\)').trim(), 'y = 2', 'inline \\( \\) delimiters removed');
hasNot(UI.plainifyMath('$$ z = 3 $$'), '$$', 'double-dollar delimiters removed');

// ── \text and \frac ──
eq(UI.plainifyMath('\\text{New Average Price}'), 'New Average Price', '\\text{X} unwrapped to X');
has(UI.plainifyMath('\\frac{a}{b}'), '(a) / (b)', '\\frac{a}{b} becomes (a) / (b)');

// The real-world nested case from a deal-scenario answer: a fraction inside a fraction must fully resolve,
// with no backslash commands left behind.
(function () {
	const src = '\\frac{(10701 + 20000)}{(107012 + \\frac{20000}{0.1087})}';
	const out = UI.plainifyMath(src);
	hasNot(out, '\\frac', 'no \\frac command survives in a nested fraction');
	has(out, '(20000) / (0.1087)', 'the inner fraction is resolved');
	has(out, '/', 'the outer fraction is expressed as a division');
})();

// ── operators ──
has(UI.plainifyMath('a \\times b'), '\u00d7', '\\times becomes the multiplication sign');
has(UI.plainifyMath('a \\approx b'), '\u2248', '\\approx becomes the approx sign');

// ── a whole scenario line reads cleanly, with NO backslash commands left ──
(function () {
	const src = '\\[\n\\text{New Average Price} = \\frac{(A + B)}{(C)}\n\\]';
	const out = UI.plainifyMath(src);
	hasNot(out, '\\text', 'no \\text left');
	hasNot(out, '\\frac', 'no \\frac left');
	hasNot(out, '\\[', 'no \\[ left');
	hasNot(out, '\\]', 'no \\] left');
	has(out, 'New Average Price =', 'the label and equation read as plain text');
})();

// ── it must NOT disturb ordinary chat text or currency amounts ──
eq(UI.plainifyMath('The deal is up $1,234.56 today.'), 'The deal is up $1,234.56 today.', 'a single $ (currency) is untouched');
eq(UI.plainifyMath('Use a [link](./x) and a list.'), 'Use a [link](./x) and a list.', 'ordinary markdown is left intact');

console.log('\nChatMarkdownMath: \u2713 ' + passed + ' passed\n');
