'use strict';

const { toNum } = require('../../app/Common.js');

/**
 * Signal Bot — pure helpers, all in one place.
 *
 * Dependency-free Signal Bot logic shared by the engine (DCABot.js) and the
 * API/UI layer (DCABotManager.js). No I/O, no DB, no exchange, so it stays
 * trivially unit-testable and safe to require from anywhere:
 *
 *   buildSignalAlerts()     — generate the copy-paste webhook alert messages
 *                             (entry / add_funds / close / panic_sell) for a bot.
 *   evaluateGracefulClose() — the graceful `close` profit guard: only close when
 *                             the deal's price is at/above its take-profit target.
 *   isApiStart()            — is the bot's primary start condition `api`? Drives
 *                             both the UI's Signal Bot mode and the engine's
 *                             manual/API re-entry gate (an "api" bot does not
 *                             auto-open a new deal after one completes).
 */


// ─────────────────────────────────────────────────────────────────────────────
// Alert-message generator
// ─────────────────────────────────────────────────────────────────────────────
//
// A TradingView alert posts the message body to the webhook path. TradingView
// substitutes {{ticker}} with the chart symbol, so one alert works across pairs.
// The apiToken defaults to a {{YOUR_TOKEN}} placeholder — the token is a
// credential and should be filled in by the user (or revealed deliberately in
// the UI), never printed casually.
//
// The four commands map onto existing webhook endpoints:
//   entry       -> /webhook/api/bots/{botId}/start_deal   (open a deal)
//   add_funds   -> /webhook/api/bots/{botId}/add_funds     (one safety order)
//   close       -> /webhook/api/bots/{botId}/close         (graceful, respects TP)
//   panic_sell  -> /webhook/api/bots/{botId}/panic_sell    (emergency, ignores TP)

const TOKEN_PLACEHOLDER = '{{YOUR_TOKEN}}';
const TICKER_PLACEHOLDER = '{{ticker}}';
const DEFAULT_ADD_FUNDS_VOLUME = 20;


/**
 * Build the full set of Signal Bot alert messages for a bot.
 *
 * @param {object} opts
 * @param {string} opts.botId              The bot's id (required).
 * @param {string} [opts.baseUrl]          Public origin of the SymBot server. If
 *                                         omitted, `url` is the relative path and
 *                                         the caller (browser) prepends its origin.
 * @param {string} [opts.token]            apiToken to embed. Defaults to the
 *                                         {{YOUR_TOKEN}} placeholder.
 * @param {string} [opts.pairPlaceholder]  Value used for `pair` in the multi-pair
 *                                         variant. Defaults to {{ticker}}.
 * @param {number} [opts.addFundsVolume]   Volume for the add_funds body. Default 20.
 * @returns {{bot_id:string, base_url:string, token_is_placeholder:boolean, commands:Array}}
 */
function buildSignalAlerts(opts) {

	opts = opts || {};

	const botId = String(opts.botId == undefined ? '' : opts.botId).trim();

	if (botId === '') {

		throw new Error('buildSignalAlerts: botId is required');
	}

	const baseUrl = trimTrailingSlash(opts.baseUrl || '');
	const token = (opts.token == undefined || opts.token === '') ? TOKEN_PLACEHOLDER : String(opts.token);
	const pairPlaceholder = (opts.pairPlaceholder == undefined || opts.pairPlaceholder === '') ? TICKER_PLACEHOLDER : String(opts.pairPlaceholder);

	let addFundsVolume = Number(opts.addFundsVolume);

	if (!Number.isFinite(addFundsVolume) || addFundsVolume <= 0) {

		addFundsVolume = DEFAULT_ADD_FUNDS_VOLUME;
	}

	const specs = [
		{
			'command': 'entry',
			'label': 'Entry — open a deal (base order)',
			'endpoint': 'start_deal',
			'extra': {}
		},
		{
			'command': 'add_funds',
			'label': 'Add funds — one safety order',
			'endpoint': 'add_funds',
			'extra': { 'volume': addFundsVolume }
		},
		{
			'command': 'close',
			'label': 'Close — graceful, respects the profit target',
			'endpoint': 'close',
			'extra': {}
		},
		{
			'command': 'panic_sell',
			'label': 'Panic sell — emergency close, ignores profit',
			'endpoint': 'panic_sell',
			'extra': {}
		}
	];

	const commands = specs.map((spec) => {

		const path = '/webhook/api/bots/' + botId + '/' + spec['endpoint'];
		const url = baseUrl + path;

		// Multi-pair variant carries `pair` (TradingView fills {{ticker}}); the
		// single-pair variant omits it entirely for the simplest possible setup.
		const bodyMulti = buildBody(token, pairPlaceholder, spec['extra']);
		const bodySingle = buildBody(token, null, spec['extra']);

		return {
			'command': spec['command'],
			'label': spec['label'],
			'path': path,
			'url': url,
			'body_multi': bodyMulti,
			'body_single': bodySingle,
			'json_multi': JSON.stringify(bodyMulti, null, 2),
			'json_single': JSON.stringify(bodySingle, null, 2)
		};
	});

	return {
		'bot_id': botId,
		'base_url': baseUrl,
		'token_is_placeholder': token === TOKEN_PLACEHOLDER,
		'commands': commands
	};
}


/**
 * Build a single alert body with a stable key order: apiToken, [pair], [extra].
 * Passing pair === null omits it (single-pair variant).
 */
function buildBody(token, pair, extra) {

	const body = { 'apiToken': token };

	if (pair !== null && pair !== undefined && pair !== '') {

		body['pair'] = pair;
	}

	if (extra && typeof extra === 'object') {

		for (const key in extra) {

			body[key] = extra[key];
		}
	}

	return body;
}


function trimTrailingSlash(str) {

	return String(str || '').replace(/\/+$/, '');
}


// ─────────────────────────────────────────────────────────────────────────────
// Graceful-close profit guard
// ─────────────────────────────────────────────────────────────────────────────
//
// The pure decision of whether a graceful `close` may close a deal. The actual
// market close is always performed by the existing, proven `panicSellDeal` path
// — this guard just decides yes/no. There is deliberately NO parameter that can
// turn a graceful close into an unconditional close; if the target cannot be
// confirmed met (e.g. no live price yet), it fails safe and refuses to close.
// `panic_sell` is the separate, profit-ignoring emergency close.

/**
 * Decide whether a graceful close may proceed. Price-based to mirror the engine's
 * own take-profit gate (it sells when price reaches the order's target price);
 * `price_target` is the take-profit price (currentOrder.target).
 *
 * @param {object} data
 * @param {number} data.price_last            Current/live market price for the pair.
 * @param {number} data.price_target          Take-profit target price for the active order.
 * @param {number} [data.profit_percentage]   Live net profit % (informational only).
 * @param {number} [data.take_profit_percent] Configured dcaTakeProfitPercent (informational only).
 * @returns {{ready:boolean, reason:string, message:string, price_last:(number|null), price_target:(number|null), profit_percentage:(number|null), take_profit_percent:(number|null)}}
 */
function evaluateGracefulClose(data) {

	data = data || {};

	const priceLast = toNum(data['price_last']);
	const priceTarget = toNum(data['price_target']);

	// One result object, built once and returned once. The shared fields live in
	// a single place; only ready/reason/message change per outcome, so a future
	// edit can't leave one branch out of step with another.
	const result = {
		'ready': false,
		'reason': '',
		'message': '',
		'price_last': priceLast,
		'price_target': priceTarget,
		'profit_percentage': toNum(data['profit_percentage']),
		'take_profit_percent': toNum(data['take_profit_percent'])
	};

	if (priceLast === null || priceLast <= 0 || priceTarget === null || priceTarget <= 0) {

		// Fail safe: without a valid live price AND target we cannot confirm the
		// profit target is met, so we do NOT close. Leaving the deal open can never
		// lose money; closing when we're unsure could dump at a loss.
		result['reason'] = 'no_live_price';
		result['message'] = 'Profit target not yet determinable (no live price/target for the deal); deal left open';
	}
	else if (priceLast >= priceTarget) {

		result['ready'] = true;
		result['reason'] = 'target_met';
		result['message'] = 'Profit target met; closing at market';
	}
	else {

		result['reason'] = 'target_not_met';
		result['message'] = 'Profit target not met (current price below take-profit target); deal left open';
	}

	return result;
}


// ─────────────────────────────────────────────────────────────────────────────
// Start-condition predicate (Signal Bot / manual-API)
// ─────────────────────────────────────────────────────────────────────────────
//
// The single, atomic question "is this bot's primary start condition `api`?" —
// i.e. is it a manual / API (Signal Bot) bot rather than `asap` or a provider
// signal bot such as 3CQS (`signal|...`). Two things derive from it, so it lives
// in one tested place:
//
//   • UI: whether the bot is in Signal Bot mode (isSignalBot).
//   • Engine: whether auto-reopen must be suppressed when a deal completes. An
//     api bot's deals come only from external entry signals, so a completed deal
//     must NOT auto-chain a new one — the bot waits for the next signal. (This is
//     the ONLY re-entry gate; it is deliberately NOT part of canStartDeal, which
//     also governs explicit signal-driven starts that an api bot must be allowed
//     to make.)

/**
 * @param {string|string[]} startConditions  The bot's startConditions (array or
 *        single string). Only the first/primary condition determines the strategy.
 * @returns {boolean} true when the primary start condition is `api`.
 */
function isApiStart(startConditions) {

	let first = '';

	if (Array.isArray(startConditions)) {

		first = startConditions[0];
	}
	else if (typeof startConditions === 'string') {

		first = startConditions;
	}

	return String(first == undefined || first == null ? '' : first).trim().toLowerCase() === 'api';
}


/**
 * Resolve an inbound signal ticker to one of a bot's OWN configured pairs.
 *
 * A signal source (TradingView's {{ticker}}, or a custom script) sends the symbol in its own
 * format — "BTCUSD", "COINBASE:BTCUSD", "BTC-USD" — which need not match the "BTC/USD" form SymBot
 * stores. This maps such a ticker back to the exact pair the bot is configured for, so a multi-pair
 * Signal Bot alert works without the user hand-formatting every symbol.
 *
 * Deliberately conservative and purely additive — the caller consults it only AFTER an exact match
 * has already been attempted, and it can only ever return a pair the bot is ALREADY configured for:
 *   1. An exact (case-insensitive) match wins, mirroring the previous first-match-wins behavior, so
 *      any pair that resolved before resolves identically now.
 *   2. Otherwise it compares on a "compact" form (letters and digits only, upper-cased) after
 *      dropping any "EXCHANGE:" prefix, so "BTCUSD" / "COINBASE:BTC-USD" both map to a configured
 *      "BTC/USD" while "BTCUSDT" still maps only to "BTC/USDT".
 *   3. The compact match must be UNIQUE. Zero matches, or more than one, returns null — the caller
 *      then rejects exactly as it did before. It never guesses and never widens the bot's pair set.
 *
 * @param {string} inputPair          The raw pair/ticker from the signal.
 * @param {string[]} configuredPairs  The bot's configured pairs (canonical "BASE/QUOTE").
 * @returns {string|null} The matching configured pair (its stored form), or null if none/ambiguous.
 */
function resolveConfiguredPair(inputPair, configuredPairs) {

	if (typeof inputPair !== 'string') { return null; }

	const pairs = Array.isArray(configuredPairs) ? configuredPairs.filter((p) => typeof p === 'string') : [];

	if (pairs.length === 0) { return null; }

	const raw = inputPair.trim();

	if (raw === '') { return null; }

	// 1. Exact, case-insensitive — first match wins, exactly as the previous loop did.
	const exact = pairs.find((p) => p.toUpperCase() === raw.toUpperCase());

	if (exact != undefined) { return exact; }

	// 2. Compact compare: drop an "EXCHANGE:" prefix, then keep only letters and digits.
	const compact = (s) => String(s).split(':').pop().toUpperCase().replace(/[^A-Z0-9]/g, '');

	const target = compact(raw);

	if (target === '') { return null; }

	const hits = pairs.filter((p) => compact(p) === target);

	// Unique match only — never guess between two configured pairs that compact to the same string.
	return hits.length === 1 ? hits[0] : null;
}


module.exports = {

	resolveConfiguredPair,

	buildSignalAlerts,
	evaluateGracefulClose,
	isApiStart,
	toNum,
	TOKEN_PLACEHOLDER,
	TICKER_PLACEHOLDER,
	DEFAULT_ADD_FUNDS_VOLUME
};