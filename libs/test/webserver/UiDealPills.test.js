'use strict';

// Pins the two shared deal-row helpers that were unified out of the instance Active Deals view and the Hub
// Deals view so those two surfaces can never drift again:
//   * actionButtons()      — the deal action pills (add/ai/cancel/edit/panic/pause/resume/stop). Both views
//     had carried their own byte-identical copy of this markup; they now render from this one factory. This
//     test locks the exact markup (class, role, tabindex, aria-label, title, icon, danger/warn variants) so a
//     change here is a deliberate, reviewed change and not accidental drift.
//   * dealRowBackground()  — the translucent row tint. A confirmed data/tracker error (amber) must win over a
//     system pause (orange); a normal row is untinted. The Hub view previously lacked the data-error tint
//     entirely, so this pins the shared precedence both views now use.
// symbot-ui.js is browser code, so it is loaded with a minimal window shim (its jQuery/DOM calls are all
// inside functions, never at load time).

const assert = require('assert');

global.window = global.window || {};
require('../../webserver/public/js/symbot-ui.js');
const UI = global.window.SymBot.UI;

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function eq(a, b, m) { assert.strictEqual(a, b, m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); passed++; }

// ── actionButtons() ────────────────────────────────────────────────────────────
const btns = UI.actionButtons();

// Every key a view addresses by name must be present.
['add', 'ai', 'cancel', 'edit', 'panic', 'pause', 'resume', 'stop'].forEach(function (k) {
	ok(btns[k] && typeof btns[k].button === 'string' && typeof btns[k].tooltip === 'string', 'actionButtons has key "' + k + '" with button + tooltip');
});

// Exact markup — this is the byte-identity contract shared by both deal views.
function pill(cls, icon, label) {
	return '<span class="pill-btn' + (cls ? ' ' + cls : '') + '" role="button" tabindex="0" aria-label="' + label + '" title="' + label + '">'
		+ '<span class="icon ' + icon + '" style="width:13px;height:13px;pointer-events:none;"></span></span>';
}

eq(btns['add'].button,    pill('',            'icon-add',    'Add funds to deal'), 'add pill markup');
eq(btns['ai'].button,     pill('',            'icon-ai',     'AI Analyze deal'),   'ai pill markup');
eq(btns['cancel'].button, pill('pill-danger', 'icon-cancel', 'Cancel deal'),       'cancel pill markup');
eq(btns['edit'].button,   pill('',            'icon-edit',   'Edit deal'),         'edit pill markup');
eq(btns['panic'].button,  pill('',            'icon-close',  'Close deal'),        'panic pill markup');
eq(btns['pause'].button,  pill('pill-warn',   'icon-pause',  'Pause deal'),        'pause pill markup');
eq(btns['resume'].button, pill('pill-warn',   'icon-resume', 'Resume deal'),       'resume pill markup');
eq(btns['stop'].button,   pill('pill-danger', 'icon-stop',   'Stop bot'),          'stop pill markup');

// Tooltips match the labels the views show on hover.
eq(btns['cancel'].tooltip, 'Cancel deal', 'cancel tooltip');
eq(btns['stop'].tooltip,   'Stop bot',    'stop tooltip');

// A fresh call returns a fresh object (a view mutates its local copy, e.g. swapping pause→resume or disabling
// stop), so the factory must not hand out a shared singleton that one view's edits would leak into another.
ok(UI.actionButtons() !== btns, 'actionButtons() returns a fresh object each call (no shared mutable singleton)');

// ── dealRowBackground() ──────────────────────────────────────────────────────────
eq(UI.dealRowBackground({ hasDataError: true }),                          'rgba(183,130,37,0.28)', 'data error → amber');
eq(UI.dealRowBackground({ isSystemPaused: true }),                        'rgba(255,140,0,0.22)',  'system pause → orange');
eq(UI.dealRowBackground({ hasDataError: true, isSystemPaused: true }),    'rgba(183,130,37,0.28)', 'data error WINS over system pause');
eq(UI.dealRowBackground({}),                                             '', 'normal row → no tint');
eq(UI.dealRowBackground(),                                               '', 'no opts → no tint (safe)');

console.log('UiDealPills: ' + passed + ' assertions passed');
process.exit(0);
