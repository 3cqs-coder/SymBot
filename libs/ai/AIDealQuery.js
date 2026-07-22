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

// status is 0 while a deal is running and 1 once it has completed.
const STATUS_ACTIVE = 0;
const STATUS_COMPLETE = 1;


let shareData;


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

			// getProcessedDeals calls .filter directly on deal.orders, so it needs a
			// real array. Mongo can hand back the orders object in either shape, and
			// a plain object here would throw inside the helper.
			const safeDeal = Object.assign({}, deal, { 'orders': ordersToArray(deal.orders) });

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
async function getDealsByPair(pair, completedOnly, limit) {

	const query = { 'pair': pair };

	if (completedOnly) {

		query.status = STATUS_COMPLETE;
	}

	return (await runQuery(query, {}, limit));
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

		query.updatedAt = range;
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


// Aggregate outcome statistics per pair over completed deals, so a comparison
// question can be answered without pulling every document.
async function getPairStats(pair, limit) {

	const getDeals = getDealsFn();

	const capped = Math.min(Math.max(parseInt(limit, 10) || MAX_RESULTS_DEFAULT, 1), MAX_RESULTS_LIMIT);

	let result = { 'success': false, 'error': 'Deal data not available', 'stats': [] };

	if (getDeals != null) {

		const match = { 'status': STATUS_COMPLETE };

		if (typeof pair === 'string' && pair !== '') {

			match.pair = pair;
		}

		const pipeline = [
			{ '$match': match },
			{ '$group': {
				'_id': '$pair',
				'deals': { '$sum': 1 },
				'lastCompleted': { '$max': '$updatedAt' }
			} },
			{ '$sort': { 'deals': -1 } },
			{ '$limit': capped }
		];

		try {

			const rows = await getDeals(null, null, null, pipeline);

			const stats = (rows || []).map(r => ({
				'pair': r._id,
				'deals': r.deals,
				'lastCompleted': r.lastCompleted ? new Date(r.lastCompleted).toISOString() : null
			}));

			result = { 'success': true, 'error': null, 'stats': stats };
		}
		catch (e) {

			result = { 'success': false, 'error': e.message, 'stats': [] };
		}
	}

	return (result);
}


module.exports = {

	getDeal,
	getDealsByPair,
	getRecentDeals,
	getPausedDeals,
	getActiveDeals,
	getPairStats,
	summarizeDeal,

	init: function(obj) {

		shareData = obj;
	}
};
