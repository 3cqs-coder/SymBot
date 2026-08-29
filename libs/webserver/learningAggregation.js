'use strict';

// Shared orchestration for the AI-learning corpus "aggregate + verify accuracy" maintainer endpoints, used by
// BOTH the instance webserver (libs/webserver/routes.js) and the Hub webserver (libs/webserver/Hub/routes.js).
// The ONLY difference between the two surfaces is where the current corpus comes from and how an adopted
// pattern is persisted — passed in as `current` and `adopt` — so the aggregation, the held-out accuracy
// measurement, the tool validation, and the response shape live in ONE place and can never drift between them.
//
// The held-out eval set is required once here (relative to this file, so both callers resolve the same data).

const EVAL_SET = require(__dirname + '/../ai/data/learning-eval.json');

function validToolSet(aiTools) { return new Set(((aiTools && aiTools.TOOLS) || []).map(t => t.name)); }

// Aggregate contributed packs and measure the accuracy change (dry-run unless body.commit is true).
//   aiMemory, aiTools — the shared modules (passed so this file requires neither and stays a pure orchestrator).
//   body              — the request body: { packs | pack, min_contributors?, commit? }.
//   opts.current      — the corpus record array to aggregate against (undefined ⇒ AIMemory loads its own store).
//   opts.adopt        — async (newRecords) => count; persists the winners on commit and returns how many stored.
//   opts.validTools   — optional Set of tool names to validate contributed patterns against. The Hub passes the
//                       UNION of tools its running instances actually report, so a pack is validated against the
//                       real fleet rather than only the Hub process's own registry; omitted ⇒ this process's tools.
// Returns a plain result object for the caller to send, or { error } for the caller to surface via sendErr.
async function aggregateResponse(aiMemory, aiTools, body, opts) {

	body = body || {};
	opts = opts || {};

	const packs = Array.isArray(body.packs) ? body.packs : (body.pack ? [ body.pack ] : []);
	if (!packs.length) { return { error: 'No packs provided to aggregate.' }; }

	const validTools = (opts.validTools instanceof Set && opts.validTools.size) ? opts.validTools : validToolSet(aiTools);
	const minContributors = (body.min_contributors != null && !isNaN(parseInt(body.min_contributors, 10))) ? parseInt(body.min_contributors, 10) : 2;
	const preview = await aiMemory.previewAggregate(packs, EVAL_SET, { current: opts.current, validTools, aliases: aiTools.TOOL_ALIASES, minContributors });

	let imported = 0;
	if (body.commit === true && preview.new_records.length && typeof opts.adopt === 'function') {
		imported = (await opts.adopt(preview.new_records)) || 0;
	}

	return {
		success: true,
		committed: body.commit === true,
		imported: imported,
		candidate_count: preview.candidate.length,
		new_count: preview.new_records.length,
		report: preview.report,
		comparison: preview.comparison
	};
}

// Measure the current corpus against the held-out eval set (no packs). `opts.current`/`opts.validTools` as above.
async function evaluateResponse(aiMemory, aiTools, opts) {

	opts = opts || {};
	const validTools = (opts.validTools instanceof Set && opts.validTools.size) ? opts.validTools : validToolSet(aiTools);
	const preview = await aiMemory.previewAggregate([], EVAL_SET, { current: opts.current, validTools, aliases: aiTools.TOOL_ALIASES });
	const ev = preview.current_eval || { total: 0, correct: 0, accuracy: 0, by_tool: {}, results: [] };
	return { success: true, total: ev.total, correct: ev.correct, accuracy: ev.accuracy, by_tool: ev.by_tool, misses: ev.results.filter(r => !r.correct) };
}

module.exports = { aggregateResponse, evaluateResponse };
