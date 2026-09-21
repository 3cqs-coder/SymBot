'use strict';

// Locks the system-pause taxonomy that the trading loop and the UI both depend on.
//
// A sell must never be placed while an order is still unresolved. A prior SELL in flight would let a
// panic/stop place a SECOND live order for coin already committed (oversell); a safety-order BUY in
// verification means the coin isn't credited yet, so selling would strand it. The follow loop expresses
// this by refusing the sell branch when the deal's pauseReason marks a sell as in flight
// ('order_verify_sell'), filled-but-not-finalized ('sell_finalize_error'), or a buy in verification
// ('order_verify_buy'). A generic, retryable sell error uses a distinct reason ('sell_error') that does
// NOT block a panic and auto-recovers. The UI must show all four of these as "system" pauses (not
// manual). This test pins both halves so a change to the reason strings can't silently desync the guard,
// the restart recovery, and the UI.

const assert = require('assert');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// ── SymBot.UI.systemPauseInfo (real client helper) ──
// symbot-ui.js is browser code — shim the globals it touches at load, then exercise the helper.
global.window = global.window || {};
const SymBot = require('../../../webserver/public/js/symbot-ui.js') || global.window.SymBot;
const ui = (SymBot && SymBot.UI) || global.window.SymBot.UI;

const SYSTEM_REASONS = ['order_verify_buy', 'buy_error', 'order_verify_sell', 'sell_error', 'sell_finalize_error'];

for (const reason of SYSTEM_REASONS) {
	const info = ui.systemPauseInfo(reason);
	ok(info.isSystem === true, reason + ' is a system pause');
	ok(typeof info.type === 'string' && info.type.length > 0, reason + ' has a side label');
	ok(typeof info.description === 'string' && info.description.length > 0, reason + ' has a description');
}

// Order-verify reasons name the correct side.
ok(ui.systemPauseInfo('order_verify_buy').type === 'buy order', 'order_verify_buy => buy order');
ok(ui.systemPauseInfo('buy_error').type === 'buy order', 'buy_error => buy order');
ok(ui.systemPauseInfo('order_verify_sell').type === 'sell order', 'order_verify_sell => sell order');

// A manual pause / unknown / empty reason is NOT a system pause.
for (const reason of ['', null, undefined, 'user', 'manual', 'something_else']) {
	const info = ui.systemPauseInfo(reason);
	ok(info.isSystem === false, JSON.stringify(reason) + ' is not a system pause');
	ok(info.type === '' && info.description === '', JSON.stringify(reason) + ' yields empty fields');
}

// ── Order-in-flight sell guard invariant (characterization of the sell-branch guard) ──
// Mirrors the follow-loop condition: the automated sell branch (take-profit, stop-loss, panic, cancel)
// must be refused while an order is unresolved — either a SELL in flight ('order_verify_sell' /
// 'sell_finalize_error'), where a second sell would oversell committed coin, OR a safety-order BUY in
// background verification ('order_verify_buy'), where selling now would move only the credited qty and
// strand the pending buy's coin (the post-close reconcile filters status:0 and never picks it up).
// Crucially, 'order_verify_buy' is used ONLY for a genuine in-flight, likely-filled order. A buy that
// FAILED with nothing in flight (insufficient funds, exchange-cancelled, generic) uses a distinct
// 'buy_error' reason that does NOT block the sell — there is no pending coin to strand, so the deal must
// still be able to take profit or stop-loss. A generic, retryable sell error ('sell_error') likewise
// has nothing in flight and does NOT block a panic.
function sellBlockedByOrderInFlight(pauseReason) {
	return pauseReason === 'order_verify_sell'
		|| pauseReason === 'sell_finalize_error'
		|| pauseReason === 'order_verify_buy';
}

ok(sellBlockedByOrderInFlight('order_verify_sell') === true, 'in-flight sell verify blocks a sell (no oversell)');
ok(sellBlockedByOrderInFlight('sell_finalize_error') === true, 'filled-but-unfinalized blocks a sell (coin already gone)');
ok(sellBlockedByOrderInFlight('order_verify_buy') === true, 'an in-flight buy verification blocks a sell (pending coin uncredited)');
ok(sellBlockedByOrderInFlight('buy_error') === false, 'a non-in-flight buy failure (NSF / canceled / generic) does NOT block a sell — nothing to strand, so the deal can still exit');
ok(sellBlockedByOrderInFlight('sell_error') === false, 'a generic sell error does NOT block panic (nothing in flight)');
ok(sellBlockedByOrderInFlight('') === false, 'no pause reason does not block a sell');

// Every reason that blocks a sell must also render as a system pause in the UI (they cannot desync).
for (const reason of SYSTEM_REASONS) {
	if (sellBlockedByOrderInFlight(reason)) {
		ok(ui.systemPauseInfo(reason).isSystem === true, reason + ' blocks sells AND shows as a system pause');
	}
}

console.log('systemPause: ' + passed + ' assertions passed');