'use strict';

// Pins the per-sub-action capability enforcement in apiSignalDispatch (DCABotManager.js). The signal
// route /api/signal/:botId is coarsely mapped to deal.create, but the dispatcher fans one request out to
// entry / add_funds / close / panic_sell / close_all — which are NOT all deal.create-class. Without the
// in-handler ACTION_CAPS check, a scoped key holding only deal.create could force-close or liquidate the
// book through this one route. This test locks that a resolved principal must hold the ACTION's own
// capability, so the enforcement can never silently regress.
//
// Only the DENY path is exercised end-to-end (it returns 403 before any trade handler runs, so it needs no
// DB/exchange wiring). The positive controls confirm a request that DOES hold the capability is NOT stopped
// by the cap gate — the dispatcher then forwards to the real handler, which throws on the minimal test
// wiring; that throw is caught and simply proves the cap gate let it through.

const assert = require('assert');
const Authz = require('../../../app/Authz.js');
const Manager = require('../../../strategies/DCABot/DCABotManager.js');

Manager.init({ Authz: Authz, Common: { logger: function () {} } });

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

function mockRes() {
	return {
		statusCode: 200,
		body: null,
		status(c) { this.statusCode = c; return this; },
		send(o) { this.body = o; return this; }
	};
}

// A key scoped to ONLY deal.create (can open/fund, must NOT be able to close/liquidate).
const dealCreateOnly = { id: 'k-create', kind: 'apikey', capabilities: [ 'deal.create' ] };
// The webhook token principal holds all deal.* caps (open/fund/pause/close).
const dealAll = Authz.webhookPrincipal();

function isCapDeny(res) {
	return res.statusCode === 403 && res.body && typeof res.body.data === 'string' && /lacks the "[^"]+" permission/.test(res.body.data);
}

(async () => {

	// ── DENY: a deal.create-only key cannot close / liquidate through the signal route ──
	for (const action of [ 'close', 'panic_sell', 'close_all' ]) {

		const res = mockRes();
		const out = await Manager.apiSignalDispatch({ body: { action }, params: {}, principal: dealCreateOnly }, res);
		ok(isCapDeny(res), 'deal.create-only key is DENIED 403 on action "' + action + '"');
		ok(out && out.success === false && /deal\.close/.test(out.data), 'the deny for "' + action + '" names the required deal.close capability');
	}

	// ── DENY: deal.create-only also can't pause (deal.pause) ──
	{
		const res = mockRes();
		await Manager.apiSignalDispatch({ body: { action: 'pause' }, params: {}, principal: dealCreateOnly }, res).catch(() => {});
		// 'pause' isn't in the dispatcher's handler map (it's a deal action, not a signal verb), so this is an
		// unknown-action response, NOT a silent allow — assert it did not forward as permitted.
		ok(res.body && res.body.success === false, 'an unhandled signal verb ("pause") is refused, never silently allowed');
	}

	// ── Unknown action is refused before any capability/handler logic ──
	{
		const res = mockRes();
		const out = await Manager.apiSignalDispatch({ body: { action: 'frobnicate' }, params: {}, principal: dealCreateOnly }, res);
		ok(out && out.success === false && /Unknown or missing action/.test(out.data), 'an unknown action is rejected with the valid-actions list');
		ok(!isCapDeny(res), 'the unknown-action refusal is not a capability denial');
	}

	// ── POSITIVE control: deal.create-only IS allowed past the cap gate for entry/add_funds (deal.create) ──
	for (const action of [ 'entry', 'add_funds' ]) {
		const res = mockRes();
		try { await Manager.apiSignalDispatch({ body: { action }, params: {}, principal: dealCreateOnly }, res); } catch (e) {}
		ok(!isCapDeny(res), 'deal.create-only key passes the cap gate for "' + action + '" (forwarded to the handler, not cap-denied)');
	}

	// ── POSITIVE control: a principal holding deal.close IS allowed past the gate for close ──
	{
		const res = mockRes();
		try { await Manager.apiSignalDispatch({ body: { action: 'close' }, params: {}, principal: dealAll }, res); } catch (e) {}
		ok(!isCapDeny(res), 'a principal with deal.close passes the cap gate for "close" (not falsely denied)');
	}

	console.log('signalDispatchCaps: ' + passed + ' assertions passed');
	process.exit(0);
})().catch((e) => { console.error('signalDispatchCaps test error:', e); process.exit(1); });
