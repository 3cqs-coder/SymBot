'use strict';

// ── Structured deep analysis ─────────────────────────────────────────────────────────────────────
//
// Turns one hard question into a structured investigation over the read-only tools:
//   plan → gather → gap-check → adaptive-stop → cited synthesis.
// Instead of a single free-form tool loop, it breaks the question into sub-questions, investigates
// each (reusing the ordinary tool loop), asks a supervisor whether anything is still missing, and
// then writes one grounded report over the collected findings.
//
// This module is the ORCHESTRATION plus its PURE helpers, decoupled from the AI client through an
// injected `deps` object, so the whole control flow is unit-testable with deterministic fakes. The
// client wires the real deps (LLM planning / gap-check / synthesis + the tool-loop investigator).
//
// Safety posture: every phase FAILS SAFE. Planning fails OPEN (fall back to a single pass so the user
// still gets an answer); the gap supervisor fails CLOSED (no follow-ups, so a run can never balloon);
// the whole run is bounded by round / sub-question / evidence caps. It is read-only and is never on
// the trading path. `runDeepAnalysis` returns null to mean "not a deep question — use the simple
// path", so the caller keeps its existing single-pass behavior as the graceful fallback.

// Tuning — deliberately small so the extra passes stay affordable on modest local hardware.
const DEFAULTS = {
	maxRounds:        2,      // investigation rounds (initial + follow-ups)
	subqRound1:       3,      // sub-questions investigated in the first round
	subqFollowup:     2,      // follow-up sub-questions accepted per later round
	maxEvidenceChars: 8000,   // total findings handed to synthesis (keeps it within a small window)
	minBlockChars:    300,    // don't include a findings block smaller than this when truncating
	// Wall-clock budget for the GATHERING phase (plan + investigations). Once exceeded, stop gathering
	// and synthesize whatever was collected, so a slow local model can't run the deep flow long enough
	// to trip the chat request's hard timeout and sever the connection. Synthesis runs after this.
	gatherBudgetMs:   150000  // 150s of gathering, then write the report with what we have
};


// ── Pure helpers ───────────────────────────────────────────────────────────────

// Strip a ```json … ``` fence a small model often wraps JSON in.
function stripFence(s) {
	return String(s == null ? '' : s).replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
}

// Parse the planner output into a sub-question list. Accepts an already-parsed object or a JSON string
// (fenced or not). FAIL-OPEN: anything unusable falls back to [task] so research still runs as one
// pass. Returns a de-duplicated, trimmed, non-empty list.
function parsePlan(raw, task) {

	const fallback = [ String(task == null ? '' : task).trim() ].filter(Boolean);

	let obj = raw;
	if (typeof raw !== 'object' || raw === null) { try { obj = JSON.parse(stripFence(raw)); } catch (e) { return fallback; } }

	const subs = (obj && Array.isArray(obj.subquestions)) ? obj.subquestions : [];
	const seen = new Set();
	const clean = [];
	for (const s of subs) {
		if (typeof s !== 'string') { continue; }
		const t = s.trim();
		const key = t.toLowerCase();
		if (t && !seen.has(key)) { seen.add(key); clean.push(t); }
	}

	return clean.length ? clean : fallback;
}

// Parse the gap-supervisor output into follow-up sub-questions. FAIL-CLOSED: `done`, or anything
// unusable, yields [] so the run stays bounded. Returns trimmed, non-empty follow-ups.
function parseGap(raw) {

	let obj = raw;
	if (typeof raw !== 'object' || raw === null) { try { obj = JSON.parse(stripFence(raw)); } catch (e) { return []; } }

	// Fail-closed: only continue on an EXPLICIT done:false. Anything else — done:true, done absent, or a
	// malformed object — ends the run so it can never balloon on an ambiguous supervisor reply.
	if (!obj || obj.done !== false) { return []; }

	const f = Array.isArray(obj.followups) ? obj.followups : [];
	return f.filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
}

// Which follow-ups become the next round: drop any already investigated (via `seen`) or duplicated
// within this batch (case-insensitive), and cap the count.
function nextPending(followups, seen, cap) {
	const out = [];
	const taken = new Set();
	for (const f of (followups || [])) {
		const key = String(f == null ? '' : f).trim().toLowerCase();
		if (!key || taken.has(key) || (seen && seen.has(key))) { continue; }
		taken.add(key);
		out.push(f);
		if (out.length >= cap) { break; }
	}
	return out;
}

// Assemble a bounded evidence string from the gathered { subq, answer } blocks, in discovery order
// (earlier sub-questions set up the later ones). Caps the total so synthesis fits a small window.
function boundEvidence(covered, maxChars, minBlock) {

	const cap = (maxChars > 0) ? maxChars : DEFAULTS.maxEvidenceChars;
	const floor = (minBlock > 0) ? minBlock : DEFAULTS.minBlockChars;

	const blocks = [];
	let total = 0;

	for (const c of (covered || [])) {
		if (!c || typeof c.answer !== 'string') { continue; }
		const block = '[' + c.subq + ']\n' + c.answer;
		if (total + block.length > cap) {
			const room = cap - total;
			if (room >= floor) { blocks.push(block.slice(0, room) + ' …[truncated]'); }
			break;
		}
		blocks.push(block);
		total += block.length;
	}

	return blocks.join('\n\n---\n\n');
}

// Plain digest of the findings — the fallback report when LLM synthesis is unavailable.
function digest(covered) {
	return (covered || []).map(c => '• ' + c.subq + '\n' + c.answer).join('\n\n');
}


// ── Orchestrator ─────────────────────────────────────────────────────────────────

// deps:
//   plan(task)               -> Promise<string[]>   sub-questions (already parsed via parsePlan)
//   investigate(subq)        -> Promise<string>     grounded findings for one sub-question
//   gap(task, covered)       -> Promise<string[]>   follow-up sub-questions (already parsed via parseGap)
//   synthesize(task, ev)     -> Promise<string>     the final cited report
//   onActivity?()                                   optional keep-alive ping (e.g. a typing indicator)
//   onProgress?(text)                               optional human-readable status line ("Investigating …")
// cfg overrides DEFAULTS. Returns the final report string, or NULL meaning "not a deep question —
// use the simple single-pass path" (planning produced ≤1 sub-question, or nothing was gathered).
// Never throws: a thrown investigate/gap/synthesize is caught and treated as empty.
async function runDeepAnalysis(task, deps, cfg) {

	deps = deps || {};
	cfg = Object.assign({}, DEFAULTS, cfg || {});

	// Progress keeps a multi-step run feeling responsive: the user sees what it is doing rather than a
	// silent pause. Optional so the API/curl path (no socket) just ignores it. Short, bounded lines.
	const progress = (t) => { if (deps.onProgress) { try { deps.onProgress(t); } catch (e) {} } };
	const ping = () => { if (deps.onActivity) { try { deps.onActivity(); } catch (e) {} } };
	const shortQ = (q) => { const s = String(q == null ? '' : q).trim(); return s.length > 80 ? s.slice(0, 77) + '…' : s; };

	progress('Planning the analysis…');
	const planned = await safeCall(() => deps.plan(task), [ task ]);

	// One (or zero) sub-question isn't worth the extra passes — signal the caller to use its simple path.
	if (!Array.isArray(planned) || planned.length <= 1) { return null; }

	const covered = [];
	const seen = new Set();
	let pending = planned.slice(0, cfg.subqRound1);

	// Gathering deadline: once exceeded, stop investigating and go straight to synthesis with what we
	// have, so a slow local model can't drag the deep flow past the chat request's hard timeout.
	const gatherStart = Date.now();
	const overBudget = () => (cfg.gatherBudgetMs > 0) && ((Date.now() - gatherStart) >= cfg.gatherBudgetMs);

	for (let round = 0; round < cfg.maxRounds && pending.length && !overBudget(); round++) {

		let gained = 0;

		for (const subq of pending) {

			if (overBudget()) { progress('Time budget reached — writing the report with what I have…'); break; }

			const key = String(subq == null ? '' : subq).trim().toLowerCase();
			if (!key || seen.has(key)) { continue; }
			seen.add(key);

			ping();
			progress('Investigating: ' + shortQ(subq));

			const ans = await safeCall(() => deps.investigate(subq), '');
			if (ans && String(ans).trim()) { covered.push({ subq: subq, answer: String(ans).trim() }); gained++; }
		}

		if (!gained || overBudget()) { break; }   // adaptive stop, or the gathering budget is spent

		const followups = await safeCall(() => deps.gap(task, covered), []);
		pending = nextPending(followups, seen, cfg.subqFollowup);
		if (!pending.length) { break; }
		progress('Following up on ' + pending.length + ' more angle' + (pending.length === 1 ? '' : 's') + '…');
	}

	if (!covered.length) { return null; }   // gathered nothing usable → caller falls back to simple path

	progress('Writing the report…');
	const evidence = boundEvidence(covered, cfg.maxEvidenceChars, cfg.minBlockChars);
	const report = await safeCall(() => deps.synthesize(task, evidence), '');

	return (report && String(report).trim()) ? String(report).trim() : digest(covered);
}

// Await fn(); on any throw/rejection return the fallback. Keeps the orchestrator's "never throws"
// guarantee without try/catch at every call site.
async function safeCall(fn, fallback) {
	try { const r = await fn(); return (r === undefined || r === null) ? fallback : r; }
	catch (e) { return fallback; }
}


module.exports = {
	DEFAULTS,
	// pure helpers (exported for testing)
	stripFence,
	parsePlan,
	parseGap,
	nextPending,
	boundEvidence,
	digest,
	// orchestrator
	runDeepAnalysis
};