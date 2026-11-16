'use strict';

// SINGLE SOURCE OF TRUTH for deal pause-reason classification — shared by the BACKEND money path (which SETS a
// reason when it pauses a deal) and the FRONTEND (which DISPLAYS it: tints the row, explains the pause, warns
// before a manual resume). It lives in the backend (libs/app, which the DCA engine already depends on) and is
// handed to the browser via EJS — the header partial inlines `appData.pause_reasons` into a page global
// (window.SymBot.PAUSE_REASONS), exactly how other server data/functions reach the views. So there is ONE
// definition; neither side can carry a reason the other doesn't know.
//
// Why this exists: a new money-path pause reason (e.g. 'sell_partial_hold', #130) once shipped without a
// matching frontend entry, so the UI silently failed to recognize the pause. Routing both sides through this
// one module — and locking it with a drift test (libs/test/strategies/DCABot/systemPause.test.js) that extracts
// the reasons the engine actually sets and asserts each is defined here — makes that class of drift impossible.
//
// Pure and dependency-free (safe to require anywhere and to JSON-serialize for the page). To add a reason:
// add ONE entry here, set it in the engine via KEY.<name>, and the UI picks it up automatically.

// The taxonomy. Each entry: `side` (buy/sell label shown to the user) and `description` (plain-language reason).
// Presence in this map IS the definition of a "system" pause (one SymBot applied itself, vs a manual user pause).
var REASONS = {
	'order_verify_buy':    { side: 'buy order',  description: 'a buy order that could not be verified' },
	'buy_error':           { side: 'buy order',  description: 'a buy order error (buys are paused; the deal can still take profit or stop-loss)' },
	'buy_error_persistent':{ side: 'buy order',  description: 'a persistent buy order error (e.g. the pair is in limit-only mode); buys stay paused and are NOT retried automatically on restart — resume manually once the condition clears (the deal can still take profit, stop-loss, or be panic sold)' },
	'order_verify_sell':   { side: 'sell order', description: 'a sell order that could not be verified' },
	'sell_error':          { side: 'sell order', description: 'a sell order error (it retries automatically)' },
	'sell_error_persistent':{ side: 'sell order', description: 'a persistent sell order error (e.g. the pair is in limit-only mode); it is NOT retried automatically on restart — resume manually once the condition clears (the deal can still be stopped-out or panic sold)' },
	'sell_finalize_error': { side: 'sell order', description: 'a sell that filled but could not be finalized' },
	'sell_partial_hold':   { side: 'sell order', description: 'a slippage-safe close holding the unsold remainder below your break-even floor (it auto-resumes selling when the price recovers above the floor; use panic sell to force an exit now)' }
};

// Named key constants so the backend SETS a reason by reference (PauseReasons.KEY.SELL_ERROR) rather than a raw
// string — a typo or rename then fails fast (undefined) and cannot silently desync from this map or the UI.
var KEY = {};
Object.keys(REASONS).forEach(function (k) { KEY[k.toUpperCase()] = k; });

// The classification verdict the UI (and anything else) uses. A reason present in REASONS is a system pause;
// an empty / unknown / manual reason is not. Single definition, used by the frontend via the injected map.
function systemPauseInfo(reason) {

	var info = REASONS[reason || ''];

	return { isSystem: !!info, type: info ? info.side : '', description: info ? info.description : '' };
}

// Every reason the taxonomy defines (for the drift test and any enumeration).
function keys() { return Object.keys(REASONS); }

module.exports = { REASONS: REASONS, KEY: KEY, systemPauseInfo: systemPauseInfo, keys: keys };
