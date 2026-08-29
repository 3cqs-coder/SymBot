'use strict';


// Lightweight, opt-in faithfulness check for tool-grounded chat answers.
//
// After the assistant composes an answer from tool results, this grades each claim
// in that answer against the raw tool results — the only source of truth about the
// user's account. It grades each claim the way a source-grounded answer is checked
// against its cited sources; here the sources are the tool-call JSON.
//
// It is deliberately POST-HOC and FAIL-SAFE: it never blocks, rewrites, or delays
// the answer beyond one bounded judge call, and returns null on any error, timeout,
// or unparseable verdict so the chat is never held up. The caller decides what to do
// with the score; the intended use is to surface a single subtle caveat only when the
// answer is poorly grounded, and nothing at all otherwise.


// The judge's system prompt lives in a data file (read via the shared loader) rather than inline, so a
// stray character in the wording can never turn this source file into a syntax error.
const { readText, parseModelJson } = require('./AIGuardrails');
const JUDGE_SYSTEM = readText('faithfulness-judge.txt');

const MAX_CLAIMS = 16;
const MAX_SOURCES_CHARS = 12000;
const VALID = { 'supported': 1, 'partial': 1, 'unsupported': 1 };


// Split an answer into checkable statements: sentences and bullet lines, stripped of
// markdown, short fragments dropped, de-duplicated, capped.
function segmentClaims(answer) {

	const text = String(answer || '');

	const parts = text
		.split(/\n+|(?<=[.!?])\s+/)
		.map(s => s.replace(/^[\s>*\-•\d.)#]+/, '').replace(/[*_`#]+/g, '').trim())
		.filter(s => s.length >= 15);

	const seen = new Set();
	const out = [];

	for (const s of parts) {

		const k = s.toLowerCase();

		if (!seen.has(k)) { seen.add(k); out.push(s); }

		if (out.length >= MAX_CLAIMS) { break; }
	}

	return (out);
}


function buildPrompt(sources, claims) {

	const numbered = claims.map((c, i) => (i + 1) + '. ' + c).join('\n');

	const usr = 'SOURCES:\n' + String(sources || '').slice(0, MAX_SOURCES_CHARS) + '\n\nSTATEMENTS:\n' + numbered;

	return [ { role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: usr } ];
}


// Tolerant JSON extraction (strip fences, slice first { to last }, repair trailing commas, parse).
// Delegates to the shared parser so the judge recovers the same malformed replies every other AI caller
// does — this local copy previously lacked the trailing-comma repair and dropped replies the others accept.
function extractJson(raw) {

	return parseModelJson(raw);
}


// Turn verdicts into an overall grade. A claim the judge omits defaults to 'partial'
// (not confidently supported). Thresholds mirror the source approach: low when more
// than a quarter are unsupported; medium when any is unsupported or over a third are
// partial; otherwise high.
function score(verdicts, total) {

	const byN = {};

	for (const v of (verdicts || [])) {

		if (v && VALID[v.verdict] && v.n) { byN[v.n] = v.verdict; }
	}

	let unsupported = 0;
	let partial = 0;
	let supported = 0;

	// Score ONLY the claims the judge actually returned a verdict for. A claim the judge omitted is
	// treated as NEUTRAL (excluded from the denominator), NOT as 'partial'. Small local judges routinely
	// return fewer verdicts than claims sent, and defaulting the gaps to 'partial' stamped a
	// "partly confirmed" caveat onto fully-grounded answers. The denominator is the number JUDGED.
	const judgedNs = Object.keys(byN);

	for (const k of judgedNs) {

		const vv = byN[k];

		if (vv === 'unsupported') { unsupported++; }
		else if (vv === 'partial') { partial++; }
		else { supported++; }
	}

	const judged = judgedNs.length;

	let overall = 'high';

	if (judged > 0 && unsupported / judged > 0.25) { overall = 'low'; }
	else if (unsupported > 0 || (judged > 0 && partial / judged > 0.34)) { overall = 'medium'; }

	return { overall, counts: { supported, partial, unsupported, total: judged } };
}


// judge: async (messages) => string. Returns { overall, counts } or null on any
// failure (so the caller degrades to showing nothing).
async function scoreAnswer({ answer, sources, judge }) {

	try {

		const claims = segmentClaims(answer);

		if (!claims.length || !sources || typeof judge !== 'function') { return null; }

		const raw = await judge(buildPrompt(sources, claims));

		const parsed = extractJson(raw);

		if (!parsed || !Array.isArray(parsed.verdicts)) { return null; }

		return score(parsed.verdicts, claims.length);
	}
	catch (e) {

		return null;
	}
}


module.exports = {

	scoreAnswer,
	segmentClaims,
	_score: score,
	_extractJson: extractJson,
	_buildPrompt: buildPrompt
};
