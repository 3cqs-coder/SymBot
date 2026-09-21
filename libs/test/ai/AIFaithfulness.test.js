'use strict';


// Unit tests for the faithfulness scorer. No model or network: the judge is stubbed.

const assert = require('assert');
const path = require('path');

const F = require(path.join(__dirname, '..', '..', 'ai', 'AIFaithfulness.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS' : 'FAIL') + ' — ' + m); };

(async () => {

	// segmentClaims
	const claims = F.segmentClaims('You have 8 open deals.\n* 2Z/USD used 16 safety orders\n* it');
	ok(claims.length === 2, 'segmentClaims splits lines and drops fragments under 15 chars');
	ok(claims[0].indexOf('*') === -1 && claims[0].indexOf('8 open deals') !== -1, 'segmentClaims strips markdown markers');

	// score thresholds
	ok(F._score([{ n: 1, verdict: 'supported' }, { n: 2, verdict: 'supported' }], 2).overall === 'high', 'all supported -> high');
	ok(F._score([{ n: 1, verdict: 'supported' }, { n: 2, verdict: 'unsupported' }], 2).overall === 'low', 'one of two unsupported (>25%) -> low');
	ok(F._score([{ n: 1, verdict: 'supported' }, { n: 2, verdict: 'supported' }, { n: 3, verdict: 'supported' }, { n: 4, verdict: 'unsupported' }], 4).overall === 'medium', 'one of four unsupported (25%) -> medium');
	// Omitted verdicts are NEUTRAL (excluded), not "partial": a judge that returns nothing does not
	// manufacture a caveat on an answer the deterministic grounding already passed.
	ok(F._score([], 3).overall === 'high', 'no judge verdicts -> high (omitted verdicts are neutral, not partial)');
	// But a genuinely partial-heavy JUDGED set still lands at medium.
	ok(F._score([ { n: 1, verdict: 'partial' }, { n: 2, verdict: 'partial' }, { n: 3, verdict: 'supported' } ], 3).overall === 'medium', 'a real partial-heavy judged set -> medium');

	// tolerant JSON
	ok(F._extractJson('```json\n{"verdicts":[]}\n```') !== null, 'extractJson strips code fences');
	ok(F._extractJson('no json here') === null, 'extractJson returns null on garbage');

	// The judge system prompt is externalized to a data file (faithfulness-judge.txt), read via the shared
	// loader. Assert it actually loaded into the built prompt — guards against the file being renamed or
	// deleted, which would otherwise ship an empty system prompt with no test catching it.
	const built = F._buildPrompt('SOURCES: {"open_deals":8}', [ 'You have 8 open deals.' ]);
	ok(built[0].role === 'system' && /fact-checker/i.test(built[0].content), 'buildPrompt loads the externalized judge system prompt');
	ok(built[1].role === 'user' && /STATEMENTS:/.test(built[1].content), 'buildPrompt lays out the sources and numbered statements');

	// scoreAnswer end to end with a stubbed judge
	const goodJudge = async () => JSON.stringify({ verdicts: [{ n: 1, verdict: 'supported' }, { n: 2, verdict: 'supported' }] });
	const r1 = await F.scoreAnswer({ answer: 'You have 8 open deals.\n2Z/USD used 16 safety orders.', sources: '{"open_deals":8}', judge: goodJudge });
	ok(r1 && r1.overall === 'high', 'scoreAnswer returns high when the judge supports every claim');

	const badJudge = async () => 'the model refused and returned prose';
	const r2 = await F.scoreAnswer({ answer: 'You have 8 open deals here now.', sources: '{"open_deals":8}', judge: badJudge });
	ok(r2 === null, 'scoreAnswer returns null (fail-safe) when the judge output is unparseable');

	const r3 = await F.scoreAnswer({ answer: 'anything', sources: '', judge: goodJudge });
	ok(r3 === null, 'scoreAnswer returns null when there are no sources');

	console.log('\n' + pass + ' passed, ' + fail + ' failed');
	process.exit(fail === 0 ? 0 : 1);
})();
