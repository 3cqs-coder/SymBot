'use strict';

/**
 * TransactionExport — converts stored SymBot deals into per-transaction rows formatted
 * for consumer crypto-tax tools (Koinly Universal template; CoinTracker /
 * CoinLedger consume near-identical Sent/Received-model files).
 *
 * DESIGN:
 *  - Export TRANSACTIONS ONLY. Never compute gains / cost basis / tax. Tax tools
 *    do their own lot-matching, and SymBot structurally cannot know true cost
 *    basis anyway: it only sees its own deals, not the whole account (manual
 *    trades, transfers, other bots), and tax rules — cost-basis method, per-wallet
 *    vs pooled tracking, what counts as a disposal — vary by country and change
 *    over time. Exporting raw transactions and letting the user's tax software
 *    apply their jurisdiction's rules is the only correct approach worldwide.
 *  - One row per filled buy order + one row per closed deal's sell.
 *  - Fees come from SymBot's own per-order accounting (config.exchangeFee %,
 *    frozen per deal): buy fee from orderMetadata.exchange_fee_amount (quote);
 *    sell fee derived from feeData.exchangeFeePercent x gross proceeds.
 *  - Sell uses GROSS proceeds + explicit fee (representation A) — never net+fee.
 *
 * This module is PURE and dependency-free: it transforms plain deal objects into
 * row objects and CSV text. It performs no DB or network access, so it can be
 * unit-tested in isolation. The endpoint layer is responsible for querying deals
 * and streaming the output.
 */

// Koinly Universal header, exact order. CoinTracker/CoinLedger accept the same
// Sent/Received model with minor header renames handled by a future format param.
const KOINLY_HEADERS = [
	'Date',
	'Sent Amount',
	'Sent Currency',
	'Received Amount',
	'Received Currency',
	'Fee Amount',
	'Fee Currency',
	'Net Worth Amount',
	'Net Worth Currency',
	'Label',
	'Description',
	'TxHash'
];

// ── helpers ────────────────────────────────────────────────────────────────

// Split a SymBot pair ("GWEI/USD") into { base, quote }. Falls back gracefully.
function splitPair(pair) {

	const p = (typeof pair === 'string' ? pair : '');
	const parts = p.split('/');

	return { base: parts[0] || '', quote: parts[1] || '' };
}

// ISO 8601 UTC with a trailing Z, e.g. 2026-07-25T04:10:00Z. Tax tools require
// UTC; emitting Z-suffixed ISO is the safest form for Koinly. Returns '' if the
// date is missing/invalid rather than throwing.
function toIsoUtc(dateVal) {

	if (dateVal === undefined || dateVal === null || dateVal === '') { return ''; }

	const d = (dateVal instanceof Date) ? dateVal : new Date(dateVal);

	if (isNaN(d.getTime())) { return ''; }

	// Strip milliseconds for cleaner output; keep the Z (UTC).
	return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Format a number for CSV: fixed-ish decimal string, no thousands separators,
// period decimal, never negative (direction is expressed by column, not sign),
// blank for null/undefined/non-finite. Trims trailing zeros but keeps precision.
function num(val) {

	if (val === undefined || val === null || val === '') { return ''; }

	let n = Number(val);

	if (!isFinite(n)) { return ''; }

	// No negatives in the Sent/Received model.
	n = Math.abs(n);

	if (n === 0) { return '0'; }

	// Standard crypto precision is 8 decimals. If a real (non-zero) value would
	// round to 0 at 8 decimals, keep enough precision that it doesn't silently
	// vanish from the file — extend up to 18 decimals for very small amounts.
	let decimals = 8;

	if (n < 1e-8) {

		decimals = 18;
	}

	// toFixed avoids scientific notation (e.g. "1e-8"), which tax tools reject.
	let s = n.toFixed(decimals);

	// Trim trailing zeros (and a trailing dot), but never back to empty.
	if (s.indexOf('.') !== -1) {

		s = s.replace(/0+$/, '').replace(/\.$/, '');
	}

	return s === '' ? '0' : s;
}

// Derive the per-buy-order fee in QUOTE currency. Prefer the persisted
// orderMetadata.exchange_fee_amount (SymBot's own per-order accounting). Fall
// back to amount x (exchangeFee/100) for legacy deals that predate orderMetadata.
function buyFeeQuote(order, exchangeFeePercent) {

	const meta = order && order.orderMetadata;

	if (meta && meta.exchange_fee_amount !== undefined && meta.exchange_fee_amount !== null && meta.exchange_fee_amount !== '') {

		return Number(meta.exchange_fee_amount);
	}

	// Legacy fallback: derive from the order amount and the deal's fee %.
	const amount = Number(order && order.amount);
	const feePct = Number(exchangeFeePercent);

	if (isFinite(amount) && isFinite(feePct)) {

		return amount * (feePct / 100);
	}

	return null;
}

// ── row builders ───────────────────────────────────────────────────────────

/**
 * Build the row objects for a single stored deal.
 * @param {Object} deal - a stored deal: { dealId, config, orders, sellData, ... }
 * @param {Object} [opts]
 * @param {boolean} [opts.includeSandbox=false] - if false, sandbox deals yield no rows.
 * @returns {Array<Object>} array of row objects keyed by KOINLY_HEADERS.
 */
function buildDealRows(deal, opts) {

	opts = opts || {};

	const includeSandbox = opts.includeSandbox === true;

	if (!deal || typeof deal !== 'object') { return []; }

	const config = deal.config || {};
	const pair = config.pair || (deal.sellData && deal.sellData.pair) || '';
	const { base, quote } = splitPair(pair);
	const botName = config.botName || '';
	const dealId = deal.dealId || '';
	const exchangeFeePercent = Number(config.exchangeFee);

	// Never emit sandbox deals into a tax file unless explicitly asked.
	if (config.sandBox === true && !includeSandbox) { return []; }

	const rows = [];

	// ── BUY rows: one per FILLED buy order, ordered by fill time ──────────────
	const orders = Array.isArray(deal.orders) ? deal.orders : [];

	const filledBuys = orders
		.filter(o => o && o.filled)
		.slice()
		.sort((a, b) => {
			const da = new Date(a.dateFilled || 0).getTime();
			const db = new Date(b.dateFilled || 0).getTime();
			return da - db;
		});

	filledBuys.forEach(order => {

		const feeQuote = buyFeeQuote(order, exchangeFeePercent);
		const label = order.orderNo === 1 ? 'Base Order' : ('Safety Order ' + (order.orderNo - 1));

		rows.push({
			'Date':               toIsoUtc(order.dateFilled),
			'Sent Amount':        num(order.amount),   // quote spent
			'Sent Currency':      quote,
			'Received Amount':    num(order.qty),      // base received
			'Received Currency':  base,
			'Fee Amount':         num(feeQuote),
			'Fee Currency':       feeQuote !== null && feeQuote !== undefined ? quote : '',
			'Net Worth Amount':   '',
			'Net Worth Currency': '',
			'Label':              '',                  // leave blank -> tool treats as Trade
			'Description':        'SymBot ' + botName + ' ' + label + ' deal ' + dealId,
			'TxHash':             order.orderId || ''
		});
	});

	// ── SELL row: one per closed deal (aggregate) ────────────────────────────
	const sellData = deal.sellData;

	if (sellData && sellData.date) {

		const feeData = sellData.feeData || {};
		const sellFeePct = Number(feeData.exchangeFeePercent !== undefined ? feeData.exchangeFeePercent : exchangeFeePercent);

		// Disposed quantity (base). Prefer qtySold; fall back to qtySum (the total
		// position) if qtySold wasn't stored.
		let qtyDisposed = Number(sellData.qtySold);

		if (!isFinite(qtyDisposed) || qtyDisposed <= 0) {

			const qtySum = Number(sellData.qtySum);
			qtyDisposed = (isFinite(qtySum) && qtySum > 0) ? qtySum : null;
		}

		// Gross proceeds (representation A). Prefer the actual figure from fills;
		// when the exchange returned no usable fill data at sell time, SymBot
		// stores proceeds as null — reconstruct it from the sell price and the
		// disposed quantity so a real sale never shows blank proceeds in a tax
		// file. Fall back through the sell-price-based estimates that are still
		// authoritative (never avg entry, which would misstate proceeds).
		let proceeds = sellData.proceeds;

		if (proceeds === undefined || proceeds === null || proceeds === '' || Number(proceeds) <= 0) {

			const price = Number(sellData.price);

			if (isFinite(price) && price > 0 && isFinite(qtyDisposed) && qtyDisposed > 0) {

				proceeds = price * qtyDisposed;
			}
			else {

				proceeds = null;
			}
		}

		// A deal can be flagged `canceled` yet still carry sellData/status — but a
		// cancel that never actually sold on the exchange must NOT produce a
		// phantom disposal row in a tax file. Only skip the sell row when the deal
		// was canceled AND there is no evidence of a real sale (no proceeds and no
		// quantity sold). A genuine panic-sell or cancel-and-sell has proceeds or
		// a disposed quantity and is kept. The buy rows above are always kept
		// (those acquisitions really happened).
		const hasRealSale = (proceeds !== null && Number(proceeds) > 0) || (isFinite(qtyDisposed) && qtyDisposed > 0);

		if (!(deal.canceled === true && !hasRealSale)) {

			// Sell fee in quote = gross proceeds x fee%. Explicit fee, tool subtracts it.
			let sellFeeQuote = null;

			if (proceeds !== null && isFinite(Number(proceeds)) && isFinite(sellFeePct)) {

				sellFeeQuote = Number(proceeds) * (sellFeePct / 100);
			}

			const sellOrderId = Array.isArray(sellData.orderId) ? sellData.orderId.join('|') : (sellData.orderId || '');

			rows.push({
				'Date':               toIsoUtc(sellData.date),
				'Sent Amount':        num(qtyDisposed),       // base disposed
				'Sent Currency':      base,
				'Received Amount':    num(proceeds),           // quote received (gross)
				'Received Currency':  quote,
				'Fee Amount':         num(sellFeeQuote),
				'Fee Currency':       sellFeeQuote !== null ? quote : '',
				'Net Worth Amount':   '',
				'Net Worth Currency': '',
				'Label':              '',
				'Description':        'SymBot ' + botName + ' close deal ' + dealId,
				'TxHash':             sellOrderId
			});
		}
	}

	return rows;
}

/**
 * Build rows for many deals, flattened.
 * @param {Array<Object>} deals
 * @param {Object} [opts] - passed through to buildDealRows.
 * @returns {Array<Object>}
 */
function buildRows(deals, opts) {

	if (!Array.isArray(deals)) { return []; }

	const all = [];

	deals.forEach(deal => {

		const rows = buildDealRows(deal, opts);

		for (let i = 0; i < rows.length; i++) { all.push(rows[i]); }
	});

	return all;
}

// ── CSV serialization ────────────────────────────────────────────────────────

// Escape a single CSV field: wrap in double quotes, double any embedded quotes.
function csvField(val) {

	let s = (val === undefined || val === null) ? '' : String(val);

	// Neutralize spreadsheet formula injection: a cell that begins with = + - @ (or a leading tab /
	// carriage return) is executed as a formula by Excel / Google Sheets when the file is opened, so a
	// free-text field (e.g. a journal note or a crafted pair symbol) could run =HYPERLINK(...) etc. Prefix
	// such a cell with a single quote so it is treated as literal text. Do this ONLY when the value is not
	// a plain number, so legitimate negative amounts (e.g. -30.50) stay numeric for tax / spreadsheet tools.
	if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) {

		s = "'" + s;
	}

	return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * Serialize rows to CSV text (Koinly Universal). Does NOT prepend a BOM — the
 * streaming/endpoint layer should emit a UTF-8 BOM before this text for Excel.
 * @param {Array<Object>} rows - row objects keyed by KOINLY_HEADERS.
 * @param {Object} [opts]
 * @param {Array<string>} [opts.headers=KOINLY_HEADERS]
 * @returns {string} CSV text with CRLF line endings.
 */
function rowsToCsv(rows, opts) {

	opts = opts || {};

	const headers = opts.headers || KOINLY_HEADERS;

	const lines = [];

	lines.push(headers.map(csvField).join(','));

	(rows || []).forEach(row => {

		lines.push(headers.map(h => csvField(row[h])).join(','));
	});

	return lines.join('\r\n') + '\r\n';
}

module.exports = {
	KOINLY_HEADERS,
	// pure helpers (exported for testing)
	splitPair,
	toIsoUtc,
	num,
	buyFeeQuote,
	// row builders
	buildDealRows,
	buildRows,
	// serialization
	rowsToCsv
};
