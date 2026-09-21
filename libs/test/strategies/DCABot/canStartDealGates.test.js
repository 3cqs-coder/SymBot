'use strict';

// Pins the PAIR-LIMIT gates in canStartDeal (DCABot.js) — the checks that stop a bot from over-opening a pair,
// which is real capital. CircuitBreakerGate.test.js covers the breaker branch; this covers the rest of "gate
// every start": pairMax (bot's max distinct pairs), pairDealsMax > 1 (multiple deals per pair up to a limit),
// and the default pairDealsMax <= 1 "already has an active deal" branch — plus the "no limit" cases. A silent
// regression here would let a bot open more deals on a pair than configured. Deterministic: pairBlackListed is
// stubbed false and pairBotsDealsMax is 0 so checkGlobalPairLimit never touches the DB (same technique the
// breaker test uses). process.exit(0) at the end because requiring DCABot may register timers.

const assert = require('assert');
const Common = require('../../../app/Common.js');
const DCABot = require('../../../strategies/DCABot/DCABot.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

const appData = {};
DCABot.init({ appData: appData });
const origBlacklist = Common.pairBlackListed;

(async () => {

	appData.circuit_breaker_active = null;
	Common.pairBlackListed = async () => false;   // never blacklisted

	const PAIR = 'BTC/USDT';

	// ── pairMax: the bot's cap on distinct pairs ──
	let r = await DCABot.canStartDeal({ pair: PAIR, config: { pairMax: 3, pairBotsDealsMax: 0 }, pairCount: 3, dealsActive: [] });
	ok(r.allowed === false && /max 3 pairs/.test(r.reason), 'pairMax reached (pairCount == pairMax) blocks');

	r = await DCABot.canStartDeal({ pair: PAIR, config: { pairMax: 3, pairBotsDealsMax: 0 }, pairCount: 4, dealsActive: [] });
	ok(r.allowed === false, 'pairMax exceeded (pairCount > pairMax) blocks');

	r = await DCABot.canStartDeal({ pair: PAIR, config: { pairMax: 3, pairBotsDealsMax: 0 }, pairCount: 2, dealsActive: [] });
	ok(r.allowed === true, 'one below pairMax allows');

	r = await DCABot.canStartDeal({ pair: PAIR, config: { pairMax: 0, pairBotsDealsMax: 0 }, pairCount: 99, dealsActive: [] });
	ok(r.allowed === true, 'pairMax 0 = no limit (never blocks on pair count)');

	// ── pairDealsMax > 1: multiple concurrent deals per pair, capped ──
	r = await DCABot.canStartDeal({ pair: PAIR, config: { pairDealsMax: 3, pairBotsDealsMax: 0 }, dealsActive: [ {}, {}, {} ] });
	ok(r.allowed === false && /max 3 deals/.test(r.reason), 'pairDealsMax reached blocks');

	r = await DCABot.canStartDeal({ pair: PAIR, config: { pairDealsMax: 3, pairBotsDealsMax: 0 }, dealsActive: [ {}, {} ] });
	ok(r.allowed === true, 'one below pairDealsMax allows');

	// ── default pairDealsMax <= 1: any existing active deal for the pair blocks ──
	r = await DCABot.canStartDeal({ pair: PAIR, config: { pairBotsDealsMax: 0 }, dealsActive: [ {} ] });
	ok(r.allowed === false && /already has an active deal/.test(r.reason), 'default (pairDealsMax<=1): an existing active deal blocks');

	r = await DCABot.canStartDeal({ pair: PAIR, config: { pairBotsDealsMax: 0 }, dealsActive: [] });
	ok(r.allowed === true, 'default with no active deals allows');

	// dcaFollow passes dealsActive: [] to deliberately skip the per-pair check.
	r = await DCABot.canStartDeal({ pair: PAIR, config: { pairDealsMax: 1, pairBotsDealsMax: 0 }, dealsActive: [] });
	ok(r.allowed === true, 'empty dealsActive skips the per-pair deal check (the dcaFollow path)');

	Common.pairBlackListed = origBlacklist;
	console.log('canStartDealGates.test.js: ' + passed + ' assertions passed');
	process.exit(0);

})().catch((e) => { console.error('canStartDealGates.test.js FAILED:', e && e.message); process.exit(1); });
