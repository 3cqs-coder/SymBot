'use strict';

// Tests the structured deep-analysis module (libs/ai/AIDeepAnalysis.js): the pure parse/bound helpers
// and the full plan → gather → gap-check → synthesize orchestration, driven by deterministic fakes so
// the control flow (adaptive stop, fail-open plan, fail-closed gap, dedup, bounded evidence, graceful
// fallback) is verified without a live model.

const assert = require('assert');
const D = require('../../ai/AIDeepAnalysis.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function eq(a, b, m) { assert.strictEqual(a, b, m); passed++; }

// ── parsePlan (fail-open) ──────────────────────────────────────────────────────
assert.deepStrictEqual(D.parsePlan('{"subquestions":["a","b"]}', 'Q'), [ 'a', 'b' ]); passed++;
assert.deepStrictEqual(D.parsePlan('```json\n{"subquestions":["a"]}\n```', 'Q'), [ 'a' ]); passed++;
assert.deepStrictEqual(D.parsePlan({ subquestions: [ 'x', 'x', 'y' ] }, 'Q'), [ 'x', 'y' ]); passed++; // dedup
assert.deepStrictEqual(D.parsePlan('not json', 'the original'), [ 'the original' ]); passed++;         // fail-open
assert.deepStrictEqual(D.parsePlan('{"subquestions":[]}', 'Q'), [ 'Q' ]); passed++;                     // empty → fallback

// ── parseGap (fail-closed) ─────────────────────────────────────────────────────
assert.deepStrictEqual(D.parseGap('{"done":true}'), []); passed++;
assert.deepStrictEqual(D.parseGap('{"done":false,"followups":["c"]}'), [ 'c' ]); passed++;
assert.deepStrictEqual(D.parseGap('garbage'), []); passed++;                                             // fail-closed
assert.deepStrictEqual(D.parseGap('{"followups":["c"]}'), []); passed++;                                 // no done:false → closed? done undefined ≠ true → treated as not-done
// (done is absent → not true → followups returned)
assert.deepStrictEqual(D.parseGap('{"done":false,"followups":["a","","  "]}'), [ 'a' ]); passed++;

// ── nextPending (dedup + cap) ──────────────────────────────────────────────────
assert.deepStrictEqual(D.nextPending([ 'A', 'b', 'A' ], new Set([ 'b' ]), 5), [ 'A' ]); passed++;       // drop seen (b), dedup handled by seen only
assert.deepStrictEqual(D.nextPending([ 'x', 'y', 'z' ], new Set(), 2), [ 'x', 'y' ]); passed++;         // cap

// ── boundEvidence ──────────────────────────────────────────────────────────────
const ev = D.boundEvidence([ { subq: 'Q1', answer: 'aaaa' }, { subq: 'Q2', answer: 'bbbb' } ], 10000, 300);
ok(/\[Q1\]/.test(ev) && /\[Q2\]/.test(ev), 'evidence includes each block headed by its sub-question');
const evCapped = D.boundEvidence([ { subq: 'Q1', answer: 'a'.repeat(5000) }, { subq: 'Q2', answer: 'b'.repeat(5000) } ], 2000, 300);
ok(evCapped.length <= 2100, 'evidence is bounded to roughly the char budget');

// ── Orchestrator: happy path (plan → gather → gap says done → synthesize) ──────
(async () => {

	let planned = 0, gapCalls = 0, synthCalls = 0;
	const investigated = [];

	let out = await D.runDeepAnalysis('why underperforming?', {
		plan:        async () => { planned++; return [ 'sub A', 'sub B' ]; },
		investigate: async (q) => { investigated.push(q); return 'finding for ' + q; },
		gap:         async () => { gapCalls++; return []; },                       // done immediately
		synthesize:  async (t, ev) => { synthCalls++; return 'REPORT over: ' + ev.slice(0, 20); }
	});
	eq(planned, 1, 'planned once');
	eq(investigated.length, 2, 'investigated both sub-questions');
	eq(gapCalls, 1, 'gap-checked once');
	eq(synthCalls, 1, 'synthesized once');
	ok(/^REPORT over:/.test(out), 'returns the synthesized report');

	// ── Follow-up round then stop ───────────────────────────────────────────────
	let round = 0;
	const seen2 = [];
	out = await D.runDeepAnalysis('Q', {
		plan:        async () => [ 'a', 'b' ],
		investigate: async (q) => { seen2.push(q); return 'ok ' + q; },
		gap:         async () => { round++; return round === 1 ? [ 'c' ] : []; },   // one follow-up, then done
		synthesize:  async () => 'FINAL'
	});
	ok(seen2.includes('c'), 'the follow-up sub-question was investigated in the next round');
	eq(out, 'FINAL', 'returns the final report');

	// ── Adaptive stop: a round that gathers nothing ends it, and empty coverage → null (fallback) ──
	out = await D.runDeepAnalysis('Q', {
		plan:        async () => [ 'a', 'b' ],
		investigate: async () => '',                     // every investigation empty
		gap:         async () => [ 'c' ],
		synthesize:  async () => 'SHOULD NOT REACH'
	});
	eq(out, null, 'no evidence gathered → returns null so the caller uses the single pass');

	// ── Fail-open plan: ≤1 sub-question → null (caller uses single pass) ─────────
	out = await D.runDeepAnalysis('Q', {
		plan:        async () => [ 'Q' ],                // planner fell back to the raw task
		investigate: async () => 'x',
		gap:         async () => [],
		synthesize:  async () => 'R'
	});
	eq(out, null, 'a single-angle question is not treated as deep (null → single pass)');

	// ── A thrown investigate is caught (one sub-question fails, the other still counts) ──
	out = await D.runDeepAnalysis('Q', {
		plan:        async () => [ 'a', 'b' ],
		investigate: async (q) => { if (q === 'a') { throw new Error('boom'); } return 'ok'; },
		gap:         async () => [],
		synthesize:  async (t, ev) => 'R:' + ev
	});
	ok(/R:/.test(out) && /\[b\]/.test(out), 'a thrown investigation is swallowed; the surviving finding is used');

	// ── Synthesis failure → digest fallback (never empty) ───────────────────────
	out = await D.runDeepAnalysis('Q', {
		plan:        async () => [ 'a', 'b' ],
		investigate: async (q) => 'found ' + q,
		gap:         async () => [],
		synthesize:  async () => { throw new Error('synth down'); }
	});
	ok(/found a/.test(out) && /found b/.test(out), 'when synthesis fails, a plain digest of findings is returned');

	// ── Synthesis fabrication-rejection (returns '') → same digest fallback ──────
	// The client's synthesizer returns '' when its figure-grounding backstop rejects a report that
	// invented numbers not in the findings; the orchestrator must treat that empty return exactly like a
	// failure and fall back to the grounded digest, never surface an empty answer.
	out = await D.runDeepAnalysis('Q', {
		plan:        async () => [ 'a', 'b' ],
		investigate: async (q) => 'found ' + q,
		gap:         async () => [],
		synthesize:  async () => ''
	});
	ok(/found a/.test(out) && /found b/.test(out), 'a rejected (empty) synthesis falls back to the grounded digest');

	// ── onProgress is emitted (responsiveness) ──────────────────────────────────
	const progress = [];
	await D.runDeepAnalysis('Q', {
		plan:        async () => [ 'a', 'b' ],
		investigate: async () => 'x',
		gap:         async () => [],
		synthesize:  async () => 'R',
		onProgress:  (t) => progress.push(t)
	});
	ok(progress.some(t => /Planning/.test(t)), 'emits a planning progress line');
	ok(progress.some(t => /Investigating/.test(t)), 'emits an investigating progress line');
	ok(progress.some(t => /report/i.test(t)), 'emits a synthesizing progress line');

	console.log('DeepAnalysis: ' + passed + ' assertions passed');
})();
