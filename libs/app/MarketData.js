'use strict';

// Read-only public market data (OHLCV candles) for the per-deal chart.
//
// This module deliberately keeps its OWN keyless ccxt clients, entirely separate from the trading
// exchange objects in shareData.appData.exchanges. OHLCV is PUBLIC market data, so it needs no API
// credentials, and by never touching the trading clients it cannot rate-limit them, mutate their
// state, or otherwise reach the trading loop. Every call is best-effort and fully wrapped: a failure
// returns a structured result, never a throw. Nothing here places, reads, or affects any order.

const ccxt = require('ccxt');
const Common = require('./Common.js');

let shareData;

const FETCH_TIMEOUT_MS = 12000;   // per-request ccxt timeout
const CACHE_TTL_MS     = 20000;   // short cache so repeat views of the same chart don't hammer the API
const DEFAULT_LIMIT    = 300;
const MAX_LIMIT        = 1000;    // hard cap on candles per request
const MAX_CACHE_ENTRIES = 200;    // bound the candle cache (oldest evicted past this)

const clients = {};   // "<exchangeId>|<type>" -> keyless public ccxt client
const cache   = {};   // "<exchangeId>|<type>|<symbol>|<timeframe>|<limit>" -> { at, data }


// CCXT has renamed some exchanges over time; delegate to the single shared alias map so the same
// configured exchange name resolves identically here and on the trading side.
function exchangeAlias(name) {

	return Common.exchangeAlias(name);
}


function resolveType(defaultType) {

	const t = String(defaultType || '').toLowerCase();

	return (t === 'swap' || t === 'future' || t === 'futures') ? 'swap' : 'spot';
}


// Lazily create and cache a keyless public client for an exchange + market type. Returns null for an
// unknown exchange id so callers can report "unsupported exchange" instead of throwing.
function clientFor(exchangeName, defaultType) {

	const id = exchangeAlias(String(exchangeName || '').trim());

	if (!id || typeof ccxt[id] !== 'function') { return null; }

	const type = resolveType(defaultType);
	const key  = id + '|' + type;

	if (!clients[key]) {

		clients[key] = new ccxt[id]({
			'enableRateLimit': true,
			'timeout': FETCH_TIMEOUT_MS,
			'options': { 'defaultType': type }
		});
	}

	return clients[key];
}


// Normalize a SymBot pair ("BTC/USD", "BTC-USD", "BTC_USD") to a ccxt unified symbol ("BTC/USD").
function normalizeSymbol(pair) {

	if (typeof pair !== 'string') { return ''; }

	const p = pair.trim().toUpperCase();

	if (p.indexOf('/') > -1) { return p; }
	if (p.indexOf('-') > -1) { return p.replace('-', '/'); }
	if (p.indexOf('_') > -1) { return p.replace('_', '/'); }

	return p;
}


// Raw ccxt-style rows [ timestamp_ms, open, high, low, close, volume ] — the shape the existing
// /api/markets/ohlcv consumers (text / AI context) read. Kept alongside the object candles so both the
// chart and the legacy callers are served by this one module.
function toRows(candles) {
	return (candles || []).map(function (c) { return [ c.time * 1000, c.open, c.high, c.low, c.close, c.volume ]; });
}


// Timeout a public market-data fetch (see Common.withTimeout for the shared logic). Rejects with a
// market-data-specific message so a hung exchange call can never stall the trading path.
function withTimeout(promise, ms) {
	return Common.withTimeout(promise, ms, { message: 'market data request timed out' });
}


// Which timeframes an exchange offers (for the interval selector) and whether it exposes candles at
// all. Reads ccxt's static describe() data — no network call.
function getCapabilities(exchangeName, defaultType) {

	const out = { 'success': true, 'available': false, 'timeframes': [] };

	try {

		const client = clientFor(exchangeName, defaultType);

		if (!client) { out.success = false; out.error = 'Unknown or unsupported exchange'; return out; }

		out.available = !!(client.has && client.has['fetchOHLCV']);

		if (client.timeframes && typeof client.timeframes === 'object') {

			out.timeframes = Object.keys(client.timeframes);
		}
	}
	catch (e) { out.success = false; out.error = (e && e.message) ? e.message : String(e); }

	return out;
}


// Fetch candles for a pair. Resolves to a structured result — never rejects.
//   { success, available, candles:[{time,open,high,low,close,volume}], timeframes:[], timeframe, error }
// available:false means the exchange has no OHLCV API (the caller shows the lite fallback + a message).
async function getOhlc(params) {

	const p = params || {};

	const result = { 'success': false, 'available': false, 'candles': [], 'timeframes': [], 'error': null };

	try {

		const id     = exchangeAlias(String(p.exchange || '').trim());
		const type   = resolveType(p.defaultType);
		const client = clientFor(id, type);

		if (!client) { result.error = 'Unknown or unsupported exchange'; return result; }

		// Advertise the exchange's timeframes regardless of the fetch outcome (drives the UI selector).
		if (client.timeframes && typeof client.timeframes === 'object') {

			result.timeframes = Object.keys(client.timeframes);
		}

		if (!(client.has && client.has['fetchOHLCV'])) {

			// Capability genuinely absent — not an error: the caller falls back to the order-only view.
			result.success   = true;
			result.available = false;
			result.reason    = 'no_ohlcv';
			return result;
		}

		result.available = true;

		const symbol = normalizeSymbol(p.pair);

		if (!symbol) { result.error = 'Missing or invalid pair'; return result; }

		let timeframe = String(p.timeframe || '').trim() || '1h';

		if (result.timeframes.length && result.timeframes.indexOf(timeframe) === -1) {

			// Requested interval not offered by this exchange — fall back to a common one it does offer.
			const common = ['1h', '1H', '60m'].filter(tf => result.timeframes.indexOf(tf) > -1)[0];
			timeframe = common || result.timeframes[0];
		}

		let limit = parseInt(p.limit, 10);
		if (!Number.isFinite(limit) || limit <= 0) { limit = DEFAULT_LIMIT; }
		limit = Math.min(limit, MAX_LIMIT);

		// Optional start time (ms since epoch). ccxt treats undefined as "most recent"; only forward a
		// finite, non-negative value so a stray param can't become NaN/garbage on the fetch.
		let since = parseInt(p.since, 10);
		if (!Number.isFinite(since) || since < 0) { since = undefined; }

		const cacheKey = id + '|' + type + '|' + symbol + '|' + timeframe + '|' + limit + '|' + (since != null ? since : '');
		const now      = Date.now();

		if (cache[cacheKey] && (now - cache[cacheKey].at) < CACHE_TTL_MS) {

			result.success   = true;
			result.candles   = cache[cacheKey].data;
			result.data      = toRows(result.candles);
			result.timeframe = timeframe;
			result.cached    = true;
			return result;
		}

		// Some ccxt exchanges only resolve a unified symbol to its market id after markets are loaded and
		// do not auto-load inside fetchOHLCV. Load them first (idempotent — ccxt caches after the first
		// call). Best-effort: if this hiccups we still attempt the fetch, which may succeed or surface a
		// clear error of its own.
		try { await withTimeout(client.loadMarkets(), FETCH_TIMEOUT_MS); } catch (e) {}

		const raw = await withTimeout(client.fetchOHLCV(symbol, timeframe, since, limit), FETCH_TIMEOUT_MS + 2000);

		const candles = (Array.isArray(raw) ? raw : [])
			.filter(r => Array.isArray(r) && r.length >= 5 && Number.isFinite(r[0]))
			.map(r => ({
				'time':   Math.floor(r[0] / 1000),   // ccxt gives ms; Lightweight Charts wants seconds
				'open':   Number(r[1]),
				'high':   Number(r[2]),
				'low':    Number(r[3]),
				'close':  Number(r[4]),
				'volume': Number(r[5] != null ? r[5] : 0)
			}))
			.filter(c => Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close));

		cache[cacheKey] = { 'at': now, 'data': candles };

		// Bound the cache: an authenticated caller could otherwise vary symbol/timeframe/limit to grow it
		// without limit. When over the cap, evict the oldest entry. (Small and off the trading path.)
		const keys = Object.keys(cache);
		if (keys.length > MAX_CACHE_ENTRIES) {
			let oldestKey = keys[0];
			for (const k of keys) { if (cache[k].at < cache[oldestKey].at) { oldestKey = k; } }
			delete cache[oldestKey];
		}

		result.success   = true;
		result.candles   = candles;
		result.data      = toRows(candles);
		result.timeframe = timeframe;
		return result;
	}
	catch (e) {

		result.error = (e && e.message) ? e.message : String(e);
		return result;
	}
}


function init(obj) { shareData = obj; }


module.exports = { init, getOhlc, getCapabilities, normalizeSymbol, exchangeAlias, resolveType };
