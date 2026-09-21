'use strict';

// Tests weakResult — the predicate the corrective recover-gate uses to decide a tool result carried no
// usable data (so the gate rephrases the question and retries once instead of answering "no data").
// A result is WEAK when it errored, is unavailable, has an explicit count of 0, or its only payload
// arrays are all empty. A result with real rows, a scalar, or a non-zero count is NOT weak.

const assert = require('assert');
const AIClient = require('../../ai/AIClient.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

const weak = AIClient.weakResult;

// ── Weak (would trigger a corrective retry) ──
ok(weak({ error: 'Deal data temporarily unavailable' }) === true, 'an error result is weak');
ok(weak({ available: false, note: 'no wallet data' }) === true, 'available:false is weak');
ok(weak({ count: 0, deals: [] }) === true, 'count:0 is weak');
ok(weak({ completed_deals: 0, total_profit: 0, win_rate_percent: 0 }) === true, 'completed_deals:0 (a scalar-only summary) is weak');
ok(weak({ pairs: [], best_pair: null }) === true, 'a result whose only array is empty is weak');
ok(weak({ open_deals: [], count: 0 }) === true, 'empty list + count 0 is weak');

// ── Strong (no corrective needed) ──
ok(weak({ count: 16, open_deals: [ {}, {} ] }) === false, 'a non-zero count is strong');
ok(weak({ pairs: [ { pair: 'OSMO/USD' } ], best_pair: 'OSMO/USD' }) === false, 'a non-empty array is strong');
ok(weak({ total_profit: 47545.86 }) === false, 'a scalar figure is strong (no arrays, no zero count)');
ok(weak({ best_bot: 'SymSync 100', bots: [ {} ] }) === false, 'a populated result is strong');
// A summary object with an incidental empty list but a real count is strong (mirrors the trace fix).
ok(weak({ count: 3, near_stop_loss: [] }) === false, 'count>0 wins over an incidental empty array');

// ── Non-object / edge ──
ok(weak(null) === false, 'null is not weak (nothing to retry on)');
ok(weak('some text answer') === false, 'a string answer is not weak');
ok(weak({}) === false, 'an empty object with no count and no arrays is not weak');

console.log('CorrectiveGate: ' + passed + ' assertions passed');

// Requiring AIClient pulls in the provider SDKs, which leave open handles; exit explicitly so this
// unit test terminates instead of hanging the runner.
process.exit(0);
