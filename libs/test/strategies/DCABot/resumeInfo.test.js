'use strict';

// buildResumeInfo — the NON-LIVE deal-info snapshot the active-deals view (instance + Hub) uses to show a
// just-resumed deal immediately, instead of hiding it for ~30s while the exchange reconnects on a cold
// restart. It must derive everything knowable from the PERSISTED deal (no live price) and leave the
// live-only figures null + flag awaiting_live, so the view renders "updating…" rather than a fabricated
// number. This is a display-path helper — it must never depend on the exchange or trading state.

const assert = require('assert');
const DCABot = require('../../../strategies/DCABot/DCABot.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

const deal = {
	updated: '2026-08-01T00:00:00.000Z',
	pair: 'ATOM/USD',
	pauseReason: '',
	config: { botId: 'b1', botName: 'Bot 1', dealCount: 3, dealMax: 60, pair: 'ATOM/USD' },
	orders: [
		{ filled: 1, average: 1.50, target: 1.57, sum: 50 },
		{ filled: 1, average: 1.48, target: 1.55, sum: 50 },
		{ filled: 1, average: 1.45, target: 1.52, sum: 50 },
		{ filled: 0 }
	]
};

const info = DCABot.buildResumeInfo(deal);

// The row must render: deal_count is a real number (a NaN here makes the view treat the row as a "data
// issue" and hide it — the exact bug being fixed).
ok(typeof info.deal_count === 'number' && !isNaN(info.deal_count), 'deal_count is a real number so the view does not hide the row');
ok(info.deal_count === 3, 'deal_count comes from the persisted config');
ok(info.deal_max === 60, 'deal_max comes from the persisted config');
ok(info.awaiting_live === true, 'the snapshot is flagged awaiting_live so the view shows pending live cells');

// Known-without-a-live-price fields are populated from the persisted orders.
ok(info.safety_orders_used === 2, 'safety_orders_used = filled orders minus the base order');
ok(info.price_average === 1.45, 'price_average is the current (last filled) order average');
ok(info.price_target === 1.52, 'price_target is the current order target');

// Live-only fields stay null — never a stale or fabricated figure.
ok(info.price_last === null, 'price_last is null until the first live tick');
ok(info.profit === null && info.profit_base === null && info.profit_percentage === null && info.profit_quote_projected === null, 'all profit figures are null until live');

// A deal with no filled orders yet must still yield a numeric deal_count (falls back to the filled count).
const empty = DCABot.buildResumeInfo({ config: {}, orders: [] });
ok(typeof empty.deal_count === 'number' && !isNaN(empty.deal_count), 'deal_count falls back to a number even with no config/orders');
ok(empty.awaiting_live === true, 'the fallback snapshot is still flagged awaiting_live');

// A persisted pause reason surfaces immediately (accurate, not live), so a paused deal shows its state.
const paused = DCABot.buildResumeInfo({ pauseReason: 'order_verify_buy', config: { dealCount: 1 }, orders: [ { filled: 1, average: 2, target: 2.1 } ] });
ok(paused.pause === true && paused.pause_reason === 'order_verify_buy', 'a persisted pause reason is reflected in the snapshot');

console.log('resumeInfo: ' + passed + ' assertions passed');
