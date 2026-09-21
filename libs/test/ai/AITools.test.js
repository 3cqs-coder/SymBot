'use strict';

/**
 * Tests for the AI chat's read-only tool registry.
 *
 * The critical invariant is SAFETY: every registered tool must be read-only —
 * there must be no tool that can pause, cancel, sell, or modify anything, so the
 * tool-calling loop cannot take a trade-affecting action even if the model asks.
 * Also pins the schema shape the provider adapters depend on and that unknown
 * tools resolve to an error rather than throwing.
 */

const assert = require('assert');

const DealQuery = require('../../queries/DealQuery.js');
const LogScan   = require('../../queries/LogScan.js');
const aiTools     = require('../../ai/AITools.js');

// Minimal shareData: deal queries hit a stub that returns no deals; log helpers
// resolve; that is enough to exercise dispatch without real data.
const shareData = {
	Common: {
		logger: () => {},
		getDateParts: () => ({ date: '2026-08-13' }),
		getInstanceName: async () => 'test-instance',
		convertBoolean: (v) => v === true,
		// The real, dependency-free arithmetic evaluator the `calculate` tool wraps.
		safeEvalArithmetic: require('../../app/Common.js').safeEvalArithmetic
	},
	DCABot: { getDeals: async () => [] }
};

DealQuery.init(shareData);
LogScan.init(shareData);
aiTools.init(shareData);

let passed = 0;

function test(name, fn) {
	try { fn(); passed++; console.log('  ok   - ' + name); }
	catch (e) { process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); }
}
async function testAsync(name, fn) {
	try { await fn(); passed++; console.log('  ok   - ' + name); }
	catch (e) { process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); }
}


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSchema shape:');

test('listSchemas returns provider-shaped function schemas', () => {
	const schemas = aiTools.listSchemas();
	assert.ok(Array.isArray(schemas) && schemas.length >= 5, 'expected several tools');
	schemas.forEach(s => {
		assert.strictEqual(s.type, 'function');
		assert.ok(s.function && typeof s.function.name === 'string' && s.function.name !== '');
		assert.ok(typeof s.function.description === 'string' && s.function.description !== '');
		assert.ok(s.function.parameters && s.function.parameters.type === 'object');
	});
});

test('the expected read-only tools are registered', () => {
	const names = aiTools.TOOLS.map(t => t.name);
	['list_open_deals', 'get_deal', 'list_recent_completed_deals', 'get_deals_for_pair',
	 'get_paused_deals', 'search_logs', 'get_deal_events'].forEach(n => {
		assert.ok(names.includes(n), 'missing tool: ' + n);
	});
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nSafety — read-only only:');

test('every tool name uses a read-only verb prefix (no mutating tools)', () => {
	// The registry must only ever expose readers. Requiring a read prefix is a
	// stronger, less error-prone gate than blacklisting mutation words (which would
	// wrongly flag a reader like get_paused_deals).
	const READ_PREFIX = /^(get|list|search|find|count|read|diagnose|summarize|analyze|scan|compare)_/;
	// Exempt by EXACT name (not a prefix, so a future mutating tool can't slip in under the name):
	//  • `explore` — an orchestrator that runs a sub-agent over ONLY the other reader tools and can never
	//    reach a mutator (its read-only-ness is additionally pinned by the explore test suite);
	//  • `calculate` — a pure, stateless arithmetic evaluator that touches no data and no state at all, so
	//    it is read-only by construction even though it carries no verb_noun reader prefix.
	const READ_ONLY_EXEMPT = new Set([ 'explore', 'calculate' ]);
	aiTools.TOOLS.forEach(t => {
		assert.ok(READ_PREFIX.test(t.name) || READ_ONLY_EXEMPT.has(t.name),
			'tool "' + t.name + '" must start with a read-only prefix (get_/list_/search_/…) — only readers may be registered');
	});
});

test('every tool description reads-only (no write verbs in the surface)', () => {
	// A weak signal, but catches an accidentally-added mutating tool at review time. "close"
	// is only a mutation verb when it takes a trade object ("close a deal/order"); the bare
	// word is proximity ("close to a stop-loss"), so it must be qualified to avoid a false hit.
	aiTools.TOOLS.forEach(t => {
		assert.ok(!/\b(cancels?|sells?|deletes?|modif|places an order|closes?\s+(a|the|this|that|all|deal|order|position))\b/i.test(t.description),
			'tool "' + t.name + '" description implies mutation');
	});
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nEnum-locked tool decoding:');

test('canonical / alias / formatting variants fold to the registry name', () => {
	const canonical = aiTools.TOOLS[0].name;
	assert.strictEqual(aiTools.resolveTool(canonical), canonical, 'exact name must resolve to itself');
	// camelCase, spaces and hyphens are all just formatting of the same enum member.
	assert.strictEqual(aiTools.resolveTool('getPerformanceSummary'), 'get_performance_summary');
	assert.strictEqual(aiTools.resolveTool('get performance summary'), 'get_performance_summary');
	assert.strictEqual(aiTools.resolveTool('GET-PERFORMANCE-SUMMARY'), 'get_performance_summary');
});

test('a near-miss repairs only within the offered shortlist', () => {
	const shortlist = [ 'get_performance_summary', 'list_open_deals', 'summarize_recent_errors' ];
	assert.strictEqual(aiTools.resolveTool('list_open_deal', shortlist), 'list_open_deals', 'plural typo');
	assert.strictEqual(aiTools.resolveTool('summarize_recent_errors', shortlist), 'summarize_recent_errors', 's/z spelling');
});

test('a genuinely unknown or far-off name stays unresolved (null)', () => {
	const shortlist = [ 'get_performance_summary', 'list_open_deals' ];
	assert.strictEqual(aiTools.resolveTool('totally_made_up_tool', shortlist), null);
	// 8-edit suffix, not a typo — must NOT be silently rerouted.
	assert.strictEqual(aiTools.resolveTool('get_performance', shortlist), null);
	assert.strictEqual(aiTools.resolveTool(''), null);
});

console.log('\nLearning-drift watchdog:');

test('auditLearningDrift returns Watchdog-shaped findings', () => {
	const findings = aiTools.auditLearningDrift();
	assert.ok(Array.isArray(findings), 'expected an array');
	findings.forEach(f => { assert.ok(f && typeof f.action === 'string' && typeof f.detail === 'string', 'finding must have action + detail'); });
});

test('the shipped learning corpus has NO orphaned tool references (tool-rename safety)', () => {
	// Every tool the corpus names must still resolve (directly or via TOOL_ALIASES). If this fails,
	// a tool was renamed/removed WITHOUT adding a TOOL_ALIASES old->new entry — which would silently
	// drop those learned patterns on import. The fix is to add the alias, not to edit the corpus.
	const orphans = aiTools.auditLearningDrift().filter(f => f.action === 'watchdog.ai_learning_orphans');
	assert.strictEqual(orphans.length, 0, orphans.length ? orphans[0].detail : '');
});

console.log('\nDispatch:');

(async () => {

	await testAsync('unknown tool resolves to an error (never throws)', async () => {
		const r = await aiTools.execute('do_something_dangerous', {});
		assert.ok(r && typeof r.error === 'string', 'expected an { error } result');
	});

	await testAsync('a formatting-variant name still dispatches (enum-locked)', async () => {
		const r = await aiTools.execute('listOpenDeals', { limit: 3 });
		assert.ok(r && Array.isArray(r.open_deals), 'camelCase name should reach list_open_deals');
	});

	await testAsync('list_open_deals dispatches and returns a shaped result', async () => {
		const r = await aiTools.execute('list_open_deals', { limit: 5 });
		assert.ok(r && Array.isArray(r.open_deals) && typeof r.count === 'number');
	});

	await testAsync('list_open_deals carries a per-bot rollup (by_bot) for the deterministic per-bot render', async () => {
		const r = await aiTools.execute('list_open_deals', { limit: 5 });
		// by_bot must always be an array of {botName, count}, sorted most-deals-first, and its counts must
		// sum to the authoritative open-deals total — this is what powers the "deals per bot" instant render.
		assert.ok(r && Array.isArray(r.by_bot), 'by_bot rollup present');
		for (const row of r.by_bot) {
			assert.ok(row && typeof row.botName === 'string' && typeof row.count === 'number' && row.count > 0, 'row shape');
		}
		for (let i = 1; i < r.by_bot.length; i++) {
			assert.ok(r.by_bot[i - 1].count >= r.by_bot[i].count, 'sorted most-deals-first');
		}
		if (!r.by_bot_capped && typeof r.open_deals_total === 'number') {
			const sum = r.by_bot.reduce((a, b) => a + b.count, 0);
			assert.strictEqual(sum, r.open_deals_total, 'per-bot counts sum to the open-deals total');
		}
	});

	await testAsync('get_deal dispatches without throwing on a missing id', async () => {
		const r = await aiTools.execute('get_deal', { deal_id: 'NOPE-000-0' });
		assert.ok(r && 'found' in r);
	});

	// ── Grounded-identifier argument constraint (#1) ──────────────────────────
	test('constrainToolSchemas injects the grounded enum on deal_id / pair without mutating the source', () => {
		const schemas = [
			{ type: 'function', function: { name: 'get_deal', parameters: { type: 'object', properties: { deal_id: { type: 'string' } } } } },
			{ type: 'function', function: { name: 'get_deals_for_pair', parameters: { type: 'object', properties: { pair: { type: 'string' } } } } },
			{ type: 'function', function: { name: 'find_deal_id', parameters: { type: 'object', properties: { terms: { type: 'string' } } } } }
		];
		const grounded = { ids: new Set([ 'ME_USD-1MBI6KO-1768609422' ]), pairs: new Set([ 'BAL/USD' ]) };
		const c = aiTools.constrainToolSchemas(schemas, grounded);
		assert.deepStrictEqual(c[0].function.parameters.properties.deal_id.enum, [ 'ME_USD-1MBI6KO-1768609422' ]);
		assert.deepStrictEqual(c[1].function.parameters.properties.pair.enum, [ 'BAL/USD' ]);
		assert.strictEqual(c[2], schemas[2], 'a schema with no id/pair param is passed through by reference');
		assert.strictEqual(schemas[0].function.parameters.properties.deal_id.enum, undefined, 'source schema is never mutated');
	});

	test('constrainToolSchemas is a no-op when nothing is grounded yet', () => {
		const schemas = [ { type: 'function', function: { name: 'get_deal', parameters: { type: 'object', properties: { deal_id: { type: 'string' } } } } } ];
		assert.strictEqual(aiTools.constrainToolSchemas(schemas, { ids: new Set(), pairs: new Set() }), schemas);
	});

	test('reconcileToolArgs snaps a truncated deal id to its grounded form and normalizes a mis-cased pair', () => {
		const grounded = { ids: new Set([ 'ME_USD-1MBI6KO-1768609422' ]), pairs: new Set([ 'BAL/USD' ]) };
		assert.strictEqual(aiTools.reconcileToolArgs({ deal_id: 'ME_USD-1MBI6KO-17' }, grounded).deal_id, 'ME_USD-1MBI6KO-1768609422');
		assert.strictEqual(aiTools.reconcileToolArgs({ pair: 'bal/usd' }, grounded).pair, 'BAL/USD');
		// A valid id and an empty grounded set both pass through untouched.
		assert.strictEqual(aiTools.reconcileToolArgs({ deal_id: 'ME_USD-1MBI6KO-1768609422' }, grounded).deal_id, 'ME_USD-1MBI6KO-1768609422');
		assert.strictEqual(aiTools.reconcileToolArgs({ deal_id: 'X_Y-ZZZZ-123456' }, { ids: new Set(), pairs: new Set() }).deal_id, 'X_Y-ZZZZ-123456');
	});

	// ── calculate tool (#2) ───────────────────────────────────────────────────
	await testAsync('calculate evaluates arithmetic exactly and rejects a bad expression', async () => {
		const ok = await aiTools.execute('calculate', { expression: '1.5^3' });
		assert.strictEqual(ok.result, 3.375);
		const bad = await aiTools.execute('calculate', { expression: '2 +' });
		assert.ok(bad && bad.error, 'a malformed expression returns an error, never throws');
	});

	// ── size guard: the model cap, the deterministic bypass, and the slimmed open-deals payload ──
	// The model-facing size guard replaces any tool result over MAX_RESULT_CHARS with a {note, partial}
	// stub. That stub has no success:false, so renderableResult() passes it, but it also lacks the real
	// fields, so a deterministic format*() returns null — the production bug where the open-deals shortcut
	// kept abstaining ("live deal data unavailable") for a user with many open deals. Two defenses are
	// tested: (1) the ctx.deterministic flag makes execute() skip the cap for in-code renderers, and
	// (2) get_open_deals_status is sized to stay UNDER the cap even at the top of the open-deal range, so
	// the MODEL path also gets real data instead of a truncated stub (no more fabricating from `partial`).
	const MODEL_RESULT_CAP = 12000;   // mirrors AITools MAX_RESULT_CHARS
	console.log('\nSize guard, deterministic bypass, and slimmed open-deals payload:');

	// A rich fixture at the top of the realistic open-deal range, with long pair / deal-id strings so the
	// serialized sizes are a conservative (large) estimate of production.
	const bigDeals = [];
	const bigTracker = {};
	for (let i = 0; i < 60; i++) {
		const pair = 'LONGCOIN' + (100 + i) + '/USDT';
		const dealId = pair.replace('/', '_') + '-ABCDEFG-17600000' + (10 + i);
		bigDeals.push({
			dealId, pair, exchange: 'coinbase', botName: 'Bot' + (i % 3), status: 'active', date: 1760000000000 + i,
			orders: { '0': { filled: 1, price: 1 + i }, '1': { filled: 0, price: 0.9 + i } }
		});
		bigTracker[dealId] = { info: {
			price_last: 1.05 + i, price_average: 1.10 + i, price_target: 1.20 + i,
			profit: (i % 2 === 0) ? 3.14 : -2.71, profit_percentage: (i % 2 === 0) ? 1.5 : -1.3,
			safety_orders_used: i % 6
		} };
	}
	const savedGetDeals = shareData.DCABot.getDeals;
	const savedTracker  = shareData.DCABot.getDealTracker;
	shareData.DCABot.getDeals       = async () => bigDeals;
	shareData.DCABot.getDealTracker = async (id) => (id == null ? bigTracker : bigTracker[id]);

	try {
		// (1) The cap MECHANISM, tested on a tool whose result genuinely overflows (list_open_deals of a
		// large book). Without the flag it is truncated for the model; with it the real array survives.
		await testAsync('the model size guard truncates an oversized tool result', async () => {
			const r = await aiTools.execute('list_open_deals', { limit: 50 });
			assert.ok(r && r.note && /truncated/i.test(r.note) && r.partial != null,
				'expected an oversized result to be replaced by the {note, partial} stub');
		});

		await testAsync('ctx.deterministic makes execute() skip the cap for in-code renderers', async () => {
			const r = await aiTools.execute('list_open_deals', { limit: 50 }, { deterministic: true });
			assert.ok(r && r.partial === undefined, 'the deterministic path is not the size-guard stub');
			assert.ok(Array.isArray(r.open_deals) && r.open_deals.length > 0, 'the real deals array survived uncapped');
		});

		// (2) The SLIMMING regression: get_open_deals_status must stay under the cap for the MODEL path too,
		// so a user with many open deals gets real data — never a truncated stub the model fabricates from.
		await testAsync('get_open_deals_status stays under the model size cap with a large open book', async () => {
			const r = await aiTools.execute('get_open_deals_status', {});   // model path — no deterministic flag
			assert.ok(r && r.partial === undefined && !(r.note && /it was too large/i.test(r.note)),
				'the model-facing open-deals result must NOT be the truncated stub');
			assert.strictEqual(r.success, true, 'the model receives the real success object');
			assert.strictEqual(r.open_deals_total, 60, 'all open deals are counted');
			assert.ok(JSON.stringify(r).length < MODEL_RESULT_CAP,
				'serialized result stays under the model cap (guards against future payload bloat)');
			assert.ok(!('deals' in r) && !('deals_shown' in r),
				'the redundant worst-first `deals` array is gone (its detail lives in closest_to_take_profit)');
		});

		await testAsync('the slimmed result keeps every field the deterministic renderers and safety-order answers need', async () => {
			const r = await aiTools.execute('get_open_deals_status', {}, { deterministic: true });
			assert.strictEqual(r.success, true);
			assert.strictEqual(r.open_deals_total, 60);
			assert.ok(Array.isArray(r.closest_to_take_profit) && r.closest_to_take_profit.length === 25,
				'the per-deal list is present and capped for size');
			assert.ok(r.biggest_gain && r.biggest_loss, 'the authoritative single extremes cover all deals');
			// The next-safety-order capability formerly carried only by the removed `deals` rows is preserved.
			const anyNextSo = r.closest_to_take_profit.some(d => 'pctToNextSafetyOrder' in d && 'nextSafetyOrderReady' in d);
			assert.ok(anyNextSo, 'closest_to_take_profit carries the next-safety-order distance fields');
		});
	}
	finally {
		shareData.DCABot.getDeals       = savedGetDeals;
		shareData.DCABot.getDealTracker = savedTracker;
	}

	console.log('\n' + passed + ' checks passed');
})();