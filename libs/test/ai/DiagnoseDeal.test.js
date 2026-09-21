'use strict';

// Regression test for the diagnose_deal handler, exercised directly with stubbed data sources. Locks in
// the fix where present-tense OPEN-deal concerns (PAUSED, ladder EXHAUSTED, "waiting for recovery") were
// wrongly reported for already-CLOSED deals — a normal winning deal that used its whole ladder was being
// diagnosed as if it were still stuck open. A closed deal must be diagnosed on its OUTCOME instead.

const assert = require('assert');
const AITools = require('../../ai/AITools.js');
const DealQuery = require('../../queries/DealQuery.js');
const LogScan = require('../../queries/LogScan.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// No log events in these tests — we are testing the deal-record concern logic, not log scanning.
LogScan.getDealEvents = async () => ({ lines: [], truncated: false });

const tool = AITools.TOOLS.find(t => t.name === 'diagnose_deal');
ok(tool && typeof tool.handler === 'function', 'diagnose_deal is registered');

(async () => {
	// A CLOSED, profitable deal that used its ENTIRE ladder — the exact shape that used to be flagged
	// "ladder EXHAUSTED / can only wait for recovery" and paused. It must now read as a clean close.
	DealQuery.getDeal = async () => ({ deals: [ {
		dealId: 'WIN-1', pair: 'OSMO/USD', status: 'complete', profitable: true,
		profitQuote: 42.5, profitPercent: 4.6, profitCurrency: 'USD',
		paused: true, ladderExhausted: true, safetyOrdersUsed: 10, safetyOrdersMax: 10, openForMins: null
	} ], count: 1 });
	const win = await tool.handler({ deal_id: 'WIN-1' });
	ok(!win.concerns.some(c => /EXHAUSTED/i.test(c)), 'a CLOSED winning deal is NOT flagged ladder-exhausted');
	ok(!win.concerns.some(c => /PAUSED/i.test(c)), 'a CLOSED deal is NOT flagged as paused');
	ok(!win.concerns.some(c => /long time/i.test(c)), 'a CLOSED deal is NOT flagged "open for a long time"');
	ok(/CLOSED and finished in profit/i.test(win.assessment), 'assessment states it closed in profit');

	// A CLOSED losing deal is diagnosed on its outcome (the loss), not open-deal state.
	DealQuery.getDeal = async () => ({ deals: [ {
		dealId: 'LOSS-1', pair: 'KERNEL/USD', status: 'complete', profitable: false,
		profitQuote: -120.4, profitPercent: -33, profitCurrency: 'USD',
		paused: false, ladderExhausted: true, safetyOrdersUsed: 60, safetyOrdersMax: 60, openForMins: null
	} ], count: 1 });
	const loss = await tool.handler({ deal_id: 'LOSS-1' });
	ok(loss.concerns.some(c => /CLOSED and finished at a LOSS/i.test(c)), 'a CLOSED losing deal reports the loss as its concern');
	ok(!loss.concerns.some(c => /EXHAUSTED/i.test(c)), 'the losing closed deal is not flagged ladder-exhausted (present tense)');

	// An OPEN paused deal with an exhausted ladder STILL surfaces those live concerns (unchanged behavior).
	DealQuery.getDeal = async () => ({ deals: [ {
		dealId: 'OPEN-1', pair: 'MPLX/USD', status: 'active', profitable: null,
		paused: true, ladderExhausted: true, safetyOrdersUsed: 41, safetyOrdersMax: 41, openForMins: 60 * 24 * 200
	} ], count: 1 });
	const open = await tool.handler({ deal_id: 'OPEN-1' });
	ok(open.concerns.some(c => /PAUSED/i.test(c)), 'an OPEN paused deal is still flagged paused');
	ok(open.concerns.some(c => /EXHAUSTED/i.test(c)), 'an OPEN exhausted-ladder deal is still flagged exhausted');
	ok(open.concerns.some(c => /long time/i.test(c)), 'an OPEN 200-day deal is still flagged as long-open');

	console.log('DiagnoseDeal: ' + passed + ' assertions passed');
})().catch(e => { console.error('FAIL', e && e.stack || e); process.exit(1); });
