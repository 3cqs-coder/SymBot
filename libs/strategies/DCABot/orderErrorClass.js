'use strict';

// orderErrorClass.js — single source of truth for deciding whether an order-placement error is
// PERSISTENT (the exchange will keep rejecting the same market order until an operator or the exchange
// changes something) or transient/unknown.
//
// Used by the resume path (#129): a deal paused with a generic buy_error / sell_error records the raw
// exchange message plus this classification. On restart, resumeDeal keeps the pause for a PERSISTENT
// error instead of clearing it and re-attempting a doomed order every restart; a transient or unknown
// error clears and resumes exactly as before.
//
// Conservative by construction — the whole point is to NEVER strand a deal paused on a false positive:
//   • Returns true ONLY for well-known, operator-actionable persistent conditions.
//   • Everything else, including anything it does not recognize, returns false → the caller fails safe
//     to the existing clear-and-resume behavior (no regression).
//
// Language-agnostic: it matches stable exchange error vocabulary (lower-cased substrings), not any
// localized SymBot UI text, so it behaves the same regardless of locale. Pure: text in, boolean out.

// Each entry is a condition a quick restart cannot resolve. Kept deliberately narrow. These are the
// exchange-side signatures seen across the venues the bot drives (market order placed on a pair that
// has gone limit-only / post-only, been suspended or delisted, or rejected the market order type).
const PERSISTENT_PATTERNS = [
	'limit only',
	'limit_only',
	'limit-only',
	'post only',
	'post_only',
	'market orders are not',       // "market orders are not supported/allowed on this pair"
	'market order is not',
	'market order is disabled',
	'market orders disabled',
	'order type not supported',
	'invalid order type',
	'invalid_argument',            // e.g. an unsupported order configuration rejected outright
	'not tradable',
	'not currently tradable',
	'trading is suspended',
	'trading suspended',
	'symbol is not trading',
	'is not trading',
	'delisted',
	'has been removed'
];

// isPersistentOrderError(text) → true only for a recognized persistent condition; false otherwise
// (including null/empty/unknown). Single exit.
function isPersistentOrderError(text) {

	let persistent = false;

	if (text !== null && text !== undefined) {

		const s = String(text).toLowerCase();

		if (s !== '') {

			for (let i = 0; i < PERSISTENT_PATTERNS.length; i++) {

				if (s.indexOf(PERSISTENT_PATTERNS[i]) !== -1) {

					persistent = true;
					break;
				}
			}
		}
	}

	return persistent;
}

module.exports = { isPersistentOrderError, PERSISTENT_PATTERNS };
