'use strict';

// Tests the derived analytics added to Common.computeDealSetStats (profit factor, expectancy,
// avg win/loss, max drawdown), plus that the existing fields are unchanged.

const assert = require('assert');
const Common = require('../../app/Common.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// Deals in close-date order; profits: +10, -4, +6, -12, +8  => cumulative 10,6,12,0,8
const deals = [
	{ profit: 10, date_end: '2026-08-01T00:00:00Z', safety_orders: 1 },
	{ profit: -4, date_end: '2026-08-02T00:00:00Z', safety_orders: 3 },
	{ profit: 6,  date_end: '2026-08-03T00:00:00Z', safety_orders: 0 },
	{ profit: -12, date_end: '2026-08-04T00:00:00Z', safety_orders: 5 },
	{ profit: 8,  date_end: '2026-08-05T00:00:00Z', safety_orders: 2 }
];

const s = Common.computeDealSetStats(deals);

// existing fields intact
ok(s.total === 5, 'total');
ok(s.wins === 3 && s.losses === 2, 'wins/losses');
ok(s.total_profit === 8, 'total_profit = 10-4+6-12+8 = 8');

// gross
ok(s.gross_profit === 24, 'gross_profit = 10+6+8 = 24');
ok(s.gross_loss === 16, 'gross_loss = 4+12 = 16');

// profit factor = 24/16 = 1.5
ok(s.profit_factor === 1.5, 'profit_factor 1.5');

// expectancy = total_profit/total = 8/5 = 1.6
ok(s.expectancy === 1.6, 'expectancy 1.6');

// avg win = 24/3 = 8 ; avg loss = 16/2 = 8
ok(s.avg_win === 8, 'avg_win 8');
ok(s.avg_loss === 8, 'avg_loss 8');

// max drawdown: cumulative peaks at 12 (after deal 3), then drops to 0 (after deal 4) => drawdown 12
ok(s.max_drawdown === 12, 'max_drawdown 12 (peak 12 → trough 0)');

// edge cases
const allWins = Common.computeDealSetStats([{ profit: 5, date_end: '2026-08-01T00:00:00Z' }, { profit: 3, date_end: '2026-08-02T00:00:00Z' }]);
ok(allWins.profit_factor === null, 'profit_factor is null with no losses');
ok(allWins.max_drawdown === 0, 'no drawdown when only gains');

const empty = Common.computeDealSetStats([]);
ok(empty.total === 0 && empty.expectancy === 0 && empty.max_drawdown === 0, 'empty set is all-zero, no throw');

// ── Break-even deals (profit === 0) are their own bucket, NOT losses ──────────────────────────────
// A 0-profit deal is a real break-even outcome, not a loss. It must not inflate the loss count or halve
// avg_loss (which happened when losses was computed as total - wins).
const be = Common.computeDealSetStats([
	{ profit: -10, date_end: '2026-08-01T00:00:00Z' },
	{ profit: 0,   date_end: '2026-08-02T00:00:00Z' },
	{ profit: 5,   date_end: '2026-08-03T00:00:00Z' }
]);
ok(be.total === 3, 'break-even set: total counts every deal');
ok(be.wins === 1, 'break-even set: exactly one win (profit > 0)');
ok(be.break_even === 1, 'break-even set: the profit===0 deal is its own bucket');
ok(be.losses === 1, 'break-even set: losses counts ONLY profit < 0 (not total - wins)');
ok(be.avg_loss === 10, 'break-even set: avg_loss = grossLoss / (profit<0 count) = 10/1, not halved by the break-even');
ok(be.avg_win === 5, 'break-even set: avg_win over winners only');
ok(be.wins + be.losses + be.break_even === be.total, 'wins + losses + break_even accounts for every deal');

const loneBe = Common.computeDealSetStats([{ profit: 0, date_end: '2026-08-01T00:00:00Z' }]);
ok(loneBe.losses === 0 && loneBe.break_even === 1, 'a single break-even deal is not counted as a loss');

console.log('DealSetStats: ' + passed + ' assertions passed');
