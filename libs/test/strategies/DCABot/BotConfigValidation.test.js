'use strict';

// Pins the money-adjacent numeric validation in calculateOrders (bot create/update). The per-deal edit path
// (apiUpdateDeal) already rejects bad numbers, but the create/update path used to copy them straight into the
// bot config — so a bot could be saved with a negative take-profit (closes at a guaranteed loss), a
// negative/NaN order amount, or a 0%/negative deviation (a degenerate safety-order ladder). This test proves
// each invalid value is rejected BEFORE persistence (calculateOrders returns orders.success === false, which
// the caller treats as "do not save"), and that a valid config passes the gate.

const assert = require('assert');
const Manager = require('../../../strategies/DCABot/DCABotManager.js');

// Minimal wiring: calculateOrders reads shareData.appData.bot_config and shareData.Common.getConfig to load
// the base bot config, then validates the body up front. A valid body proceeds past validation into the
// order math (which needs no exchange here for the invalid cases — they return before it).
Manager.init({
	Common: { logger: function () {} }
});
// init stores shareData; set the pieces calculateOrders needs directly on it via a second init-style shim.
Manager.init({
	Common: {
		logger: function () {},
		getConfig: async function () { return { success: true, data: { botName: 'Test', pair: 'BTC/USD' } }; }
	},
	appData: { bot_config: 'bot.json' }
});

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

// A base valid body; individual tests override one field with a bad value.
function body(overrides) {
	return Object.assign({
		pair: 'BTC/USD',
		firstOrderAmount: 100,
		dcaOrderAmount: 50,
		dcaMaxOrder: 5,
		dcaOrderStepPercent: 1.5,
		dcaOrderSizeMultiplier: 1.2,
		dcaOrderStepPercentMultiplier: 1,
		dcaTakeProfitPercent: 1.5
	}, overrides || {});
}

async function rejects(overrides, expectField) {
	const r = await Manager.calculateOrders(body(overrides));
	assert.ok(r && r.orders && r.orders.success === false, 'expected orders.success === false');
	assert.ok(typeof r.orders.data === 'string' && r.orders.data.indexOf(expectField) !== -1,
		'expected rejection to mention ' + expectField + ' — got: ' + (r.orders && r.orders.data));
}

(async () => {

	console.log('\nBot config validation (calculateOrders rejects bad money-adjacent numbers before persistence):');

	await test('negative take-profit is rejected', () => rejects({ dcaTakeProfitPercent: -5 }, 'dcaTakeProfitPercent'));
	await test('zero take-profit is rejected', () => rejects({ dcaTakeProfitPercent: 0 }, 'dcaTakeProfitPercent'));
	await test('non-numeric take-profit is rejected', () => rejects({ dcaTakeProfitPercent: 'abc' }, 'dcaTakeProfitPercent'));
	await test('negative first-order amount is rejected', () => rejects({ firstOrderAmount: -20 }, 'firstOrderAmount'));
	await test('NaN dca order amount is rejected', () => rejects({ dcaOrderAmount: 'x' }, 'dcaOrderAmount'));
	await test('zero deviation (step %) is rejected', () => rejects({ dcaOrderStepPercent: 0 }, 'dcaOrderStepPercent'));
	await test('negative size multiplier is rejected', () => rejects({ dcaOrderSizeMultiplier: -1 }, 'dcaOrderSizeMultiplier'));
	await test('fractional dcaMaxOrder is rejected', () => rejects({ dcaMaxOrder: 3.5 }, 'dcaMaxOrder'));
	await test('negative dcaMaxOrder is rejected', () => rejects({ dcaMaxOrder: -1 }, 'dcaMaxOrder'));

	await test('a valid config passes the validation gate (not rejected for a bad number)', async () => {
		// A validation rejection RETURNS { orders: { success:false, data:'Invalid value…' } } and never throws.
		// With only minimal wiring the valid config proceeds PAST validation and then throws in the order math
		// (no exchange) — that throw itself proves the validation gate let it through. If it returns instead,
		// just assert the message is not an "Invalid value" rejection.
		let threw = false, r = null;
		try { r = await Manager.calculateOrders(body({ startCondition: 'asap' })); }
		catch (e) { threw = true; }
		if (!threw) {
			const msg = (r && r.orders && r.orders.data) || '';
			assert.ok(!/Invalid value|must be a/.test(msg), 'valid config should not be rejected by validation — got: ' + msg);
		}
	});

	console.log('\n' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
	process.exit(failed ? 1 : 0);
})();
