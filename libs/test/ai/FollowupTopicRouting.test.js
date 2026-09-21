'use strict';

// Regression gate for the follow-up TOPIC predicates that keep a bare continuation ("tell me more")
// on the deterministic render path instead of letting the weak model fabricate.
//
// The bug this guards against: a SECOND follow-up ("tell me more" AFTER "tell me in greater detail")
// tested the immediately-previous user turn — which was itself a continuation — so it matched no topic,
// the deterministic deals-breakdown shortcut never fired, and the 8B model invented a list of open deals
// (fabricated trading PAIRS the user does not hold). The predicates must walk back PAST chained
// continuations to the substantive question that set the topic, and must also recognize our own
// deterministic render as the topic when the question chain isn't available.

const assert = require('assert');
const AIClient = require('../../ai/AIClient.js');

const isDeals = AIClient.recentTopicIsDealsPortfolio;
const isErrors = AIClient.recentTopicIsRecentErrors;

let passed = 0;
function ok(cond, label) { assert.ok(cond, label); passed++; }

const U = (content) => ({ role: 'user', content });
const A = (content) => ({ role: 'assistant', content });
const room = (messages) => ({ messages });

// ── Deals portfolio topic ─────────────────────────────────────────────────
// A FIRST follow-up after a deals summary stays on topic.
ok(isDeals(room([
	U('Tell me how my deals are doing'),
	A('You have 9 open deals — 0 in profit, 9 underwater. Total unrealized P/L: -919.2.'),
	U('tell me in greater detail')
])), 'first follow-up after a deals summary is recognized as the deals-portfolio topic');

// THE REGRESSION: a SECOND, chained follow-up after the breakdown must STILL resolve to the original
// "how are my deals" question — not stop at the intermediate "tell me in greater detail" continuation.
ok(isDeals(room([
	U('Tell me how my deals are doing'),
	A('You have 9 open deals — 0 in profit, 9 underwater. Total unrealized P/L: -919.2.'),
	U('tell me in greater detail'),
	A('Here is each of your open deals (9 total, 0 in profit, 9 underwater):\n\n1. ATOM/USD — underwater, unrealized P/L -0.69 (-0.87%), 1 safety orders used'),
	U('tell me more')
])), 'a chained second follow-up still resolves to the deals-portfolio topic (the fabrication regression)');

// Fallback: with no prior user question available, our own deterministic BREAKDOWN render is itself
// recognized as the deals topic so the next follow-up re-renders rather than falling to the model.
ok(isDeals(room([
	A('Here is each of your open deals (9 total, 0 in profit, 9 underwater):\n\n1. ATOM/USD — underwater, 1 safety orders used'),
	U('tell me more')
])), 'the deterministic breakdown render is recognized as the deals topic via the assistant-reply fallback');

// No false positive: a follow-up after an UNRELATED substantive question must NOT be treated as deals.
ok(!isDeals(room([
	U('What is dollar cost averaging?'),
	A('Dollar-cost averaging is a strategy where you buy a fixed amount at regular intervals to smooth out price.'),
	U('tell me more')
])), 'a follow-up after an unrelated concept question is NOT routed to the deals breakdown');

// A single substantive deals question with no continuation still reads as the topic (baseline).
ok(isDeals(room([
	U('how are my open positions doing'),
	A('You have 9 open deals — 0 in profit, 9 underwater.'),
	U('list them in detail')
])), 'baseline: a deals question followed by one continuation is on-topic');

// ── Recent-errors topic (same chained-continuation robustness) ─────────────
ok(isErrors(room([
	U('What errors happened the last 3 days?'),
	A('22 errors logged over the 3 days searched (2026-08-22 to 2026-08-24), all on 2026-08-22.'),
	U('tell me in greater detail'),
	A('Here is each error type with real log lines: ...'),
	U('tell me more')
])), 'a chained second follow-up after an errors survey still resolves to the errors topic');

ok(!isErrors(room([
	U('What is a safety order?'),
	A('A safety order averages down an open deal when price falls a configured step.'),
	U('tell me more')
])), 'a follow-up after an unrelated concept question is NOT routed to the errors render');

// ── First-turn deals-status detection (routes to the deterministic summary, not the model) ─────────
// Both word orders must match: "how ARE my deals doing" and "how my deals ARE doing". A live test found the
// second form fell through to the model, which answered a simple status question in prose under a caveat.
const isStatus = AIClient.looksLikeDealsStatusQuestion;
ok(isStatus('Tell me how my deals are doing'), '"how my deals ARE doing" (trailing verb) routes to the deterministic summary');
ok(isStatus('how are my deals doing'), '"how ARE my deals doing" (leading verb) routes to the deterministic summary');
ok(isStatus('how my positions are looking'), '"how my positions are looking" is a status question');
ok(!isStatus('how do my deals work'), 'a how-to ("how do my deals work") is NOT a status question');
ok(!isStatus('which deal is losing the most'), 'a ranking question is NOT a status question');
ok(!isStatus('what is a safety order'), 'a definitional question is NOT a status question');
// PRODUCTION REGRESSION: the contracted "how's" and the apostrophe-less "hows" (a very common typed form)
// fell through to the fabricating model because the matcher required a space right after "how". They are
// ordinary status questions and must route to the deterministic summary.
for (const q of ['hows my deals', "how's my deals", 'hows my deals doing', 'hows my portfolio', "how's my positions"]) {
	ok(isStatus(q), '"' + q + '" (contracted how) routes to the deterministic summary');
}
ok(!isStatus('howdy my deals'), '"howdy" is not "how" + a status question');

// ── Continuation-phrase recognition (the gate BEFORE the topic walk-back) ──────────────────────────
// PRODUCTION REGRESSION: "tell me more about them" — a first follow-up after the open-deals summary — was
// NOT recognized as a continuation ("tell me more" needed the phrase to END there, and "tell me about
// (it|that|this)" omitted the plural pronoun "them" for multiple deals), so the deterministic breakdown
// never fired and the 8B model FABRICATED a per-deal list ([unavailable] ids under a caveat). The phrase
// and its natural variants must register as continuations; a genuine new question must not.
const isCont = require('../../ai/AIGuardrails.js').looksLikeContinuation;
for (const q of ['tell me more about them', 'tell me about them', 'tell me more about those',
	'tell me about these', 'tell me more about each', 'tell me more about the deals']) {
	ok(isCont(q), '"' + q + '" is recognized as a continuation');
}
ok(isCont('tell me more'), '"tell me more" (bare) still recognized');
ok(isCont('list them in detail'), '"list them in detail" still recognized');
ok(!isCont('tell me about the weather'), 'a genuine new question ("tell me about the weather") is NOT a continuation');
ok(!isCont('tell me about bitcoin'), 'a genuine new question ("tell me about bitcoin") is NOT a continuation');

// ── Superlative follow-up ranking (the "which is the worst?" fabrication) ──────────────────────────
// PRODUCTION REGRESSION: after "how's my deals going today?" → summary → "tell me more details" → breakdown,
// asking "which is the worst?" fell to the model, which named a LEAST-bad deal as the worst (and pasted the
// wrong P/L onto it). A bare superlative carries no deal noun, so dealRankingIntent rejected it as "not about
// deals" and never routed to the deterministic ranking. On a deals-topic turn it must be recognized WITH the
// assumeDeals context, mapping "worst" → the 'loss' ranking (which renders the tool's authoritative
// biggest_loss over ALL deals), while a bare superlative with NO context still stays out of the ranking.
const rank = AIClient.dealRankingIntent;

// The exact production conversation still resolves to the deals-portfolio topic on the "worst" turn.
ok(isDeals(room([
	U("how's my deals going today?"),
	A('You have 9 open deals — 0 in profit, 9 underwater. Total unrealized P/L: -784.23.'),
	U('tell me more details'),
	A('Here is each of your open deals (9 total, 0 in profit, 9 underwater):\n\n1. ALEO/USD — underwater, unrealized P/L -0.1 (-0.36%)'),
	U('which is the worst?')
])), 'the "which is the worst?" turn resolves to the deals-portfolio topic');

// PRODUCTION REGRESSION #2: a superlative AFTER another superlative ("which is the worst?" → "which is the
// best?") lost the deals context — the topic walk-back stopped at the previous superlative (not a deals
// question) and the assistant-render fallback didn't recognize the RANKING render (it has no deal count), so
// "which is the best?" fell to the model and deflected ("I'm not sure what you're referring to"). The
// fallback must recognize the ranking render as a deals-portfolio answer so the chain keeps re-ranking.
ok(isDeals(room([
	U("How's my deals today?"),
	A('You have 9 open deals — 1 in profit, 8 underwater. Total unrealized P/L: -748.53.'),
	U('Tell me more'),
	A('Here is each of your open deals (9 total, 1 in profit, 8 underwater):\n\n1. TIA/USD — in profit, unrealized P/L 0.09 (0.34%)'),
	U('Which is the worst?'),
	A('Your worst-performing (biggest loss) open deal is AUCTION/USD, unrealized P/L -673.54 (-10.84%), 12.84% from take-profit, 36 safety orders used.'),
	U('which is the best?')
])), 'a superlative after another superlative (the ranking render) still resolves to the deals topic');

// The single-pick ranking render (and the top-N list render) is recognized as a deals-portfolio answer.
ok(isDeals(room([ U('which is the worst?'), A('Your worst-performing (biggest loss) open deal is AUCTION/USD, unrealized P/L -673.54.'), U('and the best?') ])), 'the single-pick ranking render is recognized as the deals topic');
ok(isDeals(room([ U('top 3 losers'), A('Your least profitable (biggest loss) open deals (top 3 of 9), ranked by live unrealized P/L:\n\n1. AUCTION/USD'), U('and the winners?') ])), 'the top-N ranking-list render is recognized as the deals topic');

// With the deals context, the superlatives route to the correct deterministic ranking kind.
ok(rank('which is the worst?', { assumeDeals: true }) && rank('which is the worst?', { assumeDeals: true }).kind === 'loss', '"which is the worst?" (deals context) → loss ranking');
ok(rank('and the best one?', { assumeDeals: true }) && rank('and the best one?', { assumeDeals: true }).kind === 'gain', '"and the best one?" (deals context) → gain ranking');
ok(rank('which is closest to profit?', { assumeDeals: true }) && rank('which is closest to profit?', { assumeDeals: true }).kind === 'closest', '"closest to profit?" (deals context) → closest ranking');

// Without the deals context, a bare superlative is NOT hijacked into a per-deal ranking (avoids false positives).
ok(rank('which is the worst?') === null, '"which is the worst?" with NO context is not a deal ranking');
// Even WITH the deals context, a superlative about a NON-deal noun stays out of the per-deal ranking.
ok(rank('which is the worst exchange?', { assumeDeals: true }) === null, '"which is the worst exchange?" is never a per-deal ranking, even in deals context');
// A superlative that already names deals keeps working with or without the flag.
ok(rank('which deal is losing the most?') && rank('which deal is losing the most?').kind === 'loss', '"which deal is losing the most?" → loss ranking (unchanged)');

console.log('FollowupTopicRouting: ' + passed + ' assertions passed');