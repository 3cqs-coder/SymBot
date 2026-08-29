'use strict';

const { Ollama } = require('ollama');
const OpenAI = require('openai');

const analysisGuard = require('./AIAnalysisGuard');
const aiGuardrails = require('./AIGuardrails');
const axioms = require('./Axioms');
const aiTools = require('./AITools');
const aiFaithfulness = require('./AIFaithfulness');
const aiMemory = require('./AIMemory');
const aiMemoryStore = require('./AIMemoryStore');
const deepAnalysis = require('./AIDeepAnalysis');
const { WORKER_TO_HUB } = require('../app/Hub/MessageTypes.js');


let aiClient;
let aiProvider;
let modelCurrent;
let shareData;
let learningSeeded = false;
let learningSeedingPromise = null;   // in-flight seeding pass, so concurrent first-use calls coalesce (no double-seed)


const modelDefaults = {
	ollama: 'llama3.2',
	openai: 'gpt-4o',
};

const TIMEOUT_MS = 75000;
const maxHistoryDefault = 25;
const maxMessageAge = 2 * (60 * 60 * 1000);
const hoursInterval = 1;


// ── Generation parameters ───────────────────────────────────────────────────
// Per-purpose decoding settings, keyed by the `purpose` a caller asks for.
// The factual and structured paths run at a low (or zero) temperature so their
// output is consistent and easy to parse; chat keeps the provider default
// unless the user sets one in config. These are normalized option names —
// the provider adapters translate them into each SDK's own shape, so callers
// never have to know whether OpenAI or Ollama is active.
const GEN_PRESETS = {
	chat:        {},                              // provider default unless configured
	analysis:    { temperature: 0 },              // deterministic — same position gives the same read on re-run
	compression: { temperature: 0.3 },            // faithful summary
	journal:     { temperature: 0.2 },            // short factual note
};

const PERSONA = aiGuardrails.readText('persona.txt');


// Appended to the system prompt when tool-calling is on. Written as a strict
// grounding rulebook: the tool
// results are the ONLY source of truth about the user's account, and the model must
// not pad, round out, or invent anything beyond them. Rule 4 in particular stops a
// small model from inventing extra list items to "complete" a breakdown.
// The tool system note lives in libs/ai/data/tool-system-note.txt (plain text — a stray
// character in the wording cannot break this file).
const TOOL_SYSTEM_NOTE = aiGuardrails.readText('tool-system-note.txt');

// Lightweight system note for the fast-lane (tool-free) reply to clearly-general questions —
// keeps the model answering directly from its own knowledge and forbids inventing account figures.
const FREEFORM_NOTE = aiGuardrails.readText('freeform-note.txt');


// ── Context compression ─────────────────────────────────────────────────────
// Fires when total chars in message history exceeds the threshold.
// Compresses middle turns into a structured summary, preserving
// the first exchange and the most recent N messages verbatim.
const COMPRESSION_DEFAULTS = {
	enabled:        true,
	threshold_chars: 80000,   // ~20K tokens — fire well before model limits
	protect_last_n:  10       // always keep last N messages verbatim
};

// Map to store conversation history for each room
const conversationHistory = new Map();

// Map of room → AbortController for currently active generations.
// Allows external callers (e.g. socket stopGeneration event) to abort mid-stream.
const activeGenerations = new Map();

let aiStarted = false;

const cleanupRoomsTimer = setInterval(() => {

	// Best-effort local guard so a stray throw stays contained here rather than relying on the
	// process-level net — matching the local-guard convention every other server-side timer follows.
	try { cleanupRooms(); } catch (e) {}

}, (hoursInterval * (60 * 60 * 1000)));

// Unref so this background cleanup interval never keeps the process alive on its own — matching the
// unref convention the other AI/server timers follow (withTimeout, the router timeout, the 3CQS timers).
if (cleanupRoomsTimer && cleanupRoomsTimer.unref) { cleanupRoomsTimer.unref(); }


// Keyword-density windowing — finds the most relevant passage for the query.
// Used for large documents to stay within model context limits.
const SMALL_DOC_LIMIT = 20000;  // chars — below this, full text is used
const PASSAGE_SIZE    = 8000;   // chars per window for large docs
const PASSAGE_STEP    = 2000;   // step between windows

function extractPassage(text, query) {

	if (!text || text.length <= SMALL_DOC_LIMIT) return text;

	// Tokenize query into meaningful keywords
	const stopWords = new Set(['the','a','an','is','are','was','were','be','been',
		'have','has','had','do','does','did','will','would','could','should',
		'what','who','when','where','why','how','which','that','this','with',
		'from','for','and','but','not','you','they','them','their','about']);

	const keywords = [...new Set(
		query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
			.filter(w => w.length > 2 && !stopWords.has(w))
	)];

	// Fall back to full text if no useful keywords
	if (keywords.length === 0) return text.slice(0, SMALL_DOC_LIMIT);

	const lower = text.toLowerCase();
	let bestScore = -1;
	let bestPos   = 0;

	for (let pos = 0; pos < text.length - PASSAGE_SIZE; pos += PASSAGE_STEP) {
		const slice = lower.slice(pos, pos + PASSAGE_SIZE);
		const score = keywords.reduce((s, kw) => {
			let count = 0, idx = 0;
			while ((idx = slice.indexOf(kw, idx)) !== -1) { count++; idx++; }
			return s + count;
		}, 0);
		if (score > bestScore) { bestScore = score; bestPos = pos; }
	}

	// Snap to nearest paragraph boundary
	const snap = text.lastIndexOf('\n\n', bestPos);
	const start = (snap > bestPos - 500 && snap >= 0) ? snap + 2 : bestPos;
	const passage = text.slice(start, start + PASSAGE_SIZE);

	const truncNote = text.length > SMALL_DOC_LIMIT
		? `\n\n[Note: document is ${Math.round(text.length/1000)}K chars — showing most relevant ${Math.round(PASSAGE_SIZE/1000)}K char passage. Ask follow-up questions to explore other sections.]`
		: '';

	return passage + truncNote;
}


// Returns compression config, merging defaults with app config
function getCompressionConfig() {

	// shareData.appData.ai is not seeded by symbot.js — read safely with fallback
	const cfg = (shareData.appData &&
	             shareData.appData.ai &&
	             shareData.appData.ai.context_compression) || {};
	return {
		enabled:         cfg.enabled         !== false,
		threshold_chars: cfg.threshold_chars  || COMPRESSION_DEFAULTS.threshold_chars,
		protect_last_n:  cfg.protect_last_n   || COMPRESSION_DEFAULTS.protect_last_n
	};
}


// Resolve the normalized generation options for a purpose, layering any user
// overrides from config over the per-purpose preset. The deterministic presets
// (router / compression / journal) are never loosened; only the chat
// temperature and an optional response cap are user-configurable.
function resolveGenOptions(purpose) {

	const opts = { ...(GEN_PRESETS[purpose] || {}) };

	const gen = (shareData.appData && shareData.appData.ai && shareData.appData.ai.generation) || {};

	if (purpose === 'chat') {

		const t = parseFloat(gen.chat_temperature);

		if (!isNaN(t)) { opts.temperature = Math.min(Math.max(t, 0), 2); }
	}

	// An optional hard cap applies only to the visible responses (chat + analysis)
	// so an internal summary or routing pass can never be truncated by it.
	if (purpose === 'chat' || purpose === 'analysis') {

		const mt = parseInt(gen.max_tokens, 10);

		if (!isNaN(mt) && mt > 0) { opts.maxTokens = mt; }
	}

	// Optional context window (Ollama num_ctx). Opt-in: when set it is passed to the provider so the
	// model uses that window; unset leaves the provider default untouched. Applies to every purpose so
	// tool-selection and internal passes get the same window as the visible answer.
	const nctx = parseInt(gen.num_ctx, 10);
	if (!isNaN(nctx) && nctx > 0) { opts.num_ctx = nctx; }

	return (opts);
}


// Tool-calling config, merging defaults with app config. Off by default so
// existing chat behavior (the AIContext router) is unchanged until enabled.
const TOOLS_MAX_ITERATIONS_DEFAULT = 5;

// Explore sub-agent: hard ceiling on wall-clock so a nested loop of model calls can never
// hang the chat. Aborts cleanly at the next loop boundary.
const EXPLORE_TIMEOUT_MS = 120000;

// Explore / deep-research sub-agent persona and the structured deep-analysis prompts. Kept as plain-text
// data files (a stray character in the wording cannot break this source file), read the same way as the
// other AI prompts.
const EXPLORE_SUBAGENT_SYSTEM = aiGuardrails.readText('explore-subagent.txt');
const EXPERT_ANALYST_SYSTEM   = aiGuardrails.readText('expert-analyst.txt');
const COMPRESSION_SYSTEM      = aiGuardrails.readText('compression-summary.txt');
const REPHRASE_SYSTEM         = aiGuardrails.readText('question-rephrase.txt');
const DEEP_PLAN_SYSTEM   = aiGuardrails.readText('deep-plan.txt');
const DEEP_GAP_SYSTEM    = aiGuardrails.readText('deep-gap.txt');
const DEEP_REPORT_SYSTEM = aiGuardrails.readText('deep-report.txt');

// JSON schemas that constrain the planner / gap-supervisor output (structured outputs on capable
// endpoints; a plain-JSON retry otherwise). Parsing still fails safe if a small model ignores them.
const DEEP_PLAN_SCHEMA = { type: 'object', properties: { subquestions: { type: 'array', items: { type: 'string' } } }, required: [ 'subquestions' ] };
const DEEP_GAP_SCHEMA  = { type: 'object', properties: { done: { type: 'boolean' }, followups: { type: 'array', items: { type: 'string' } } }, required: [ 'done' ] };

// Wall-clock ceilings for the auxiliary planner / gap calls so a slow local model can't stall a run.
const DEEP_PLAN_TIMEOUT_MS = 25000;
const DEEP_GAP_TIMEOUT_MS  = 20000;

function getToolsConfig() {

	const cfg = (shareData.appData && shareData.appData.ai && shareData.appData.ai.tools) || {};

	const max = parseInt(cfg.max_iterations, 10);

	return {
		enabled:        cfg.enabled === true,
		max_iterations: (!isNaN(max) && max > 0) ? Math.min(max, 10) : TOOLS_MAX_ITERATIONS_DEFAULT,
		// Opt-in answer verification (faithfulness check). Off by default so the
		// common path never pays for an extra judge call.
		verify:         cfg.verify === true,
		// Opt-in topic/scope guard: a cheap classifier declines off-topic requests.
		// Off by default so the common path pays no extra call; users enable it for a
		// stricter, on-topic assistant.
		topic_guard:    cfg.topic_guard === true,
		// Opt-in explore sub-agent (deep research). When on, a chat turn may run a long, bounded
		// nested tool loop — the request-timeout logic uses this to grant that path more headroom.
		explore:        cfg.explore === true,
		// Opt-in structured deep analysis for the explore sub-agent: plan → gather → gap-check → cited
		// synthesis instead of a single pass. Off by default (it costs extra planner/gap calls); it
		// degrades to the single pass automatically when the model can't sustain the structure.
		deep_explore:   cfg.deep_explore === true,
		// Opt-in tool-call tracing: logs every tool the model invoked, with its arguments, timing, and a
		// one-line result summary (row count / empty / error). Off by default so the log stays quiet; a
		// user turns it on (Configuration → AI, or ai.tools.trace) to capture exactly how a given answer
		// was produced when reporting a problem. Purely diagnostic — it changes no answer.
		trace:          cfg.trace === true,
		// Opt-in corrective recovery: when a whole tool loop comes back empty (every tool returned no
		// rows / unavailable / an error), rephrase the question ONCE and let the model try the tools again
		// with the clearer wording, before it answers "no data". Off by default (it costs one extra LLM
		// call, only on the weak-result path); bounded and fail-safe.
		corrective:     cfg.corrective === true,
		// Opt-in STRONGER model for the data (tool) path only. Empty by default, so the whole assistant
		// runs on one model. When set (e.g. a 14B where the chat model is an 8B), the tool loop — the
		// identifier/number-emitting step where a small model most often fabricates a deal id or miscounts
		// — uses this model instead, while free-form conversation stays on the lighter, faster chat model.
		// A model cascade: pay for the stronger model only on the calls where accuracy matters most.
		tool_model:     (typeof cfg.tool_model === 'string') ? cfg.tool_model.trim() : ''
	};
}


// Is a tool result "weak" — nothing the model can answer from? True for an explicit error, an
// unavailable result, a zero count, or a result whose only payload arrays are all empty. A scalar/string
// result (e.g. a computed figure) is NOT weak. Mirrors summarizeToolResult's emptiness signal; used by
// the corrective recover-gate to decide whether a whole loop found nothing. Single exit.
function weakResult(result) {

	let weak = false;

	if (result && typeof result === 'object') {
		if ('error' in result && result.error) { weak = true; }
		else if (result.available === false) { weak = true; }
		else {
			// Explicit row-count fields the tools use to report how many records matched (different tools
			// name it differently). If any is present, 0 across them all means nothing matched → weak.
			const COUNT_FIELDS = [ 'count', 'completed_deals', 'open_deals', 'bot_count', 'total_errors', 'restarts', 'total_orders' ];
			let sawCount = false;
			let allZero = true;
			for (const f of COUNT_FIELDS) { if (typeof result[f] === 'number') { sawCount = true; if (result[f] !== 0) { allZero = false; } } }

			if (sawCount) { weak = allZero; }
			else {
				const arrays = Object.keys(result).filter(k => Array.isArray(result[k]));
				weak = arrays.length > 0 && arrays.every(k => result[k].length === 0);
			}
		}
	}

	return weak;
}


// One-line summary of a tool result for the trace log: how many rows it returned and whether it was a
// success, an empty result, or a reported error — enough to see WHY an answer came out the way it did
// without dumping the whole payload. Never throws. Single exit.
function summarizeToolResult(result) {

	let out = 'ok';

	try {
		if (result && typeof result === 'object') {
			if ('error' in result && result.error) { out = 'ERROR: ' + String(result.error).slice(0, 120); }
			else if (result.available === false) { out = 'unavailable'; }
			else if (typeof result.count === 'number') {
				// An explicit count is authoritative: 0 truly means empty.
				out = result.count === 0 ? 'EMPTY (0 rows)' : ('ok (' + result.count + ' rows)');
			}
			else {
				// No explicit count: use the LARGEST array field, not the first. A summary object (e.g. a
				// risk snapshot) can carry an incidental empty list alongside its real scalar counts, and
				// reporting the first-empty-array as "EMPTY" was a false negative. Never claim EMPTY here —
				// only a real count:0 does.
				let max = null;
				for (const k of Object.keys(result)) { if (Array.isArray(result[k])) { max = Math.max(max || 0, result[k].length); } }
				out = (max === null) ? 'ok' : (max === 0 ? 'ok (no list rows)' : ('ok (' + max + ' rows)'));
			}
		}
	}
	catch (e) { out = 'ok'; }

	return out;
}


const FAITHFULNESS_TIMEOUT_MS = 15000;

// Race a promise against a timeout that resolves (never rejects) to '' — a hung
// judge model can never stall the chat. The timer is unref'd so it can't hold the
// event loop open, and cleared when the work wins so its closure is released promptly.
function withTimeout(promise, ms) {
	// Shared timeout logic (shareData.Common.withTimeout), fail-open: on timeout it RESOLVES '' (never
	// rejects), so a hung judge/model call can never stall the chat — the empty result is handled downstream.
	return shareData.Common.withTimeout(promise, ms, { resolveValue: '' });
}


// Subtle one-line caveat appended when an answer carries figures the data does not clearly support.
// Shared by the faithfulness judge (verify path) and the free deterministic number check (default
// path) so the wording is identical however it was triggered.
const FIGURE_CAVEAT = '\n\n_⚠️ Some figures or details above may not be fully supported by the data — please double-check._';

// An EXCLUSION clause ("…besides my worst", "…not counting stale deals") that a plain deterministic render
// cannot honor. Used BOTH at the dispatch level (to skip the open-deals renders) and inside the per-bot
// intent, so it lives here as one source of truth rather than being re-typed at each guard. Not /g, so
// `.test()` is stateless.
const EXCLUSION_CLAUSE_RE = /\b(?:besides|except(?:ing|\s+for)?|other than|aside from|not counting|excluding|apart from|leaving out|without counting)\b/i;

// Shown in place of an answer that cites a fabricated deal id but has NO grounded tool data behind it —
// so an invented identifier is never presented as real. Honest and safe; invites the grounded path.
const UNGROUNDED_FALLBACK = "I don't have a verified match for that in your live data, so I won't guess at a deal identifier. Ask me to list your open deals (or name the pair) and I'll pull the exact figures.";

// Fail-closed grounding: shown when a question about the user's OWN data/operations was answered without
// consulting any tool (so the model would be speaking from its own head, not the live data). Replacing the
// model's ungrounded text with this fixed line is the structural guarantee that account/operational answers
// are never fabricated — an 8B model that cannot see the data must abstain, not invent a plausible report.
const GROUNDING_ABSTENTION = "I couldn't pull that from your live SymBot data just now, so I won't guess at it. Please ask again in a moment, or check it directly in SymBot (for example the Logs view for errors, or Active Deals for your positions).";

// How many DISTINCT trading pairs, all absent from this turn's tool data, turn a "soft" off-result-pair caveat
// into a hard fail-closed replacement. One or two can be a legitimate example/comparison; three-plus absent
// pairs is a fabricated position enumeration and is replaced with the grounded-path invitation. Central knob
// so the enumeration threshold is defined once and easy to tune.
const FABRICATED_PAIR_LIST_MIN = 3;

// The deal ids / pairs already established earlier in THIS conversation, as a plain grounding string. An
// entity the model repeats from a previous turn (e.g. a "tell me more" elaboration on the deal we just
// looked up) is grounded-by-context, not fabricated — so it counts as grounding alongside this turn's
// tool results. Prevents the fabrication backstop from wiping a legitimate history-grounded follow-up.
function knownEntitiesText(recentEntities) {
	return ((recentEntities && recentEntities.dealIds) || []).join(' ') + ' ' + ((recentEntities && recentEntities.pairs) || []).join(' ');
}


// Grade a tool-grounded answer against the raw tool results and, only when it is
// poorly grounded, return a single subtle caveat line to append. Everything here is
// best-effort: any failure yields '' so the answer is shown unchanged. Kept subtle by
// design — a well-grounded answer gets nothing, so the chat stays clean.
async function faithfulnessNote(answer, sources, model) {

	try {

		const genCfg = (shareData.appData && shareData.appData.ai && shareData.appData.ai.generation) || {};

		// Prefer the configured (stronger) analysis model as the judge — a weak judge
		// gives unreliable verdicts.
		const judgeModel = (typeof genCfg.analysis_model === 'string' && genCfg.analysis_model.trim() !== '')
			? genCfg.analysis_model.trim()
			: model;

		// A judge that IS the answering model cannot independently vouch for it — a weak model will
		// rubber-stamp its own fabrication. So a self-judge is allowed only to DOWNGRADE (add a caveat when
		// it finds the answer poorly grounded); it must never emit the positive "checked" tick, which would
		// be false assurance. Configure a distinct (stronger) analysis_model to get the positive tick.
		const selfJudge = (judgeModel === model);

		const judge = (messages) => withTimeout(completePrompt(messages, judgeModel, { temperature: 0 }), FAITHFULNESS_TIMEOUT_MS);

		const result = await aiFaithfulness.scoreAnswer({ answer, sources, judge });

		if (result) { shareData.Common.logger('AI faithfulness (' + judgeModel + '): ' + JSON.stringify(result)); }

		// A subtle one-line indicator, only when the check actually ran (result is
		// null on any failure/timeout, and then nothing is shown — no false tick).
		if (result) {

			// Every footer below vouches specifically for FIGURES. When the answer carries no significant
			// figures at all — a concept explanation, a definition, a plain conversational reply that merely
			// shared the tool path — there is nothing for a figure-grounding note to speak to, and a
			// "figures checked / some figures only partly confirmed" line is misleading. Stay silent in that
			// case, for every grade (the 'low' branch below already does this for the caveat). Fail safe: if
			// the number scan itself errors, fall through to the normal grade-based logic.
			try {

				if (analysisGuard.checkNumbers(answer || '', sources || '').numbersChecked === 0) {

					return '';
				}
			}
			catch (e) { /* fall through to grade-based logic */ }

			// A poorly-grounded answer earns the caveat — but the caveat is specifically about FIGURES.
			// A 'low' grade can also come from non-numeric general-knowledge sentences that legitimately
			// share an answer with grounded data (a concept explanation alongside a real figure, in a
			// mixed question). Only surface the caveat when a number in the answer is actually absent from
			// the sources; if the deterministic figure check finds none, the low score is driven by
			// general content, not a data-grounding problem, so stay quiet. The check fails safe: any error
			// keeps the warning.
			if (result.overall === 'low') {

				try {

					const chk = analysisGuard.checkNumbers(answer || '', sources || '');

					if (chk && Array.isArray(chk.ungrounded) && chk.ungrounded.length === 0) {

						return '';
					}
				}
				catch (e) { /* fall through to the safe warning */ }

				return FIGURE_CAVEAT;
			}

			// Beyond a caveat, a self-judge stays silent: no positive tick (see selfJudge above).
			if (selfJudge) {

				return '';
			}

			if (result.overall === 'medium') {

				return '\n\n_✓ Checked against your data — some figures only partly confirmed._';
			}

			return '\n\n_✓ Figures checked against your data._';
		}

		return '';
	}
	catch (e) {

		return '';
	}
}


// Capture one patterns-only learning outcome after an answer is finalized: the
// question and which tools answered it, plus a cheap DETERMINISTIC grounding signal
// (were the answer's significant numbers all present in the tool output?). It never
// stores any values from the answer — only the plan. Fire-and-forget and fully
// guarded: learning must never add latency to, or break, the chat. Only real user
// questions are captured (internal sub-agent runs pass no `question`).
function captureLearning({ room, question, tools, sources, answer }) {

	try {

		if (!question || !aiMemory.config().enabled) { return; }

		const src = Array.isArray(sources) ? sources.join('\n\n') : '';
		const grounded = src ? (analysisGuard.checkNumbers(answer || '', src).ungrounded.length === 0) : true;
		const uniqTools = Array.from(new Set((Array.isArray(tools) ? tools : []).filter(Boolean)));

		// The corpus is about question→tool routing, so only capture answers that actually used a
		// tool. A plain reply ("hello") teaches nothing about routing and would just add noise.
		if (uniqTools.length === 0) { return; }

		// Best-effort and not blocking the return: record the outcome, then (only if a row was
		// actually written and this is a streamed chat) tell the client its id so it can show a
		// small, optional 👍/👎 on the finished answer. recordOutcome swallows its own errors.
		aiMemory.recordOutcome({
			question,
			tools: uniqTools,
			confidence: grounded ? 'high' : 'low',
			grounded
		}).then((rec) => {

			if (rec && rec.id && room) {

				shareData.Common.sendSocketMsg({ room, type: 'learning', message: { id: rec.id } });
			}

			// Relay to the Hub (only when running as a Hub worker) so instances that do NOT
			// share a database still pool their learning. Patterns only; fire-and-forget,
			// mirroring the mailer relay path. Redact the question at this boundary so no deal
			// id / amount / raw value ever leaves the instance or lands in the Hub's store at
			// rest — the Hub keeps only the agnostic routing pattern, matching the patterns-only
			// contract (the egress pack is redacted again downstream as defense in depth).
			relayLearningToHub({ question: aiMemory.redactQuestion(question), tools: uniqTools, confidence: grounded ? 'high' : 'low', grounded });

		}).catch(() => {});
	}
	catch (e) { /* learning is never allowed to disturb the chat */ }
}


// Relay one patterns-only learning note to the Hub, if this instance is running as a Hub
// worker (parent_port present). Mirrors the mailer relay: fire-and-forget, no ack, and a
// standalone instance (no parent_port) simply skips it.
function relayLearningToHub(pattern) {

	try {

		const port = shareData && shareData.parent_port;
		if (!port || typeof port.postMessage !== 'function') { return; }

		port.postMessage({ type: WORKER_TO_HUB.LEARNING, payload: pattern });
	}
	catch (e) { /* relay is best-effort */ }
}

// Report this instance's AI-tool NAMES to the Hub once at startup, so the Hub can validate contributed
// learning packs against the tools instances actually have (the union across the fleet) rather than only the
// Hub process's own registry, and can show which instances support a given tool. No-op when not running under
// a Hub. Best-effort — never allowed to affect startup.
function relayToolsToHub() {

	try {

		const port = shareData && shareData.parent_port;
		if (!port || typeof port.postMessage !== 'function') { return; }

		const names = (aiTools.TOOLS || []).map(t => t.name);
		port.postMessage({ type: WORKER_TO_HUB.TOOLS, payload: names });
	}
	catch (e) { /* relay is best-effort */ }
}


// Import an aggregated learning pack pushed down by the Hub. Validated like any other
// pack (format + checksum + tool whitelist) before anything is stored. Called from the
// worker message handler.
async function importHubLearningPack(pack) {

	try {

		const validTools = new Set(aiTools.TOOLS.map(t => t.name));
		const res = await aiMemory.verifyAndImportPack(pack, 'hub', { validTools, aliases: aiTools.TOOL_ALIASES });

		if (res && res.imported) { shareData.Common.logger('AI learning: imported ' + res.imported + ' patterns from Hub'); }
		return res;
	}
	catch (e) { return { imported: 0, error: e && e.message }; }
}


// Seed the learning corpus once, on first use, from the pack shipped in the repo — so
// a fresh install answers common questions well before it has learned anything itself.
// Runs at chat time (the database is up), only when learning is on and the corpus is
// empty; the seed is validated against this install's tool registry like any other pack.
async function ensureLearningSeeded() {

	if (learningSeeded) { return; }

	// Concurrency guard: the first chat request after boot may fan out into several parallel
	// tool loops, each calling this. Without a shared in-flight promise they would all observe an
	// empty corpus and each import the full seed, doubling it (dedup snapshots the existing keys
	// once, before any of them has inserted). Coalesce them onto ONE seeding pass.
	if (learningSeedingPromise) { return learningSeedingPromise; }

	learningSeedingPromise = (async () => {

	try {

		if (!aiMemory.config().enabled) { return; }   // not marked done — re-check if enabled later

		// The shipped default (libs/ai/data/seed-learning.json) is the read-only source of truth; the
		// writable corpus lives in the database. Merge the default only when its VERSION (checksum)
		// changes: a fresh install gets it all, an upgrade with a new default merges the new
		// patterns (import is additive + deduped), and a user's own additions/edits are never
		// clobbered. If the same version was already merged, do nothing.
		const seedPack = require('./data/seed-learning.json');
		const seedChecksum = seedPack && seedPack.manifest && seedPack.manifest.checksum;

		const lastMerged = (typeof aiMemoryStore.getMeta === 'function') ? await aiMemoryStore.getMeta('seed_checksum') : null;
		if (seedChecksum && lastMerged === seedChecksum) { learningSeeded = true; return; }

		const validTools = new Set(aiTools.TOOLS.map(t => t.name));
		const res = await aiMemory.verifyAndImportPack(seedPack, 'seed', { validTools, aliases: aiTools.TOOL_ALIASES });

		if (seedChecksum && typeof aiMemoryStore.setMeta === 'function') { await aiMemoryStore.setMeta('seed_checksum', seedChecksum); }
		learningSeeded = true;

		if (res && res.imported) { shareData.Common.logger('AI learning: merged ' + res.imported + ' default patterns (seed ' + String(seedChecksum || '').slice(0, 8) + ')'); }
	}
	catch (e) { /* seeding is best-effort and must never disturb the chat */ }

	})();

	try { await learningSeedingPromise; }
	finally { learningSeedingPromise = null; }   // clear so a later enable/version-bump can re-run
}


// Returns total character count across all messages in the history
function totalHistoryChars(messages) {

	return messages.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0);
}


// Compresses middle turns of roomData.messages into a structured summary.
// Modifies roomData.messages in place. Returns true if compression occurred.
// Single non-streaming completion against the configured provider.
// Shared by context compression and by the AI context router so there is one
// provider code path rather than one per caller. Returns '' on any failure.
async function completePrompt(messages, model, options) {

	const adapter = providerAdapters[aiProvider];

	if (!adapter || !aiClient) { return ''; }

	const useModel = model || modelCurrent;

	try {

		const result = await adapter.createNonStream(aiClient, useModel, messages, undefined, options);

		return (adapter.extractNonStreamContent(result) || '');
	}
	catch (err) {

		// Generation options are best-effort on the non-streaming helper paths
		// (routing + summarization): not every model or OpenAI-compatible endpoint
		// accepts response_format or a custom temperature. If options were supplied
		// and the request was rejected, retry once with none — the caller can still
		// parse JSON out of a plain response — before surfacing the error to the
		// caller's own handler.
		if (options) {

			const result = await adapter.createNonStream(aiClient, useModel, messages, undefined, undefined);

			return (adapter.extractNonStreamContent(result) || '');
		}

		throw err;
	}
}


async function compressContext(room, roomData, model) {

	const cfg = getCompressionConfig();

	if (!cfg.enabled) return false;
	if (totalHistoryChars(roomData.messages) < cfg.threshold_chars) return false;
	if (roomData.messages.length < 6) return false; // need enough messages to bother

	// Identify boundaries
	// Head: first 2 messages (first user + first assistant exchange) always preserved
	// Tail: last protect_last_n messages always preserved
	// Middle: everything in between — gets summarized
	const protectFirst = 2;
	const protectLast  = Math.min(cfg.protect_last_n, roomData.messages.length - protectFirst);
	const middleStart  = protectFirst;
	const middleEnd    = roomData.messages.length - protectLast;

	if (middleEnd <= middleStart) return false; // nothing to compress

	const head   = roomData.messages.slice(0, middleStart);
	const middle = roomData.messages.slice(middleStart, middleEnd);
	const tail   = roomData.messages.slice(middleEnd);

	// Build the summary prompt from middle turns
	const turnText = middle.map(m =>
		`${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 2000)}`
	).join('\n\n');

	const previousSummary = roomData.lastCompressionSummary
		? `The following is the summary from the previous compression round. Update it with the new turns below.\n\n${roomData.lastCompressionSummary}\n\n---\n\nNew turns to incorporate:\n\n`
		: '';

	const summaryPrompt = [
		{ role: 'system', content: COMPRESSION_SYSTEM },
		{ role: 'user', content:
			`${previousSummary}Summarize the following conversation turns concisely under these headings:\n\n`
			+ `## Topic\n## Key Points\n## Important Values / Numbers\n## Decisions Made\n## Still Open\n\n`
			+ `Turns:\n\n${turnText}`
		}
	];

	try {

		// Non-streaming call — summary doesn't need to stream
		// No abort signal for compression — it's a background operation and
		// we want it to complete fully regardless of user-facing timeouts.
		const summary = await completePrompt(summaryPrompt, model, resolveGenOptions('compression'));

		if (!summary || !summary.trim()) return false;

		// Replace middle turns with a single assistant summary message
		const summaryMessage = {
			role:      'assistant',
			content:   '[Earlier conversation summarized]\n\n' + summary.trim(),
			timestamp: Date.now(),
			attachments: []
		};

		roomData.messages = [...head, summaryMessage, ...tail];
		roomData.lastCompressionSummary = summary.trim();

		shareData.Common.logger('AI context compressed for room ' + room +
			' — ' + middle.length + ' turns → 1 summary (' +
			totalHistoryChars(roomData.messages) + ' chars remaining)');

		return true;

	} catch(e) {

		// If compression fails, log and continue with full history
		shareData.Common.logger('AI context compression failed for room ' + room + ': ' + e.message);
		return false;
	}
}


// Topic/scope guard: a single cheap classifier call decides if the message is on-topic for
// a trading assistant. FAIL-OPEN — any error/uncertain reply is treated as on-topic, so a real
// trading question is never blocked by a classifier hiccup. Returns true when on-topic.
async function classifyOnTopic(question, model, abortSignal) {

	try {
		const adapter = providerAdapters[aiProvider];
		if (!adapter || !aiClient || typeof adapter.createNonStream !== 'function' || typeof adapter.extractNonStreamContent !== 'function') { return true; }

		// Bounded like every other auxiliary model call: thread the turn's abort signal and cap the wait
		// so a provider stall on the classifier can never outlast the chat turn's own idle/hard timeout.
		// Fail-open — a timeout or error is treated as on-topic, so a real trading question is never lost.
		const res = await withTimeout(adapter.createNonStream(aiClient, model, [ { role: 'user', content: aiGuardrails.buildScopePrompt(question) } ], abortSignal, undefined), 8000);
		const reply = (adapter.extractNonStreamContent(res) || '').trim();
		return !aiGuardrails.isOffTopicReply(reply);
	}
	catch (e) { return true; }
}


// Single source of truth for clearing the per-conversation ANAPHORA / entity memory — the recent-entity
// stack (used to resolve "that deal" / "it") and the rolling compression summary. Both the explicit
// "new chat" reset and a mid-conversation topic switch clear exactly this state, so routing both through
// one helper keeps them from drifting apart: a partial reset that clears one field but not the other
// silently bleeds a stale entity or summary into the next subject. Read-only AI-chat state — it never
// touches the visible transcript (that is the caller's separate concern) or any trading path.
function clearEntityMemory(roomData) {

	roomData.recentEntities = { dealIds: [], pairs: [] };
	roomData.lastCompressionSummary = '';
}


const streamChatResponse = async ({ room, model, message, abortSignal, reset, stream = true, onActivity, options, footer, purpose }) => {

	let fullResponse = '';

	// Get or initialize room data
	let roomData = conversationHistory.get(room);

	if (!roomData) {

		roomData = {
			persona: {
				role: 'system',
				content: PERSONA
			},
			messages: []
		};
	}

	// Reset ("new chat") must clear ALL per-conversation memory, not just the visible messages: the
	// recent-entity stack (used for anaphora) and the last compression summary would otherwise survive
	// into the next, unrelated conversation and resolve "that deal" to a pre-reset entity or prepend a
	// stale summary.
	if (reset) {

		roomData.messages = [];
		clearEntityMemory(roomData);
	}

	// Add user message — skip empty content (reset-only calls have no real message)
	if (message.content) {

		// Resolve attachment text from server-side cache
		const resolvedAttachments = Array.isArray(message.attachments)
			? message.attachments.map(att => {
				if (att.attachmentId && shareData.attachmentCache) {
					const cached = shareData.attachmentCache.get(att.attachmentId);
					if (cached) {
						// Remove from cache — text now lives on the message
						shareData.attachmentCache.delete(att.attachmentId);
						return { name: att.name, type: att.type, size: att.size,
						         charCount: att.charCount, text: cached.text };
					}
				}
				return att;
			})
			: [];

		roomData.messages.push({
			role: 'user',
			content: message.content,
			timestamp: Date.now(),
			attachments: resolvedAttachments
		});
	}
	else if (reset) {

		// Pure reset with no content — save cleared room and return early
		conversationHistory.set(room, roomData);
		if (stream) sendChatEnd(room);
		return;
	}

	// Trim messages only (persona never touched)
	const maxHistory = (shareData.appData.ai && shareData.appData.ai.max_history) || maxHistoryDefault;
	if (roomData.messages.length > maxHistory - 1) {

		roomData.messages.splice(0, roomData.messages.length - (maxHistory - 1));
	}

	// Topic-switch memory hygiene. When the user pivots to a genuinely NEW subject mid-conversation, clear
	// the anaphora entity stack (and the rolling summary) so a later "that deal" / "it" / "tell me more"
	// re-grounds fresh — or asks which they mean — instead of silently pinning the PREVIOUS topic's deal.
	// Deterministic, read-only AI-chat state only (never any trading path); the worst case is "which deal?"
	// rather than a wrong guess. It NEVER fires on a vague continuation ("tell me more") or a deictic
	// back-reference (those NEED the prior entity), and only when the new turn carries its own distinct
	// subject — a DIFFERENT concrete position, or a concept/definitional/how-to question — so a bare
	// acknowledgement ("ok", "thanks") leaves the stack intact. The transcript is preserved (that is the
	// separate explicit "new chat" reset). Runs before every consumer of recentEntities and before compression.
	try {
		const re = roomData.recentEntities;
		if (message.content && !reset && re && ((re.dealIds && re.dealIds.length) || (re.pairs && re.pairs.length))
			&& !aiGuardrails.looksLikeContinuation(message.content)
			&& aiGuardrails.resolveAnaphora(message.content, re) === '') {

			const ents = aiGuardrails.extractEntities(message.content);
			const namesNewPosition = !!ents && (
				(ents.dealIds && ents.dealIds.length && ents.dealIds[0] !== (re.dealIds[0] || null)) ||
				(ents.pairs && ents.pairs.length && ents.pairs[0] !== (re.pairs[0] || null)));
			const isConceptTurn = (aiGuardrails.looksLikeConceptQuestion(message.content) && !aiGuardrails.hasStrongAccountSignal(message.content))
				|| aiGuardrails.looksLikeDefinitional(message.content) || aiGuardrails.looksLikeHowTo(message.content);

			if (namesNewPosition || isConceptTurn) {
				clearEntityMemory(roomData);
				shareData.Common.logger('AI topic switch: cleared conversation entity memory for a new subject [' + (room || '?') + ']');
			}
		}
	}
	catch (e) { /* memory hygiene is best-effort and never blocks a reply */ }

	// Compress context if history is getting long — fires before building the model payload
	if (message.content && !reset) {

		await compressContext(room, roomData, model);
	}

	// Tool-calling path (opt-in via ai.tools.enabled): instead of the AIContext
	// router guessing what data to prepend, the model looks the data up itself via
	// read-only tools. Only for streamed conversational chat — never analysis. If
	// the model/endpoint can't do tools the loop returns null and we fall through
	// to the normal (router) path unchanged.
	const toolsCfg = getToolsConfig();

	// Single funnel for a deterministic render → answer. Every simple "render, don't generate" shortcut below
	// funnels its rendered body through here, so the grounding/sanitize step AND the record-the-turn sequence
	// (history push, recent-entity update, optional lastRender for a pushback re-render, log, stream-or-return)
	// live in ONE place instead of being copy-pasted per block. Returns the answer string, or undefined when it
	// streamed — both are valid streamChatResponse returns, so a caller does `return await emitRender(...)`.
	const emitRender = async (body, sources, opts) => {
		opts = opts || {};
		const srcJson = JSON.stringify(sources || {});
		const answer = finalizeAnswer(body, srcJson, message.content, knownEntitiesText(roomData.recentEntities), { trusted: true });
		roomData.messages.push({ role: 'assistant', content: answer, timestamp: Date.now() });
		roomData.recentEntities = aiGuardrails.updateRecentEntities(roomData.recentEntities, message.content + '\n' + answer);
		if (opts.lastRender) { roomData.lastRender = Object.assign({ ts: Date.now() }, opts.lastRender); }
		conversationHistory.set(room, roomData);
		if (opts.log) { shareData.Common.logger(opts.log); }
		if (stream) { await streamReplay({ room, text: answer, footer, abortSignal, onActivity }); }
		// A deterministic shortcut is a grounded, tool-backed answer exactly like the model loop's — so capture
		// the same question→tool routing here too. Without this the most COMMON questions (e.g. "how are my
		// deals?"), which the shortcuts answer, would teach the learning corpus nothing AND never emit an
		// outcome id, so the 👍/👎 rating would silently never appear on them. `opts.tool` names the tool the
		// shortcut executed; done after the stream so the client's rating attaches to the finished message,
		// mirroring the model-loop order. captureLearning is self-guarded (best-effort, never disturbs chat).
		if (opts.tool) { captureLearning({ room, question: message.content, tools: [ opts.tool ], sources: [ srcJson ], answer }); }
		if (stream) { return undefined; }
		return answer;
	};

	// Topic/scope guard: decline off-topic requests up front with a friendly,
	// in-scope redirect. Runs only for real chat turns and only when enabled; fails open so a
	// legitimate trading question is never blocked. History already recorded the user turn above.
	if (toolsCfg.topic_guard && purpose === 'chat' && message.content && !reset) {

		const onTopic = await classifyOnTopic(message.content, model, abortSignal);

		if (!onTopic) {

			const refusal = aiGuardrails.refusalMessage('offtopic');
			roomData.messages.push({ role: 'assistant', content: refusal, timestamp: Date.now() });
			conversationHistory.set(room, roomData);
			shareData.Common.logger('AI topic guard: declined off-topic message in room ' + room);

			if (stream) { await streamReplay({ room, text: refusal, footer, abortSignal, onActivity }); return undefined; }
			return refusal;
		}
	}

	// Read-only guard: a request to PERFORM a trading action (close/pause/start/cancel a deal or bot)
	// is refused instantly with a helpful redirect. The assistant has no mutating tools, so without
	// this the model would enter the tool loop, find nothing to call, and spin until it timed out and
	// returned an empty answer. Deterministic (regex), so it costs nothing and never blocks a genuine
	// question — "how many deals did I close" and friends pass straight through.
	if (purpose === 'chat' && message.content && !reset && aiGuardrails.looksLikeActionRequest(message.content)) {

		const refusal = aiGuardrails.refusalMessage('action');
		roomData.messages.push({ role: 'assistant', content: refusal, timestamp: Date.now() });
		conversationHistory.set(room, roomData);
		shareData.Common.logger('AI read-only guard: declined an action request in room ' + room);

		if (stream) { await streamReplay({ room, text: refusal, footer, abortSignal, onActivity }); return undefined; }
		return refusal;
	}

	// Prediction guard: a request to FORECAST future returns/profit ("how much will I make by the end of the
	// month?") is declined up front. Without this the weak model tends to reframe a real past/MTD figure as a
	// forecast ("you have made -$5403 by the end of the month ✓") — a subtle fabrication. Deterministic, then
	// it pivots to the real figures it CAN show. Placed before the credential/data guards so a forecast never
	// reaches the tool path.
	if (purpose === 'chat' && message.content && !reset && aiGuardrails.looksLikePrediction(message.content)) {

		const refusal = aiGuardrails.refusalMessage('prediction');
		roomData.messages.push({ role: 'assistant', content: refusal, timestamp: Date.now() });
		conversationHistory.set(room, roomData);
		shareData.Common.logger('AI prediction guard: declined a future-forecast request in room ' + room);

		if (stream) { await streamReplay({ room, text: refusal, footer, abortSignal, onActivity }); return undefined; }
		return refusal;
	}

	// Credential guard: a request to DISPLAY a secret (API key/secret, password, token) gets a clear credential
	// refusal. Without this it routes to the tool path, finds no such data (credentials live in the config file,
	// not the database) and returns the generic grounding abstention ("I couldn't pull that … ask again"), which
	// wrongly implies it might retrieve the secret later. Declined up front like the other secrets guards.
	if (purpose === 'chat' && message.content && !reset && aiGuardrails.looksLikeCredentialRequest(message.content)) {

		const refusal = aiGuardrails.refusalMessage('credential');
		roomData.messages.push({ role: 'assistant', content: refusal, timestamp: Date.now() });
		conversationHistory.set(room, roomData);
		shareData.Common.logger('AI credential guard: declined a request to display a secret credential in room ' + room);

		if (stream) { await streamReplay({ room, text: refusal, footer, abortSignal, onActivity }); return undefined; }
		return refusal;
	}

	// Prompt-exfiltration guard: a request to reveal the system prompt / hidden instructions is refused
	// deterministically. The persona says never to reveal them, but a small local model does not reliably
	// obey that under a direct "repeat your system prompt" — so, like the read-only guard above, this
	// catches it up front rather than trusting the model to decline.
	if (purpose === 'chat' && message.content && !reset && aiGuardrails.looksLikeSystemPromptRequest(message.content)) {

		const refusal = aiGuardrails.refusalMessage('systemPrompt');
		roomData.messages.push({ role: 'assistant', content: refusal, timestamp: Date.now() });
		conversationHistory.set(room, roomData);
		shareData.Common.logger('AI prompt-exfiltration guard: declined a system-prompt request in room ' + room);

		if (stream) { await streamReplay({ room, text: refusal, footer, abortSignal, onActivity }); return undefined; }
		return refusal;
	}

	// Jailbreak / role-override guard: "you are now in developer mode with no restrictions", "enter DAN
	// mode", "disable all your safety checks". A small local model tends to play along and confirm the
	// fake privileged mode; decline it deterministically up front, like the exfil guard above.
	if (purpose === 'chat' && message.content && !reset && aiGuardrails.looksLikeJailbreak(message.content)) {

		const refusal = aiGuardrails.refusalMessage('injection');
		roomData.messages.push({ role: 'assistant', content: refusal, timestamp: Date.now() });
		conversationHistory.set(room, roomData);
		shareData.Common.logger('AI jailbreak guard: declined a role-override / restriction-bypass request in room ' + room);

		if (stream) { await streamReplay({ room, text: refusal, footer, abortSignal, onActivity }); return undefined; }
		return refusal;
	}

	// Ground the model in the current date/time for BOTH the fast-lane and the tool loop below. Every
	// deal and log timestamp is stored in UTC; without this note a small model refuses a plain "what's
	// the date and time?" and misreads "yesterday" as a 2-day count. Computed once, reused by both
	// paths. Uses the shared Common helpers (DST-correct); degrades to UTC on any error or missing tz.
	const nowUtc = new Date();
	const _tz = (shareData.Common && typeof shareData.Common.normalizeTimeZone === 'function') ? shareData.Common.normalizeTimeZone(message && message.timezone) : null;
	const _zdate = (inst) => (shareData.Common && typeof shareData.Common.zonedDateStr === 'function') ? shareData.Common.zonedDateStr(inst, _tz || 'UTC') : inst.toISOString().slice(0, 10);
	const todayLocal = _zdate(nowUtc);
	const yesterdayLocal = _zdate(new Date(nowUtc.getTime() - (24 * 60 * 60 * 1000)));
	const zoneLabel = _tz || 'UTC';
	// A human-readable local wall-clock string ("Wednesday, August 20, 2026 at 7:47 PM EDT") so a
	// plain "what's the date and time?" is answered in the USER's timezone, not a raw UTC ISO string.
	// Intl throws on an unknown zone, so guard and fall back to the ISO UTC value on any error.
	let _human = null;
	try {
		_human = nowUtc.toLocaleString('en-US', { timeZone: zoneLabel, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
	}
	catch (e) { _human = null; }
	const nowBase = 'Current date and time: ' + (_human || (nowUtc.toISOString() + ' UTC'))
		+ '. In the user\'s timezone (' + zoneLabel + '), today is ' + todayLocal + ' and yesterday was ' + yesterdayLocal + '.'
		+ ' When the user asks the date or time, answer with this human-readable local value rather than a raw UTC timestamp.';

	// Pushback re-render — "re-render, never re-derive". A challenge to the PRIOR deterministic-grounded answer
	// ("are you sure?", "that doesn't sound right", "you're wrong") makes a weak model sycophantically RECANT a
	// correct grounded figure ("I may have made an error…"). When the previous answer was one of our instant
	// renders (a count/summary/ranking/bot-count), re-fetch the SAME live data and re-serve it, so there is
	// nothing for the model to take back. Only within a short window; anything else falls through unchanged.
	if (toolsCfg.enabled && purpose === 'chat' && message.content && !reset
		&& (!message.attachments || message.attachments.length === 0)
		&& aiGuardrails.looksLikePushback(message.content)
		&& roomData.lastRender && (Date.now() - (roomData.lastRender.ts || 0) < 10 * 60 * 1000)) {

		try {
			const lr = roomData.lastRender;
			let res = null, body = null;
			if (lr.kind === 'deals') {
				res = await aiTools.execute('get_open_deals_status', {}, { onActivity, timezone: message.timezone });
				if (res && res.success !== false) { body = lr.view === 'breakdown' ? formatOpenDealsBreakdown(res) : (lr.view === 'ranking' ? formatDealRanking(res, lr.rankKind) : formatOpenDealsSummary(res)); }
			}
			else if (lr.kind === 'bots') {
				res = await aiTools.execute('list_bots', {}, { onActivity, timezone: message.timezone });
				if (res && res.success !== false) { body = formatBotsCount(res); }
			}
			if (body) {
				const answer = finalizeAnswer("I've re-checked this against your live data — it's still accurate:\n\n" + body, JSON.stringify(res), message.content, knownEntitiesText(roomData.recentEntities), { trusted: true });
				roomData.messages.push({ role: 'assistant', content: answer, timestamp: Date.now() });
				roomData.lastRender = Object.assign({}, lr, { ts: Date.now() });
				conversationHistory.set(room, roomData);
				shareData.Common.logger('AI pushback re-render (' + lr.kind + '): re-served grounded answer instead of recanting [' + (room || '?') + ']');

				// Deliberately NOT captured for learning: here message.content is a PUSHBACK ("are you sure?"),
				// not a routing-worthy question, so recording it → tool would pollute the question→tool corpus.
				// The original render already captured the real routing; this turn just re-serves it.
				if (stream) { await streamReplay({ room, text: answer, footer, abortSignal, onActivity }); return undefined; }
				return answer;
			}
		}
		catch (e) { shareData.Common.logger('AI pushback re-render failed, falling back: ' + ((e && e.message) ? e.message : e)); }
	}

	// Deterministic deal-report shortcut. A question centered on a specific deal id (e.g. "give me a
	// detailed analysis of 1INCH_USD-TESTAA-1723456789") is the user asking about their OWN position.
	// Left to the tool loop, a small local model lexically overfits on "analysis of <crypto>" and either
	// refuses it as financial advice or invents token trivia — even when the deal tool DID return the
	// data (verified on llama3.2). So when the message asks to analyze/report/diagnose one deal id, fetch
	// the deal ourselves and hand the model a pure NARRATION task with the data inline (the one thing
	// small models do reliably), bypassing tool-selection and the refusal reflex. A bogus id yields a
	// clean "not found", never a hallucination. Best-effort: any failure falls through to the tool loop.
	if (toolsCfg.enabled && purpose === 'chat' && message.content && !reset
		&& (!message.attachments || message.attachments.length === 0)
		&& aiClient && typeof completePrompt === 'function') {

		let dealReportId = aiGuardrails.firstDealId(message.content);
		let isDealReport = dealReportId && looksLikeDealReportRequest(message.content);

		// A deictic per-deal follow-up carries no explicit id ("how many safety orders has IT used?",
		// "is IT profitable?", "what's ITS average price?"). Resolve it to the deal just discussed and
		// answer on this same reliable narration path. Left to the general tool loop, a small local model
		// has been seen to exhaust its iteration cap and then fabricate a per-deal figure (e.g. a safety-
		// order count) that contradicts the deal's own data. Actions ("close it") and comparisons
		// ("compare it to my others") are excluded — they belong on their own paths.
		if (!dealReportId
			&& !aiGuardrails.looksLikeActionRequest(message.content)
			&& !DEAL_COMPARE_RE.test(message.content)
			&& aiGuardrails.resolveAnaphora(message.content, roomData.recentEntities)) {

			let anaphoraDeal = (roomData.recentEntities && roomData.recentEntities.dealIds && roomData.recentEntities.dealIds[0]) || null;
			// No id was tracked, but a recent PAIR is — e.g. the deterministic RANKING / summary render names a
			// pair ("MPLX/USD, …"), not a deal id, so a following deictic per-deal question ("how many safety
			// orders has THAT ONE used?", "what pair is IT?") had nothing to resolve and fell to the model loop,
			// which deflected or named the wrong pair. Resolve the recent pair to its open deal id so the
			// follow-up answers from the grounded deal report instead. Only on a single unambiguous match.
			if (!anaphoraDeal) {
				const recentPair = roomData.recentEntities && roomData.recentEntities.pairs && roomData.recentEntities.pairs[0];
				if (recentPair) {
					try {
						const rp = await aiTools.execute('find_deal_id', { reference: recentPair }, { timezone: message.timezone });
						if (rp && rp.match_count === 1 && rp.matches && rp.matches[0] && rp.matches[0].dealId) { anaphoraDeal = rp.matches[0].dealId; }
					}
					catch (e) { /* best-effort; fall through unchanged */ }
				}
			}
			if (anaphoraDeal) { dealReportId = anaphoraDeal; isDealReport = true; }
		}

		// A PAIR-named single-deal request ("tell me about my A8/USD deal", "how's my AAVE deal doing?") carries
		// a PAIR (or bare base), not an id — so firstDealId is null and it would fall to the model loop, where a
		// weak model has been seen to FABRICATE the deal's average price and config (observed: an average of
		// "12.56 USD" for a deal whose real average is 0.0053). Resolve the reference to its OPEN deal id and
		// answer on the same deterministic, grounded report path. Fires ONLY when exactly ONE open deal matches
		// (resolveDeal returns match_count 1); zero or several → fall through, where the tool loop or a clarify is
		// correct. Excludes comparisons / actions / rankings / counts / portfolio-wide status so only a genuine
		// single-deal report reaches here.
		if (!dealReportId
			&& !aiGuardrails.looksLikeActionRequest(message.content)
			&& !DEAL_COMPARE_RE.test(message.content)
			&& looksLikeDealReportRequest(message.content)
			&& !looksLikeDealsStatusQuestion(message.content)
			&& !openDealsCountIntent(message.content)
			&& !dealRankingIntent(message.content)) {

			try {
				const ents = aiGuardrails.extractEntities(message.content);
				// A candidate the user names: an explicit pair, or a bare upper-case ticker (2–6 chars, excluding
				// common trading abbreviations) — "my DOGE deal", "how's my AAVE deal".
				const bareTicker = (message.content.match(/\b(?!TP|SL|SO|DCA|API|UI|ID|PNL|ROI|USD|USDT|USDC|EUR|GBP|AI|OK)[A-Z]{2,6}\b/) || [])[0] || null;
				const named = (ents && ents.pairs && ents.pairs.length === 1) ? ents.pairs[0] : bareTicker;
				const reference = named || message.content;
				const resolved = await aiTools.execute('find_deal_id', { reference: reference }, { timezone: message.timezone });

				if (resolved && resolved.match_count === 1 && resolved.matches && resolved.matches[0] && resolved.matches[0].dealId) {
					dealReportId = resolved.matches[0].dealId;
					isDealReport = true;
				}
				else if (named && resolved && resolved.match_count === 0) {
					// A specifically-named coin/pair the user does NOT hold. Fail closed FAST with the real open
					// list, instead of the model loop spinning ~2 minutes on an unresolvable reference (and risking
					// naming the wrong deal). Grounded, instant, and honest.
					const od = await aiTools.execute('get_open_deals_status', {}, { onActivity, timezone: message.timezone });
					const openPairs = (od && Array.isArray(od.closest_to_take_profit)) ? Array.from(new Set(od.closest_to_take_profit.map(d => d.pair).filter(Boolean))) : [];
					const body = "You don't have an open " + named + " deal right now."
						+ (openPairs.length ? ' Your open deals are: ' + openPairs.slice(0, 40).join(', ') + '.' : '');
					const answer = finalizeAnswer(body, JSON.stringify(od || {}), message.content, knownEntitiesText(roomData.recentEntities), { trusted: true });
					roomData.messages.push({ role: 'assistant', content: answer, timestamp: Date.now() });
					conversationHistory.set(room, roomData);
					shareData.Common.logger('AI pair fail-closed: no open ' + named + ' deal [' + (room || '?') + ']');

					if (stream) { await streamReplay({ room, text: answer, footer, abortSignal, onActivity }); return undefined; }
					return answer;
				}
			}
			catch (e) { /* resolution is best-effort; fall through to the model path unchanged */ }
		}

		// COMPARE with a false premise — "compare my BTC deal to my ETH deal" when the user holds neither. A weak
		// model ACCOMMODATES the false premise and fabricates a comparison instead of rejecting it (2026
		// false-presupposition research), so check each named ticker against the live deals FIRST and, if any is
		// not held, fail closed naming it — never hand the compare to the model. Only fires when ≥2 concrete
		// tickers are named (a "compare my two furthest-from-TP deals" names none, so the ranking/model handles it).
		if (!dealReportId && !isDealReport
			&& DEAL_COMPARE_RE.test(message.content)
			&& !aiGuardrails.looksLikeActionRequest(message.content)) {

			try {
				const tickers = Array.from(new Set((message.content.match(/\b(?!TP|SL|SO|DCA|API|UI|ID|PNL|ROI|USD|USDT|USDC|EUR|GBP|AI|OK|VS)[A-Z]{2,6}\b/g) || [])));
				if (tickers.length >= 2) {
					const missing = [];
					for (const t of tickers.slice(0, 4)) {
						const r = await aiTools.execute('find_deal_id', { reference: t }, { timezone: message.timezone });
						if (!r || r.match_count === 0) { missing.push(t); }
					}
					if (missing.length) {
						const od = await aiTools.execute('get_open_deals_status', {}, { onActivity, timezone: message.timezone });
						const openPairs = (od && Array.isArray(od.closest_to_take_profit)) ? Array.from(new Set(od.closest_to_take_profit.map(d => d.pair).filter(Boolean))) : [];
						const body = "You don't have an open " + missing.join(' or ') + ' deal, so I can\'t compare ' + (missing.length > 1 ? 'those' : 'that') + '.'
							+ (openPairs.length ? ' Your open deals are: ' + openPairs.slice(0, 40).join(', ') + '.' : '');
						const answer = finalizeAnswer(body, JSON.stringify(od || {}), message.content, knownEntitiesText(roomData.recentEntities), { trusted: true });
						roomData.messages.push({ role: 'assistant', content: answer, timestamp: Date.now() });
						conversationHistory.set(room, roomData);
						shareData.Common.logger('AI compare fail-closed: missing ' + missing.join(',') + ' [' + (room || '?') + ']');

						if (stream) { await streamReplay({ room, text: answer, footer, abortSignal, onActivity }); return undefined; }
						return answer;
					}
				}
			}
			catch (e) { /* best-effort; fall through to the model path unchanged */ }
		}

		if (dealReportId && isDealReport) {

			try {

				const dealAnswer = await answerDealReport({ dealId: dealReportId, roomData, model, question: message.content, timezone: message.timezone, nowBase });

				if (typeof dealAnswer === 'string' && dealAnswer.trim() !== '') {

					roomData.messages.push({ role: 'assistant', content: dealAnswer, timestamp: Date.now() });
					// Track the deal just reported so a deictic/continuation follow-up ("why is it stuck?",
					// "tell me more") resolves to it — the tool loop does this at its own turn, but the
					// deterministic shortcut bypasses that loop, so record the entity here too.
					roomData.recentEntities = aiGuardrails.updateRecentEntities(roomData.recentEntities, dealAnswer);
					conversationHistory.set(room, roomData);

					shareData.Common.logger('AI deal-report shortcut (' + aiProvider + '): deal ' + dealReportId + ' [' + (room || '?') + ']');

					if (stream) { await streamReplay({ room, text: dealAnswer, footer, abortSignal, onActivity }); }
					// Like the other deterministic shortcuts, this grounded per-deal answer bypasses the model
					// loop, so capture its question→tool routing here too (resolved via find_deal_id) — otherwise
					// a single-deal question would record no learning and show no 👍/👎 rating. answerDealReport
					// already finalized+grounded the text, so no source is needed (grounded defaults true for a
					// trusted deterministic render). Best-effort; captureLearning never disturbs the chat.
					captureLearning({ room, question: message.content, tools: [ 'find_deal_id' ], sources: [], answer: dealAnswer });
					if (stream) { return undefined; }
					return dealAnswer;
				}
				// null → fall through to the normal tool loop.
			}
			catch (e) {

				shareData.Common.logger('AI deal-report shortcut failed, falling back to tool path: ' + ((e && e.message) ? e.message : e));
			}
		}
	}

	// Deterministic data-provenance answer — "did you use OHLCV?", "was market data used?", "did you use live
	// prices?" inside a DEAL-ANALYSIS conversation. The weak analysis model has been observed to DENY using
	// OHLCV even though the analysis's own provenance note (earlier in this conversation) states it WAS
	// OHLCV-derived — falsely making the user distrust an otherwise correct report. Read the authoritative
	// provenance from the conversation and answer from it, never the model. No marker present (not an analysis
	// conversation) → fall through unchanged.
	if (toolsCfg.enabled && purpose === 'chat' && message.content && !reset
		&& (!message.attachments || message.attachments.length === 0)
		&& looksLikeAnalysisDataSourceQuestion(message.content)) {

		const prov = analysisDataProvenance(roomData);
		if (prov) {
			try {
				// Same sentence the report footer shows (analysisProvenanceText), so the answer never disagrees
				// with the report. It reads as a direct yes/no on its own, so no extra prefix is needed.
				return await emitRender(analysisProvenanceText(prov), {}, { log: 'AI analysis data-provenance shortcut (' + (prov.used ? 'ohlcv' : 'fallback') + '): answered deterministically [' + (room || '?') + ']' });
			}
			catch (e) { shareData.Common.logger('AI data-provenance shortcut failed, falling back: ' + ((e && e.message) ? e.message : e)); }
		}
	}

	// Deterministic open-deals shortcut — "render, don't generate" for the two most common (and most
	// fabrication/drift-prone) deals questions, bypassing the weak model entirely:
	//   • SUMMARY  — a portfolio-status question ("how are my deals?") → one-line real counts + total P/L.
	//   • BREAKDOWN — a follow-up ("tell me more", "list them", "in detail") after a deals topic → every deal.
	// Both fetch the same real get_open_deals_status data and format it in code: fast, grounded, complete, and
	// impossible to fabricate. Any failure falls through to the normal model path unchanged.
	let dealsView = null;
	let rankKind = null;
	let quantSpec = null;
	const hasExclusion = EXCLUSION_CLAUSE_RE.test(message.content);
	if (toolsCfg.enabled && purpose === 'chat' && message.content && !reset && !hasExclusion
		&& (!message.attachments || message.attachments.length === 0)) {
		// Whether the conversation is already ON the user's deals/portfolio, so a bare follow-up resolves in
		// that context. Computed once and reused by the continuation and the ranking branches below.
		const dealsCtx = recentTopicIsDealsPortfolio(roomData);
		if (aiGuardrails.looksLikeContinuation(message.content) && dealsCtx) { dealsView = 'breakdown'; }
		else if (looksLikeDealsStatusQuestion(message.content) || openDealsCountIntent(message.content) || portfolioPnlIntent(message.content)) { dealsView = 'summary'; }
		else if ((quantSpec = dealsQuantifierIntent(message.content))) { dealsView = 'quantifier'; }
		// A superlative follow-up ("which is the worst?", "and the best one?") carries no deal noun of its own,
		// so tell dealRankingIntent to assume the deals context when the topic is already deals — otherwise it
		// falls to the model, which mis-picks (e.g. naming a least-bad deal as the worst).
		else { const ri = dealRankingIntent(message.content, { assumeDeals: dealsCtx }); if (ri) { dealsView = 'ranking'; rankKind = ri; } }
	}
	if (dealsView) {

		try {

			const res = await aiTools.execute('get_open_deals_status', {}, { onActivity, timezone: message.timezone });
			let body = (res && res.success !== false)
				? (dealsView === 'quantifier' ? formatDealsQuantifier(res, quantSpec)
					: dealsView === 'breakdown' ? formatOpenDealsBreakdown(res)
					: dealsView === 'ranking' ? formatDealRanking(res, rankKind)
					: formatOpenDealsSummary(res))
				: null;

			if (body) {

				// If the turn was a COMPOUND concept+data ask ("… and what does underwater mean?"), append the
				// concept explanation so both halves are answered (the data half is already rendered above).
				body = await appendConceptForCompound(body, message.content, model);
				return await emitRender(body, res, {
					log: 'AI deals shortcut (' + dealsView + '): rendered open deals deterministically [' + (room || '?') + ']',
					lastRender: { kind: 'deals', view: dealsView, rankKind: rankKind },
					tool: 'get_open_deals_status'
				});
			}
		}
		catch (e) {

			shareData.Common.logger('AI deals shortcut failed, falling back: ' + ((e && e.message) ? e.message : e));
		}
	}

	// Deterministic bot-count shortcut — "how many bots do I have?" renders the real count + names from the
	// list_bots data, bypassing the model loop (observed to answer a WRONG count, e.g. "2 bots" when 7 exist,
	// and take ~24s). Any failure falls through to the normal path unchanged.
	if (toolsCfg.enabled && purpose === 'chat' && message.content && !reset && !dealsView
		&& (!message.attachments || message.attachments.length === 0)
		&& (botsCountIntent(message.content) || botsListIntent(message.content))) {

		try {
			const res = await aiTools.execute('list_bots', {}, { onActivity, timezone: message.timezone });
			const body = (res && res.success !== false) ? formatBotsCount(res) : null;
			if (body) {
				return await emitRender(body, res, {
					log: 'AI bots-count shortcut: rendered bot list deterministically [' + (room || '?') + ']',
					lastRender: { kind: 'bots' },
					tool: 'list_bots'
				});
			}
		}
		catch (e) {
			shareData.Common.logger('AI bots-count shortcut failed, falling back: ' + ((e && e.message) ? e.message : e));
		}
	}

	// Deterministic bot-config shortcut — "what take-profit % are my bots using?", "how many safety orders
	// max?", "what deviation step?". A configured setting is a discrete stored number the model loop was slow
	// on and sometimes DEFLECTED on (the deviation step) or risked inventing; render the real value from the
	// bot config (per bot when they differ), never a guess. Runs ahead of the model path; any failure falls
	// through unchanged.
	let configSpec = null;
	if (toolsCfg.enabled && purpose === 'chat' && message.content && !reset
		&& (!message.attachments || message.attachments.length === 0)) {
		configSpec = botConfigIntent(message.content);
	}
	if (configSpec) {

		try {
			const res = await aiTools.execute('list_bots', {}, { onActivity, timezone: message.timezone });
			const body = (res && res.success !== false) ? formatBotConfig(res, configSpec) : null;
			if (body) {
				return await emitRender(body, res, { log: 'AI bot-config shortcut (' + configSpec.field + '): rendered deterministically [' + (room || '?') + ']', tool: 'list_bots' });
			}
		}
		catch (e) { shareData.Common.logger('AI bot-config shortcut failed, falling back: ' + ((e && e.message) ? e.message : e)); }
	}

	// Deterministic per-bot open-deals shortcut — "how many open deals does each of my bots have?" and
	// "which bot has the most open deals?". This per-bot aggregation was reaching the model loop, which was
	// slow (~50s) and, in the worst case, HUNG and returned an empty answer, and could invent a bot. The
	// count is a plain group-by on the live open-deals list, so render it deterministically from the tool's
	// authoritative per-bot rollup instead. Any failure falls through to the model unchanged.
	let perBotSpec = null;
	if (toolsCfg.enabled && purpose === 'chat' && message.content && !reset && !dealsView
		&& (!message.attachments || message.attachments.length === 0)) {
		perBotSpec = perBotDealsIntent(message.content);
	}
	if (perBotSpec) {

		try {
			const res = await aiTools.execute('list_open_deals', { limit: 50 }, { onActivity, timezone: message.timezone });
			const body = (res && res.success !== false) ? formatPerBotDeals(res, perBotSpec) : null;
			if (body) {
				return await emitRender(body, res, { log: 'AI per-bot-deals shortcut (' + (perBotSpec.most ? 'most' : 'each') + '): rendered deterministically [' + (room || '?') + ']', tool: 'list_open_deals' });
			}
		}
		catch (e) { shareData.Common.logger('AI per-bot-deals shortcut failed, falling back: ' + ((e && e.message) ? e.message : e)); }
	}

	// Deterministic recent-errors shortcut — "render, don't generate" for "any notable errors lately?".
	// Handed the rich error summary, the weak model intermittently mangles it (a bulleted list of "the data")
	// or reports bare counts and drops the actual messages ("details can be found in the logs"). Render the
	// authoritative tally AND the real per-type log lines in code, so the answer always carries the specifics.
	let errorsIntent = null;
	if (toolsCfg.enabled && purpose === 'chat' && message.content && !reset && !dealsView
		&& (!message.attachments || message.attachments.length === 0)) {
		errorsIntent = recentErrorsIntent(message.content);
		// A continuation ("tell me more", "in detail") right after an errors survey stays on the errors topic
		// and widens to the last 3 days — instead of falling to the model, which was seen to pivot to an
		// unrelated open-deals dump. Deterministic and on-topic.
		if (!errorsIntent && aiGuardrails.looksLikeContinuation(message.content) && recentTopicIsRecentErrors(roomData)) {
			errorsIntent = { offsets: [ 0, 1, 2 ], span: 'range' };
		}
	}
	if (errorsIntent) {

		try {

			// Resolve the relative day(s) to explicit dates in the user's timezone and scan exactly those — so
			// "two days ago" hits that one day, not the last-N-days range the tool defaults to.
			const tz = shareData.Common.normalizeTimeZone(message.timezone) || null;
			const resolved = resolveErrorDates(errorsIntent.offsets, tz);
			const dates = resolved.map(r => r.date);
			const res = await aiTools.execute('summarize_recent_errors', { dates }, { onActivity, timezone: message.timezone });
			const body = (res && res.success !== false) ? formatRecentErrors(res, errorPeriodLabel(errorsIntent, resolved)) : null;

			if (body) {
				return await emitRender(body, res, { log: 'AI errors shortcut: rendered recent errors deterministically (' + dates.join(',') + ') [' + (room || '?') + ']', tool: 'summarize_recent_errors' });
			}
		}
		catch (e) {

			shareData.Common.logger('AI errors shortcut failed, falling back: ' + ((e && e.message) ? e.message : e));
		}
	}

	// Deterministic recent-completed-deals shortcut — "have any deals completed recently?" / "recent closed
	// deals". The model loop mis-routed this to an aggregate performance tool (no deal ids) and then FABRICATED
	// a completed-deal id (one in NEITHER open nor completed deals), shipping it under a soft caveat. Render the
	// real recently-completed list in code instead — grounded and impossible to invent. Any failure falls
	// through to the normal path unchanged.
	if (toolsCfg.enabled && purpose === 'chat' && message.content && !reset && !dealsView && !errorsIntent
		&& (!message.attachments || message.attachments.length === 0)
		&& recentCompletedIntent(message.content)) {

		try {
			const res = await aiTools.execute('list_recent_completed_deals', {}, { onActivity, timezone: message.timezone });
			const body = (res && res.success !== false) ? formatRecentCompleted(res) : null;
			if (body) {
				return await emitRender(body, res, { log: 'AI recent-completed shortcut: rendered deterministically [' + (room || '?') + ']', tool: 'list_recent_completed_deals' });
			}
		}
		catch (e) { shareData.Common.logger('AI recent-completed shortcut failed, falling back: ' + ((e && e.message) ? e.message : e)); }
	}

	// Deterministic deployed-vs-available funds shortcut — "how much have I deployed versus available?". The
	// model loop was slow (~84s) and printed the wallet balance as "$null" when it was unavailable; render the
	// real figures in code, with an honest "not available" for the wallet balance instead of a null placeholder.
	if (toolsCfg.enabled && purpose === 'chat' && message.content && !reset && !dealsView && !errorsIntent
		&& (!message.attachments || message.attachments.length === 0)
		&& portfolioFundsIntent(message.content)) {

		try {
			const res = await aiTools.execute('get_portfolio_summary', {}, { onActivity, timezone: message.timezone });
			const body = (res && res.success !== false) ? formatPortfolioFunds(res) : null;
			if (body) {
				return await emitRender(body, res, { log: 'AI portfolio-funds shortcut: rendered deterministically [' + (room || '?') + ']', tool: 'get_portfolio_summary' });
			}
		}
		catch (e) { shareData.Common.logger('AI portfolio-funds shortcut failed, falling back: ' + ((e && e.message) ? e.message : e)); }
	}

	// Deterministic time-window log search — "find logs around 10:43 PM", "what happened between 6 and 7 AM".
	// The weak model converts a local 12-hour clock time to UTC unreliably (wrong offset/day) or hand-waves at
	// the UI; parse the time in code (reusing Common's DST-correct tz helpers) and render the real events.
	let timeWindow = null;
	if (toolsCfg.enabled && purpose === 'chat' && message.content && !reset && !dealsView && !errorsIntent
		&& (!message.attachments || message.attachments.length === 0)) {
		try { timeWindow = timeSearchIntent(message.content, message.timezone); }
		catch (e) { timeWindow = null; }
	}
	if (timeWindow) {

		try {

			const res = await runTimeSearch(timeWindow, message.timezone, onActivity);
			const body = res ? formatEventsWindow(res, timeWindow.label, timeWindow.errorsOnly) : null;

			if (body) {
				return await emitRender(body, res, { log: 'AI time-window shortcut (' + timeWindow.mode + '): ' + timeWindow.label + ' [' + (room || '?') + ']', tool: 'get_events_in_window' });
			}
		}
		catch (e) {

			shareData.Common.logger('AI time-window shortcut failed, falling back: ' + ((e && e.message) ? e.message : e));
		}
	}

	// Fast lane for clearly-general / free-form questions. When AI Tools is on, EVERY chat message
	// would otherwise enter the tool-calling loop — a large system prompt (tool note + full tool
	// schema + guard notes + tool guide + learned examples) and one or more model rounds — which is
	// slow for a plain "tell me a story" and also primes the model to hunt for "relevant data" and
	// refuse. A zero-latency keyword classifier (rule-based routing, the fastest tier) sends a
	// question with NO account-data signal straight to a single lean, tool-free model call instead.
	// Biased toward the tool loop: any data signal falls through to it, so a data question is never
	// answered tool-free (where the model could fabricate figures). Attachment turns always go to the
	// tool path so document analysis still works. Best-effort: any failure falls through unchanged.
	if (toolsCfg.enabled && purpose === 'chat' && message.content && !reset
		&& (!message.attachments || message.attachments.length === 0)
		&& aiClient && typeof completePrompt === 'function'
		// Route to the tool-free lane when there is no account-data signal, OR when the message is a
		// pure concept / how-to question with no STRONG ownership signal — the broad account-data test
		// matches a bare trading noun ("what is a market order?"), which would otherwise send a concept
		// question to the tool path where a small model deflects instead of answering it.
		&& (!aiGuardrails.looksLikeAccountDataQuestion(message.content)
			|| (aiGuardrails.looksLikeConceptQuestion(message.content) && !aiGuardrails.hasStrongAccountSignal(message.content))
				// A purely DEFINITIONAL question ("what does drawdown mean for one of my deals?", "difference
				// between realized and unrealized profit") is answered from general knowledge, so it takes the
				// free-form lane even when an incidental possessive or aggregate term trips the strong-account
				// signal — otherwise it drags onto the tool path and picks up irrelevant figures or deflects.
				|| aiGuardrails.looksLikeDefinitional(message.content)
				// A HOW-TO / capability question ("where do I see my closed deals?", "can I change a deal's
				// take profit while it's open?") is answered from product knowledge, not the user's figures —
				// free-form lane, so it never routes into a data tool that returns null and drives a wrong
				// "no you cannot" answer or leaks tool names.
				|| aiGuardrails.looksLikeHowTo(message.content))
		&& !(aiGuardrails.looksLikeContinuation(message.content) && recentContextIsData(roomData))
		// A deictic follow-up carrying no data noun ("why is that one stuck?", "is it profitable?") is
		// neither an account-data question nor a bare continuation, so it would fall to the fast lane and
		// deflect — or worse, regurgitate figures from history unverified. resolveAnaphora returns a hint
		// ONLY for a deictic over a known recent entity, so it is the precise signal to re-ground instead.
		&& !aiGuardrails.resolveAnaphora(message.content, roomData.recentEntities)) {

		try {

			const freeSystem = (roomData.persona && roomData.persona.content ? roomData.persona.content : PERSONA)
				+ '\n\n' + FREEFORM_NOTE + '\n\n' + aiGuardrails.ADVICE_SYSTEM_NOTE + '\n\n' + nowBase;

			const freeMessages = [ { role: 'system', content: freeSystem } ]
				.concat(roomData.messages.map((m) => ({ role: m.role, content: m.content })));

			let answer = await completePrompt(freeMessages, model, resolveGenOptions('chat'));

			if (typeof answer === 'string' && answer.trim() !== '') {

				answer = finalizeAnswer(answer, '', message.content, knownEntitiesText(roomData.recentEntities));   // egress sanitize + advice rail; no sources

				roomData.messages.push({ role: 'assistant', content: answer, timestamp: Date.now() });
				conversationHistory.set(room, roomData);

				shareData.Common.logger('AI fast-lane (' + aiProvider + '): general reply, tool loop skipped [' + (room || '?') + ']');

				if (stream) { await streamReplay({ room, text: answer, footer, abortSignal, onActivity }); return undefined; }
				return answer;
			}
			// Empty answer → fall through to the tool path rather than return nothing.
		}
		catch (e) {

			shareData.Common.logger('AI fast-lane failed, falling back to tool path: ' + ((e && e.message) ? e.message : e));
			// fall through to the tool loop below
		}
	}

	// Runs for both streamed (UI / socket) and non-streamed (curl / API) chat. In
	// streaming mode the answer is replayed to the socket room; in non-streaming
	// mode it is returned so the HTTP caller gets it in the response body.
	if (toolsCfg.enabled && purpose === 'chat' && message.content && !reset
		&& aiClient && providerAdapters[aiProvider] && typeof providerAdapters[aiProvider].chatWithTools === 'function') {

		// Anchor relative-time questions ("today", "yesterday", "the last 2 days") for the tool loop.
		// Reuse the shared nowBase computed above (current UTC time + exact today/yesterday in the
		// user's timezone) and append the tool-specific day-passing guidance so a named single day is
		// passed to tools as an exact date, while day-counts are reserved for genuine multi-day ranges.
		const nowNote = nowBase + ' Deal and log timestamps are stored in UTC but the tools resolve any day you name in the user\'s timezone, so when a question refers to a specific day such as "yesterday", pass that exact date (YYYY-MM-DD) to tools rather than a day count; use a day count only for genuine ranges like "the last 3 days".';

		// A tool-note-free system message, used only if the loop has to fall back to a
		// plain answer — it keeps the persona and the current-time note but omits the
		// "call a tool" instruction so the model answers directly instead of retrying a
		// tool call it can no longer make.
		const cleanSystem = { role: 'system', content: (roomData.persona && roomData.persona.content ? roomData.persona.content : PERSONA) + '\n\n' + nowNote };

		// Self-improvement: inject the most similar GOOD past questions (patterns only —
		// which tools answered them) so the model reuses what worked instead of re-guessing.
		// Strictly additive and best-effort: any failure yields '' and the prompt is built
		// exactly as before. Off unless ai.learning.enabled.
		let learnedBlock = '';
		try {
			await ensureLearningSeeded();
			// Map each learned exemplar's tool names through the CURRENT registry: alias-remap a renamed
			// tool to its current name, drop one that no longer exists — so a locally-learned example never
			// nudges the model toward a retired tool.
			const _validToolNames = new Set((aiTools.TOOLS || []).map(t => t.name));
			const _aliases = aiTools.TOOL_ALIASES || {};
			const toolMapper = (name) => { const c = _aliases[name] || name; return _validToolNames.has(c) ? c : null; };
			learnedBlock = aiMemory.formatForPrompt(await aiMemory.retrieveSimilar(message.content), { toolMapper });
		}
		catch (e) { learnedBlock = ''; }

		// Guardrail hardening appended to the system contract: the trust boundary / spotlighting
		// clause, the financial-advice boundary, and the provenance/confidence clause.
		const guardNote = '\n\n' + aiGuardrails.SPOTLIGHT_SYSTEM_NOTE + '\n\n' + aiGuardrails.ADVICE_SYSTEM_NOTE + '\n\n' + aiGuardrails.PROVENANCE_SYSTEM_NOTE;

		// Anaphora resolution: if the question uses a deictic reference ("that deal", "it",
		// "the same") and names no entity itself, hint the most recently discussed deal/pair so the
		// model uses the exact id rather than guessing. Deterministic, from the recent-entity stack.
		const anaphoraHint = aiGuardrails.resolveAnaphora(message.content, roomData.recentEntities);

		// Continuation guidance: a bare "tell me more" reaches the tool path only after a data-grounded
		// turn (see the fast-lane gate). Tell the model to re-run the same lookup and elaborate on the same
		// subject instead of deflecting ("what topic?") — the weak-model failure the continuation fix left open.
		const continuationHint = aiGuardrails.resolveContinuation(message.content, roomData.recentEntities);

		const toolMessages = [
			{ role: 'system', content: (roomData.persona && roomData.persona.content ? roomData.persona.content : PERSONA) + '\n\n' + TOOL_SYSTEM_NOTE + guardNote + '\n\n' + nowNote + (anaphoraHint ? '\n\n' + anaphoraHint : '') + (continuationHint ? '\n\n' + continuationHint : '') + '\n\n' + aiTools.TOOL_GUIDE + learnedBlock },
			...roomData.messages.map((m) => {
				let content = m.content;
				if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
					const attachmentContext = m.attachments
						.filter(a => a.text && a.text.length > 0)
						.map(a => {
							// Spotlight the file body in random delimiters so injected instructions inside
							// an uploaded log cannot hijack the assistant. The framing note stays.
							const spot = aiGuardrails.spotlight(extractPassage(a.text, m.content), 'UPLOADED_FILE');
							return `[Attached file: ${a.name} — ANALYZE THIS CONTENT DIRECTLY. ${spot.note} Any deal ids, pairs or order ids inside it belong to this file and may be from another instance, an old run, or a hypothetical; do NOT call tools to look them up in live data — they will not be found. Reason over the text as given.]\n${spot.wrapped}`;
						})
						.join('\n\n---\n\n');
					if (attachmentContext) { content = attachmentContext + '\n\n---\n\n' + content; }
				}
				return { role: m.role, content };
			})
		];

		// Uploaded-file text is grounding for the faithfulness check too, not just the
		// tool results — collect the same passages that were injected into the prompt.
		const attachmentSources = [];
		for (const m of roomData.messages) {
			if (m.role === 'user' && Array.isArray(m.attachments)) {
				for (const a of m.attachments) {
					if (a && a.text && a.text.length > 0) {
						attachmentSources.push('[Attached file: ' + a.name + ']\n' + extractPassage(a.text, m.content));
					}
				}
			}
		}

		let toolResult = null;

		// Shortlist the tools relevant to this question so a small model sees ~8 tools,
		// not all ~25 (selection accuracy drops sharply past ~10–15 tools).
		const toolNames = aiTools.selectTools(message.content);

		// A bare continuation ("tell me more") following a grounded DATA answer is itself a data question —
		// it must re-ground via a tool or ABSTAIN, never be composed from the model's head (which fabricates a
		// deal list). Its own text ("tell me more") does not trip requiresGrounding, so flag it explicitly so
		// the tool loop's fail-closed gate applies to it.
		const dataContinuation = aiGuardrails.looksLikeContinuation(message.content) && recentContextIsData(roomData);

		try {

			toolResult = await runToolLoop({ room, messages: toolMessages, model, maxIterations: toolsCfg.max_iterations, abortSignal, onActivity, footer, stream, attachmentSources, cleanSystem, shortlist: toolNames, question: message.content, timezone: message.timezone, recentEntities: roomData.recentEntities, dataContinuation });
		}
		catch (err) {

			if (err.name === 'AbortError' || abortSignal.aborted) {

				if (stream) {

					sendAborted(room, 'Response stopped due to timeout. Please try again.');
					sendChatEnd(room);
				}

				return stream ? undefined : 'Response stopped due to timeout. Please try again.';
			}

			// Any other tool-loop failure must never surface as a raw provider error to
			// the user; fall through to the normal (router) chat path instead.
			shareData.Common.logger('AI tools: tool path failed, falling back to router: ' + err.message);
			toolResult = null;
		}

		// null → the provider/model can't do tools; fall through to the normal path.
		// A string (possibly empty on abort) → handled. In streaming mode it has been
		// sent to the socket room; in non-streaming mode it is the answer to return.
		if (toolResult !== null) {

			if (toolResult) {

				roomData.messages.push({ role: 'assistant', content: toolResult, timestamp: Date.now() });
				// Remember the deal/pair entities just discussed so a follow-up ("that deal",
				// "the same") resolves deterministically next turn.
				roomData.recentEntities = aiGuardrails.updateRecentEntities(roomData.recentEntities, message.content + '\n' + toolResult);
				conversationHistory.set(room, roomData);
			}

			return toolResult;
		}

		// runToolLoop returned null (the model produced nothing usable, or its build can't tool-call). For a
		// data CONTINUATION ("tell me more") this must NOT fall through to the free-form router path below —
		// that path has no fail-closed gate, so it would compose an ungrounded answer or drift to concepts.
		// Abstain instead, consistent with the in-loop gate.
		if (dataContinuation) {

			const abst = finalizeAnswer(GROUNDING_ABSTENTION, '', message.content, knownEntitiesText(roomData.recentEntities));
			roomData.messages.push({ role: 'assistant', content: abst, timestamp: Date.now() });
			conversationHistory.set(room, roomData);
			shareData.Common.logger('AI tools: data-continuation could not re-ground — abstaining rather than free-form [' + (room || '?') + ']');

			if (stream) { await streamReplay({ room, text: abst, footer, abortSignal, onActivity }); return undefined; }
			return abst;
		}
	}

	// Retrieve SymBot deal / log data relevant to this question, when enabled.
	// Read-only and strictly additive: any failure yields an empty string and the
	// payload below is built exactly as it was before this step existed.
	let dealContext = '';

	if (message.content && !reset && shareData.AIContext) {

		try {

			dealContext = await shareData.AIContext.build(room, message.content, roomData.messages, purpose);
		}
		catch (e) {

			dealContext = '';
		}
	}

	// Build final message payload for the model
	// If a user message has attachments, inject the extracted text before the message content
	const lastUserIndex = roomData.messages.map(m => m.role).lastIndexOf('user');

	// Harden the system message on this (tool-free) fallback path with the same trust-boundary clause the
	// tool path carries, so untrusted strings inside the retrieved deal data / log lines (a bot named
	// "ignore previous instructions…", a crafted log line) are treated as DATA, not instructions. Built as
	// a copy so the stored persona is never mutated.
	const hardenedSystem = (roomData.persona && roomData.persona.content)
		? { role: 'system', content: roomData.persona.content + '\n\n' + aiGuardrails.SPOTLIGHT_SYSTEM_NOTE }
		: roomData.persona;

	const messagesForModel = [
		hardenedSystem,
		...roomData.messages.map((m, index) => {
			let content = m.content;
			if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
				const attachmentContext = m.attachments
					.filter(a => a.text && a.text.length > 0)
					.map(a => `[Attached file: ${a.name}]\n${extractPassage(a.text, m.content)}`)
					.join('\n\n---\n\n');
				if (attachmentContext) {
					content = attachmentContext + '\n\n---\n\n' + content;
				}
			}
			// Retrieved SymBot data goes outermost so it leads the message — wrapped in a spotlight block
			// (random unforgeable delimiters) so the model can tell this fetched data from its instructions.
			if (m.role === 'user' && index === lastUserIndex && dealContext) {
				content = aiGuardrails.spotlight(dealContext, 'SYMBOT_DATA') + '\n\n---\n\n' + content;
			}
			return { role: m.role, content };
		})
	];

	try {

		if (stream && purpose === 'chat') {

			// Egress funnel for the router (non-tool) chat path. A default install has AI Tools OFF,
			// so ordinary chat runs here — and previously the model's output streamed to the user
			// unvetted (no egress sanitize, no system-prompt-leak backstop, no fabricated-list backstop).
			// Buffer the whole answer (stream:false emits nothing), run it through the same finalizeAnswer
			// funnel the tool path uses, then replay it progressively so the reveal still looks streamed.
			// dealContext is the injected SymBot data, so it is the grounding source. Read-only: nothing
			// here can touch trading.
			const raw = await streamChatProvider({
				model,
				stream: false,
				messages: messagesForModel,
				abortSignal,
				onActivity,
				room,
				options,
				footer: null,
			});

			fullResponse = finalizeAnswer(raw, dealContext, message.content, '', {});

			if (!(abortSignal && abortSignal.aborted)) {

				await streamReplay({ room, text: fullResponse, footer, abortSignal, onActivity });
			}
			else {

				// The buffered model call was aborted (timeout / user cancel). The non-streaming provider
				// call swallows the abort and returns empty rather than throwing, so send the terminal
				// signals here ourselves — otherwise the UI never receives chat_end and appears to hang.
				sendAborted(room, 'Response stopped due to timeout. Please try again.');
				sendChatEnd(room);
			}
		}
		else {

			fullResponse = await streamChatProvider({
				model,
				stream,
				messages: messagesForModel,
				abortSignal,
				onActivity,
				room,
				options,
				footer,
			});
		}

		// Advisory grounding check on the streamed deal analysis (the path the UI
		// uses). Log-only — it never alters the reply, it just surfaces drift: a
		// reply that dropped its Hold / Add Funds recommendation or cited a figure
		// absent from the analysis prompt. The footer is stripped first so the model
		// name is not mistaken for an ungrounded figure. The non-streaming API path
		// runs its own gated guard, so this is scoped to the streaming path.
		if (purpose === 'analysis' && stream && typeof fullResponse === 'string' && fullResponse.trim() !== '') {

			try {

				const clean = fullResponse.replace(/\n+_Analyzed with [^\n]*_\s*$/, '');
				const guard = analysisGuard.checkAnalysis(clean, message.content);

				if (!guard.hasRecommendation) {

					shareData.Common.logger('AI analysis guard: streamed analysis is missing a clear Hold / Add Funds recommendation');
				}

				if (guard.ungroundedNumbers.length > 0) {

					shareData.Common.logger('AI analysis guard: streamed analysis — ' + guard.ungroundedNumbers.length
						+ ' figure(s) not found in the source data: ' + guard.ungroundedNumbers.slice(0, 8).join(', '));
				}
			}
			catch (e) {}
		}

		// API / non-streaming path: vet the buffered answer through the same egress funnel before it is
		// returned (the streaming chat path already funneled above; streaming analysis keeps its existing
		// log-only guard). This gives the HTTP / curl callers the same fail-closed egress the UI gets.
		if (!stream) {

			fullResponse = finalizeAnswer(fullResponse, dealContext, message.content, '', {});
		}

		// Store assistant response
		roomData.messages.push({
			role: 'assistant',
			content: fullResponse,
			timestamp: Date.now()
		});

		conversationHistory.set(room, roomData);

		shareData.Common.logger(
			'AI Request (' + aiProvider + '): ' + JSON.stringify({
				room,
				message,
				response: fullResponse
			})
		);

		return stream ? undefined : fullResponse;
	}
	catch (err) {

		// AbortError from timeout or user cancel — notify the user distinctly
		if (err.name === 'AbortError' || abortSignal.aborted) {

			if (stream) {

				sendAborted(room, 'Response stopped due to timeout. Please try again.');
				sendChatEnd(room);
			}

			return stream ? undefined : fullResponse;
		}

		throw err;
	}
};


// Translate the normalized generation options ({ temperature, maxTokens, json })
// into each SDK's own request shape. Absent fields are left untouched so the
// provider default applies — a call with no options behaves exactly as before.
// How long Ollama should keep the model resident in memory after a request. Ollama unloads after ~5 min
// idle by default, so the next chat turn pays a multi-second cold reload (observed ~42s cold vs ~18s warm
// for the same question). Keeping it resident between turns is the single biggest, cheapest latency win.
// Overridable via ai.ollama.keep_alive in the config (e.g. '30m', '1h', or -1 to keep it always loaded).
function ollamaKeepAlive() {
	try {
		const ka = shareData && shareData.appData && shareData.appData.ai && shareData.appData.ai.ollama && shareData.appData.ai.ollama.keep_alive;
		return (ka === undefined || ka === null || ka === '') ? '30m' : ka;
	}
	catch (e) { return '30m'; }
}

function withOllamaOptions(payload, options) {

	payload.keep_alive = ollamaKeepAlive();   // keep the model resident so the NEXT turn isn't a cold-start

	if (!options) return payload;

	const opt = {};

	if (typeof options.temperature === 'number') { opt.temperature = options.temperature; }
	if (typeof options.maxTokens   === 'number') { opt.num_predict = options.maxTokens; }
	if (typeof options.num_ctx     === 'number' && options.num_ctx > 0) { opt.num_ctx = options.num_ctx; }

	if (Object.keys(opt).length > 0) { payload.options = opt; }

	// A JSON schema constrains the output to a valid shape (Ollama structured outputs),
	// which is stronger than plain JSON mode on small models; fall back to plain JSON
	// mode when only `json` is set. If the endpoint rejects the schema, completePrompt
	// retries without options.
	if (options.schema && typeof options.schema === 'object') { payload.format = options.schema; }
	else if (options.json) { payload.format = 'json'; }

	return payload;
}

function withOpenAIOptions(payload, options) {

	if (!options) return payload;

	if (typeof options.temperature === 'number') { payload.temperature = options.temperature; }
	if (typeof options.maxTokens   === 'number') { payload.max_tokens  = options.maxTokens; }

	// Prefer a JSON schema (structured outputs) when given; plain JSON mode otherwise.
	// An endpoint that does not support json_schema throws, and completePrompt retries
	// without options, so the caller's own lenient JSON parsing still applies.
	if (options.schema && typeof options.schema === 'object') { payload.response_format = { type: 'json_schema', json_schema: { name: 'decision', schema: options.schema } }; }
	else if (options.json) { payload.response_format = { type: 'json_object' }; }

	return payload;
}


// ── Context-window guard (system-prompt eviction protection) ──────────────────────────────────
// Small local models have a limited context window. When the tool-loop conversation grows past it,
// providers (Ollama) silently drop the OLDEST tokens — which is the SYSTEM message carrying the
// grounding rules, leaving the model to answer with the rules gone (the classic degenerate one-word
// reply). This guard clamps the conversation to a character budget WITHOUT ever shortening or dropping
// the system message (index 0) or any user turn (the questions): it shortens the CONTENT of the oldest
// tool-result / assistant turns first, and never removes a turn — so an OpenAI-shaped endpoint's
// tool_call↔tool_result pairing stays valid. It matters most on small hardware; on a roomy window it
// never triggers.

const CHARS_PER_TOKEN = 3.5;            // rough average across English prose + JSON tool results
const INPUT_CONTEXT_FRACTION = 0.7;     // reserve ~30% of the window for the model's own reply
const DEFAULT_CONTEXT_TOKENS = 8192;    // assumed window when the user has not configured num_ctx
const MIN_TRUNCATED_CONTENT = 200;      // leave a readable stub on any turn we shorten

// The user's configured context window in tokens (ai.generation.num_ctx), or 0 when unset. Opt-in: a
// value here is also passed to the provider so the ACTUAL window matches the budget below, giving an
// exact guarantee; unset leaves the provider default untouched and the guard runs best-effort.
function configuredNumCtx() {
	const gen = (shareData && shareData.appData && shareData.appData.ai && shareData.appData.ai.generation) || {};
	const n = parseInt(gen.num_ctx, 10);
	return (!isNaN(n) && n > 0) ? n : 0;
}

// Usable INPUT character budget derived from the context window (configured, else a conservative
// default), reserving room for the reply. Never below a small floor so the guard can't over-clamp.
function resolveConvoBudgetChars() {
	const tokens = configuredNumCtx() || DEFAULT_CONTEXT_TOKENS;
	return Math.max(2000, Math.floor(tokens * CHARS_PER_TOKEN * INPUT_CONTEXT_FRACTION));
}

// PURE. Return a conversation that fits `budgetChars`, preserving the system message and all user
// turns intact and shortening the oldest non-user turns first. Returns the original array untouched
// when already within budget (no allocation on the common path). Never throws.
function clampConversation(messages, budgetChars) {

	if (!Array.isArray(messages) || messages.length <= 1) { return messages; }

	const budget = (budgetChars > 0) ? budgetChars : resolveConvoBudgetChars();

	const len = m => (m && typeof m.content === 'string') ? m.content.length : 0;

	let total = 0;
	for (const m of messages) { total += len(m); }
	if (total <= budget) { return messages; }

	// Clone so the caller's running conversation keeps its full content for the next iteration and for
	// the faithfulness sources; we only shorten what the model is shown THIS call.
	const out = messages.map(m => ({ ...m }));

	// Oldest-first. Never touch index 0 (system) or a user turn (the question). An assistant tool-call
	// turn usually has empty content, so this mostly bites the bulky tool-result turns.
	for (let i = 1; i < out.length && total > budget; i++) {

		const m = out[i];
		if (!m || m.role === 'user' || typeof m.content !== 'string' || m.content.length <= MIN_TRUNCATED_CONTENT) { continue; }

		const cut = Math.min(m.content.length - MIN_TRUNCATED_CONTENT, total - budget);
		if (cut > 0) {
			m.content = m.content.slice(0, m.content.length - cut) + ' …[truncated to fit the model context]';
			total -= cut;
		}
	}

	return out;
}

// OpenAI returns tool-call arguments as a JSON string; Ollama as an object. Some
// OpenAI-compatible and smaller local models return a malformed or fenced string.
// Normalize to an object so tool handlers get a consistent args shape, repairing the
// common breakages (code fences, surrounding prose, trailing commas) before giving
// up. Logs once on a non-empty give-up so a systematically-broken model is visible.
function safeParseJson(s) {

	// Shared tolerant parser (fences / surrounding prose / trailing commas). Tool handlers expect an
	// OBJECT, so normalize its null (unparseable) result to {} and log once on a non-empty give-up.
	const parsed = aiGuardrails.parseModelJson(s);
	if (parsed != null && typeof parsed === 'object') { return parsed; }

	const str = (typeof s === 'string') ? s.trim() : '';
	if (str !== '') {

		try {

			if (shareData && shareData.Common && typeof shareData.Common.logger === 'function') {

				shareData.Common.logger('AI tool-call args could not be parsed: ' + str.slice(0, 200));
			}
		}
		catch (_) { /* logging is best-effort */ }
	}

	return {};
}


// Recover a tool call a model emitted as JSON text in its content (rather than in the
// structured tool_calls field) — common with Ollama's OpenAI-compat URL and smaller
// local models. Only returns a call whose name matches a registered tool, so ordinary
// prose answers are never mistaken for tool calls.
function extractLeakedToolCall(content, knownToolNames) {

	if (!content || typeof content !== 'string') { return null; }

	const candidates = [];

	const fenceRegex = /```(?:json|tool_call)?\s*([\s\S]*?)```/g;
	let m;
	while ((m = fenceRegex.exec(content)) !== null) { candidates.push(m[1].trim()); }

	const trimmed = content.trim();
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) { candidates.push(trimmed); }

	// First balanced {...} anywhere, string-aware.
	const startIdx = content.indexOf('{');
	if (startIdx !== -1) {

		let depth = 0, endIdx = -1, inStr = false, escNext = false;

		for (let i = startIdx; i < content.length; i++) {

			const ch = content[i];
			if (escNext) { escNext = false; continue; }
			if (inStr) { if (ch === '\\') { escNext = true; } else if (ch === '"') { inStr = false; } continue; }
			if (ch === '"') { inStr = true; continue; }
			if (ch === '{') { depth++; }
			else if (ch === '}') { depth--; if (depth === 0) { endIdx = i; break; } }
		}

		if (endIdx !== -1) { candidates.push(content.slice(startIdx, endIdx + 1)); }
	}

	for (const raw of candidates) {

		let parsed;
		try { parsed = JSON.parse(raw); } catch (e) { continue; }
		if (!parsed || typeof parsed !== 'object') { continue; }

		const name = parsed.name || parsed.tool || (parsed.function && parsed.function.name);
		let args = parsed.arguments || parsed.args || parsed.parameters || (parsed.function && parsed.function.arguments) || {};

		if (typeof args === 'string') { args = safeParseJson(args); }

		// Enum-lock the leaked name onto a tool we actually offered this turn (exact, or a
		// formatting/near-miss repair scoped to the shortlist) rather than requiring an exact hit.
		const canonical = name ? aiTools.resolveTool(name, knownToolNames) : null;
		if (canonical) {

			return { id: 'leaked_' + Date.now(), name: canonical, args };
		}
	}

	return null;
}


// Per-provider adapter set at start() time.
// Each adapter exposes two methods with a normalized interface:
//   createStream(client, model, messages, abortSignal, options) → async iterable of chunks
//   createNonStream(client, model, messages, abortSignal, options) → { content: string }
//   extractChunkContent(chunk) → string | null | undefined
// The optional `options` is the normalized generation-option object; omitting
// it preserves the provider's default decoding behavior.
const providerAdapters = {

	ollama: {

		createStream: (client, model, messages, abortSignal, options) =>
			client.chat(withOllamaOptions({ model, stream: true, messages }, options)),

		createNonStream: async (client, model, messages, abortSignal, options) => {

			// Ollama's non-stream path has no built-in abort support.
			// When a signal is provided, use the streaming path internally
			// and accumulate — the stream iterator supports .abort().
			if (!abortSignal) return client.chat(withOllamaOptions({ model, stream: false, messages }, options));

			const iterator = await client.chat(withOllamaOptions({ model, stream: true, messages }, options));

			const onAbort = () => { try { iterator.abort(); } catch (_) {} };

			if (abortSignal.aborted) { onAbort(); return { message: { content: '' } }; }

			abortSignal.addEventListener('abort', onAbort, { once: true });

			let content = '';

			try {

				for await (const part of iterator) {
					content += part?.message?.content || '';
				}
			}
			catch (err) {

				if (err.name !== 'AbortError' && !abortSignal.aborted) throw err;
			}
			finally {

				abortSignal.removeEventListener('abort', onAbort);
			}

			return { message: { content } };
		},

		extractChunkContent: (chunk) => chunk?.message?.content,

		extractNonStreamContent: (result) => result?.message?.content ?? '',

		// Tool-calling (non-streaming). Returns the assistant message to append and
		// a normalized list of tool calls. Ollama gives arguments as objects already.
		chatWithTools: async (client, model, messages, tools) => {

			// temperature 0 for reliable tool selection on small local models. When the user has
			// configured a context window, pass it so the ACTUAL window matches the eviction guard's
			// budget (an exact guarantee); unset leaves Ollama's own default untouched.
			const toolOpts = { temperature: 0 };
			const nctx = configuredNumCtx();
			if (nctx > 0) { toolOpts.num_ctx = nctx; }

			const res = await client.chat({ model, messages, tools, stream: false, options: toolOpts, keep_alive: ollamaKeepAlive() });

			const msg = (res && res.message) || {};

			// Ollama usually gives arguments as an object, but some gateways return a
			// string; safeParseJson handles both.
			const toolCalls = ((msg.tool_calls) || []).map(tc => ({
				name: tc && tc.function && tc.function.name,
				args: safeParseJson(tc && tc.function && tc.function.arguments)
			}));

			const assistantMessage = { role: 'assistant', content: msg.content || '' };

			if (msg.tool_calls && msg.tool_calls.length) { assistantMessage.tool_calls = msg.tool_calls; }

			return { assistantMessage, toolCalls };
		},

		formatToolResult: (toolCall, resultStr) => ({ role: 'tool', tool_name: toolCall.name, content: resultStr }),
	},

	openai: {

		createStream: (client, model, messages, abortSignal, options) =>
			client.chat.completions.create(withOpenAIOptions({ model, stream: true, messages }, options), { signal: abortSignal }),

		createNonStream: (client, model, messages, abortSignal, options) =>
			client.chat.completions.create(withOpenAIOptions({ model, stream: false, messages }, options), { signal: abortSignal }),

		extractChunkContent: (chunk) => chunk.choices[0]?.delta?.content,

		extractNonStreamContent: (result) => result.choices[0]?.message?.content ?? '',

		// Tool-calling (non-streaming). OpenAI gives arguments as JSON strings.
		chatWithTools: async (client, model, messages, tools) => {

			const res = await client.chat.completions.create({ model, messages, tools, tool_choice: 'auto', stream: false, temperature: 0 });

			const msg = (res && res.choices && res.choices[0] && res.choices[0].message) || {};

			// Synthesize an id when a compat endpoint (llama.cpp, vLLM, LM Studio, some
			// Ollama /v1 configs) omits or duplicates it — an assistant message whose
			// tool_calls lack ids that match the follow-up tool messages otherwise 400s.
			const toolCalls = ((msg.tool_calls) || []).map((tc, i) => ({
				id: (tc && tc.id) || ('call_' + Date.now() + '_' + i),
				name: tc && tc.function && tc.function.name,
				args: safeParseJson(tc && tc.function && tc.function.arguments)
			}));

			// Rebuild the assistant tool_calls from the reconciled ids so every tool
			// result's tool_call_id matches one here. content coerced to '' (never null)
			// for endpoints that reject null content on the follow-up request.
			const assistantMessage = {
				role: 'assistant',
				content: msg.content == null ? '' : msg.content,
				tool_calls: toolCalls.length
					? toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } }))
					: undefined
			};

			return { assistantMessage, toolCalls };
		},

		formatToolResult: (toolCall, resultStr) => ({ role: 'tool', tool_call_id: toolCall.id, content: resultStr }),
	},
};


function abortToolLoop(room) {

	sendAborted(room, 'Response stopped due to timeout. Please try again.');
	sendChatEnd(room);
	return '';
}


const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


// The tool-call rounds are non-streaming, so the model's final answer arrives as
// one complete string. Replay it to the room in small chunks — with a short pause
// between them — so the chat reveals it progressively, matching the look of the
// normal streamed path instead of dropping the whole message at once. No extra
// model call is made: the text is already final, this only paces its delivery.
async function streamReplay({ room, text, footer, abortSignal, onActivity }) {

	const full = (text || '').trim();

	if (full) {

		const parts = full.split(/(\s+)/);                          // keep whitespace between words
		const per = Math.max(1, Math.ceil(parts.length / 60));      // bound the number of emitted chunks

		for (let i = 0; i < parts.length; i += per) {

			if (abortSignal && abortSignal.aborted) { break; }

			sendMessage(room, parts.slice(i, i + per).join(''));
			onActivity?.();

			await sleep(15);
		}
	}

	if (footer) { sendMessage(room, footer); }

	sendChatEnd(room);
}


// Tool-calling loop for conversational chat. The model is given read-only tools
// and, round by round, requests the deal/log data it needs; each tool result is
// appended and the loop repeats until the model answers with no further tool
// call (or the iteration cap is hit, after which one final plain answer is made).
// Tool rounds are non-streaming, so the final answer is sent as one message then the
// out-of-band chat_end signal (no token-by-token streaming on this path).
//
// Returns the final answer string, or null when the provider/model does not
// support tools (the first call fails) so the caller can fall back to normal chat.
// Final-answer guardrails applied before every composed answer ships: R5 egress sanitizing
// (strip data-exfil markdown-image/unicode vectors), R3 advice output-rail (append a one-line
// disclaimer if a buy/sell/predict directive slipped through), and the G1 entity grounding
// SIGNAL — log any deal id / pair the answer asserts that the tool results never returned
// (advisory, like the number-grounding signal). Read-only: cannot affect trading.
function finalizeAnswer(answer, sourcesText, questionText, knownText, opts) {

	let out = aiGuardrails.sanitizeEgress(typeof answer === 'string' ? answer : String(answer || ''), opts);

	// Arithmetic self-check on MODEL-generated answers: a free-form reply that states a self-contained
	// calculation out loud can get the number wrong even when the method is right (the weak model's one
	// remaining way to emit a fabricated figure — the account-data answers are all rendered deterministically
	// from real values). Recompute and correct only a result that is wrong at the model's own stated
	// precision; legitimate rounding is left untouched. Trusted renders are grounded by construction, so they
	// are skipped. Improve-only and microsecond, so it sits on the shared finalize funnel with the other
	// backstops.
	if (!(opts && opts.trusted) && typeof out === 'string' && out) {
		try {
			const fixedMath = analysisGuard.correctArithmetic(out);
			if (fixedMath.corrections.length) {
				out = fixedMath.text;
				if (shareData && shareData.Common && typeof shareData.Common.logger === 'function') {
					shareData.Common.logger('AI arithmetic: corrected a mis-stated calculation — ' + JSON.stringify(fixedMath.corrections));
				}
			}
		}
		catch (e) { /* advisory — never block an answer on the math check */ }
	}

	// Phrasing-independent system-prompt-leak backstop. The input guards decline the obvious exfil wordings
	// before generation, but the phrasing space is unbounded; this catches a leak at the OUTPUT — if the
	// finished answer reproduces a verbatim run of the (fixed, known) system-prompt scaffolding, it is a leak
	// however it was elicited, so it is replaced wholesale with the standard refusal. Deterministic and
	// microsecond; every answer path funnels through finalizeAnswer, so one wiring point covers them all.
	if (aiGuardrails.detectSystemPromptLeak(out)) { return aiGuardrails.refusalMessage('systemPrompt'); }

	// OUTPUT BACKSTOP — a fabricated per-deal RECORD LIST must never reach the user (render-don't-generate).
	// Records (deal lists) are only ever produced by the deterministic breakdown, which passes the real tool
	// payload as sourcesText. So a per-deal list with NO grounding (free-form, empty sourcesText) is invented,
	// and a list that uses "[unavailable]" as deal-id parts is invented on any path (the deterministic render
	// never emits that). Replace it with an honest redirect rather than ship fabricated positions. This is
	// model- and phrasing-independent: it catches the fabrication even when the follow-up detector missed.
	// A TRUSTED answer is a deterministic code render straight from the payload — grounded by construction, so
	// it is exempt from the fabrication backstop below (which is for MODEL-generated record lists).
	if (!(opts && opts.trusted) && typeof out === 'string' && out) {
		const recordEntry = /(?:deal\s*\d+\b|\b[A-Z0-9]{2,10}[_\/][A-Z0-9]{2,10}\b|\[unavailable\][- ]?\d)[^.\n]{0,80}?\b(?:entry price|average price|target price|base order|safety order|unrealized|unrealized|p\/?l|profit\s*%|distance to (?:target|take))\b/gi;
		const looksLikeRecordList = (out.match(recordEntry) || []).length >= 2 || (out.match(/\[unavailable\]/g) || []).length >= 3;
		if (looksLikeRecordList) {
			const fabricatedIds = /\[unavailable\][- ]?\d|(?:\[unavailable\][^\n]*){2}/i.test(out);
			const noGrounding = !sourcesText || String(sourcesText).trim() === '';
			// Even WITH a tool payload, the model may fabricate per-deal figures that are not in it (invented
			// entry prices, order times, sizes) — the exact production failure. Verify: if a large share of the
			// listed figures are absent from the payload, the record list is fabricated. (numbersChecked>=4 so a
			// short genuine reply is never judged on one or two numbers.)
			let ungroundedFigures = false;
			if (!noGrounding) {
				try {
					const chk = analysisGuard.checkNumbers(out, sourcesText);
					ungroundedFigures = chk.numbersChecked >= 4 && chk.ungrounded.length >= Math.ceil(chk.numbersChecked * 0.34);
				}
				catch (e) { /* advisory */ }
			}
			if (noGrounding || fabricatedIds || ungroundedFigures) {
				return "I don't have a reliable per-deal breakdown to show right now — I won't list positions I can't confirm against your live data. Ask me to \"list my open deals in detail\" and I'll pull each one from SymBot directly.";
			}
		}
	}

	if (aiGuardrails.looksLikeDirective(out) && out.indexOf('Not licensed financial advice') === -1) {
		// The DATA disclaimer ("figures above are from your own SymBot data") only fits an answer that
		// actually cites figures. A concept/advice reply with no numbers — even one composed on the tool
		// path — must get the data-free variant, or it falsely claims figures it does not contain. So key
		// the choice on whether the ANSWER uses figures, not merely on whether tools ran this turn.
		let citesFigures = false;
		try { citesFigures = !!(sourcesText && String(sourcesText).trim() !== '') && analysisGuard.checkNumbers(out, sourcesText).numbersChecked > 0; }
		catch (e) { citesFigures = false; }
		out += citesFigures
			? aiGuardrails.FINANCIAL_ADVICE_NOTE
			: aiGuardrails.FINANCIAL_ADVICE_NOTE_GENERIC;
	}

	try {
		// An entity is GROUNDED if it appears in this turn's tool results (sourcesText), was supplied by the
		// user in their own question (questionText), OR was already established earlier in the conversation
		// (knownText — a "tell me more" that re-uses the deal we just discussed). Anything else the answer
		// asserts is fabricated.
		const grounding = [sourcesText || '', questionText || '', knownText || ''].join('\n');
		const v = aiGuardrails.verifyGroundedEntities(out, grounding);

		if (v.anyUnverified) {
			if (shareData && shareData.Common && typeof shareData.Common.logger === 'function') {
				shareData.Common.logger('AI grounding: answer asserts entities absent from tool results — dealIds=' + JSON.stringify(v.unverifiedDealIds) + ' pairs=' + JSON.stringify(v.unverifiedPairs));
			}

			const fabIds = Array.isArray(v.unverifiedDealIds) ? v.unverifiedDealIds : [];
			const fabPairs = Array.isArray(v.unverifiedPairs) ? v.unverifiedPairs : [];
			// "Data context" = there is real grounding in play this conversation: live tool results this turn
			// OR entities already established earlier. Only then does a tool-less answer that invents an
			// identifier get replaced wholesale — because a bare concept/general reply (no tool data, nothing
			// established) that names a pair as an illustration ("e.g. BTC/USD") is legitimate and must be left
			// alone. Deliberately NOT keyed on question keywords: many concept questions contain trading terms
			// ("how does take profit work?", "what does a deal id look like?") and must not be treated as data.
			const dataContext = !!sourcesText || !!(knownText && knownText.trim());

			// A fabricated DEAL ID must never reach the user — a specific id is never a legitimate example.
			if (fabIds.length) {
				if (!sourcesText && dataContext) {
					// No fresh tool grounding and the id isn't from history either → the answer is invented.
					return aiGuardrails.sanitizeEgress(UNGROUNDED_FALLBACK);
				}
				// Otherwise redact just the fabricated id token(s), keeping the grounded remainder, + caveat.
				for (const id of fabIds) { out = out.split(id).join('[unverified id]'); }
				if (typeof out === 'string' && out && out.indexOf(FIGURE_CAVEAT.trim()) === -1) { out += FIGURE_CAVEAT; }
			}
			// A fabricated PAIR is normally a SOFT signal — a concept reply legitimately names a pair as an
			// illustration ("e.g. BTC/USD"), and text alone can't tell that apart from a single invented one.
			// So ONE off-result pair, when the answer was grounded in live tool data this turn, is only
			// caveated (and a sources-free concept/general reply is left untouched). But SEVERAL pairs that are
			// all absent from the tool data is no longer an illustration — it is a fabricated ENUMERATION (the
			// "list my deals" answer inventing positions the user does not hold). That fails closed exactly like
			// a fabricated deal id: replace the whole answer with the grounded-path invitation rather than ship
			// an invented list under a caveat. The threshold is conservative (no normal grounded answer names
			// three-plus pairs the tools never returned), so a legitimate one/two-pair comparison is unaffected.
			else if (fabPairs.length && sourcesText) {
				if (fabPairs.length >= FABRICATED_PAIR_LIST_MIN) {
					return aiGuardrails.sanitizeEgress(UNGROUNDED_FALLBACK);
				}
				if (typeof out === 'string' && out && out.indexOf(FIGURE_CAVEAT.trim()) === -1) { out += FIGURE_CAVEAT; }
			}
		}
	}
	catch (e) { /* advisory only — never block the answer */ }

	// Fabricated HYBRID id — a slash PAIR fused with a deal-id-style "-suffix-epoch" ("XRP/USD-123456-7890").
	// A real deal id uses an UNDERSCORE ("XRP_USD-…"), and a real pair carries no numeric suffix, so this exact
	// slash-plus-suffix shape is ALWAYS a model invention (it slips past the underscore-only deal-id check
	// above). Redact any that a typo-broken model loop emitted and that is absent from this turn's tool results,
	// so a fabricated identifier never reaches the user under a mere caveat.
	try {
		if (typeof out === 'string' && out) {
			const hybridRe = /\b[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}-[A-Za-z0-9]{3,12}-\d{4,}\b/g;
			const hybrids = Array.from(new Set(out.match(hybridRe) || [])).filter(h => !sourcesText || sourcesText.indexOf(h) === -1);
			if (hybrids.length) {
				for (const h of hybrids) { out = out.split(h).join('[unverified id]'); }
				if (out.indexOf(FIGURE_CAVEAT.trim()) === -1) { out += FIGURE_CAVEAT; }
			}
		}
	}
	catch (e) { /* advisory only */ }

	// Bot-subject grounding. A bot NAME the user supplies is treated as grounded by the entity check above
	// (questionText is in its grounding set), which is right for deal ids and pairs — but a bot name the user
	// invents is a fabrication trap: handed the full bot ranking, the weak model relabels the top bot with the
	// made-up name and reports its figures. So bot names are grounded ONLY against real data (this turn's tool
	// results), never the question. If the user explicitly named a bot that matches NONE of the real bots the
	// tools returned, fail closed with the actual bot list rather than ship invented figures under a fake name.
	try {
		if (sourcesText && typeof out === 'string' && out) {
			const named = aiGuardrails.extractNamedBotSubject(questionText || '');
			if (named) {
				// Build the bot-name oracle from the AUTHORITATIVE bot list (every configured bot, including
				// ones with no completed deals — the performance ranking omits those, so it can't be the oracle
				// or a real but idle bot would be wrongly rejected). The caller fetches that list once and passes
				// it as opts.botNames (finalizeAnswer is synchronous, so it can't query the store itself); fall
				// back to the tool results only when the caller supplied none (e.g. the Hub proxy path).
				const realBots = [];
				if (opts && Array.isArray(opts.botNames)) { for (const b of opts.botNames) { if (b && realBots.indexOf(b) === -1) { realBots.push(b); } } }
				if (!realBots.length) {
					const re = /"(?:botName|bot)"\s*:\s*"([^"]+)"/g;
					let m;
					while ((m = re.exec(sourcesText)) !== null) { if (realBots.indexOf(m[1]) === -1) { realBots.push(m[1]); } }
					const avail = /"available_bots"\s*:\s*\[([^\]]*)\]/.exec(sourcesText);
					if (avail) { const names = avail[1].match(/"([^"]+)"/g) || []; for (const q of names) { const b = q.slice(1, -1); if (realBots.indexOf(b) === -1) { realBots.push(b); } } }
				}
				// Only enforce when we actually have a real bot-name oracle this turn — that is exactly when the
				// relabel fabrication is possible (the model was handed the bot list).
				if (realBots.length) {
					const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
					const n = norm(named);
					const known = realBots.some((b) => { const bn = norm(b); return bn === n || bn.includes(n) || n.includes(bn); });
					if (!known) {
						if (shareData && shareData.Common && typeof shareData.Common.logger === 'function') {
							shareData.Common.logger('AI bot grounding: question named a bot absent from the account (' + named + ') — failing closed');
						}
						const list = realBots.slice(0, 12).join(', ');
						return aiGuardrails.sanitizeEgress('You don\'t have a bot named "' + named + '". Your bots are: ' + list + '. Ask me about any of those and I\'ll pull its performance.');
					}
				}
			}
		}
	}
	catch (e) { /* advisory only — never block the answer */ }

	// Deterministic numeric grounding — the FREE number check that flags figures absent from the tool
	// results. This ALWAYS runs, even when `verify` is on: the faithfulness JUDGE is a weak local model
	// that has been seen to stamp a positive "✓ checked" tick on FABRICATED figures (e.g. inventing a deal
	// for a pair the user does not hold). The deterministic check is the authoritative backstop — when it
	// finds an ungrounded figure it appends the caveat, and the later tick-reconciliation then strips any
	// false ✓, so a made-up number can never ship under a confidence stamp. No extra model call.
	try {
		if (sourcesText && typeof out === 'string' && out && out.indexOf(FIGURE_CAVEAT.trim()) === -1) {
			const chk = analysisGuard.checkNumbers(out, sourcesText);
			if (chk && Array.isArray(chk.ungrounded) && chk.ungrounded.length > 0) {
				out += FIGURE_CAVEAT;
			}
		}
	}
	catch (e) { /* advisory only — never block the answer */ }

	// Axiom pass: deterministic DOMAIN-INVARIANT checks over the finished answer (does it
	// contradict a fact the tool results state, or break a rule of the domain?), separate from
	// the grounding checks above (did every id/figure come from the results?). Read-only, no
	// model call, and fully wrapped — a violation only ever redacts a template token or appends
	// the existing uncertainty caveat, and any failure here is ignored so an answer is never blocked.
	try {
		const flags = axioms.evaluate({ answer: out, sourcesText: sourcesText || '', questionText: questionText || '' });
		if (flags && flags.length) {
			let caveated = out.indexOf(FIGURE_CAVEAT.trim()) !== -1;
			for (const f of flags) {
				if (f.severity === 'correct' && f.correct && f.correct.find && out.indexOf(f.correct.find) !== -1) {
					// The axiom holds the authoritative value and rewrote the wrong figure in place — apply
					// it and add NO caveat: the number is now correct, so a "double-check" note would be
					// misleading. Only a correction that can't be located falls through to the caveat below.
					out = out.split(f.correct.find).join(f.correct.replace);
					continue;
				}
				if (f.severity === 'redact' && Array.isArray(f.redact)) {
					for (const tok of f.redact) { if (tok) { out = out.split(tok).join('[unavailable]'); } }
				}
				if (!caveated) { out += FIGURE_CAVEAT; caveated = true; }
			}
			if (shareData && shareData.Common && typeof shareData.Common.logger === 'function') {
				shareData.Common.logger('AI axioms: ' + flags.map(f => f.axiom + ' (' + f.detail + ')').join('; '));
			}
		}
	}
	catch (e) { /* advisory only — never block the answer */ }

	// Safety reconciliation: a positive "checked" tick and the uncertainty caveat must never coexist in one
	// answer. If some combination of paths produced both, the WARNING wins — false assurance is worse than an
	// extra note of caution — so any positive tick line is stripped, leaving only the caveat.
	try {
		if (typeof out === 'string' && out.indexOf(FIGURE_CAVEAT.trim()) !== -1 && /_✓ [^\n]*_/.test(out)) {
			// Anchor on a preceding newline OR the very start of the answer, so a tick the model emitted as
			// the first line (no leading newline) is stripped too, not just an appended one.
			out = out.replace(/(?:\n+|^)_✓ [^\n]*_/g, '');
		}
	}
	catch (e) { /* advisory only */ }

	// Final tidy AFTER all redaction: the axiom/grounding pass above can leave a dash-joined run of the
	// "[unavailable]" stand-in when a multi-part id was dropped part-by-part (or a stranded currency prefix).
	// sanitizeEgress ran before that redaction, so the collapse has to happen here, at the true end of the path.
	out = aiGuardrails.tidyRedactionMarkers(out);

	// A TRUSTED answer is a deterministic render straight from the tool payload (the open-deals summary /
	// breakdown / ranking) — grounded by construction, so the "may not be fully supported" uncertainty caveat
	// is wrong and undercuts it. Strip any such caveat and mark it checked. (The axiom pass above still ran, so
	// a genuine inconsistency would already have corrected the figure before this point.)
	if (opts && opts.trusted && typeof out === 'string') {
		out = out.replace(/\n*_⚠️[^\n]*_\s*$/i, '').trimEnd();
		if (!/_✓[^\n]*_/.test(out)) { out += '\n\n_✓ Figures checked against your data._'; }
	}

	// SAFETY NET: if sanitizing a non-empty MODEL answer stripped it to nothing (a reply that was ENTIRELY
	// machinery narration or an exfil vector, with no substance left once removed), never ship a blank
	// message — return a short honest fallback instead. Trusted renders are always substantive, so this only
	// guards the model paths.
	if (!(opts && opts.trusted) && (typeof out !== 'string' || out.trim() === '')
		&& typeof answer === 'string' && answer.trim() !== '') {
		return 'I can\'t give a reliable answer to that from your data right now. You can ask about your open deals, bots, balances, or how a specific part of SymBot works.';
	}

	return out;
}


// Grounding ENFORCEMENT (upgrade of the advisory entity check): if a composed answer cites a deal id — or
// enumerates several trading pairs — that appear in NO tool result from this turn (the classic fabricated-
// identifier / invented-position-list bug), re-ask the model once to answer using only entities the tools
// actually returned. One extra call, and only when a fabrication is detected (rare), so the fast path pays
// nothing. Returns the re-grounded answer, or the original if there is nothing to fix or the retry fails.
async function reGroundIfNeeded(convo, model, answer, sourcesText) {

	try {
		const v = aiGuardrails.verifyGroundedEntities(answer, sourcesText || '');
		// Re-ground on a fabricated deal id (a single wrong id is always worth fixing) OR on a fabricated
		// pair ENUMERATION — several pairs absent from the tool data, i.e. an invented position list. Both
		// get ONE grounded retry here so the model can self-correct from the real rows before finalizeAnswer's
		// fail-closed backstop replaces the answer wholesale. A lone off-result pair (possible example) is left
		// to the softer caveat path, so this never fires on a legitimate one-pair mention.
		const badIds = Array.isArray(v.unverifiedDealIds) ? v.unverifiedDealIds : [];
		const badPairs = (Array.isArray(v.unverifiedPairs) && v.unverifiedPairs.length >= FABRICATED_PAIR_LIST_MIN) ? v.unverifiedPairs : [];
		if (!badIds.length && !badPairs.length) { return answer; }

		const adapter = providerAdapters[aiProvider];
		if (!adapter || !aiClient || typeof adapter.createNonStream !== 'function' || typeof adapter.extractNonStreamContent !== 'function') { return answer; }

		const bad = badIds.concat(badPairs).join(', ');
		const msgs = convo.concat([ { role: 'user', content: 'Your previous answer referenced ' + bad + ', which do NOT appear in any tool result from this turn. Re-answer using ONLY deal ids, pairs and figures that appear verbatim in the tool results above; do not mention ' + bad + ' or anything a tool did not return. If you cannot identify it from the tool results, say so plainly.' } ]);

		const res = await adapter.createNonStream(aiClient, model, msgs, undefined, undefined);
		const out = (adapter.extractNonStreamContent(res) || '').trim();

		if (out) {
			if (shareData && shareData.Common && typeof shareData.Common.logger === 'function') { shareData.Common.logger('AI grounding: re-grounded answer after ungrounded entities: ' + bad); }
			return out;
		}
		return answer;
	}
	catch (e) { return answer; }
}


// ── Deterministic deal-report shortcut helpers ───────────────────────────
// A verb/intent that means "tell me about this deal": analyze, report, diagnose, status, why, etc.
// Matched as word STEMS with a leading \b and NO trailing \b, so a stem also matches its inflections —
// "analy" catches analyze / analyze / analysis / analytics, "diagnos" catches diagnose / diagnosis,
// "evaluat" catches evaluate / evaluation. (A trailing \b broke this: it failed on "analyze" because
// the stem is followed by another letter, so "detailed analysis of" matched but a bare "analyze" did not.)
const DEAL_REPORT_INTENT_RE = /\b(analy|assess|evaluat|diagnos|review|detail|break[\s-]?down|status|report|summar|overview|explain|deep[\s-]?dive|walk me through|look at|checking|check on|tell me about|what about|how about|what'?s (?:going on|happening|up) with|how'?s|how is|how are|why (?:is|are|did|isn'?t|hasn'?t))/i;
// Multi-deal / comparison questions belong in the tool loop, not this single-deal shortcut.
const DEAL_COMPARE_RE = /\b(compare|comparison|versus|vs\.?|against|other deals?|all (?:my |your )?deals?|rest of|which deal|between)\b/i;

// True when a message is centered on ONE deal id and asks to report/analyze it — i.e. a good fit for the
// deterministic shortcut. Comparison questions are excluded; a message that is essentially just the id
// (no other words) also qualifies, since that too means "show me this deal".
function looksLikeDealReportRequest(text) {

	const s = String(text || '');
	if (DEAL_COMPARE_RE.test(s)) { return false; }
	if (DEAL_REPORT_INTENT_RE.test(s)) { return true; }
	// Just the id (or the id plus a couple of filler characters) → treat as "show me this deal".
	const residue = s.replace(aiGuardrails.DEAL_ID_RE || /\b[A-Z0-9]{1,12}_[A-Z0-9]{2,10}-[A-Z0-9]{4,12}-\d{6,}\b/g, ' ').replace(/[^a-z]/gi, '');
	return residue.length < 4;
}

// True when the conversation so far is account-data grounded, so a bare continuation follow-up ("tell me
// more") is asking to expand on real figures and must re-ground rather than be answered tool-free. Prefers
// the tracked entities (deal ids / pairs surfaced by earlier tool turns); falls back to scanning the most
// recent assistant reply for a deal id or trading pair. Best-effort and side-effect free.
function recentContextIsData(roomData) {

	try {

		const ent = roomData && roomData.recentEntities;

		if (ent && ((Array.isArray(ent.dealIds) && ent.dealIds.length) || (Array.isArray(ent.pairs) && ent.pairs.length))) {
			return true;
		}

		const history = roomData && Array.isArray(roomData.messages) ? roomData.messages : [];

		for (let i = history.length - 1; i >= 0; i--) {

			const m = history[i];
			if (!m || m.role !== 'assistant' || !m.content) { continue; }

			const text = String(m.content);
			// Fresh, non-global regexes: the exported DEAL_ID_RE carries /g, whose lastIndex would make
			// .test() stateful and flaky across calls. A deal id, or a bare trading pair, means data.
			if (aiGuardrails.containsDealId(text)
				|| /\b[A-Z0-9]{2,12}[/_][A-Z0-9]{2,10}\b/.test(text)) {
				return true;
			}
			// An OPERATIONAL-data answer carries no deal id or pair (an aggregate deals/errors/status summary
			// — "9 deals, 1 in profit, 8 underwater, total P/L -673.9") but is still grounded data the user
			// follows up on ("tell me more"). Recognize it by a digit next to an operational-data noun so the
			// continuation RE-GROUNDS via the tools (or fail-closed abstains) instead of falling to the
			// tool-free lane and FABRICATING a deal list. Biased toward data — re-grounding is always safe.
			if (/\b\d[\d,.]*\b[^.\n]{0,45}\b(deals?|positions?|trades?|errors?|warnings?|safety\s+orders?|in\s+profit|underwater|unrealized|unrealized|realized|win\s+rate|p\/?l|profit|loss|uptime|memory|balance|open|closed|completed)\b/i.test(text)
				|| /\b(deals?|positions?|errors?|safety\s+orders?|win\s+rate|underwater|in\s+profit|open|closed)\b[^.\n]{0,45}\b\d/i.test(text)) {
				return true;
			}
			break;   // only the latest assistant reply matters for a follow-up
		}

	} catch (e) { /* best-effort: fall through to fast-lane */ }

	return false;
}

// True when the recent turn was about the user's DEALS PORTFOLIO — the case where a follow-up ("tell me more",
// "in detail", "break them down") should ENUMERATE the deals. Keyed on the user's own last QUESTION (stable —
// "how are my deals?", "my open deals") first, since the weak model's summary WORDING varies and can even
// drift off-topic; falls back to the assistant reply looking like a portfolio summary (a deal count plus a
// profit/loss signal). A reply that already named a single specific deal id is a per-deal answer, not a
// portfolio, so it is excluded.
function recentTopicIsDealsPortfolio(roomData) {
	const msgs = roomData && Array.isArray(roomData.messages) ? roomData.messages : [];
	// Walk back through the user turns to the substantive question that SET the topic, skipping the current
	// continuation AND any earlier chained continuations. A SECOND follow-up ("tell me more" after "tell me in
	// greater detail") must still resolve to the original "how are my deals?" — otherwise it tests the first
	// follow-up ("in greater detail"), which matches no deals pattern, the deterministic breakdown never fires,
	// and the weak model is left to FABRICATE a deal list. Only continuations are skipped, so an unrelated
	// substantive question in between correctly ends the topic.
	let seenUser = 0;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (!m || !m.content) { continue; }
		if (m.role === 'user') {
			seenUser++;
			if (seenUser < 2) { continue; }   // skip the current continuation turn
			const q = String(m.content);
			if (aiGuardrails.looksLikeContinuation(q)) { continue; }   // skip a chained "tell me more" question
			const dealsPortfolioQ = /\b(?:my|our|the|all|open|active|current)\s+(?:open\s+|active\s+)?(?:deals?|positions?|trades?|portfolio|bags)\b/i.test(q)
				|| /\bhow\s+(?:are|is|'?s)\s+(?:my|the|things|it)\b/i.test(q)
				|| /\b(?:deals?|positions?)\s+(?:doing|going|status|look)/i.test(q);
			const singleDealQ = aiGuardrails.containsDealId(q);
			if (dealsPortfolioQ && !singleDealQ) { return true; }
			break;   // the first substantive (non-continuation) question decides the topic
		}
	}
	// Fallback: the latest assistant reply is a portfolio SUMMARY or our own deterministic BREAKDOWN render —
	// so a follow-up after either one still enumerates the deals rather than falling through to the model.
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (!m || m.role !== 'assistant' || !m.content) { continue; }
		const t = String(m.content);
		// The breakdown render's stable header (see formatOpenDealsBreakdown). It enumerates pairs but no deal
		// id, so the summary's count/state heuristic below misses it — match it explicitly.
		if (/here is each of your open deals\b/i.test(t)) { return true; }
		// Our deterministic RANKING render — a single pick ("Your worst-performing … open deal is PAIR, …")
		// or a top-N list ("… open deals (top N …), ranked by …"). It names one deal and carries no total
		// count, so the count heuristic below misses it, yet it IS a deals-portfolio answer: a superlative
		// follow-up ("which is the worst?" → "and the best?") must re-rank rather than fall to the model.
		if (/\bopen deal is\b/i.test(t) || /\bopen deals \(top \d/i.test(t) || /\branked by\b/i.test(t)) { return true; }
		const hasCount = /\b\d+\s+(?:open\s+|active\s+)?(?:deals?|positions?|trades?)\b/i.test(t);
		const hasState = /\b(?:in\s+profit|underwater|unrealized|unrealized|p\/?l|profit|loss|losing|winning)\b/i.test(t);
		const singleDeal = aiGuardrails.containsDealId(t);
		return hasCount && hasState && !singleDeal;
	}
	return false;
}

// True when the recent turn was a RECENT-ERRORS survey — so a follow-up ("tell me more", "in detail") should
// expand the error detail, NOT drift to the deals view or fall to the model (which was observed to pivot to an
// unrelated open-deals dump). Keyed on the user's previous QUESTION matching the errors intent (stable), with a
// fallback to the last assistant reply looking like the errors render.
function recentTopicIsRecentErrors(roomData) {
	const msgs = roomData && Array.isArray(roomData.messages) ? roomData.messages : [];
	let seenUser = 0;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (!m || !m.content) { continue; }
		if (m.role === 'user') {
			seenUser++;
			if (seenUser < 2) { continue; }   // skip the current continuation turn
			const q = String(m.content);
			if (aiGuardrails.looksLikeContinuation(q)) { continue; }   // skip a chained "tell me more" — reach the topic-setting question
			if (recentErrorsIntent(q)) { return true; }
			break;   // the first substantive (non-continuation) question decides the topic
		}
	}
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (!m || m.role !== 'assistant' || !m.content) { continue; }
		const t = String(m.content);
		return /\b\d+\s+errors?\s+logged\b/i.test(t) || /each error type with real log lines/i.test(t) || /no errors were logged/i.test(t);
	}
	return false;
}

// Parse the DEAL-ANALYSIS provenance marker from ONE analysis-prompt string. The analysis prompt (built by
// aiAnalyzeDealView) carries a stable "Data provenance:" line stating whether the report was computed from
// live OHLCV candles or from fallback estimates. Returns { used, timeframe, candles } or null. Shared by the
// conversation scanner below AND the report footer (DCABotManager), so the report and the follow-up answer
// read the SAME source.
function parseAnalysisProvenance(text) {
	const t = String(text || '');
	if (/This analysis WAS computed from live OHLCV candle data/i.test(t)) {
		const tf = (t.match(/live OHLCV candle data \(([^,)]+?)\s*timeframe/i) || [])[1];
		const cd = (t.match(/,\s*(\d+)\s*candles/i) || [])[1];
		return { used: true, timeframe: tf ? tf.trim() : '', candles: cd ? Number(cd) : null };
	}
	if (/Live OHLCV candle data was NOT available/i.test(t)) {
		return { used: false, timeframe: '', candles: null };
	}
	return null;
}

// One user-facing sentence naming the analysis's data source, from the parsed provenance. Shared by the
// report footer (shown on every analysis) and the "did you use OHLCV?" follow-up answer, so both say exactly
// the same thing. Returns '' when provenance is unknown.
function analysisProvenanceText(prov) {
	if (!prov) { return ''; }
	return prov.used
		? ('This analysis was computed from live OHLCV candle data'
			+ (prov.timeframe ? ' (' + prov.timeframe + (prov.candles ? ', ' + prov.candles + ' candles' : '') + ')' : '')
			+ '. The market-condition figures — Trend, RSI, Volatility, ATR and the Market Score — are technical indicators derived directly from those candles.')
		: 'Live OHLCV candle data was not available for this analysis (the exchange returned too few candles, or none), so the market-condition values shown are fallback estimates rather than OHLCV-derived indicators.';
}

// Read the deal-analysis data provenance from the conversation. A weak model has been observed to DENY using
// OHLCV on a follow-up despite the prompt's provenance note, so a deterministic responder reads it here (the
// note lives in the analysis PROMPT — a user turn) and answers authoritatively. Returns { used, timeframe,
// candles } or null when no marker is present (not a deal analysis, or it was compressed away).
function analysisDataProvenance(roomData) {
	try {
		const msgs = (roomData && Array.isArray(roomData.messages)) ? roomData.messages : [];
		for (let i = msgs.length - 1; i >= 0; i--) {   // newest-first: the marker lives in the analysis PROMPT
			const m = msgs[i];
			if (!m || m.role !== 'user' || !m.content) { continue; }
			const prov = parseAnalysisProvenance(m.content);
			if (prov) { return prov; }
		}
	}
	catch (e) { /* best-effort: no marker → caller falls through to the model */ }
	return null;
}

// "did you use OHLCV?", "was candle/market data used?", "did you use live prices?", "where did the indicators
// come from?" — a follow-up asking what DATA the analysis was based on. Requires both a data-source noun and
// a usage/origin word so an ordinary market question ("what's the RSI mean?") doesn't match.
function looksLikeAnalysisDataSourceQuestion(text) {
	const s = String(text || '').trim();
	if (!s || s.split(/\s+/).length > 16) { return false; }
	const mentionsData = /\b(ohlcv|candles?|candle\s+data|market\s+data|live\s+prices?|price\s+data|price\s+feed|technical\s+indicators?|the\s+indicators?)\b/i.test(s);
	if (!mentionsData) { return false; }
	return /\b(use|used|using|based|come\s+from|from|source|include[ds]?|consider(?:ed)?|factor(?:ed)?|rel(?:y|ied)|pull(?:ed)?|fetch(?:ed)?|did\s+you|do\s+you|was\s+it|were\s+they|real|actual|actually)\b/i.test(s);
}

// A portfolio-STATUS question about the user's open deals ("how are my deals?", "how's my portfolio doing?")
// — the case where the weak model drifts (deflects to "check the Active Deals tab") or, worse, fabricates.
// Render the one-line summary deterministically from real data instead. Excludes a specific deal id (a
// per-deal question), a ranking superlative (a different view), and how-to / definitional framings.
function looksLikeDealsStatusQuestion(text) {
	const s = String(text || '').trim();
	if (!s || s.split(/\s+/).length > 10) { return false; }
	if (aiGuardrails.containsDealId(s)) { return false; }
	if (/\b(biggest|worst|best|most|least|closest|furthest|nearest|top|highest|lowest|winning|losing|which)\b/i.test(s)) { return false; }
	if (aiGuardrails.looksLikeHowTo(s) || aiGuardrails.looksLikeDefinitional(s)) { return false; }
	// The "are/is/'s" after "how" is OPTIONAL so BOTH word orders match: "how ARE my deals doing" and the
	// equally common "how my deals ARE doing" (where the verb trails the noun). Without this, the second form
	// fell through to the model — which then answered a simple status question in prose under an uncertainty
	// caveat. The how-to / definitional / ranking guards above still exclude "how do my deals work" etc.
	return /\bhow\s+(?:are\s+|is\s+|'?s\s+)?(?:my|the|our)\s+(?:open\s+|active\s+)?(?:deals?|positions?|trades?|portfolio|bags)\b/i.test(s)
		|| /\b(?:status|state|health|overview|summary|recap|rundown)\s+of\s+(?:my|the|our)\s+(?:open\s+|active\s+)?(?:deals?|positions?|portfolio)\b/i.test(s)
		// A trailing status verb, allowing an intervening "are/is" ("my deals are doing", "positions look").
		|| /\b(?:my|the|our)\s+(?:open\s+|active\s+)?(?:deals?|positions?|portfolio)\s+(?:are\s+|is\s+)?(?:doing|going|looking|performing|status|overall|right now|today|at the moment)\b/i.test(s)
		|| /\bare\s+(?:my|the|our)\s+(?:open\s+|active\s+)?(?:deals?|positions?)\s+(?:ok|okay|doing|alright|fine|good|bad|healthy)\b/i.test(s);
}

// Deterministic bot count from the real list_bots data — the authoritative total, how many are active, and
// their names (capped). Never invents. Returns null when the data is unavailable.
function formatBotsCount(res) {
	if (!res || res.success === false || !Array.isArray(res.bots)) { return null; }
	const bots = res.bots;
	const total = (typeof res.count === 'number') ? res.count : bots.length;
	const active = bots.filter(b => b && b.active).length;
	let s = 'You have ' + total + ' bot' + (total === 1 ? '' : 's');
	if (total > 0) { s += ' (' + active + ' active)'; }
	s += '.';
	const names = bots.map(b => b && b.botName).filter(Boolean);
	if (names.length) {
		const shown = names.slice(0, 12);
		s += ' ' + (names.length === 1 ? 'It is' : 'They are') + ': ' + shown.join(', ') + (names.length > shown.length ? ', …' : '') + '.';
	}
	return s;
}

// Deterministic per-bot OPEN-DEAL distribution from the tool's authoritative by_bot rollup (a group-by on
// the live open-deals list). Answers "how many open deals does each bot have?" (breakdown) and "which bot
// has the most open deals?" (the single busiest, with ties handled) — instant and grounded, replacing a
// slow/hanging model loop. Bots with zero open deals do not appear in the rollup, so the breakdown notes it.
// Returns null on missing data so the caller falls through rather than mis-stating.
function formatPerBotDeals(res, spec) {
	if (!res || res.success === false || !Array.isArray(res.by_bot)) { return null; }
	const rows = res.by_bot;
	const total = (res.open_deals_total != null) ? res.open_deals_total : rows.reduce((a, b) => a + (b.count || 0), 0);
	if (!rows.length) {
		return total === 0
			? 'You have no open deals right now, so none of your bots have any active deals.'
			: null;
	}
	// When the fetch hit its 100-deal bound, deals beyond it were not grouped, so BOTH the "most" pick and
	// the per-bot counts could undercount — disclose it in every branch rather than only the breakdown.
	const capNote = res.by_bot_capped ? ' (Counted from the first 100 open deals, so this may undercount.)' : '';
	if (spec && spec.most) {
		const top = rows[0].count;
		const leaders = rows.filter(r => r.count === top);
		if (leaders.length > 1) {
			return 'Your bots are tied for the most open deals: ' + leaders.map(r => r.botName).join(', ')
				+ ' each have ' + top + ' of your ' + total + ' open deals.' + capNote;
		}
		return 'The bot with the most open deals is ' + rows[0].botName + ' with ' + top
			+ ' of your ' + total + ' open deals.' + capNote;
	}
	const lines = rows.map(r => '• ' + r.botName + ': ' + r.count + (r.count === 1 ? ' open deal' : ' open deals'));
	let body = 'Open deals by bot (' + total + ' total across ' + rows.length + (rows.length === 1 ? ' bot' : ' bots') + '):\n' + lines.join('\n');
	body += '\n\nAny of your bots not listed here have no open deals right now.';
	if (capNote) { body += capNote; }
	return body;
}

// COMPOUND concept+data: when a turn asks for DATA and ALSO to explain a concept ("how many of my deals are
// underwater, and what does underwater mean?"), the deterministic data render answers the DATA half; this
// appends a short model explanation of the CONCEPT half. Per the 2026 compound-query research: render the data
// block, then hand the weak model ONLY the concept sub-question, forbidden from restating or inventing any
// figure/deal (the data is already shown). The concept text is sanitized and any stray $-figure / deal-id
// sentence is dropped, so the append can never smuggle in fabricated account specifics. Precision-biased: it
// fires only when a definitional/concept clause is joined by a conjunction, so a pure data question pays no
// model call. Returns the body unchanged on anything unexpected; never throws.
async function appendConceptForCompound(dataBody, question, model) {
	try {
		const q = String(question || '');
		if (!dataBody || q.split(/\s+/).length < 6) { return dataBody; }
		if (!(aiGuardrails.looksLikeDefinitional(q) || aiGuardrails.looksLikeConceptQuestion(q))) { return dataBody; }
		if (!/,?\s+(?:and|&|;|also|plus)\s+/i.test(q)) { return dataBody; }
		const clauses = q.split(/,?\s+(?:and|&|;|also|plus)\s+/i).map(c => c.trim()).filter(Boolean);
		const conceptClause = clauses.find(c => aiGuardrails.looksLikeDefinitional(c) || /\b(?:what (?:is|are|does|do)|explain|how does|why|means?)\b/i.test(c));
		if (!conceptClause || conceptClause.split(/\s+/).length < 2) { return dataBody; }
		const sys = PERSONA + '\n\nExplain ONLY the following concept, in 1-3 plain sentences. Do NOT restate, list, recompute, or invent any deal, id, count, price, percentage, or dollar figure — the user has already been shown their data separately. Explain the concept in general terms.';
		const raw = await withTimeout(completePrompt([ { role: 'system', content: sys }, { role: 'user', content: conceptClause } ], model, { temperature: 0.2 }), 15000).catch(() => '');
		let clean = (typeof raw === 'string') ? aiGuardrails.sanitizeEgress(raw).trim() : '';
		if (!clean) { return dataBody; }
		// Drop any sentence that slipped in a $-figure or a deal id — a concept explanation carries no specifics.
		// This uses a DELIBERATELY looser id shape than aiGuardrails.containsDealId (a 4+ digit epoch, not 6+)
		// so even a truncated/typo'd id in a concept sentence is dropped; it is fused with the $-figure test in
		// one alternation, so it stays inline rather than using the shared predicate.
		clean = clean.split(/(?<=[.!?])\s+/).filter(sent => !/[$€£]\s?-?\d|\b[A-Z0-9]{1,12}_[A-Z0-9]{2,10}-[A-Z0-9]{4,12}-\d{4,}\b/.test(sent)).join(' ').trim();
		return clean ? (dataBody + '\n\n' + clean) : dataBody;
	}
	catch (e) { return dataBody; }
}

// The bot CONFIG settings a "what's my <setting>?" question can ask for, mapped to the list_bots field. A
// config setting is a STORED number in the bot config (take-profit %, max safety orders, price step, order
// sizes) — a discrete keyed value a weak model would otherwise invent a plausible-but-wrong figure for, so it
// is answered by a deterministic render, never generated.
const BOT_CONFIG_SETTINGS = [
	{ field: 'takeProfitPercent', unit: '%', label: 'take-profit percentage', re: /\btake[- ]?profit\b|\btp\b/i },
	{ field: 'maxSafetyOrders', unit: '', label: 'maximum safety orders', re: /\b(?:max(?:imum)?|most|limit|how many|number of)\b[^.\n]{0,24}\b(?:safety[- ]?orders?|\bso\b)|\b(?:safety[- ]?orders?)\b[^.\n]{0,24}\b(?:max(?:imum)?|most|limit|at most|allowed)\b/i },
	{ field: 'priceStepPercent', unit: '%', label: 'price step between safety orders', re: /\b(?:price\s+)?(?:deviation|step|order[- ]?step|price[- ]?step|spacing|drop)\b/i },
	{ field: 'firstOrderAmount', unit: '', label: 'base order size', re: /\b(?:base|first|initial)\s+order\b[^.\n]{0,16}\b(?:size|amount|how (?:big|much))?|\b(?:size|amount) of[^.\n]{0,12}\b(?:base|first)\s+order\b/i },
	{ field: 'safetyOrderAmount', unit: '', label: 'safety order size', re: /\bsafety[- ]?order\s+(?:size|amount)\b|\b(?:size|amount) of[^.\n]{0,12}safety[- ]?order/i },
	{ field: 'maxActiveDeals', unit: '', label: 'maximum active deals per bot', re: /\bmax(?:imum)?\s+(?:active\s+)?deals?\b|\bdeals?\s+(?:max|limit|at once)\b/i }
];

// A CONFIG / SETTINGS question about the user's bots ("what take-profit % are my bots using?", "how many
// safety orders max?", "what deviation step am I using?"). Returns the matched setting spec, or null. Excludes
// a concept/how-to/definitional framing ("what does the step control?"), a specific deal id, and a LIVE per-
// deal question ("what's the price on my BTC deal right now?") — those are not the configured setting. The
// research's guard: config vocabulary overlaps live-deal vocabulary, so a "right now / current / on my X deal"
// cue routes AWAY from config to the live path.
function botConfigIntent(text) {
	const s = String(text || '').trim();
	if (!s || s.split(/\s+/).length > 22) { return null; }
	if (aiGuardrails.looksLikeDefinitional(s) || aiGuardrails.looksLikeHowTo(s)) { return null; }   // concept, not a value
	if (aiGuardrails.containsDealId(s)) { return null; }          // a specific deal
	if (/\b(right now|currently|live|at the moment|on (?:my|the) [A-Z0-9]{2,6}(?:\/[A-Z0-9]{2,6})?\b)/i.test(s)) { return null; }   // live per-deal
	// Must read as a question about a SETTING the user HAS/uses/configured.
	const settingFrame = /\b(setting|config(?:ured|uration)?|set to|am i using|do i (?:use|have)|what(?:'?s| is| are)\s+my|how many|how (?:big|much)|max(?:imum)?|using)\b/i.test(s);
	if (!settingFrame) { return null; }
	for (const spec of BOT_CONFIG_SETTINGS) { if (spec.re.test(s)) { return spec; } }
	return null;
}

// Deterministic render of ONE configured bot setting from list_bots data — the real stored value, never an
// invented one. If every bot shares the value it reports the single figure; if bots differ it lists them per
// bot; if the value is not set anywhere it says so plainly (never a 0/placeholder).
function formatBotConfig(res, spec) {
	if (!res || res.success === false || !Array.isArray(res.bots) || !spec) { return null; }
	const bots = res.bots.filter(b => b && b.botName);
	if (!bots.length) { return null; }
	const fmt = (v) => (v == null ? null : (spec.unit === '%' ? round2(v) + '%' : String(round2(v))));
	const vals = bots.map(b => ({ name: b.botName, v: fmt(b[spec.field]) })).filter(x => x.v != null);
	if (!vals.length) { return 'Your ' + spec.label + ' is not set on any of your bots.'; }
	const distinct = Array.from(new Set(vals.map(x => x.v)));
	if (distinct.length === 1) {
		return 'Your ' + spec.label + ' is ' + distinct[0] + (vals.length < bots.length ? ' (on the bots where it is configured)' : (bots.length > 1 ? ' across all your bots' : '')) + '.';
	}
	return 'Your ' + spec.label + ' differs by bot:\n\n' + vals.map(x => '• ' + x.name + ': ' + x.v).join('\n');
}

// Deterministic one-line portfolio summary from the real open-deals data. Never invents figures; if the total
// P/L cannot be a single figure (deals span multiple quote currencies) it reports the per-currency totals
// rather than summing them. Returns null when the data is unavailable.
function formatOpenDealsSummary(res) {
	const total = res && res.open_deals_total;
	if (total == null) { return null; }
	let s = 'You have ' + total + ' open deal' + (total === 1 ? '' : 's');
	const bits = [];
	if (res.open_deals_in_profit != null) { bits.push(res.open_deals_in_profit + ' in profit'); }
	if (res.open_deals_underwater != null) { bits.push(res.open_deals_underwater + ' underwater'); }
	// Stale deals have no live price this cycle, so they are neither "in profit" nor "underwater" — spell
	// that out, otherwise the profit+underwater counts appear not to add up to the total.
	if (res.stale_price_deals != null && res.stale_price_deals > 0) { bits.push(res.stale_price_deals + ' with no live price yet (stale)'); }
	if (bits.length) { s += ' — ' + bits.join(', '); }
	s += '.';
	if (res.total_unrealized_pnl != null) {
		s += ' Total unrealized P/L: ' + res.total_unrealized_pnl + (res.unrealized_currency ? ' ' + res.unrealized_currency : '') + '.';
	}
	else if (res.unrealized_by_currency && typeof res.unrealized_by_currency === 'object') {
		const parts = Object.keys(res.unrealized_by_currency).map(k => res.unrealized_by_currency[k] + ' ' + k);
		if (parts.length) { s += ' Unrealized P/L by currency: ' + parts.join(', ') + ' (not summed — different currencies).'; }
	}
	s += ' Ask me to "list them in detail" for the per-deal breakdown.';
	return s;
}

// A QUANTIFIER / yes-no question about the open-deals profit state — "are ALL my deals underwater?", "is ANY
// in profit?", "do I have more winners or losers?", "am I profitable overall?". The open-deals summary already
// holds the exact counts (total / in profit / underwater / stale-price) and the total P/L, so the answer is a
// deterministic count/sign comparison — never something to let the weak model recompute (~14-22s, and it
// mis-states it). Returns { kind, side } or null. Deliberately CONSERVATIVE: negation and majority/complement
// phrasings ("which are NOT underwater", "aren't losing", "most of") — which the negation literature flags as
// error-prone (a "not" scopes over the quantifier and inverts which count to test) — return null and fall
// through to the model, so a tricky polarity is never mis-answered.
function dealsQuantifierIntent(text) {
	const s = String(text || '').trim();
	if (!s || s.split(/\s+/).length > 16) { return null; }
	if (aiGuardrails.looksLikeHowTo(s) || aiGuardrails.looksLikeDefinitional(s)) { return null; }
	if (aiGuardrails.containsDealId(s)) { return null; }   // a specific deal
	if (/\b(not|aren'?t|isn'?t|none|majority|most of|half)\b/i.test(s) || /\bwhich\b[^.\n]*\bnot\b/i.test(s)) { return null; }   // tricky polarity → model
	const profitSide = /\b(in profit|profitable|winning|winners?|in the green)\b/i.test(s);
	const lossSide = /\b(underwater|in the red|losing|losers?|at a loss)\b/i.test(s);
	// Whole-book PROFITABILITY yes/no ("am I profitable overall?", "am I in the red across everything?").
	if (/\b(am i|is my portfolio|is my account|are my deals?)\b/i.test(s)
		&& (profitSide || lossSide || /\b(making|losing) money\b/i.test(s))
		&& !/\b(all|every|any|each|single|more)\b/i.test(s)) {
		return { kind: 'profitability' };
	}
	if (!profitSide && !lossSide) { return null; }
	// Comparative "more winners or losers".
	if (/\bmore\b/i.test(s) && ((profitSide && lossSide) || /\bor\b/i.test(s))) { return { kind: 'compare' }; }
	const side = (lossSide && !profitSide) ? 'underwater' : (profitSide && !lossSide ? 'profit' : null);
	if (!side) { return null; }
	if (/\b(all|every|each|entirely|every single)\b/i.test(s)) { return { kind: 'all', side: side }; }
	if (/\b(any|some|at least one|a single)\b/i.test(s)) { return { kind: 'any', side: side }; }
	return null;
}

// Deterministic yes/no (or comparison) computed from the open-deals summary counts. Leads with the verdict and
// cites BOTH operands, so the answer is self-checking and never depends on the model. Handles the stale-price
// bucket explicitly (a deal with no live price is counted neither way) and the empty book. Returns null when
// the needed counts are unavailable (or the P/L spans currencies), so the caller falls through to the model.
function formatDealsQuantifier(res, spec) {
	if (!res || res.success === false || !spec) { return null; }
	const total = res.open_deals_total, inP = res.open_deals_in_profit, under = res.open_deals_underwater;
	if (total == null) { return null; }
	if (total === 0) { return 'You have no open deals right now.'; }
	const stale = res.stale_price_deals || 0;
	const staleNote = stale > 0 ? ' (' + stale + ' ' + (stale === 1 ? 'has' : 'have') + ' no live price yet, so ' + (stale === 1 ? "it isn't" : "they aren't") + ' counted either way)' : '';
	if (spec.kind === 'profitability') {
		const pnl = res.total_unrealized_pnl;
		if (pnl == null) { return null; }   // multi-currency → no single sign; fall through
		if (pnl > 0) { return 'Yes — your open deals are up ' + pnl + ' overall right now' + (inP != null ? ' (' + inP + ' of ' + total + ' in profit)' : '') + '.'; }
		if (pnl < 0) { return 'No — your open deals are down ' + pnl + ' overall right now' + (under != null ? ' (' + under + ' of ' + total + ' underwater)' : '') + '.'; }
		return 'You are flat overall right now — unrealized P/L is 0.';
	}
	if (inP == null || under == null) { return null; }
	if (spec.kind === 'compare') {
		if (inP > under) { return 'You have more winning deals: ' + inP + ' in profit vs ' + under + ' underwater' + staleNote + '.'; }
		if (under > inP) { return 'You have more losing deals: ' + under + ' underwater vs ' + inP + ' in profit' + staleNote + '.'; }
		return "It's even — " + inP + ' in profit and ' + under + ' underwater' + staleNote + '.';
	}
	if (spec.kind === 'all') {
		if (spec.side === 'underwater') {
			return (under === total) ? 'Yes — all ' + total + ' of your open deals are underwater.'
				: 'No — ' + under + ' of your ' + total + ' are underwater' + (inP ? ', and ' + inP + ' ' + (inP === 1 ? 'is' : 'are') + ' in profit' : '') + staleNote + '.';
		}
		return (inP === total) ? 'Yes — all ' + total + ' of your open deals are in profit.'
			: 'No — only ' + inP + ' of your ' + total + ' ' + (inP === 1 ? 'is' : 'are') + ' in profit' + (under ? ', and ' + under + ' ' + (under === 1 ? 'is' : 'are') + ' underwater' : '') + staleNote + '.';
	}
	if (spec.kind === 'any') {
		if (spec.side === 'profit') {
			return (inP > 0) ? 'Yes — ' + inP + ' of your ' + total + ' open deals ' + (inP === 1 ? 'is' : 'are') + ' in profit.'
				: 'No — none of your ' + total + ' open deals are currently in profit' + staleNote + '.';
		}
		return (under > 0) ? 'Yes — ' + under + ' of your ' + total + ' ' + (under === 1 ? 'is' : 'are') + ' underwater.'
			: 'No — none of your ' + total + ' open deals are underwater.';
	}
	return null;
}

// Word/number → integer, for relative-day parsing ("two days ago").
const REL_WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14 };
function relNum(tok) { const t = String(tok || '').toLowerCase(); if (/^\d+$/.test(t)) { return parseInt(t, 10); } return REL_WORD_NUM[t] != null ? REL_WORD_NUM[t] : null; }
const REL_NUM_RE = '\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen';

// Resolve the relative-day phrasing of an errors question to day OFFSETS from today (0 = today, 1 = yesterday,
// …) plus a `span` for labeling. Pure; capped at 14 days so a question can't walk the whole archive. Covers a
// SINGLE past day ("two days ago", "the day before yesterday", "yesterday"), a LIST ("yesterday and the day
// before"), a RANGE from today ("last N days", "few days", "this week"), and "today"/default.
function parseRelativeDays(s) {
	const t = String(s || '');
	const cap = (n) => Math.min(Math.max(n, 0), 14);

	let m = t.match(new RegExp('\\b(' + REL_NUM_RE + ')\\s+days?\\s+ago\\b', 'i'));
	if (m) { const n = relNum(m[1]); if (n != null) { return { offsets: [ cap(n) ], span: 'single' }; } }

	if (/\byesterday\s+and\s+(?:the\s+)?days?\s+before(?:\s+(?:that|yesterday))?\b/i.test(t)) { return { offsets: [ 1, 2 ], span: 'list' }; }
	if (/\b(?:the\s+)?days?\s+before\s+yesterday\b/i.test(t)) { return { offsets: [ 2 ], span: 'single' }; }
	if (/\byesterday\b/i.test(t)) { return { offsets: [ 1 ], span: 'single' }; }

	m = t.match(new RegExp('\\b(?:last|past|previous|recent)\\s+(' + REL_NUM_RE + ')\\s+days?\\b', 'i'))
		|| t.match(new RegExp('\\b(' + REL_NUM_RE + ')\\s+days?\\b', 'i'));
	if (m) { const n = relNum(m[1]); if (n != null && n >= 1) { const N = cap(n); const off = []; for (let i = 0; i < N; i++) { off.push(i); } return { offsets: off, span: 'range' }; } }

	if (/\b(few|couple|recent(?:ly)?|lately|this week|past (?:few )?days?|last (?:few )?days?)\b/i.test(t)) { return { offsets: [ 0, 1, 2 ], span: 'range' }; }

	return { offsets: [ 0 ], span: 'single' };   // today / default
}

// "have any of my deals completed/closed recently?" / "recent closed deals" — a request for the RECENTLY
// COMPLETED deals list. The model loop mis-routed this to an aggregate performance tool and fabricated a
// completed-deal id, so render the real list in code. Excludes a specific deal id, how-to/definitional, and
// an OPEN-deals question (those are the summary/count renders). Returns true to route to the render.
function recentCompletedIntent(text) {
	const s = String(text || '').trim();
	if (!s || s.split(/\s+/).length > 16) { return false; }
	if (aiGuardrails.looksLikeHowTo(s) || aiGuardrails.looksLikeDefinitional(s)) { return false; }
	if (aiGuardrails.containsDealId(s)) { return false; }   // a specific deal id
	if (/\b(open|active|running|underwater|in profit|in the red|in the green)\b/i.test(s)) { return false; }   // open-deals question
	const completed = /\b(completed?|closed?|finished?|ended?|wrapped up|sold)\b/i.test(s);
	const deals = /\b(deals?|positions?|trades?)\b/i.test(s);
	const recencyOrAny = /\b(recent(?:ly)?|lately|today|this\s+(?:week|month)|last\s+(?:week|month|few|couple)|past\s+(?:day|week|month|few)|any|anything)\b/i.test(s);
	return completed && deals && recencyOrAny;
}

// "how much have I deployed vs available?" / "how much capital is committed?" / "what's my dry powder?" — a
// whole-account funds question. The model loop was slow (~84s) AND printed a null as "$null" for the wallet
// balance when it was unavailable; render it in code, which reports the real deployed/committed figures and
// says plainly when available funds can't be read (never a null/0 placeholder). Excludes a specific deal id,
// how-to and definitional.
function portfolioFundsIntent(text) {
	const s = String(text || '').trim();
	if (!s || s.split(/\s+/).length > 20) { return false; }
	if (aiGuardrails.looksLikeHowTo(s) || aiGuardrails.looksLikeDefinitional(s)) { return false; }
	if (aiGuardrails.containsDealId(s)) { return false; }   // a specific deal
	const term = /\b(deploy(?:ed|ing)?|committ(?:ed|ing)?|available|dry[- ]?powder|uncommitted|invested|portfolio|holdings?)\b/i.test(s);
	const funds = /\b(funds?|capital|money|cash|balance|powder|how much|invested|deployed|committed|available)\b/i.test(s);
	return term && funds;
}

// Deterministic deployed-vs-available render from get_portfolio_summary. Reports real figures; for the wallet
// balance it prints the real per-currency amounts or says plainly it is unavailable — NEVER a null/0/"$null".
function formatPortfolioFunds(res) {
	if (!res || res.success === false) { return null; }
	const cur = res.quote_currency ? (' ' + res.quote_currency) : '';
	const parts = [];
	if (res.deployed_funds != null) { parts.push('Deployed (committed to open deals): ' + round2(res.deployed_funds) + cur); }
	else if (res.deployed_by_currency && Object.keys(res.deployed_by_currency).length) {
		parts.push('Deployed by currency (not summed — multiple quote currencies): ' + Object.entries(res.deployed_by_currency).map(([c, v]) => round2(v) + ' ' + c).join(', '));
	}
	if (res.max_committed_if_all_safety_orders_fill != null) { parts.push('Max committed if every safety order fills: ' + round2(res.max_committed_if_all_safety_orders_fill) + cur); }
	if (res.available_funds && typeof res.available_funds === 'object' && Object.keys(res.available_funds).length) {
		parts.push('Available (uncommitted) funds: ' + Object.entries(res.available_funds).map(([c, v]) => round2(v) + ' ' + c).join(', '));
	}
	else {
		parts.push('Available (uncommitted) funds: not currently available from the wallet, so I can\'t give a figure for it — and it is NOT the same as your deployed funds.');
	}
	return parts.length ? parts.join('\n') : null;
}

// Deterministic list of recently-completed deals from list_recent_completed_deals — real pair, realized
// profit %, and bot, never an invented id/figure. Returns a "none" line when there are no recent completions.
function formatRecentCompleted(res) {
	if (!res || res.success === false) { return null; }
	const deals = Array.isArray(res.completed_deals) ? res.completed_deals : [];
	if (!deals.length) { return 'No deals have completed recently.'; }
	const shown = deals.slice(0, 15);
	const lines = shown.map((d, i) => {
		const parts = [ (i + 1) + '. ' + (d.pair || d.dealId) ];
		if (d.profitPercent != null) { parts.push('profit ' + round2(d.profitPercent) + '%'); }
		if (d.botName) { parts.push('bot ' + d.botName); }
		return parts.join(', ');
	});
	const head = (deals.length === 1 ? 'One deal has' : deals.length + ' deals have') + ' completed recently'
		+ (deals.length > shown.length ? ' (showing the ' + shown.length + ' most recent)' : '') + ':';
	return head + '\n\n' + lines.join('\n');
}

// A general "any notable errors / anything going wrong lately?" question about the logs (NOT about one
// specific deal, and NOT a why/how/fix diagnostic — those keep the model or the deal path). The weak model,
// handed the rich error summary, intermittently mangles it — a bulleted list of "the data", or bare counts
// with the actual error messages dropped ("details can be found in the logs"). So render it in code instead.
// Returns { offsets, span } (the resolved days) or null. Excludes a specific deal id and how-to/definitional.
function recentErrorsIntent(text) {
	const s = String(text || '').trim();
	if (!s || s.split(/\s+/).length > 16) { return null; }
	if (aiGuardrails.containsDealId(s)) { return null; }   // a per-deal question
	// A specific clock time or range ("errors around 5pm", "errors between 11am and 8pm") is a TIME-WINDOW
	// query — defer to the time-window search so the time is honored, instead of scanning a whole day (the
	// day-granularity survey) and ignoring the time the user named.
	if (/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/i.test(s) || /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(s)) { return null; }
	if (aiGuardrails.looksLikeHowTo(s) || aiGuardrails.looksLikeDefinitional(s)) { return null; }
	// A diagnostic / advice framing ("why", "how do I fix", "should I", "prevent") wants reasoning the
	// deterministic render can't give — leave those to the model (it still gets the tool data via the loop).
	if (/\b(why|how (?:do|can|should|to|would)|what (?:should|can|do) i (?:do|about)|fix|resolve|prevent|avoid|stop|cause[sd]?|reason)\b/i.test(s)) { return null; }
	// Must be about errors/problems/failures, and framed as a recent/log survey ("any", "lately", "in the logs").
	const aboutErrors = /\b(errors?|problems?|failures?|failing|faults?|went wrong|going wrong|gone wrong|anything (?:wrong|broken|failing|off)|insufficient funds?)\b/i.test(s);
	if (!aboutErrors) { return null; }
	const surveyFraming = /\b(any|anything|notable|recent(?:ly)?|lately|today|yesterday|this week|few days|couple|past|last|days?|ago|logs?|going on|happening|so far)\b/i.test(s);
	if (!surveyFraming) { return null; }
	// Resolve which day(s) to scan — "today", "two days ago", "yesterday and the day before", "last 3 days", …
	return parseRelativeDays(s);
}

// Resolve day offsets (0=today, 1=yesterday, …) to YYYY-MM-DD date labels in the user's timezone. Calendar-day
// subtraction is DST-safe; de-duplicated and sorted most-recent-first. Returns [{ offset, date }].
function resolveErrorDates(offsets, tz) {
	const [ y, mo, d ] = String(shareData.Common.zonedDateStr(Date.now(), tz)).split('-').map(Number);
	const uniq = Array.from(new Set(offsets)).sort((a, b) => a - b);
	return uniq.map(n => ({ offset: n, date: new Date(Date.UTC(y, mo - 1, d) - n * 86400000).toISOString().slice(0, 10) }));
}

// A human, timezone-anchored label for the searched period, so an empty result names the exact day(s) —
// "today, 2026-08-24", "two days ago (2026-08-22)", "on yesterday (…) and the day before (…)".
function errorPeriodLabel(intent, resolved) {
	const nm = (n) => (n === 0 ? 'today' : n === 1 ? 'yesterday' : n === 2 ? 'the day before yesterday' : (n + ' days ago'));
	if (intent.span === 'range' && resolved.length > 1) {
		const dates = resolved.map(r => r.date).slice().sort();
		return 'in the last ' + resolved.length + ' days (' + dates[0] + ' to ' + dates[dates.length - 1] + ')';
	}
	if (intent.span !== 'list' || resolved.length === 1) {
		const r = resolved[0];
		return (r.offset === 0 ? 'today, ' + r.date : nm(r.offset) + ' (' + r.date + ')');
	}
	return 'on ' + resolved.map(r => nm(r.offset) + ' (' + r.date + ')').join(' and ');
}

// Render one raw log line readably: ANSI-strip, keep the leading timestamp, and when the rest is a JSON blob
// carrying a human "message" (SymBot's order-result errors are logged as JSON), surface that message instead of
// the raw object — the message is the concrete specific ("SELL ERROR: InsufficientFunds coinbase"), the rest is
// machine metadata. A plain (non-JSON) log line is kept as-is. Never invents; only trims for readability. Shared
// by the recent-errors and time-window renders.
function cleanLogLine(raw) {
	let s;
	try { s = shareData.Common.stripAnsi(String(raw == null ? '' : raw)); } catch (e) { s = String(raw == null ? '' : raw); }
	s = s.trim();
	const tsM = s.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+([\s\S]*)$/);
	const ts = tsM ? tsM[1] : '';
	let body = tsM ? tsM[2] : s;
	const msgM = body.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
	if (msgM) {
		body = msgM[1].replace(/\\"/g, '"').replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').trim();
		const brace = body.search(/\s*[{[]/);          // drop a trailing nested-JSON dump inside the message
		if (brace > 15) { body = body.slice(0, brace).trim(); }
	}
	else if (/^[{[]/.test(body)) { body = body.replace(/\s+/g, ' ').trim(); }   // JSON with no message → collapse
	if (body.length > 220) { body = body.slice(0, 220).trim() + ' …'; }
	return (ts ? ts + '  ' : '') + body;
}

// Deterministic render of the recent-errors summary: the authoritative tally sentence followed by EACH error
// type with its real count, time span, and up to three verbatim log lines — the concrete specifics a user
// asking "any notable errors?" actually wants, which the model otherwise drops or invents. Log lines are
// ANSI-stripped so escape codes never leak into the chat. Returns null when the data is unavailable.
function formatRecentErrors(res, periodLabel) {
	if (!res) { return null; }
	const strip = (v) => { try { return shareData.Common.stripAnsi(String(v == null ? '' : v)); } catch (e) { return String(v == null ? '' : v); } };
	const total = (res.total_errors != null) ? res.total_errors : 0;
	// Empty result: name the period actually searched (e.g. "today, 2026-08-23") so the user can see it looked
	// at the right day — otherwise a bare "no errors" reads as if it might have searched the wrong date.
	if (total === 0) { return 'No errors were logged ' + (periodLabel || 'in the requested period') + '.'; }

	const out = [];
	if (res.summary) { out.push(strip(res.summary)); }        // the ground-truth tally (counts, by-type, busiest day)

	const byType = Array.isArray(res.errors_by_type) ? res.errors_by_type : [];
	if (byType.length) {
		out.push('');
		out.push('Here is each error type with real log lines:');
		for (const t of byType) {
			if (!t || !t.type) { continue; }
			const when = (t.first_seen && t.last_seen)
				? (t.first_seen === t.last_seen ? ' (seen ' + t.first_seen + ')' : ' (from ' + t.first_seen + ' to ' + t.last_seen + ')')
				: '';
			out.push('');
			out.push('• ' + (t.count != null ? t.count + '× ' : '') + t.type + when);
			for (const line of (Array.isArray(t.examples) ? t.examples.slice(0, 3) : [])) {
				const clean = cleanLogLine(line);
				if (clean) { out.push('    ' + clean); }
			}
		}
	}
	if (res.truncated) {
		out.push('');
		out.push('(Only a sample of matching lines is shown — ask me to search the logs for a specific error, deal, or day for the full detail.)');
	}
	return out.join('\n').trim();
}

// ── Deterministic time-window log search ────────────────────────────────────────────────────────────
// "find logs around 10:43 PM", "what happened around 6:25 AM today?", "events between 6:00 and 7:00 AM". The
// weak model fumbles the local-clock → UTC conversion (wrong offset, wrong day, or it doesn't call the tool at
// all and hand-waves at the UI), so parse the time deterministically in code — reusing the shared timezone
// helpers in Common — and route straight to get_events_in_window over the exact UTC window.

// Parse a clock token ("10:43 PM", "6:25 am", "22:43", or a bare hour when a meridiem is inheritable from a
// sibling token in a range) into { h, m, mer } in 24-hour form, or null. `inheritMer` is 'am' | 'pm' | null.
function parseClockToken(tok, inheritMer) {
	const s = String(tok || '');
	let m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);
	if (m) {
		let h = parseInt(m[1], 10) % 12;
		const mer = /p/i.test(m[3]) ? 'pm' : 'am';
		if (mer === 'pm') { h += 12; }
		return { h, m: m[2] ? parseInt(m[2], 10) : 0, mer };
	}
	m = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);                 // 24-hour "22:43"
	if (m) { return { h: parseInt(m[1], 10), m: parseInt(m[2], 10), mer: null }; }
	m = s.match(/\b(\d{1,2})\b/);                                   // bare hour — only usable with an inherited meridiem
	if (m && inheritMer) {
		let h = parseInt(m[1], 10) % 12;
		if (inheritMer === 'pm') { h += 12; }
		return { h, m: 0, mer: inheritMer };
	}
	return null;
}

// Primitive: convert a local wall-clock on a SPECIFIC calendar day (y, mo=1-12, d, in `tz`) to a UTC Date,
// DST-correct via Common's offset helper (tz null ⇒ treat the wall-clock as UTC). Shared by clockToUtc (which
// resolves the day) and the time-of-day BAND scan (which walks several days).
function localWallToUtc(y, mo, d, h, mi, tz) {
	const naive = Date.UTC(y, mo - 1, d, h, mi, 0);               // wall-clock treated as if UTC …
	const offMs = tz ? shareData.Common.tzOffsetMsAt(new Date(naive), tz) : 0;   // … then shifted by the real tz offset
	return new Date(naive - offMs);
}

// Convert a parsed clock time (local wall-clock in `tz`) to a UTC Date, resolving the DAY: an explicit
// 'today'/'yesterday' hint wins; otherwise pick the most-recent PAST occurrence (a time later than now rolls
// back a day — "around 10:43 PM" asked at 2 AM means last night).
function clockToUtc(c, tz, dayHint) {
	const nowMs = Date.now();
	const [ y, mo, d ] = String(shareData.Common.zonedDateStr(nowMs, tz)).split('-').map(Number);   // today in tz
	let utc = localWallToUtc(y, mo, d, c.h, c.m, tz).getTime();
	if (dayHint === 'yesterday') { utc -= 86400000; }
	else if (dayHint !== 'today' && utc > nowMs + 60000) { utc -= 86400000; }
	return new Date(utc);
}

// The half-width (in minutes) of a time window, parsed from "within N minutes/hours", "within an hour", "give
// or take 20 min", "± 15 minutes". Returns `def` when the user named no width. Capped at 12 hours.
function parseWindowMinutes(s, def) {
	const m = String(s || '').match(/\b(?:within|give or take|plus or minus|±|~)\s+(?:an?\s+)?(\d+)?\s*(hours?|hrs?|minutes?|mins?)\b/i);
	if (!m) { return def; }
	const n = m[1] ? parseInt(m[1], 10) : 1;                       // "within an hour" ⇒ 1
	const unit = /^h/i.test(m[2]) ? 60 : 1;
	return Math.min(Math.max(n * unit, 1), 720);
}

// How many recent days a time-of-day BAND spans, parsed from "over the last week", "past N days", "last 2
// weeks". Returns { days, explicit }: `explicit` is true when the user named a span (so a precise time can be
// promoted to a band), false when the default applies. Capped at 14 days to bound the per-day scans.
function parseBandDays(s, def) {
	const MAX = 14;
	const clamp = (n) => Math.min(Math.max(n, 1), MAX);
	const t = String(s || '');
	if (/\b(?:this|last|past|previous)\s+week\b|\bover the last week\b|\bin the last week\b/i.test(t)) { return { days: 7, explicit: true }; }
	let m = t.match(/\b(\d+)\s*weeks?\b/i);
	if (m) { return { days: clamp(parseInt(m[1], 10) * 7), explicit: true }; }
	m = t.match(/\b(?:last|past|previous|over the last|in the last|recent)\s+(\d+)\s*days?\b/i) || t.match(/\b(\d+)\s*days?\b/i);
	if (m) { return { days: clamp(parseInt(m[1], 10)), explicit: true }; }
	return { days: def, explicit: false };
}

// Human suffix for a band label: "over the last week" / "over the last 2 weeks" / "over the last N days".
function bandSuffix(days) {
	if (days === 7) { return ' over the last week'; }
	if (days === 14) { return ' over the last 2 weeks'; }
	return ' over the last ' + days + ' days';
}

// Detect a time-window log query and resolve it to { from, to (Date), label } in UTC, or null. Requires BOTH a
// log/event framing AND a parseable clock time, so it never hijacks a question that merely mentions a number.
function timeSearchIntent(text, timezone) {
	const s = String(text || '').trim();
	if (!s || s.split(/\s+/).length > 30) { return null; }
	if (aiGuardrails.containsDealId(s)) { return null; }   // a per-deal question
	// Framing includes an error/problem word so "any errors around 5pm?" routes here (the recent-errors survey
	// defers when a clock time is present); a broad "what happened / logs / events" framing works too.
	const framing = /\b(logs?|log ?lines?|events?|errors?|problems?|failures?|failing|what (?:happened|went (?:on|wrong))|anything (?:wrong|happen)|activity|incidents?|going on|show me|find|search)\b/i.test(s);
	if (!framing) { return null; }

	const tz = shareData.Common.normalizeTimeZone(timezone) || null;
	const dayHint = /\byesterday\b/i.test(s) ? 'yesterday' : (/\btoday\b/i.test(s) ? 'today' : null);
	// A single window resolves to one specific DAY; naming it (in the user's own timezone) makes the search
	// transparent — "around 5pm on 2026-08-22" — so an empty result is obviously "nothing that day", not "wrong
	// day". A band already says "over the last N days", so it gets no single date.
	const onDate = (instant) => { try { return ' on ' + shareData.Common.zonedDateStr(instant, tz); } catch (e) { return ''; } };
	// When the question is specifically about ERRORS (and not a broad "what happened / show me the logs"),
	// filter the window down to error lines so the answer addresses the question rather than burying it under
	// routine events.
	const errorsOnly = /\b(errors?|problems?|failures?|failing|faults?|wrong|insufficient|circuit ?breaker|cancell?ed|invalid)\b/i.test(s)
		&& !/\b(everything|all\b|what happened|what went|\blogs?\b|\bevents?\b|activity|going on)\b/i.test(s);

	// A time-OF-DAY band spans several recent days when the user names a time but no day: "errors around 5pm"
	// means "around 5pm over the last few days" — a recurring band, scanned per-day so a busy log can't truncate
	// one day before the next is reached. The span defaults to 3 days but honors "over the last week / N days";
	// an explicit span also promotes a precise time to a band. An explicit today/yesterday anchors to one day.
	const band = parseBandDays(s, 3);

	// Range: "between 6:00 AM and 7:00 AM", "from 6 to 7 am". Parse the later token first so a bare earlier
	// token ("6") can inherit its meridiem.
	const range = s.match(/\b(?:between|from)\s+(.+?)\s+(?:and|to|until|through|[-–—])\s+(.+?)(?:$|[.?!,])/i);
	if (range) {
		const c2 = parseClockToken(range[2], null);
		const c1 = parseClockToken(range[1], c2 ? c2.mer : null);
		if (c1 && c2) {
			const startMin = c1.h * 60 + c1.m, endMin = c2.h * 60 + c2.m;
			// Label from just the CLOCK tokens — the second capture can greedily swallow a trailing "over the
			// last week", which would otherwise duplicate in the band suffix.
			const clockText = (cap) => { const m = String(cap).match(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\b/i); return m ? m[0].trim() : String(cap).trim(); };
			const rangeLabel = 'between ' + clockText(range[1]) + ' and ' + clockText(range[2]);
			// No day anchor + a real (non-midnight-spanning) band → a time-OF-DAY band across the recent days.
			if (!dayHint && endMin > startMin) {
				return { mode: 'band', startMin, endMin, days: band.days, label: rangeLabel + bandSuffix(band.days), errorsOnly };
			}
			let from = clockToUtc(c1, tz, dayHint);
			let to = clockToUtc(c2, tz, dayHint);
			if (to.getTime() <= from.getTime()) { to = new Date(to.getTime() + 86400000); }   // spans midnight
			return { mode: 'window', from, to, label: rangeLabel + onDate(from), errorsOnly };
		}
	}

	// Single moment: "around 10:43 PM", "near 6:25am", "at 22:43". A ± window whose half-width is parsed from
	// "within N minutes/hours" (default: ±5 min for a precise time, ±30 min for a looser round hour).
	const around = s.match(/\b(?:around|near|about|approximately|circa|~|at)\s+(.+?)(?:$|[.?!,])/i);
	const timeStr = around ? around[1] : s;
	const c = parseClockToken(timeStr, null) || parseClockToken(s, null);
	if (c) {
		const hasMinutes = /\d{1,2}:\d{2}/.test(timeStr);
		const winMin = parseWindowMinutes(s, hasMinutes ? 5 : 30);
		const timeText = timeStr.match(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\b/i);
		const timeLabel = 'around ' + (timeText ? timeText[0].trim() : 'that time');
		// No day anchor and either a loose round hour OR an explicit multi-day span ("10:43 PM over the last
		// week") → a time-OF-DAY band (±winMin each day) across the recent days; a precise time with no span, or
		// an anchored day, stays a single most-recent window.
		if (!dayHint && (!hasMinutes || band.explicit)) {
			const center = c.h * 60 + c.m;
			return { mode: 'band', startMin: center - winMin, endMin: center + winMin, days: band.days, label: timeLabel + bandSuffix(band.days), errorsOnly };
		}
		const center = clockToUtc(c, tz, dayHint);
		return {
			mode: 'window',
			from: new Date(center.getTime() - winMin * 60000),
			to: new Date(center.getTime() + winMin * 60000),
			label: timeLabel + onDate(center),
			errorsOnly
		};
	}
	return null;
}

// A line is an error/problem (used to filter a time window down to errors when the user asked specifically
// about errors). Mirrors the log markers the error tools recognize.
const ERR_LINE_RE = /\b(error|fail(?:ed|ure|ing)?|exception|unable|invalid|timeout|reject(?:ed)?|insufficient|not have enough|cancell?ed|circuit ?breaker|no pending order|retries exhausted|giving up)\b/i;

// Deterministic render of the events in a time window: the real log lines (cleaned), in order. When errorsOnly
// is set, the window is filtered to error lines so an "any errors around 5pm?" question is answered directly.
// Returns a clear "nothing in that window" line rather than inventing anything when the scan is empty.
function formatEventsWindow(res, label, errorsOnly) {
	let events = Array.isArray(res && res.events) ? res.events : [];
	if (errorsOnly) { events = events.filter(l => ERR_LINE_RE.test(String(l))); }

	if (!events.length) {
		// An error-focused scan only fetched error markers, so an empty result means "no ERRORS here" — say
		// exactly that (never "no activity", which would be a false claim) and point at the broader view.
		if (errorsOnly) {
			return 'I found no errors ' + label + '. Ask "what happened ' + label + '" to see all log activity in that window, or widen the time / pick a different day.';
		}
		return 'I found no log activity ' + label + '. Try a wider time (e.g. "within 30 minutes"), a different day, or ask me to search the logs for a specific error or deal.';
	}

	const out = [ (errorsOnly ? 'Here are the errors the logs show ' : 'Here is what the logs show ') + label + ' (your local time):', '' ];
	const shown = events.slice(0, 40);
	for (const line of shown) { const c = cleanLogLine(line); if (c) { out.push('  ' + c); } }
	const total = errorsOnly ? events.length : ((res.event_count != null) ? res.event_count : events.length);
	if (total > shown.length) {
		out.push('');
		out.push('(' + total + (errorsOnly ? ' error lines' : ' events') + ' in that window; showing the first ' + shown.length + '. Ask me to narrow the time or filter by a deal or error.)');
	}
	return out.join('\n').trim();
}

// Execute a time search and return one { events } result, so the render path is identical for both shapes. A
// 'window' mode is one get_events_in_window call; a 'band' mode ("around 5pm over the last N days") builds one
// absolute [from,to] window per recent day and hands ALL of them to a SINGLE get_events_in_window call, which
// scans the union of days once and keeps any line falling in any window — so even a two-week span is one pass,
// not N. `errors_only` scans the error markers directly so an error-focused ask isn't diluted before capping.
// Reuses the existing tool and the localWallToUtc primitive; never throws its own errors upward.
async function runTimeSearch(tw, timezone, onActivity) {
	const exec = (extra) => aiTools.execute('get_events_in_window', Object.assign({ errors_only: !!tw.errorsOnly }, extra), { onActivity, timezone });

	if (tw.mode !== 'band') {
		const r = await exec({ from: tw.from.toISOString(), to: tw.to.toISOString() });
		return (r && r.success !== false) ? r : null;
	}

	const tz = shareData.Common.normalizeTimeZone(timezone) || null;
	const nowMs = Date.now();
	const [ ty, tmo, td ] = String(shareData.Common.zonedDateStr(nowMs, tz)).split('-').map(Number);
	const sMin = Math.max(0, tw.startMin), eMin = Math.min(1440, tw.endMin);
	const windows = [];
	for (let i = 0; i < tw.days; i++) {
		const dd = new Date(Date.UTC(ty, tmo - 1, td) - i * 86400000);      // the calendar day i days before today
		const from = localWallToUtc(dd.getUTCFullYear(), dd.getUTCMonth() + 1, dd.getUTCDate(), Math.floor(sMin / 60), sMin % 60, tz);
		const to = localWallToUtc(dd.getUTCFullYear(), dd.getUTCMonth() + 1, dd.getUTCDate(), Math.floor(eMin / 60), eMin % 60, tz);
		if (from.getTime() > nowMs) { continue; }                            // a band still in the future today
		windows.push({ from: from.toISOString(), to: to.toISOString() });
	}
	if (!windows.length) { return { success: true, events: [], event_count: 0 }; }
	const r = await exec({ windows });                                       // ONE scan over the whole span
	return (r && r.success !== false) ? r : null;
}

// A RANKING question over the user's open deals ("which is losing the most?", "biggest winner?", "closest to
// take-profit?"). The tool already computes the authoritative pick (biggest_loss / biggest_gain, and the
// closest_to_take_profit list ordered by nearness), but a weak model re-scans the list and mis-ranks or
// invents — so render the real winner/loser/nearest deterministically. Returns { kind } or null.
// A COUNT question about the user's OPEN deals — either the PURE count ("how many open deals do I have?",
// "number of active positions") or a profit-state SUBSET count ("how many are in profit / underwater /
// losing"). BOTH are answered by the open-deals SUMMARY render, which already carries the authoritative
// total AND the in-profit / underwater counts — so route either there (render, don't generate) instead of
// the weak model, which is both SLOW (a full tool loop — measured ~25s for a bare count) and prone to
// echoing the total or mis-counting (observed: "16 open deals that is currently in profit"). Returns true to
// route to the summary. NOT triggered by ranking/list phrasings ("which", "top", "list") — those are
// dealRankingIntent — nor by bots / closed / historical scopes (different renders).
function openDealsCountIntent(text) {
	const s = String(text || '');
	// A TERSE bare reference — "open deals?", "my active positions", "current trades" — carries no verb but is
	// unambiguously a request for the open-deals status; route it to the summary render rather than the ~20s
	// model loop. Scoped to a very short message so a real sentence is not swallowed.
	if (s.trim().split(/\s+/).length <= 4 && /^\s*(?:my\s+)?(?:open|active|current(?:ly)?|running)\s+(?:deals?|positions?|trades?)\s*\??\s*$/i.test(s.trim())) { return true; }
	// A COUNT question ("how many …"), not a value ("how much of …" is dropped — that asks for an amount).
	if (!/\bhow many\b|\bnumber of\b|\bcount of\b/i.test(s)) { return false; }
	if (/\b(which|list|top|rank)\b/i.test(s)) { return false; }
	// The open-deals summary answers about OPEN DEALS only — not bots, and not closed/historical performance.
	// Exclude those subjects/scopes so the count isn't given for the wrong thing.
	if (/\b(bots?|completed|closed|finished|ended|were|realized|realised|history|historical|all[- ]?time|so far)\b/i.test(s)) { return false; }
	// Profit-state SUBSET count ("…in profit / underwater / losing / down") — the summary carries these counts.
	if (/\b(in profit|profitable|winning|in the green|underwater|in the red|losing|at a loss|down)\b/i.test(s)) { return true; }
	// PURE open-deal count. Requires an open/active-position noun so "how many safety orders / bots / errors"
	// never match, and that it refers to CURRENT holdings — an explicit open/active qualifier, or present-tense
	// possession ("do I have", "are open"). "how many deals did I open today" (a rate, not a holding) is
	// intentionally NOT matched (no open/active qualifier, no present possession of the noun).
	if (/\b(?:open|active|currently open|still open)\s+(?:deals?|positions?|trades?)\b/i.test(s)) { return true; }
	if (/\b(?:deals?|positions?|trades?)\b[\s\S]{0,25}\b(?:do i have|have i got|i have (?:open|active)|are (?:(?:currently|now|still|presently)\s+)?(?:open|running|active))\b/i.test(s)) { return true; }
	return false;
}

// A whole-portfolio UNREALIZED P/L question ("what's my total unrealized P/L?", "how much am I down overall?",
// "how much am I underwater across everything?"). The open-deals SUMMARY render already carries the real
// total_unrealized_pnl (and a per-currency split when quote currencies differ), so route it there instead of
// the model loop — which has been observed to FABRICATE this figure (answered "-123.45" for a real ≈ -17,000).
// Excludes a specific deal, a ranking/list, and REALIZED/historical profit (a different tool), so only a
// current whole-book unrealized figure reaches the summary.
function portfolioPnlIntent(text) {
	const s = String(text || '').trim();
	if (!s || s.split(/\s+/).length > 16) { return false; }
	if (aiGuardrails.looksLikeHowTo(s) || aiGuardrails.looksLikeDefinitional(s)) { return false; }
	if (aiGuardrails.containsDealId(s)) { return false; }            // a specific deal id
	if (/\b(which|list|top|rank|biggest|worst|best|most|least|closest|furthest|nearest)\b/i.test(s)) { return false; }   // a ranking
	if (/\b(realized|realised|completed|closed|booked|cashed|so far this|made (?:so far|this|last)|profit this (?:week|month|year))\b/i.test(s)) { return false; }   // realized/historical → different tool
	// A whole-book SCOPE word, AND an unrealized-P/L subject.
	const wholeBook = /\b(total|overall|altogether|combined|net|across (?:all|everything|the board)|everything|all (?:my |of my )?(?:deals?|positions?)|portfolio|in total)\b/i.test(s);
	const pnl = /\b(unrealized|unrealised|floating|paper)\s+(?:profit|loss|p\/?l|pnl|gain)\b|\bunderwater\b|\bin the red\b|\b(?:am i|i'?m|i am)\s+(?:up|down)\b|\bp\/?l\b|\bpnl\b|\bprofit or loss\b|\bprofit\/loss\b/i.test(s);
	return wholeBook && pnl;
}

// "how many bots do I have?" / "number of bots" — a COUNT of configured bots. The list_bots data carries the
// authoritative count (and which are active), so render it deterministically: the model loop, left to answer
// this, has been observed to give a WRONG count (e.g. "2 bots" when 7 are configured) and is slow (~24s).
// Excludes the deal/position/order/etc. nouns so only a bot count matches.
function botsCountIntent(text) {
	const s = String(text || '');
	if (!/\bhow many\b|\bnumber of\b|\bcount of\b/i.test(s)) { return false; }
	if (/\b(which|list|top|rank)\b/i.test(s)) { return false; }
	if (/\b(deals?|positions?|trades?|orders?|safety|errors?|exchanges?|pairs?|schedules?|coins?|assets?)\b/i.test(s)) { return false; }
	return /\bbots?\b/i.test(s);
}

// A plain ENUMERATION of the user's bots ("what bots do I have?", "list my bots", "show me my bots") — the
// same grounded formatBotsCount render already prints the real names + active state, so route the list
// phrasing here rather than letting the model loop enumerate them (observed to INVENT bot names and
// exchanges, e.g. a non-existent "SymSync 200 on Binance"). Deliberately narrow: a performance/superlative
// question ("which bot is doing best?"), a config question ("what take-profit are my bots using?"), or a
// question about another noun is NOT an enumeration and is left to its dedicated path.
function botsListIntent(text) {
	const s = String(text || '').trim();
	if (!s || s.split(/\s+/).length > 14) { return false; }
	if (aiGuardrails.looksLikeHowTo(s) || aiGuardrails.looksLikeDefinitional(s)) { return false; }
	if (!/\bbots?\b/i.test(s)) { return false; }
	if (/\b(deals?|positions?|trades?|orders?|safety|errors?|exchanges?|pairs?|schedules?|coins?|assets?)\b/i.test(s)) { return false; }
	// Performance / superlative / config framings are handled elsewhere — not a plain enumeration.
	if (/\b(best|worst|most|least|top|biggest|highest|lowest|profit|performing|performs?|doing|take[- ]?profit|safety order|deviation|settings?|config|configured|using|status of)\b/i.test(s)) { return false; }
	return /\b(what|which)\b[^.\n]{0,20}\bbots?\b/i.test(s)
		|| /\b(list|show|name|display|enumerate|tell me)\b[^.\n]{0,20}\bbots?\b/i.test(s)
		|| /\bbots?\b[^.\n]{0,20}\bdo i have\b/i.test(s)
		|| /^\s*(my|the)\s+bots?\s*\??\s*$/i.test(s);
}

// Per-bot OPEN-DEAL distribution — "how many open deals does each of my bots have?" (breakdown) and "which
// bot has the most open deals?" (the single busiest). Both are a plain group-by on the live open-deals list,
// so they render deterministically instead of reaching the model loop (observed slow, and in one case it
// HUNG and returned an empty answer). Returns { most: true|false } for the two shapes, or null. Deliberately
// narrow: a bot PERFORMANCE ("which bot is doing best?"), CONFIG ("what take-profit are my bots using?") or
// ORDER-count question is handled by its own path and returns null here.
function perBotDealsIntent(text) {
	const s = String(text || '').trim();
	if (!s || s.split(/\s+/).length > 18) { return null; }
	if (aiGuardrails.looksLikeHowTo(s) || aiGuardrails.looksLikeDefinitional(s)) { return null; }
	if (!/\bbots?\b/i.test(s) || !/\bdeals?\b/i.test(s)) { return null; }
	// A message carrying an inline arithmetic expression ("if each bot runs 2 deals, that's 2+2+2 = 6?") is a
	// CALCULATION question, not a request for the real per-bot distribution — let it reach the model (and the
	// arithmetic self-check) rather than answering with live counts the user did not ask for.
	if (/\d\s*[-+*/×x]\s*\d/.test(s)) { return null; }
	// An EXCLUSION clause ("…besides the paused ones", "…not counting stale deals") cannot be honored by a
	// plain group-by count, so let the model handle it rather than render counts that silently ignore it.
	if (EXCLUSION_CLAUSE_RE.test(s)) { return null; }
	// A performance / config / order-count question that merely mentions bots and deals is handled elsewhere.
	// Checked BEFORE the "most … deals" shape so "which bot has the most PROFITABLE/WINNING/LOSING deals?"
	// (a profit question) is not mis-answered with a plain open-deal COUNT.
	if (/\b(best|worst|profitable|performing|performs?|doing (?:best|worst|well|badly|great)|p\/?l|pnl|win(?:ning|s|ner)?|los(?:e|ing|ses|ers?)|take[- ]?profit|safety orders?|deviation|settings?|config(?:ured)?|orders?)\b/i.test(s)) { return null; }
	// "which bot has the most (open) deals?" — a COUNT superlative over bots (a plain count, not performance).
	if (/\bmost\b[^.\n]{0,14}\b(?:open\s+|active\s+)?deals?\b/i.test(s) && /\bbots?\b/i.test(s)) { return { most: true }; }
	// "how many (open) deals does each bot have?" / "deals per bot" / "deals by bot" / "each of my bots"
	if (/\beach\b[^.\n]{0,20}\bbots?\b/i.test(s)
		|| /\bbots?\b[^.\n]{0,14}\beach\b/i.test(s)
		|| /\bdeals?\b[^.\n]{0,8}\bper\b[^.\n]{0,6}\bbot\b/i.test(s)
		|| /\b(?:per[- ]bot|by bot|across (?:my |the )?bots)\b/i.test(s)) {
		return { most: false };
	}
	return null;
}

function dealRankingIntent(text, opts) {
	// assumeDeals: the caller already knows the conversation topic is the user's deals/portfolio (a follow-up
	// like "which is the worst?" right after "how are my deals?"). A bare superlative carries no deal noun of
	// its own, so without this it would be rejected below and fall to the model, which mis-picks/fabricates.
	// It only relaxes the "is this even about deals" gate — the non-deal-noun bail and the kind regexes still
	// run, so "which is the worst exchange?" is still not treated as a per-deal ranking.
	const assumeDeals = !!(opts && opts.assumeDeals);
	const s = String(text || '').trim();
	if (!s || s.split(/\s+/).length > 14) { return null; }
	if (aiGuardrails.looksLikeHowTo(s) || aiGuardrails.looksLikeDefinitional(s)) { return null; }
	// A superlative about a NON-deal noun (pair, bot, strategy, exchange, coin/asset) is not a per-deal
	// ranking — naming a single DEAL for "my most profitable pair/bot" would be the wrong subject. Dedicated
	// paths handle those, so bail out here and let routing pick the right tool.
	if (/\b(most|least|best|worst|top|biggest|highest|lowest)\b[^.\n]{0,20}\b(pairs?|bots?|strateg(?:y|ies)|exchanges?|coins?|assets?|tokens?|currenc(?:y|ies))\b/i.test(s)
		|| /\b(pairs?|bots?|strateg(?:y|ies)|exchanges?|coins?|assets?|tokens?|currenc(?:y|ies))\b[^.\n]{0,25}\b(most|least|best|worst|top|performing (?:best|worst)|performs? (?:best|worst)|doing (?:best|worst|great|well|badly))\b/i.test(s)) { return null; }
	// A ranking phrasing ("biggest winner", "closest to profit", "losing the most") implies deals even without
	// the word "deal" — so accept a deals/positions noun OR a P/L / take-profit context word. This keeps a
	// non-deals superlative ("which is the best exchange?") out (no such context word), while catching the
	// bare "who is my biggest winner?" / "which is closest to profit?".
	const aboutDeals = assumeDeals || /\b(deals?|positions?|trades?|\bone\b|bags?|profit(?:able)?|loss(?:es)?|losing|winning|winner|loser|underwater|take[- ]?profit|performer|performing|\bgain(?:s|er)?\b|in the red)\b/i.test(s);
	if (!aboutDeals) { return null; }
	// A LIST / top-N phrasing ("top 5 …", "list my …", "which deals are …", plural winners/losers) wants a
	// ranked list, not a single pick. The requested N is captured so the render can honour "top 3" / "top 10".
	const listM = s.match(/\btop\s+(\d{1,2})\b/i) || s.match(/\b(\d{1,2})\s+(?:most|biggest|best|worst|top)\b/i);
	// A LIST is wanted only on an EXPLICIT multiplicity signal — a top-N count, a "list/show me … deals"
	// request, or a plural "most profitable deals". A singular "which … is closest/my biggest winner" stays
	// a single-pick answer (not turned into a list).
	const wantsList = !!listM
		|| /\b(list|show me|give me)\b[^.\n]{0,25}\b(deals?|positions?|winners?|losers?|profitable)\b/i.test(s)
		|| /\bmost profitable deals?\b/i.test(s);
	const n = listM ? Math.min(Math.max(parseInt(listM[1], 10) || 5, 1), 25) : 5;
	if (/\b(clos(?:est|e)|nearest)\b[^.\n]{0,25}\b(profit|take[- ]?profit|target|closing)\b|\bclosest to (?:profit|target|take)/i.test(s)) { return { kind: 'closest', list: wantsList, n }; }
	if (/\b(furthest|farthest|least close)\b[^.\n]{0,25}\b(profit|take[- ]?profit|target)\b/i.test(s)) { return { kind: 'furthest', list: wantsList, n }; }
	if (/\b(losing|worst|biggest los(?:s|er)|deepest|most underwater|most in the red|down the most|bleeding the most|least profitable)\b/i.test(s)
			|| /\b(biggest|largest|greatest|deepest|worst|highest)\b[^.\n]{0,24}\b(loss(?:es)?|losing|underwater|in the red)\b/i.test(s)) { return { kind: 'loss', list: wantsList, n }; }
	// "winning / best / biggest gain / top performer / most profitable / highest profit / up the most". Note
	// "profitable" (an adjective) — NOT bare "in profit", which is a COUNT question handled separately.
	if (/\b(winning|best|biggest (?:win(?:ner)?|gain)|top performer|most in profit|up the most|doing best|(?:most |highest |biggest |top )profit(?:able)?|profitable)\b/i.test(s)
			|| /\b(biggest|largest|greatest|highest|top|best)\b[^.\n]{0,24}\b(gain(?:s|er)?|profit(?:able)?|winner|win)\b/i.test(s)) { return { kind: 'gain', list: wantsList, n }; }
	return null;
}

// Round a display figure to 2 decimals for the deterministic deal renders. Shared by the ranking and
// breakdown renderers so they can't drift. A non-number is passed through unchanged (never NaN); null → null.
function round2(v) {
	return (typeof v === 'number') ? Math.round(v * 100) / 100 : (v == null ? null : v);
}

function formatDealRanking(res, rank) {
	const kind = (rank && typeof rank === 'object') ? rank.kind : rank;   // tolerate a bare kind string
	const wantList = !!(rank && typeof rank === 'object' && rank.list);
	const topN = (rank && typeof rank === 'object' && rank.n) ? rank.n : 5;
	const r2 = round2;
	const list = Array.isArray(res.closest_to_take_profit) ? res.closest_to_take_profit : [];

	const one = (r, label) => {
		if (!r || (!r.pair && !r.dealId)) { return null; }
		const parts = [ 'Your ' + label + ' open deal is ' + (r.pair || r.dealId) ];
		if (r.unrealizedPnl != null) { parts.push('unrealized P/L ' + r2(r.unrealizedPnl) + (r.unrealizedPct != null ? ' (' + r2(r.unrealizedPct) + '%)' : '')); }
		if (r.pctToTakeProfit != null && !r.priceStale) { parts.push(r2(r.pctToTakeProfit) + '% from take-profit'); }
		if (r.safetyOrdersUsed != null) { parts.push(r.safetyOrdersUsed + ' safety orders used'); }
		return parts.join(', ') + '.';
	};

	// Ranked LIST (top-N): sort a COPY of the live-figure list by the requested dimension and render each
	// REAL deal from the payload — this is the deterministic answer to "list my top N most profitable /
	// losing deals", which a weak model otherwise fabricates (inventing ids and dollar figures).
	// Completeness guard for a P/L / furthest LIST. closest_to_take_profit is the PRICED deals sorted by
	// NEARNESS to take-profit and capped at 30, so it omits exactly the extremes a gain/loss/furthest ranking
	// needs (the biggest losers sit FURTHEST from take-profit and are dropped by a nearest-first cap). Only
	// render a "top N" list when the list actually covers every priced deal (total minus stale-price ones);
	// otherwise it would falsely claim a portfolio-wide ranking, so fall through to the authoritative single
	// pick (biggest_gain/biggest_loss, computed over ALL deals). 'closest' is exempt — the nearest are never
	// dropped by a nearest-first cap, so a top-N-closest over the kept list is correct.
	const pricedCount = (res.open_deals_total != null) ? (res.open_deals_total - (res.stale_price_deals || 0)) : list.length;
	const listNeedsFullSet = (kind === 'gain' || kind === 'loss' || kind === 'furthest');
	if (wantList && list.length && (!listNeedsFullSet || list.length >= pricedCount)) {
		const num = (v) => (typeof v === 'number' ? v : null);
		// Cross-currency safety, mirroring how the tool picks the single biggest_gain/biggest_loss: dollar P/L
		// is only comparable within ONE quote currency (0.01 BTC is not 100 USDT). res.total_unrealized_pnl is
		// a single number ONLY when every open deal shares one quote currency, and null when they are mixed
		// (then res.unrealized_by_currency carries the per-currency split) — so a null total means mixed, and
		// we rank by unrealized PERCENT instead. closest/furthest are distance-based, unaffected.
		const byPct = (kind === 'gain' || kind === 'loss') && res.total_unrealized_pnl == null;
		const metric = (r) => (byPct ? num(r.unrealizedPct) : num(r.unrealizedPnl));
		let ordered = list.slice();
		if (kind === 'gain') { ordered.sort((a, b) => (metric(b) ?? -Infinity) - (metric(a) ?? -Infinity)); }
		else if (kind === 'loss') { ordered.sort((a, b) => (metric(a) ?? Infinity) - (metric(b) ?? Infinity)); }
		else if (kind === 'furthest') { ordered = ordered.reverse(); }
		// 'closest' keeps the payload's own nearness order.
		const top = ordered.slice(0, topN);
		const label = kind === 'gain' ? 'most profitable' : kind === 'loss' ? 'least profitable (biggest loss)' : kind === 'furthest' ? 'furthest from take-profit' : 'closest to take-profit';
		// Name the dimension the list is actually ordered by, honestly: gain/loss by live P/L (dollars when a
		// single currency, else percent), closest/furthest by distance to the take-profit target.
		const orderedBy = (kind === 'gain' || kind === 'loss') ? ('live unrealized P/L' + (byPct ? ' %' : '')) : 'distance to take-profit';
		const lines = top.map((r, i) => {
			const parts = [ (i + 1) + '. ' + (r.pair || r.dealId) ];
			if (r.unrealizedPnl != null) { parts.push('unrealized P/L ' + r2(r.unrealizedPnl) + (r.unrealizedPct != null ? ' (' + r2(r.unrealizedPct) + '%)' : '')); }
			if (r.pctToTakeProfit != null && !r.priceStale) { parts.push(r2(r.pctToTakeProfit) + '% to take-profit'); }
			if (r.safetyOrdersUsed != null) { parts.push(r.safetyOrdersUsed + ' safety orders used'); }
			return parts.join(', ');
		});
		let out = 'Your ' + label + ' open deals (top ' + top.length + (res.open_deals_total != null ? ' of ' + res.open_deals_total : '') + '), ranked by ' + orderedBy + ':\n\n' + lines.join('\n');
		// The only deals excluded from a complete list are the stale-price ones (no live P/L this cycle) —
		// name that cause accurately rather than the previous generic "not ranked".
		const stale = res.stale_price_deals || 0;
		if (stale > 0) { out += '\n\n(' + stale + ' deal(s) without a live price yet are not ranked.)'; }
		// Honesty note: a "most profitable" list padded with underwater deals (fewer deals in profit than
		// shown) must not read as if all of them are winners.
		if (kind === 'gain' && res.open_deals_in_profit != null && res.open_deals_in_profit < top.length) {
			out += '\n\n(Only ' + res.open_deals_in_profit + ' of these ' + (res.open_deals_in_profit === 1 ? 'is' : 'are') + ' actually in profit; the rest are your least-negative deals.)';
		}
		return out;
	}

	if (kind === 'loss') { return one(res.biggest_loss, 'worst-performing (biggest loss)'); }
	if (kind === 'gain') { return one(res.biggest_gain, 'best-performing (biggest gain)'); }
	if (!list.length) { return null; }
	if (kind === 'closest') { return one(list[0], 'closest to take-profit'); }
	if (kind === 'furthest') { return one(list[list.length - 1], 'furthest from take-profit'); }
	return null;
}

// Deterministic per-deal breakdown for a "tell me more" after an open-deals summary. A weak model, asked to
// elaborate, drifts to generic concepts or just re-states the counts instead of enumerating; this bypasses the
// model and lists EVERY open deal from the REAL data (`closest_to_take_profit` carries full per-deal figures).
// null figures are omitted, never printed as 0 or a placeholder. Returns null if there is nothing to list.
function formatOpenDealsBreakdown(res) {
	const list = Array.isArray(res && res.closest_to_take_profit) ? res.closest_to_take_profit : [];
	if (!list.length) { return null; }
	const f = round2;   // shared 2-dp rounder (the second arg on f(x, 2) calls is harmlessly ignored)
	const lines = list.map((r, i) => {
		const parts = [ (i + 1) + '. ' + (r.pair || r.dealId) + ' — ' + (r.priceStale ? 'stale price (no live figure)' : (r.inProfit ? 'in profit' : 'underwater')) ];
		if (r.unrealizedPnl != null) { parts.push('unrealized P/L ' + f(r.unrealizedPnl, 2) + (r.unrealizedPct != null ? ' (' + f(r.unrealizedPct, 2) + '%)' : '')); }
		if (r.pctToTakeProfit != null && !r.priceStale) { parts.push(f(r.pctToTakeProfit, 2) + '% to take-profit'); }
		if (r.safetyOrdersUsed != null) { parts.push(r.safetyOrdersUsed + ' safety orders used'); }
		return parts.join(', ');
	});
	let header = 'Here is each of your open deals';
	if (res.open_deals_total != null) {
		header += ' (' + res.open_deals_total + ' total';
		if (res.open_deals_in_profit != null && res.open_deals_underwater != null) { header += ', ' + res.open_deals_in_profit + ' in profit, ' + res.open_deals_underwater + ' underwater'; }
		header += ')';
	}
	let out = header + ':\n\n' + lines.join('\n');
	if (list.length < (res.open_deals_total || 0)) { out += '\n\n(Showing the ' + list.length + ' deals with live figures; ask me about a specific deal for its full detail.)'; }
	return out;
}

// Render a diagnose_deal result into a compact, human-readable facts block the model narrates from. Only
// non-empty fields are listed. This is the grounded source of truth — the model is told to use only these
// figures, so the answer can never drift from the deal record.
function buildDealFacts(res) {

	const d = (res && res.deal) || {};
	const L = [];
	const add = (label, v) => { if (v !== null && v !== undefined && v !== '') { L.push(label + ': ' + v); } };

	add('Deal id', d.dealId);
	add('Pair', d.pair);
	add('Bot', d.botName);
	add('Exchange', d.exchange);
	add('Status', d.status);
	add('Average price', d.averagePrice);
	add('Take-profit target price', d.targetPrice);
	// Live in-flight state for an OPEN deal (populated from the deal tracker): current price, unrealized
	// P/L and how far it still is from the take-profit target. These are the figures that make a live
	// report useful ("how far underwater is it, is it near target"); absent for a completed deal.
	add('Current price', d.currentPrice);
	if (d.unrealizedPnl != null) { add('Unrealized P/L', d.unrealizedPnl + (d.unrealizedPct != null ? ' (' + d.unrealizedPct + '%)' : '')); }
	if (d.pctToTakeProfit != null) { add('Distance to take-profit', d.pctToTakeProfit + '% above current price' + (d.readyToTakeProfit ? ' — AT or PAST target now' : '')); }
	if (d.ordersFilled != null) { add('Orders filled', d.ordersFilled + (d.ordersTotal != null ? ' of ' + d.ordersTotal : '')); }
	if (d.safetyOrdersUsed != null) { add('Safety orders used', d.safetyOrdersUsed + (d.safetyOrdersMax != null ? ' of ' + d.safetyOrdersMax : '')); }
	// "Ladder exhausted" is a present-tense state — only meaningful for an OPEN deal that actually has a
	// safety-order ladder. Omit it for a closed deal (where it reads as a false concern) and for a
	// base-only deal with no safety orders (where filled >= orders-1 is trivially true).
	if (d.status !== 'complete' && d.ladderExhausted != null && d.safetyOrdersMax > 0) { add('Safety-order ladder exhausted', d.ladderExhausted ? 'yes' : 'no'); }
	add('Quantity held', d.qtyFilled);
	add('Open for', d.elapsedHuman);
	if (d.paused != null) { add('Paused', d.paused ? ('yes' + (d.pauseReason ? ' (' + d.pauseReason + ')' : '')) : 'no'); }
	if (d.status === 'complete') {
		if (d.profitPercent != null) { add('Result', d.profitPercent + '%' + (d.profitQuote != null ? ' (' + d.profitQuote + (d.profitCurrency ? ' ' + d.profitCurrency : '') + ')' : '')); }
		add('Profitable', d.profitable === true ? 'yes' : (d.profitable === false ? 'no' : null));
		add('Sell price', d.sellPrice);
	}
	if (res && res.concerns && res.concerns.length) { L.push('Concerns: ' + res.concerns.join(' ')); }
	else if (res && res.assessment) { L.push('Assessment: ' + res.assessment); }

	// Real error log events for a "what happened / why did it fail" diagnosis. The concern above only says HOW
	// MANY error-like events there were; surface the actual messages (ANSI-stripped, capped) so a failure report
	// carries the concrete detail instead of "see events for detail". Only ERROR-like events are included — a
	// healthy deal's routine events (recalcs, order fills) would just clutter its otherwise clean report.
	if (res && Array.isArray(res.events) && res.events.length) {
		const strip = (v) => { try { return shareData.Common.stripAnsi(String(v == null ? '' : v)); } catch (e) { return String(v == null ? '' : v); } };
		const errRe = /\b(error|fail(?:ed|ure)?|exception|unable|invalid|timeout|rejected|insufficient|not enough|cancell?ed|retries exhausted)\b/i;
		const errEvents = res.events.filter(l => errRe.test(String(l))).slice(-8).map(l => strip(l).trim()).filter(Boolean);
		if (errEvents.length) {
			L.push('Error / problem log events (verbatim — report these specifics):');
			for (const line of errEvents) { L.push('  ' + line); }
		}
	}

	return L.join('\n');
}

// Fetch a deal deterministically and produce its report. Returns the answer string, or null to signal
// the caller to fall through to the normal tool loop. A missing deal returns a clean "not found" string
// (a handled answer, NOT null) so a bogus id can never become a hallucinated analysis.
async function answerDealReport({ dealId, roomData, model, question, timezone, nowBase }) {

	let res;
	try { res = await aiTools.execute('diagnose_deal', { deal_id: dealId }, { timezone }); }
	catch (e) { return null; }

	if (!res || res.error) { return null; }

	if (!res.found || !res.deal) {
		return "I couldn't find a deal with id " + dealId + " in your SymBot data. Double-check the id, or ask me to list your open or recent deals.";
	}

	const facts = buildDealFacts(res);

	const sys = (roomData && roomData.persona && roomData.persona.content ? roomData.persona.content : PERSONA)
		+ '\n\n' + aiGuardrails.ADVICE_SYSTEM_NOTE + '\n\n' + nowBase
		+ '\n\nThe data block below is the USER\'S OWN deal record from their SymBot account. Report it clearly. Include EVERY line from the data block — present every field it lists (status, current/average/target price, unrealized P/L, distance to take-profit, orders filled, safety orders, quantity held, how long it has been open, paused, concerns), and do not omit or merge any that is present. If the data block includes log events, quote the actual error / problem lines verbatim and explain what they mean for this deal — those are the concrete specifics of what happened, so never summarize them away as "see the logs". This is their own account data — it is NOT financial advice and NOT a market call, so never refuse it and never add outside token or market trivia. Use only the figures given below.';
	const userMsg = 'Give me a detailed report of my deal ' + dealId + '.\n\nDeal data:\n' + facts;
	const prefill = 'Here is the breakdown of your deal ' + dealId + ':\n\n';
	const gen = resolveGenOptions('chat');

	const complete = async (msgs) => {
		try { const r = await completePrompt(msgs, model, gen); return (typeof r === 'string') ? r.trim() : ''; }
		catch (e) { return ''; }
	};

	// Attempt 1 — assistant prefill (the research-backed, most reliable lever on local models: the model
	// continues the compliant opener into the report instead of refusing).
	let cont = await complete([ { role: 'system', content: sys }, { role: 'user', content: userMsg }, { role: 'assistant', content: prefill } ]);
	let answer = null;
	if (cont && !aiGuardrails.looksLikeAdviceRefusal(cont)) { answer = prefill + cont; }

	// Attempt 2 — no prefill (a provider that ignores a trailing assistant turn still gets a clean pass).
	if (!answer) {
		cont = await complete([ { role: 'system', content: sys }, { role: 'user', content: userMsg } ]);
		if (cont && !aiGuardrails.looksLikeAdviceRefusal(cont)) { answer = cont; }
	}

	// Last resort — present the grounded facts directly, so the user always gets their data, never a refusal.
	if (!answer) { answer = prefill + facts; }

	return finalizeAnswer(answer, facts, question, knownEntitiesText(roomData && roomData.recentEntities));
}


// Authoritative bot-name list for egress grounding (see finalizeAnswer's bot-subject check). Cached briefly
// so a burst of chat turns does not re-query the store; read-only and best-effort — any failure yields an
// empty list and the caller falls back to the tool results.
let _botNamesCache = { at: 0, names: [] };
async function botNamesForGrounding() {
	try {
		const now = Date.now();
		if (now - _botNamesCache.at < 30000 && _botNamesCache.names.length) { return _botNamesCache.names; }
		if (shareData && shareData.DCABot && typeof shareData.DCABot.getBots === 'function') {
			const docs = await shareData.DCABot.getBots({}) || [];
			const names = [];
			for (const b of docs) { if (b && b.botName && names.indexOf(b.botName) === -1) { names.push(b.botName); } }
			_botNamesCache = { at: now, names };
			return names;
		}
	}
	catch (e) { /* best-effort — empty list falls back to the tool-derived names */ }
	return [];
}


async function runToolLoop({ room, messages, model, maxIterations, abortSignal, onActivity, footer, stream = true, attachmentSources = [], cleanSystem = null, shortlist = null, question = null, timezone = null, recentEntities = null, dataContinuation = false }) {

	const adapter = providerAdapters[aiProvider];

	if (!adapter || !aiClient || typeof adapter.chatWithTools !== 'function') { return null; }

	// Authoritative bot names, fetched once for this turn's egress bot-subject grounding (best-effort).
	const groundingBotNames = await botNamesForGrounding();

	// Model cascade: when a stronger tool_model is configured, the ENTIRE data path (tool selection,
	// argument emission, and the grounded answer composition) runs on it — this is where a small model
	// most often invents an id or miscounts. Empty config → unchanged (one model for everything). The
	// free-form fast lane is untouched; it keeps using the lighter chat model.
	const toolCfgModel = getToolsConfig().tool_model;
	if (toolCfgModel) { model = toolCfgModel; }

	const toolSchemas = aiTools.listSchemas(shortlist);
	const toolNames = toolSchemas.map(s => s && s.function && s.function.name).filter(Boolean);

	if (shortlist && shareData && shareData.Common && typeof shareData.Common.logger === 'function') {
		shareData.Common.logger('AI tools: shortlisted ' + toolNames.length + ' tools [' + toolNames.join(', ') + ']');
	}
	const convo = messages.slice();

	// Context-window guard: the conversation shown to the model each round is clamped to this budget so
	// accumulated tool results can never evict the system prompt on a small-context model. `convo` keeps
	// its full content (for the next round and the faithfulness sources); only the sent copy is clamped.
	const convoBudget = resolveConvoBudgetChars();

	let firstCall = true;
	const used = [];

	// Grounded-identifier set for constraining follow-up tool-call arguments (see AITools
	// constrainToolSchemas / reconcileToolArgs): the deal ids and pairs that actually appear this turn —
	// seeded from the user's own question and grown from each tool result — so the model cannot invent an
	// id/pair to look up. Empty on the first call (nothing to constrain yet).
	const grounded = { ids: new Set(), pairs: new Set() };
	const addGrounded = (text) => {
		try {
			const ent = aiGuardrails.extractEntities(text || '');
			(ent.dealIds || []).forEach(x => grounded.ids.add(x));
			(ent.pairs || []).forEach(x => grounded.pairs.add(x));
		}
		catch (e) { /* best-effort */ }
	};
	addGrounded(question);

	// Grounding sources for the optional faithfulness check applied to the final
	// answer: the raw tool results plus any uploaded-file text, so an answer drawn
	// from an attachment is not wrongly flagged as unsupported.
	const sources = (attachmentSources || []).slice();
	sources.forEach(addGrounded);
	const verify = getToolsConfig().verify;

	// KV-CACHE STABILITY: the tool schemas sit at the front of the prompt, so if they change between rounds the
	// cached prefix is invalidated and every round re-prefills the whole ~10k-token prompt from scratch
	// (measured ~8-15s each on local Ollama, where prefill dominates the turn). Compute the grounded-id enum
	// constraint ONCE, from the ids already known before the loop (the question / attachments) which do not
	// change — so the schemas stay byte-identical across every round and the model reuses the cached prefix
	// (measured prefill 8.6s → ~0.1s once reused; the same stable prefix also lets a hosted provider's automatic
	// prompt cache apply). Ids discovered mid-loop from tool results still grow `grounded` for reconcileToolArgs
	// (the deterministic backstop that snaps a fabricated/truncated id before the call runs), so id-grounding
	// safety is unchanged — only the per-round SCHEMA mutation is dropped.
	const stableSchemas = aiTools.constrainToolSchemas(toolSchemas, grounded);

	// Loop guards: a small model can repeat the same call or keep hitting errors. Track
	// per-call-signature counts, the previous round's signatures, and a failure streak
	// so the loop can stop and answer instead of thrashing or fabricating results.
	const callCounts = new Map();
	let lastRoundSigs = null;
	let failStreak = 0;
	const callSig = (name, a) => { try { return name + ':' + JSON.stringify(a); } catch (e) { return name + ':?'; } };

	// Corrective recover-gate (opt-in via ai.tools.corrective): if a whole tool loop comes back empty —
	// every result zero-row / unavailable / error — rephrase the question ONCE and let the model try the
	// tools again with the clearer wording before it answers "no data". Bounded (one 12s LLM call) and
	// fail-safe: a failed rephrase just lets the model answer from what it has. Fires at most once.
	const correctiveOn = getToolsConfig().corrective;
	let corrected = false;
	let anyStrong = false;   // did ANY tool result this loop come back with real data?
	let narrationNudged = false;   // guards the one-shot "you described a tool call but didn't make it" nudge

	// Fail-closed grounding gate. A question about the user's OWN data/operations (deals, P/L, errors, logs,
	// status, counts) MUST be answered from a tool result. If the model tries to finish such a question having
	// executed NO tool, it is answering from its own head — the exact path that fabricated a whole error report
	// in production. We force one grounding attempt and, failing that, abstain (GROUNDING_ABSTENTION) rather
	// than ship an invented answer. Concept / how-to / definitional questions are NOT data questions and are
	// excluded, so general chat is untouched. A tool that runs and returns an honest zero ("no errors") still
	// counts as grounded — the model may report that truthfully; only NEVER-consulting-the-data is blocked.
	const mustGround = dataContinuation || (!!question && aiGuardrails.requiresGrounding(question));
	let groundNudged = false;   // one-shot "call the tool, do not answer from memory" nudge

	// One bounded rephrase of the question. Returns the rephrasing, or null (failure, timeout, or a
	// rephrase identical to the original — nothing to gain from retrying).
	const correctiveRephrase = async (q) => {
		try {
			const msgs = [
				{ role: 'system', content: REPHRASE_SYSTEM },
				{ role: 'user', content: 'Rephrase this so the tools can find the answer:\n\n' + String(q || '') }
			];
			const res = await withTimeout(adapter.createNonStream(aiClient, model, msgs, abortSignal, undefined), 12000);
			const out = String((res && adapter.extractNonStreamContent(res)) || '').trim().replace(/^["']+|["']+$/g, '').split('\n')[0].trim();
			if (!out || out.toLowerCase() === String(q || '').trim().toLowerCase()) { return null; }
			return out.slice(0, 300);
		}
		catch (e) { return null; }
	};

	// Produce the single corrective retry nudge (a user turn steering a fresh tool attempt with the
	// rephrased question), or null when correction does not apply / did not yield a new phrasing. Consumes
	// the one allowed attempt on first eligible call so it can never loop.
	const correctiveNudge = async () => {
		if (!correctiveOn || corrected || anyStrong || used.length === 0 || !question) { return null; }
		corrected = true;
		const reformulated = await correctiveRephrase(question);
		if (!reformulated) { return null; }
		failStreak = 0;   // give the retry a clean slate
		if (getToolsConfig().trace) { shareData.Common.logger('AI trace [' + (room || '?') + ']: corrective retry — rephrased "' + String(question).slice(0, 120) + '" → "' + reformulated + '"'); }
		return 'Those tools returned no matching data for that phrasing. Re-answer this rephrased version of the question, calling the appropriate tool(s) again with it: "' + reformulated + '"';
	};

	// On abort: the streaming caller gets a socket notice; the non-streaming (curl)
	// caller just gets an empty answer, since it has no socket to receive a notice.
	const onAbort = () => (stream ? abortToolLoop(room) : '');

	for (let iter = 0; iter < maxIterations; iter++) {

		if (abortSignal && abortSignal.aborted) { return onAbort(); }

		let assistantMessage;
		let toolCalls;

		try {

			// Stable across rounds (computed once, above) so the model reuses the cached prompt prefix instead
			// of re-prefilling ~10k tokens every round. reconcileToolArgs (below) is the deterministic id
			// backstop for identifiers discovered mid-loop, so dropping the per-round schema mutation is safe.
			({ assistantMessage, toolCalls } = await adapter.chatWithTools(aiClient, model, clampConversation(convo, convoBudget), stableSchemas));
		}
		catch (err) {

			if (abortSignal && abortSignal.aborted) { return onAbort(); }

			// A model/endpoint that does not support tool-calling fails the very first
			// call — signal the caller to fall back to the normal (router) chat path.
			if (firstCall) { return null; }

			// A later failure (e.g. the model emitted malformed tool-call output that the
			// provider could not parse) must not surface as an error: break out and
			// compose a final answer from the tool results already gathered.
			shareData.Common.logger('AI tools (' + aiProvider + '): recovering from mid-loop error: ' + err.message);
			break;
		}

		firstCall = false;
		onActivity?.();

		convo.push(assistantMessage);

		if (!toolCalls || toolCalls.length === 0) {

			const content = (assistantMessage.content || '').trim();

			// Some models emit the tool call as JSON text in content instead of the
			// structured tool_calls field — recover it when the name matches a real tool
			// (ordinary prose never matches, so it stays a final answer).
			const leaked = extractLeakedToolCall(content, toolNames);

			if (leaked) {

				used.push(leaked.name);
				const _traceT0 = getToolsConfig().trace ? Date.now() : 0;
				const result = await aiTools.execute(leaked.name, leaked.args, { onActivity, timezone });
				if (getToolsConfig().trace) {
					let argStr = ''; try { argStr = JSON.stringify(leaked.args || {}); } catch (e) { argStr = '?'; }
					shareData.Common.logger('AI trace [' + (room || '?') + ']: ' + leaked.name + ' (text) args=' + argStr.slice(0, 300) + ' → ' + (Date.now() - _traceT0) + 'ms ' + summarizeToolResult(result));
				}
				const resultStr = JSON.stringify(result);

				// Replace the plain assistant turn with a canonical tool-call turn so the
				// follow-up tool result is valid for OpenAI-shaped endpoints.
				convo[convo.length - 1] = { role: 'assistant', content: '', tool_calls: [ { id: leaked.id, type: 'function', function: { name: leaked.name, arguments: JSON.stringify(leaked.args) } } ] };
				convo.push(adapter.formatToolResult({ id: leaked.id, name: leaked.name }, resultStr));
				sources.push(resultStr);
				onActivity?.();

				if (abortSignal && abortSignal.aborted) { return onAbort(); }

				continue;
			}

			// The model emitted a JSON blob attempting a tool that does not exist (e.g.
			// a made-up get_current_time) instead of an answer. Don't show that raw JSON
			// — drop the junk turn and re-answer plainly from the accumulated context
			// (which still carries the current-time note), with no tools.
			const stripped = content.replace(/^```(?:json)?\s*/i, '').trim();
			const looksLikeToolAttempt = /^\{\s*"(name|function|tool|tool_name)"\s*:/.test(stripped);

			if (looksLikeToolAttempt) {

				convo.pop();
				break;
			}

			// An endpoint that silently ignored the tools array and returned nothing
			// usable on the FIRST call → fall back to the grounded router path instead
			// of a blank answer.
			if (iter === 0 && content === '') { return null; }

			// Prose that DESCRIBES calling a tool but never emitted one — e.g. "I will call the
			// list_open_deals tool". Common on smaller local models when part of a MIXED question
			// (a concept plus an account figure) is answered in prose first: the model stays in prose
			// mode and narrates the data lookup instead of executing it, leaving that part unanswered.
			// Requiring BOTH an intent phrase AND a verbatim real tool name keeps ordinary prose from
			// matching. Nudge ONCE to actually call it, then let the loop compose the full answer.
			if (!narrationNudged && iter < maxIterations - 1) {

				const intent = /\b(i'?ll|i\s+will|i'?m\s+going\s+to|i\s+am\s+going\s+to|let\s+me|i\s+shall|i\s+need\s+to|i\s+can|i\s+should)\s+(call|use|invoke|run|query|check|look\s?up|fetch|retrieve|get)\b/i;
				const namesRealTool = toolNames.some(n => n && content.includes(n));

				if (namesRealTool && intent.test(content)) {

					narrationNudged = true;
					convo.pop();   // drop the narration turn so the retry isn't anchored to it
					convo.push({ role: 'user', content: 'You described calling a tool but did not actually call it. Call the needed tool(s) now using the tool-calling function — do not describe the call in words — then give your complete answer covering every part of the question.' });
					if (getToolsConfig().trace) { shareData.Common.logger('AI trace [' + (room || '?') + ']: narration catch — model described a tool call without emitting one; nudging to execute'); }
					continue;
				}
			}

			// The model stopped calling tools but the loop retrieved nothing usable — before it commits to
			// a "no data" answer, try one corrective rephrase and let it retry the tools. Drop this
			// premature giving-up turn so the retry isn't anchored to it.
			const nudge = await correctiveNudge();
			if (nudge) { convo.pop(); convo.push({ role: 'user', content: nudge }); continue; }

			// FAIL-CLOSED GROUNDING. A data question about the user's own account/operations that reached this
			// point with NO tool executed was about to be answered from the model's own head — the production
			// fabrication path. Force ONE grounding attempt; if the model still won't call a tool, abstain with
			// a fixed line instead of shipping the invented answer. (A tool that ran and returned an honest zero
			// sets used.length>0, so a truthful "no errors found" is never suppressed.)
			if (mustGround && used.length === 0) {
				// A concrete data QUESTION gets one nudge to actually call the tool. A bare data CONTINUATION
				// ("tell me more") does NOT — the nudge rarely helps a vague follow-up and the extra model round
				// is what timed the turn out in production; abstain immediately instead (fast and safe).
				if (!dataContinuation && !groundNudged && iter < maxIterations - 1) {
					groundNudged = true;
					convo.pop();   // drop the ungrounded draft so the retry isn't anchored to it
					convo.push({ role: 'user', content: 'Do not answer from memory or make up figures. Call the appropriate tool now to fetch the actual data for this question, then answer only from what it returns.' });
					continue;
				}
				const abst = finalizeAnswer(GROUNDING_ABSTENTION, '', question, knownEntitiesText(recentEntities));
				if (stream) { await streamReplay({ room, text: abst, footer, abortSignal, onActivity }); }
				shareData.Common.logger('AI tools (' + aiProvider + '): fail-closed abstention — data question answered with no tool consulted [' + (room || '?') + ']');
				return abst;
			}

			// No more tools requested — this is the final answer. Optionally verify it
			// against the tool results and append a subtle caveat only if poorly
			// grounded. In streaming mode replay it in chunks so it reveals
			// progressively; in non-streaming mode just return it for the HTTP caller.
			let finalAnswer = content;
			if (verify && used.length && sources.length) {
				finalAnswer = await reGroundIfNeeded(convo, model, finalAnswer, sources.join('\n\n'));
				finalAnswer += await faithfulnessNote(finalAnswer, sources.join('\n\n'), model);
			}
			finalAnswer = finalizeAnswer(finalAnswer, sources.join('\n\n'), question, knownEntitiesText(recentEntities), { botNames: groundingBotNames });
			if (stream) { await streamReplay({ room, text: finalAnswer, footer, abortSignal, onActivity }); }
			shareData.Common.logger('AI tools (' + aiProvider + '): ' + JSON.stringify({ room, tools: used }));
			captureLearning({ room, question, tools: used, sources, answer: finalAnswer });
			return finalAnswer;
		}

		// Enum-lock each emitted tool name onto the shortlist we actually offered this turn (repairs
		// camelCase / spacing / near-miss names) BEFORE the loop guards, dispatch and learning see it,
		// so signatures, logging and the captured corpus all stay on canonical names.
		for (const tc of toolCalls) { tc.name = aiTools.resolveTool(tc.name, toolNames) || tc.name; }

		// Deterministic backstop to the enum constraint above: snap a fabricated/truncated id (or a
		// mis-cased pair) to its real grounded form BEFORE the loop guards, dispatch and learning see the
		// call, so a non-existent identifier is never queried and the signatures stay canonical.
		for (const tc of toolCalls) { tc.args = aiTools.reconcileToolArgs(tc.args, grounded); }

		// Signatures for the loop guards, before running anything.
		const roundSigs = toolCalls.map(tc => callSig(tc.name, tc.args));
		roundSigs.forEach(sig => callCounts.set(sig, (callCounts.get(sig) || 0) + 1));

		const exactRepeat = lastRoundSigs && roundSigs.length === lastRoundSigs.length && roundSigs.every((s, i) => s === lastRoundSigs[i]);
		const thrashing = roundSigs.some(sig => callCounts.get(sig) >= 3);
		lastRoundSigs = roundSigs;

		// Run this round's tool calls concurrently — read-only tools have no ordering
		// hazard — then append the results in the original call order.
		const traceOn = getToolsConfig().trace;
		const executed = await Promise.all(toolCalls.map(async (tc) => {
			const t0 = traceOn ? Date.now() : 0;
			const result = await aiTools.execute(tc.name, tc.args, { onActivity, timezone });
			// Diagnostic trace (opt-in): show exactly which tool ran, with what arguments, how long it took,
			// and how its result came out — the single most useful signal when an answer looks wrong.
			if (traceOn) {
				let argStr = ''; try { argStr = JSON.stringify(tc.args || {}); } catch (e) { argStr = '?'; }
				shareData.Common.logger('AI trace [' + (room || '?') + ']: ' + tc.name + ' args=' + argStr.slice(0, 300) + ' → ' + (Date.now() - t0) + 'ms ' + summarizeToolResult(result));
			}
			return { tc, result, resultStr: JSON.stringify(result) };
		}));

		let allErrored = executed.length > 0;

		for (const e of executed) {

			used.push(e.tc.name);
			convo.push(adapter.formatToolResult(e.tc, e.resultStr));
			sources.push(e.resultStr);
			addGrounded(e.resultStr);   // grow the grounded id/pair set for the next round's arg constraint

			if (!(e.result && typeof e.result === 'object' && 'error' in e.result)) { allErrored = false; }
			if (!weakResult(e.result)) { anyStrong = true; }   // any real data means no corrective needed
		}

		onActivity?.();

		if (abortSignal && abortSignal.aborted) { return onAbort(); }

		failStreak = allErrored ? failStreak + 1 : 0;

		// Stop thrashing: identical round repeated, one call made too many times, or a
		// run of failing calls — answer from what we have rather than fabricating more.
		if (exactRepeat || thrashing || failStreak >= 3) {

			// Before giving up, if the loop retrieved nothing usable, try one corrective rephrase and let
			// the model take a fresh shot at the tools with clearer wording.
			const nudge = await correctiveNudge();
			if (nudge) { convo.push({ role: 'user', content: nudge }); continue; }

			convo.push({ role: 'user', content: 'Stop calling tools now and answer using the results already gathered. If they are insufficient, say plainly what is missing.' });
			shareData.Common.logger('AI tools (' + aiProvider + '): loop guard tripped (' + (exactRepeat ? 'repeat' : thrashing ? 'thrash' : 'failures') + ')');
			break;
		}
	}

	// Final answer with NO tools — reached on the iteration cap or after recovering from
	// a mid-loop error / a fake-tool attempt. Compose from the accumulated context; if
	// that comes back empty (e.g. tool turns derailed a general question like "time in
	// EST"), retry with just the clean system note and the original question so the user
	// always gets a real answer rather than a blank.
	const finalNumCtx = configuredNumCtx();
	const finalAnswerFrom = async (msgs) => {
		try {
			// Same eviction guard on the tool-free composition, and pass the configured window when set.
			const res = await adapter.createNonStream(aiClient, model, clampConversation(msgs, convoBudget), undefined, finalNumCtx > 0 ? { num_ctx: finalNumCtx } : undefined);
			return (adapter.extractNonStreamContent(res) || '').trim();
		}
		catch (e) { return ''; }
	};

	try {

		// FAIL-CLOSED GROUNDING (post-loop): the loop ended (cap / thrash / recovery) without ever executing a
		// tool for a question about the user's own data — do not let the tool-free composition invent it. Abstain.
		if (mustGround && used.length === 0) {
			const abst = finalizeAnswer(GROUNDING_ABSTENTION, '', question, knownEntitiesText(recentEntities));
			if (stream) { await streamReplay({ room, text: abst, footer, abortSignal, onActivity }); }
			shareData.Common.logger('AI tools (' + aiProvider + ', capped): fail-closed abstention — data question, no tool consulted [' + (room || '?') + ']');
			return abst;
		}

		let finalContent = await finalAnswerFrom(convo);

		if (!finalContent) {

			const sys = cleanSystem || convo[0];
			const lastUser = convo.slice().reverse().find(m => m && m.role === 'user');
			finalContent = await finalAnswerFrom([ sys, lastUser ].filter(Boolean));
		}

		if (!finalContent) { finalContent = "Sorry — I couldn't complete that request. Please try rephrasing it."; }

		if (verify && used.length && sources.length) {
			finalContent = await reGroundIfNeeded(convo, model, finalContent, sources.join('\n\n'));
			finalContent += await faithfulnessNote(finalContent, sources.join('\n\n'), model);
		}
		finalContent = finalizeAnswer(finalContent, sources.join('\n\n'), question, knownEntitiesText(recentEntities), { botNames: groundingBotNames });
		if (stream) { await streamReplay({ room, text: finalContent, footer, abortSignal, onActivity }); }
		shareData.Common.logger('AI tools (' + aiProvider + ', capped): ' + JSON.stringify({ room, tools: used }));
		captureLearning({ room, question, tools: used, sources, answer: finalContent });
		return finalContent;
	}
	catch (err) {

		if (stream) { sendChatEnd(room); }
		return '';
	}
}


const streamChatProvider = async ({ model, stream, messages, abortSignal, onActivity, room, options, footer }) => {

	let fullResponse = '';

	const adapter = providerAdapters[aiProvider];

	if (!adapter) {

		throw new Error('No adapter found for AI provider: ' + aiProvider);
	}

	if (!stream) {

		try {

			const result = await adapter.createNonStream(aiClient, model, messages, abortSignal, options);

			if (abortSignal.aborted) {

				return fullResponse;
			}

			onActivity?.();
			fullResponse = adapter.extractNonStreamContent(result);
		}
		catch (err) {

			if (err.name === 'AbortError' || abortSignal.aborted) {

				return fullResponse;
			}

			throw err;
		}
	}
	else {

		const result = await adapter.createStream(aiClient, model, messages, abortSignal, options);

		// Wire the abort signal directly to the iterator so the provider
		// stops generating immediately rather than waiting for the next chunk.
		const onAbort = () => { try { result.abort?.(); } catch (_) {} };

		if (abortSignal.aborted) {

			// The generation was aborted before the first chunk arrived — typically a
			// timeout while a large model was still loading. Surface the reason (the
			// mid-stream abort path below does the same) so the chat shows a notice
			// instead of silently going blank.
			onAbort();
			sendAborted(room, 'Response stopped due to timeout. Please try again.');
			sendChatEnd(room);
			return fullResponse;
		}

		abortSignal.addEventListener('abort', onAbort, { once: true });

		try {

			for await (const part of result) {

				const content = adapter.extractChunkContent(part);
				if (!content) continue;

				onActivity?.();

				fullResponse += content;
				sendMessage(room, content);
			}
		}
		catch (err) {

			// AbortError is expected — notify user and close stream gracefully
			if (err.name === 'AbortError' || abortSignal.aborted) {

				sendAborted(room, 'Response stopped due to timeout. Please try again.');
				sendChatEnd(room);
				return fullResponse;
			}

			throw err;
		}
		finally {

			abortSignal.removeEventListener('abort', onAbort);
		}

		// Append the analysis footer as a final chunk so it renders at the end.
		if (footer) { fullResponse += footer; sendMessage(room, footer); }

		sendChatEnd(room);
	}

	return fullResponse;
};


const streamChatResponseWithTimeout = async ({ room, model, message, reset, stream, options, footer, purpose }) => {

	let idleTimeout;
	let hardTimeout;

	// The explore / deep-research sub-agent is a legitimately long operation on a local model — a
	// bounded nested loop of tool calls plus a final synthesis — so a normal run can exceed the usual
	// ceilings and was being aborted mid-analysis, which severed the HTTP connection ("socket hang
	// up"). When that path is available, give the request generous idle and hard ceilings. It can't
	// hang forever: the deep flow itself is wall-clock-bounded (AIDeepAnalysis gatherBudgetMs) and the
	// explore tool is time-boxed, so these ceilings only need to outlast a legitimate run.
	const _tc = getToolsConfig();
	const deepPath = !!(purpose === 'chat' && _tc && _tc.enabled && _tc.explore);
	const idleMs = deepPath ? Math.max(TIMEOUT_MS, 120000) : TIMEOUT_MS;

	let hardTimeoutMs = deepPath ? 300000 : (TIMEOUT_MS * 1.5);

	const abortController = new AbortController();

	// Register so external callers can abort this generation (e.g. client closes view)
	activeGenerations.set(room, abortController);

	const resetIdleTimeout = () => {

		clearTimeout(idleTimeout);

		idleTimeout = setTimeout(() => {

			abortController.abort();
		}, idleMs);
	};

	// Start timers
	resetIdleTimeout();

	hardTimeout = setTimeout(() => {

		abortController.abort();
	}, hardTimeoutMs);

	try {

		return await streamChatResponse({
			room,
			model,
			message,
			abortSignal: abortController.signal,
			reset,
			stream,
			onActivity: resetIdleTimeout,
			options,
			footer,
			purpose
		});
	}
	finally {

		clearTimeout(idleTimeout);
		clearTimeout(hardTimeout);
		activeGenerations.delete(room);
	}
};


async function streamChat(data) {

	let room;
	let reset;
	let stream;
	let model = modelCurrent;
	let success = false;
	let dataOut = null;

	try {

		const parsedData = JSON.parse(data);

		room = parsedData.message.room;

		if (parsedData.message.model) {

			model = parsedData.message.model;
		}

		const message = {
			role: 'user',
			content: parsedData.message.content,
			attachments: Array.isArray(parsedData.message.attachments) ? parsedData.message.attachments : [],
			// The requester's IANA timezone (sent by the browser), so date-based tools resolve "today"/
			// "this month" in the USER's zone rather than the server's. Absent on the curl/API path →
			// tools default to UTC.
			timezone: (typeof parsedData.message.timezone === 'string') ? parsedData.message.timezone : null
		};

		reset = parsedData.message.reset || false;
		stream = parsedData.message.stream ?? true;

		// The purpose selects the decoding preset (chat / analysis / journal …).
		// Callers that omit it get plain chat behavior, unchanged from before.
		const purpose = parsedData.message.purpose || 'chat';
		const options = resolveGenOptions(purpose);

		// Use the configured Deal Analysis Model (when the caller did not pin one
		// explicitly) both for the analysis itself and for follow-up questions in an
		// analysis conversation — the client sets useAnalysisModel for those, so the
		// whole deal conversation stays on the stronger model rather than dropping to
		// the chat model after the first message. Read live from config so a config
		// change applies to the very next message without a restart.
		const wantAnalysisModel = purpose === 'analysis' || parsedData.message.useAnalysisModel === true;

		if (wantAnalysisModel && !parsedData.message.model) {

			const genCfg = (shareData.appData && shareData.appData.ai && shareData.appData.ai.generation) || {};

			if (typeof genCfg.analysis_model === 'string' && genCfg.analysis_model.trim() !== '') {

				model = genCfg.analysis_model.trim();
			}
		}

		// Note which model produced a streamed analysis, appended once the stream ends
		// (the non-streaming API path adds its own footer, so scope this to streaming).
		const footer = (purpose === 'analysis' && stream) ? ('\n\n_Analyzed with ' + model + '_') : '';

		if (!aiStarted) {

			throw new Error('AI client not started or is not enabled');
		}

		const result = await streamChatResponseWithTimeout({
			room,
			model,
			message,
			reset,
			stream,
			options,
			footer,
			purpose,
		});

		success = true;

		if (!stream) {

			dataOut = result;
		}
	}
	catch (err) {

		success = false;
		dataOut = err.message;

		if (room && stream) {

			sendError(room, dataOut);
		}
	}

	return { success, data: dataOut };
}


async function sendMessage(room, msg) {

	shareData.Common.sendSocketMsg({
		room,
		type: 'message',
		message: msg,
	});
}


async function sendError(room, msg) {

	const logData = 'AI Error (' + (aiProvider || 'unknown') + '): ' + msg;

	shareData.Common.logger(logData);
	sendMessage(room, logData);
}


async function sendAborted(room, reason) {

	shareData.Common.sendSocketMsg({
		room,
		type: 'aborted',
		message: reason || 'Response stopped due to timeout.',
	});
}


// Signal the end of a streamed chat answer OUT OF BAND — its own socket event type, never a message chunk.
// A previous in-band sentinel ('END_OF_CHAT' sent through sendMessage) meant an answer, or a document it
// quoted, that contained the literal text could prematurely end or blank the chat. An out-of-band signal
// carries no content, so it can never be spoofed by streamed text; the clients listen for this type the
// same way they already listen for 'aborted'. The non-streaming API path never emits it (it returns the
// composed answer in the HTTP response body), so this is purely for the streaming socket clients.
async function sendChatEnd(room) {

	shareData.Common.sendSocketMsg({
		room,
		type: 'chat_end',
	});
}


function start(provider, config) {

	const host = config.host;
	const apiKey = config.api_key;
	const model = config.model;
	const baseUrl = config.base_url;

	if (model != undefined && model != null && model != '') {

		modelCurrent = model;
	}
	else {

		modelCurrent = modelDefaults[provider] || modelDefaults.ollama;
	}

	aiProvider = provider;

	try {

		if (provider === 'openai') {

			const openAIConfig = {
				apiKey: apiKey || '',
			};

			if (baseUrl != undefined && baseUrl != null && baseUrl != '') {

				openAIConfig.baseURL = baseUrl;
			}

			aiClient = new OpenAI(openAIConfig);
		}
		else {

			let headers;

			if (apiKey) {

				headers = { 'Authorization': 'Bearer ' + apiKey };
			}

			aiClient = new Ollama({
				'host': host,
				'headers': headers
			});

			// Preload the model in the background so the FIRST user question is warm rather than paying a
			// multi-second cold-start. Fully fire-and-forget and swallowed — a warmup failure (Ollama down,
			// model not pulled) must never affect startup; this lives entirely in the isolated AI subsystem
			// and can never touch trading. keep_alive then holds it resident between turns.
			if (aiClient && modelCurrent) {
				const warmClient = aiClient, warmModel = modelCurrent;
				Promise.resolve().then(() => warmClient.chat({ model: warmModel, messages: [ { role: 'user', content: 'ok' } ], options: { num_predict: 1 }, keep_alive: ollamaKeepAlive() })).catch(() => {});
			}
		}

		aiStarted = true;
	}
	catch (err) {

		aiStarted = false;

		sendError('', err.message);
	}
}


function stop() {

	if (aiClient) {

		aiStarted = false;

		try {

			// Ollama's client.abort() cancels ALL in-flight requests on this client.
			// OpenAI does not expose a global abort — individual requests are
			// aborted via AbortSignal passed at request time.
			if (typeof aiClient.abort === 'function') {

				aiClient.abort();
			}

			aiClient = null;
		}
		catch (e) {}
	}
}


function cleanupRooms() {

	const now = Date.now();

	conversationHistory.forEach((roomData, room) => {

		const filteredMessages = roomData.messages.filter(

			msg => (now - msg.timestamp) <= maxMessageAge
		);

		if (filteredMessages.length === 0) {

			conversationHistory.delete(room);
		}
		else {

			roomData.messages = filteredMessages;
			conversationHistory.set(room, roomData);
		}
	});
}


function getServerId() {

	return shareData.appData.server_id || '';
}


async function listConversations() {

	const server_id = getServerId();
	return await shareData.AIChatDB.AIChatSchema
		.find({ server_id }, { conversation_id: 1, name: 1, type: 1, deal_id: 1, updatedAt: 1 })
		.sort({ updatedAt: -1 })
		.lean();
}


async function saveConversation(conversation_id, name, room, startIndex, type, deal_id) {

	const server_id = getServerId();
	const roomData = conversationHistory.get(room);

	let messages = roomData
		? roomData.messages.map(m => ({
			role: m.role,
			content: m.content,
			timestamp: m.timestamp || Date.now(),
			attachments: Array.isArray(m.attachments) ? m.attachments : []
		}))
		: [];

	// Only save messages from startIndex to avoid mixing in previously loaded messages
	if (startIndex !== undefined && startIndex > 0 && startIndex < messages.length) {
		messages = messages.slice(startIndex);
	}

	const update = {
		conversation_id,
		server_id,
		username: null,
		name,
		messages
	};

	if (type)    update.type    = type;
	if (deal_id) update.deal_id = deal_id;

	await shareData.AIChatDB.AIChatSchema.findOneAndUpdate(
		{ conversation_id },
		update,
		{ upsert: true, returnDocument: 'after' }
	);
}


async function loadConversation(conversation_id, room) {

	const server_id = getServerId();
	const doc = await shareData.AIChatDB.AIChatSchema.findOne({ conversation_id, server_id }).lean();

	if (!doc) return false;

	const maxHistory = (shareData.appData.ai && shareData.appData.ai.max_history) || maxHistoryDefault;
	let messages = doc.messages || [];
	if (messages.length > maxHistory - 1) messages = messages.slice(messages.length - (maxHistory - 1));

	conversationHistory.set(room, {
		persona: { role: 'system', content: PERSONA },
		messages: messages.map(m => ({ ...m, timestamp: Date.now() }))
	});

	return { name: doc.name, type: doc.type || 'chat', deal_id: doc.deal_id || '', messages };
}


async function deleteConversation(conversation_id) {

	const server_id = getServerId();
	await shareData.AIChatDB.AIChatSchema.deleteOne({ conversation_id, server_id });
}


function getChatHistory(room) {

	const roomData = conversationHistory.get(room);

	if (!roomData) {

		return [];
	}

	return roomData.messages.map(m => ({
		role: m.role,
		content: m.content,
		timestamp: m.timestamp,
		attachments: Array.isArray(m.attachments) ? m.attachments : []
	}));
}


function abortGeneration(room) {

	const controller = activeGenerations.get(room);

	if (controller) {

		controller.abort();
		activeGenerations.delete(room);
	}
}


// The model the client currently runs by default (the active chat model). Used
// to report which model produced an analysis when no explicit override was given.
function getModelName() {

	return (modelCurrent || '');
}


// Models that cannot produce a text analysis (embeddings, speech, image
// generation) — filtered out so the picker only offers models that can actually
// run a deal analysis or chat. Vision models are kept, as they still handle text.
const NON_TEXT_MODEL = ['embed', 'whisper', 'tts', 'dall-e', 'dalle', 'moderation',
	'transcribe', 'flux', 'z-image', 'image-turbo', 'stable-diffusion', 'sdxl'];

// Cache of model lists keyed by provider+host+base_url so repeated config-page
// loads do not keep hitting the provider APIs. A successful list is held longer
// than a failed (empty) one so a transient outage recovers quickly.
const modelListCache = new Map();
const MODEL_CACHE_TTL = 5 * 60 * 1000;
const MODEL_CACHE_TTL_EMPTY = 30 * 1000;

function isTextModel(id) {

	const s = String(id || '').toLowerCase();

	return (s !== '' && !NON_TEXT_MODEL.some(k => s.indexOf(k) !== -1));
}


// List the models a provider offers, so the UI can present real choices instead
// of a free-text guess. It is provider-aware: pass { provider, host, api_key,
// base_url } to list a specific provider using connection details entered in the
// config form (so each provider's model field shows its own models, even before
// the settings are saved). With no options it lists the active provider using the
// running client. Read-only and best-effort: any failure (provider unreachable, an
// endpoint without a model list, an SDK shape change) yields an empty list rather
// than throwing, and the picker falls back to manual entry.
async function listModels(opts) {

	opts = opts || {};

	const provider = opts.provider || aiProvider;

	const cacheKey = provider + '|' + (opts.host || '') + '|' + (opts.base_url || '');

	if (opts.force !== true) {

		const cached = modelListCache.get(cacheKey);

		if (cached && (Date.now() - cached.ts) < cached.ttl) { return cached.models; }
	}

	// Reuse the running client when it already matches and no override connection
	// was supplied; otherwise build a throwaway client from the given details.
	const reuseActive = provider === aiProvider && aiClient && !opts.host && !opts.api_key && !opts.base_url;

	try {

		let client = null;

		if (reuseActive) {

			client = aiClient;
		}
		else if (provider === 'ollama') {

			const headers = opts.api_key ? { 'Authorization': 'Bearer ' + opts.api_key } : undefined;

			client = new Ollama({ 'host': opts.host || undefined, 'headers': headers });
		}
		else if (provider === 'openai') {

			const cfg = { 'apiKey': opts.api_key || '' };

			if (opts.base_url) { cfg.baseURL = opts.base_url; }

			client = new OpenAI(cfg);
		}

		if (!client) { return []; }

		let ids = [];

		if (provider === 'ollama' && typeof client.list === 'function') {

			const res = await client.list();

			ids = ((res && res.models) || []).map(m => m.name || m.model);
		}
		else if (provider === 'openai' && client.models && typeof client.models.list === 'function') {

			const res = await client.models.list();

			ids = ((res && (res.data || (res.body && res.body.data))) || []).map(m => m.id);
		}

		const models = ids.filter(isTextModel).sort();

		modelListCache.set(cacheKey, {
			ts: Date.now(),
			models,
			ttl: models.length > 0 ? MODEL_CACHE_TTL : MODEL_CACHE_TTL_EMPTY
		});

		return models;
	}
	catch (e) {

		shareData.Common.logger('AI listModels failed (' + provider + '): ' + e.message);
	}

	return [];
}


// Whether a specific model can do tool-calling, so the UI can warn before a user
// turns AI Tools on with a model that will silently fall back. Ollama reports this
// directly (its /api/show "capabilities" lists "tools" for tool-trained templates);
// OpenAI-compatible providers do not expose a reliable per-model flag, so we return
// null (unknown) there and let the UI treat it as "assumed supported". Cached like the
// model list. Returns { supported: true|false|null }. Single exit.
async function modelSupportsTools(opts) {

	opts = opts || {};

	const provider = opts.provider || aiProvider;
	const model = opts.model;

	let supported = null;

	if (model && provider === 'ollama') {

		const cacheKey = 'caps|' + provider + '|' + (opts.host || '') + '|' + model;

		const cached = modelListCache.get(cacheKey);

		if (opts.force !== true && cached && (Date.now() - cached.ts) < cached.ttl) {

			return { 'supported': cached.supported };
		}

		try {

			const reuseActive = provider === aiProvider && aiClient && !opts.host && !opts.api_key;

			const client = reuseActive
				? aiClient
				: new Ollama({ 'host': opts.host || undefined, 'headers': opts.api_key ? { 'Authorization': 'Bearer ' + opts.api_key } : undefined });

			if (client && typeof client.show === 'function') {

				const info = await client.show({ 'model': model });
				const caps = (info && info.capabilities) || [];

				supported = Array.isArray(caps) ? caps.indexOf('tools') >= 0 : null;

				modelListCache.set(cacheKey, { ts: Date.now(), supported, ttl: MODEL_CACHE_TTL });
			}
		}
		catch (e) {

			// Unknown on error — the UI treats null as "can't tell", not "unsupported".
			shareData.Common.logger('AI modelSupportsTools failed (' + model + '): ' + e.message);
			supported = null;
		}
	}

	return { 'supported': supported };
}


// PURE diagnosis core for the preflight. Given what the IO layer gathered — the list of available
// models, the configured model, the provider, and (optionally) whether the model can do tools — it
// derives the readiness verdict and the actionable, user-facing messages. Kept pure (no network) so
// it is unit-testable and so all wording lives in one place. `messages` are UI diagnostics, not model
// prompts. Never throws.
//   in:  { provider, model, models: [], host, wantTools, toolsSupported: true|false|null|undefined }
//   out: { ok, provider, model, host, reachable, model_present, tools_supported, models_available, messages }
function diagnosePreflight(input) {

	input = input || {};

	const provider = input.provider || 'none';
	const model = input.model || '';
	const models = Array.isArray(input.models) ? input.models : [];
	const wantTools = input.wantTools === true;

	const result = {
		ok: false, provider: provider, model: model, host: input.host || '',
		reachable: models.length > 0, model_present: null, tools_supported: null,
		models_available: models, messages: []
	};

	const add = (level, text) => result.messages.push({ level: level, text: text });

	// Same base-name tolerance the model picker uses: a configured "llama3.1:8b" should match a listed
	// "llama3.1:8b" and, failing that, its tag-stripped base so a `:latest` drift still passes.
	const baseName = s => String(s || '').split(':')[0];

	if (!models.length) {

		// An empty list means either the service is unreachable or it exposes no model list. Either way
		// the user must act before AI works — give the provider-appropriate next step.
		if (provider === 'ollama') {
			add('error', 'Could not reach the local model service' + (input.host ? ' at ' + input.host : '') + ', or no models are installed. Make sure it is running (e.g. "ollama serve") and install a model with "ollama pull ' + (model || '<model>') + '".');
		}
		else {
			add('error', 'Could not reach the AI provider, or the API key was rejected. Check the endpoint URL and API key in AI settings.');
		}

		return result;
	}

	// Reachable. Is the configured model actually available on this machine/endpoint?
	if (model) {

		const present = models.indexOf(model) >= 0 || models.some(m => baseName(m) === baseName(model));

		if (present) {
			result.model_present = true;
			add('ok', 'Connected to ' + provider + '. Model "' + model + '" is available.');
		}
		else if (provider === 'ollama') {
			result.model_present = false;
			add('warn', 'Model "' + model + '" is not installed. Install it with "ollama pull ' + model + '", or pick one of the ' + models.length + ' installed model(s) in AI settings.');
		}
		else {
			// OpenAI-compatible list endpoints are not always exhaustive, so treat a miss as unverified.
			result.model_present = null;
			add('ok', 'Connected to ' + provider + '. (Whether "' + model + '" is offered can\'t be fully verified for this provider.)');
		}
	}
	else {
		add('warn', 'No model is configured. Choose one of the ' + models.length + ' available model(s) in AI settings.');
	}

	// Tool-calling caveat: only meaningful when AI Tools will be used and the model is usable.
	if (wantTools && result.model_present !== false) {

		result.tools_supported = (input.toolsSupported === undefined) ? null : input.toolsSupported;
		if (result.tools_supported === false) {
			add('warn', 'Model "' + model + '" does not support tool-calling, so AI Tools will fall back to plain answers. Choose a tools-capable model for full analysis.');
		}
	}

	// "ok" = reachable and the model is present (or presence can't be disproved for this provider).
	result.ok = result.reachable && result.model_present !== false;

	return result;
}


// Provider preflight: a single, best-effort readiness check so a user learns UP FRONT whether the AI
// backend on THEIR machine can actually serve requests — instead of a cryptic failure on the first
// question. This is the IO half: it composes the existing introspection (listModels +
// modelSupportsTools) rather than opening its own connections, then hands the gathered facts to the
// pure diagnosePreflight for the verdict. Read-only, never throws. It is on-demand only (config UI /
// API); it is never on the boot or trading path.
// opts: { provider, host, api_key, base_url, model, tools, force } — omit to check the active config.
async function preflight(opts) {

	opts = opts || {};

	const provider = opts.provider || aiProvider;
	const model = (opts.model != null && opts.model !== '') ? opts.model : modelCurrent;
	const wantTools = opts.tools === true;

	let models = [];
	try { models = await listModels({ provider: provider, host: opts.host, api_key: opts.api_key, base_url: opts.base_url, force: opts.force === true }) || []; }
	catch (e) { models = []; }

	// Fetch tool-calling capability only when it matters (AI Tools requested and the backend answered),
	// so the common case stays a single round-trip.
	let toolsSupported;
	if (wantTools && models.length) {
		try { toolsSupported = (await modelSupportsTools({ provider: provider, host: opts.host, api_key: opts.api_key, model: model, force: opts.force === true })).supported; }
		catch (e) { toolsSupported = null; }
	}

	return diagnosePreflight({ provider: provider, model: model, models: models, host: opts.host || '', wantTools: wantTools, toolsSupported: toolsSupported });
}


module.exports = {
	start,
	stop,
	preflight,
	diagnosePreflight,
	clampConversation,
	streamChat,
	completePrompt,
	getChatHistory,
	getModelName,
	listModels,
	modelSupportsTools,
	listConversations,
	saveConversation,
	loadConversation,
	deleteConversation,
	importHubLearningPack,

	abortGeneration,

	// Exported for testing: the predicate the corrective recover-gate uses to decide a tool result
	// carried no usable data.
	weakResult,

	// Exported for testing: the pure clock-time parser and the recent-errors intent detector (whose routing
	// must DEFER a time-scoped query like "errors around 5pm" to the time-window search), plus the band-span
	// and window-width parsers.
	parseClockToken,
	recentErrorsIntent,
	parseBandDays,
	parseWindowMinutes,
	parseRelativeDays,

	// Exported for testing: the follow-up TOPIC predicates that route a bare continuation ("tell me more")
	// to the deterministic deals-breakdown / errors render. They must survive a CHAIN of continuations — a
	// second follow-up has to resolve to the original topic question, not the first follow-up — or the weak
	// model is left to fabricate.
	recentTopicIsDealsPortfolio,
	recentTopicIsRecentErrors,

	// Exported for testing: the per-deal ranking-intent detector. A superlative follow-up ("which is the
	// worst?") carries no deal noun, so on a deals-topic turn it must be called with { assumeDeals: true } to
	// route to the deterministic ranking — otherwise the model mis-picks (names a least-bad deal as the worst).
	dealRankingIntent,

	// The deal-analysis data-provenance helpers. parseAnalysisProvenance + analysisProvenanceText are used by
	// DCABotManager to add the provenance line to the report footer; analysisDataProvenance +
	// looksLikeAnalysisDataSourceQuestion answer "did you use OHLCV?" deterministically from that same note, so
	// a weak model can't falsely deny using OHLCV. All four are also covered by tests.
	parseAnalysisProvenance,
	analysisProvenanceText,
	analysisDataProvenance,
	looksLikeAnalysisDataSourceQuestion,

	// Exported for testing: the FIRST-turn deals-status detector that routes "how are my deals doing" (in either
	// word order) to the deterministic summary instead of the model.
	looksLikeDealsStatusQuestion,

	// Exported for testing: the central answer funnel where entity/number grounding is enforced. A fabricated
	// ENUMERATION of pairs (several absent from the tool data) must fail closed, not ship under a caveat.
	finalizeAnswer,

	// Exported for testing: the learning-capture step. It records the turn's question→tool routing and, on a
	// streamed turn, emits the 'learning' socket id that drives the client's 👍/👎 rating. The deterministic
	// shortcuts (via emitRender) must reach this too, or the most common questions record nothing and show no
	// rating — the exact regression this guards.
	captureLearning,

	init: function(obj) {
		shareData = obj;
		aiTools.init(obj);

		// Self-policing: register an integrity check that flags DRIFT between the shipped learning
		// corpus and the live tool registry (orphaned references from a rename without an alias, or
		// tools with no corpus coverage) — so learning silently breaking on a tool change is caught at
		// boot and recorded to the audit log. Warn-only, like the other Watchdog checks. Wired from
		// here (the AI layer owns its corpus); the Watchdog registry stays generic.
		if (obj && obj.Watchdog && typeof obj.Watchdog.register === 'function') {
			obj.Watchdog.register('ai_learning_drift', function () { return aiTools.auditLearningDrift(); });
			obj.Watchdog.register('tool_schema_parity', function () { return aiTools.auditToolSchemaParity(); });
			obj.Watchdog.register('tool_guide_coverage', function () { return aiTools.auditToolGuideCoverage(); });
		}

		// Wire the self-improvement memory to its database-backed store. The store is the
		// durable source of truth (ai_learning collection); AIMemory keeps only a hot cache.
		// Config is read live so toggling learning applies without a restart.
		aiMemory.init({
			store: aiMemoryStore,
			getConfig: () => ((shareData.appData && shareData.appData.ai && shareData.appData.ai.learning) || {}),
			logger: (m) => { try { shareData.Common.logger(m); } catch (e) {} }
		});

		// Wire the get_expert_analysis tool to a stronger reasoning model (the configured
		// analysis model when set, else the current chat model). Single-shot, no tools.
		if (typeof aiTools.setExpert === 'function') aiTools.setExpert(async (question) => {

			const expertModel = resolveAnalysisModel();

			return await completePrompt([
				{ role: 'system', content: EXPERT_ANALYST_SYSTEM },
				{ role: 'user', content: question }
			], expertModel, { temperature: 0.2 });
		});

		// Wire the explore tool to a research sub-agent. By default it runs a single bounded tool-calling
		// loop over the read-only tools MINUS explore itself (so it cannot recurse). When "deep analysis"
		// is enabled it instead runs the STRUCTURED flow (plan → gather → gap-check → cited synthesis),
		// which degrades back to the single pass whenever the model can't sustain the structure. Both are
		// read-only, time-boxed, and can never change a trade.
		if (typeof aiTools.setSubAgent === 'function') aiTools.setSubAgent(async (task, opts) => {

			opts = opts || {};

			// Read-only tools minus `explore` → the sub-agent has no way to call itself.
			const shortlist = aiTools.TOOLS.map(t => t.name).filter(n => n !== 'explore');

			if (getToolsConfig().deep_explore) {

				const report = await runDeepAnalysis(task, shortlist, opts);
				if (report != null) { return report; }   // null ⇒ not a deep question / nothing gathered → single pass
			}

			return exploreOnce(task, shortlist, opts);
		});

		// Report this instance's AI-tool names to the Hub once, so a maintainer aggregating contributed
		// learning packs validates against the tools the fleet actually has (not only the Hub process's
		// own registry). Deferred one tick so the worker's parent_port is wired; a no-op on a standalone
		// instance (no parent_port) and best-effort either way — it can never affect trading or startup.
		setImmediate(relayToolsToHub);
	}
};


// One bounded tool-calling loop over `shortlist`, returning a grounded synthesis string. This is the
// original single-pass explore behavior, reused both directly and as the investigator for each
// deep-analysis sub-question. Time-boxed so a nested loop can never hang the chat. Single exit.
async function exploreOnce(task, shortlist, opts) {

	opts = opts || {};

	const messages = [
		{ role: 'system', content: EXPLORE_SUBAGENT_SYSTEM },
		{ role: 'user', content: String(task || '') }
	];

	const ac = new AbortController();
	const timer = setTimeout(() => { try { ac.abort(); } catch (e) {} }, EXPLORE_TIMEOUT_MS);

	try {
		const answer = await runToolLoop({
			room: opts.room || null,
			messages,
			model: modelCurrent,
			maxIterations: getToolsConfig().max_iterations,
			stream: false,
			shortlist,
			abortSignal: ac.signal,
			onActivity: opts.onActivity
		});
		return (typeof answer === 'string') ? answer : '';
	}
	finally { clearTimeout(timer); }
}

// Ask the model to break the task into sub-questions (structured output; fail-open to a single pass).
// The configured Deal Analysis Model (a stronger, tool-free reasoning model) when set, else the
// current chat model. Use this ONLY for tool-free reasoning tasks — one-off analysis, the expert-
// analysis tool, the deep-analysis final write-up. A tool-calling loop must keep using the chat
// model, which is the credential verified to support tools. Single exit.
function resolveAnalysisModel() {
	const genCfg = (shareData.appData && shareData.appData.ai && shareData.appData.ai.generation) || {};
	return (typeof genCfg.analysis_model === 'string' && genCfg.analysis_model.trim() !== '')
		? genCfg.analysis_model.trim()
		: modelCurrent;
}

async function deepPlanLLM(task) {
	const messages = [ { role: 'system', content: DEEP_PLAN_SYSTEM }, { role: 'user', content: String(task || '') } ];
	let raw = '';
	try { raw = await withTimeout(completePrompt(messages, modelCurrent, { temperature: 0.2, maxTokens: 400, schema: DEEP_PLAN_SCHEMA }), DEEP_PLAN_TIMEOUT_MS); }
	catch (e) { raw = ''; }
	return deepAnalysis.parsePlan(raw, task);
}

// Ask the supervisor whether anything important is still missing (structured output; fail-closed).
async function deepGapLLM(task, covered) {
	const summary = (covered || []).map((c, i) => '(' + (i + 1) + ') ' + c.subq).join('\n');
	const messages = [
		{ role: 'system', content: DEEP_GAP_SYSTEM },
		{ role: 'user', content: 'Original question: ' + String(task || '') + '\n\nSub-questions already investigated:\n' + summary + '\n\nWhat, if anything, is still missing?' }
	];
	let raw = '';
	try { raw = await withTimeout(completePrompt(messages, modelCurrent, { temperature: 0, maxTokens: 250, schema: DEEP_GAP_SCHEMA }), DEEP_GAP_TIMEOUT_MS); }
	catch (e) { raw = ''; }
	return deepAnalysis.parseGap(raw);
}

// Write the final cited report over the gathered evidence (visible-answer decoding + context guard).
// This step is pure reasoning with NO tools, so it runs on the configured Deal Analysis Model when
// set (the same stronger, tool-free model get_expert_analysis uses), else the chat model. The tool-
// driven investigation above stays on the chat model, which is the one that must support tool-calling.
async function deepSynthesizeLLM(task, evidence) {
	const messages = [
		{ role: 'system', content: DEEP_REPORT_SYSTEM },
		{ role: 'user', content: 'Question: ' + String(task || '') + '\n\nFindings (each block is one investigated sub-question and its grounded results):\n\n' + evidence }
	];
	let out = '';
	try { out = await completePrompt(clampConversation(messages, resolveConvoBudgetChars()), resolveAnalysisModel(), resolveGenOptions('analysis')); }
	catch (e) { out = ''; }
	if (typeof out !== 'string' || out.trim() === '') { return ''; }

	// Fabrication backstop for the synthesis step. The report is supposed to quote figures FROM the
	// findings only (the prompt says so), so any significant figure it introduces that is NOT in the
	// evidence is invented — and it would otherwise launder past finalizeAnswer, which verifies the final
	// chat answer against this report rather than against the underlying tool data. When the report
	// introduces ungrounded figures beyond a conservative share, discard it and return '' so the
	// orchestrator falls back to digest(covered): the grounded findings rendered verbatim. Render, don't
	// generate — an honest, less-polished digest beats a fluent report with invented numbers.
	try {
		const chk = analysisGuard.checkNumbers(out, evidence);
		if (chk && chk.numbersChecked >= 4 && chk.ungrounded.length >= Math.ceil(chk.numbersChecked * 0.34)) {
			if (shareData && shareData.Common && typeof shareData.Common.logger === 'function') {
				shareData.Common.logger('AI deep analysis: synthesis introduced ' + chk.ungrounded.length
					+ ' figure(s) not in the findings (' + chk.ungrounded.slice(0, 8).join(', ')
					+ ') — falling back to the grounded findings digest');
			}
			return '';
		}
	}
	catch (e) {}

	return out;
}

// Run the structured deep analysis for one explore task. Returns the report string, or null to mean
// "use the single pass" (planning found ≤1 angle, or nothing was gathered). Never throws.
function runDeepAnalysis(task, shortlist, opts) {
	opts = opts || {};
	return deepAnalysis.runDeepAnalysis(task, {
		plan:        (t) => deepPlanLLM(t),
		investigate: (subq) => exploreOnce(subq, shortlist, opts),
		gap:         (t, covered) => deepGapLLM(t, covered),
		synthesize:  (t, evidence) => deepSynthesizeLLM(t, evidence),
		onActivity:  opts.onActivity,
		onProgress:  opts.onProgress
	});
}