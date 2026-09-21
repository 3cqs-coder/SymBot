'use strict';

// Pins the signal->trade seam in the 3CQS client's BOT_START loop (libs/signals/3CQS/3cqs-signals-client.js).
// A single 3CQS BOT_START matches EVERY active bot subscribed to that condition on the pair (the startConditions
// query is array-contains), and each matched bot carries its own extra sub-conditions. A bot that fails its
// sub-conditions must be SKIPPED (continue) — not abort the whole signal (return), which would silently suppress
// the deal start for every later-matched bot (an order-dependent missed entry). This drives the real processSignal
// loop with two matched bots where the FIRST fails its sub-condition, and asserts the SECOND still starts its deal.
//
// The client captures its Mongoose model into a module const at load, so we patch the schema module's export in
// the require cache BEFORE requiring the client; everything else is injected via init(shareData).

const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..', '..', '..', '..');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function eq(a, b, m) { assert.strictEqual(a, b, m + ' (got ' + JSON.stringify(a) + ')'); passed++; }

// Replace the real Signals model with a no-DB fake whose save() succeeds (so updateDb treats every (bot, signal)
// as new and the loop proceeds to evaluate sub-conditions). Patch the cached module BEFORE requiring the client.
const schemaMod = require(root + '/libs/mongodb/Signals3CQSSchema');
function FakeSignals(doc) { this._doc = doc; }
FakeSignals.prototype.save = async function() { return true; };
schemaMod.Signals3CQSSchema = FakeSignals;

const client = require(root + '/libs/signals/3CQS/3cqs-signals-client.js');
const signalsJson = require(root + '/libs/signals/3CQS/signals.json');
const providerId = signalsJson['metadata']['provider_id'];

(async () => {

	const started = [];   // botIds we observed a start_deal fetch for

	const nameId = 'demo-signal';
	const baseCondition = 'signal|' + providerId + '|' + nameId;

	// bot A: has an extra sub-condition on sym_score that will FAIL for this signal.
	const botA = {
		botId: 'botA',
		botName: 'Bot A',
		config: { pair: ['BTC/USDT'], startConditions: [baseCondition, 'x|y|sym_score|>|100'] }
	};

	// bot B: only the base condition (no extra sub-conditions), so it must always start.
	const botB = {
		botId: 'botB',
		botName: 'Bot B',
		config: { pair: ['BTC/USDT'], startConditions: [baseCondition] }
	};

	client.init({
		appData: {
			system_pause: '',
			web_server_port: 3010,
			internal_signals_key: 'test-key',
			api_token: 'test-token',
			telegram_id: ''
		},
		DCABot: {
			// Order matters: the FAILING bot is first, so a `return` would suppress botB.
			getBots: async () => [botA, botB]
		},
		Common: {
			fetchURL: async (opts) => {
				const m = String(opts.url).match(/\/bots\/([^/]+)\/start_deal$/);
				if (m) { started.push(m[1]); }
				return { success: true, data: { success: true } };
			},
			logger: () => {},
			sendNotification: () => {}
		}
	});

	const data = {
		symbol: 'BTC',
		created: new Date().toISOString(),   // fresh, so diffSec < 5 min
		signal: 'BOT_START',
		signal_id: 'sig-1',
		signal_name_id: nameId,
		sym_score: 50   // 50 > 100 is false → botA's sub-condition FAILS
	};

	await client.processSignal(data);

	// The core regression assertion: botB must still start even though botA (earlier in the list) failed its
	// sub-condition. Before the fix (return instead of continue), started would be empty.
	ok(started.indexOf('botB') !== -1, 'a later-matched bot still starts its deal when an earlier bot fails its sub-condition');
	ok(started.indexOf('botA') === -1, 'the bot that failed its own sub-condition does NOT start a deal');
	eq(started.length, 1, 'exactly one deal start fired (only the qualifying bot)');

	console.log('signalMultiBotDispatch: ' + passed + ' assertions passed');
	process.exit(0);
})().catch((e) => { console.error('signalMultiBotDispatch test error:', e && e.stack || e); process.exit(1); });
