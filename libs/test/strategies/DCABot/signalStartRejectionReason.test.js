'use strict';

// Pins the fix for the "rejected entry signal reported as success:true" bug on the signal→trade seam.
// A deal start is gated authoritatively on the serial queue (blacklist, pairMax, global pair limit, deal
// already active, circuit breaker, inactive bot, ...) AFTER requestDealStart has already returned to the
// caller, so apiStartDeal used to poll the start tracker, see it cleared with no deal, and default to
// success:true — reporting a false success to the webhook/API response, the 3CQS notification, the Signal
// Activity log, and the Hub cross-instance action. The fix propagates the already-computed reason:
//   • startDelay returns the full { success, data, startId }.
//   • a queued rejection records its reason (keyed by startId) before clearing the tracker.
//   • apiStartDeal reports success:false + reason on a synchronous rejection OR when the tracker clears with
//     no deal AND a rejection reason was recorded — never mislabeling a slow/edge success as a failure.
// Both directions are asserted (money-path-adjacent change). No order internals are touched.

const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..', '..', '..', '..');

const DCABot = require(root + '/libs/strategies/DCABot/DCABot.js');
const DCABotManager = require(root + '/libs/strategies/DCABot/DCABotManager.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function eq(a, b, m) { assert.strictEqual(a, b, m + ' (got ' + JSON.stringify(a) + ')'); passed++; }

// ── The reason store (recordStartDealResult / takeStartDealResult) ──────────────────
DCABot.recordStartDealResult('start-1', 'Pair is on the blacklist');
const r1 = DCABot.takeStartDealResult('start-1');
ok(r1 && r1.reason === 'Pair is on the blacklist', 'a recorded reason is read back by startId');
eq(DCABot.takeStartDealResult('start-1'), null, 'reading is read-and-clear (a second read returns null)');
eq(DCABot.takeStartDealResult('never-recorded'), null, 'an unknown startId returns null (absence is not a rejection)');
DCABot.recordStartDealResult(null, 'x');
eq(DCABot.takeStartDealResult(null), null, 'a null startId is handled safely (no throw, no entry)');
DCABot.recordStartDealResult('start-2', '');
const r2 = DCABot.takeStartDealResult('start-2');
ok(r2 && r2.reason === 'Deal not started', 'an empty reason falls back to a generic non-empty message');

// ── apiStartDeal: drive the real handler with a stubbed shareData ───────────────────
// Build a stub whose DCABot.startDelay / getStartDealTracker / getDealTracker / takeStartDealResult return
// exactly the scenario under test. resolveConfiguredPair + applyConfigData just pass a valid pair/config
// through so the handler reaches the start path.
function runCase(scenario) {

	DCABotManager.init({
		DCABot: {
			getBots: async () => [ { active: true, botName: 'B', config: { pair: [ 'BTC/USD' ] } } ],
			applyConfigData: async (o) => o.config,
			startDelay: async () => scenario.startDelay,
			getStartDealTracker: async () => { if (scenario.onGetTracker) { scenario.onGetTracker(); } return scenario.tracker; },   // null ⇒ "cleared"
			getDealTracker: async () => scenario.dealTracker || {},
			takeStartDealResult: () => scenario.recordedReason || null
		},
		SignalBot: { resolveConfiguredPair: (p) => p },
		Common: { logger: () => {}, delay: async () => {} }
	});

	const req = { params: { botId: 'bot1' }, body: { pair: 'BTC/USD', signalId: 'sig-1' } };
	return DCABotManager.apiStartDeal(req, null, false);   // sendResponse=false → returns the resObj
}

(async () => {

	// 1) Synchronous rejection (the pairMax fast pre-check / queue-not-ready) → failure + reason, no false success.
	let res = await runCase({ startDelay: { success: false, data: 'pairMax pre-check: too many pending starts', startId: null } });
	eq(res.success, false, 'synchronous rejection reports success:false');
	eq(res.data, 'pairMax pre-check: too many pending starts', 'synchronous rejection surfaces the reason');

	// 2) Async rejection: queue accepted, tracker clears with NO deal, a reason was recorded → failure + reason.
	res = await runCase({
		startDelay: { success: true, data: null, startId: 's-async' },
		tracker: null,
		dealTracker: {},
		recordedReason: { reason: 'Pair blacklisted' }
	});
	eq(res.success, false, 'async rejection (tracker cleared, no deal, reason recorded) reports success:false');
	eq(res.data, 'Pair blacklisted', 'async rejection surfaces the recorded reason');

	// 3) Success: tracker clears and the deal is found in the deal tracker → success + deal_id (unchanged).
	res = await runCase({
		startDelay: { success: true, data: null, startId: 's-ok' },
		tracker: null,
		dealTracker: { 'D42': { meta: { start_id: 's-ok' } } }
	});
	eq(res.success, true, 'a successful start still reports success:true');
	ok(res.data && res.data.deal_id === 'D42', 'a successful start still returns the deal_id');

	// 4) Edge: tracker clears, no deal found, and NO reason recorded → NOT mislabeled a failure (stays success).
	res = await runCase({
		startDelay: { success: true, data: null, startId: 's-edge' },
		tracker: null,
		dealTracker: {},
		recordedReason: null
	});
	eq(res.success, true, 'no recorded reason is NOT treated as a failure (a slow/edge success is never mislabeled)');

	// 5) Cooldown-deferred: the pair is in a cooldown that outlasts the poll window (cooldownMs > 30s). The start
	//    is accepted but deferred, so it must be reported honestly as a failure with a cooldown reason — NOT a
	//    false success — and WITHOUT polling (the deal cannot commit within the response window).
	let polled = false;
	res = await runCase({
		startDelay: { success: true, data: null, startId: 's-cool', cooldownMs: 300000 },
		tracker: null,
		dealTracker: {},
		recordedReason: null,
		onGetTracker: () => { polled = true; }
	});
	eq(res.success, false, 'a start deferred by a cooldown beyond the poll window reports success:false (not a false success)');
	ok(typeof res.data === 'string' && /cooldown/i.test(res.data), 'the deferral reason mentions the cooldown');
	eq(polled, false, 'the cooldown-deferred branch does not poll (no needless wait for a start that cannot commit in time)');

	// 6) A SHORT cooldown (within the poll window) still polls and correlates a real deal → success + deal_id.
	res = await runCase({
		startDelay: { success: true, data: null, startId: 's-short', cooldownMs: 5000 },
		tracker: null,
		dealTracker: { 'D7': { meta: { start_id: 's-short' } } }
	});
	eq(res.success, true, 'a short cooldown (within the poll window) still polls and reports the real success');
	ok(res.data && res.data.deal_id === 'D7', 'the short-cooldown success returns the deal_id');

	console.log('signalStartRejectionReason: ' + passed + ' assertions passed');
	process.exit(0);
})().catch((e) => { console.error('signalStartRejectionReason test error:', e && e.stack || e); process.exit(1); });
