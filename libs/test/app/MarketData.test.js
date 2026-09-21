'use strict';

// Tests the read-only market-data module that feeds the per-deal chart. All cases are offline — they
// exercise the pure helpers and the guard paths that return BEFORE any network fetchOHLCV call, plus
// ccxt's static capability data (has / timeframes), which needs no network. The point is to prove the
// module degrades gracefully (structured results, never a throw) for unknown exchanges, missing pairs,
// and exchanges without a candle API — the robustness the chart relies on.

const assert = require('assert');
const M = require('../../app/MarketData.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// ── normalizeSymbol ──
ok(M.normalizeSymbol('BTC/USD') === 'BTC/USD', 'slash pair unchanged');
ok(M.normalizeSymbol('BTC-USD') === 'BTC/USD', 'dash pair -> slash');
ok(M.normalizeSymbol('btc_usdt') === 'BTC/USDT', 'underscore pair -> slash + upper');
ok(M.normalizeSymbol('  sol/usd ') === 'SOL/USD', 'trimmed + uppercased');
ok(M.normalizeSymbol(null) === '', 'null -> empty');
ok(M.normalizeSymbol(42) === '', 'non-string -> empty');

// ── exchangeAlias / resolveType ──
ok(M.exchangeAlias('coinbasepro') === 'coinbaseexchange', 'coinbasepro rename applied');
ok(M.exchangeAlias('binance') === 'binance', 'other names unchanged');
ok(M.resolveType('futures') === 'swap', 'futures -> swap');
ok(M.resolveType('swap') === 'swap', 'swap -> swap');
ok(M.resolveType('future') === 'swap', 'future -> swap (dated futures)');
ok(M.resolveType('SWAP') === 'swap', 'case-insensitive futures type');
ok(M.resolveType('spot') === 'spot', 'spot -> spot');
ok(M.resolveType('margin') === 'spot', 'margin trades spot markets -> spot candles');
ok(M.resolveType('') === 'spot', 'empty string (unset exchangeOptions) -> spot');
ok(M.resolveType(undefined) === 'spot', 'default -> spot');

// ── getCapabilities (ccxt static data, no network) ──
const capB = M.getCapabilities('binance');
ok(capB.success === true && capB.available === true, 'binance advertises OHLCV');
ok(Array.isArray(capB.timeframes) && capB.timeframes.indexOf('1h') > -1, 'binance timeframes include 1h');

const capU = M.getCapabilities('definitely-not-an-exchange');
ok(capU.success === false && !!capU.error, 'unknown exchange -> success:false + error');

// ── getOhlc guard paths (return before any network call) ──
(async () => {

	const unknown = await M.getOhlc({ exchange: 'definitely-not-an-exchange', pair: 'BTC/USD' });
	ok(unknown.success === false && unknown.available === false && !!unknown.error, 'unknown exchange: structured error, no throw');
	ok(Array.isArray(unknown.candles) && unknown.candles.length === 0, 'unknown exchange: empty candles');

	const noPair = await M.getOhlc({ exchange: 'binance', pair: '' });
	ok(noPair.success === false && !!noPair.error, 'missing pair: structured error, no throw');
	ok(noPair.available === true, 'missing pair on binance still reports OHLCV available');
	ok(Array.isArray(noPair.timeframes) && noPair.timeframes.length > 0, 'timeframes advertised even on the error path');

	const nullArgs = await M.getOhlc(null);
	ok(nullArgs.success === false, 'null params: no throw, structured failure');

	console.log('MarketData: ' + passed + ' assertions passed');

	// Requiring ccxt / constructing a client may register rate-limit timers; exit explicitly so the
	// unit test terminates instead of hanging the runner.
	process.exit(0);
})();
