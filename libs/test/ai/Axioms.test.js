'use strict';

/**
 * Tests for the deterministic answer-verification axioms.
 *
 * The axioms run over a finished answer and its tool sources and report DOMAIN
 * INVARIANT violations — an answer that contradicts a fact the data states or
 * breaks a rule of the domain. They never call a model. These tests pin the three
 * built-in axioms and the conservatism that keeps them free of false positives:
 *
 *   • count_consistency — flags an over-count or a wrong total-claim against the
 *     canonical open_deals_total, but leaves legitimate subset phrasings alone.
 *   • no_placeholder    — flags template slots / filler runs in a DATA answer only,
 *     and reports the tokens to redact.
 *   • no_currency_sum   — flags a single money total only when the data itself
 *     signals multiple quote currencies.
 */

const assert = require('assert');
const axioms = require('../../ai/Axioms.js');

let passed = 0;

function test(name, fn) {
	try { fn(); passed++; console.log('  ok   - ' + name); }
	catch (e) { process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); }
}

function names(vs) { return vs.map(v => v.axiom).sort(); }

// ── registry ─────────────────────────────────────────────────────────────────

test('the four built-in axioms are registered', () => {
	const l = axioms.list();
	assert.ok(l.indexOf('count_consistency') !== -1);
	assert.ok(l.indexOf('no_placeholder') !== -1);
	assert.ok(l.indexOf('no_currency_sum') !== -1);
	assert.ok(l.indexOf('impossible_percentage') !== -1);
});

test('register is idempotent by name', () => {
	axioms.register('__probe__', () => null);
	const after1 = axioms.list().length;
	axioms.register('__probe__', () => null);   // same name → replaces, no growth
	assert.strictEqual(axioms.list().length, after1);
});

test('evaluate never throws and returns [] for empty input', () => {
	assert.deepStrictEqual(axioms.evaluate({}), []);
	assert.deepStrictEqual(axioms.evaluate(), []);
});

// ── count_consistency ──────────────────────────────────────────────────────────

const SRC16 = '{"open_deals_total":16,"deals":[]}';

test('over-count: "53 open deals" against a true 16 is flagged', () => {
	const v = axioms.evaluate({ answer: 'You currently have 53 open deals.', sourcesText: SRC16 });
	assert.deepStrictEqual(names(v), ['count_consistency']);
});

test('total-claim mismatch: "you have 15 open deals" against 16 is flagged', () => {
	const v = axioms.evaluate({ answer: 'You have 15 open deals right now.', sourcesText: SRC16 });
	assert.deepStrictEqual(names(v), ['count_consistency']);
});

test('total-claim mismatch carries an in-place CORRECTION to the true total', () => {
	const v = axioms.evaluate({ answer: 'You have 1 open deal.', sourcesText: SRC16 });
	assert.strictEqual(v.length, 1);
	assert.strictEqual(v[0].severity, 'correct');
	assert.ok(v[0].correct, 'a correction is present');
	assert.strictEqual(v[0].correct.find, 'You have 1 open deal');
	// digits swapped AND the noun pluralized (1 → 16)
	assert.strictEqual(v[0].correct.replace, 'You have 16 open deals');
});

test('false-premise total with an intervening qualifier is CORRECTED, not just caveated (round 14)', () => {
	// A stronger model echoing the user's false premise ("I have exactly 100 open deals, right?") — the
	// "exactly" must not stop the in-place correction, and the correction must win over the over-count caveat.
	const v = axioms.evaluate({ answer: 'Based on the data returned, you have exactly 100 open deals.', sourcesText: SRC16 });
	const cc = v.find(x => x.axiom === 'count_consistency');
	assert.ok(cc && cc.severity === 'correct', 'should correct, not caveat');
	assert.strictEqual(cc.correct.replace, 'you have exactly 16 open deals');
});

test('correction singularizes when the true total is 1 (an under-count of 0)', () => {
	// truth 1 is only reachable by Rule B via an UNDER-count (0); any n>1 is an over-count (Rule A).
	const v = axioms.evaluate({ answer: 'You have 0 open deals.', sourcesText: '{"open_deals_total":1}' });
	assert.strictEqual(v[0].severity, 'correct');
	assert.strictEqual(v[0].correct.replace, 'You have 1 open deal');
});

test('over-count (Rule A) is caveated, NOT auto-corrected (intended figure unknown)', () => {
	const v = axioms.evaluate({ answer: '53 open deals are underwater.', sourcesText: SRC16 });
	assert.deepStrictEqual(names(v), ['count_consistency']);
	assert.strictEqual(v[0].severity, 'caveat');
	assert.strictEqual(v[0].correct, null);
});

test('correct total: "you have 16 open deals" is clean', () => {
	const v = axioms.evaluate({ answer: 'You have 16 open deals.', sourcesText: SRC16 });
	assert.deepStrictEqual(v, []);
});

test('subset phrasing "3 of your 16 open deals are in profit" is clean', () => {
	// "16 open deals" matches the true total; the subset count 3 is not adjacent to
	// "open deals", so it is never read as a total.
	const v = axioms.evaluate({ answer: '3 of your 16 open deals are in profit.', sourcesText: SRC16 });
	assert.deepStrictEqual(v, []);
});

test('legitimate subset count below the total is clean', () => {
	// "2 open deals are underwater" — a subset, not a total, and 2 < 16, so not impossible.
	const v = axioms.evaluate({ answer: '2 open deals are underwater at the moment.', sourcesText: SRC16 });
	assert.deepStrictEqual(v, []);
});

test('no authoritative total in sources → not judged', () => {
	const v = axioms.evaluate({ answer: 'You have 99 open deals.', sourcesText: '{"deals":[]}' });
	assert.deepStrictEqual(v, []);
});

test('conflicting totals in sources → not judged (ambiguous)', () => {
	const src = '{"open_deals_total":16} {"open_deals_total":8}';
	const v = axioms.evaluate({ answer: 'You have 40 open deals.', sourcesText: src });
	assert.deepStrictEqual(v, []);
});

// ── count_consistency: completed/closed deals (the generalized table) ───────────

const SRC_DONE = '{"completed_deals":50,"win_rate_percent":62.5}';

test('over-count of closed deals is flagged', () => {
	const v = axioms.evaluate({ answer: 'You have closed 80 completed deals.', sourcesText: SRC_DONE });
	assert.deepStrictEqual(names(v), ['count_consistency']);
});

test('total-claim mismatch on closed deals is flagged', () => {
	const v = axioms.evaluate({ answer: 'In total you have 45 closed deals.', sourcesText: SRC_DONE });
	assert.deepStrictEqual(names(v), ['count_consistency']);
});

test('correct closed-deal total is clean', () => {
	const v = axioms.evaluate({ answer: 'You have 50 completed deals.', sourcesText: SRC_DONE });
	assert.deepStrictEqual(v, []);
});

test('qualified subset "3 winning closed deals" is not read as a total', () => {
	const v = axioms.evaluate({ answer: '3 winning closed deals used no safety orders.', sourcesText: SRC_DONE });
	assert.deepStrictEqual(v, []);
});

// ── impossible_percentage ───────────────────────────────────────────────────────

test('win rate over 100% is flagged (rate-first)', () => {
	const v = axioms.evaluate({ answer: 'Your win rate is 150%.', sourcesText: SRC_DONE });
	assert.deepStrictEqual(names(v), ['impossible_percentage']);
});

test('win rate over 100% is flagged (percent-first)', () => {
	const v = axioms.evaluate({ answer: 'That is a 120% win rate.', sourcesText: SRC_DONE });
	assert.deepStrictEqual(names(v), ['impossible_percentage']);
});

test('a valid win rate is clean', () => {
	const v = axioms.evaluate({ answer: 'Your win rate is 62.5%.', sourcesText: SRC_DONE });
	assert.deepStrictEqual(v, []);
});

test('an ordinary percentage (a return) is not treated as a win rate', () => {
	const v = axioms.evaluate({ answer: 'That deal returned 150% profit.', sourcesText: SRC_DONE });
	assert.deepStrictEqual(v, []);
});

// ── no_placeholder ───────────────────────────────────────────────────────────

test('angle-bracket slot in a data answer is flagged and redacted', () => {
	const v = axioms.evaluate({ answer: 'Your deal id is <deal_id>.', sourcesText: SRC16 });
	assert.deepStrictEqual(names(v), ['no_placeholder']);
	assert.ok(v[0].redact.indexOf('<deal_id>') !== -1);
});

test('filler run XXXXXX in a data answer is flagged', () => {
	const v = axioms.evaluate({ answer: 'The order id is XXXXXX.', sourcesText: SRC16 });
	assert.deepStrictEqual(names(v), ['no_placeholder']);
});

test('placeholder with NO tool data (concept reply) is left alone', () => {
	const v = axioms.evaluate({ answer: 'A deal id looks like <deal_id>.', sourcesText: '' });
	assert.deepStrictEqual(v, []);
});

test('templated id (PAIR_QUOTE-…) IS flagged even with NO tool data — the free-form fabrication case (round 14)', () => {
	// A free-form "tell me more" that invents a deal list from the prompt's format example, with no tool data
	// this turn — the exact production fabrication. The unambiguous templated-id / filler tells must fire on
	// EVERY path, unlike the bracket-slot check which stays gated to spare concept illustrations.
	const v = axioms.evaluate({ answer: '1. PAIR_QUOTE-ABCDE-NNNN: Stale, P/L -0.1', sourcesText: '' });
	assert.deepStrictEqual(names(v), ['no_placeholder']);
	assert.ok(v[0].redact.indexOf('PAIR_QUOTE') !== -1, 'PAIR_QUOTE flagged for redaction');
});

test('the pipeline\'s own [unverified id] / [unavailable] are not treated as placeholders', () => {
	const v = axioms.evaluate({ answer: 'Deal [unverified id] and [unavailable].', sourcesText: SRC16 });
	assert.deepStrictEqual(v, []);
});

// ── no_currency_sum ────────────────────────────────────────────────────────────

const SRC_MULTI = '{"note":"Completed deals span multiple quote currencies (USD, EUR)","profit_by_currency":{"USD":10,"EUR":5}}';

test('single money total against multi-currency data is flagged', () => {
	const v = axioms.evaluate({ answer: 'Your total profit is $1,234.', sourcesText: SRC_MULTI });
	assert.deepStrictEqual(names(v), ['no_currency_sum']);
});

test('per-currency answer against multi-currency data is clean', () => {
	const v = axioms.evaluate({ answer: 'You made $10 in USD and €5 in EUR.', sourcesText: SRC_MULTI });
	assert.deepStrictEqual(v, []);
});

test('single money total against single-currency data is clean', () => {
	const v = axioms.evaluate({ answer: 'Your total profit is $1,234.', sourcesText: '{"total_profit":1234}' });
	assert.deepStrictEqual(v, []);
});

// ── ranking_consistency ──────────────────────────────────────────────────────

const GAIN = 'ME_USD-1MBI6KO-1768609422';
const LOSS = 'BAL_USD-25HCLHL-1768609422';
const SRC_RANK = '{"biggest_gain":{"dealId":"' + GAIN + '","pair":"ME/USD"},"biggest_loss":{"dealId":"' + LOSS + '","pair":"BAL/USD"}}';

test('same deal named as both best and worst (across sentences) is flagged', () => {
	const v = axioms.evaluate({ answer: 'Your best deal is ' + GAIN + '. The worst is also ' + GAIN + '.', sourcesText: SRC_RANK });
	assert.deepStrictEqual(names(v), ['ranking_consistency']);
});

test('labeling the biggest gainer as the worst deal is flagged (against the tool ranking)', () => {
	const v = axioms.evaluate({ answer: 'The deal doing the worst right now is ' + GAIN + '.', sourcesText: SRC_RANK });
	assert.deepStrictEqual(names(v), ['ranking_consistency']);
	const p = axioms.evaluate({ answer: 'Your worst performing deal is ME/USD.', sourcesText: SRC_RANK });
	assert.deepStrictEqual(names(p), ['ranking_consistency']);
});

test('a correct best/worst answer is clean — one sentence and two sentences', () => {
	assert.deepStrictEqual(axioms.evaluate({ answer: 'The best is ' + GAIN + ', the worst is ' + LOSS + '.', sourcesText: SRC_RANK }), []);
	assert.deepStrictEqual(axioms.evaluate({ answer: 'Your best deal is ' + GAIN + '. Your worst deal is ' + LOSS + '.', sourcesText: SRC_RANK }), []);
	assert.deepStrictEqual(axioms.evaluate({ answer: 'ME/USD is your best and BAL/USD is your worst.', sourcesText: SRC_RANK }), []);
});

test('naming only the best deal (no worst claim) is clean', () => {
	assert.deepStrictEqual(axioms.evaluate({ answer: 'Your best deal is ' + GAIN + '.', sourcesText: SRC_RANK }), []);
});

test('ranking is not judged when the sources lack biggest_gain/biggest_loss', () => {
	assert.deepStrictEqual(axioms.evaluate({ answer: 'The worst deal is ' + LOSS + '.', sourcesText: '{"deals":[]}' }), []);
});

// ── arithmetic_consistency ───────────────────────────────────────────────────

test('a wrong power result stated as an equation is corrected in place', () => {
	const v = axioms.evaluate({ answer: '1.5 to the power of 4 = 3.375.', sourcesText: '' });
	assert.strictEqual(v.length, 1);
	assert.strictEqual(v[0].axiom, 'arithmetic_consistency');
	assert.strictEqual(v[0].severity, 'correct');
	assert.strictEqual(v[0].correct.replace, '1.5 to the power of 4 = 5.0625');
});

test('a wrong product is corrected; a correct one and a valid rounding are left alone', () => {
	assert.strictEqual(axioms.evaluate({ answer: '2 times 8 = 18.', sourcesText: '' })[0].correct.replace, '2 times 8 = 16');
	assert.deepStrictEqual(axioms.evaluate({ answer: '2 times 8 = 16.', sourcesText: '' }), []);
	assert.deepStrictEqual(axioms.evaluate({ answer: '1.05^4 is 1.2155.', sourcesText: '' }), []); // valid rounding of 1.21550625
});

test('arithmetic axiom ignores prose that is not an explicit A op B = C claim', () => {
	assert.deepStrictEqual(axioms.evaluate({ answer: 'The safety orders grow with the size scale.', sourcesText: '' }), []);
});

// ── profit_state_count ─────────────────────────────────────────────────────
const SRC_PROFIT = '{"open_deals_in_profit":3,"open_deals_underwater":5}';

test('profit_state_count caveats an over-claim of in-profit deals', () => {
	const v = axioms.evaluate({ answer: 'Right now 8 of your deals are in profit.', sourcesText: SRC_PROFIT });
	assert.ok(names(v).indexOf('profit_state_count') !== -1, 'should flag 8 > 3 in profit');
	assert.strictEqual(v.find(x => x.axiom === 'profit_state_count').severity, 'caveat');
});

test('profit_state_count caveats an over-claim of underwater deals', () => {
	const v = axioms.evaluate({ answer: '9 positions are underwater at the moment.', sourcesText: SRC_PROFIT });
	assert.ok(names(v).indexOf('profit_state_count') !== -1, 'should flag 9 > 5 underwater');
});

test('profit_state_count leaves an accurate profit/underwater claim alone', () => {
	assert.deepStrictEqual(axioms.evaluate({ answer: '3 of your deals are in profit and 5 are underwater.', sourcesText: SRC_PROFIT }), []);
});

console.log('\n' + passed + ' checks passed');