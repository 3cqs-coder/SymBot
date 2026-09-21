'use strict';

// Pins the circuit-breaker deal-start gate in canStartDeal (DCABot.js). When the portfolio circuit breaker
// trips, `shareData.appData.circuit_breaker_active` is set to a human-readable reason. canStartDeal is the
// single centralized start-permission check that ALL deal-start paths funnel through (3CQS signals, manual
// API, webhooks, future clients), so enforcing the breaker here — as the very first gate, before any pair
// or DB work — is what actually blocks new deals while the breaker is active. The portfolio-guard tests
// cover the DECISION to trip; this test covers the ENFORCEMENT, so the gate can never silently regress to
// letting new deals open through the breaker.
//
// The gate is exercised directly. Common.pairBlackListed is monkeypatched on the shared Common singleton
// (DCABot holds the same instance) to (a) prove the active breaker short-circuits BEFORE any pair/DB work,
// and (b) provide a clean no-op for the positive control. No DB/exchange wiring is needed: with no pair
// limits configured, checkGlobalPairLimit never queries getDeals. process.exit(0) at the end because
// requiring DCABot pulls in modules that may register timers.

const assert = require('assert');
const Common = require('../../../app/Common.js');
const DCABot = require('../../../strategies/DCABot/DCABot.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// Minimal shareData: only appData is read by the breaker gate.
const appData = {};
DCABot.init({ appData: appData });

const origBlacklist = Common.pairBlackListed;

// ── 1. An active breaker blocks the start, before any pair/DB work ───────────
(async () => {

	let blacklistCalled = false;
	// If the gate does NOT short-circuit, this throwing spy would be hit and reject the promise.
	Common.pairBlackListed = async () => { blacklistCalled = true; throw new Error('pairBlackListed must not run while breaker is active'); };

	appData.circuit_breaker_active = 'Portfolio loss 12.0% exceeded 10% limit';

	const res = await DCABot.canStartDeal({ pair: 'BTC/USDT', config: {} });

	ok(res.allowed === false, 'active breaker: deal start is not allowed');
	ok(typeof res.reason === 'string' && /Circuit Breaker Active/.test(res.reason), 'active breaker: reason names the circuit breaker');
	ok(res.reason.indexOf('Portfolio loss 12.0% exceeded 10% limit') !== -1, 'active breaker: the trip reason is surfaced to the caller');
	ok(blacklistCalled === false, 'active breaker: short-circuits before the blacklist / DB checks run');

	// ── 2. A different truthy reason still trips the gate (any caller, any reason) ──
	appData.circuit_breaker_active = 'Manual halt';
	const res2 = await DCABot.canStartDeal({ pair: 'ETH/USDT', config: {} });
	ok(res2.allowed === false && /Manual halt/.test(res2.reason), 'any truthy breaker reason blocks the start');

	// ── 3. With the breaker cleared, the gate is passed and control proceeds ──────
	let cleanCalled = false;
	Common.pairBlackListed = async () => { cleanCalled = true; return false; };   // not blacklisted
	appData.circuit_breaker_active = null;

	const res3 = await DCABot.canStartDeal({ pair: 'BTC/USDT', config: {} });   // no pair limits → no getDeals query
	ok(!/Circuit Breaker Active/.test(res3.reason || ''), 'cleared breaker: the breaker no longer blocks the start');
	ok(cleanCalled === true, 'cleared breaker: control passes the breaker gate and reaches the blacklist check');
	ok(res3.allowed === true, 'cleared breaker with no other limits: the deal start is allowed');

	// A breaker value of undefined (never tripped) also does not block.
	delete appData.circuit_breaker_active;
	const res4 = await DCABot.canStartDeal({ pair: 'BTC/USDT', config: {} });
	ok(res4.allowed === true, 'never-tripped breaker (undefined): the deal start is allowed');

	Common.pairBlackListed = origBlacklist;

	console.log('CircuitBreakerGate.test.js: ' + passed + ' assertions passed');
	process.exit(0);

})().catch((e) => { console.error('CircuitBreakerGate.test.js FAILED:', e && e.message); process.exit(1); });