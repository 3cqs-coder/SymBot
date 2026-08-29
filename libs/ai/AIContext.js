'use strict';


// Decides what SymBot data a chat question needs, fetches it read-only, and
// renders it as a context block for the model.
//
// One model pass reads the recent conversation and the latest message and
// returns a structured routing decision. That single pass replaces a pile of
// independent keyword heuristics and, more usefully, resolves references:
// "why did it pause?" only means something in the context of the turn before it.
//
// This is strictly additive and fail-safe. If the feature is disabled, the
// routing pass fails, times out, returns unusable output, or no data is found,
// the caller receives an empty string and the conversation proceeds exactly as
// it did before this module existed. Nothing is removed from the existing path.
//
// It is also read-only end to end: it can look at deals and logs and describe
// them, and has no route to pause, cancel, sell or modify anything.


const LogScan = require('../queries/LogScan');
const DealQuery = require('../queries/DealQuery');
const aiGuardrails = require('./AIGuardrails');


const ROUTER_TIMEOUT_MS = 12000;
const HISTORY_TURNS = 6;

// The routing pass must return a strict JSON object and nothing else, so it runs
// deterministically (temperature 0) and asks the provider for a schema-constrained
// JSON object (structured outputs — more reliable than plain JSON mode on small
// models), with plain JSON mode as the fallback. If the active model or endpoint
// supports neither, completePrompt retries once without options and parseJsonObject
// still recovers the object from the text. The schema itself is attached below, once
// VALID_SCOPES (its scope enum) is defined.
const ROUTER_GEN = { temperature: 0, json: true };

// A short message with no data-seeking words is treated as conversational.
const CONVERSATIONAL_MAX_WORDS = 6;

// Messages that ask to carry on with whatever was just said. They carry no
// topic of their own, so there is nothing to look up: the answer comes from the
// conversation the model already has. Matching these outright is more reliable
// than judging by length, because several of them mention "it" or "that" and
// would otherwise look like references to a deal.
const VAGUE_CONTINUATION_RE = /^(tell me more( about( it| that| this))?|more( about( it| that| this))?|continue|go on|elaborate|keep going|and then|what else|anything else|what happened next|next|more details?|more info|expand|explain more|explain( it| this| that)?( in detail)?|overview|summari[sz]e|analy[sz]e( it| this| that)?|break( it| this| that)? down|breakdown|in[- ]depth|go deeper|dive deeper|ok|okay|thanks|thank you|got it|ok got it|sounds good|understood|i see)[\s!.?]*$/i;
const MAX_LOG_LINES = 150;
const MAX_DEALS = 15;
const MAX_CONTEXT_CHARS = 24000;

const VALID_SCOPES = new Set([ 'one_deal', 'compare_deals', 'day_events', 'paused_deals', 'active_deals', 'log_search', 'general' ]);

// Schema for the routing decision, matching the shape ROUTER_SYSTEM asks the model to
// return. The scope enum is derived from VALID_SCOPES so the schema can never drift out
// of sync with the code that validates it. Only the always-present fields are required;
// the optional ones (searchTerm/resolvedQuery/ambiguous/clarify) are coerced by
// validateRoute when absent.
const ROUTER_SCHEMA = {
	type: 'object',
	properties: {
		scope:         { type: 'string', enum: Array.from(VALID_SCOPES) },
		dealIds:       { type: 'array', items: { type: 'string' } },
		pair:          { type: 'string' },
		days:          { type: 'integer', minimum: 1, maximum: 2 },
		needLogs:      { type: 'boolean' },
		searchTerm:    { type: 'string' },
		resolvedQuery: { type: 'string' },
		ambiguous:     { type: 'boolean' },
		clarify:       { type: 'string' }
	},
	required: [ 'scope', 'dealIds', 'pair', 'days', 'needLogs' ]
};

ROUTER_GEN.schema = ROUTER_SCHEMA;

// A deal id looks like PAIR_QUOTE-XXXXXX-<epoch>. Recognizing it directly means
// the common case works even if the routing pass is unavailable.
const DEAL_ID_RE = /\b[A-Z0-9]+_[A-Z0-9]+-[A-Z0-9]+-\d+\b/g;
const PAIR_RE = /\b([A-Z0-9]{2,10})\/([A-Z]{3,5})\b/;

// Rooms used for one-shot generated prompts such as deal analysis and the
// closed-deal journal narrative. Those build their own self-contained prompt
// (the journal prompt explicitly says to use only the numbers it provides), so
// the conversational routing pass must not run for them or add extra context.
const NON_CONVERSATIONAL_ROOM_RE = /^(aiAnalyze|journal)/i;


// The router system prompt lives in libs/ai/data/router-system.txt (plain text, not inline code) so a
// stray backtick can't silently truncate it — the same convention as the deep-analysis/persona prompts.
const ROUTER_SYSTEM = aiGuardrails.readText('router-system.txt');


let shareData;


function getConfig() {

	const ai = (shareData && shareData.appData && shareData.appData.ai) || {};

	return (ai.deal_context || {});
}


function isEnabled() {

	const cfg = getConfig();

	return (cfg.enabled === true);
}


// Deal analysis and other generated one-shot prompts must be left alone.
function isConversationalRoom(room) {

	return (typeof room === 'string' && room !== '' && !NON_CONVERSATIONAL_ROOM_RE.test(room));
}


let logger = function () {};   // assigned in init() via Common.makeLogger


// Local date as YYYY-MM-DD. Uses Common.getDateParts, which is the same helper
// that builds the log file names, so a date derived here cannot drift from the
// one the file was written under.
function dateKey(date) {

	const d = date instanceof Date ? date : new Date();

	let key;

	if (shareData && shareData.Common && typeof shareData.Common.getDateParts === 'function') {

		key = shareData.Common.getDateParts(d).date;
	}
	else {

		const month = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');

		key = d.getFullYear() + '-' + month + '-' + day;
	}

	return (key);
}


// The most recent dates to search, newest first.
function recentDates(days) {

	const count = Math.min(Math.max(parseInt(days, 10) || 1, 1), 2);

	const out = [];

	for (let i = 0; i < count; i++) {

		const d = new Date();

		d.setDate(d.getDate() - i);

		out.push(dateKey(d));
	}

	return (out);
}


// Instance name is part of the log file name.
async function getInstanceName() {

	let name = '';

	if (shareData && shareData.Common && typeof shareData.Common.getInstanceName === 'function') {

		try {

			name = await shareData.Common.getInstanceName() || '';
		}
		catch (e) {

			name = '';
		}
	}

	return (name);
}


// Pull a JSON object out of a model response that may carry stray prose or code fences around it.
// Delegates to the shared tolerant parser so the router recovers the same fenced / trailing-comma
// breakages every other AI caller does (this local copy previously did neither and silently dropped them).
function parseJsonObject(text) {

	return aiGuardrails.parseModelJson(text);
}


// Deal ids and pairs mentioned literally in a string.
function extractIdentifiers(text) {

	const raw = typeof text === 'string' ? text : '';

	const ids = raw.match(DEAL_ID_RE) || [];
	const pairMatch = raw.match(PAIR_RE);

	return ({
		'dealIds': [ ...new Set(ids) ],
		'pair': pairMatch ? pairMatch[0].toUpperCase() : ''
	});
}


// Plain-language topics mapped to the phrases that actually appear in the logs.
// Without this, asking about "restarts" or "errors" would need the user to know
// and quote the exact wording SymBot writes.
//
// Phrases are chosen so that one matching line means one occurrence of the thing
// being asked about. That rules out some otherwise obvious choices: the shutdown
// line is written once per active deal, so a single shutdown with fifty open
// deals produces fifty lines. Counting those as restarts would overstate them by
// the size of the deal book, so restarts are counted from the startup line, which
// is written exactly once per launch.
const TOPIC_TERMS = {
	'restart': [ 'Starting SymBot' ],
	'reboot': [ 'Starting SymBot' ],
	'start': [ 'Starting SymBot' ],
	'shutdown': [ 'Starting SymBot' ],
	'disconnect': [ 'Client Disconnected' ],
	'circuit breaker': [ 'CIRCUIT BREAKER ACTIVATED' ],
	'insufficient funds': [ 'InsufficientFunds' ],
	'partial fill': [ 'Exchange-cancelled partial' ],
	'invalid order': [ 'Invalid order', 'Invalid base order' ],
	'finished': [ 'DCA Bot Finished' ],
	'completed': [ 'DCA Bot Finished' ]
};


// Pull the phrase to search for out of a question about the logs.
//
// A quoted phrase is taken as written. Otherwise the longest run of adjacent
// capitalized words is used, which is how log messages tend to read ("Client
// Disconnected", "Circuit Breaker"). Returns '' when nothing usable is found,
// which leaves the caller to fall back rather than search for filler words.
function extractSearchTerm(message) {

	const raw = typeof message === 'string' ? message : '';

	let term = '';

	const quoted = raw.match(/["'`]([^"'`]{2,60})["'`]/);

	if (quoted) {

		term = quoted[1].trim();
	}
	else {

		// Runs of two or more capitalized words, ignoring the leading word of the
		// sentence which is capitalized for grammar rather than meaning.
		const body = raw.replace(/^\s*\S+\s+/, ' ');

		const runs = body.match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\b/g) || [];

		const best = runs
			.filter(r => !DEAL_ID_RE.test(r))
			.sort((a, b) => b.length - a.length)[0];

		term = best ? best.trim() : '';
	}

	return (term);
}


// Log phrases for a plain-language topic, e.g. "restarts" -> the lines SymBot
// writes when it starts and stops. Returns [] when nothing matches.
function topicTerms(message) {

	const text = (message || '').toLowerCase();

	let terms = [];

	for (const topic of Object.keys(TOPIC_TERMS)) {

		// Match the topic word with or without a trailing s.
		const re = new RegExp('\\b' + topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 's?\\b');

		if (re.test(text)) {

			terms = TOPIC_TERMS[topic];

			break;
		}
	}

	return (terms);
}


// Routing decision without the model. Used when the router is unavailable or
// returns something unusable, so the feature degrades to something useful
// rather than to nothing.
function heuristicRoute(message, history) {

	const text = (message || '').toLowerCase();

	const found = extractIdentifiers(message);

	const wantsDebug = /\bwhy|what happened|trace|debug|fail|error|pause|stuck|cancel|reject\b/.test(text);
	const wantsCompare = /\bcompare|similar|other deals|history|typical|usually|average\b/.test(text);
	const wantsToday = /\btoday|last 24|overnight|this morning|tonight\b/.test(text);
	const wantsPaused = /\bpaused|stuck|waiting|held\b/.test(text);
	const wantsActive = /\bactive|running|open deals|my deals|how are\b/.test(text);

	// Questions about the log contents themselves, e.g. "how many X are in the
	// logs", "search the logs for X". These need a phrase to look for rather than
	// the fixed set of notable events.
	// Questions about the log contents themselves, e.g. "how many X are in the
	// logs", "search the logs for X". The word "log" is the clearest signal, but a
	// recognized topic asked in counting terms is the same question — "how many
	// times did symbot restart today" never says "log" and still means one.
	const asksHowMany = /\bhow many|how often|how much|count|number of|search|find|any\b/.test(text);

	const mentionsLog = /\blogs?\b/.test(text);

	const topicHit = topicTerms(message);

	const wantsLogSearch = (mentionsLog && (asksHowMany || /\bwere|are there\b/.test(text)))
		|| (topicHit.length > 0 && asksHowMany);

	// A recognized topic supplies the log phrases directly; otherwise fall back to
	// a quoted or capitalized phrase lifted from the question.
	const topic = wantsLogSearch ? topicHit : [];

	const searchTerm = wantsLogSearch ? extractSearchTerm(message) : '';

	// A quoted phrase is the user being explicit, so it wins over the topic map.
	const wasQuoted = /["'`][^"'`]{2,60}["'`]/.test(message || '');

	// How the terms were arrived at matters when a search finds nothing. Phrases
	// taken from a known mapping are wording the logs actually use, so an empty
	// result means the events did not occur. A phrase lifted from the question is
	// only a guess at the wording, so an empty result may just mean we looked for
	// the wrong string — which must not be reported as though nothing happened.
	const searchTerms = (wasQuoted && searchTerm)
		? [ searchTerm ]
		: (topic.length ? topic : (searchTerm ? [ searchTerm ] : []));

	const termSource = (wasQuoted && searchTerm)
		? 'quoted'
		: (topic.length ? 'mapped' : (searchTerm ? 'guessed' : 'none'));

	// Words that signal the message is still about the thing under discussion.
	// Without this, any unrelated question asked after a deal was mentioned would
	// inherit that deal and pull its data into an answer that has nothing to do
	// with it.
	const refersBack = /\b(it|its|that|this|the deal|same|one|there|then)\b/.test(text);

	// A pronoun alone is not enough. "ok got it" and "thanks, that helps" contain
	// one but ask for nothing, and treating them as deal questions meant an
	// acknowledgement triggered a full retrieval. The message also has to be
	// asking or requesting something.
	const asksSomething = /\?|^(what|why|how|when|where|which|who|is|are|was|were|did|does|do|can|could|should|would|show|tell|give|list|explain|compare|find|check)\b/.test(text)
		|| /\b(tell me|show me|give me|explain|compare|check|look at)\b/.test(text);

	// A continuation asks to carry on, not to look something up, so it must not
	// drag the previous deal's data into what is really a conversational reply.
	const isContinuation = VAGUE_CONTINUATION_RE.test((message || '').trim());

	const dealRelated = !isContinuation
		&& (wantsDebug || wantsCompare || wantsPaused || wantsActive || (refersBack && asksSomething));

	// A deal referred to earlier, for messages like "why did it pause?"
	const fromHistory = dealRelated
		? extractIdentifiers((history || []).map(m => m.content || '').join(' '))
		: { 'dealIds': [], 'pair': '' };

	const dealIds = found.dealIds.length ? found.dealIds : fromHistory.dealIds.slice(-1);
	const pair = found.pair || fromHistory.pair;

	let scope = 'general';

	// An explicit time reference makes the question about a period, not about
	// whichever deal was discussed earlier. Without this, "what happened today"
	// asked after a deal conversation inherits that deal and reports on it alone.
	const namesDeal = found.dealIds.length > 0;

	if (isContinuation) {

		scope = 'general';
	}
	else if (wantsLogSearch && searchTerms.length) {

		// A named thing to look for beats a bare time reference: "how many times
		// did symbot restart today" is a search for restarts, not a request for
		// everything that happened.
		scope = 'log_search';
	}
	else if (wantsToday && !namesDeal) {

		scope = 'day_events';
	}
	else if (wantsPaused && !namesDeal) {

		// Asking what is paused is a question about the whole book, even in a
		// conversation that was previously about one deal.
		scope = 'paused_deals';
	}
	else if (wantsActive && !namesDeal) {

		// Likewise for asking what is running.
		scope = 'active_deals';
	}
	else if (dealIds.length) {

		scope = wantsCompare ? 'compare_deals' : 'one_deal';
	}
	else if (wantsCompare && pair) {

		scope = 'compare_deals';
	}
	else if (wantsPaused) {

		scope = 'paused_deals';
	}
	else if (wantsToday || (wantsDebug && !pair)) {

		scope = 'day_events';
	}
	else if (wantsActive) {

		scope = 'active_deals';
	}

	return ({
		'scope': scope,
		'dealIds': dealIds,
		'pair': pair,
		'days': 1,
		'needLogs': wantsDebug || wantsToday || wantsLogSearch || dealIds.length > 0,
		'searchTerm': searchTerms.length ? searchTerms[0] : '',
		'searchTerms': searchTerms,
		'termSource': termSource,
		'resolvedQuery': message || '',
		'ambiguous': false,
		'clarify': '',
		'source': 'heuristic'
	});
}


// Coerce a model routing decision into the expected shape, falling back to the
// heuristic route for anything missing or invalid. Single exit.
function validateRoute(parsed, message, history) {

	const fallback = heuristicRoute(message, history);

	let route = fallback;

	if (parsed && typeof parsed === 'object' && VALID_SCOPES.has(parsed.scope)) {

		// A question that maps to known log phrases is a search of the log as a
		// whole, and stays that way. Left to itself the router reads such a question
		// as a follow-up about whatever deal was discussed earlier and narrows the
		// search to that deal, which then finds nothing — the events are in the log,
		// just not under that deal id.
		const mappedLogSearch = fallback.scope === 'log_search' && fallback.termSource === 'mapped';

		// The same narrowing happens to questions about the whole book. "Tell me
		// about my deals" and "what is paused" name no deal, and the router reading
		// them as being about one deal produces either the wrong deal or a request
		// for clarification the user never needed.
		const bookWide = (fallback.scope === 'active_deals' || fallback.scope === 'paused_deals'
			|| fallback.scope === 'day_events')
			&& fallback.dealIds.length === 0;

		const keepFallbackScope = mappedLogSearch || bookWide;

		const scope = keepFallbackScope ? fallback.scope : parsed.scope;

		const ids = Array.isArray(parsed.dealIds)
			? parsed.dealIds.filter(id => typeof id === 'string' && id !== '')
			: [];

		route = {
			'scope': scope,
			// A whole-log or whole-book question is not about one deal, so any deal
			// ids the router carried over from earlier turns are dropped.
			'dealIds': keepFallbackScope ? [] : (ids.length ? ids : fallback.dealIds),
			'pair': (typeof parsed.pair === 'string' && parsed.pair !== '') ? parsed.pair.toUpperCase() : fallback.pair,
			'days': Math.min(Math.max(parseInt(parsed.days, 10) || 1, 1), 2),
			'needLogs': mappedLogSearch ? true : (parsed.needLogs === true),
			// The model tends to echo the user's wording ("restarts"), which is not
			// what the log actually contains. When the question maps to known log
			// phrases, those win; the model's term is used only for phrases we have
			// no mapping for.
			'searchTerm': (fallback.searchTerms && fallback.searchTerms.length)
				? fallback.searchTerms[0]
				: ((typeof parsed.searchTerm === 'string' && parsed.searchTerm.trim() !== '')
					? parsed.searchTerm.trim()
					: fallback.searchTerm),
			'searchTerms': (fallback.searchTerms && fallback.searchTerms.length)
				? fallback.searchTerms
				: ((typeof parsed.searchTerm === 'string' && parsed.searchTerm.trim() !== '')
					? [ parsed.searchTerm.trim() ]
					: fallback.searchTerms),
			'termSource': (fallback.searchTerms && fallback.searchTerms.length)
				? fallback.termSource
				: ((typeof parsed.searchTerm === 'string' && parsed.searchTerm.trim() !== '') ? 'guessed' : fallback.termSource),
			'resolvedQuery': (typeof parsed.resolvedQuery === 'string' && parsed.resolvedQuery !== '') ? parsed.resolvedQuery : (message || ''),
			'ambiguous': parsed.ambiguous === true,
			'clarify': typeof parsed.clarify === 'string' ? parsed.clarify : '',
			'source': 'model'
		};
	}

	return (route);
}


// Ask the model how to route the question. Any failure resolves to null so the
// caller falls back to the heuristic route.
async function routeQuestion(message, history) {

	const cfg = getConfig();

	const complete = (shareData && shareData.AIClient && typeof shareData.AIClient.completePrompt === 'function')
		? shareData.AIClient.completePrompt
		: null;

	let parsed = null;

	if (complete != null && cfg.use_router !== false) {

		const turns = (history || []).slice(-HISTORY_TURNS)
			.map(m => (m.role === 'user' ? 'User: ' : 'Assistant: ') + String(m.content || '').slice(0, 600))
			.join('\n');

		const messages = [
			{ 'role': 'system', 'content': ROUTER_SYSTEM },
			{ 'role': 'user', 'content': 'CONVERSATION:\n' + (turns || '(none)') + '\n\nLATEST MESSAGE:\n' + message }
		];

		let routerTimer;

		const timeout = new Promise(resolve => {

			routerTimer = setTimeout(() => resolve(null), cfg.router_timeout_ms || ROUTER_TIMEOUT_MS);
			if (routerTimer && routerTimer.unref) { routerTimer.unref(); }
		});

		const started = Date.now();

		try {

			const raw = await Promise.race([ complete(messages, cfg.router_model, ROUTER_GEN), timeout ]);

			parsed = parseJsonObject(raw);

			logger('router pass took ' + (Date.now() - started) + 'ms' + (parsed ? '' : ' (no usable result)'));
		}
		catch (e) {

			logger('router failed after ' + (Date.now() - started) + 'ms (' + e.message + ') — using heuristic route');

			parsed = null;
		}
		finally {

			clearTimeout(routerTimer);
		}
	}

	return (parsed);
}


// Describe a deal's safety order position.
//
// The remaining count is stated outright rather than left to be worked out from
// two numbers. Reading "33 of 34" and concluding the ladder is finished is an
// easy mistake to make, and one that matters: a deal with an order still
// available behaves quite differently from one with none.
function formatSafetyOrders(deal) {

	const used = deal.safetyOrdersUsed;
	const max = deal.safetyOrdersMax;

	let text;

	// Every figure carries the noun it counts. A bare "45 still available" was
	// read as a quantity of coins and turned into an invented per-token price,
	// and a bare "0 still available" was read as the position being sold out.
	// Naming what is being counted each time removes the room to guess.
	if (max == null) {

		text = 'safety orders placed ' + used + ' (no ladder maximum recorded)';
	}
	else if (deal.ladderExhausted === true) {

		text = 'safety orders placed ' + used + ' of ' + max + ', none left to place';
	}
	else {

		const left = max - used;

		text = 'safety orders placed ' + used + ' of ' + max + ', ' + left + ' left to place';
	}

	return (text);
}


// Render a completed deal's outcome. States profit or loss in words as well as
// figures so a negative result cannot be read as a gain. The amount is shown in
// the currency the deal is measured in, using the shared currency symbol helper
// rather than assuming a sign. Returns null while a deal is still open.
function formatProfit(deal) {

	let text = null;

	if (deal.profitPercent != null || deal.profitQuote != null) {

		const outcome = deal.profitable === true ? 'PROFIT' : (deal.profitable === false ? 'LOSS' : 'result');

		const q = (shareData && shareData.Common && typeof shareData.Common.quoteCurrency === 'function') ? shareData.Common.quoteCurrency(deal.pair) : '';
		const quote = (q && q !== 'UNKNOWN') ? q : '';

		const symbol = (shareData && shareData.Common && typeof shareData.Common.getCurrencySymbol === 'function')
			? shareData.Common.getCurrencySymbol(quote)
			: '';

		const parts = [];

		// profitCurrency mirrors the deal's own config: base is only meaningful
		// when the deal was set to measure profit that way and a base figure exists.
		const useBase = deal.profitCurrency === 'base' && deal.profitBase != null && Number(deal.profitBase) > 0;

		if (useBase) {

			parts.push(deal.profitBase + (quote ? '' : '') + (deal.pair ? ' ' + deal.pair.split('/')[0] : ''));
		}
		else if (deal.profitQuote != null) {

			parts.push(symbol + deal.profitQuote + (quote ? ' ' + quote : ''));
		}

		if (deal.profitPercent != null) {

			parts.push(deal.profitPercent + '%');
		}

		text = outcome + ': ' + parts.join(' / ');
	}

	return (text);
}


// Render a list of deal summaries compactly.
function renderDeals(title, deals) {

	let text = '';

	if (deals && deals.length) {

		const describe = (d) => {

			const parts = [
				d.dealId,
				d.pair,
				formatSafetyOrders(d),
				d.ranMins != null ? 'ran ' + d.elapsedHuman : null,
				d.openForMins != null ? 'open ' + d.elapsedHuman + ' so far' : null,
				d.averagePrice != null ? 'average entry price ' + d.averagePrice : null,
				d.targetPrice != null ? 'sell target price ' + d.targetPrice : null,
				d.sellPrice != null ? 'sold at price ' + d.sellPrice : null,
				formatProfit(d),
				d.pauseReason ? 'pause reason: ' + d.pauseReason : (d.paused || d.pausedBuy || d.pausedSell ? 'paused' : null),
				d.canceled ? 'canceled' : null,
				d.panicSell ? 'panic sell' : null
			].filter(p => p != null);

			return ('- ' + parts.join(' | '));
		};

		// One deal is described as labeled lines rather than a pipe-separated row.
		// A row of pipes reads as a table, and with a single entry the fields
		// themselves were counted as separate deals. Lists keep the compact row
		// form, where the repetition of the same shape makes each line read as one
		// deal.
		const describeSingle = (d) => {

			const lines = [
				'Deal ID: ' + d.dealId,
				'Pair: ' + d.pair,
				'Status: ' + (d.status === 'complete' ? 'completed, has sold' : 'open, has not sold'),
				// Spelled out rather than reduced to "48 of 48". The bare pair of numbers
				// was read as a relationship between buy and sell orders; saying what
				// each number is leaves nothing to interpret.
				'Safety orders placed so far: ' + d.safetyOrdersUsed
					+ (d.safetyOrdersMax != null ? ' (this deal allows a maximum of ' + d.safetyOrdersMax + ')' : ''),
				// Taken from the deal's own exhaustion flag, not from max minus used. The
				// base order counts toward SymBot's limit, so a deal can read one short
				// of its maximum and still have nothing left to place — subtracting the
				// two figures here disagreed with the bot itself.
				d.safetyOrdersMax != null
					? 'Safety orders still available to place: '
						+ (d.ladderExhausted === true ? 0 : Math.max(d.safetyOrdersMax - d.safetyOrdersUsed, 0))
					: null,
				d.ranMins != null ? 'Ran for: ' + d.elapsedHuman : null,
				d.openForMins != null ? 'Open for: ' + d.elapsedHuman + ' so far' : null,
				d.averagePrice != null ? 'Average entry price: ' + d.averagePrice : null,
				d.targetPrice != null ? 'Sell target price: ' + d.targetPrice : null,
				d.sellPrice != null ? 'Sold at price: ' + d.sellPrice : null,
				formatProfit(d) ? formatProfit(d) : null,
				d.pauseReason ? 'Paused, reason: ' + d.pauseReason : (d.paused || d.pausedBuy || d.pausedSell ? 'Paused: yes' : null),
				d.canceled ? 'Canceled: yes' : null,
				d.panicSell ? 'Panic sell: yes' : null
			].filter(l => l != null);

			return (lines.join('\n'));
		};

		const shown = deals.slice(0, MAX_DEALS);

		const open = shown.filter(d => d.status !== 'complete');
		const done = shown.filter(d => d.status === 'complete');

		// Deals are grouped under their status rather than carrying it as one field
		// among many on a single line. Status is the fact most easily lost when a
		// row is long, and losing it turns an open position into a finished trade.
		// A heading cannot be skimmed past the way an inline marker can.
		const blocks = [];

		if (shown.length === 1) {

			const only = shown[0];

			blocks.push((only.status === 'complete'
				? 'THIS IS ONE COMPLETED DEAL. All the lines below describe that single deal:'
				: 'THIS IS ONE OPEN DEAL. All the lines below describe that single deal:')
				+ '\n' + describeSingle(only));
		}
		else if (open.length) {

			blocks.push('YOUR OPEN DEALS — these have NOT sold, have no realized profit or loss, and are still running ('
				+ open.length + '):\n' + open.map(describe).join('\n'));
		}

		if (shown.length > 1 && done.length) {

			blocks.push('YOUR COMPLETED DEALS — these have sold and are finished ('
				+ done.length + '):\n' + done.map(describe).join('\n'));
		}

		// Only worth saying when several deals are listed and the reader might scan
		// for a completed one. On a single-deal lookup it is noise, and it was being
		// read as the answer to the question.
		if (!done.length && open.length > 1) {

			blocks.push('There are no completed deals in this result. Every deal listed above is still open.');
		}

		text = (title ? title + '\n' : '') + blocks.join('\n\n') + '\n';
	}

	return (text);
}


function renderLogLines(title, lines) {

	let text = '';

	if (lines && lines.length) {

		text = title + '\n' + lines.slice(0, MAX_LOG_LINES).join('\n') + '\n';
	}

	return (text);
}


// Fetch whatever the route calls for. Every branch is read-only.
// Single exit.
async function gatherData(route) {

	const instanceName = await getInstanceName();
	const dates = recentDates(route.days);

	const sections = [];

	if (route.scope === 'one_deal' && route.dealIds.length) {

		for (const dealId of route.dealIds.slice(0, 3)) {

			const deal = await DealQuery.getDeal(dealId);

			// No outer title: the grouped heading below already names the deal and its
			// status, and stacking two headers made one deal look like two entries.
			sections.push(renderDeals('', deal.deals));

			if (route.needLogs) {

				const logs = await LogScan.getDealEvents(dealId, dates, instanceName, MAX_LOG_LINES);

				// Say so explicitly when nothing was found. A deal id is an exact
				// identifier, so an empty result here is reliable: nothing was logged
				// for this deal in the dates searched. That is different from having
				// searched for a phrase that might be worded differently.
				sections.push(logs.lines.length
					? renderLogLines('LOG EVENTS (' + dealId + '):', logs.lines)
					// Stated as a fact, not explained. The long version of this note ran to
					// more than half the length of the deal itself, and a paragraph of
					// caveat sitting beside the data was read as material to draw on —
					// producing invented events that were never logged.
					: 'LOG EVENTS: none for this deal on ' + dates.join(', ') + '.\n');
			}
		}
	}
	else if (route.scope === 'compare_deals') {

		if (route.dealIds.length) {

			for (const dealId of route.dealIds.slice(0, 5)) {

				const deal = await DealQuery.getDeal(dealId);

				sections.push(renderDeals('DEAL RECORD (' + dealId + '):', deal.deals));
			}
		}

		if (route.pair) {

			const byPair = await DealQuery.getDealsByPair(route.pair, true, MAX_DEALS);

			sections.push(renderDeals('COMPLETED DEALS FOR ' + route.pair + ':', byPair.deals));
		}
		else {

			const recent = await DealQuery.getRecentDeals(null, null, MAX_DEALS);

			sections.push(renderDeals('RECENTLY COMPLETED DEALS:', recent.deals));
		}
	}
	else if (route.scope === 'log_search' && (route.searchTerm || (route.searchTerms && route.searchTerms.length))) {

		// Free-text search. The count is what these questions usually ask for, so
		// it is stated directly rather than leaving the model to tally lines it
		// may only have been given a sample of.
		const needles = (route.searchTerms && route.searchTerms.length) ? route.searchTerms : [ route.searchTerm ];

		let found = await LogScan.scanLogs({
			'needles': needles,
			'dates': dates,
			'instanceName': instanceName,
			'maxLines': MAX_LOG_LINES
		});

		let used = needles;
		let usedSource = route.termSource || 'guessed';

		// A term lifted from the question is often wording the log never uses.
		// Rather than report a confident zero, retry once with the phrases mapped
		// from the question's topic before concluding nothing is there.
		if (!found.lines.length) {

			const mapped = topicTerms(route.resolvedQuery || '');

			const retry = mapped.filter(m => !needles.includes(m));

			if (retry.length) {

				const second = await LogScan.scanLogs({
					'needles': retry,
					'dates': dates,
					'instanceName': instanceName,
					'maxLines': MAX_LOG_LINES
				});

				if (second.lines.length) {

					found = second;
					used = retry;
					usedSource = 'mapped';
				}
			}
		}

		const header = 'LOG SEARCH for ' + used.map(n => '"' + n + '"').join(' or ') + ' — searched ' + found.files.length
			+ ' log file(s) for ' + dates.join(', ') + ':';

		if (found.lines.length) {

			// Some events are logged once per deal rather than once per occurrence,
			// so a burst of lines sharing a timestamp is one event, not many. Report
			// both figures when they differ so a line count is not mistaken for an
			// event count.
			// matchCount is every occurrence in the file; found.lines is the subset
			// shown, which may be fewer because of the display limit or because a
			// match sat inside a logged AI request. The count reported must be the
			// true total, not the number of lines that happened to be displayed.
			const total = (typeof found.matchCount === 'number' && found.matchCount >= found.lines.length)
				? found.matchCount
				: found.lines.length;

			const seconds = new Set(found.lines.map(l => l.slice(0, 19)));

			const burst = found.lines.length > seconds.size;

			const shownNote = (total > found.lines.length)
				? '\nShowing ' + found.lines.length + ' of them below.'
				: '';

			const counted = header + '\n'
				+ 'Matching lines found: ' + total
				+ (found.truncated ? ' (result limit reached, there may be more)' : ' (complete count for the dates searched)')
				+ shownNote
				+ (burst
					? '\nThe lines shown fall within ' + seconds.size + ' distinct moment(s). Some events are'
						+ ' written once per deal, so the number of separate occurrences may be far smaller'
						+ ' than the line count. Report occurrences, not raw line count.'
					: '')
				+ '\n';

			sections.push(counted + found.lines.join('\n') + '\n');
		}
		else if (usedSource === 'mapped') {

			// Known wording, so an empty result is a real answer: the events did not
			// happen in the range searched.
			sections.push(header
				+ '\nMatching lines found: 0.'
				+ ' These are the phrases SymBot writes for this kind of event, so this means'
				+ ' no such events occurred in the dates searched.\n');
		}
		else {

			// The phrase came from the question rather than a known mapping, so an
			// empty result is inconclusive — the wording may simply be different.
			// Reporting this as "it did not happen" is exactly the wrong conclusion.
			sections.push(header
				+ '\nMatching lines found: 0. IMPORTANT: this phrase was taken from the question'
				+ ' rather than from a known log format, so a zero result does NOT establish that'
				+ ' nothing happened — the logs may record it using different wording. Say that the'
				+ ' exact phrase was not found and offer to search for a different term, rather than'
				+ ' concluding the events did not occur.\n');
		}
	}
	else if (route.scope === 'day_events') {

		let events = await LogScan.getNotableEvents(dates, instanceName, MAX_LOG_LINES);
		let eventDates = dates;

		// Shortly after midnight "today" holds almost nothing, and answering that
		// nothing has happened is technically true but useless. When today is empty
		// the previous day is searched as well, and the range is reported so the
		// answer says which days it covers.
		if (!events.lines.length && dates.length === 1) {

			const wider = recentDates(2);

			const widerEvents = await LogScan.getNotableEvents(wider, instanceName, MAX_LOG_LINES);

			if (widerEvents.lines.length) {

				events = widerEvents;
				eventDates = wider;
			}
		}

		// A question about what happened is answered by events. The list of open
		// deals is current state, not activity, and including it here meant a reply
		// built almost entirely from deals — with the events outnumbered and the
		// question effectively unanswered.
		if (events.lines.length) {

			sections.push('WHAT HAPPENED ON ' + eventDates.join(' and ') + ' — ' + events.lines.length
				+ ' notable event(s) from the log, newest last:\n' + events.lines.join('\n') + '\n');
		}
		else {

			// The complete answer, phrased so nothing needs adding to it. An open
			// ended negative invites illustration, and illustration here means
			// invented deal ids and prices.
			sections.push('WHAT HAPPENED ON ' + dates.join(', ') + ': nothing. The log for '
				+ dates.join(' and ') + ' contains no completed deals, no failed orders, no circuit '
				+ 'breaker activity and no errors. The whole answer is that it has been quiet. Do not '
				+ 'name any deal, price or quantity, because none are involved.\n');
		}
	}
	else if (route.scope === 'paused_deals') {

		const paused = await DealQuery.getPausedDeals(null, MAX_DEALS);

		sections.push(renderDeals('PAUSED:', paused.deals));

		if (route.needLogs) {

			const events = await LogScan.getNotableEvents(dates, instanceName, MAX_LOG_LINES);

			sections.push(renderLogLines('NOTABLE LOG EVENTS:', events.lines));
		}
	}
	else if (route.scope === 'active_deals') {

		const active = await DealQuery.getActiveDeals(MAX_DEALS);

		sections.push(renderDeals('', active.deals));
	}

	return (sections.filter(s => s !== '').join('\n'));
}


// Build the context block for a message, or '' when nothing applies.
// This is the only function callers need. Single exit; every failure path
// yields '' so the conversation continues unchanged.
//
// A deal analysis (purpose 'analysis') is skipped outright: its prompt is a
// self-contained report that already carries every figure the model needs, so
// running the router over it only prepends redundant data and chat-oriented
// rules. This mirrors the room-name exclusion above — the streamed UI analysis
// simply runs in a chat room, so the purpose is what identifies it here.
async function build(room, message, history, purpose) {

	let context = '';

	if (purpose === 'analysis') { return context; }

	if (isEnabled() && isConversationalRoom(room) && typeof message === 'string' && message.trim() !== '') {

		try {

			// The routing pass costs a full model round trip, which is the slowest
			// part of answering. It is only worth paying when it can change the
			// outcome.
			const direct = heuristicRoute(message, history);

			// Already names its deals: nothing left to resolve.
			const selfContained = extractIdentifiers(message).dealIds.length > 0;

			// Carries no sign of wanting data at all — "tell me more", "thanks",
			// "explain that". Routing such a message can only return the same
			// general scope the heuristic already gave, so the round trip buys
			// nothing and makes a conversational reply feel slow.
			const looksConversational = VAGUE_CONTINUATION_RE.test(message.trim())
				|| (direct.scope === 'general'
					&& !extractIdentifiers(message).pair
					&& message.trim().split(/\s+/).length <= CONVERSATIONAL_MAX_WORDS);

			const skipRouter = selfContained || looksConversational;

			const parsed = skipRouter ? null : await routeQuestion(message, history);

			const route = skipRouter ? direct : validateRoute(parsed, message, history);

			if (selfContained) {

				logger('message names its deals — routing pass skipped');
			}
			else if (looksConversational) {

				logger('conversational follow-up — routing pass skipped');
			}

			// A clarifying-question path was tried here: when the routing pass flagged
			// a reference as ambiguous, ask which deal is meant instead of guessing.
			// It was removed because it could not be reached. The heuristic either
			// resolves the reference from the conversation, leaving nothing to ask,
			// or does not scope the question to a single deal at all — and when the
			// router alone claimed ambiguity, it turned "tell me about my deals"
			// into a question back to the user. The ambiguous and clarify fields are
			// still carried on the route for future use.

			if (route.scope !== 'general') {

				const data = await gatherData(route);

				if (data !== '') {

					const trimmed = data.length > MAX_CONTEXT_CHARS
						? data.slice(0, MAX_CONTEXT_CHARS) + '\n…[context truncated]'
						: data;

					// Instructions go before the data, not after, and only the ones this
					// answer can actually breach are included. A long block of rules
					// appended to every reply competed with the data for attention and
					// repeated the very words it was trying to prevent — the model began
					// echoing "COMPLETED" back from the instructions themselves.
					const rules = [ 'Use only the data below. If it does not answer the question, say so.' ];

					if (data.indexOf('OPEN DEALS') !== -1) {

						// The count is stated so a list that ends early is visible as wrong.
						// A long list can otherwise trail off a deal short without anything
						// in the reply indicating something is missing.
						rules.push('List every deal shown. The heading gives the count — your reply must include '
							+ 'that many deals, none omitted.');

						rules.push('These are the user\'s own deals. Every deal under YOUR OPEN DEALS is still '
							+ 'running: do not describe any of them as completed, finished or sold, and do not give '
							+ 'them a profit or loss. Safety order counts are numbers of ORDERS, never quantities of '
							+ 'coins or tokens, and a deal with 0 more safety orders available has not sold anything.');
					}

					if (data.indexOf('COMPLETED DEALS') !== -1) {

						rules.push('Only deals under YOUR COMPLETED DEALS have finished.');
					}

					if (data.indexOf('WHAT HAPPENED ON') !== -1) {

						rules.push('The log events below are the answer to what happened. Summarize them; do not '
							+ 'say you lack information about past activity.');
					}

					if (data.indexOf('Matching lines found') !== -1) {

						rules.push('Report the count exactly as given; do not recount or reinterpret it.');
					}

					if (data.indexOf('none found in the logs') !== -1 || data.indexOf('does NOT establish') !== -1) {

						rules.push('Where the data says nothing was found, say that plainly rather than concluding '
							+ 'the events did not happen.');
					}

					rules.push('Quote deal ids, prices and quantities exactly, and never invent one. If no deal '
						+ 'id, price or quantity appears below, do not mention any — not even as an example.');

					// The header says whose deals these are. Without it a question phrased
					// as "my deals" has nothing to attach to, and the model answers that
					// it cannot tell which deals belong to the user.
					context = rules.map(r => '- ' + r).join('\n')
						+ '\n\nTHE USER\'S OWN SYMBOT DATA (read-only, retrieved for this question). '
						+ 'Everything below belongs to the user asking:\n\n'
						+ trimmed;

					logger('scope ' + route.scope + ' via ' + route.source + ' — ' + trimmed.length + ' chars');
				}
			}
		}
		catch (e) {

			logger('build failed (' + e.message + ') — continuing without context');

			context = '';
		}
	}

	return (context);
}


module.exports = {

	build,
	isEnabled,
	isConversationalRoom,
	heuristicRoute,
	validateRoute,
	parseJsonObject,
	extractIdentifiers,
	recentDates,

	init: function(obj) {

		shareData = obj;
		logger = obj.Common.makeLogger('AI context: ');

		LogScan.init(obj);
		DealQuery.init(obj);
	}
};