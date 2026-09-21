'use strict';

// Tests for the community-pack aggregation + accuracy-verification tooling (AIMemory.aggregatePacks,
// evaluateCorpus, compareEvaluations) and the shipped held-out eval set. All pure — no DB, no model.

const assert = require('assert');
const M = require('../../ai/AIMemory.js');
const aiTools = require('../../ai/AITools.js');
const seed = require('../../ai/data/seed-learning.json');
const evalSet = require('../../ai/data/learning-eval.json');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function eq(a, b, m) { assert.strictEqual(a, b, m); passed++; }

const validTools = new Set(aiTools.TOOLS.map(t => t.name));
const pack = (records, author) => M.buildPack(records, { author });

// ── aggregatePacks: majority vote, conflict, singleton gate, dedup ──
{
	const p1 = pack([ { question: 'how are my deals', tools: [ 'get_open_deals_status' ], confidence: 'high' } ], 'alice');
	const p2 = pack([ { question: 'how are my deals', tools: [ 'get_open_deals_status' ], confidence: 'high' } ], 'bob');
	const p3 = pack([ { question: 'how are my deals', tools: [ 'get_performance_summary' ], confidence: 'high' } ], 'carol');   // dissenting vote
	const p4 = pack([ { question: 'whats my win rate', tools: [ 'get_performance_summary' ], confidence: 'high' } ], 'dave');   // singleton

	const agg = M.aggregatePacks([ p1, p2, p3, p4 ], { validTools, minContributors: 2 });
	eq(agg.report.contributors, 4, 'counts each submitted pack as one contributor');
	eq(agg.candidate.length, 1, 'only the majority-supported, above-threshold pattern is accepted');
	eq(agg.candidate[0].tools[0], 'get_open_deals_status', 'majority tool set wins (2 votes vs 1)');
	eq(agg.report.dropped_low_support, 1, 'the single-contributor pattern is gated out (volume is not ground truth)');
	eq(agg.report.conflicts.length, 1, 'the same-question/different-tool disagreement is surfaced as a conflict');
	ok(agg.report.conflicts[0].resolved === true, 'a clear majority conflict is marked resolved (not a tie)');
	ok(agg.report.per_tool_coverage.get_open_deals_status === 1, 'per-tool coverage reflects the accepted pattern');
}

// ── a tie is left UNRESOLVED (never guessed) ──
{
	const a = pack([ { question: 'ambiguous q', tools: [ 'get_balance' ], confidence: 'high' } ], 'a');
	const b = pack([ { question: 'ambiguous q', tools: [ 'get_open_deals_status' ], confidence: 'high' } ], 'b');
	const agg = M.aggregatePacks([ a, b ], { validTools, minContributors: 1 });
	eq(agg.candidate.length, 0, 'a 1-1 tie is not adopted');
	ok(agg.report.conflicts.length === 1 && agg.report.conflicts[0].resolved === false, 'the tie is surfaced as an unresolved conflict');
}

// ── a bad tool is rejected by verifyPack, not aggregated ──
{
	const good = pack([ { question: 'q', tools: [ 'get_balance' ], confidence: 'high' } ], 'x');
	const bad = pack([ { question: 'q', tools: [ 'get_balance' ], confidence: 'high' } ], 'y');
	// Corrupt bad's record to reference an unknown tool AFTER checksum (simulate a hostile pack): rebuild it.
	const hostile = M.buildPack([ { question: 'q2', tools: [ 'get_balance' ], confidence: 'high' } ], { author: 'z' });
	hostile.records[0].tools = [ 'not_a_real_tool' ];   // now the checksum no longer matches → whole pack rejected
	const agg = M.aggregatePacks([ good, bad, hostile ], { validTools, minContributors: 1 });
	ok(agg.report.packs.some(p => p.ok === false), 'a tampered/invalid pack is reported as not ok');
	ok(!agg.candidate.some(r => r.tools.includes('not_a_real_tool')), 'no invalid tool ever reaches the candidate');
}

// ── evaluateCorpus: retrieval accuracy on a held-out set ──
{
	const corpus = [ { question: 'how are my open deals', tools: [ 'get_open_deals_status' ], confidence: 'high' } ];
	const r = M.evaluateCorpus(corpus, [ { question: 'how are my open positions doing', tools: [ 'get_open_deals_status' ] } ]);
	eq(r.total, 1, 'one case scored');
	eq(r.correct, 1, 'a close paraphrase retrieves the right tool');
	ok(r.by_tool.get_open_deals_status && r.by_tool.get_open_deals_status.accuracy === 1, 'per-tool accuracy recorded');
}

// ── compareEvaluations: delta, flips, per-tool regression gate ──
{
	const evalTwo = [
		{ question: 'how are my open positions doing', tools: [ 'get_open_deals_status' ] },
		{ question: 'what is my win rate overall', tools: [ 'get_performance_summary' ] }
	];
	const before = M.evaluateCorpus([], evalTwo);
	const after = M.evaluateCorpus([ { question: 'how are my open deals', tools: [ 'get_open_deals_status' ], confidence: 'high' } ], evalTwo);
	const cmp = M.compareEvaluations(before, after);
	ok(cmp.global.delta > 0, 'adding a helpful pattern raises global accuracy');
	eq(cmp.regressions.length, 0, 'no per-tool regression when only adding coverage');
	eq(cmp.recommend, 'adopt', 'recommend adopt when nothing regressed and global improved');
	ok(cmp.newly_correct.some(f => /open positions/.test(f.question)), 'the flipped question is reported as newly correct');
}

// ── The shipped held-out eval set is valid, held-out, and the seed clears a reasonable baseline ──
{
	ok(evalSet.format === 'symbot-ai-learning-eval' && evalSet.version === 1, 'eval set has a versioned format header');
	ok(Array.isArray(evalSet.cases) && evalSet.cases.length >= 20, 'eval set has a meaningful number of cases');
	for (const c of evalSet.cases) {
		ok(c.question && Array.isArray(c.tools) && c.tools.length, 'each case has a question and expected tool(s)');
		for (const t of c.tools) { ok(validTools.has(t), 'eval tool "' + t + '" exists in the registry'); }
	}
	// Held-out invariant: no eval question may be an exact (normalized) copy of a seed question.
	const seedQs = new Set(seed.records.map(r => String(r.question || '').toLowerCase().trim().replace(/\s+/g, ' ')));
	for (const c of evalSet.cases) {
		ok(!seedQs.has(String(c.question).toLowerCase().trim().replace(/\s+/g, ' ')), 'eval question is held out (not a seed copy): ' + c.question);
	}
	const base = M.evaluateCorpus(seed.records, evalSet);
	ok(base.accuracy >= 0.6, 'the shipped seed corpus clears a 60% baseline on the held-out eval (got ' + (base.accuracy * 100).toFixed(1) + '%)');
}

// ── The shared route orchestrator (instance + Hub both call these) ──
{
	const L = require('../../webserver/learningAggregation.js');
	const recs = [ { question: 'how are my open positions doing right now', tools: [ 'get_open_deals_status' ], confidence: 'high' } ];
	const A = M.buildPack(recs, 'a'), B = M.buildPack(recs, 'b');
	(async () => {
		let adopted = null;
		const out = await L.aggregateResponse(M, aiTools, { packs: [ A, B ], commit: true }, { current: [], adopt: (r) => { adopted = r; return r.length; } });
		ok(out.success && out.committed && out.imported === 1 && out.new_count === 1, 'aggregateResponse aggregates, commits via the adopt callback, and reports counts');
		ok(adopted && adopted.length === 1, 'the adopt callback receives exactly the new winners to persist');
		const empty = await L.aggregateResponse(M, aiTools, { packs: [] }, {});
		ok(empty.error, 'aggregateResponse returns an error object when no packs are supplied');
		const ev = await L.evaluateResponse(M, aiTools, { current: adopted });
		ok(ev.success && ev.total === evalSet.cases.length && typeof ev.accuracy === 'number', 'evaluateResponse scores the corpus against the full eval set');

		// opts.validTools override (the Hub passes the union of tools its live fleet reports, not the local
		// registry). A pattern referencing a tool that exists ONLY in the supplied fleet set must be accepted,
		// and one referencing a tool absent from that set must be dropped as invalid — proving the Hub validates
		// contributed packs against the real fleet rather than only its own process registry.
		const fleetSet = new Set([ 'get_open_deals_status', 'a_fleet_only_tool' ]);
		const fleetRecs = [ { question: 'does the fleet only tool route yet', tools: [ 'a_fleet_only_tool' ], confidence: 'high' } ];
		const F1 = M.buildPack(fleetRecs, 'f1'), F2 = M.buildPack(fleetRecs, 'f2');
		const fleetOut = await L.aggregateResponse(M, aiTools, { packs: [ F1, F2 ] }, { current: [], validTools: fleetSet });
		ok(fleetOut.success && fleetOut.new_count === 1, 'a pattern for a tool present only in the supplied fleet validTools set is accepted');

		const bogusRecs = [ { question: 'does the fleet only tool route yet', tools: [ 'a_tool_no_instance_has' ], confidence: 'high' } ];
		const G1 = M.buildPack(bogusRecs, 'g1'), G2 = M.buildPack(bogusRecs, 'g2');
		const bogusOut = await L.aggregateResponse(M, aiTools, { packs: [ G1, G2 ] }, { current: [], validTools: fleetSet });
		ok(bogusOut.success && bogusOut.new_count === 0, 'a pattern for a tool absent from the fleet validTools set is dropped as invalid');

		console.log('LearningAggregation: ' + passed + ' assertions passed');
	})();
}
