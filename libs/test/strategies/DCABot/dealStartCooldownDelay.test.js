'use strict';

// Pins the per-pair cooldown behavior after the deal-start cooldown wait was moved OUT of the serial queue
// (resolveStartDelayMs in DCABot.js). Previously the queued task awaited its full dealCoolDown inside the
// serialized critical section, so one pair's multi-minute cooldown head-of-line-blocked new-deal starts for
// EVERY other pair and bot. The wait now elapses on a timer before the gate-and-start work is enqueued, and
// resolveStartDelayMs computes how long to wait. The safety-critical invariant this locks: moving the wait out
// must NOT let a same-pair start bypass the cooldown, and must NOT make other pairs wait. Pure and now-injectable.

const assert = require('assert');
const path = require('path');
const DCABot = require(path.resolve(__dirname, '..', '..', '..', '..') + '/libs/strategies/DCABot/DCABot.js');

let passed = 0;
function eq(a, b, m) { assert.strictEqual(a, b, m + ' (got ' + JSON.stringify(a) + ')'); passed++; }

const T0 = 1000000;   // fixed base time (ms)

// 1) A 'deal complete' cooldown waits its own full duration and records the pair's deadline.
eq(DCABot.resolveStartDelayMs({ botId: 'bot1', pair: 'BTC/USD', delaySec: 300, source: 'deal complete', now: T0 }), 300000,
	"the 'deal complete' cooldown waits its full 300s");

// 2) A DIFFERENT pair/bot is NOT blocked by pair BTC/USD's cooldown — the whole point of the fix (liveness).
eq(DCABot.resolveStartDelayMs({ botId: 'bot2', pair: 'ETH/USD', delaySec: 0, source: 'api/signal', now: T0 + 100000 }), 0,
	'a different pair/bot has zero wait while another pair is mid-cooldown (no head-of-line blocking)');
eq(DCABot.resolveStartDelayMs({ botId: 'bot1', pair: 'ETH/USD', delaySec: 0, source: 'api/signal', now: T0 + 100000 }), 0,
	'a different PAIR on the SAME bot is also not blocked');

// 3) A SAME bot+pair start arriving mid-cooldown must wait out the REMAINING cooldown (no bypass) — the
//    behavior that used to come from being queued behind the cooldown task.
eq(DCABot.resolveStartDelayMs({ botId: 'bot1', pair: 'BTC/USD', delaySec: 0, source: 'api/signal', now: T0 + 100000 }), 200000,
	'a same-pair signal 100s into a 300s cooldown still waits the remaining 200s (cooldown not bypassed)');

// 4) After the cooldown elapses, the same pair has no wait.
eq(DCABot.resolveStartDelayMs({ botId: 'bot1', pair: 'BTC/USD', delaySec: 0, source: 'api/signal', now: T0 + 300001 }), 0,
	'once the cooldown has elapsed, the same pair is free to start immediately');

// 5) A same-pair start takes the LARGER of its own stagger and the remaining cooldown.
DCABot.resolveStartDelayMs({ botId: 'bot3', pair: 'SOL/USD', delaySec: 100, source: 'deal complete', now: T0 });   // 100s cooldown
eq(DCABot.resolveStartDelayMs({ botId: 'bot3', pair: 'SOL/USD', delaySec: 5, source: 'asap', now: T0 + 90000 }), 10000,
	'own 5s stagger vs 10s cooldown remaining → waits the larger (10s)');
eq(DCABot.resolveStartDelayMs({ botId: 'bot3', pair: 'SOL/USD', delaySec: 30, source: 'asap', now: T0 + 99000 }), 30000,
	'own 30s stagger vs 1s cooldown remaining → waits the larger (30s stagger)');

// 6) Only 'deal complete' sets a pair cooldown — a staggered ASAP start must NOT create one that then blocks
//    a concurrent same-pair start.
DCABot.resolveStartDelayMs({ botId: 'bot4', pair: 'ADA/USD', delaySec: 5, source: 'asap', now: T0 });
eq(DCABot.resolveStartDelayMs({ botId: 'bot4', pair: 'ADA/USD', delaySec: 0, source: 'api/signal', now: T0 + 1000 }), 0,
	'a staggering delay does not create a pair cooldown, so a concurrent same-pair start is not blocked');

// 7) A zero-delay non-cooldown start is immediate.
eq(DCABot.resolveStartDelayMs({ botId: 'bot5', pair: 'XRP/USD', delaySec: 0, source: 'api/signal', now: T0 }), 0,
	'a plain start with no delay and no active cooldown is immediate');

// 8) Missing botId/pair is handled safely (no key, no throw) → just the own delay.
eq(DCABot.resolveStartDelayMs({ delaySec: 0, source: 'api/signal', now: T0 }), 0, 'missing bot/pair with no delay → 0');
eq(DCABot.resolveStartDelayMs({ botId: 'bot6', delaySec: 2, source: 'asap', now: T0 }), 2000, 'missing pair falls back to the own delay');

// 9) pairCooldownRemainingMs is a read-only view of the active cooldown — what lets the API path report an
//    honest "deferred for cooldown" instead of a false success.
DCABot.resolveStartDelayMs({ botId: 'bot9', pair: 'DOT/USD', delaySec: 120, source: 'deal complete', now: T0 });   // 120s cooldown
eq(DCABot.pairCooldownRemainingMs('bot9', 'DOT/USD', T0 + 30000), 90000, 'pairCooldownRemainingMs returns the remaining cooldown (90s of 120s)');
eq(DCABot.pairCooldownRemainingMs('bot9', 'DOT/USD', T0 + 200000), 0, 'pairCooldownRemainingMs is 0 once the cooldown has elapsed');
eq(DCABot.pairCooldownRemainingMs('nobot', 'NONE/USD', T0), 0, 'no cooldown for an unknown bot+pair → 0');
eq(DCABot.pairCooldownRemainingMs(null, null, T0), 0, 'null bot/pair returns 0 (no throw)');

console.log('dealStartCooldownDelay: ' + passed + ' assertions passed');
process.exit(0);
