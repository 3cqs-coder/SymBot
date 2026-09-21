'use strict';

// Regression tests for two answer-quality fixes found in the deeper-flows audit:
//   1. resolveAnaphora must NOT treat a superlative/fresh query ("the worst one", "the best bot") as a
//      back-reference — doing so injected a stale prior-turn entity and steered the answer to the wrong
//      deal/bot. Genuine pronoun references ("that deal", "it") must still resolve.
//   2. AIFaithfulness._score must score ONLY the claims the judge actually returned verdicts for; a
//      truncated judge output must not stamp a "partly confirmed" caveat on a fully-supported answer.

const assert = require('assert');
const G = require('../../ai/AIGuardrails.js');
const F = require('../../ai/AIFaithfulness.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

const recent = { dealIds: [ 'BTCUSD-ABC123-1700000000' ], pairs: [ 'BTC/USD' ] };

// ── Superlative / fresh-ranking queries must NOT resolve to a prior entity ──
for (const q of [
	'and the worst one?',
	'which is the worst deal?',
	'show me the best performing bot',
	'what is my most profitable pair?',
	'the oldest open deal',
	'which pair has the highest win rate'
]) {
	ok(G.resolveAnaphora(q, recent) === '', 'superlative query is NOT anaphora: ' + q);
}

// ── Genuine back-references still resolve to the most recent entity ──
ok(/BTC/.test(G.resolveAnaphora('why is it underwater?', recent)), '"why is it underwater?" resolves to the recent deal/pair');
ok(/BTC/.test(G.resolveAnaphora('tell me more about that deal', recent)), '"that deal" resolves');
ok(/BTC/.test(G.resolveAnaphora('what about this one?', recent)), '"this one" resolves');

// A query that names a concrete entity, or references nothing, resolves to '' (nothing to inject).
ok(G.resolveAnaphora('how is ETH/USD doing?', recent) === '', 'a query naming another pair is not anaphora');
ok(G.resolveAnaphora('how many open deals do I have?', recent) === '', 'a plain fresh query is not anaphora');

// ── Faithfulness scoring: omitted judge verdicts are NEUTRAL, not "partial" ──
// 16 claims sent, judge returned only 10 — all supported. Old code defaulted the 6 gaps to "partial"
// and produced overall:'medium' (a false caveat). Now the denominator is the 10 JUDGED, → 'high'.
const partialJudge = [];
for (let i = 1; i <= 10; i++) { partialJudge.push({ n: i, verdict: 'supported' }); }
const s1 = F._score(partialJudge, 16);
ok(s1.overall === 'high', 'a fully-supported but truncated judge output scores high, not a false "medium"');
ok(s1.counts.total === 10, 'denominator is the number of claims actually judged (10), not sent (16)');

// A genuinely unsupported claim still drags the score down.
const badJudge = [ { n: 1, verdict: 'supported' }, { n: 2, verdict: 'unsupported' } ];
ok(F._score(badJudge, 2).overall !== 'high', 'a real unsupported claim is still caught');

console.log('AnaphoraFaithfulness: ' + passed + ' assertions passed');
