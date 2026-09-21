'use strict';

// Pins Common.quoteCurrency — the ONE canonical "quote currency of a pair" helper that both the
// dashboard KPI split and the trading-journal split now share, so they can never diverge and label the
// same money two different ways. The load-bearing correctness property this locks:
//
//   * bucketing keys on the QUOTE currency (parts[1]), NEVER on a deal's profit_currency setting. The
//     money summed (deal.profit) is always quote-denominated; keying on profit_currency='base' would
//     mislabel it and — worse — could falsely split a genuinely single-quote-currency instance into two
//     currencies, showing a per-currency breakdown where one blended-free total is correct. This was the
//     exact confusion the cross-currency guard was corrected to avoid.
//   * both the "/" and "_" pair spellings resolve, and the result is upper-cased, so BTC/usdt and
//     BTC_USDT and BTC/USDT all bucket together rather than into three phantom currencies.
//   * an unparseable pair yields the 'UNKNOWN' sentinel (visibly quarantined), which the bucketers drop
//     rather than merge into a real currency — so a single malformed pair can't flip a single-currency
//     instance into a multi-currency split.

const assert = require('assert');
const Common = require('../../app/Common.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function eq(a, b, m) { assert.strictEqual(a, b, m + ' (got ' + a + ', want ' + b + ')'); passed++; }

// ── the quote is parts[1], both separators, upper-cased ──
eq(Common.quoteCurrency('BTC/USDT'), 'USDT', 'quote of BTC/USDT is USDT (the SECOND leg, not the base)');
eq(Common.quoteCurrency('ETH/BTC'), 'BTC', 'quote of ETH/BTC is BTC');
eq(Common.quoteCurrency('BTC_USDT'), 'USDT', 'the underscore pair form resolves the same as the slash form');
eq(Common.quoteCurrency('btc/usdt'), 'USDT', 'the result is upper-cased so casing never splits a currency');

// ── the sentinel for anything unparseable ──
eq(Common.quoteCurrency(''), 'UNKNOWN', 'empty string -> UNKNOWN');
eq(Common.quoteCurrency('BTCUSDT'), 'UNKNOWN', 'a separator-less symbol -> UNKNOWN (not silently the whole string)');
eq(Common.quoteCurrency(null), 'UNKNOWN', 'null -> UNKNOWN, never a throw');
eq(Common.quoteCurrency(undefined), 'UNKNOWN', 'undefined -> UNKNOWN, never a throw');
eq(Common.quoteCurrency(12345), 'UNKNOWN', 'a non-string -> UNKNOWN, never a throw');

// ── the property that matters: a single-quote-currency set is ONE bucket, regardless of base assets ──
// Two different BASE assets (BTC, ETH) against the SAME quote (USDT) must collapse to a single currency.
// If bucketing ever keyed on the base or on profit_currency, this would wrongly report two currencies.
(function () {
	const deals = [ { pair: 'BTC/USDT', profit: 10 }, { pair: 'ETH/USDT', profit: 5 }, { pair: 'SOL/USDT', profit: -3 } ];
	const buckets = {};
	deals.forEach(d => { const c = Common.quoteCurrency(d.pair); buckets[c] = (buckets[c] || 0) + d.profit; });
	const keys = Object.keys(buckets);
	ok(keys.length === 1 && keys[0] === 'USDT', 'three different base assets, one quote currency -> exactly ONE bucket (USDT)');
	ok(buckets.USDT === 12, 'the single-currency total sums normally (10 + 5 - 3 = 12)');
})();

// ── genuinely mixed quote currencies DO split (the guard must still fire when it should) ──
(function () {
	const deals = [ { pair: 'BTC/USDT', profit: 10 }, { pair: 'ETH/BTC', profit: 0.5 } ];
	const buckets = {};
	deals.forEach(d => { const c = Common.quoteCurrency(d.pair); if (c !== 'UNKNOWN') buckets[c] = (buckets[c] || 0) + d.profit; });
	const keys = Object.keys(buckets).sort();
	assert.deepStrictEqual(keys, [ 'BTC', 'USDT' ], 'two real quote currencies split into two buckets'); passed++;
	ok(buckets.USDT === 10 && buckets.BTC === 0.5, 'each currency keeps its own total, never blended');
})();

// ── mixed-case / underscore forms of the SAME quote merge into one bucket ──
// This is the property the portfolio-loss circuit breaker relies on: it buckets realized loss per quote
// currency and halts on the worst single-currency net. If 'BTC/usdt' and 'BTC/USDT' landed in separate
// buckets, a single-currency loss would be split and the worst net understated, letting the breaker
// under-halt. Routing every bucketer through this helper guarantees they collapse to one label.
(function () {
	const losses = [ { pair: 'ETH/usdt', p: -300 }, { pair: 'BTC/USDT', p: -250 }, { pair: 'SOL_USDT', p: -100 } ];
	const byCur = {};
	losses.forEach(x => { const c = Common.quoteCurrency(x.pair); byCur[c] = (byCur[c] || 0) + x.p; });
	const keys = Object.keys(byCur);
	ok(keys.length === 1 && keys[0] === 'USDT', 'mixed-case and underscore forms of USDT collapse to a single bucket');
	ok(byCur.USDT === -650, 'the whole loss lands in one bucket (-650), never split by casing so the worst-net can under-halt');
})();

// ── a lone malformed pair does not manufacture a phantom currency alongside a real one ──
(function () {
	const deals = [ { pair: 'BTC/USDT', profit: 10 }, { pair: 'GARBAGE', profit: 1 } ];
	const buckets = {};
	deals.forEach(d => { const c = Common.quoteCurrency(d.pair); if (c && c !== 'UNKNOWN') buckets[c] = (buckets[c] || 0) + d.profit; });
	const keys = Object.keys(buckets);
	ok(keys.length === 1 && keys[0] === 'USDT', 'a malformed pair is dropped, not turned into a second currency that fakes a multi-currency split');
})();

console.log('QuoteCurrency: ' + passed + ' assertions passed');
