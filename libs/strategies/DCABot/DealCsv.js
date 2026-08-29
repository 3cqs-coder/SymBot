'use strict';

/**
 * DealCsv — converts processed closed deals into a DEAL-LEVEL summary CSV (one row per
 * closed deal), for spreadsheets and record-keeping.
 *
 * This is deliberately DISTINCT from TransactionExport (libs/app/TransactionExport.js):
 *  - TransactionExport emits per-TRANSACTION legs (each buy order + the sell) formatted for
 *    crypto-tax tools, and — following the Sent/Received model — never carries a sign.
 *  - DealCsv emits one row per DEAL with the figures a user reads in the Trading Journal:
 *    open/close time, duration, safety orders used, close price, and realized profit. Profit
 *    KEEPS its sign here (a losing deal must read negative), which is why this cannot reuse
 *    TransactionExport's unsigned num().
 *
 * The module is PURE and dependency-light: it maps plain processed-deal objects (the shape
 * getProcessedDeals returns) to row objects and CSV text, and does no DB or network access,
 * so it is unit-testable in isolation. The endpoint layer queries deals and streams output.
 * CSV serialization is delegated to TransactionExport.rowsToCsv (a generic, header-keyed,
 * RFC-4180-style serializer) so both exports quote fields identically.
 */

const TransactionExport = require('../../app/TransactionExport.js');

// Column order for the deal-level export. Stable — downstream sheets key on these names.
const HEADERS = [
	'Deal ID',
	'Bot',
	'Pair',
	'Opened (UTC)',
	'Closed (UTC)',
	'Duration (hours)',
	'Safety Orders',
	'Unsold',
	'Close Price',
	'Profit',
	'Profit Currency',
	'Profit %',
	'Profit (base)',
	'Mood',
	'Note'
];

// ISO 8601 UTC with a trailing Z; '' for a missing/invalid date. Reuses TransactionExport's
// implementation so both exports render timestamps identically.
function isoUtc(dateVal) { return TransactionExport.toIsoUtc(dateVal); }

// Format a number for a P&L cell: fixed decimals, period decimal, no thousands separators,
// trailing zeros trimmed, and — unlike the tax export — the SIGN PRESERVED (a loss stays
// negative). Blank for null/undefined/non-finite. Single exit.
function signedNum(val, decimals) {

	let out = '';

	if (val !== undefined && val !== null && val !== '') {

		const n = Number(val);

		if (isFinite(n)) {

			let s = n.toFixed(decimals === undefined ? 8 : decimals);

			if (s.indexOf('.') !== -1) { s = s.replace(/0+$/, '').replace(/\.$/, ''); }

			// Normalize a "-0" (e.g. -0.0000001 rounded to 0 decimals) to "0".
			out = (s === '-0') ? '0' : s;
		}
	}

	return out;
}

// Whole-hours-with-one-decimal duration between open and close. '' if either end is missing
// or the span is negative/invalid. Single exit.
function durationHours(dateStart, dateEnd) {

	let out = '';

	// Treat null/undefined/'' as MISSING before constructing a Date — note new Date(null) is a
	// VALID date (epoch 0), so without this guard a missing end would yield a huge bogus span.
	const missing = v => v === undefined || v === null || v === '';

	if (!missing(dateStart) && !missing(dateEnd)) {

		const a = (dateStart instanceof Date) ? dateStart : new Date(dateStart);
		const b = (dateEnd instanceof Date) ? dateEnd : new Date(dateEnd);
		const ta = a && a.getTime ? a.getTime() : NaN;
		const tb = b && b.getTime ? b.getTime() : NaN;

		if (isFinite(ta) && isFinite(tb) && tb >= ta) {

			out = ((tb - ta) / 3600000).toFixed(1);
		}
	}

	return out;
}

/**
 * Map one processed-deal entry (the shape getProcessedDeals returns, optionally with a
 * journal note/mood merged in) to a row object keyed by HEADERS.
 * @param {Object} d
 * @returns {Object}
 */
function dealToRow(d) {

	d = d || {};

	return {
		'Deal ID':          d.deal_id || '',
		'Bot':              d.bot_name || '',
		'Pair':             d.pair || '',
		'Opened (UTC)':     isoUtc(d.date_start),
		'Closed (UTC)':     isoUtc(d.date_end),
		'Duration (hours)': durationHours(d.date_start, d.date_end),
		'Safety Orders':    (d.safety_orders === undefined || d.safety_orders === null) ? '' : String(d.safety_orders),
		// Unsold coin on a "closed (partial)" deal; blank for a clean close so the column is unobtrusive.
		'Unsold':           ((Number(d.qty_unsold) || 0) > 0) ? signedNum(d.qty_unsold) : '',
		'Close Price':      signedNum(d.price),
		'Profit':           signedNum(d.profit),
		'Profit Currency':  d.profit_currency || '',
		'Profit %':         signedNum(d.profit_percent, 2),
		'Profit (base)':    signedNum(d.profit_base),
		'Mood':             typeof d.mood === 'string' ? d.mood : '',
		'Note':             typeof d.note === 'string' ? d.note : ''
	};
}

/**
 * Build the full CSV text for a list of processed-deal entries.
 * @param {Array<Object>} entries
 * @returns {string} CSV text (CRLF line endings, no BOM — the endpoint prepends one).
 */
function buildCsv(entries) {

	const rows = (Array.isArray(entries) ? entries : []).map(dealToRow);

	return TransactionExport.rowsToCsv(rows, { headers: HEADERS });
}

module.exports = {
	HEADERS,
	// pure helpers (exported for testing)
	signedNum,
	durationHours,
	dealToRow,
	buildCsv
};