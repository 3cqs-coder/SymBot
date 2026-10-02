'use strict';

// Pins the Tier 2 deal-targeting gate in apiSignalDispatch (DCABotManager.js). A signal to /api/signal/:botId
// may name a specific deal via `deal_id` (or `dealId`) in the body — resolved and pinned as req.params.dealId
// only when it is an ACTIVE deal owned by THIS bot. The money-path isolation property proven here: a bot-scoped
// signal can NEVER act on another bot's deal by id, and an unknown or inactive deal is refused (fail closed).
// The successful-targeting cases use dry_run so nothing executes: dry_run runs AFTER the target gate, so the
// plan's dealId reflects exactly what a real action would have hit. A non-dry-run case proves a valid target is
// pinned and forwarded to the handler; an absent deal_id leaves the existing bot+pair resolution untouched.

const assert = require('assert');
const Authz = require('../../../app/Authz.js');
const Manager = require('../../../strategies/DCABot/DCABotManager.js');

// getDeals is the ONLY money-path read the gate makes; a small fixture returns a deal by id so the gate's
// ownership/active checks can be exercised without a database.
const DEALS = {
	'DEAL_OWN':    { dealId: 'DEAL_OWN',    botId: 'bot-1', status: 0 },   // active, owned by bot-1
	'DEAL_OTHER':  { dealId: 'DEAL_OTHER',  botId: 'bot-2', status: 0 },   // active, owned by a DIFFERENT bot
	'DEAL_CLOSED': { dealId: 'DEAL_CLOSED', botId: 'bot-1', status: 1 }    // owned by bot-1 but not active
};

Manager.init({
	Authz: Authz,
	Common: { logger: function () {}, convertBoolean: (v) => (v === true || v === 'true' || v === 1 || v === '1') },
	DCABot: { getDeals: async (q) => { const d = DEALS[q && q.dealId]; return d ? [ d ] : []; } }
});

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

function mockRes() {
	return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, send(o) { this.body = o; return this; } };
}

const dealAll = Authz.webhookPrincipal();   // holds all deal.* capabilities

(async () => {

	// ── A same-bot, active deal_id is accepted and pinned (dry run reports the resolved target) ──
	{
		const req = { body: { action: 'close', deal_id: 'DEAL_OWN', dry_run: true }, params: { botId: 'bot-1' }, principal: dealAll };
		const out = await Manager.apiSignalDispatch(req, mockRes());
		ok(out && out.dry_run === true && out.would && out.would.dealId === 'DEAL_OWN', 'a same-bot active deal_id is targeted and reported');
		ok(req.params.dealId === 'DEAL_OWN', 'the resolved deal is pinned as req.params.dealId for the handler');
	}

	// ── A deal_id owned by ANOTHER bot is REFUSED (isolation — fail closed) ──
	{
		const res = mockRes();
		const out = await Manager.apiSignalDispatch({ body: { action: 'close', deal_id: 'DEAL_OTHER', dry_run: true }, params: { botId: 'bot-1' }, principal: dealAll }, res);
		ok(out && out.success === false && !out.dry_run && /does not belong to bot bot-1/.test(out.data), 'a cross-bot deal_id is refused, never executed or dry-run planned');
	}

	// ── An unknown deal_id is refused ──
	{
		const out = await Manager.apiSignalDispatch({ body: { action: 'add_funds', deal_id: 'NOPE', volume: 10, dry_run: true }, params: { botId: 'bot-1' }, principal: dealAll }, mockRes());
		ok(out && out.success === false && /not found/.test(out.data), 'an unknown deal_id is refused');
	}

	// ── An inactive deal_id (owned by this bot) is refused ──
	{
		const out = await Manager.apiSignalDispatch({ body: { action: 'panic_sell', deal_id: 'DEAL_CLOSED', dry_run: true }, params: { botId: 'bot-1' }, principal: dealAll }, mockRes());
		ok(out && out.success === false && /not active/.test(out.data), 'an inactive deal_id is refused');
	}

	// ── A Mongo-operator injection as deal_id matches nothing → clean "not found", never a broad match ──
	{
		const out = await Manager.apiSignalDispatch({ body: { action: 'close', deal_id: { $ne: null }, dry_run: true }, params: { botId: 'bot-1' }, principal: dealAll }, mockRes());
		ok(out && out.success === false && /not found/.test(out.data), 'a non-string deal_id is coerced and matches nothing');
	}

	// ── A valid same-bot target WITHOUT dry_run pins the deal and forwards to the handler ──
	{
		const req = { body: { action: 'close', deal_id: 'DEAL_OWN' }, params: { botId: 'bot-1' }, principal: dealAll };
		let reached = false;
		try { await Manager.apiSignalDispatch(req, mockRes()); } catch (e) { reached = true; }   // handler throws on minimal wiring
		ok(req.params.dealId === 'DEAL_OWN', 'a real (non-dry-run) request pins the resolved deal');
		ok(reached, 'and forwards to the trade handler (proven by the minimal-wiring throw)');
	}

	// ── No deal_id: the existing bot+pair resolution is untouched (gate is a no-op, forwards to the handler) ──
	{
		const req = { body: { action: 'close', pair: 'BTC/USD' }, params: { botId: 'bot-1' }, principal: dealAll };
		let reached = false;
		try { await Manager.apiSignalDispatch(req, mockRes()); } catch (e) { reached = true; }
		ok(req.params.dealId === undefined, 'no deal_id → nothing pinned; the handler runs its own bot+pair resolution');
		ok(reached, 'and the request still forwards to the handler (existing path unchanged)');
	}

	console.log('SignalDealTarget: ' + passed + ' assertions passed');
	process.exit(0);
})().catch((e) => { console.error('SignalDealTarget test error:', e); process.exit(1); });
