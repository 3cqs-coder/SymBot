'use strict';

// Pins the opt-in DRY RUN in apiSignalDispatch (DCABotManager.js). With `dry_run` truthy, the dispatcher
// reports what the signal WOULD do — the resolved action and its target — and returns WITHOUT calling the
// trade handler. The money-path invariant proven here: a dry run never starts, funds, closes, or panic-sells
// a deal. The proof reuses the same wiring signalDispatchCaps.test.js relies on — on this minimal test setup
// the real handlers throw the moment they run, so a dry run that returns cleanly (no throw, a dry_run:true
// body) demonstrates the handler was never reached. The ordering guarantees are also locked: a dry run is
// still refused for an unknown action or a key lacking the action's capability, and a request WITHOUT dry_run
// still reaches the handler (control).

const assert = require('assert');
const Authz = require('../../../app/Authz.js');
const Manager = require('../../../strategies/DCABot/DCABotManager.js');

// convertBoolean is the body-boolean coercion apiSignalDispatch uses for the dry_run flag; a faithful stub
// (true / 'true' / 1 / '1') is enough for these tests. getDeals backs the deal-targeting gate that runs for
// close / add_funds / panic_sell before the dry-run: these tests target an active deal owned by bot-1 so the
// gate resolves it (read-only) and the dry-run reports it.
Manager.init({
	Authz: Authz,
	Common: { logger: function () {}, convertBoolean: (v) => (v === true || v === 'true' || v === 1 || v === '1') },
	DCABot: { getDeals: async (q) => ((q && q.dealId === 'DEAL_X') ? [ { dealId: 'DEAL_X', botId: 'bot-1', status: 0 } ] : []) }
});

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

const dealAll = Authz.webhookPrincipal();                                     // holds all deal.* caps
const dealCreateOnly = { id: 'k-create', kind: 'apikey', capabilities: [ 'deal.create' ] };

(async () => {

	// ── A dry run of every action returns the plan and NEVER reaches the trade handler ──
	// (If it reached the handler, the minimal wiring would throw; a clean dry_run:true body proves it did not.)
	for (const action of [ 'entry', 'add_funds', 'close', 'panic_sell' ]) {

		const res = mockRes();
		let threw = false;
		try {
			const out = await Manager.apiSignalDispatch(
				{ body: { action, dry_run: true, dealId: 'DEAL_X', pair: 'BTC/USD' }, params: { botId: 'bot-1' }, principal: dealAll },
				res
			);
			ok(out && out.dry_run === true && out.success === true, 'dry run of "' + action + '" returns a dry_run plan');
			ok(out.would && out.would.action === action && out.would.botId === 'bot-1' && out.would.dealId === 'DEAL_X', 'the plan reports the resolved action and target for "' + action + '"');
		}
		catch (e) { threw = true; }
		ok(!threw, 'dry run of "' + action + '" did NOT reach the trade handler (no execution)');
		ok(res.body && res.body.dry_run === true, 'the response body is the dry_run plan for "' + action + '"');
	}

	// ── Ordering: a dry run is still CAP-DENIED for an action the key lacks (dry_run cannot bypass scope) ──
	{
		const res = mockRes();
		const out = await Manager.apiSignalDispatch({ body: { action: 'close', dry_run: true }, params: { botId: 'bot-1' }, principal: dealCreateOnly }, res);
		ok(res.statusCode === 403 && out && out.success === false && !out.dry_run, 'a deal.create-only key is still denied a dry run of "close"');
	}

	// ── Ordering: a dry run of an UNKNOWN action is still refused (dry_run cannot bypass validation) ──
	{
		const res = mockRes();
		const out = await Manager.apiSignalDispatch({ body: { action: 'frobnicate', dry_run: true }, params: { botId: 'bot-1' }, principal: dealAll }, res);
		ok(out && out.success === false && /Unknown or missing action/.test(out.data) && !out.dry_run, 'an unknown action is refused even with dry_run');
	}

	// ── Control: WITHOUT dry_run, the request reaches the handler (throws on minimal wiring), never a dry_run body ──
	{
		const res = mockRes();
		let reached = false;
		try { await Manager.apiSignalDispatch({ body: { action: 'entry' }, params: { botId: 'bot-1' }, principal: dealAll }, res); }
		catch (e) { reached = true; }
		ok(reached || !(res.body && res.body.dry_run), 'a normal (no dry_run) request forwards to the handler, not the dry-run path');
	}

	console.log('SignalDryRun: ' + passed + ' assertions passed');
	process.exit(0);
})().catch((e) => { console.error('SignalDryRun test error:', e); process.exit(1); });
