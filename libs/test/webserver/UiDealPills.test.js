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
['add', 'ai', 'cancel', 'pause_averaging', 'resume_averaging', 'edit', 'panic', 'pause', 'resume', 'stop'].forEach(function (k) {
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
eq(btns['pause_averaging'].button,  pill('', 'icon-target', 'Pause averaging'),  'pause_averaging pill markup (neutral-styled + target icon: the managed hold, distinct from the red Panic Sell)');
eq(btns['resume_averaging'].button, pill('pill-averaging', 'icon-resume', 'Resume averaging'), 'resume_averaging pill markup (persistent amber pill-averaging background: the button itself signals the paused-averaging state when it swaps in)');
eq(btns['panic'].button,  pill('pill-danger', 'icon-close',  'Panic sell deal'),   'panic pill markup (danger-styled + honest label: it fires panic_sell, not a graceful close)');
eq(btns['pause'].button,  pill('pill-warn',   'icon-pause',  'Pause deal'),        'pause pill markup');
eq(btns['resume'].button, pill('pill-warn',   'icon-resume', 'Resume deal'),       'resume pill markup');
eq(btns['stop'].button,   pill('pill-danger', 'icon-stop',   'Stop bot'),          'stop pill markup');

// Tooltips match the labels the views show on hover.
eq(btns['cancel'].tooltip, 'Cancel deal', 'cancel tooltip');
eq(btns['stop'].tooltip,   'Stop bot',    'stop tooltip');
// The panic pill's title (what the deal views key their click dispatch off) must stay 'Panic sell deal', and its
// hover tooltip must spell out that it ignores the profit target — the honest-labeling safety fix for a control
// that sells at market and can realize a loss. The dispatch match lives in both deal views (btnTitle === ...).
ok(/title="Panic sell deal"/.test(btns['panic'].button), 'panic pill title is the exact string the deal views dispatch on');
ok(/title="Pause averaging"/.test(btns['pause_averaging'].button), 'pause_averaging pill title is the exact string the deal views dispatch on');
ok(/title="Resume averaging"/.test(btns['resume_averaging'].button), 'resume_averaging pill title is the exact string the deal views dispatch on');
ok(!/pill-danger/.test(btns['pause_averaging'].button), 'pause_averaging pill is NOT danger-styled — it is the profit-respecting managed hold, visually distinct from Panic Sell');
ok(/ignoring the profit target/.test(btns['panic'].tooltip), 'panic tooltip states it ignores the profit target');

// A fresh call returns a fresh object (a view mutates its local copy, e.g. swapping pause→resume or disabling
// stop), so the factory must not hand out a shared singleton that one view's edits would leak into another.
ok(UI.actionButtons() !== btns, 'actionButtons() returns a fresh object each call (no shared mutable singleton)');

// ── dealRowBackground() ──────────────────────────────────────────────────────────
eq(UI.dealRowBackground({ hasDataError: true }),                          'rgba(183,130,37,0.28)', 'data error → amber');
eq(UI.dealRowBackground({ isSystemPaused: true }),                        'rgba(255,140,0,0.22)',  'system pause → orange');
eq(UI.dealRowBackground({ hasDataError: true, isSystemPaused: true }),    'rgba(183,130,37,0.28)', 'data error WINS over system pause');
eq(UI.dealRowBackground({}),                                             '', 'normal row → no tint');
eq(UI.dealRowBackground(),                                               '', 'no opts → no tint (safe)');

// ── severityClass() / severityClassList() — the single-source 90/70 cutoffs ──────────────────────────────
eq(UI.severityClass(95, 'portfolio-risk'), 'portfolio-risk-high', '>= 90 → high');
eq(UI.severityClass(90, 'portfolio-risk'), 'portfolio-risk-high', 'exactly 90 → high (inclusive)');
eq(UI.severityClass(75, 'portfolio-risk'), 'portfolio-risk-mid',  'between 70 and 90 → mid');
eq(UI.severityClass(70, 'portfolio-risk'), 'portfolio-risk-mid',  'exactly 70 → mid (inclusive)');
eq(UI.severityClass(10, 'portfolio-risk'), 'portfolio-risk-low',  'below 70 → low');
// Non-numeric / missing → low tier (never a false "high").
eq(UI.severityClass(null, 'portfolio-risk'),      'portfolio-risk-low', 'null → low');
eq(UI.severityClass(undefined, 'portfolio-risk'), 'portfolio-risk-low', 'undefined → low');
eq(UI.severityClass(NaN, 'portfolio-risk'),       'portfolio-risk-low', 'NaN → low');
// The health-load family labels the middle tier "med" (not "mid") — overridable labels keep one cutoff source.
const medLabels = { high: 'high', mid: 'med', low: 'low' };
eq(UI.severityClass(95, 'health-load', { labels: medLabels }), 'health-load-high', 'health-load high');
eq(UI.severityClass(75, 'health-load', { labels: medLabels }), 'health-load-med',  'health-load mid → "med"');
eq(UI.severityClass(10, 'health-load', { labels: medLabels }), 'health-load-low',  'health-load low');
// Custom cutoffs.
eq(UI.severityClass(60, 'x', { high: 80, mid: 50 }), 'x-mid', 'custom cutoffs honored');
// The removeClass list matches the class names the helper can return (no drift).
eq(UI.severityClassList('portfolio-risk'), 'portfolio-risk-high portfolio-risk-mid portfolio-risk-low', 'class list (default labels)');
eq(UI.severityClassList('health-load', medLabels), 'health-load-high health-load-med health-load-low', 'class list (med labels)');

// ── formatMoney() — the i18n money seam ──────────────────────────────────────────────────────────────
// Default (no locale) reproduces today's output EXACTLY, so migrating a call site is a no-op visually.
eq(UI.formatMoney(1234.5, { symbol: '$' }),  '$1234.50', 'default: symbol-prefixed, 2 dp, no grouping (unchanged)');
eq(UI.formatMoney(1234.5, { symbol: '€' }),  '€1234.50', 'default: honors the passed symbol');
eq(UI.formatMoney(0, { symbol: '$' }),       '$0.00',    'default: zero');
eq(UI.formatMoney(-12.3, { symbol: '$' }),   '$-12.30',  'default: negative (same as symbol + toFixed)');
eq(UI.formatMoney(null, { symbol: '$' }),    '$0.00',    'null → 0.00 (never NaN)');
eq(UI.formatMoney(NaN, { symbol: '$' }),     '$0.00',    'NaN → 0.00 (never NaN)');
eq(UI.formatMoney('19.9', { symbol: '$' }),  '$19.90',   'numeric string coerced');
eq(UI.formatMoney(5, {}),                    '$5.00',    'no symbol → default $ fallback (matches old hard-coded fallback)');
eq(UI.formatMoney(5.126, { symbol: '$', decimals: 3 }), '$5.126', 'decimals override');
// With a locale + currency code it localizes via Intl (symbol position + separators). Assert the DIGITS
// localize (grouping separator appears); exact symbol glyph varies by environment ICU data, so match loosely.
{
	const de = UI.formatMoney(1234.5, { locale: 'de-DE', code: 'EUR' });
	ok(/1\.234,50/.test(de), 'de-DE EUR groups with "." and decimals with "," (locale-aware): ' + de);
	const us = UI.formatMoney(1234.5, { locale: 'en-US', code: 'USD' });
	ok(/\$?1,234\.50/.test(us), 'en-US USD groups with "," : ' + us);
}
// A bad locale/currency falls back to the plain format rather than throwing.
eq(UI.formatMoney(5, { symbol: '$', locale: 'en-US', code: 'NOT_A_CODE' }), '$5.00', 'bad currency code → safe plain fallback');

// ── t() / interpolate() / plural() — the i18n message seam ───────────────────────────────────────────────
eq(UI.interpolate('{name} is now {status}', { name: 'ZorvBot', status: 'enabled' }), 'ZorvBot is now enabled', 'interpolate substitutes placeholders');
eq(UI.interpolate('no placeholders', {}), 'no placeholders', 'interpolate passes plain text through');
eq(UI.interpolate('{missing}', {}), '{missing}', 'interpolate leaves an unprovided placeholder intact (visible, debuggable)');
eq(UI.interpolate(null), '', 'interpolate(null) → empty string (never throws)');

eq(UI.t('bot.now_status', { name: 'ZorvBot', status: UI.t('bot.status.enabled') }), 'ZorvBot is now enabled', 't composes the migrated enable toast (English unchanged)');
eq(UI.t('bot.toggled', { name: 'ZorvBot', status: UI.t('bot.status.disabled') }), 'ZorvBot disabled', 't composes the Hub toggle toast');
eq(UI.t('deal.canceled', { id: 'DEAL-7' }), 'Deal DEAL-7 canceled', 't composes the deal-canceled toast');
eq(UI.t('deal.panic_requested', { id: 'DEAL-7' }), 'Deal DEAL-7 panic sell requested', 't composes the panic toast');
eq(UI.t('bot.deleted', { name: 'ZorvBot' }), 'Bot "ZorvBot" and all deal history deleted.', 't composes the delete toast');
eq(UI.t('bot.status_unknown'), 'Unable to change bot status', 't resolves a no-param message');
// An unknown key returns the key itself — never a blank string — so a missing message is visible, not silent.
eq(UI.t('nonexistent.key'), 'nonexistent.key', 'unknown message key → the key (visible fallback)');
// Every message the views now reference must exist in the table (no silent key fallthrough in production).
['bot.status.enabled','bot.status.disabled','bot.now_status','bot.toggled','bot.status_unknown','bot.deleted','deal.canceled','deal.panic_requested'].forEach(function(k){
	ok(UI.MESSAGES.en[k] != null, 'message table defines "' + k + '"');
});

// plural(): correct CLDR category per locale via Intl.PluralRules, with {count} interpolated.
eq(UI.plural(1, { one: '{count} bot', other: '{count} bots' }), '1 bot', 'plural: 1 → one');
eq(UI.plural(2, { one: '{count} bot', other: '{count} bots' }), '2 bots', 'plural: 2 → other');
eq(UI.plural(0, { one: '{count} bot', other: '{count} bots' }), '0 bots', 'plural: 0 → other (en)');
eq(UI.plural(5, { other: '{count} deals' }), '5 deals', 'plural: falls back to other when a category form is absent');

console.log('UiDealPills: ' + passed + ' assertions passed');
process.exit(0);
