'use strict';

// closeHold.js — pure, side-effect-free decisions for closing a deal when the exchange PRICE FEED is untrusted
// (cancelOnly: a getSymbol error, or a price rejected by the plausibility guard — e.g. a delisted pair whose
// feed returns 0). Single source of truth for two questions, exercised by handleSell in DCABot.js and unit
// tested directly. No I/O, no order placement — safe to call every tick.

// Should a PENDING close be HELD because there is no trustworthy price?
//
// A close that places a REAL market order — a panic sell or a stop-loss — MUST record a genuine fill price, so
// it is held until a trustworthy price returns (never executed at a garbage price). A user CANCEL places NO
// order and sells nothing, so it needs no price and is NEVER held — it can always close out a deal, even on a
// permanently delisted / dead-feed pair. Fail-safe: a null/odd state, or anything that is not clearly a
// cancel-only condition, returns false (do not hold), so a cancel is never trapped by a malformed state.
//
// state: { cancelOnly, isDealCancel }  (extra fields ignored).
function holdCloseForUntrustedPrice(state) {

	if (!state || typeof state !== 'object') { return false; }

	const cancelOnly = state.cancelOnly === true;
	const isCancel   = state.isDealCancel === true;

	// Hold only when the price is untrusted AND this is NOT a cancel.
	return cancelOnly && !isCancel;
}

// The finalize figures for a forced CANCEL that has no trustworthy price. A cancel keeps the coins and sells
// nothing, so it is recorded as cleanly ABANDONED: nothing sold, position kept at its cost basis, ZERO realized
// P&L — never the phantom −100% that a price of 0 would derive. The recorded mark is the deal's average entry
// (break-even) when that is a positive finite number, else 0. Pure; returns a fresh object every call.
function canceledNoPriceFigures(average) {

	const avg = Number(average);
	const mark = (isFinite(avg) && avg > 0) ? avg : 0;

	return {
		'sellPriceFinal':   mark,
		'profitFinal':      0,
		'profitBaseFinal':  0,
		'profitQuoteFinal': 0,
		'qtySoldFinal':     0,
		'profitSource':     'canceled_no_price'
	};
}

module.exports = { holdCloseForUntrustedPrice, canceledNoPriceFigures };
