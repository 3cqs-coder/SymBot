'use strict';

/**
 * Unit tests for the Signal Bot pure helpers (signalBot.js).
 *
 * Run standalone (no framework, no DB, no exchange needed):
 *     node libs/strategies/DCABot/signalBot.test.js
 *
 * Exits 0 if every assertion passes, 1 otherwise. Covers all three helpers:
 * the alert generator, the graceful-close guard (both directions + fail-safe),
 * and the auto-reopen gate (api blocks; asap/signal do not).
 */

const assert = require('assert');
const {
	buildSignalAlerts, TOKEN_PLACEHOLDER, TICKER_PLACEHOLDER,
	evaluateGracefulClose,
	isApiStart,
	resolveConfiguredPair
} = require('../../../strategies/DCABot/signalBot.js');

let passed = 0;

function test(name, fn) {

	try {

		fn();
		passed++;
		console.log('  ok   - ' + name);
	}
	catch (e) {

		console.error('  FAIL - ' + name);
		console.error('         ' + e.message);
		process.exitCode = 1;
	}
}

function byCommand(result, command) {

	return result.commands.find((c) => c.command === command);
}


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nAlert generator (buildSignalAlerts):');

test('produces exactly the four commands in order', () => {
	const r = buildSignalAlerts({ botId: 'abc123' });
	assert.deepStrictEqual(r.commands.map((c) => c.command), ['entry', 'add_funds', 'close', 'panic_sell']);
});

test('paths target the bot by id on the webhook passthrough', () => {
	const r = buildSignalAlerts({ botId: 'abc123' });
	assert.strictEqual(byCommand(r, 'entry').path, '/webhook/api/bots/abc123/start_deal');
	assert.strictEqual(byCommand(r, 'add_funds').path, '/webhook/api/bots/abc123/add_funds');
	assert.strictEqual(byCommand(r, 'close').path, '/webhook/api/bots/abc123/close');
	assert.strictEqual(byCommand(r, 'panic_sell').path, '/webhook/api/bots/abc123/panic_sell');
});

test('close and panic_sell are distinct endpoints', () => {
	const r = buildSignalAlerts({ botId: 'abc123' });
	assert.notStrictEqual(byCommand(r, 'close').path, byCommand(r, 'panic_sell').path);
});

test('baseUrl is prepended and trailing slashes trimmed', () => {
	const r = buildSignalAlerts({ botId: 'b1', baseUrl: 'https://my.symbot.example/' });
	assert.strictEqual(byCommand(r, 'entry').url, 'https://my.symbot.example/webhook/api/bots/b1/start_deal');
});

test('omitting baseUrl leaves url as the relative path', () => {
	const r = buildSignalAlerts({ botId: 'b1' });
	assert.strictEqual(byCommand(r, 'entry').url, '/webhook/api/bots/b1/start_deal');
});

test('token defaults to the placeholder', () => {
	const r = buildSignalAlerts({ botId: 'b1' });
	assert.strictEqual(r.token_is_placeholder, true);
	assert.strictEqual(byCommand(r, 'entry').body_multi.apiToken, TOKEN_PLACEHOLDER);
});

test('explicit token is embedded and flagged as not-placeholder', () => {
	const r = buildSignalAlerts({ botId: 'b1', token: 'secret-token' });
	assert.strictEqual(r.token_is_placeholder, false);
	assert.strictEqual(byCommand(r, 'close').body_multi.apiToken, 'secret-token');
});

test('multi-pair variant carries {{ticker}}; single-pair omits pair', () => {
	const r = buildSignalAlerts({ botId: 'b1' });
	const entry = byCommand(r, 'entry');
	assert.strictEqual(entry.body_multi.pair, TICKER_PLACEHOLDER);
	assert.ok(!('pair' in entry.body_single), 'single-pair body must not include pair');
});

test('add_funds carries a volume (default 20) in both variants', () => {
	const r = buildSignalAlerts({ botId: 'b1' });
	const add = byCommand(r, 'add_funds');
	assert.strictEqual(add.body_multi.volume, 20);
	assert.strictEqual(add.body_single.volume, 20);
});

test('custom add_funds volume is honored; invalid falls back to 20', () => {
	assert.strictEqual(byCommand(buildSignalAlerts({ botId: 'b1', addFundsVolume: 55 }), 'add_funds').body_multi.volume, 55);
	assert.strictEqual(byCommand(buildSignalAlerts({ botId: 'b1', addFundsVolume: -3 }), 'add_funds').body_multi.volume, 20);
	assert.strictEqual(byCommand(buildSignalAlerts({ botId: 'b1', addFundsVolume: 'x' }), 'add_funds').body_multi.volume, 20);
});

test('non-add commands do not carry a volume', () => {
	const r = buildSignalAlerts({ botId: 'b1' });
	assert.ok(!('volume' in byCommand(r, 'entry').body_multi));
	assert.ok(!('volume' in byCommand(r, 'close').body_multi));
	assert.ok(!('volume' in byCommand(r, 'panic_sell').body_multi));
});

test('json output is pretty-printed and parses back to the body', () => {
	const r = buildSignalAlerts({ botId: 'b1' });
	const add = byCommand(r, 'add_funds');
	assert.ok(add.json_multi.indexOf('\n') > -1, 'expected multi-line JSON');
	assert.deepStrictEqual(JSON.parse(add.json_multi), add.body_multi);
	assert.deepStrictEqual(JSON.parse(add.json_single), add.body_single);
});

test('apiToken is the first key in the generated JSON', () => {
	const r = buildSignalAlerts({ botId: 'b1' });
	assert.ok(byCommand(r, 'entry').json_multi.trimStart().startsWith('{\n  "apiToken"'));
});

test('missing botId throws', () => {
	assert.throws(() => buildSignalAlerts({}), /botId is required/);
	assert.throws(() => buildSignalAlerts({ botId: '   ' }), /botId is required/);
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nGraceful-close guard (evaluateGracefulClose):');

test('price above target -> ready (close)', () => {
	const r = evaluateGracefulClose({ price_last: 105, price_target: 100 });
	assert.strictEqual(r.ready, true);
	assert.strictEqual(r.reason, 'target_met');
});

test('price exactly at target -> ready (boundary, inclusive)', () => {
	const r = evaluateGracefulClose({ price_last: 100, price_target: 100 });
	assert.strictEqual(r.ready, true);
});

test('tiny fractional price at/above target -> ready', () => {
	assert.strictEqual(evaluateGracefulClose({ price_last: 0.00031, price_target: 0.00030 }).ready, true);
});

test('price below target -> not ready (no-op)', () => {
	const r = evaluateGracefulClose({ price_last: 99.99, price_target: 100 });
	assert.strictEqual(r.ready, false);
	assert.strictEqual(r.reason, 'target_not_met');
});

test('price well below target -> not ready', () => {
	assert.strictEqual(evaluateGracefulClose({ price_last: 42, price_target: 100 }).ready, false);
});

test('missing live price -> not ready (fail safe)', () => {
	const r = evaluateGracefulClose({ price_last: undefined, price_target: 100 });
	assert.strictEqual(r.ready, false);
	assert.strictEqual(r.reason, 'no_live_price');
});

test('missing target -> not ready (fail safe)', () => {
	assert.strictEqual(evaluateGracefulClose({ price_last: 100, price_target: null }).reason, 'no_live_price');
});

test('zero price -> not ready (fail safe)', () => {
	assert.strictEqual(evaluateGracefulClose({ price_last: 0, price_target: 100 }).reason, 'no_live_price');
});

test('non-numeric garbage -> not ready (fail safe)', () => {
	assert.strictEqual(evaluateGracefulClose({ price_last: 'abc', price_target: 100 }).ready, false);
});

test('empty / undefined input -> not ready (fail safe)', () => {
	assert.strictEqual(evaluateGracefulClose({}).ready, false);
	assert.strictEqual(evaluateGracefulClose(undefined).ready, false);
});

test('extra force-like fields cannot override a below-target result', () => {
	const r = evaluateGracefulClose({ price_last: 50, price_target: 100, force: true, unconditional: true, close_all: true });
	assert.strictEqual(r.ready, false);
});

test('string-numeric price/target are coerced correctly', () => {
	assert.strictEqual(evaluateGracefulClose({ price_last: '105', price_target: '100' }).ready, true);
	assert.strictEqual(evaluateGracefulClose({ price_last: '95', price_target: '100' }).ready, false);
});


// ─────────────────────────────────────────────────────────────────────────────
console.log('\nStart-condition predicate / auto-reopen gate (isApiStart):');

test('startConditions ["api"] -> true', () => {
	assert.strictEqual(isApiStart(['api']), true);
});

test('bare string "api" -> true', () => {
	assert.strictEqual(isApiStart('api'), true);
});

test('case/space-insensitive " API " -> true', () => {
	assert.strictEqual(isApiStart([' API ']), true);
});

test('startConditions ["asap"] -> false', () => {
	assert.strictEqual(isApiStart(['asap']), false);
});

test('3CQS provider "signal|3CQS|62" -> false', () => {
	assert.strictEqual(isApiStart(['signal|3CQS|62']), false);
});

test('any signal|... provider -> false', () => {
	assert.strictEqual(isApiStart(['signal|SomeProvider|1']), false);
});

test('primary asap with extra sub-conditions -> false', () => {
	assert.strictEqual(isApiStart(['asap', 'signalsub|x|1|>=|5']), false);
});

test('primary api with extra entries -> true', () => {
	assert.strictEqual(isApiStart(['api', 'whatever']), true);
});

test('empty array / undefined / null / "" -> false', () => {
	assert.strictEqual(isApiStart([]), false);
	assert.strictEqual(isApiStart(undefined), false);
	assert.strictEqual(isApiStart(null), false);
	assert.strictEqual(isApiStart(''), false);
});


// ── Inbound-ticker resolution (resolveConfiguredPair) ─────────────────────────
// A signal source may send a symbol in its own format ("BTCUSD", "COINBASE:BTC-USD"); this maps it
// back to the bot's exact configured pair. Exact match must be unchanged; a fuzzy match must be unique
// or it returns null so the caller rejects rather than guessing.
console.log('\nInbound-ticker resolution (resolveConfiguredPair):');

const CFG = ['BTC/USD', 'ETH/USD', 'BTC/USDT', '1INCH/USD', 'ETH/BTC'];

test('exact match is unchanged (any casing)', () => {
	assert.strictEqual(resolveConfiguredPair('BTC/USD', CFG), 'BTC/USD');
	assert.strictEqual(resolveConfiguredPair('btc/usd', CFG), 'BTC/USD');
});

test('TradingView {{ticker}} forms resolve to the configured pair', () => {
	assert.strictEqual(resolveConfiguredPair('BTCUSD', CFG), 'BTC/USD');
	assert.strictEqual(resolveConfiguredPair('COINBASE:BTCUSD', CFG), 'BTC/USD');
	assert.strictEqual(resolveConfiguredPair('BTC-USD', CFG), 'BTC/USD');
	assert.strictEqual(resolveConfiguredPair('BTC_USD', CFG), 'BTC/USD');
	assert.strictEqual(resolveConfiguredPair('COINBASE:BTC-USD', CFG), 'BTC/USD');
});

test('near-collision USD vs USDT stays correct', () => {
	assert.strictEqual(resolveConfiguredPair('BTCUSDT', CFG), 'BTC/USDT');
	assert.strictEqual(resolveConfiguredPair('BTCUSD', CFG), 'BTC/USD');
	assert.strictEqual(resolveConfiguredPair('ETHBTC', CFG), 'ETH/BTC');
	assert.strictEqual(resolveConfiguredPair('1INCHUSD', CFG), '1INCH/USD');
});

test('unknown, empty, no-config and non-string inputs return null', () => {
	assert.strictEqual(resolveConfiguredPair('DOGEUSD', CFG), null);
	assert.strictEqual(resolveConfiguredPair('', CFG), null);
	assert.strictEqual(resolveConfiguredPair('BTC/USD', []), null);
	assert.strictEqual(resolveConfiguredPair(null, CFG), null);
	assert.strictEqual(resolveConfiguredPair({ '$ne': null }, CFG), null);
});

test('ambiguous compact match returns null (never guesses)', () => {
	assert.strictEqual(resolveConfiguredPair('BTCUSD', ['BTC/USD', 'BT/CUSD']), null);
});


console.log('\n' + passed + ' assertions passed' + (process.exitCode ? ' (with failures above)' : ', all green'));
