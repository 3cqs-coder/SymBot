'use strict';

// Pins the deal-id extraction regex behind the AI log/error-tool scope redirect: a question naming EXACTLY
// one deal id reroutes a fleet-wide log tool to that deal's own events; naming none or several must NOT
// redirect (returns null). Pure and offline — guards against a future regex tweak silently changing which
// deal strings are recognized or how ambiguity is handled.

const assert = require('assert');
const AITools = require('../../ai/AITools.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

const f = AITools.extractQuestionDealId;

const ID1 = 'ROBO_USD-4C2458-1790854771';
const ID2 = 'KAIO_USD-2AJNBCI-1790953252';
const ID3 = 'VELO_USD-4E4515P-1790830516';   // safety segment contains a letter

// one id in prose → that id
ok(f('why did ' + ID1 + ' close at a loss?') === ID1, 'a single id in prose is extracted');
ok(f(ID3) === ID3, 'a bare id (letters in the middle segment) is extracted');

// the SAME id repeated → still unambiguous (deduped) → that id
ok(f('errors on ' + ID1 + ' then ' + ID1 + ' again') === ID1, 'the same id repeated is still one id');

// two DIFFERENT ids → ambiguous → null (do not guess which deal to scope to)
ok(f(ID1 + ' vs ' + ID2) === null, 'two distinct ids → null (ambiguous, no redirect)');

// no id → null (a fleet-wide question stays fleet-wide)
ok(f('show me the latest errors across all pairs') === null, 'no id → null');

// a lowercase / malformed near-id must NOT match (ids are upper-case) → null
ok(f('why did robo_usd-4c2458-1790854771 lose?') === null, 'a lowercase near-id does not match → null');
ok(f('deal ROBO_USD-4C2458 with no numeric tail') === null, 'a truncated id (no 6+ digit tail) does not match → null');

// non-string / empty input → null, never throws
ok(f(null) === null, 'null → null');
ok(f(undefined) === null, 'undefined → null');
ok(f(123) === null, 'a non-string → null');
ok(f('') === null, 'empty string → null');

console.log('ExtractQuestionDealId: ' + passed + ' assertions passed');
process.exit(0);
