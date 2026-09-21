'use strict';

// Common.roundCost — the single consolidated cost-basis rounding helper (backlog #115).
//
// The hard requirement: USD / USDT (and every USD-stable / fiat) quote must stay BYTE-IDENTICAL to
// the old `Math.round(x * 100) / 100`, while a crypto-quoted pair (e.g. ETH/BTC) keeps finer
// precision instead of being truncated to cents. These tests prove both, exhaustively over a large
// random sample for the byte-identical guarantee.

const assert = require('assert');
const Common = require('../../app/Common.js');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

const prior = (x) => Math.round(Number(x) * 100) / 100;   // the exact expression we replaced

console.log('\nroundCost (cost-basis precision):');

test('USD/USDT quotes are byte-identical to the old Math.round(x*100)/100', () => {
	const usdPairs = [ 'BTC/USD', 'ETH/USDT', 'SOL/USDC', 'XRP/BUSD', 'ADA/DAI', 'DOGE/TUSD' ];
	// deterministic spread of values incl. the classic float-rounding edge cases
	const vals = [ 0, 0.005, 0.01, 0.015, 0.025, 0.045, 1.005, 2.345, 12.3456, 999.999, 1000000.005, 0.1 + 0.2 ];
	for (const p of usdPairs) {
		for (const v of vals) {
			assert.strictEqual(Common.roundCost(v, p), prior(v), `${p} @ ${v}`);
		}
	}
});

test('byte-identical over 20k pseudo-random values (fixed seed, no RNG)', () => {
	// Simple deterministic LCG so the suite never flakes and needs no Date/Math.random.
	let s = 123456789;
	const next = () => (s = (1103515245 * s + 12345) & 0x7fffffff) / 0x7fffffff;
	for (let i = 0; i < 20000; i++) {
		const v = (next() * 200000) - 100000;   // range spanning big + small, +/-
		assert.strictEqual(Common.roundCost(v, 'BTC/USDT'), prior(v), 'value ' + v);
	}
});

test('crypto-quoted pair keeps finer precision (not truncated to cents)', () => {
	assert.strictEqual(Common.roundCost(0.0523, 'ETH/BTC'), 0.0523);       // would have been 0.05
	assert.strictEqual(Common.roundCost(0.00012345, 'SOL/BTC'), 0.00012345);
	assert.strictEqual(Common.roundCost(1.23456789, 'AAVE/ETH'), 1.23456789);
	// still normalizes binary float artifacts to 8 dp
	assert.strictEqual(Common.roundCost(0.1 + 0.2, 'X/BTC'), 0.3);
	// the UNDERSCORE pair form ("ETH_BTC") is now recognized too (via the canonical quoteCurrency helper),
	// so a crypto-quoted underscore pair keeps finer precision instead of falling through to 2 dp.
	assert.strictEqual(Common.roundCost(0.0523, 'ETH_BTC'), 0.0523);          // was 0.05 before the fix
	assert.strictEqual(Common.roundCost(0.00012345, 'SOL_BTC'), 0.00012345);
});

test('unknown / unparseable pair falls back to the safe 2-decimal behavior', () => {
	assert.strictEqual(Common.roundCost(2.345, null), prior(2.345));
	assert.strictEqual(Common.roundCost(2.345, ''), prior(2.345));
	assert.strictEqual(Common.roundCost(2.345, 'NOTAPAIR'), prior(2.345));
	assert.strictEqual(Common.roundCost(2.345, undefined), prior(2.345));
});

test('quote currency is matched case-insensitively and trimmed', () => {
	assert.strictEqual(Common.roundCost(12.3456, 'btc/usdt'), 12.35);        // usdt → 2 dp
	assert.strictEqual(Common.roundCost(0.0523, 'sol/ btc '), 0.0523);       // btc → finer
});

test('non-finite input is coerced to 0, never NaN', () => {
	assert.strictEqual(Common.roundCost(NaN, 'BTC/USDT'), 0);
	assert.strictEqual(Common.roundCost(Infinity, 'ETH/BTC'), 0);
	assert.strictEqual(Common.roundCost('not-a-number', 'BTC/USD'), 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);