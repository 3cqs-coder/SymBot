'use strict';

// Regression tests for two circuit-breaker safety-net accuracy fixes (DCABot.js):
//   • cbActiveDealDenominator — the deal-ratio trigger must divide by the LIVE tracked active-deal count,
//     so it works on a headless / API-only deployment. Previously it divided by a cache that only a polling
//     browser refreshed, so with no dashboard open the denominator collapsed to 1 and a normal broad dip
//     (two deals firing a safety order) tripped the breaker every window.
//   • portfolioLossMatchStage — the realized portfolio-loss window must EXCLUDE canceled deals. A cancel
//     keeps the coins and sells nothing, yet still records a marked-to-market sellData.profitQuote; counting
//     it would inject a fictitious realized loss (false halt) or gain (masking a real loss).
// Both are pure helpers exported for testing, so no DB / exchange wiring is needed.

const assert = require('assert');
const DCABot = require('../../../strategies/DCABot/DCABot.js');

DCABot.init({ appData: {} });

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

const { cbActiveDealDenominator, portfolioLossMatchStage } = DCABot;

// ── M1: deal-ratio denominator ───────────────────────────────────────────────
console.log('\ncbActiveDealDenominator (deal-ratio denominator):');

ok(cbActiveDealDenominator(5, undefined) === 5, 'live count is used even with no browser-refreshed cache (headless works)');
ok(cbActiveDealDenominator(3, 10) === 3, 'the live count wins over a stale cache');
ok(cbActiveDealDenominator(0, 8) === 8, 'falls back to the cache when the live tracker is empty');
ok(cbActiveDealDenominator(0, undefined) === 1, 'falls back to 1 only when neither is available');
ok(cbActiveDealDenominator(0, 0) === 1, 'a zero cache still floors at 1 (never divide by zero)');

// The exact headless regression: 2 unique deals fired safety orders out of 5 active. With the live count
// the ratio is 2/5 = 0.4 < 0.5 → the breaker does NOT trip. The old cache-only path gave 2/(undefined||1)
// = 2 ≥ 0.5 → a spurious trip. Prove the denominator is now the real base.
const denom = cbActiveDealDenominator(5, undefined);
ok((2 / denom) === 0.4, 'headless: 2-of-5 yields a real 0.4 ratio (below a 0.5 threshold), not the old 2.0 spurious trip');

// ── M2: realized portfolio-loss match excludes canceled deals ─────────────────
console.log('\nportfolioLossMatchStage (realized-loss window):');

const windowStart = new Date('2026-01-01T00:00:00Z');
const stage = portfolioLossMatchStage(windowStart);

ok(stage['sellData.date'] && stage['sellData.date']['$gte'] === windowStart, 'window is scoped by sellData.date >= windowStart');
ok(stage['canceled'] && stage['canceled']['$ne'] === true, 'canceled deals are excluded (canceled $ne true)');

// Apply the match semantics to a mock deal set to prove a canceled, deeply-underwater deal is NOT counted
// toward the realized loss (which is what would have falsely tripped or skewed the portfolio-loss breaker).
function matches(deal, m) {
	const inWindow = deal.sellData && deal.sellData.date && deal.sellData.date >= m['sellData.date']['$gte'];
	const notCanceled = deal.canceled !== true;   // mirrors $ne: true (missing/false pass)
	return inWindow && notCanceled;
}
const deals = [
	{ pair: 'BTC/USD', canceled: false, sellData: { date: new Date('2026-02-01T00:00:00Z'), profitQuote: -50 } },  // real loss, counts
	{ pair: 'ETH/USD', canceled: true,  sellData: { date: new Date('2026-02-02T00:00:00Z'), profitQuote: -9999 } }, // canceled, must NOT count
	{ pair: 'SOL/USD', canceled: false, sellData: { date: new Date('2025-12-01T00:00:00Z'), profitQuote: -80 } },  // before window, excluded
];
const realized = deals.filter(d => matches(d, stage)).reduce((s, d) => s + d.sellData.profitQuote, 0);
ok(realized === -50, 'only the genuinely-sold in-window deal counts (-50); the canceled -9999 and the out-of-window -80 are excluded');

console.log('\n' + passed + ' assertions passed');
process.exit(0);
