'use strict';

// Tests the pure DealCsv module: deal-level summary CSV (one row per closed deal). Verifies that
// profit KEEPS its sign (unlike the tax TransactionExport), that durations and dates render, and
// that CSV escaping/headers are correct.

const assert = require('assert');
const DealCsv = require('../../../strategies/DCABot/DealCsv.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function eq(a, b, m) { assert.strictEqual(a, b, m); passed++; }

// ── signedNum ────────────────────────────────────────────────────────────────
eq(DealCsv.signedNum(12.5), '12.5', 'positive passes through');
eq(DealCsv.signedNum(-3.25), '-3.25', 'NEGATIVE keeps its sign (the whole point vs the tax export)');
eq(DealCsv.signedNum(0), '0', 'zero renders as 0');
eq(DealCsv.signedNum(null), '', 'null → blank');
eq(DealCsv.signedNum(undefined), '', 'undefined → blank');
eq(DealCsv.signedNum(''), '', 'empty string → blank');
eq(DealCsv.signedNum('not-a-number'), '', 'non-numeric → blank');
eq(DealCsv.signedNum(1.230000, 8), '1.23', 'trailing zeros trimmed');
eq(DealCsv.signedNum(-0.0000000001, 2), '0', 'a tiny negative that rounds to 0 is not "-0"');
eq(DealCsv.signedNum(7.126, 2), '7.13', 'rounds to requested decimals');

// ── durationHours ──────────────────────────────────────────────────────────
eq(DealCsv.durationHours(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T06:00:00Z')), '6.0', '6-hour span');
eq(DealCsv.durationHours('2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'), '24.0', 'accepts string dates');
eq(DealCsv.durationHours(new Date('2026-01-02T00:00:00Z'), new Date('2026-01-01T00:00:00Z')), '', 'negative span → blank (never negative duration)');
eq(DealCsv.durationHours(null, new Date()), '', 'missing start → blank');

// ── dealToRow ────────────────────────────────────────────────────────────────
const winRow = DealCsv.dealToRow({
	deal_id: 'D-1', bot_name: 'My Bot', pair: 'BTC/USD',
	date_start: new Date('2026-01-01T00:00:00Z'), date_end: new Date('2026-01-01T12:00:00Z'),
	price: 42000.5, profit: 15.25, profit_base: 0.0003, profit_percent: 1.5,
	profit_currency: 'quote', safety_orders: 2, mood: 'confident', note: 'good one'
});
eq(winRow['Deal ID'], 'D-1', 'deal id mapped');
eq(winRow['Bot'], 'My Bot', 'bot name mapped');
eq(winRow['Duration (hours)'], '12.0', 'duration computed');
eq(winRow['Safety Orders'], '2', 'safety orders mapped as string');
eq(winRow['Profit'], '15.25', 'profit mapped');
eq(winRow['Profit %'], '1.5', 'profit percent mapped');
eq(winRow['Mood'], 'confident', 'mood mapped');
eq(winRow['Note'], 'good one', 'note mapped');
ok(/^2026-01-01T00:00:00Z$/.test(winRow['Opened (UTC)']), 'opened rendered as ISO UTC');

const lossRow = DealCsv.dealToRow({ deal_id: 'D-2', profit: -8.4, profit_percent: -2.1, safety_orders: 0 });
eq(lossRow['Profit'], '-8.4', 'a losing deal reports a NEGATIVE profit');
eq(lossRow['Profit %'], '-2.1', 'a losing deal reports a negative percent');
eq(lossRow['Safety Orders'], '0', 'zero safety orders renders as "0", not blank');
eq(lossRow['Note'], '', 'missing note → blank');

// ── buildCsv ────────────────────────────────────────────────────────────────
const csv = DealCsv.buildCsv([
	{ deal_id: 'D-1', bot_name: 'Bot, Inc', pair: 'ETH/USD', date_start: new Date('2026-02-01T00:00:00Z'), date_end: new Date('2026-02-01T01:30:00Z'), price: 3000, profit: 5, profit_percent: 0.5, safety_orders: 1, note: 'has "quotes" and, comma' }
]);
const lines = csv.split('\r\n');
eq(lines[0], DealCsv.HEADERS.map(h => '"' + h + '"').join(','), 'header row is quoted and in order');
ok(/"Bot, Inc"/.test(lines[1]), 'a value containing a comma stays one quoted field');
ok(/"has ""quotes"" and, comma"/.test(lines[1]), 'embedded quotes are doubled (RFC-4180)');
eq(DealCsv.buildCsv([]).split('\r\n')[0], DealCsv.HEADERS.map(h => '"' + h + '"').join(','), 'empty input still emits the header');

console.log('DealCsv: ' + passed + ' assertions passed');
