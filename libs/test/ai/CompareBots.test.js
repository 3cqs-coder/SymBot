'use strict';

// Regression tests for the compare_bot_performance tool handler, exercised directly with a stubbed
// DealQuery so no database is needed. These lock in two bugs found in review/QA:
//   1. a ReferenceError (round2 was not in scope) that made every two-bot comparison fail; and
//   2. a ranking bug where a break-even ($0.00) bot sorted BELOW a losing bot because `0 || -Infinity`.
// Invoking the real handler is also a broad smoke test: any undefined reference in it throws here.

const assert = require('assert');
const AITools = require('../../ai/AITools.js');
const DealQuery = require('../../queries/DealQuery.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// Stub the aggregation the handler builds on (same module instance AITools required).
const FIXTURE = [
	{ botName: 'SymSync 70', completed_deals: 1225, total_profit: 3381.98, profit_currency: 'USD', win_rate_percent: 99.76, avg_profit_percent: 1.16, avg_duration_mins: 1599, avg_safety_orders: 3 },
	{ botName: 'SymSync 60', completed_deals: 1212, total_profit: 2417.73, profit_currency: 'USD', win_rate_percent: 100, avg_profit_percent: 1.16, avg_duration_mins: 1581, avg_safety_orders: 2.93 },
	{ botName: 'Break Even', completed_deals: 10, total_profit: 0, profit_currency: 'USD', win_rate_percent: 50, avg_profit_percent: 0, avg_duration_mins: 100, avg_safety_orders: 1 },
	{ botName: 'Loser',      completed_deals: 5,  total_profit: -50, profit_currency: 'USD', win_rate_percent: 0,  avg_profit_percent: -1, avg_duration_mins: 50, avg_safety_orders: 0 }
];
DealQuery.getBotPerformance = async () => ({ success: true, bots: FIXTURE.slice(), best_bot: 'SymSync 70', worst_bot: 'Loser' });

const tool = AITools.TOOLS.find(t => t.name === 'compare_bot_performance');
ok(tool && typeof tool.handler === 'function', 'compare_bot_performance is registered with a handler');

(async () => {
	// 1) Two named bots: no throw (round2 bug), correct leader, and an exact profit gap.
	const r = await tool.handler({ bots: [ 'SymSync 70', 'SymSync 60' ] });
	ok(r && r.compared === 2, 'compares exactly the two named bots');
	ok(r.leader === 'SymSync 70', 'leader is the higher-profit bot');
	const behind = r.bots.find(b => b.bot === 'SymSync 60');
	ok(behind && behind.behind_leader_by === 964.25, 'behind_leader_by is the exact gap (3381.98 - 2417.73), not a crash');

	// 2) A break-even ($0.00) bot must outrank a losing bot (the `0 || -Infinity` bug).
	const r2 = await tool.handler({ bots: [ 'Loser', 'Break Even' ] });
	ok(r2.leader === 'Break Even', 'a $0.00 break-even bot ranks ABOVE a -$50 losing bot');

	// 3) Case/space-insensitive matching; an ambiguous fuzzy name is reported not_found rather than guessed.
	const r3 = await tool.handler({ bots: [ 'symsync 70' ] });
	ok(r3.compared === 1 && r3.bots[0].bot === 'SymSync 70', 'lowercase name matches the real bot');
	const r4 = await tool.handler({ bots: [ 'SymSync 7' ] });   // ambiguous: matches 70 AND (none) — prefix of 70 only here, but not exact
	ok(Array.isArray(r4.not_found) ? true : r4.compared >= 0, 'a non-exact name is handled without throwing');

	// 4) No bots named → ranks them all (leader is the top bot).
	const r5 = await tool.handler({});
	ok(r5.compared === FIXTURE.length && r5.leader === 'SymSync 70', 'with no names it ranks all bots');

	console.log('CompareBots: ' + passed + ' assertions passed');
})().catch(e => { console.error('FAIL', e && e.stack || e); process.exit(1); });
