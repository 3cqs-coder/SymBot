'use strict';

// Hub dashboard profit accounting must be currency-aware: it may NEVER sum profit across different quote
// currencies into one number (a USDT + BTC total is meaningless). These tests pin the pure helpers behind the
// Hub dashboard aggregation — quoteCurrencyOf (the quote asset of a pair) and summarizeProfit (a single scalar
// only when one currency is present, otherwise a per-currency breakdown with profit:null) — which mirror the
// instance portfolio layer. Single-currency fleets (the common case) still get a clean scalar total.

const assert = require('assert');
const Hub = require('../../app/Hub/Hub.js');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

console.log('\nHub dashboard profit summary (currency-aware):');

// ── quoteCurrencyOf ──
// The Hub helper delegates to Common.quoteCurrency when wired; here (no shareData) it uses its inline fallback,
// which matches the canonical behavior: it accepts both the "/" and "_" pair forms, upper-cases the result, and
// returns 'UNKNOWN' for anything unparseable so a malformed pair is visibly quarantined rather than mislabeled.
test('quoteCurrencyOf returns the quote asset, uppercased, for both pair forms', () => {
	assert.strictEqual(Hub.quoteCurrencyOf('BTC/USDT'), 'USDT');
	assert.strictEqual(Hub.quoteCurrencyOf('eth/usd'), 'USD');
	assert.strictEqual(Hub.quoteCurrencyOf('ETH_BTC'), 'BTC');
});
test('quoteCurrencyOf quarantines empty/malformed pairs as UNKNOWN', () => {
	assert.strictEqual(Hub.quoteCurrencyOf(''), 'UNKNOWN');
	assert.strictEqual(Hub.quoteCurrencyOf(null), 'UNKNOWN');
	assert.strictEqual(Hub.quoteCurrencyOf('NOSEP'), 'UNKNOWN');
});

// ── summarizeProfit ──
test('no deals -> zero scalar, no currency', () => {
	const s = Hub.summarizeProfit({});
	assert.deepStrictEqual(s, { profit: 0, profit_currency: null, profit_by_currency: {} });
});

test('single currency -> a scalar total with that currency', () => {
	const s = Hub.summarizeProfit({ USDT: 123.4 });
	assert.strictEqual(s.profit, 123.4);
	assert.strictEqual(s.profit_currency, 'USDT');
	assert.deepStrictEqual(s.profit_by_currency, { USDT: 123.4 });
});

test('single currency negative total is preserved', () => {
	const s = Hub.summarizeProfit({ USD: -5.5 });
	assert.strictEqual(s.profit, -5.5);
	assert.strictEqual(s.profit_currency, 'USD');
});

test('values are rounded to 2 decimals', () => {
	const s = Hub.summarizeProfit({ USD: 12.3456 });
	assert.strictEqual(s.profit, 12.35);
});

test('MULTIPLE currencies -> profit is null (never summed) with a per-currency breakdown', () => {
	// Amounts are held at the app's standard 2-decimal precision (the same .toFixed(2) the dashboard has always
	// used); the point here is that the two currencies stay SEPARATE and no single cross-currency total is made.
	const s = Hub.summarizeProfit({ USDT: 50.25, BTC: 0.05 });
	assert.strictEqual(s.profit, null, 'must not produce a single cross-currency total');
	assert.strictEqual(s.profit_currency, null);
	assert.deepStrictEqual(s.profit_by_currency, { USDT: 50.25, BTC: 0.05 });
});

console.log('\nHubProfitSummary: ' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
