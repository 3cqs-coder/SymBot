'use strict';

// Tests the shared confirmation-dialog builders in SymBot.UI — confirmDeleteBot / confirmToggleBot /
// confirmPanicSell — the single source of truth for the delete-bot, enable/disable and panic-sell dialogs used
// by BOTH the instance deal/bot views and the Hub views (#145 M1). Before this they were hand-copied into each
// view and drifted (one surface escaped the bot name, one didn't; the panic action was mislabeled "Close").
//
// symbot-ui.js is browser code; we stub the two globals the builders touch at call time ($.confirm captures the
// dialog config; alertBox records a message), then exercise each builder's content, button wiring and the
// confirm/cancel callbacks. No DOM: the builders' onContentReady (jQuery form binding) is not invoked here.
// Synthetic names only.

const assert = require('assert');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// ── stub the browser globals the builders use ──
global.window = global.window || {};
let captured = null;                 // the last $.confirm({...}) config
let lastAlert = null;                // the last alertBox(...) message
global.$ = function () { return { on: function () {} }; };
global.$.confirm = function (cfg) { captured = cfg; };
global.alertBox = function (m) { lastAlert = m; };

const SymBot = require('../../webserver/public/js/symbot-ui.js') || global.window.SymBot;
const ui = (SymBot && SymBot.UI) || global.window.SymBot.UI;

// The pause-reason taxonomy the real systemPauseInfo reads (normally injected via EJS); needed so
// confirmPauseDeal can render its "system paused" caution.
try { global.window.SymBot = global.window.SymBot || {}; global.window.SymBot.PAUSE_REASONS = require('../../app/pauseReasons.js').REASONS; } catch (e) {}

// A fake jquery-confirm `this` so a button `action` can read the typed input value.
function withInput(val) { return { $content: { find: function () { return { val: function () { return val; } }; } } }; }

// A fake `this` whose $content.find(selector) reports per-selector checkbox state (and optional value).
// map: { '<selector>': { checked: bool, val: string } }
function withChecks(map) {
	return { $content: { find: function (sel) { var e = map[sel] || {}; return { prop: function (p) { return e[p]; }, val: function () { return e.val; } }; } } };
}

// ── confirmDeleteBot ──
{
	let confirmed = 0, canceled = 0;
	captured = null; lastAlert = null;
	ui.confirmDeleteBot({ botName: 'ZorvBot', onConfirm: function () { confirmed++; }, onCancel: function () { canceled++; } });

	ok(captured && /Delete ZorvBot\?/.test(captured.content), 'delete dialog names the bot');
	ok(/This cannot be undone/.test(captured.content), 'delete dialog carries the irreversible warning');
	ok(/Delete Bot/.test(captured.buttons.confirm.text) && /color: var\(--color-danger\)/.test(captured.buttons.confirm.text), 'delete confirm button is danger-styled');

	// Wrong name typed → re-prompt (alertBox), onConfirm NOT called.
	const r1 = captured.buttons.confirm.action.call(withInput('wrong'));
	ok(r1 === false && confirmed === 0 && /does not match/.test(lastAlert), 'name mismatch blocks delete and alerts');
	// Correct name (with surrounding spaces, trimmed) → onConfirm fires.
	captured.buttons.confirm.action.call(withInput('  ZorvBot  '));
	ok(confirmed === 1, 'exact (trimmed) name match fires the delete action');
	// Cancel → onCancel fires.
	captured.buttons.cancel.action.call({});
	ok(canceled === 1, 'cancel fires onCancel');
}

// A bot name containing markup is HTML-escaped (both surfaces now get this; the instance view previously did not).
{
	captured = null;
	ui.confirmDeleteBot({ botName: '<img src=x onerror=alert(1)>', onConfirm: function () {} });
	ok(captured.content.indexOf('<img') === -1 && /&lt;img/.test(captured.content), 'bot name is HTML-escaped in the delete dialog (no injection)');
}

// ── confirmToggleBot ──
{
	let on = 0;
	captured = null;
	ui.confirmToggleBot({ botName: 'ZorvBot', enable: true, onConfirm: function () { on++; } });
	ok(/Enable ZorvBot\?/.test(captured.content), 'enable dialog reads "Enable <bot>?"');
	ok(/Enable Bot/.test(captured.buttons.ok.text) && /color: var\(--color-success\)/.test(captured.buttons.ok.text), 'enable button is success-styled');
	captured.buttons.ok.action.call({});
	ok(on === 1, 'OK fires onConfirm for enable');

	captured = null;
	ui.confirmToggleBot({ botName: 'ZorvBot', enable: false, onConfirm: function () {} });
	ok(/Disable ZorvBot\?/.test(captured.content), 'disable dialog reads "Disable <bot>?"');
	ok(/Disable Bot/.test(captured.buttons.ok.text) && /color: var\(--color-danger\)/.test(captured.buttons.ok.text), 'disable button is danger-styled (unified: instance now matches Hub)');
}

// ── confirmPanicSell ──
{
	let sold = 0;
	captured = null; lastAlert = null;
	ui.confirmPanicSell({ dealId: 'DEAL-7', onConfirm: function () { sold++; } });

	ok(/Panic sell deal DEAL-7 now at market price\?/.test(captured.content), 'panic dialog names the deal and says "Panic sell … at market"');
	ok(/ignores the profit target/.test(captured.content), 'panic dialog states it ignores the profit target (can realize a loss)');
	ok(/Panic Sell/.test(captured.buttons.formSubmit.text) && /color: var\(--color-danger\)/.test(captured.buttons.formSubmit.text), 'panic button is danger-styled "Panic Sell" (not "Close")');

	// Extract the required random number from the content and exercise both directions.
	const num = (captured.content.match(/Type <b>(\d{4})<\/b>/) || [])[1];
	ok(!!num, 'panic dialog shows a 4-digit confirmation number');
	const r1 = captured.buttons.formSubmit.action.call(withInput('0000' === num ? '1111' : '0000'));
	ok(r1 === false && sold === 0 && /Confirmation number incorrect/.test(lastAlert), 'wrong number blocks the panic sell and alerts');
	captured.buttons.formSubmit.action.call(withInput(num));
	ok(sold === 1, 'correct number fires the panic sell');
}

// ── confirmCancelDeal ──
{
	let confirmed = 0;
	captured = null; lastAlert = null;
	ui.confirmCancelDeal({ dealId: 'DEAL-7', onConfirm: function () { confirmed++; } });
	ok(/Cancel deal DEAL-7\?/.test(captured.content), 'cancel dialog names the deal');
	ok(/not<\/b> sold|not<\/b>\s*sold/.test(captured.content) || /are <b>not<\/b> sold/.test(captured.content), 'cancel dialog states assets already bought are NOT sold');
	// Unchecked box → blocked + alert; checked → confirm fires.
	const r = captured.buttons.formSubmit.action.call(withChecks({ '#confirmBox': { checked: false } }));
	ok(r === false && confirmed === 0 && /check the box/i.test(lastAlert), 'unchecked box blocks cancel and alerts');
	captured.buttons.formSubmit.action.call(withChecks({ '#confirmBox': { checked: true } }));
	ok(confirmed === 1, 'checked box fires the cancel action');
}

// ── confirmPauseDeal ──
{
	let got = null;
	captured = null;
	ui.confirmPauseDeal({ dealId: 'DEAL-7', pauseReason: '', onConfirm: function (pb, ps) { got = [pb, ps]; } });
	ok(/Pause \/ Resume deal DEAL-7\?/.test(captured.content), 'pause dialog names the deal');
	ok(captured.content.indexOf('System paused') === -1, 'no system-pause warning for a manual pause (empty reason)');
	// Reads both toggle states and passes them to onConfirm.
	captured.buttons.formSubmit.action.call(withChecks({ '#confirmBox': { checked: true }, '#dealPauseBuy': { checked: true }, '#dealPauseSell': { checked: false } }));
	ok(got && got[0] === true && got[1] === false, 'pause onConfirm receives (pauseBuy, pauseSell) toggle states');
	// Unchecked confirm box blocks.
	got = null; lastAlert = null;
	const r = captured.buttons.formSubmit.action.call(withChecks({ '#confirmBox': { checked: false } }));
	ok(r === false && got === null && /check the box/i.test(lastAlert), 'unchecked box blocks pause and alerts');
}
// A SYSTEM pause reason surfaces the caution block (shared systemPauseInfo → one source).
{
	captured = null;
	ui.confirmPauseDeal({ dealId: 'DEAL-7', pauseReason: 'sell_partial_hold', onConfirm: function () {} });
	ok(/System paused/.test(captured.content), 'a system pause reason shows the "System paused" caution');
}

// ── confirmStopBot ──
{
	let stopped = 0;
	captured = null;
	ui.confirmStopBot({ botName: 'ZorvBot', onConfirm: function () { stopped++; } });
	ok(/Disable ZorvBot\?/.test(captured.content) && /continue running/.test(captured.content), 'stop dialog: "Disable <bot>?" and notes deals keep running');
	ok(/Disable Bot/.test(captured.buttons.ok.text) && /color: var\(--color-danger\)/.test(captured.buttons.ok.text), 'disable button is danger-styled');
	captured.buttons.ok.action.call({});
	ok(stopped === 1, 'OK fires the stop action');
}

// ── defensive: missing callbacks must not throw (a caller may omit onCancel) ──
{
	captured = null;
	ui.confirmDeleteBot({ botName: 'ZorvBot' });
	let threw = false;
	try { captured.buttons.cancel.action.call({}); } catch (e) { threw = true; }
	ok(!threw, 'omitted onCancel is a safe no-op (never throws)');

	// Same for the new builders.
	captured = null; ui.confirmCancelDeal({ dealId: 'DEAL-7' });
	try { captured.buttons.cancel.action.call({}); } catch (e) { threw = true; }
	captured = null; ui.confirmStopBot({ botName: 'ZorvBot' });
	try { captured.buttons.cancel.action.call({}); } catch (e) { threw = true; }
	ok(!threw, 'omitted callbacks on cancel/stop builders are safe no-ops');
}

// ── confirmPauseAveraging (the managed hold) ──
{
	let confirmed = 0, canceled = 0;
	captured = null; lastAlert = null;
	ui.confirmPauseAveraging({ dealId: 'ZORVX-1', onConfirm: function () { confirmed++; }, onCancel: function () { canceled++; } });

	ok(captured && /Pause averaging on deal ZORVX-1\?/.test(captured.content), 'pause-averaging dialog names the deal');
	ok(/stop placing <b>new safety orders<\/b>/i.test(captured.content), 'pause-averaging dialog states it stops new safety orders');
	ok(/take-profit target/i.test(captured.content) && /never sells at a loss/i.test(captured.content), 'pause-averaging dialog states it still closes at the target and never at a loss');
	ok(/Resume averaging/i.test(captured.content) && /Panic sell/i.test(captured.content), 'pause-averaging dialog explains it is reversible and distinct from Panic sell');
	// Safe action — a plain confirm, NOT gated behind a random number or a checkbox like panic/cancel.
	ok(!/Type <b>/.test(captured.content), 'pause-averaging dialog has no random-number gate (safe action)');

	captured.buttons.confirm.action.call({});
	ok(confirmed === 1, 'pause-averaging confirm fires onConfirm');
	captured.buttons.cancel.action.call({});
	ok(canceled === 1, 'pause-averaging cancel fires onCancel');

	let threw = false;
	captured = null; ui.confirmPauseAveraging({ dealId: 'ZORVX-2' });
	try { captured.buttons.confirm.action.call({}); captured.buttons.cancel.action.call({}); } catch (e) { threw = true; }
	ok(!threw, 'omitted callbacks on confirmPauseAveraging are safe no-ops');
}

// ── confirmResumeAveraging ──
{
	let confirmed = 0;
	captured = null;
	ui.confirmResumeAveraging({ dealId: 'ZORVX-3', onConfirm: function () { confirmed++; } });
	ok(captured && /Resume averaging on deal ZORVX-3\?/.test(captured.content), 'resume-averaging dialog names the deal');
	ok(/safety orders on this deal again/i.test(captured.content), 'resume-averaging dialog states it re-enables safety orders');
	captured.buttons.confirm.action.call({});
	ok(confirmed === 1, 'resume-averaging confirm fires onConfirm');
}

// ── pauseAveragingResult (single-source, language-agnostic outcome message) ──
// Decides purely on success + the pause_buy boolean, so the instance and Hub grids can never word an
// outcome differently. English templates come from MESSAGES.en via t() (locale defaults to en here).
{
	const id = 'ZORVX-9';
	ok(/averaging paused/i.test(ui.pauseAveragingResult({ success: true, pause_buy: true }, id)), 'pause_buy:true → "averaging paused" message');
	ok(/resumed averaging/i.test(ui.pauseAveragingResult({ success: true, pause_buy: false }, id)), 'pause_buy:false → "resumed averaging" message');
	ok(/Unable to update/i.test(ui.pauseAveragingResult({ success: false, data: 'Deal not active' }, id)), 'failure → "Unable to update" with detail');
	// Interpolates the deal id (never a raw {id}).
	var m = ui.pauseAveragingResult({ success: true, pause_buy: true }, id);
	ok(m.indexOf(id) !== -1 && m.indexOf('{id}') === -1, 'pause-averaging message interpolates the deal id');
	// Crash-proof on an empty/absent response.
	let threw = false;
	try { ui.pauseAveragingResult(null, id); ui.pauseAveragingResult(undefined, id); } catch (e) { threw = true; }
	ok(!threw, 'pauseAveragingResult is crash-proof on null/undefined response');
}

console.log('UiConfirmDialogs: ' + passed + ' assertions passed');
process.exit(0);
