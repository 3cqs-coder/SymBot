'use strict';

// Pure assessment of whether a trading pair is still normally tradable, from a CCXT market object
// (exchange.markets[pair]) or null/undefined. Used by the delisting / suspended-pair guard (backlog #138
// Phase 1): the pre-start gate refuses to open a deal on a dying pair, and the Watchdog alerts on an OPEN
// deal whose pair is going away.
//
// Design: CONSERVATIVE and CCXT-agnostic. `market.active === false` is CCXT's universal "suspended/delisted"
// signal and is the primary basis. Limit-only / trading-disabled / a bad status string are best-effort reads
// of the raw exchange payload (`market.info`) — recognized fields only (e.g. Coinbase exposes limit_only /
// trading_disabled / status); anything unrecognized is treated as tradable so this NEVER false-alarms on an
// exchange whose metadata shape we do not know. SymBot places MARKET orders, so a limit-only pair is reported
// as not-startable (tradable:true but limitOnly:true) — the caller decides (the gate refuses, the watchdog
// alerts).
//
// Returns: { tradable, limitOnly, status, reason }.
//   tradable  — false when the pair is missing/inactive/trading-disabled (cannot trade at all).
//   limitOnly — true when the pair still trades but only accepts limit/maker orders (SymBot cannot use it).
//   status    — 'missing' | 'inactive' | 'disabled' | 'limit_only' | 'ok'.
//   reason    — a short human-readable explanation ('' when ok).

function truthy(v) {
	return v === true || v === 'true' || v === 1 || v === '1';
}

function evaluatePairTradable(market, pair) {

	const label = pair ? (pair + ' ') : '';

	if (!market) {
		return { tradable: false, limitOnly: false, status: 'missing', reason: label + 'is not listed on the exchange (removed/delisted, or the symbol changed)' };
	}

	// CCXT's universal signal. Only an explicit `false` blocks — `undefined`/`true` are treated as tradable,
	// since not every exchange populates this field (a missing value must not be read as "delisted").
	if (market.active === false) {
		return { tradable: false, limitOnly: false, status: 'inactive', reason: label + 'is marked inactive by the exchange (suspended or delisted)' };
	}

	const info = (market.info && typeof market.info === 'object') ? market.info : {};

	const statusStr = (typeof info.status === 'string') ? info.status.toLowerCase() : '';
	const badStatus = (statusStr === 'delisted' || statusStr === 'suspended' || statusStr === 'halted' || statusStr === 'cancel_only' || statusStr === 'offline');

	if (truthy(info.trading_disabled) || truthy(info.tradingDisabled) || badStatus) {
		return { tradable: false, limitOnly: false, status: 'disabled', reason: label + 'has trading disabled on the exchange' + (statusStr ? ' (status: ' + statusStr + ')' : '') };
	}

	if (truthy(info.limit_only) || truthy(info.limitOnly)) {
		return { tradable: true, limitOnly: true, status: 'limit_only', reason: label + 'is in limit-only mode on the exchange (often a pre-delisting step; SymBot places market orders, which this mode rejects)' };
	}

	return { tradable: true, limitOnly: false, status: 'ok', reason: '' };
}

module.exports = { evaluatePairTradable };
