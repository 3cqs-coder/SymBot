'use strict';


// Advisory, read-only checks on a generated deal-analysis reply.
//
// This changes nothing the user sees. The caller runs it after a standard deal
// analysis and logs what it finds, so that over time any drift — a reply that
// forgets the required recommendation, or one that cites a figure the model was
// never given — is visible in the logs rather than passing silently.
//
// It is deliberately conservative: it only judges the two things the analysis
// prompt is explicit about, and it never blocks or edits the reply.


// The analysis prompt asks the model to end with a single clear recommendation,
// emphasized as **Hold** or **Add Funds**. Models are not consistent about where
// they put the emphasis, so two shapes are accepted, taking whichever appears
// last as the actual call:
//   - the emphasized token itself:            "**Hold**", "**Add Funds**"
//   - a "Recommendation" label followed by the word, however it is emphasized:
//     "**Recommendation:** Hold", "Recommendation: **Add Funds**", "Recommendation - hold"
// Plain prose that merely mentions holding or adding funds is NOT matched: it
// must be either emphasized or introduced by the recommendation label.
function detectRecommendation(text) {

	const t = String(text || '');

	const re = /(?:\*\*\s*(hold|add\s+funds)\s*\*\*)|(?:recommendation\b[\s:*\-–—]*\**\s*(hold|add\s+funds))/gi;

	let m;
	let last = null;

	while ((m = re.exec(t)) !== null) {

		const word = (m[1] || m[2] || '').toLowerCase().replace(/\s+/g, ' ').trim();

		if (word) { last = word; }
	}

	const recommendation = last === 'hold' ? 'hold' : (last ? 'add_funds' : null);

	return { hasRecommendation: recommendation !== null, recommendation };
}


// Pull the "significant" figures out of a reply: decimals (prices, percentages,
// dollar amounts) and long integers. Small bare integers such as safety-order
// counts are intentionally ignored — they are not the numbers a model would
// hallucinate and would only add noise. Grouping commas are stripped so
// "1,234.56" and "1234.56" compare equal.
function extractSignificantNumbers(text) {

	const found = new Set();

	const re = /\d[\d,]*\.\d+|\d{4,}/g;

	let m;

	while ((m = re.exec(String(text || ''))) !== null) {

		found.add(m[0].replace(/,/g, ''));
	}

	return ([ ...found ]);
}


// The grounding source (a JSON dump of tool results) is dense with machine digit-runs that no
// figure a model would cite ever collides with legitimately: deal ids carry a trailing epoch
// (KTA_USD-37G2657-1786620653), records carry epoch/ms timestamps (1786620653000) and ISO dates.
// A short fabricated figure ("6620") can hide as a substring inside one of those runs and be scored
// as grounded. Blank them out before the match so the substring test still gives rounding tolerance
// for real figures (prices, percentages, amounts — none of which are 9+ digit integers) without the
// id/epoch pool masking an invention. Conservative by construction: it only removes id/timestamp
// shapes and pure digit-runs of nine or more, never a plausible financial figure.
function stripGroundingNoise(src) {

	return String(src || '')
		.replace(/\b[A-Za-z0-9]{2,10}[_/][A-Za-z0-9]{2,10}-[A-Za-z0-9]+-\d+\b/g, ' ')  // deal ids (incl. their epoch)
		.replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, ' ')                                // ISO timestamps
		.replace(/\d{9,}/g, ' ');                                                       // bare epoch / ms-epoch runs
}


// Which significant figures in the reply do NOT appear anywhere in the data the
// model was given? A substring match against the comma-stripped, id/epoch-scrubbed
// source gives natural tolerance for rounding (a reply that shortens 75.53272 to
// 75.5 still matches), while an invented price or amount is surfaced.
function checkNumbers(output, source) {

	const src = stripGroundingNoise(String(source || '').replace(/,/g, ''));

	const numbers = extractSignificantNumbers(output);

	const ungrounded = numbers.filter(n => src.indexOf(n) === -1);

	return { numbersChecked: numbers.length, ungrounded };
}


// Deterministic arithmetic self-check for FREE-FORM answers. When a reply states a self-contained
// calculation out loud ("15% of 2400 is 360", "12 * 4 = 50", "1.5^4 = 3.375"), recompute it from the
// stated operands and correct ONLY the result — and ONLY when it is wrong at the model's OWN stated
// precision. Legitimate rounding is left alone by construction: the true value is compared after rounding
// it to the same number of decimal places the model used, so "1 / 3 = 0.33" matches 0.33 and is untouched,
// while "12 * 4 = 50" is corrected to 48. It is improve-only (operands are never changed, non-arithmetic
// prose is never touched) and never calls the model. This guards the one place a number can still be
// model-generated — the conceptual / free-form path — since every account-data answer is rendered
// deterministically from real figures. Returns { text, corrections } (corrections listed for logging).
function correctArithmetic(text) {

	let out = String(text || '');
	if (!out) { return { text: out, corrections: [] }; }

	const corrections = [];
	const N = /\d[\d,]*(?:\.\d+)?/.source;

	const num = (s) => parseFloat(String(s).replace(/,/g, ''));
	const decimalsOf = (s) => { const m = String(s).replace(/,/g, '').match(/\.(\d+)$/); return m ? m[1].length : 0; };
	// Is the true value different from what the model stated, judged at the model's own precision?
	const wrongAt = (trueVal, statedStr) => {
		if (!isFinite(trueVal)) { return false; }
		const d = decimalsOf(statedStr);
		return trueVal.toFixed(d) !== num(statedStr).toFixed(d);
	};
	// Render the true value at the precision (and grouping) the model expressed for its result.
	const fmt = (trueVal, likeStr) => {
		let r = trueVal.toFixed(decimalsOf(likeStr));
		if (/,/.test(String(likeStr))) { const p = r.split('.'); r = Number(p[0]).toLocaleString('en-US') + (p[1] ? '.' + p[1] : ''); }
		return r;
	};
	// Replace the stated result (the last token of the matched span) with the corrected value.
	const swap = (full, statedStr, fixed, expr) => {
		corrections.push({ expr, stated: statedStr, fixed });
		return full.slice(0, full.lastIndexOf(statedStr)) + fixed;
	};
	// Decide whether a matched "A op B = C" should be LEFT ALONE — the guard only touches a clean, standalone,
	// two-operand expression, and skipping is always safe (worst case: a wrong number the guard declines to
	// fix). Skip when:
	//   • an operator/"=" sits right before A → this is a sub-expression of a chain ("2 + 3 + 4 = 9", whose
	//     trailing "3 + 4 = 9" would otherwise be "corrected" to 7, corrupting a correct answer);
	//   • a LETTER sits right before A → A is embedded in an identifier (a deal-id epoch like
	//     "…-37G2657-1786620653 is 5", where "2657 - 1786620653 is 5" is not real arithmetic);
	//   • an operator/"=" + digit follows C → C is itself an operand in a longer expression;
	//   • "%" or "percent" follows C → the expression is a percentage/ratio, not a raw quotient
	//     ("win rate 6/10 is 60%": 6/10 is 60 PERCENT, not 0.6 — correcting 60→1 would destroy a correct
	//     answer), so the raw computation does not apply.
	const skipContext = (string, offset, matchLen) => {
		const raw = String(string).slice(0, offset);
		// A letter DIRECTLY before the first operand — no space — means it is embedded in an identifier (a
		// deal-id epoch like "…37G2657-1786620653"), not arithmetic. Tested on the RAW prefix so an ordinary
		// word followed by a space ("So 12 * 4", "That is 25% of") is NOT mistaken for an identifier.
		if (/[A-Za-z]$/.test(raw)) { return true; }
		const before = raw.replace(/\s+$/, '');
		if (/[-+*×x/=]$/.test(before)) { return true; }   // A is a continuation of a chain ("2 + 3 + 4 = 9")
		const after = String(string).slice(offset + matchLen).replace(/^\s+/, '');
		return /^[-+*×x/=]\s*\d/.test(after) || /^%|^percent\b/i.test(after);
	};

	// A op B = C   (op ∈ + − * × x /)
	out = out.replace(new RegExp('(' + N + ')\\s*([+\\-*×x/])\\s*(' + N + ')\\s*(?:=|is)\\s*(' + N + ')', 'gi'),
		(full, a, op, b, c, offset, string) => {
			if (skipContext(string, offset, full.length)) { return full; }
			const A = num(a), B = num(b); let t;
			switch (op) {
				case '+': t = A + B; break;
				case '-': t = A - B; break;
				case '/': if (B === 0) { return full; } t = A / B; break;
				default:  t = A * B;   // * × x
			}
			return wrongAt(t, c) ? swap(full, c, fmt(t, c), a + ' ' + op + ' ' + b) : full;
		});

	// A% of B = C
	out = out.replace(new RegExp('(' + N + ')\\s*%\\s*of\\s*(' + N + ')\\s*(?:=|is)\\s*(' + N + ')', 'gi'),
		(full, p, b, c, offset, string) => {
			if (skipContext(string, offset, full.length)) { return full; }
			const t = num(p) / 100 * num(b);
			return wrongAt(t, c) ? swap(full, c, fmt(t, c), p + '% of ' + b) : full;
		});

	// A^B = C  /  A**B = C  /  A to the power of B = C
	out = out.replace(new RegExp('(' + N + ')\\s*(?:\\^|\\*\\*|to the power of)\\s*(' + N + ')\\s*(?:=|is)\\s*(' + N + ')', 'gi'),
		(full, a, b, c, offset, string) => {
			if (skipContext(string, offset, full.length)) { return full; }
			const t = Math.pow(num(a), num(b));
			return wrongAt(t, c) ? swap(full, c, fmt(t, c), a + '^' + b) : full;
		});

	return { text: out, corrections };
}


// Run all advisory checks on an analysis reply against its source data block.
function checkAnalysis(output, source) {

	const rec = detectRecommendation(output);
	const num = checkNumbers(output, source);

	return {
		hasRecommendation: rec.hasRecommendation,
		recommendation:    rec.recommendation,
		numbersChecked:    num.numbersChecked,
		ungroundedNumbers: num.ungrounded,
		ok:                rec.hasRecommendation && num.ungrounded.length === 0
	};
}


module.exports = {
	checkAnalysis,
	detectRecommendation,
	extractSignificantNumbers,
	checkNumbers,
	correctArithmetic
};