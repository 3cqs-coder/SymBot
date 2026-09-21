'use strict';

// Tests the 'drawdown_sentinel' recipe handler in isolation by stubbing DealQuery.getDrawdownRisk
// (the deterministic risk snapshot). Verifies: a BREACH delivers one detailed alert; a CLEAN check is
// silent; the OPTIONAL ai_enhance path appends an AI summary when a provider is available and skips it
// gracefully when not. No DB, no model.

const assert = require('assert');
const DealQuery = require('../../queries/DealQuery.js');
const Handler = require('../../scheduledtasks/DrawdownSentinelHandler.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; console.log('  ok   - ' + m); }

const BREACH = {
	success: true, underwater_threshold_pct: 10, so_used_threshold: 0.8, open_deals: 16, total_unrealized_pnl: -1234.5,
	underwater: [ { dealId: 'AAVE_USD-1', pair: 'AAVE/USD', unrealizedPct: -12.4, unrealizedPnl: -345.2, safetyOrdersUsed: 5 } ],
	underwater_count: 1,
	near_max_safety: [ { dealId: 'SOL_USD-2', pair: 'SOL/USD', safetyOrdersUsed: 8, safetyOrdersMax: 9, ladderExhausted: false } ],
	near_max_safety_count: 1
};
const CLEAN = { success: true, underwater_threshold_pct: 10, open_deals: 16, total_unrealized_pnl: 210.5, underwater: [], underwater_count: 0, near_max_safety: [], near_max_safety_count: 0 };

function makeShareData(cap, opts) {
	opts = opts || {};
	return {
		Common: { logger: () => {} },
		appData: { ai: opts.aiOn ? { ollama: { enabled: true } } : {} },
		AIClient: opts.ai ? { getModelName: () => 'test-model', completePrompt: async () => opts.ai } : undefined,
		ScheduleNotifier: {
			resolveTargets: (s) => (s && s.notifications) || [ { type: 'browser', target: {}, on: [ 'always' ] } ],
			deliver: async (t, p) => { cap.push(p); return { delivered: 1 }; }
		}
	};
}
function registerAndGet(sd) {
	let fn = null;
	Handler.register({ registerHandler: (type, h) => { assert.strictEqual(type, 'drawdown_sentinel'); fn = h; } }, sd);
	assert.ok(typeof fn === 'function');
	return fn;
}

(async () => {

	const orig = DealQuery.getDrawdownRisk;

	// (1) breach → one detailed alert, no AI
	DealQuery.getDrawdownRisk = async () => BREACH;
	{
		const cap = [];
		const fn = registerAndGet(makeShareData(cap));
		const res = await fn({ schedule_id: 's1', label: 'Drawdown sentinel', settings: {} });
		ok(res.status === 'ok', 'breach run returns ok');
		ok(cap.length === 1 && cap[0].type === 'warning' && cap[0].status === 'error', 'one warning alert delivered');
		const msg = cap[0].message;
		ok(/AAVE\/USD/.test(msg) && /-12\.4%/.test(msg), 'alert lists the underwater deal with its %');
		ok(/SOL\/USD/.test(msg) && /8\/9/.test(msg), 'alert lists the near-max-safety deal');
		ok(!/AI take/.test(msg), 'no AI narrative when ai_enhance is off');
	}

	// (2) clean → silent
	DealQuery.getDrawdownRisk = async () => CLEAN;
	{
		const cap = [];
		const fn = registerAndGet(makeShareData(cap));
		const res = await fn({ schedule_id: 's2', label: 'Drawdown sentinel', settings: {} });
		ok(res.status === 'ok' && cap.length === 0, 'a clean check sends NO alert');
		ok(/nothing breaching/.test(res.output), 'clean run output says nothing breaching');
	}

	// (3) ai_enhance ON + provider available → narrative appended
	DealQuery.getDrawdownRisk = async () => BREACH;
	{
		const cap = [];
		const fn = registerAndGet(makeShareData(cap, { aiOn: true, ai: 'AAVE is your biggest drag; watch its ladder.' }));
		await fn({ schedule_id: 's3', label: 'Drawdown sentinel', settings: { ai_enhance: true } });
		ok(cap.length === 1 && /AI take: AAVE is your biggest drag/.test(cap[0].message), 'ai_enhance appends the AI summary when a provider is available');
	}

	// (4) ai_enhance ON but NO provider → still alerts, just no narrative (graceful)
	{
		const cap = [];
		const fn = registerAndGet(makeShareData(cap, { aiOn: false }));   // no AIClient / provider off
		await fn({ schedule_id: 's4', label: 'Drawdown sentinel', settings: { ai_enhance: true } });
		ok(cap.length === 1 && !/AI take/.test(cap[0].message), 'ai_enhance with no provider still delivers the deterministic alert, minus the summary');
	}

	DealQuery.getDrawdownRisk = orig;
	console.log('\nDrawdownSentinelHandler: ' + passed + ' assertions passed');
	process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
