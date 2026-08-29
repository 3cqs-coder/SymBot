'use strict';


// Read-only deal lookups for the AI assistant.
//
// Every query goes through DCABot.getDeals, which is the same helper the rest of
// the application uses, so there is no second database access path to keep in
// step. Nothing here writes, updates or removes: only find and aggregate.
//
// Deal records are large — orders, config and sellData are all free-form
// objects — so results are reduced to a compact summary before they reach a
// model. The summary keeps what a person actually asks about (pair, outcome,
// how many safety orders were used, how long it ran, why it paused) and drops
// the rest.


const MAX_RESULTS_DEFAULT = 20;
const OUTCOME_TIMEOUT_MS = 5000;
const MAX_RESULTS_LIMIT = 100;

// How many deals to walk when counting orders in a time window. Bounded so a
// single "how many safety orders yesterday" question cannot scan the whole archive.
const DEALS_SCAN_DEFAULT = 300;
const DEALS_SCAN_LIMIT = 1000;

// status is 0 while a deal is running and 1 once it has completed.
const STATUS_ACTIVE = 0;
const STATUS_COMPLETE = 1;


let shareData;


// Round a money value to 2 decimals. Shared so the AI deal-query readouts do not each redeclare
// their own identical lambda (they used to). Display-only helper for USD-denominated summaries.
function round2(n) { return Math.round(n * 100) / 100; }


// Shape the open-portfolio unrealized-P/L fields consistently for the open-deal reports. When open deals
// span more than one quote currency there is no single meaningful total — computeOpenDealsLive already
// returns totalUnrealized:null and a per-currency breakdown + note in that case — so the total must stay
// null and the breakdown/note is surfaced, NOT collapsed to a misleading 0 (round2(null) === 0). A
// single-currency account gets the one rounded total, exactly as before.
function openUnrealizedFields(core) {

	const out = { 'total_unrealized_pnl': (core && core.totalUnrealized != null) ? round2(core.totalUnrealized) : null };

	if (core && core.unrealizedByCurrency) { out.unrealized_by_currency = core.unrealizedByCurrency; }
	if (core && core.note) { out.unrealized_note = core.note; }

	return out;
}


// Deals are only reachable once DCABot is registered. Returns null when it is
// not, so callers can degrade instead of throwing.
function getDealsFn() {

	return (shareData && shareData.DCABot && typeof shareData.DCABot.getDeals === 'function')
		? shareData.DCABot.getDeals
		: null;
}


// Orders are stored as a free-form object. Normalize to an array so the same
// counting logic works whether it arrives as an array or a keyed object.
function ordersToArray(orders) {

	let list = [];

	if (Array.isArray(orders)) {

		list = orders;
	}
	else if (orders && typeof orders === 'object') {

		list = Object.values(orders);
	}

	return (list);
}


// Convert a fetched deal into a PLAIN object with its orders normalized to an array. Deals come back
// from DCABot.getDeals as Mongoose documents (no .lean()), whose schema fields (sellData, config,
// botName, …) live on the internal _doc and are NOT own-enumerable — so a plain Object.assign({}, doc)
// silently drops them, which made getProcessedDeals discard every deal (its sellData?.date guard
// failed) and returned empty. toObject() materializes the real fields first. A doc that is already
// plain (e.g. from an aggregate/.lean()) is passed through unchanged. Single exit.
function toPlainDealWithOrders(d) {

	const plain = (d && typeof d.toObject === 'function') ? d.toObject() : (d || {});
	plain.orders = ordersToArray(plain.orders);
	return plain;
}


// Read a flag that may be stored as a boolean or as a string. Uses the shared
// helper so these are interpreted exactly as the rest of the application does.
function readBoolean(value) {

	let result = false;

	if (shareData && shareData.Common && typeof shareData.Common.convertBoolean === 'function') {

		result = shareData.Common.convertBoolean(value, false) === true;
	}
	else {

		result = value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
	}

	return (result);
}


// The quote currency of a pair — the asset a deal's profit is denominated in (e.g.
// "USD" for BTC/USD). Profits in different quote currencies must never be summed into
// one figure, so the performance tools bucket by this. Delegates to the ONE canonical
// helper in Common so this and the dashboard KPI bucketing can never diverge; the
// identical inline is a pre-init fallback (shareData.Common may not be wired yet).
function quoteCurrency(pair) {

	if (shareData && shareData.Common && typeof shareData.Common.quoteCurrency === 'function') {

		return shareData.Common.quoteCurrency(pair);
	}

	if (typeof pair !== 'string') { return 'UNKNOWN'; }

	const sep = pair.indexOf('/') >= 0 ? '/' : (pair.indexOf('_') >= 0 ? '_' : null);

	if (sep == null) { return 'UNKNOWN'; }

	const parts = pair.split(sep);

	return (parts.length >= 2 && parts[1]) ? parts[1].toUpperCase() : 'UNKNOWN';
}


// Sum per-deal profit into a { currency: amount } map (each amount rounded to 2dp),
// so a total is only ever formed within a single quote currency.
function profitByCurrency(deals) {

	const map = {};

	for (const d of (deals || [])) {

		const q = Number(d && d.profit);

		if (isNaN(q)) { continue; }

		const cur = quoteCurrency(d && d.pair);

		map[cur] = (map[cur] || 0) + q;
	}

	for (const k of Object.keys(map)) { map[k] = round2(map[k]); }

	return (map);
}


// A pause reason is only a reason when it names one. Records can carry an empty
// value, a boolean, or the strings "false"/"null" left by earlier writes, none of
// which describe why a deal is paused.
function normalizePauseReason(value) {

	let reason = '';

	if (typeof value === 'string') {

		const trimmed = value.trim();

		const meaningless = trimmed === '' || /^(false|true|null|undefined|0)$/i.test(trimmed);

		reason = meaningless ? '' : trimmed;
	}

	return (reason);
}


// Elapsed time in the same form the rest of the application shows it. Uses
// Common.timeDiff so a duration reads identically here and in the deals views
// rather than in a second format invented for this module.
function formatElapsed(dateStart, dateEnd) {

	let text = null;

	if (dateStart instanceof Date && dateEnd instanceof Date
		&& !isNaN(dateStart.getTime()) && !isNaN(dateEnd.getTime())
		&& shareData && shareData.Common && typeof shareData.Common.timeDiff === 'function') {

		text = shareData.Common.timeDiff(dateStart, dateEnd);
	}

	return (text);
}


// Outcome figures for a completed deal.
//
// These are not recalculated here. getProcessedDeals in DCABotManager already
// derives profit, safety order count and the sell date for the deals history
// view, including the fallbacks used when sellData is missing profitQuote or
// profitBase. Reusing it keeps the assistant's numbers identical to the ones
// shown in the UI rather than a second, slightly different calculation.
//
// Returns null when the deal is open, when the helper is unavailable, or when
// it produces nothing for this deal.
async function getOutcome(deal) {

	const processFn = (shareData && shareData.DCABotManager && typeof shareData.DCABotManager.getProcessedDeals === 'function')
		? shareData.DCABotManager.getProcessedDeals
		: null;

	let outcome = null;

	if (processFn != null && deal && deal.status === STATUS_COMPLETE && deal.sellData) {

		try {

			// getProcessedDeals needs a PLAIN deal with orders as a real array. `deal` here can be a
			// raw Mongoose document (reconcileDeal passes one straight from getDeals), whose schema
			// fields live on _doc and are NOT copied by Object.assign — dropping sellData/config so
			// getProcessedDeals discards the deal and the outcome comes back null. toPlainDealWithOrders
			// materializes the real fields first (same fix as the perf aggregators). Single source.
			const safeDeal = toPlainDealWithOrders(deal);

			// Bounded so a slow or stalled helper can never hold up a chat response.
			const timeout = new Promise(resolve => setTimeout(() => resolve(null), OUTCOME_TIMEOUT_MS));

			const processed = await Promise.race([ processFn([ safeDeal ]), timeout ]);

			if (Array.isArray(processed) && processed.length) {

				outcome = processed[0];
			}
		}
		catch (e) {

			outcome = null;
		}
	}

	return (outcome);
}


// Reduce a deal document to the fields worth showing. Single exit.
async function summarizeDeal(deal) {

	let summary = null;

	if (deal && deal.dealId) {

		const orders = ordersToArray(deal.orders);
		const filled = orders.filter(o => o && (o.filled === 1 || o.filled === true));

		const last = filled.length ? filled[filled.length - 1] : null;

		const created = deal.date ? new Date(deal.date) : (deal.createdAt ? new Date(deal.createdAt) : null);
		const updated = deal.updatedAt ? new Date(deal.updatedAt) : null;

		const isComplete = deal.status === STATUS_COMPLETE;

		// Outcome figures come from the shared history calculation, not from a
		// second one written here. sellData is only present once a deal closes.
		const outcome = await getOutcome(deal);

		const sell = (isComplete && deal.sellData && typeof deal.sellData === 'object') ? deal.sellData : null;

		const profitPercent = outcome && outcome.profit_percent != null ? Number(outcome.profit_percent) : null;
		const profitQuote = outcome && outcome.profit != null ? Number(outcome.profit) : null;
		const profitBase = outcome && outcome.profit_base != null ? Number(outcome.profit_base) : null;

		// A completed deal ended when it sold, which is what the history view uses.
		// updatedAt only records the last write to the document and can drift later.
		// For an open deal there is no end yet, so updatedAt gives its age so far —
		// reported under a different name so the two are never conflated.
		const ended = (outcome && outcome.date_end)
			? new Date(outcome.date_end)
			: (sell && sell.date ? new Date(sell.date) : updated);

		const endPoint = isComplete ? ended : updated;

		const elapsedMins = (created && endPoint) ? Math.round((endPoint.getTime() - created.getTime()) / 60000) : null;

		summary = {
			'dealId': deal.dealId,
			'pair': deal.pair,
			'botName': deal.botName,
			'exchange': deal.exchange,
			'status': isComplete ? 'complete' : 'active',
			'created': created ? created.toISOString() : null,
			'updated': updated ? updated.toISOString() : null,
			// The day the deal last genuinely acted: its CLOSE day for a completed deal
			// (endPoint = sellData.date), or the last write for an open one. Unlike `updated`
			// (raw updatedAt), this is not corrupted when a bulk re-save — e.g. a convert-to-
			// sandbox restore — rewrites updatedAt fleet-wide, so log lookups keyed off it still
			// land on the right day for old completed deals.
			'lastActivity': endPoint ? endPoint.toISOString() : (updated ? updated.toISOString() : null),
			'ranMins': isComplete ? elapsedMins : null,
			'openForMins': isComplete ? null : elapsedMins,
			'elapsedHuman': formatElapsed(created, endPoint),
			'ordersTotal': orders.length,
			'ordersFilled': filled.length,
			'safetyOrdersUsed': (outcome && outcome.safety_orders != null)
				? Number(outcome.safety_orders)
				: (filled.length > 0 ? filled.length - 1 : 0),
			// The ladder belongs to the deal, not to the bot. Each deal's orders array
			// is built at creation from whatever config applied then, so two deals from
			// the same bot can hold different ladders and the bot's current default
			// says nothing about either. The deal's own array is the authority.
			'safetyOrdersMax': orders.length > 0
				? orders.length - 1
				: ((deal.config && deal.config.dcaMaxOrder != null) ? Number(deal.config.dcaMaxOrder) : null),
			// Exhaustion is taken from SymBot's own test rather than recomputed from
			// the two figures above. SymBot compares every filled order, the base one
			// included, against orders.length - 1, so a deal can be spent while the
			// safety-order tally still reads one short of the maximum. Deriving it
			// separately here produced a different answer to the bot's own.
			'ladderExhausted': orders.length > 0 ? (filled.length >= orders.length - 1) : null,
			'averagePrice': last ? last.average : null,
			'targetPrice': last ? last.target : null,
			'qtyFilled': last ? last.qtySum : null,
			// Read through convertBoolean rather than a strict comparison. Deal records
			// can hold these as booleans or as the strings "true"/"false", and a
			// strict === true would silently miss a genuinely paused deal stored the
			// second way. convertBoolean is how the rest of the application reads
			// them, so the assistant agrees with the UI by construction.
			'paused': readBoolean(deal.paused),
			'pausedBuy': readBoolean(deal.pausedBuy),
			'pausedSell': readBoolean(deal.pausedSell),
			// Some deal records hold the string "false" rather than an empty value.
			// SymBot's own convertBoolean treats that string as false, so it is not
			// a reason and must not be shown as one — rendering it produced the
			// meaningless line "pause reason: false".
			'pauseReason': normalizePauseReason(deal.pauseReason),
			'canceled': deal.canceled === true,
			'panicSell': deal.panicSell === true,

			// Outcome — populated only once a deal has closed.
			'sellPrice': (outcome && outcome.price != null) ? outcome.price : (sell && sell.price != null ? sell.price : null),
			'profitCurrency': outcome && outcome.profit_currency ? outcome.profit_currency : null,
			'qtySold': sell && sell.qtySumSell != null ? sell.qtySumSell : null,
			'profitPercent': profitPercent,
			'profitQuote': profitQuote,
			'profitBase': profitBase,
			'profitable': profitPercent != null ? profitPercent > 0 : null
		};

		// For an ACTIVE deal, enrich the summary with LIVE state from the in-memory deal tracker —
		// the same source the deals view uses — so a per-deal answer like "how far underwater is X"
		// or "what is the current price" is grounded in the live figure rather than only the
		// average/target. Cheap in-memory lookup; optional and fail-safe (the summary is returned
		// with or without it, and completed deals are never touched).
		if (!isComplete && shareData && shareData.DCABot && typeof shareData.DCABot.getDealTracker === 'function') {

			try {

				const tracker = await shareData.DCABot.getDealTracker(deal.dealId);
				const info = tracker && tracker.info;

				if (info && info.price_last != null && Number(info.price_last) > 0) {

					const current = Number(info.price_last);

					summary.currentPrice = current;

					if (info.profit != null && !isNaN(Number(info.profit))) {

						summary.unrealizedPnl = round2(Number(info.profit));
						summary.inProfit = Number(info.profit) > 0;
					}

					if (info.profit_percentage != null && !isNaN(Number(info.profit_percentage))) {

						summary.unrealizedPct = round2(Number(info.profit_percentage));
					}

					const tgt = (summary.targetPrice != null) ? Number(summary.targetPrice)
						: (info.price_target != null ? Number(info.price_target) : null);

					if (tgt) {

						summary.pctToTakeProfit = round2((tgt - current) / current * 100);
						summary.readyToTakeProfit = current >= tgt;
					}
				}
			}
			catch (e) { /* live info is optional — the summary still returns without it */ }
		}
	}

	return (summary);
}


// Shared execution path for every lookup below: run the query, summarize, cap.
// Single exit; any failure returns an empty, unsuccessful result rather than
// throwing into the chat pipeline.
async function runQuery(query, options, limit) {

	const getDeals = getDealsFn();

	const capped = Math.min(Math.max(parseInt(limit, 10) || MAX_RESULTS_DEFAULT, 1), MAX_RESULTS_LIMIT);

	let result = { 'success': false, 'error': 'Deal data not available', 'deals': [], 'count': 0 };

	if (getDeals != null) {

		try {

			const queryOptions = Object.assign({ 'limit': capped, 'sort': { 'updatedAt': -1 } }, options || {});

			const docs = await getDeals(query, queryOptions);

			const summaries = await Promise.all(
				(docs || []).map(d => summarizeDeal(d && typeof d.toObject === 'function' ? d.toObject() : d))
			);

			const deals = summaries.filter(d => d != null);

			result = { 'success': true, 'error': null, 'deals': deals, 'count': deals.length };
		}
		catch (e) {

			result = { 'success': false, 'error': e.message, 'deals': [], 'count': 0 };
		}
	}

	return (result);
}


// One deal by id.
async function getDeal(dealId) {

	return (await runQuery({ 'dealId': dealId }, {}, 1));
}


// Deals for a pair, newest first. Optionally restricted to completed deals.
async function getDealsByPair(pair, completedOnly, limit, window) {

	const query = { 'pair': pair };

	// A close-date window ("my BTC deals from last month") only makes sense for CLOSED deals,
	// so it implies completed_only. Filter on the immutable sellData.date, never updatedAt.
	const hasWindow = window && ((window.from instanceof Date && !isNaN(window.from.getTime())) || (window.to instanceof Date && !isNaN(window.to.getTime())));

	if (completedOnly || hasWindow) {

		query.status = STATUS_COMPLETE;
	}

	if (hasWindow) {

		const range = {};
		if (window.from instanceof Date && !isNaN(window.from.getTime())) { range.$gte = window.from; }
		if (window.to instanceof Date && !isNaN(window.to.getTime())) { range.$lte = window.to; }
		query['sellData.date'] = range;
	}

	const r = await runQuery(query, {}, limit);

	// runQuery returns at most `limit` deals, so its count is the truncated LIST length — wrong for
	// "how many deals for pair X" when the pair has more than the cap. Add the TRUE total via a DB count
	// over the same filter, so the caller can report an accurate total alongside the sample. Best-effort:
	// on any failure `total` falls back to the list length (never worse than before). Read-only.
	if (r && r.success !== false) {
		try {
			const getDeals = getDealsFn();
			if (getDeals) {
				const c = await getDeals(null, null, null, [ { '$match': query }, { '$count': 'n' } ]);
				if (Array.isArray(c) && c[0] && typeof c[0].n === 'number') { r.total = c[0].n; }
			}
		}
		catch (e) { /* keep the list-length fallback */ }
		if (r.total == null) { r.total = r.count; }
	}

	return r;
}


// Recently completed deals, optionally within a date range.
async function getRecentDeals(dateFrom, dateTo, limit) {

	const query = { 'status': STATUS_COMPLETE };

	const range = {};

	if (dateFrom instanceof Date && !isNaN(dateFrom.getTime())) {

		range.$gte = dateFrom;
	}

	if (dateTo instanceof Date && !isNaN(dateTo.getTime())) {

		range.$lte = dateTo;
	}

	if (Object.keys(range).length) {

		// Close date, not updatedAt — see getPerformanceSummary. A "closed last week" window must
		// key off the immutable sellData.date so a re-save that bumps updatedAt can't leak old deals.
		query['sellData.date'] = range;
	}

	return (await runQuery(query, {}, limit));
}


// Deals currently paused, optionally filtered by reason. Useful for questions
// about what is stuck and why.
async function getPausedDeals(pauseReason, limit) {

	const query = { 'status': STATUS_ACTIVE, '$or': [ { 'paused': true }, { 'pausedBuy': true }, { 'pausedSell': true } ] };

	if (typeof pauseReason === 'string' && pauseReason !== '') {

		query.pauseReason = pauseReason;
	}

	return (await runQuery(query, {}, limit));
}


// Deals active right now.
async function getActiveDeals(limit) {

	return (await runQuery({ 'status': STATUS_ACTIVE }, {}, limit));
}


// Count filled orders within a UTC time window, split into base orders (orderNo 1)
// and safety orders (orderNo > 1). Reads each deal's own orders[] array — the only
// place both the base/safety distinction and the per-order fill time (dateFilled)
// live, since the generic "Status: Filled" log line records neither. Scans deals
// touched since the window opened (updatedAt >= from), capped, so one question can
// never walk the whole archive. Single exit.
async function getOrderCounts(dateFrom, dateTo, pair, limit) {

	const getDeals = getDealsFn();

	const capped = Math.min(Math.max(parseInt(limit, 10) || DEALS_SCAN_DEFAULT, 1), DEALS_SCAN_LIMIT);

	let result = { 'success': false, 'error': 'Deal data not available', 'base_orders': 0, 'safety_orders': 0, 'total_orders': 0, 'deals_with_safety_orders': 0, 'deals_scanned': 0, 'scan_capped': false, 'by_deal': [] };

	if (getDeals != null) {

		try {

			const query = {};

			// Candidate prefilter: any deal with an order FILLED at/after dateFrom is either still
			// active or closed at/after dateFrom (an order cannot fill after the deal closes). Keying
			// off active-status OR the immutable sellData.date — rather than updatedAt, which a re-save
			// can bump to "now" — keeps the candidate set tight and correct so the per-order dateFilled
			// tally below (which does the real windowing) never misses an in-window order to the cap.
			if (dateFrom instanceof Date && !isNaN(dateFrom.getTime())) {
				query.$or = [ { 'status': STATUS_ACTIVE }, { 'sellData.date': { '$gte': dateFrom } } ];
			}
			if (typeof pair === 'string' && pair !== '') { query.pair = pair; }

			const docs = await getDeals(query, { 'limit': capped, 'sort': { 'updatedAt': -1 } });

			let base = 0;
			let safety = 0;

			// Per-deal tally, keyed by deal id, so the answer to "which deals" is
			// authoritative rather than reconstructed by the model from a flat sample.
			const byDeal = new Map();

			// Same tally rolled up per BOT, so "how many safety orders did each bot place" is
			// answered authoritatively rather than the model guessing a bot from the per-deal list.
			const byBot = new Map();

			for (const d of (docs || [])) {

				const orders = ordersToArray(d && d.orders);

				for (const o of orders) {

					if (!o || !(o.filled === 1 || o.filled === true) || !o.dateFilled) { continue; }

					const t = new Date(o.dateFilled);

					if (isNaN(t.getTime())) { continue; }
					if (dateFrom instanceof Date && t < dateFrom) { continue; }
					if (dateTo instanceof Date && t > dateTo) { continue; }

					const isBase = Number(o.orderNo) === 1;

					if (isBase) { base++; } else { safety++; }

					let entry = byDeal.get(d.dealId);

					if (!entry) {

						entry = { 'dealId': d.dealId, 'pair': d.pair, 'base_orders': 0, 'safety_orders': 0 };
						byDeal.set(d.dealId, entry);
					}

					if (isBase) { entry.base_orders++; } else { entry.safety_orders++; }

					const botKey = d.botName || '(unknown bot)';
					let bEntry = byBot.get(botKey);
					if (!bEntry) { bEntry = { 'botName': botKey, 'base_orders': 0, 'safety_orders': 0, 'deals': new Set() }; byBot.set(botKey, bEntry); }
					if (isBase) { bEntry.base_orders++; } else { bEntry.safety_orders++; }
					bEntry.deals.add(d.dealId);
				}
			}

			// Most safety orders first; cap the list so a wide window stays compact.
			const perDeal = Array.from(byDeal.values())
				.sort((a, b) => (b.safety_orders - a.safety_orders) || (b.base_orders - a.base_orders))
				.slice(0, 50);

			const perBot = Array.from(byBot.values())
				.map(b => ({ 'botName': b.botName, 'base_orders': b.base_orders, 'safety_orders': b.safety_orders, 'deals': b.deals.size }))
				.sort((a, b) => (b.safety_orders - a.safety_orders) || (b.base_orders - a.base_orders));

			const dealsWithSafety = Array.from(byDeal.values()).filter(e => e.safety_orders > 0).length;

			result = { 'success': true, 'error': null, 'base_orders': base, 'safety_orders': safety, 'total_orders': base + safety, 'deals_with_safety_orders': dealsWithSafety, 'deals_scanned': (docs || []).length, 'scan_capped': (docs || []).length >= capped, 'by_deal': perDeal, 'by_bot': perBot };
		}
		catch (e) {

			result = { 'success': false, 'error': e.message, 'base_orders': 0, 'safety_orders': 0, 'total_orders': 0, 'deals_with_safety_orders': 0, 'deals_scanned': 0, 'scan_capped': false, 'by_deal': [] };
		}
	}

	return (result);
}


// Aggregate profit/loss over completed deals in a window, reusing DCABotManager's
// getProcessedDeals so the figures match the deals-history view exactly rather than
// a second calculation invented here. One batch call, not one per deal, so it stays
// fast over a large window. Single exit.
async function getPerformanceSummary(dateFrom, dateTo, pair, limit) {

	const getDeals = getDealsFn();

	const processFn = (shareData && shareData.DCABotManager && typeof shareData.DCABotManager.getProcessedDeals === 'function')
		? shareData.DCABotManager.getProcessedDeals
		: null;

	const capped = Math.min(Math.max(parseInt(limit, 10) || 500, 1), DEALS_SCAN_LIMIT);


	let result = { 'success': false, 'error': 'Deal data not available', 'completed_deals': 0 };

	if (getDeals != null && processFn != null) {

		try {

			const query = { 'status': STATUS_COMPLETE };

			const range = {};

			if (dateFrom instanceof Date && !isNaN(dateFrom.getTime())) { range.$gte = dateFrom; }
			if (dateTo instanceof Date && !isNaN(dateTo.getTime())) { range.$lte = dateTo; }
			// Window on the deal's CLOSE date (sellData.date), never updatedAt: updatedAt records
			// the last write and a migration or re-save can bump every deal to "now", which would
			// pull the entire history into any "last week / this month" window. sellData.date is
			// the immutable close timestamp — the correct field for "deals that closed in a period".
			if (Object.keys(range).length) { query['sellData.date'] = range; }
			if (typeof pair === 'string' && pair !== '') { query.pair = pair; }

			// EXACT headline figures via a per-pair DB aggregation. It returns ONE small row
			// per pair no matter how many deals match, so the deal count, total profit, win rate
			// and average percent are correct across the whole window — never truncated by the
			// per-deal scan cap below (which previously made "this year" report only 1000 of
			// thousands of deals). sellData.profit is the realized percent; profitQuote the money.
			const agg = (await getDeals(null, null, null, [
				{ '$match': query },
				{ '$group': {
					'_id': '$pair',
					'count':     { '$sum': 1 },
					'profitSum': { '$sum': { '$toDouble': { '$ifNull': [ '$sellData.profitQuote', 0 ] } } },
					'pctSum':    { '$sum': { '$toDouble': { '$ifNull': [ '$sellData.profit', 0 ] } } },
					'wins':      { '$sum': { '$cond': [ { '$gt': [ { '$toDouble': { '$ifNull': [ '$sellData.profit', 0 ] } }, 0 ] }, 1, 0 ] } }
				} }
			])) || [];

			let exactCount = 0, exactWins = 0, exactPctSum = 0;
			const byCur = {};

			for (const row of agg) {

				const cnt = Number(row.count) || 0;
				exactCount += cnt;
				exactWins += Number(row.wins) || 0;
				exactPctSum += Number(row.pctSum) || 0;

				const ps = Number(row.profitSum);
				if (!isNaN(ps)) { const cur = quoteCurrency(row._id); byCur[cur] = (byCur[cur] || 0) + ps; }
			}

			for (const k of Object.keys(byCur)) { byCur[k] = round2(byCur[k]); }

			// A single "total profit" is only meaningful within one currency — summing USD and
			// USDT (or BTC) profits is nonsense — so total_profit is a number only when every
			// completed deal shares one quote currency, else null with a per-currency breakdown.
			const currencies = Object.keys(byCur);
			const singleCurrency = currencies.length <= 1;
			const exactLosses = exactCount - exactWins;

			// Sampled scan for the richer per-deal EXTRAS (average duration, best/worst deal,
			// safety-order totals) that need each deal's orders/timestamps. Capped for memory and
			// sorted by close date, so when the window holds more than the cap these extras cover
			// the most recent `capped` deals — flagged in scan_capped/note so nothing reads as
			// complete when it is a recent sample. The headline figures above are always exact.
			const docs = await getDeals(query, { 'limit': capped, 'sort': { 'sellData.date': -1 } });
			const safe = (docs || []).map(toPlainDealWithOrders);
			const processed = (await processFn(safe)) || [];

			let soSum = 0, durSum = 0, durN = 0;
			let best = null, worst = null;
			// Winners-vs-losers split (avg safety orders / avg percent per outcome) so
			// "did winners use more safety orders than losers?" is answered from data, not guessed.
			let winSo = 0, winN = 0, winPct = 0, loseSo = 0, loseN = 0, losePct = 0;

			for (const p of processed) {

				const pct = Number(p.profit_percent);

				if (!isNaN(pct)) {

					if (best == null || pct > Number(best.profit_percent)) { best = p; }
					if (worst == null || pct < Number(worst.profit_percent)) { worst = p; }

					const so = Number(p.safety_orders) || 0;
					if (pct > 0) { winN++; winSo += so; winPct += pct; }
					else { loseN++; loseSo += so; losePct += pct; }
				}

				if (p.safety_orders != null) { soSum += Number(p.safety_orders); }

				if (p.date_start && p.date_end) {

					const ms = new Date(p.date_end).getTime() - new Date(p.date_start).getTime();
					if (!isNaN(ms) && ms >= 0) { durSum += ms; durN++; }
				}
			}

			const sampleCapped = (docs || []).length >= capped && exactCount > (docs || []).length;

			const brief = (d) => d ? { 'dealId': d.deal_id, 'pair': d.pair, 'profit_percent': Number(d.profit_percent), 'profit': Number(d.profit) } : null;

			result = {
				'success': true,
				'error': null,
				'completed_deals': exactCount,
				'total_profit': singleCurrency ? round2(byCur[currencies[0]] || 0) : null,
				'profit_currency': singleCurrency ? (currencies[0] || null) : null,
				'avg_profit_percent': exactCount ? round2(exactPctSum / exactCount) : null,
				'win_rate_percent': exactCount ? round2((exactWins / exactCount) * 100) : null,
				'wins': exactWins,
				'losses': exactLosses,
				'total_safety_orders': soSum,
				'avg_duration_mins': durN ? round2(durSum / durN / 60000) : null,
				'best_deal': brief(best),
				'worst_deal': brief(worst),
				// Outcome split: counts are exact; the averages are over the scanned sample.
				'winners': { 'count': exactWins, 'avg_safety_orders': winN ? round2(winSo / winN) : null, 'avg_profit_percent': winN ? round2(winPct / winN) : null },
				'losers': { 'count': exactLosses, 'avg_safety_orders': loseN ? round2(loseSo / loseN) : null, 'avg_profit_percent': loseN ? round2(losePct / loseN) : null },
				'scan_capped': sampleCapped
			};

			if (!singleCurrency) {

				result.profit_by_currency = byCur;
				result.note = 'Completed deals span multiple quote currencies (' + currencies.join(', ') + '), so there is no single total profit; see profit_by_currency for the per-currency totals. Percentages and win rate are across all deals.';
			}

			if (sampleCapped) {

				result.note = (result.note ? result.note + ' ' : '')
					+ 'Deal count, total profit, win rate and average percent are exact for the whole period; the safety-order total, average duration and best/worst deal shown are from the most recent ' + (docs || []).length + ' of ' + exactCount + ' deals (use get_top_deals for the exact best/worst over the period).';
			}
		}
		catch (e) {

			result = { 'success': false, 'error': e.message, 'completed_deals': 0 };
		}
	}

	return (result);
}


// Leaderboard: rank individual deals by performance and return the best N and worst N,
// pre-sorted, so "top/best performing deals" and "worst deals" are answered directly instead
// of asking the model to rank a list. scope 'completed' (default) ranks by REALIZED profit —
// actual closed-trade outcomes, the natural reading of "my best trades"; scope 'open' ranks
// current open deals by live UNREALIZED P/L (reusing computeOpenDealsLive). metric 'percent'
// (default) is currency-agnostic and safe to compare across deals; 'amount' ranks by the money
// figure (which can span quote currencies, so percent is preferred). Single exit.
async function getTopDeals(scope, metric, limit, direction, window) {

	const n = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
	const byDuration = (metric === 'duration' || metric === 'time' || metric === 'runtime' || metric === 'longest' || metric === 'shortest' || metric === 'age');
	// "Most / least profitable" colloquially means DOLLARS, so rank by realized amount BY DEFAULT
	// (previously it defaulted to percent, which put a $31 deal above a $589 one). Percent is opt-in.
	const byPercent = (metric === 'percent' || metric === 'pct' || metric === '%');
	const byAmount = !byPercent && !byDuration;
	// Accept both the American ('unrealized') and British ('unrealised') spelling as caller input, so an
	// existing integration passing the British form keeps working after the codebase standardized on American.
	const useOpen = (scope === 'open' || scope === 'active' || scope === 'unrealized' || scope === 'unrealised');

	// Which end of the ranking the caller wants. When it's specifically 'best' or 'worst' we return
	// ONE `deals` array (the requested ranking) rather than both best+worst — a smaller model reliably
	// reports a single list but often mixes up two arrays (e.g. reads `best` for a "worst" question).
	const dir = (direction === 'best' || direction === 'top' || direction === 'highest') ? 'best'
		: (direction === 'worst' || direction === 'bottom' || direction === 'lowest') ? 'worst'
		: 'both';

	// Shape the output by direction: a single, unambiguous `deals` list for best/worst, both otherwise.
	const shape = (bestArr, worstArr, extra) => {
		const base = Object.assign({ 'success': true, 'error': null }, extra);
		if (dir === 'best') { return Object.assign(base, { 'ranking': 'best', 'deals': bestArr }); }
		if (dir === 'worst') { return Object.assign(base, { 'ranking': 'worst', 'deals': worstArr }); }
		return Object.assign(base, { 'best': bestArr, 'worst': worstArr });
	};

	let result = { 'success': false, 'error': 'Deal data not available', 'deals': [] };

	try {

		if (useOpen) {

			const core = await computeOpenDealsLive(DEALS_SCAN_LIMIT);

			if (core && core.success === true) {

				const key = (d) => byAmount ? d.unrealizedPnl : d.unrealizedPct;
				const priced = (core.deals || []).filter(d => key(d) != null && !isNaN(Number(key(d))));
				const desc = priced.slice().sort((a, b) => Number(key(b)) - Number(key(a)));

				const brief = (d) => ({ 'dealId': d.dealId, 'pair': d.pair, 'unrealizedPct': d.unrealizedPct != null ? d.unrealizedPct : null, 'unrealizedPnl': d.unrealizedPnl != null ? d.unrealizedPnl : null, 'inProfit': d.inProfit === true });

				result = shape(desc.slice(0, n).map(brief), desc.slice(-n).reverse().map(brief), {
					'scope': 'open',
					'ranked_by': byAmount ? 'unrealized P/L amount' : 'unrealized P/L percent',
					'deals_considered': priced.length, 'stale_excluded': core.stale || 0
				});
			}
			else { result = { 'success': false, 'error': (core && core.error) || 'Deal data not available', 'deals': [] }; }
		}
		else {

			const getDeals = getDealsFn();

			if (getDeals != null) {

				// Rank at the DATABASE level so EVERY completed deal is considered (not just a recent-N
				// sample — the true best deal can be old), while only the N tiny projected docs per end
				// come back, keeping memory flat even with tens of thousands of deals. sellData.profit IS
				// the realized profit percent (stored numeric); sellData.profitQuote is the money figure.
				// This deliberately avoids the batch getProcessedDeals path, where one malformed deal
				// throws and empties the whole result.
				const sortField = byAmount ? 'sellData.profitQuote' : 'sellData.profit';

				// Optional close-date window. A completed deal's close time is sellData.date, so a
				// "last week / yesterday / this month" question filters here. With no window the
				// ranking is all-time (the natural meaning of "my best deals" with no period).
				const hasWindow = window && ((window.from instanceof Date && !isNaN(window.from.getTime())) || (window.to instanceof Date && !isNaN(window.to.getTime())));
				const dateClause = { '$exists': true };
				if (hasWindow) {
					if (window.from instanceof Date && !isNaN(window.from.getTime())) { dateClause['$gte'] = window.from; }
					if (window.to instanceof Date && !isNaN(window.to.getTime())) { dateClause['$lte'] = window.to; }
				}

				const q = { 'status': STATUS_COMPLETE, 'sellData.date': dateClause };

				const winEcho = hasWindow
					? { 'from': dateClause['$gte'] ? dateClause['$gte'].toISOString() : null, 'to': dateClause['$lte'] ? dateClause['$lte'].toISOString() : null }
					: 'all_time';

				if (byDuration) {

					// Rank by how long each deal ran (close − start), computed in the DB so ALL
					// completed deals are considered. best = longest-running, worst = shortest.
					const base = [
						{ '$match': Object.assign({ 'date': { '$exists': true } }, q) },
						{ '$project': { '_id': 0, 'dealId': 1, 'pair': 1, 'profit_percent': '$sellData.profit', 'profit': '$sellData.profitQuote', 'durMs': { '$subtract': [ '$sellData.date', '$date' ] } } }
					];
					const topD = (dir !== 'worst') ? ((await getDeals(null, null, null, base.concat([ { '$sort': { 'durMs': -1 } }, { '$limit': n } ]))) || []) : [];
					const botD = (dir !== 'best')  ? ((await getDeals(null, null, null, base.concat([ { '$sort': { 'durMs': 1 } }, { '$limit': n } ]))) || []) : [];
					const briefD = (d) => ({ 'dealId': d.dealId, 'pair': d.pair, 'duration_days': round2((Number(d.durMs) || 0) / 86400000), 'duration_hours': round2((Number(d.durMs) || 0) / 3600000), 'profit_percent': d.profit_percent != null ? Number(d.profit_percent) : null, 'profit': d.profit != null ? Number(d.profit) : null });
					result = shape(topD.map(briefD), botD.map(briefD), { 'scope': 'completed', 'ranked_by': 'deal duration / run time (best = longest, worst = shortest)', 'window': winEcho });
				}
				else {

				if (byAmount) { q['sellData.profitQuote'] = { '$exists': true, '$ne': null }; }

				const proj = { 'dealId': 1, 'pair': 1, 'sellData.profit': 1, 'sellData.profitQuote': 1, '_id': 0 };

				// Only query the end(s) actually needed.
				const topDocs = (dir !== 'worst') ? ((await getDeals(q, { 'sort': { [sortField]: -1 }, 'limit': n }, proj)) || []) : [];
				const botDocs = (dir !== 'best')  ? ((await getDeals(q, { 'sort': { [sortField]:  1 }, 'limit': n }, proj)) || []) : [];

				const brief = (d) => {
					const sd = d.sellData || {};
					const pct = Number(sd.profit);
					const amt = (sd.profitQuote != null && !isNaN(Number(sd.profitQuote))) ? Number(sd.profitQuote) : null;
					return { 'dealId': d.dealId, 'pair': d.pair, 'profit_percent': isNaN(pct) ? null : pct, 'profit': amt };
				};

				const extra = {
					'scope': 'completed',
					'ranked_by': byAmount ? 'realized profit amount' : 'realized profit percent',
					// Echo the window applied so the model reports the correct period and never
					// presents an all-time ranking as if it were a bounded one.
					'window': hasWindow
						? { 'from': dateClause['$gte'] ? dateClause['$gte'].toISOString() : null, 'to': dateClause['$lte'] ? dateClause['$lte'].toISOString() : null }
						: 'all_time'
				};
				if (byAmount) { extra.note = 'Ranked by realized profit amount over deals that store one; amounts can span quote currencies — rank by percent for a currency-agnostic comparison.'; }

				result = shape(topDocs.map(brief), botDocs.map(brief), extra);
				}
			}
		}
	}
	catch (e) { result = { 'success': false, 'error': e.message, 'deals': [] }; }

	return (result);
}


// Completed-deal stats bucketed by calendar period (day / week / month) over a window — the
// time-SERIES view ("how many deals did I close each day this week", "profit by month this
// year"). One DB aggregation grouping on the immutable close date (sellData.date, UTC), so it is
// exact and memory-flat regardless of how many deals match. total_profit is a raw sum per bucket;
// it is meaningful within a single quote currency (the usual case) — flagged when deals span more.
async function getDealStatsOverTime(dateFrom, dateTo, groupBy) {

	const getDeals = getDealsFn();

	let result = { 'success': false, 'error': 'Deal data not available', 'buckets': [] };

	if (getDeals == null) { return result; }

	const grp = (groupBy === 'month' || groupBy === 'week') ? groupBy : 'day';
	const fmt = grp === 'month' ? '%Y-%m' : (grp === 'week' ? '%G-W%V' : '%Y-%m-%d');

	const dateClause = {};
	if (dateFrom instanceof Date && !isNaN(dateFrom.getTime())) { dateClause.$gte = dateFrom; }
	if (dateTo instanceof Date && !isNaN(dateTo.getTime())) { dateClause.$lte = dateTo; }

	const match = { 'status': STATUS_COMPLETE, 'sellData.date': Object.keys(dateClause).length ? dateClause : { '$exists': true } };

	try {

		const pipeline = [
			{ '$match': match },
			{ '$group': {
				'_id': { '$dateToString': { 'format': fmt, 'date': '$sellData.date', 'timezone': 'UTC' } },
				'count':  { '$sum': 1 },
				'profit': { '$sum': { '$toDouble': { '$ifNull': [ '$sellData.profitQuote', 0 ] } } },
				'wins':   { '$sum': { '$cond': [ { '$gt': [ { '$toDouble': { '$ifNull': [ '$sellData.profit', 0 ] } }, 0 ] }, 1, 0 ] } }
			} },
			{ '$sort': { '_id': 1 } }
		];

		const rows = (await getDeals(null, null, null, pipeline)) || [];

		const buckets = rows.map(r => ({
			'period': r._id,
			'deals': r.count,
			'total_profit': round2(Number(r.profit) || 0),
			'wins': r.wins,
			'losses': r.count - r.wins,
			'win_rate_percent': r.count ? round2((r.wins / r.count) * 100) : null
		}));

		// Pre-computed grand totals across all buckets, so "how many deals in total" is answered
		// from one field rather than the model summing the per-period rows (which it can get wrong).
		const tDeals = buckets.reduce((a, b) => a + b.deals, 0);
		const tWins = buckets.reduce((a, b) => a + b.wins, 0);
		const totals = {
			'deals': tDeals,
			'total_profit': round2(buckets.reduce((a, b) => a + b.total_profit, 0)),
			'wins': tWins,
			'losses': tDeals - tWins,
			'win_rate_percent': tDeals ? round2((tWins / tDeals) * 100) : null
		};

		result = { 'success': true, 'error': null, 'group_by': grp, 'totals': totals, 'buckets': buckets, 'periods': buckets.length };
	}
	catch (e) { result = { 'success': false, 'error': e.message, 'buckets': [] }; }

	return (result);
}


// Contrastive per-deal diagnosis: compare ONE deal to similar deals with the
// OPPOSITE outcome on the same pair, so the model can explain WHY it under/over-performed against
// the norm. Everything numeric is computed here; the model only narrates the decisive difference.
// A completed deal's "how far price fell below the base order" (max_price_drop_pct) and its
// safety-order/ladder usage are the load-bearing contrast signals.
async function compareDealOutcome(dealId, baselineLimit) {

	const getDeals = getDealsFn();

	if (getDeals == null) { return { 'success': false, 'error': 'Deal data not available' }; }

	const targetDocs = (await getDeals({ 'dealId': String(dealId || '') }, { 'limit': 1 })) || [];
	const target = targetDocs[0];

	if (!target) { return { 'success': false, 'error': 'No deal found with id ' + dealId }; }
	if (target.status !== STATUS_COMPLETE || !target.sellData) {
		return { 'success': false, 'error': 'Deal ' + dealId + ' is not completed yet — contrastive comparison needs a closed deal (use diagnose_deal for a live one).' };
	}

	// Per-deal contrast metrics.
	const metric = (d) => {
		const filled = ordersToArray(d.orders).filter(o => o && (o.filled === 1 || o.filled === true));
		const base = filled.find(o => Number(o.orderNo) === 1) || filled[0] || {};
		const baseAvg = Number(base.average) || Number(base.price) || null;
		const closePrice = d.sellData ? Number(d.sellData.price) : null;
		const so = Math.max(filled.length - 1, 0);
		const max = (d.config && d.config.dcaMaxOrder != null) ? parseInt(d.config.dcaMaxOrder, 10) : null;
		const durMin = (d.date && d.sellData && d.sellData.date) ? Math.round((new Date(d.sellData.date).getTime() - new Date(d.date).getTime()) / 60000) : null;
		const dropPct = (baseAvg && closePrice) ? round2(((baseAvg - closePrice) / baseAvg) * 100) : null;
		return {
			'dealId': d.dealId, 'pair': d.pair,
			'profit_percent': d.sellData && d.sellData.profit != null ? Number(d.sellData.profit) : null,
			'profit': d.sellData && d.sellData.profitQuote != null ? Number(d.sellData.profitQuote) : null,
			'safety_orders_used': so,
			'safety_orders_max': isNaN(max) ? null : max,
			'ladder_exhausted': (max != null && !isNaN(max)) ? (so >= max) : null,
			'duration_mins': durMin,
			'max_price_drop_pct': dropPct,
			'take_profit_percent': (d.config && d.config.dcaTakeProfitPercent != null) ? Number(d.config.dcaTakeProfitPercent) : null,
			'step_percent': (d.config && d.config.dcaOrderStepPercent != null) ? Number(d.config.dcaOrderStepPercent) : null,
			'size_multiplier': (d.config && d.config.dcaOrderSizeMultiplier != null) ? Number(d.config.dcaOrderSizeMultiplier) : null
		};
	};

	const t = metric(target);
	const targetWon = t.profit_percent != null && t.profit_percent > 0;

	// Baseline = the OPPOSITE outcome on the same pair (if the target lost, compare to winners).
	const wantProfit = !targetWon;
	const q = { 'status': STATUS_COMPLETE, 'pair': target.pair, 'sellData.date': { '$exists': true }, 'dealId': { '$ne': target.dealId } };
	q['sellData.profit'] = wantProfit ? { '$gt': 0 } : { '$lte': 0 };

	const cap = Math.min(Math.max(parseInt(baselineLimit, 10) || 5, 1), 10);
	const baseDocs = (await getDeals(q, { 'sort': { 'sellData.date': -1 }, 'limit': cap })) || [];
	const baselines = baseDocs.map(metric);

	const avg = (key) => {
		const v = baselines.map(x => x[key]).filter(n => n != null && !isNaN(n));
		return v.length ? round2(v.reduce((a, b) => a + b, 0) / v.length) : null;
	};

	const baselineAvg = baselines.length ? {
		'profit_percent': avg('profit_percent'),
		'safety_orders_used': avg('safety_orders_used'),
		'duration_mins': avg('duration_mins'),
		'max_price_drop_pct': avg('max_price_drop_pct'),
		'take_profit_percent': avg('take_profit_percent'),
		'step_percent': avg('step_percent')
	} : null;

	return {
		'success': true, 'error': null,
		'pair': target.pair,
		'target': t,
		'target_outcome': targetWon ? 'win' : 'loss',
		'baseline_outcome': wantProfit ? 'winning deals on this pair' : 'losing deals on this pair',
		'baseline_count': baselines.length,
		'baseline_avg': baselineAvg,
		'baselines': baselines,
		'guidance': 'Explain the outcome by contrasting `target` against `baseline_avg`: the decisive signals are safety_orders_used vs the baseline (and ladder_exhausted), max_price_drop_pct (how far price fell below the base order), duration, and any config difference (take_profit_percent, step_percent, size_multiplier). State the single biggest difference from the norm. Do NOT assert a cause the numbers do not show, and remember "different before" is not "the reason".'
	};
}


// Rank configured bots by REALIZED performance over a period. Reuses the same
// getProcessedDeals path as getPerformanceSummary and Common.computeDealSetStats (the
// exact aggregation the web dashboard uses per bot), grouped by bot.
async function getBotPerformance(dateFrom, dateTo, order) {

	const getDeals = getDealsFn();

	let result = { 'success': false, 'error': 'Deal data not available', 'bots': [] };

	if (getDeals != null) {

		try {

			const match = { 'status': STATUS_COMPLETE };
			const range = {};
			if (dateFrom instanceof Date && !isNaN(dateFrom.getTime())) { range.$gte = dateFrom; }
			if (dateTo instanceof Date && !isNaN(dateTo.getTime())) { range.$lte = dateTo; }
			// Window on the deal's CLOSE date (sellData.date), never updatedAt: updatedAt records
			// the last write and a migration or re-save can bump every deal to "now", which would
			// pull the entire history into any "last week / this month" window. sellData.date is
			// the immutable close timestamp — the correct field for "deals that closed in a period".
			if (Object.keys(range).length) { match['sellData.date'] = range; }

			// Aggregate per (bot, quote-currency) at the DATABASE over EVERY matching deal — not a capped
			// recent sample. A 1000-deal in-memory cap (getDeals limit) badly UNDERCOUNTED any bot with
			// thousands of closed deals (e.g. a bot's true all-time $29k read as $22k from its slice of the
			// recent 1000), and could even mis-rank bots. profitQuote is the money; profit is the percent.
			// safety_orders = filled orders with orderNo != 1 (matching getOrderCounts); duration is the
			// close-minus-open span. Grouping also by quote currency keeps multi-currency bots honest.
			const curExpr = { '$toUpper': { '$let': { 'vars': { 'p': { '$ifNull': [ '$pair', '' ] } }, 'in': {
				'$cond': [ { '$gt': [ { '$indexOfCP': [ '$$p', '/' ] }, -1 ] }, { '$arrayElemAt': [ { '$split': [ '$$p', '/' ] }, 1 ] },
				{ '$cond': [ { '$gt': [ { '$indexOfCP': [ '$$p', '_' ] }, -1 ] }, { '$arrayElemAt': [ { '$split': [ '$$p', '_' ] }, 1 ] }, 'UNKNOWN' ] } ] } } } };
			const safetyExpr = { '$size': { '$filter': { 'input': { '$ifNull': [ '$orders', [] ] }, 'as': 'o',
				'cond': { '$and': [ { '$ne': [ '$$o.orderNo', 1 ] }, { '$ne': [ { '$ifNull': [ '$$o.dateFilled', null ] }, null ] } ] } } } };
			// Duration in minutes = close − open. Guarded for null AND for sign: a data/clock anomaly where
			// the close precedes the open must not push a NEGATIVE duration into the average. A negative or
			// one-sided row contributes null and is skipped (durN doesn't count it).
			const durExpr = { '$let': { 'vars': { 'd': { '$subtract': [ '$sellData.date', '$date' ] } }, 'in': {
				'$cond': [ { '$and': [ { '$ne': [ '$sellData.date', null ] }, { '$ne': [ '$date', null ] }, { '$gte': [ '$$d', 0 ] } ] },
				{ '$divide': [ '$$d', 60000 ] }, null ] } } };

			const rows = await getDeals(null, null, null, [
				{ '$match': match },
				{ '$group': {
					'_id':       { 'bot': { '$ifNull': [ '$botName', '$botId' ] }, 'cur': curExpr },
					'deals':     { '$sum': 1 },
					'profitSum': { '$sum': { '$toDouble': { '$ifNull': [ '$sellData.profitQuote', 0 ] } } },
					'pctSum':    { '$sum': { '$toDouble': { '$ifNull': [ '$sellData.profit', 0 ] } } },
					'wins':      { '$sum': { '$cond': [ { '$gt': [ { '$toDouble': { '$ifNull': [ '$sellData.profit', 0 ] } }, 0 ] }, 1, 0 ] } },
					'durSum':    { '$sum': { '$ifNull': [ durExpr, 0 ] } },
					'durN':      { '$sum': { '$cond': [ { '$ne': [ durExpr, null ] }, 1, 0 ] } },
					'safetySum': { '$sum': safetyExpr }
				} }
			]);

			// getDeals swallows a DB/aggregation error and returns undefined (it must never throw into the
			// trading path). At the reporting layer that means "couldn't read" — NOT "no deals" — so treat it
			// as a failure: the caller's catch sets success:false, the AI tool's failGuard fires, and the
			// assistant says it couldn't retrieve rather than reporting a confident, wrong $0 during an outage.
			if (rows === undefined) { throw new Error('Deal data temporarily unavailable (query failed)'); }

			// Fold the per-(bot,currency) rows into one row per bot, keeping per-currency money totals so a
			// bot that traded multiple quote currencies never sums them into one meaningless figure.
			const byBot = {};
			for (const r of rows) {
				const bot = (r._id && r._id.bot) || '(unknown)';
				const cur = (r._id && r._id.cur) || 'UNKNOWN';
				const b = byBot[bot] || (byBot[bot] = { deals: 0, pctSum: 0, wins: 0, durSum: 0, durN: 0, safetySum: 0, byCur: {} });
				b.deals += Number(r.deals) || 0;
				b.pctSum += Number(r.pctSum) || 0;
				b.wins += Number(r.wins) || 0;
				b.durSum += Number(r.durSum) || 0;
				b.durN += Number(r.durN) || 0;
				b.safetySum += Number(r.safetySum) || 0;
				b.byCur[cur] = (b.byCur[cur] || 0) + (Number(r.profitSum) || 0);
			}

			let anyMixed = false;

			let bots = Object.keys(byBot).map(name => {
				const b = byBot[name];
				const curs = Object.keys(b.byCur);
				const single = curs.length <= 1;
				if (!single) { anyMixed = true; }
				const rankProfit = curs.reduce((a, k) => a + b.byCur[k], 0);   // raw sum for ranking (same as the dashboard)

				const row = {
					'botName': name,
					'completed_deals': b.deals,
					'total_profit': single ? round2(b.byCur[curs[0]] || 0) : null,
					'profit_currency': single ? (curs[0] || null) : null,
					'win_rate_percent': b.deals ? round2(b.wins / b.deals * 100) : 0,
					'avg_profit_percent': b.deals ? round2(b.pctSum / b.deals) : 0,
					'avg_duration_mins': b.durN ? Math.round(b.durSum / b.durN) : 0,
					'avg_safety_orders': b.deals ? round2(b.safetySum / b.deals) : 0,
					'_rankProfit': rankProfit
				};

				if (!single) { const m = {}; curs.forEach(k => { m[k] = round2(b.byCur[k]); }); row.profit_by_currency = m; }

				return row;
			});

			const ord = String(order || 'most_profitable');
			bots.sort((a, b) => ord === 'most_active' ? (b.completed_deals - a.completed_deals) : ord === 'least_profitable' ? (a._rankProfit - b._rankProfit) : (b._rankProfit - a._rankProfit));

			const bestBot = bots.length ? bots.slice().sort((a, b) => b._rankProfit - a._rankProfit)[0].botName : null;
			const worstBot = bots.length ? bots.slice().sort((a, b) => a._rankProfit - b._rankProfit)[0].botName : null;

			// Capture the true count BEFORE trimming the presented rows, so bot_count reflects all bots, not
			// the display cap of 20.
			const botCount = bots.length;

			// Drop the internal ranking field from the presented rows.
			bots = bots.slice(0, 20).map(b => { const { _rankProfit, ...rest } = b; return rest; });

			result = { 'success': true, 'error': null, 'bot_count': botCount, 'bots': bots, 'best_bot': bestBot, 'worst_bot': worstBot };

			if (anyMixed) {

				result.note = 'One or more bots traded deals in multiple quote currencies; for those, total_profit is null and profit_by_currency gives the per-currency totals. Ranking uses the raw summed profit.';
			}
		}
		catch (e) { result = { 'success': false, 'error': e.message, 'bots': [] }; }
	}

	return (result);
}


// Fetch active deals summarized via summarizeDeal (reused by the open-deal analytics
// tools below). Returns null when deal data is unavailable.
async function getSummarizedActiveDeals() {

	const getDeals = getDealsFn();
	if (getDeals == null) { return null; }

	const docs = await getDeals({ 'status': STATUS_ACTIVE }, { 'limit': DEALS_SCAN_LIMIT, 'sort': { 'updatedAt': -1 } });
	const out = [];
	for (const d of (docs || [])) { out.push(await summarizeDeal(d)); }
	return out;
}


// Open deals ranked by age — oldest first by default (surfaces stagnating positions), or newest first
// when `newest` is true (the most-recently-opened deals). Reuses summarizeDeal's openForMins/created.
async function findOldestOpenDeals(limit, minAgeHours, newest) {

	try {
		const all = await getSummarizedActiveDeals();
		if (all == null) { return { 'success': false, 'error': 'Deal data not available', 'deals': [] }; }

		let list = all.filter(s => s && s.created);
		const minH = parseFloat(minAgeHours);
		if (!isNaN(minH) && minH > 0) { const cut = Date.now() - minH * 3600000; list = list.filter(s => new Date(s.created).getTime() <= cut); }
		list.sort((a, b) => newest === true
			? new Date(b.created).getTime() - new Date(a.created).getTime()
			: new Date(a.created).getTime() - new Date(b.created).getTime());

		const cap = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 25);
		const deals = list.slice(0, cap).map(s => ({ 'dealId': s.dealId, 'pair': s.pair, 'botName': s.botName, 'openForMins': s.openForMins, 'elapsed': s.elapsedHuman, 'safetyOrdersUsed': s.safetyOrdersUsed, 'safetyOrdersMax': s.safetyOrdersMax, 'averagePrice': s.averagePrice, 'targetPrice': s.targetPrice, 'paused': s.paused }));

		return { 'success': true, 'error': null, 'open_deals_total': all.length, 'deals': deals };
	}
	catch (e) { return { 'success': false, 'error': e.message, 'deals': [] }; }
}


// Open deals that have used most/all of their safety-order ladder (least DCA cushion),
// most-exhausted first. Reuses summarizeDeal's safetyOrdersUsed/Max/ladderExhausted.
async function findDealsNearMaxSafetyOrders(minUsedFraction, limit) {

	try {
		const all = await getSummarizedActiveDeals();
		if (all == null) { return { 'success': false, 'error': 'Deal data not available', 'deals': [] }; }

		let frac = parseFloat(minUsedFraction);
		if (isNaN(frac) || frac < 0 || frac > 1) { frac = 0.7; }

		const scored = all.filter(s => s && Number(s.safetyOrdersMax) > 0).map(s => ({ s: s, used: Number(s.safetyOrdersUsed) || 0, max: Number(s.safetyOrdersMax), ratio: (Number(s.safetyOrdersUsed) || 0) / Number(s.safetyOrdersMax) }));
		let list = scored.filter(x => x.ratio >= frac || x.s.ladderExhausted === true);
		list.sort((a, b) => b.ratio - a.ratio);

		const cap = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 25);
		const deals = list.slice(0, cap).map(x => ({ 'dealId': x.s.dealId, 'pair': x.s.pair, 'botName': x.s.botName, 'safetyOrdersUsed': x.used, 'safetyOrdersMax': x.max, 'ladderExhausted': x.s.ladderExhausted, 'openForMins': x.s.openForMins, 'elapsed': x.s.elapsedHuman, 'averagePrice': x.s.averagePrice, 'targetPrice': x.s.targetPrice }));

		return { 'success': true, 'error': null, 'open_deals_total': all.length, 'matched': list.length, 'threshold_used_fraction': frac, 'deals': deals };
	}
	catch (e) { return { 'success': false, 'error': e.message, 'deals': [] }; }
}


// Fuzzy-resolve a natural reference ("the BTC deal", "my newest deal") to concrete deal
// ids, so a follow-up tool can be called with an exact id. Cuts failed get_deal calls.
async function resolveDeal(reference) {

	try {
		const getDeals = getDealsFn();
		if (getDeals == null) { return { 'success': false, 'error': 'Deal data not available', 'matches': [] }; }

		const ref = String(reference || '').toLowerCase();
		const active = await getDeals({ 'status': STATUS_ACTIVE }, { 'limit': DEALS_SCAN_LIMIT, 'sort': { 'updatedAt': -1 } });
		const pool = (active || []).map(d => ({ 'dealId': d.dealId, 'pair': d.pair, 'botName': d.botName, 'status': 'active' }));

		const stop = ['the', 'my', 'deal', 'deals', 'newest', 'latest', 'oldest', 'losing', 'winning', 'open', 'last', 'recent', 'for', 'and', 'with', 'about', 'show', 'get'];
		const tokens = (ref.match(/[a-z0-9]{2,12}(?:\/[a-z0-9]{2,12})?/g) || []).filter(t => stop.indexOf(t) < 0);

		let matches = pool.filter(d => tokens.some(t => String(d.pair || '').toLowerCase().indexOf(t.split('/')[0]) >= 0));
		if (!matches.length && /(recent|newest|latest|last)/.test(ref)) { matches = pool.slice(0, 5); }
		else if (!matches.length && /old/.test(ref)) { matches = pool.slice(-5); }
		// A VAGUE reference with no concrete ticker token ("my deal", "show me a deal") → fall back to a few
		// candidates for the caller to choose from. But a reference that NAMES a coin which matched NOTHING
		// (e.g. "my DOGE deal" when no DOGE deal is open) must return EMPTY — a genuine no-match — so the caller
		// fails closed ("you don't have an open DOGE deal") instead of being handed unrelated deals and, in the
		// tool loop, spinning through them for many seconds and risking naming the wrong deal.
		else if (!matches.length && tokens.length === 0) { matches = pool.slice(0, 8); }

		matches = matches.slice(0, 10);
		return { 'success': true, 'error': null, 'reference': String(reference || ''), 'match_count': matches.length, 'matches': matches, 'note': matches.length === 1 ? 'Single match — use this dealId.' : (matches.length ? 'Multiple candidates — pick by pair/bot, or ask the user.' : 'No open deal matched; try a completed-deal tool or ask for the exact deal id.') };
	}
	catch (e) { return { 'success': false, 'error': e.message, 'matches': [] }; }
}


// Summarize the configured bots (not deals): which exist, which are active, and the
// key DCA settings a person asks about. Reads DCABot.getBots, the same source the
// rest of the application uses. Single exit.
async function getBotsSummary(activeOnly) {

	const getBots = (shareData && shareData.DCABot && typeof shareData.DCABot.getBots === 'function')
		? shareData.DCABot.getBots
		: null;

	let result = { 'success': false, 'error': 'Bot data not available', 'bots': [], 'count': 0 };

	if (getBots != null) {

		try {

			const query = (activeOnly === true) ? { 'active': true } : {};

			const docs = await getBots(query) || [];

			const bots = docs.map(b => {

				const c = (b && b.config) || {};

				return {
					'botName': b.botName,
					'active': b.active === true,
					'exchange': c.exchange || null,
					'sandbox': readBoolean(c.sandBox),
					'pairs': Array.isArray(c.pair) ? c.pair.length : (c.pair ? 1 : 0),
					'maxSafetyOrders': c.dcaMaxOrder != null ? Number(c.dcaMaxOrder) : null,
					'takeProfitPercent': c.dcaTakeProfitPercent != null ? Number(c.dcaTakeProfitPercent) : null,
					'priceStepPercent': c.dcaOrderStepPercent != null ? Number(c.dcaOrderStepPercent) : null,
					'firstOrderAmount': c.firstOrderAmount != null ? Number(c.firstOrderAmount) : null,
					'safetyOrderAmount': c.dcaOrderAmount != null ? Number(c.dcaOrderAmount) : null,
					'maxActiveDeals': c.dealMax != null ? Number(c.dealMax) : null,
					'startConditions': c.startConditions || null
				};
			});

			result = { 'success': true, 'error': null, 'bots': bots, 'count': bots.length };
		}
		catch (e) {

			result = { 'success': false, 'error': e.message, 'bots': [], 'count': 0 };
		}
	}

	return (result);
}


// The distinct exchange(s) the user actually trades on, read from their bot configs (config.exchange),
// with a live/sandbox flag per exchange. A dedicated single-value tool so a "which exchange(s) am I
// trading on?" answer is grounded in the real configured exchange rather than guessed. Single exit.
async function getExchanges() {

	const getBots = (shareData && shareData.DCABot && typeof shareData.DCABot.getBots === 'function')
		? shareData.DCABot.getBots
		: null;

	let result = { 'success': false, 'error': 'Bot data not available', 'exchanges': [], 'count': 0 };

	if (getBots != null) {

		try {

			const docs = await getBots({}) || [];

			const seen = new Map();   // exchange name → { exchange, live, sandbox }

			for (const b of docs) {

				const c = (b && b.config) || {};
				const ex = c.exchange ? String(c.exchange).toLowerCase() : null;

				if (!ex) { continue; }

				const rec = seen.get(ex) || { 'exchange': ex, 'live': false, 'sandbox': false };

				if (readBoolean(c.sandBox)) { rec.sandbox = true; } else { rec.live = true; }

				seen.set(ex, rec);
			}

			const exchanges = Array.from(seen.values());

			result = { 'success': true, 'error': null, 'exchanges': exchanges, 'count': exchanges.length };
		}
		catch (e) {

			result = { 'success': false, 'error': e.message, 'exchanges': [], 'count': 0 };
		}
	}

	return (result);
}


// The real order ladder for one deal: every FILLED order (base + each safety order
// actually placed) with its exact fill time and price, plus the next safety order
// that would fire. This is the authoritative source for per-order questions — the
// order objects carry dateFilled and price, which the logs do not expose cleanly, so
// answering "when did the first safety order fill" from here avoids mistaking an
// unrelated log event for the order. Single exit.
async function getDealOrders(dealId, orderNo) {

	const getDeals = getDealsFn();

	let result = { 'success': false, 'error': 'Deal data not available', 'found': false, 'filled_orders': [] };

	if (getDeals != null) {

		try {

			const docs = await getDeals({ 'dealId': dealId }, { 'limit': 1 });

			const d = (docs && docs[0]) || null;

			if (d == null) {

				result = { 'success': true, 'error': null, 'found': false, 'filled_orders': [] };
			}
			else {

				const orders = ordersToArray(d.orders);

				const reduce = (o) => ({
					'orderNo': o.orderNo,
					'kind': Number(o.orderNo) === 1 ? 'base' : ('safety#' + (Number(o.orderNo) - 1)),
					'price': o.price,
					'averagePrice': o.average,
					'targetPrice': o.target,
					'amount': o.amount,
					'quantity': o.qty,
					'filled': (o.filled === 1 || o.filled === true),
					'dateFilled': (o.filled === 1 || o.filled === true) ? (o.dateFilled || null) : null
				});

				const filledAll = orders.filter(o => o && (o.filled === 1 || o.filled === true));
				const nextUnfilled = orders.find(o => o && !(o.filled === 1 || o.filled === true));

				// Deals can accumulate dozens of safety orders; the full ladder would
				// overflow the tool result cap. Show the most recent ORDERS_CAP filled
				// orders while reporting the true totals, so the model still narrates
				// accurately (mirrors the ladder cap in reconcileDeal).
				const ORDERS_CAP = 25;
				const filled = filledAll.slice(-ORDERS_CAP);

				result = {
					'success': true,
					'error': null,
					'found': true,
					'dealId': d.dealId,
					'pair': d.pair,
					'filled_orders': filled.map(reduce),
					'filled_orders_shown': filled.length,
					'filled_orders_total': filledAll.length,
					// Pre-computed answer using the user's own vocabulary ("used"), so the reply reads it
					// directly instead of (mis)counting the ladder — base order excluded from the count.
					'safety_orders_used': Math.max(filledAll.length - 1, 0),
					'safety_orders_placed': Math.max(filledAll.length - 1, 0),
					'next_safety_order': nextUnfilled ? reduce(nextUnfilled) : null,
					'total_orders_in_ladder': orders.length
				};

				// A specific ladder position was asked for (e.g. "the fourth order").
				// Return that exact order even if it has not filled yet, since the
				// filled_orders list alone cannot answer a question about a future rung.
				const n = parseInt(orderNo, 10);

				if (!isNaN(n) && n > 0) {

					const match = orders.find(o => o && Number(o.orderNo) === n);

					result.requested_order_no = n;
					result.requested_order = match ? reduce(match) : null;
				}
			}
		}
		catch (e) {

			result = { 'success': false, 'error': e.message, 'found': false, 'filled_orders': [] };
		}
	}

	return (result);
}


// Current exposure across open deals: how much is deployed now (filled orders), the
// maximum that would be committed if every safety order fills, and available funds
// from the cached balance tracker. All from deal data + the balance cache — no live
// price and no exchange call. Single exit.
// Free balance per currency from the cache, summed across exchanges. Never a live
// exchange call. Shared by the portfolio and exposure summaries so both read the same
// numbers. Returns null when no balance cache is available. Single exit.
function computeAvailableBalances() {


	const balFn = (shareData && shareData.DCABot && typeof shareData.DCABot.getBalanceCache === 'function')
		? shareData.DCABot.getBalanceCache
		: null;

	let available = null;

	if (balFn) {

		const cache = balFn() || {};
		available = {};

		for (const k of Object.keys(cache)) {

			if (k === 'updated') { continue; }

			const b = cache[k];
			if (!b || typeof b !== 'object') { continue; }

			for (const cur of Object.keys(b)) {

				const v = b[cur];
				if (v && typeof v === 'object' && Number(v.free) > 0) {

					available[cur] = round2((available[cur] || 0) + Number(v.free));
				}
			}
		}
	}

	return (available);
}


async function getPortfolioSummary() {

	const getDeals = getDealsFn();


	let result = { 'success': false, 'error': 'Deal data not available' };

	if (getDeals != null) {

		try {

			const docs = await getDeals({ 'status': STATUS_ACTIVE }, { 'limit': DEALS_SCAN_LIMIT, 'sort': { 'updatedAt': -1 } });

			// Bucket committed/deployed funds by the deal's QUOTE currency. Amounts in different quote
			// currencies (e.g. USDT vs BTC) must never be added into one scalar — 0.01 BTC is not 0.01
			// USDT. The completed-deal path already buckets this way; do the same here so a mixed-currency
			// account gets a per-currency breakdown instead of a nonsensical mixed total.
			const deployedByCur = {};
			const committedByCur = {};
			let filledOrders = 0;

			for (const d of (docs || [])) {

				const cur = quoteCurrency(d.pair);
				const orders = ordersToArray(d.orders);

				for (const o of orders) {

					const amt = Number(o && (o.amount != null ? o.amount : o.sum));

					if (isNaN(amt)) { continue; }

					committedByCur[cur] = (committedByCur[cur] || 0) + amt;

					if (o.filled === 1 || o.filled === true) { deployedByCur[cur] = (deployedByCur[cur] || 0) + amt; filledOrders++; }
				}
			}

			const curs = new Set([ ...Object.keys(deployedByCur), ...Object.keys(committedByCur) ]);
			const singleCur = curs.size <= 1;
			const deployedTotal = Object.values(deployedByCur).reduce((a, b) => a + b, 0);
			const committedTotal = Object.values(committedByCur).reduce((a, b) => a + b, 0);
			const roundMap = (m) => { const out = {}; for (const k of Object.keys(m)) { out[k] = round2(m[k]); } return out; };

			// Available funds: the free balance per currency from the cache, summed
			// across exchanges. Never a live exchange call.
			const available = computeAvailableBalances();
			// When no balance is cached this is null / {}. Return it EXPLICITLY as null with a note,
			// so the model reports "available funds unavailable" instead of silently echoing the
			// deployed figure for it (which is how "available == deployed" showed up in testing).
			const availEmpty = !available || (typeof available === 'object' && Object.keys(available).length === 0);

			result = {
				'success': true,
				'error': null,
				'open_deals': (docs || []).length,
				// Single scalar ONLY when every open deal shares one quote currency (the common case);
				// otherwise null with the per-currency breakdowns below.
				'deployed_funds': singleCur ? round2(deployedTotal) : null,
				'max_committed_if_all_safety_orders_fill': singleCur ? round2(committedTotal) : null,
				'quote_currency': singleCur ? ([ ...curs ][0] || null) : null,
				'filled_orders': filledOrders,
				'available_funds': availEmpty ? null : available
			};

			if (!singleCur) {
				result.deployed_by_currency = roundMap(deployedByCur);
				result.max_committed_by_currency = roundMap(committedByCur);
				result.note = 'Open deals span multiple quote currencies, so there is no single deployed-funds total; deployed_by_currency and max_committed_by_currency give the per-currency figures. Never add different currencies together.';
			}

			if (availEmpty) {
				result.available_funds_note = 'Wallet balance data is not currently available, so available (uncommitted / dry-powder) funds cannot be reported. Do NOT infer or estimate it — in particular it is NOT equal to deployed_funds.';
			}
		}
		catch (e) {

			result = { 'success': false, 'error': e.message };
		}
	}

	return (result);
}


// Rank pairs by profitability over a window, from completed deals. Reuses
// getProcessedDeals (same figures as the deals-history view) and groups by pair.
// Single exit.
async function getPairPerformance(dateFrom, dateTo, limit, topN, order) {

	const getDeals = getDealsFn();

	const processFn = (shareData && shareData.DCABotManager && typeof shareData.DCABotManager.getProcessedDeals === 'function')
		? shareData.DCABotManager.getProcessedDeals
		: null;

	const capped = Math.min(Math.max(parseInt(limit, 10) || 500, 1), DEALS_SCAN_LIMIT);
	const cap = Math.min(Math.max(parseInt(topN, 10) || 20, 1), 50);


	let result = { 'success': false, 'error': 'Deal data not available', 'pairs': [], 'count': 0 };

	if (getDeals != null && processFn != null) {

		try {

			const query = { 'status': STATUS_COMPLETE };

			const range = {};

			if (dateFrom instanceof Date && !isNaN(dateFrom.getTime())) { range.$gte = dateFrom; }
			if (dateTo instanceof Date && !isNaN(dateTo.getTime())) { range.$lte = dateTo; }
			// Window on the deal's CLOSE date (sellData.date), never updatedAt: updatedAt records
			// the last write and a migration or re-save can bump every deal to "now", which would
			// pull the entire history into any "last week / this month" window. sellData.date is
			// the immutable close timestamp — the correct field for "deals that closed in a period".
			if (Object.keys(range).length) { query['sellData.date'] = range; }

			// Aggregate per pair at the DATABASE over EVERY matching deal — not a capped in-memory sample —
			// so all-time "most profitable pair" is exact and never misses an old big winner (the sampled
			// getProcessedDeals path ranked only the recent ~500, so an old $19k pair lost to a recent $2 one).
			// Same per-pair $group getPerformanceSummary uses; profitSum is dollars (sellData.profitQuote).
			const agg = await getDeals(null, null, null, [
				{ '$match': query },
				{ '$group': {
					'_id':       '$pair',
					'deals':     { '$sum': 1 },
					'profitSum': { '$sum': { '$toDouble': { '$ifNull': [ '$sellData.profitQuote', 0 ] } } },
					'pctSum':    { '$sum': { '$toDouble': { '$ifNull': [ '$sellData.profit', 0 ] } } },
					'wins':      { '$sum': { '$cond': [ { '$gt': [ { '$toDouble': { '$ifNull': [ '$sellData.profit', 0 ] } }, 0 ] }, 1, 0 ] } }
				} }
			]);

			// undefined from getDeals is a swallowed query error, not "no pairs" — fail so the tool reports it
			// (see the same guard in getBotPerformance) instead of the model announcing a false "no data".
			if (agg === undefined) { throw new Error('Deal data temporarily unavailable (query failed)'); }

			const all = agg.map(row => {
				const deals = Number(row.deals) || 0;
				return {
					'pair': row._id,
					'deals': deals,
					'total_profit': round2(Number(row.profitSum) || 0),
					'avg_profit_percent': deals ? round2((Number(row.pctSum) || 0) / deals) : 0,
					'win_rate_percent': deals ? round2((Number(row.wins) || 0) / deals * 100) : 0
				};
			});

			// Single best/worst by profit, always included so "best and worst pair" is
			// answerable in one call regardless of the requested ordering or cap.
			let bestPair = null;
			let worstPair = null;

			for (const p of all) {

				if (bestPair == null || p.total_profit > bestPair.total_profit) { bestPair = p; }
				if (worstPair == null || p.total_profit < worstPair.total_profit) { worstPair = p; }
			}

			// Ordering: most active (by deal count), least profitable (asc), or most
			// profitable (desc, default).
			const sorter = (order === 'most_active')
				? ((a, b) => b.deals - a.deals)
				: (order === 'least_profitable')
					? ((a, b) => a.total_profit - b.total_profit)
					: ((a, b) => b.total_profit - a.total_profit);

			const orderName = (order === 'most_active') ? 'most_active' : (order === 'least_profitable') ? 'least_profitable' : 'most_profitable';

			const pairs = all.slice().sort(sorter).slice(0, cap);

			result = { 'success': true, 'error': null, 'order': orderName, 'pairs': pairs, 'best_pair': bestPair, 'worst_pair': worstPair, 'count': all.length, 'shown': pairs.length };
		}
		catch (e) {

			result = { 'success': false, 'error': e.message, 'pairs': [], 'count': 0 };
		}
	}

	return (result);
}


// Live status of each open deal, read from DCABot's deal tracker — the same
// per-tick snapshot the deals view uses. Its `info` carries the current price,
// unrealized profit and profit % already computed by SymBot's own calculation
// (fees included), so this reuses those figures rather than a second, slightly
// different one. Distance to the next safety order comes from the deal's own order
// ladder. A deal without a live tracker snapshot is flagged priceStale so a number
// is never shown as live when it is not. Single exit.
async function computeOpenDealsLive(limit) {

	const getDeals = getDealsFn();

	const trackerFn = (shareData && shareData.DCABot && typeof shareData.DCABot.getDealTracker === 'function')
		? shareData.DCABot.getDealTracker
		: null;

	const capped = Math.min(Math.max(parseInt(limit, 10) || DEALS_SCAN_LIMIT, 1), DEALS_SCAN_LIMIT);

	const round = (n, d) => { const f = Math.pow(10, d == null ? 2 : d); return Math.round(n * f) / f; };

	let result = { 'success': false, 'error': 'Deal data not available', 'deals': [], 'priced': 0, 'stale': 0, 'totalUnrealized': 0, 'biggestGain': null, 'biggestLoss': null };

	if (getDeals != null) {

		try {

			const docs = await getDeals({ 'status': STATUS_ACTIVE }, { 'limit': capped, 'sort': { 'updatedAt': -1 } });

			const trackers = trackerFn ? ((await trackerFn()) || {}) : {};

			let totalUnrealized = 0;
			const unrealizedByCur = {};   // quote currency -> summed unrealized P/L (never mixed into one scalar)
			let priced = 0;
			let stale = 0;

			const deals = (docs || []).map(d => {

				const dealCur = quoteCurrency(d.pair);
				const orders = ordersToArray(d.orders);
				const filled = orders.filter(o => o && (o.filled === 1 || o.filled === true));
				const nextUnfilled = orders.find(o => o && !(o.filled === 1 || o.filled === true));
				const nextSOPrice = nextUnfilled ? Number(nextUnfilled.price) : null;

				const info = trackers[d.dealId] && trackers[d.dealId].info;
				const live = info && info.price_last != null && Number(info.price_last) > 0;

				const row = {
					'dealId': d.dealId,
					'pair': d.pair,
					'quoteCurrency': dealCur,
					'exchange': d.exchange,
					'safetyOrdersUsed': (live && info.safety_orders_used != null) ? info.safety_orders_used : Math.max(filled.length - 1, 0),
					'nextSafetyOrderPrice': nextSOPrice,
					'priceStale': !live
				};

				if (live) {

					const current = Number(info.price_last);

					row.currentPrice = current;
					row.averagePrice = info.price_average != null ? Number(info.price_average) : null;
					row.targetPrice = info.price_target != null ? Number(info.price_target) : null;

					// Unrealized P/L and % come straight from SymBot's own calculation,
					// so they match the deals view rather than a second computation here.
					if (info.profit != null && !isNaN(Number(info.profit))) {

						row.unrealizedPnl = round(Number(info.profit), 2);
						row.inProfit = Number(info.profit) > 0;
						totalUnrealized += Number(info.profit);
						unrealizedByCur[dealCur] = (unrealizedByCur[dealCur] || 0) + Number(info.profit);
						priced++;
					}

					if (info.profit_percentage != null && !isNaN(Number(info.profit_percentage))) {

						row.unrealizedPct = round(Number(info.profit_percentage), 2);
					}

					// How far the price must still rise to reach take-profit, and how far
					// it must fall to trigger the next safety order. Smaller = closer.
					// The booleans give the model an unambiguous ready/near signal so it
					// does not have to interpret the sign of the percentage itself.
					if (row.targetPrice) {

						row.pctToTakeProfit = round((row.targetPrice - current) / current * 100, 2);
						row.readyToTakeProfit = current >= row.targetPrice;
					}

					if (nextSOPrice) {

						row.pctToNextSafetyOrder = round((current - nextSOPrice) / current * 100, 2);
						row.nextSafetyOrderReady = current <= nextSOPrice;
					}
				}
				else {

					stale++;
				}

				return row;
			});

			// Sort worst-first by unrealized P/L so "rank my deals" and "which lost most"
			// read directly; deals without a live price sink to the end.
			deals.sort((a, b) => {
				const av = (a.unrealizedPnl == null) ? Infinity : a.unrealizedPnl;
				const bv = (b.unrealizedPnl == null) ? Infinity : b.unrealizedPnl;
				return av - bv;
			});

			// Single biggest gainer / loser, so "which deal gained/bled the most" is answerable without the
			// model re-scanning the list. In ONE quote currency, "biggest" is by dollars (as before). Across
			// currencies, dollar amounts are not comparable (0.01 BTC is not 100 USDT), so rank by unrealized
			// PERCENT instead — a currency-agnostic measure — so the winner/loser is never mis-picked.
			const curKeys = Object.keys(unrealizedByCur);
			const singleCur = curKeys.length <= 1;
			const magOf = (r) => singleCur ? r.unrealizedPnl : (r.unrealizedPct != null ? r.unrealizedPct : null);

			let biggestGain = null;
			let biggestLoss = null;

			for (const r of deals) {

				const m = magOf(r);
				if (m == null) { continue; }

				if (biggestGain == null || m > magOf(biggestGain)) { biggestGain = r; }
				if (biggestLoss == null || m < magOf(biggestLoss)) { biggestLoss = r; }
			}

			// Rank by closeness to take-profit: smallest pctToTakeProfit first (a deal already
			// at/over target has pctToTakeProfit <= 0 and sorts to the very top). This is what
			// "closest to profit / which deals will close soonest" actually means — the price's
			// distance to its own target — and it is DIFFERENT from ranking by unrealized P/L in
			// dollars: a deal with a large dollar loss can still sit a hair below its take-profit
			// (many safety orders in, target pulled down close to price), while a small-dollar
			// loss can be far from target. Ranking by dollars answers the wrong question here.
			// Computed over ALL open deals (like biggestGain/biggestLoss) so the answer is correct
			// even when the deal list is later capped for size. Compact entries keep it small.
			// Aggregate in-profit / underwater counts over PRICED open deals, so "how many of my open deals
			// are in profit / underwater?" is answered from one field instead of the weak model mis-counting a
			// per-deal list. Break-even (exactly 0) is neither; stale-price deals are excluded (live P/L unknown).
			// Currency-agnostic: a sign count, never a sum.
			let inProfitCount = 0, underwaterCount = 0;
			for (const r of deals) {
				if (r.priceStale === true) { continue; }
				if (r.inProfit === true) { inProfitCount++; }
				else if ((r.unrealizedPnl != null && r.unrealizedPnl < 0) || (r.unrealizedPct != null && r.unrealizedPct < 0)) { underwaterCount++; }
			}

			const closestToTakeProfit = deals
				.filter(r => r.pctToTakeProfit != null)
				.sort((a, b) => a.pctToTakeProfit - b.pctToTakeProfit)
				.map(r => ({
					'dealId': r.dealId,
					'pair': r.pair,
					'pctToTakeProfit': r.pctToTakeProfit,
					'readyToTakeProfit': r.readyToTakeProfit === true,
					'unrealizedPnl': r.unrealizedPnl != null ? r.unrealizedPnl : null,
					'unrealizedPct': r.unrealizedPct != null ? r.unrealizedPct : null,
					'inProfit': r.inProfit === true,
					// Real per-deal detail carried for EVERY deal (already computed on r) so a "detail on all
					// deals" answer has the true price/average/target/safety figures and never has to invent a
					// placeholder for a deal not in the size-capped `deals` array. null (not 0) when unavailable.
					'currentPrice': r.currentPrice != null ? r.currentPrice : null,
					'averagePrice': r.averagePrice != null ? r.averagePrice : null,
					'targetPrice': r.targetPrice != null ? r.targetPrice : null,
					'safetyOrdersUsed': r.safetyOrdersUsed != null ? r.safetyOrdersUsed : null,
					'nextSafetyOrderPrice': r.nextSafetyOrderPrice != null ? r.nextSafetyOrderPrice : null,
					'priceStale': r.priceStale === true
				}));

			result = {
				'success': true,
				'error': null,
				'deals': deals,
				'priced': priced,
				'stale': stale,
				// A single unrealized-P/L total ONLY when every open deal shares one quote currency; otherwise
				// null with the per-currency breakdown, so different currencies are never summed into one figure.
				'totalUnrealized': singleCur ? round2(totalUnrealized) : null,
				'unrealized_currency': singleCur ? (curKeys[0] || null) : null,
				'inProfit': inProfitCount,
				'underwater': underwaterCount,
				'biggestGain': biggestGain,
				'biggestLoss': biggestLoss,
				'closestToTakeProfit': closestToTakeProfit
			};

			if (!singleCur) {
				const m = {}; for (const k of curKeys) { m[k] = round2(unrealizedByCur[k]); }
				result.unrealizedByCurrency = m;
				result.note = 'Open deals span multiple quote currencies, so there is no single total unrealized P/L (see unrealizedByCurrency). biggestGain/biggestLoss are ranked by unrealized PERCENT, not amount, because amounts in different currencies are not comparable.';
			}
		}
		catch (e) {

			result = { 'success': false, 'error': e.message, 'deals': [], 'priced': 0, 'stale': 0, 'totalUnrealized': 0, 'biggestGain': null, 'biggestLoss': null };
		}
	}

	return (result);
}


// Live status of every open deal (see computeOpenDealsLive). Keeps the result within
// the model's size budget: with many open deals and a full live-price row each, a flat
// list can exceed the caller's char cap and be truncated to nothing, so this includes
// the worst-first deals that fit and reports the true total — mirroring get_deal_orders
// / get_deal_timeline. The totals and biggest_gain/biggest_loss always cover ALL open
// deals, so ranking and aggregate answers stay correct even when the list is capped.
// Single exit.
async function getOpenDealsStatus(limit) {

	const core = await computeOpenDealsLive(limit);

	if (!core || core.success !== true) {

		return { 'success': false, 'error': (core && core.error) || 'Deal data not available', 'deals': [] };
	}

	const deals = core.deals;

	const ROW_BUDGET = 4200;

	const shown = [];
	let usedChars = 0;

	for (const r of deals) {

		const sz = JSON.stringify(r).length + 1;

		if (shown.length >= 1 && (usedChars + sz) > ROW_BUDGET) { break; }

		shown.push(r);
		usedChars += sz;
	}

	// Pre-ranked "nearest take-profit" list (see computeOpenDealsLive) so a "which deals are
	// closest to profit / will close soonest" question is answered directly from this field,
	// rather than the model re-ranking the size-capped deals list by the wrong metric (dollars).
	// Carries full per-deal detail (price/average/target/safety orders) for EVERY deal, so a "detail on all
	// deals" answer never has to fall back to the size-capped `deals` array. Capped generously for context
	// size; the note flags if more deals exist than are listed here.
	const closest = Array.isArray(core.closestToTakeProfit) ? core.closestToTakeProfit.slice(0, 30) : [];

	const result = {
		'success': true,
		'error': null,
		'open_deals': deals.length,
		'open_deals_total': deals.length,
		'deals_shown': shown.length,
		'priced_deals': core.priced,
		'stale_price_deals': core.stale,
		'open_deals_in_profit': core.inProfit,
		'open_deals_underwater': core.underwater,
		...openUnrealizedFields(core),
		'biggest_gain': core.biggestGain,
		'biggest_loss': core.biggestLoss,
		'closest_to_take_profit': closest,
		'deals': shown
	};

	// Per-deal detail source for a "how are all my deals doing (in detail)" answer: `closest_to_take_profit`
	// now carries the REAL price / average / target / safety-order figures for every deal it lists, so there
	// is no reason to read those from the size-capped `deals` array or to invent them.
	result.per_deal_detail_note = 'For per-deal detail (price, average, target, safety orders, next safety order, unrealized P/L, % to take-profit) use `closest_to_take_profit` — it carries the REAL figures for every deal listed there. NEVER output 0, 0.000000, null, or any placeholder as a deal\'s price/average/target/safety figure: if a value is null it was not available (e.g. a stale price), so omit that line or say it was not retrieved for that deal — do not print a fabricated number. When the user asks how ALL their deals are doing, or for a detailed breakdown / "tell me more", cover EVERY deal in `closest_to_take_profit` — it is the COMPLETE list of open deals with full figures (ordered by nearness to take-profit), so do NOT stop after the first few nearest-to-profit ones, and always include the biggest_loss and biggest_gain deals by name (the biggest loss is often furthest from take-profit and sorts last).';

	if (closest.length < deals.length) {

		result.per_deal_detail_note += ' Only the ' + closest.length + ' deals in `closest_to_take_profit` are listed with detail (of ' + deals.length + ' open); do NOT invent detail for the remaining ' + (deals.length - closest.length) + ' — name them and give only the account-wide figures (total_unrealized_pnl, biggest_gain, biggest_loss) that cover every deal, and suggest asking about a specific deal for its detail.';
	}

	if (shown.length < deals.length) {

		result.note = 'The `deals` array is capped to the ' + shown.length + ' worst-by-unrealized-loss of ' + deals.length + ' open deals for size — but this is NOT a truncated answer, because the ranked helper fields already cover ALL ' + deals.length + ' open deals: `closest_to_take_profit` is the full detail+ranking list of every deal nearest to taking profit (use it directly for "which deals will close soon / soonest / are most likely to close" AND for per-deal detail), and total_unrealized_pnl / biggest_gain / biggest_loss are computed over every open deal. Answer ranking questions from those fields, not from the capped `deals` array — do not ask for a smaller range.';
	}

	return (result);
}


// Focused answer for "which deals are closest to profit / will close soon / soonest / are
// most likely to close". Returns ONLY the ranked nearest-take-profit list (closest first) —
// no worst-first deals array to distract a weaker model into ranking by dollar loss. Reuses
// the same computation as get_open_deals_status so the figures match. Single exit.
async function getDealsClosestToTakeProfit(limit) {

	const core = await computeOpenDealsLive(DEALS_SCAN_LIMIT);

	if (!core || core.success !== true) {

		return { 'success': false, 'error': (core && core.error) || 'Deal data not available', 'deals': [] };
	}

	const n = (typeof limit === 'number' && limit > 0) ? Math.min(limit, 25) : 10;
	const ranked = Array.isArray(core.closestToTakeProfit) ? core.closestToTakeProfit.slice(0, n) : [];

	return {
		'success': true,
		'error': null,
		'open_deals': core.deals.length,
		'note': 'Open deals nearest to their take-profit target, closest first (smallest pctToTakeProfit). This IS the ranked list of deals most likely to close soon — list these entries in order. A negative pctToTakeProfit / readyToTakeProfit=true means the deal is already at or over its target.',
		'deals': ranked
	};
}


// Risk snapshot across open deals: how much is underwater and by how much, plus the
// stop-loss picture. Reuses getOpenDealsStatus for the per-deal unrealized P/L (so the
// figures match the deals view) and adds banded underwater counts and the stop-loss
// state read from the same live tracker. Answers "how much am I underwater", "how many
// deals are deep in the red", and "which deals are near their stop-loss" in one call.
// Single exit.
async function getOpenRiskSummary(nearStopLossPct) {

	// Use the uncapped compute (not getOpenDealsStatus, whose deal list is trimmed for
	// size) so the underwater band counts cover EVERY open deal, not just those shown.
	const core = await computeOpenDealsLive(DEALS_SCAN_LIMIT);

	if (!core || core.success !== true) {

		return { 'success': false, 'error': (core && core.error) || 'Deal data not available' };
	}

	const trackerFn = (shareData && shareData.DCABot && typeof shareData.DCABot.getDealTracker === 'function')
		? shareData.DCABot.getDealTracker
		: null;

	const trackers = trackerFn ? ((await trackerFn()) || {}) : {};

	const round = round2;   // reuse the file's canonical 2-dp rounder (display only)

	// How close (in %) a deal's price must be to its stop-loss to count as "near".
	// Clamp a bad value to a sane default so the band is never nonsense.
	let nearPct = Number(nearStopLossPct);
	if (isNaN(nearPct) || nearPct <= 0 || nearPct > 50) { nearPct = 3; }

	let band2 = 0;
	let band5 = 0;
	let band10 = 0;

	const stopLossArmed = [];
	const nearStopLoss = [];

	for (const r of core.deals) {

		if (r.unrealizedPct != null) {

			if (r.unrealizedPct <= -2) { band2++; }
			if (r.unrealizedPct <= -5) { band5++; }
			if (r.unrealizedPct <= -10) { band10++; }
		}

		const info = trackers[r.dealId] && trackers[r.dealId].info;

		if (info && info.stop_loss_enabled) {

			const slPrice = info.stop_loss_price != null ? Number(info.stop_loss_price) : null;

			const sl = {
				'dealId': r.dealId,
				'pair': r.pair,
				'stopLossPrice': slPrice,
				'armed': info.stop_loss_armed === true,
				'trailing': info.stop_loss_trailing === true
			};

			if (sl.armed) { stopLossArmed.push(sl); }

			// Only meaningful while price is still above the stop; a smaller gap is
			// closer to triggering.
			if (slPrice && r.currentPrice && r.currentPrice > 0) {

				const pctAboveStop = (r.currentPrice - slPrice) / r.currentPrice * 100;

				if (pctAboveStop >= 0 && pctAboveStop <= nearPct) {

					nearStopLoss.push(Object.assign({}, sl, {
						'currentPrice': r.currentPrice,
						'pctAboveStop': round(pctAboveStop)
					}));
				}
			}
		}
	}

	nearStopLoss.sort((a, b) => a.pctAboveStop - b.pctAboveStop);

	return {
		'success': true,
		'error': null,
		'open_deals': core.deals.length,
		'priced_deals': core.priced,
		'stale_price_deals': core.stale,
		'open_deals_in_profit': core.inProfit,
		'open_deals_underwater': core.underwater,
		...openUnrealizedFields(core),
		'underwater_over_2pct': band2,
		'underwater_over_5pct': band5,
		'underwater_over_10pct': band10,
		'worst_deal': core.biggestLoss,
		'stop_loss_armed_count': stopLossArmed.length,
		'stop_loss_armed': stopLossArmed.slice(0, 15),
		'near_stop_loss_threshold_pct': nearPct,
		'near_stop_loss': nearStopLoss.slice(0, 15)
	};
}


// Drawdown/risk snapshot for the sentinel recipe: the specific open deals that are UNDERWATER past a
// threshold (worst-first, with their unrealized %/$ and safety orders used) and the deals whose
// safety-order LADDER is nearly exhausted. Read-only; composes the uncapped live compute with the
// existing near-max-safety scan so the two share one definition. Returns the lists plus the totals,
// so a caller can alert only when something actually breaches (empty lists ⇒ nothing to flag).
// Aggregate the ORDER usage across all currently-OPEN deals, at the database, so "how many safety
// orders are used across my open deals" is answered by a single exact figure rather than the model
// trying (and fumbling) to sum a per-deal list itself. A safety order is a filled order with
// orderNo != 1; the base order is orderNo == 1. Read-only. Single exit.
async function getOpenOrdersSummary(topN) {

	const getDeals = getDealsFn();
	const cap = Math.min(Math.max(parseInt(topN, 10) || 5, 1), 25);

	let result = { 'success': false, 'error': 'Deal data not available', 'open_deals': 0 };

	if (getDeals != null) {

		try {

			const filledSafety = { '$size': { '$filter': { 'input': { '$ifNull': [ '$orders', [] ] }, 'as': 'o',
				'cond': { '$and': [ { '$ne': [ '$$o.orderNo', 1 ] }, { '$ne': [ { '$ifNull': [ '$$o.dateFilled', null ] }, null ] } ] } } } };
			const filledBase = { '$size': { '$filter': { 'input': { '$ifNull': [ '$orders', [] ] }, 'as': 'o',
				'cond': { '$and': [ { '$eq': [ '$$o.orderNo', 1 ] }, { '$ne': [ { '$ifNull': [ '$$o.dateFilled', null ] }, null ] } ] } } } };

			const rows = await getDeals(null, null, null, [
				{ '$match': { 'status': STATUS_ACTIVE } },
				{ '$project': { 'pair': 1, 'dealId': 1, 'safety': filledSafety, 'base': filledBase } }
			]);

			// undefined ⇒ a swallowed query error (see the getBotPerformance guard) — report it, don't
			// pretend there are zero open orders.
			if (rows === undefined) { throw new Error('Deal data temporarily unavailable (query failed)'); }

			const list = rows || [];
			let totalSafety = 0, totalBase = 0, maxSafety = 0;
			for (const r of list) {
				totalSafety += Number(r.safety) || 0;
				totalBase += Number(r.base) || 0;
				if ((Number(r.safety) || 0) > maxSafety) { maxSafety = Number(r.safety) || 0; }
			}

			const byDeal = list.slice()
				.sort((a, b) => (Number(b.safety) || 0) - (Number(a.safety) || 0))
				.slice(0, cap)
				.map(r => ({ 'dealId': r.dealId, 'pair': r.pair, 'safety_orders': Number(r.safety) || 0 }));

			result = {
				'success': true,
				'error': null,
				'open_deals': list.length,
				'total_safety_orders': totalSafety,
				'total_base_orders': totalBase,
				'total_orders': totalSafety + totalBase,
				'avg_safety_orders_per_deal': list.length ? round2(totalSafety / list.length) : 0,
				'max_safety_orders': maxSafety,
				'by_deal': byDeal
			};
		}
		catch (e) { result = { 'success': false, 'error': e.message, 'open_deals': 0 }; }
	}

	return result;
}


async function getDrawdownRisk(underwaterPct, soUsedFraction, limit) {

	const uw = Number(underwaterPct);
	const threshold = (isNaN(uw) || uw <= 0 || uw > 100) ? 10 : uw;   // default: 10% underwater
	const cap = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 25);

	const core = await computeOpenDealsLive(DEALS_SCAN_LIMIT);
	if (!core || core.success !== true) {
		return { 'success': false, 'error': (core && core.error) || 'Deal data not available' };
	}

	const round = round2;   // reuse the file's canonical 2-dp rounder (display only)

	const underwater = core.deals
		.filter(d => d.unrealizedPct != null && d.unrealizedPct <= -threshold)
		.sort((a, b) => a.unrealizedPct - b.unrealizedPct)   // most negative (worst) first
		.slice(0, cap)
		.map(d => ({
			'dealId': d.dealId, 'pair': d.pair,
			'unrealizedPct': d.unrealizedPct,
			'unrealizedPnl': d.unrealizedPnl != null ? d.unrealizedPnl : null,
			'safetyOrdersUsed': d.safetyOrdersUsed
		}));

	// Ladder nearly exhausted — reuse the existing near-max-safety scan (one definition of "near max").
	const nearMax = await findDealsNearMaxSafetyOrders(soUsedFraction, cap);
	const nearMaxDeals = (nearMax && nearMax.success && Array.isArray(nearMax.deals)) ? nearMax.deals : [];

	return {
		'success': true, 'error': null,
		'underwater_threshold_pct': threshold,
		'so_used_threshold': (nearMax && nearMax.threshold_used_fraction != null) ? nearMax.threshold_used_fraction : null,
		'open_deals': core.deals.length,
		...openUnrealizedFields(core),
		'underwater': underwater,
		'underwater_count': underwater.length,
		'near_max_safety': nearMaxDeals,
		'near_max_safety_count': nearMaxDeals.length
	};
}


// Capital exposure of open deals, bucketed by quote currency (default) or by pair:
// deployed now, the maximum committed if every remaining safety order fills, and the
// extra funds that would take — joined against the available balance for that currency
// so a potential shortfall is flagged. Reuses the same active-deal order scan as
// getPortfolioSummary and the shared balance cache. Single exit.
async function getExposureSummary(groupBy) {

	const getDeals = getDealsFn();


	const by = (String(groupBy || '').toLowerCase() === 'pair') ? 'pair' : 'quote';

	let result = { 'success': false, 'error': 'Deal data not available' };

	if (getDeals != null) {

		try {

			const docs = await getDeals({ 'status': STATUS_ACTIVE }, { 'limit': DEALS_SCAN_LIMIT, 'sort': { 'updatedAt': -1 } });

			const buckets = {};

			for (const d of (docs || [])) {

				const quote = quoteCurrency(d.pair);
				const key = (by === 'pair') ? (d.pair || '?') : quote;

				if (!buckets[key]) {

					buckets[key] = { 'key': key, 'quote_currency': quote, 'open_deals': 0, 'deployed_now': 0, 'max_if_all_fill': 0 };
				}

				const b = buckets[key];
				b.open_deals++;

				const orders = ordersToArray(d.orders);

				for (const o of orders) {

					const amt = Number(o && (o.amount != null ? o.amount : o.sum));

					if (isNaN(amt)) { continue; }

					b.max_if_all_fill += amt;

					if (o.filled === 1 || o.filled === true) { b.deployed_now += amt; }
				}
			}

			const available = computeAvailableBalances();

			const groups = Object.keys(buckets).map(k => {

				const b = buckets[k];
				const avail = (available && available[b.quote_currency] != null) ? available[b.quote_currency] : null;
				const additional = round2(b.max_if_all_fill - b.deployed_now);

				const row = {
					'group': b.key,
					'quote_currency': b.quote_currency,
					'open_deals': b.open_deals,
					'deployed_now': round2(b.deployed_now),
					'max_if_all_fill': round2(b.max_if_all_fill),
					'additional_needed_if_all_fill': additional,
					'available_funds': avail
				};

				if (avail != null) {

					row.headroom_after_all_fill = round2(avail - additional);
					row.potential_shortfall = (avail - additional) < 0;
				}

				return row;
			}).sort((a, b) => b.max_if_all_fill - a.max_if_all_fill);

			result = {
				'success': true,
				'error': null,
				'grouped_by': by,
				'groups': groups,
				'available_funds': available
			};
		}
		catch (e) {

			result = { 'success': false, 'error': e.message };
		}
	}

	return (result);
}


// Reconcile a deal: do the "what happened" analysis in code so the model only has to
// narrate it. Returns the identity, an enriched fill ladder (running average, running
// cost, and the gap between fills), the outcome (completed) or live P/L (open), and a
// list of pre-computed plain-language findings. Single exit.
async function reconcileDeal(dealId) {

	const getDeals = getDealsFn();

	let result = { 'success': false, 'error': 'Deal data not available', 'found': false };

	if (getDeals == null) { return (result); }

	try {

		const docs = await getDeals({ 'dealId': dealId }, { 'limit': 1 });
		const deal = (docs && docs[0]) || null;

		if (deal == null) { return ({ 'success': true, 'error': null, 'found': false }); }

		const num = (v) => { const n = Number(v); return isNaN(n) ? null : n; };
		const r2 = (v) => (v == null ? null : round2(v));

		const orders = ordersToArray(deal.orders);
		const filled = orders.filter(o => o && (o.filled === 1 || o.filled === true));

		const isComplete = deal.status === STATUS_COMPLETE;

		const created = deal.date ? new Date(deal.date) : (deal.createdAt ? new Date(deal.createdAt) : null);

		// Enriched ladder — cap the rows but keep the running figures each fill carries.
		let prev = null;
		const fullLadder = filled.map(o => {

			const t = o.dateFilled ? new Date(o.dateFilled) : null;
			const minsSincePrev = (t && prev) ? Math.round((t.getTime() - prev.getTime()) / 60000) : 0;
			if (t) { prev = t; }

			return {
				'orderNo': o.orderNo,
				'kind': Number(o.orderNo) === 1 ? 'base' : ('safety#' + (Number(o.orderNo) - 1)),
				'price': num(o.price),
				'avgPriceAfter': num(o.average),
				'cumInvested': num(o.sum),
				'filledAt': t ? t.toISOString() : null,
				'minsSincePrev': minsSincePrev
			};
		});

		// 15 most-recent fills — enough to narrate the ladder while leaving room for the
		// log events get_deal_timeline appends on top without overflowing the result cap
		// (a 61-order deal previously pushed the combined timeline past the limit).
		const LADDER_CAP = 15;
		const ladder = fullLadder.length > LADDER_CAP ? fullLadder.slice(fullLadder.length - LADDER_CAP) : fullLadder;

		const base = filled[0] || null;
		const last = filled.length ? filled[filled.length - 1] : null;

		const basePrice = base ? num(base.price) : null;
		const lastFillPrice = last ? num(last.price) : null;
		const averageEntry = last ? num(last.average) : null;
		const totalInvested = last ? num(last.sum) : null;
		const quantityHeld = last ? num(last.qtySum) : null;
		const targetPrice = last ? num(last.target) : null;

		const priceDropFromBasePct = (basePrice && lastFillPrice) ? r2((basePrice - lastFillPrice) / basePrice * 100) : null;

		const soUsed = Math.max(filled.length - 1, 0);
		const soMax = orders.length > 0 ? orders.length - 1 : null;

		// Outcome (completed) reuses the shared history calculation; live figures (open)
		// come from the deal tracker.
		let outcome = null;
		let live = null;
		let endPoint = null;

		if (isComplete) {

			const o = await getOutcome(deal);

			if (o) {

				endPoint = o.date_end ? new Date(o.date_end) : null;
				outcome = {
					'sellPrice': o.price != null ? num(o.price) : null,
					'profitQuote': o.profit != null ? r2(num(o.profit)) : null,
					'profitPercent': o.profit_percent != null ? r2(num(o.profit_percent)) : null,
					'profitCurrency': o.profit_currency || null,
					'profitable': o.profit_percent != null ? Number(o.profit_percent) > 0 : null
				};
			}
		}
		else {

			const trackerFn = (shareData && shareData.DCABot && typeof shareData.DCABot.getDealTracker === 'function') ? shareData.DCABot.getDealTracker : null;
			const info = trackerFn ? ((await trackerFn(dealId)) || {}).info : null;

			if (info && info.price_last != null) {

				const cur = num(info.price_last);
				live = {
					'currentPrice': cur,
					'unrealizedPnl': info.profit != null ? r2(num(info.profit)) : null,
					'unrealizedPct': info.profit_percentage != null ? r2(num(info.profit_percentage)) : null,
					'pctToTakeProfit': (targetPrice && cur) ? r2((targetPrice - cur) / cur * 100) : null
				};
			}
		}

		const endForDuration = isComplete ? endPoint : new Date();
		const durationHuman = (created && endForDuration) ? formatElapsed(created, endForDuration) : null;

		// Pre-computed, plain-language findings — the intelligent detail the model relays.
		const findings = [];

		findings.push('Filled the base order plus ' + soUsed + ' safety order' + (soUsed === 1 ? '' : 's') + (durationHuman ? ' over ' + durationHuman : '') + (soMax != null ? ' (of ' + soMax + ' possible)' : '') + '.');

		if (basePrice != null && averageEntry != null) {

			findings.push('Average entry moved from ' + basePrice + ' (base) to ' + averageEntry + (priceDropFromBasePct != null ? ', as price fell ' + priceDropFromBasePct + '% to the last fill at ' + lastFillPrice : '') + '.');
		}

		if (totalInvested != null && quantityHeld != null) {

			findings.push('Total invested ' + totalInvested + ' for ' + quantityHeld + ' ' + (deal.pair ? String(deal.pair).split('/')[0] : 'units') + (targetPrice != null ? '; take-profit target ' + targetPrice : '') + '.');
		}

		if (outcome) {

			findings.push('Closed at ' + outcome.sellPrice + ' for a ' + (outcome.profitable ? 'profit' : 'loss') + ' of ' + outcome.profitQuote + ' ' + (outcome.profitCurrency || '') + ' (' + outcome.profitPercent + '%).');
		}
		else if (live) {

			findings.push('Currently ' + live.currentPrice + ', unrealized ' + live.unrealizedPnl + ' (' + live.unrealizedPct + '%)' + (live.pctToTakeProfit != null ? ', ' + live.pctToTakeProfit + '% from take-profit' : '') + '.');
		}

		if (readBoolean(deal.paused) || readBoolean(deal.pausedBuy) || readBoolean(deal.pausedSell)) {

			const reason = normalizePauseReason(deal.pauseReason);
			findings.push('This deal is currently paused' + (reason ? ' (' + reason + ')' : '') + '.');
		}

		result = {
			'success': true,
			'error': null,
			'found': true,
			'dealId': deal.dealId,
			'pair': deal.pair,
			'botName': deal.botName,
			'exchange': deal.exchange,
			'status': isComplete ? 'complete' : 'active',
			'created': created ? created.toISOString() : null,
			'ended': (isComplete && endPoint) ? endPoint.toISOString() : null,
			'durationHuman': durationHuman,
			'safetyOrdersUsed': soUsed,
			'safetyOrdersMax': soMax,
			'basePrice': basePrice,
			'averageEntryPrice': averageEntry,
			'lastFillPrice': lastFillPrice,
			'priceDropFromBasePct': priceDropFromBasePct,
			'totalInvested': totalInvested,
			'quantityHeld': quantityHeld,
			'targetPrice': targetPrice,
			'ladder': ladder,
			'ladder_truncated': fullLadder.length > LADDER_CAP,
			'outcome': outcome,
			'live': live,
			'findings': findings
		};
	}
	catch (e) {

		result = { 'success': false, 'error': e.message, 'found': false };
	}

	return (result);
}


module.exports = {

	getDeal,
	getDealsByPair,
	getRecentDeals,
	getPausedDeals,
	getActiveDeals,
	getOrderCounts,
	getDealOrders,
	reconcileDeal,
	getOpenDealsStatus,
	getDealsClosestToTakeProfit,
	getPerformanceSummary,
	getTopDeals,
	getDealStatsOverTime,
	compareDealOutcome,
	getBotsSummary,
	getExchanges,
	getPortfolioSummary,
	getPairPerformance,
	getBotPerformance,
	findOldestOpenDeals,
	findDealsNearMaxSafetyOrders,
	resolveDeal,
	getOpenRiskSummary,
	getDrawdownRisk,
	getOpenOrdersSummary,
	getExposureSummary,
	summarizeDeal,

	init: function(obj) {

		shareData = obj;
	}
};