'use strict';

// Pins the Tier 2 batched-actions dispatch in apiSignalDispatch (DCABotManager.js). An `actions` array runs each
// sub-action IN ORDER against the same bot and returns ONE aggregated response, reusing the unchanged
// single-action path for each. This locks: order + per-action results; overall success only when every
// sub-action succeeds; a top-level dry_run propagates to each sub-action (so the batch executes nothing here);
// each sub-action is independently gated (a cross-bot deal_id fails without blocking the others); a dealId
// pinned by one sub-action does NOT leak into the next (cloned params); and the empty / too-large guards. A
// body with no `actions` array is unaffected (covered by the single-action tests).

const assert = require('assert');
const Authz = require('../../../app/Authz.js');
const Manager = require('../../../strategies/DCABot/DCABotManager.js');

const DEALS = {
	'DEAL_OWN':   { dealId: 'DEAL_OWN',   botId: 'bot-1', status: 0 },
	'DEAL_OTHER': { dealId: 'DEAL_OTHER', botId: 'bot-2', status: 0 }
};

Manager.init({
	Authz: Authz,
	Common: { logger: function () {}, convertBoolean: (v) => (v === true || v === 'true' || v === 1 || v === '1') },
	DCABot: { getDeals: async (q) => { const d = DEALS[q && q.dealId]; return d ? [ d ] : []; } }
});

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function mockRes() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, send(o) { this.body = o; return this; } }; }

const dealAll = Authz.webhookPrincipal();

(async () => {

	// ── A dry-run batch runs each sub-action in order and aggregates the results ──
	{
		const out = await Manager.apiSignalDispatch({
			body: { dry_run: true, actions: [ { action: 'close', deal_id: 'DEAL_OWN' }, { action: 'entry', pair: 'BTC/USD' } ] },
			params: { botId: 'bot-1' }, principal: dealAll
		}, mockRes());

		ok(out && out.batch === true && out.count === 2 && Array.isArray(out.results), 'a batch returns an aggregated result of every sub-action');
		ok(out.success === true, 'overall success is true when every sub-action succeeds');
		ok(out.results[0].result.dry_run === true && out.results[0].result.would.dealId === 'DEAL_OWN', 'sub-action 0 dry-runs against its targeted deal');
		ok(out.results[1].result.dry_run === true && out.results[1].result.would.action === 'entry', 'sub-action 1 dry-runs its own action');
	}

	// ── A failing sub-action (cross-bot deal_id) fails ITSELF without blocking the others ──
	{
		const out = await Manager.apiSignalDispatch({
			body: { dry_run: true, actions: [ { action: 'close', deal_id: 'DEAL_OTHER' }, { action: 'entry', pair: 'BTC/USD' } ] },
			params: { botId: 'bot-1' }, principal: dealAll
		}, mockRes());

		ok(out.success === false, 'overall success is false when any sub-action fails');
		ok(out.results[0].result.success === false && /does not belong/.test(out.results[0].result.data), 'the cross-bot sub-action is refused (fail closed)');
		ok(out.results[1].result.dry_run === true, 'the following sub-action still runs (continue-on-error)');
	}

	// ── Isolation: a dealId pinned by sub-action 0 does NOT leak into sub-action 1 (cloned params) ──
	{
		const out = await Manager.apiSignalDispatch({
			body: { dry_run: true, actions: [ { action: 'close', deal_id: 'DEAL_OWN' }, { action: 'close', pair: 'BTC/USD' } ] },
			params: { botId: 'bot-1' }, principal: dealAll
		}, mockRes());

		ok(out.results[0].result.would.dealId === 'DEAL_OWN', 'sub-action 0 targets its deal');
		ok(out.results[1].result.would.dealId === null, 'sub-action 1 does NOT inherit sub-action 0\'s pinned deal');
	}

	// ── An empty batch is refused ──
	{
		const out = await Manager.apiSignalDispatch({ body: { actions: [] }, params: { botId: 'bot-1' }, principal: dealAll }, mockRes());
		ok(out.success === false && /Empty batch/.test(out.data), 'an empty batch is refused');
	}

	// ── An over-sized batch is refused before running anything ──
	{
		const many = []; for (let i = 0; i < 11; i++) { many.push({ action: 'entry' }); }
		const out = await Manager.apiSignalDispatch({ body: { dry_run: true, actions: many }, params: { botId: 'bot-1' }, principal: dealAll }, mockRes());
		ok(out.success === false && /too large/.test(out.data), 'a batch over the size cap is refused');
	}

	console.log('SignalBatch: ' + passed + ' assertions passed');
	process.exit(0);
})().catch((e) => { console.error('SignalBatch test error:', e); process.exit(1); });
