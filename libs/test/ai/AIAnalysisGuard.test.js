'use strict';

/**
 * Tests for the advisory deal-analysis grounding guard.
 *
 * The guard never alters a reply — it only reports whether a standard analysis
 * ended with the required Hold / Add Funds recommendation and whether the
 * figures it cites actually appear in the data the model was given. These tests
 * pin that behavior: the recommendation is read from the emphasized token (the
 * LAST one when several appear), rounding a source number is tolerated, and an
 * invented figure is surfaced.
 */

const assert = require('assert');
const {
	checkAnalysis,
	detectRecommendation,
	extractSignificantNumbers,
	checkNumbers,
	correctArithmetic
} = require('../../ai/AIAnalysisGuard.js');

let passed = 0;

function test(name, fn) {

	try {

		fn();
		passed++;
		console.log('  ok   - ' + name);
	}
	catch (e) {

		process.exitCode = 1;
		console.log('  FAIL - ' + name + '\n         ' + e.message);
	}
}


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nRecommendation detection:');

test('emphasized **Hold** is detected', () => {
	const r = detectRecommendation('The position is healthy. Recommendation: **Hold**.');
	assert.strictEqual(r.hasRecommendation, true);
	assert.strictEqual(r.recommendation, 'hold');
});

test('emphasized **Add Funds** is detected (case / spacing tolerant)', () => {
	const r = detectRecommendation('End: **add   funds**');
	assert.strictEqual(r.hasRecommendation, true);
	assert.strictEqual(r.recommendation, 'add_funds');
});

test('when both appear, the LAST emphasized token is the call', () => {
	// Scenario 1 (Hold) and Scenario 2 discussed, ending on Add Funds.
	const r = detectRecommendation('Scenario 1 is **Hold**. On balance the better path is **Add Funds**.');
	assert.strictEqual(r.recommendation, 'add_funds');
});

test('plain "hold" without emphasis or a label is NOT treated as the recommendation', () => {
	// Unemphasized prose that isn't introduced by the recommendation label must not count.
	const r = detectRecommendation('You could hold or add funds depending on the market.');
	assert.strictEqual(r.hasRecommendation, false);
	assert.strictEqual(r.recommendation, null);
});

test('label-emphasized form "**Recommendation:** Hold" is detected (observed live)', () => {
	// llama3.1:8b emitted this exact shape — "Recommendation:" bold, the word plain.
	const r = detectRecommendation('### Notable Risks\n...\n\n**Recommendation:** Hold');
	assert.strictEqual(r.hasRecommendation, true);
	assert.strictEqual(r.recommendation, 'hold');
});

test('label with the word emphasized "Recommendation: **Add Funds**" is detected', () => {
	const r = detectRecommendation('Recommendation: **Add Funds**');
	assert.strictEqual(r.recommendation, 'add_funds');
});

test('scenario labels in the body do not count as the recommendation', () => {
	// "Scenario 1 (Hold)" / "Scenario 2 (Add Funds)" appear in every analysis body
	// but are neither emphasized nor label-introduced, so only the final call counts.
	const r = detectRecommendation('Scenario 1 (Hold) vs Scenario 2 (Add Funds). **Recommendation:** Add Funds');
	assert.strictEqual(r.recommendation, 'add_funds');
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSignificant-number extraction:');

test('decimals and long integers are captured; small counts ignored', () => {
	const nums = extractSignificantNumbers('Used 3 of 5 safety orders at $75.53272, target 76.1234, invested 1250');
	assert.ok(nums.includes('75.53272'), 'price decimal captured');
	assert.ok(nums.includes('76.1234'), 'target decimal captured');
	assert.ok(nums.includes('1250'), '4-digit integer captured');
	assert.ok(!nums.includes('3') && !nums.includes('5'), 'small SO counts ignored');
});

test('grouping commas are normalized away', () => {
	const nums = extractSignificantNumbers('Position value $1,234.56');
	assert.ok(nums.includes('1234.56'));
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nNumber grounding against the source data:');

test('figures present in the source are grounded', () => {
	const source = 'Average 75.53272 | Target 76.1234 | Invested 1250';
	const r = checkNumbers('Averaging 75.53272 toward 76.1234 on 1250 invested', source);
	assert.strictEqual(r.ungrounded.length, 0);
});

test('rounding a source figure is tolerated (substring match)', () => {
	const source = 'Average price 75.53272';
	const r = checkNumbers('It sits around 75.5 now', source);
	assert.strictEqual(r.ungrounded.length, 0);
});

test('an invented figure is surfaced as ungrounded', () => {
	const source = 'Average 75.53272 | Target 76.1234';
	const r = checkNumbers('The model claims a target of 80.9999', source);
	assert.deepStrictEqual(r.ungrounded, ['80.9999']);
});

test('comma-formatted output matches comma-stripped source', () => {
	const source = 'Invested 1234.56';
	const r = checkNumbers('You invested $1,234.56', source);
	assert.strictEqual(r.ungrounded.length, 0);
});

// Boundary hardening: a fabricated figure that merely coincides with the TAIL of a real number in the
// source must be surfaced, not silently grounded by a raw substring test.
test('a fabricated figure hiding inside a longer real number is surfaced (decimal tail)', () => {
	const source = 'Total 1234.56';   // "234.56" is a substring of 1234.56 but not a real figure
	const r = checkNumbers('Your total is 234.56', source);
	assert.deepStrictEqual(r.ungrounded, ['234.56']);
});

test('a fabricated integer hiding inside a longer real integer is surfaced', () => {
	const source = 'Count 66201';   // "6620" is a substring of 66201 but not a real figure
	const r = checkNumbers('There are 6620 of them', source);
	assert.deepStrictEqual(r.ungrounded, ['6620']);
});

test('rounding tolerance still holds after boundary hardening (75.5 ↔ 75.53272)', () => {
	const source = 'Average price 75.53272';
	const r = checkNumbers('It sits around 75.5 now', source);
	assert.strictEqual(r.ungrounded.length, 0);
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nEnd-to-end checkAnalysis:');

test('clean, grounded, recommended reply → ok', () => {
	const source = 'Average 75.53272 | Target 76.1234';
	const out = 'Healthy near 75.53272 with target 76.1234. Recommendation: **Hold**.';
	const r = checkAnalysis(out, source);
	assert.strictEqual(r.hasRecommendation, true);
	assert.strictEqual(r.recommendation, 'hold');
	assert.strictEqual(r.ungroundedNumbers.length, 0);
	assert.strictEqual(r.ok, true);
});

test('missing recommendation and an invented number → not ok, both flagged', () => {
	const source = 'Average 75.53272 | Target 76.1234';
	const out = 'The price could reach 99.8877 soon.';
	const r = checkAnalysis(out, source);
	assert.strictEqual(r.hasRecommendation, false);
	assert.deepStrictEqual(r.ungroundedNumbers, ['99.8877']);
	assert.strictEqual(r.ok, false);
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nArithmetic self-correction (free-form path):');

test('a gross multiplication error is corrected in place', () => {
	const r = correctArithmetic('So 12 * 4 = 50 deals in total.');
	assert.strictEqual(r.text, 'So 12 * 4 = 48 deals in total.');
	assert.strictEqual(r.corrections.length, 1);
});

test('correct arithmetic is left untouched (no correction)', () => {
	const r = correctArithmetic('That works out to 15% of 2400 is 360.');
	assert.strictEqual(r.text, 'That works out to 15% of 2400 is 360.');
	assert.strictEqual(r.corrections.length, 0);
});

test('legitimate rounding at the stated precision is NOT rewritten', () => {
	// 1/3 = 0.3333…, and 0.33 is the true value rounded to the model's own 2 places — leave it.
	const r = correctArithmetic('Roughly, 1 / 3 = 0.33 of the total.');
	assert.strictEqual(r.text, 'Roughly, 1 / 3 = 0.33 of the total.');
});

test('a power error is corrected at the model\'s stated precision (1.5^4 is 5.0625 → 5.063 at 3dp)', () => {
	// The true value is 5.0625; the model wrote 3.375 with three decimals, so the fix keeps three decimals.
	const r = correctArithmetic('Compounded, 1.5^4 = 3.375 over the period.');
	assert.strictEqual(r.text, 'Compounded, 1.5^4 = 5.063 over the period.');
});

test('a percentage error is corrected and grouping is preserved', () => {
	const r = correctArithmetic('That is 25% of 8,000 = 1,500 dollars.');
	assert.strictEqual(r.text, 'That is 25% of 8,000 = 2,000 dollars.');
});

test('a decimal figure that merely contains digits is never mistaken for arithmetic', () => {
	// The classic corruption to avoid: "-16869.43" must survive verbatim (no "= result" to act on).
	const r = correctArithmetic('Total unrealized P/L: -16869.43 across 16 open deals.');
	assert.strictEqual(r.text, 'Total unrealized P/L: -16869.43 across 16 open deals.');
	assert.strictEqual(r.corrections.length, 0);
});

test('division by zero is skipped, not corrected', () => {
	const r = correctArithmetic('If you divide, 50 / 0 = 0 by that logic.');
	assert.strictEqual(r.text, 'If you divide, 50 / 0 = 0 by that logic.');
});

test('a CORRECT multi-operand chain is never corrupted by matching a sub-expression', () => {
	// Regression: the binary matcher used to grab the trailing "3 + 4 = 9" out of "2 + 3 + 4 = 9" and
	// "fix" it to 7 — corrupting a correct answer. The chain guard now leaves multi-operand chains alone.
	assert.strictEqual(correctArithmetic('2 + 3 + 4 = 9').text, '2 + 3 + 4 = 9');
	assert.strictEqual(correctArithmetic('10 - 2 - 3 = 5').text, '10 - 2 - 3 = 5');
});

test('a WRONG multi-operand chain is left untouched (two-operand only — never a corruption)', () => {
	// The guard handles binary expressions only; it must decline a chain rather than mis-correct it.
	assert.strictEqual(correctArithmetic('2 + 3 + 4 = 10').text, '2 + 3 + 4 = 10');
});

test('a ratio stated as a percentage is NOT destroyed ("6/10 is 60%")', () => {
	// Regression: the division branch read "6/10 is 60" and rewrote 60→1, corrupting a correct win rate.
	assert.strictEqual(correctArithmetic('win rate 6/10 is 60%').text, 'win rate 6/10 is 60%');
	assert.strictEqual(correctArithmetic('your success 27/30 is 90 percent').text, 'your success 27/30 is 90 percent');
});

test('a number embedded in a deal-id epoch is never read as arithmetic', () => {
	// Regression: "…-37G2657-1786620653 is 5" was read as "2657 - 1786620653 is 5" and 5 was rewritten.
	assert.strictEqual(correctArithmetic('deal KTA_USD-37G2657-1786620653 is 5 days old').text,
		'deal KTA_USD-37G2657-1786620653 is 5 days old');
});

test('a leading word before the operands does not block a real correction ("So 12 * 4 = 50")', () => {
	// The identifier guard keys on a letter DIRECTLY adjacent to the digit, so a normal word + space is fine.
	assert.strictEqual(correctArithmetic('So 12 * 4 = 50 deals in total.').text, 'So 12 * 4 = 48 deals in total.');
});


console.log('\n' + passed + ' checks passed');