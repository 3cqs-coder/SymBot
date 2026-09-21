'use strict';

// Unit tests for the reusable schedule notifier (libs/app/ScheduleNotifier.js).
//
// No database or network: a stub shareData captures what each channel would send, so we
// assert the routing — legacy-boolean upgrade, the new notifications array, per-target
// `on` conditions, Telegram fan-out to multiple chats, the browser/history reuse of
// Common.sendNotification, and graceful skipping of channels with no sender yet.

const assert = require('assert');
const Notifier = require('../../app/ScheduleNotifier.js');

let passed = 0;
let failed = 0;

function test(name, fn) {

	try { fn(); console.log('  ✓ ' + name); passed++; }
	catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); failed++; }
}

async function testAsync(name, fn) {

	try { await fn(); console.log('  ✓ ' + name); passed++; }
	catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); failed++; }
}

// A fresh stub + capture buffers per test.
function makeStub(opts) {

	opts = opts || {};

	const cap = { notify: [], telegram: [], email: [], webhook: [], logs: [] };

	// Mock global fetch so the webhook channel is testable without a real network. Reset
	// on every stub so each test starts clean.
	global.fetch = function(url, options) { cap.webhook.push({ url: url, options: options }); return Promise.resolve({ ok: true, status: 200 }); };

	const shareData = {
		appData: { telegram_id: opts.telegramId === undefined ? 'GID' : opts.telegramId },
		Common: {
			logger: (m) => cap.logs.push(m),
			makeLogger: (prefix) => (m) => cap.logs.push((prefix || '') + m),
			sendNotification: async (d) => { cap.notify.push(d); }
		},
		Telegram: { sendMessage: (id, msg) => cap.telegram.push({ id, msg }) }
	};

	// The Mailer resolves its own delivery mode (own SMTP or relay to the Hub) and reports
	// `ready`; ScheduleNotifier just uses it when ready. `mailerReady:false` simulates a
	// mailer that cannot deliver (no own SMTP and no Hub) so email should be skipped.
	if (opts.mailer) { shareData.Mailer = { ready: opts.mailerReady !== false, send: (d) => cap.email.push(d) }; }

	Notifier.init(shareData);

	return cap;
}

// Flush pending microtasks/timers so the fire-and-forget webhook fetch has run before we assert.
function flush() { return new Promise((r) => setTimeout(r, 0)); }


// ── conditionMatches ─────────────────────────────────────────────────────────
console.log('\nScheduleNotifier — conditions:');

test('empty/absent on defaults to always', () => {
	assert.strictEqual(Notifier.conditionMatches([], 'ok'), true);
	assert.strictEqual(Notifier.conditionMatches(undefined, 'error'), true);
});
test('success fires on ok only', () => {
	assert.strictEqual(Notifier.conditionMatches(['success'], 'ok'), true);
	assert.strictEqual(Notifier.conditionMatches(['success'], 'error'), false);
});
test('failure fires on error only', () => {
	assert.strictEqual(Notifier.conditionMatches(['failure'], 'error'), true);
	assert.strictEqual(Notifier.conditionMatches(['failure'], 'ok'), false);
});
test('missed fires on missed only', () => {
	assert.strictEqual(Notifier.conditionMatches(['missed'], 'missed'), true);
	assert.strictEqual(Notifier.conditionMatches(['missed'], 'ok'), false);
});
test('always fires regardless of status', () => {
	assert.strictEqual(Notifier.conditionMatches(['always'], 'error'), true);
});


// ── resolveTargets (legacy booleans) ─────────────────────────────────────────
console.log('\nScheduleNotifier — resolveTargets (legacy):');

test('legacy defaults → browser + telegram(global id)', () => {
	makeStub();
	const t = Notifier.resolveTargets({});
	assert.deepStrictEqual(t.map(x => x.type).sort(), ['browser', 'telegram']);
	const tg = t.find(x => x.type === 'telegram');
	assert.strictEqual(tg.target.chatId, 'GID');
});
test('notify_browser:false drops browser', () => {
	makeStub();
	const t = Notifier.resolveTargets({ notify_browser: false });
	assert.deepStrictEqual(t.map(x => x.type), ['telegram']);
});
test('notify_telegram:false drops telegram', () => {
	makeStub();
	const t = Notifier.resolveTargets({ notify_telegram: false });
	assert.deepStrictEqual(t.map(x => x.type), ['browser']);
});
test('no global telegram id → no telegram target', () => {
	makeStub({ telegramId: '' });
	const t = Notifier.resolveTargets({});
	assert.deepStrictEqual(t.map(x => x.type), ['browser']);
});


// ── resolveTargets (new array) ───────────────────────────────────────────────
console.log('\nScheduleNotifier — resolveTargets (array):');

test('new notifications array wins and normalizes on', () => {
	makeStub();
	const t = Notifier.resolveTargets({ notifications: [
		{ type: 'telegram', target: { chatId: '1' } },
		{ type: 'telegram', target: { chatId: '2' }, on: ['failure'] },
		{ type: 'email', target: { to: ['a@x.com'] }, on: ['success', 'failure'] }
	]});
	assert.strictEqual(t.length, 3);
	assert.deepStrictEqual(t[0].on, ['always']);        // absent on → always
	assert.deepStrictEqual(t[1].on, ['failure']);
	assert.strictEqual(t[2].target.to[0], 'a@x.com');
});
test('array drops entries with no type', () => {
	makeStub();
	const t = Notifier.resolveTargets({ notifications: [ { target: {} }, { type: 'browser' } ] });
	assert.deepStrictEqual(t.map(x => x.type), ['browser']);
});


// ── deliver (fan-out + conditions) ───────────────────────────────────────────
console.log('\nScheduleNotifier — deliver:');

(async () => {

	await testAsync('browser routes through sendNotification with browser=true', async () => {
		const cap = makeStub();
		await Notifier.deliver([{ type: 'browser', target: {}, on: ['always'] }], { message: 'hi', type: 'info', status: 'ok' });
		assert.strictEqual(cap.notify.length, 1);
		assert.strictEqual(cap.notify[0].browser, true);
		assert.strictEqual(cap.notify[0].telegram_id, null);   // never double-sends telegram
	});

	await testAsync('multiple telegram targets each get the message', async () => {
		const cap = makeStub();
		await Notifier.deliver([
			{ type: 'telegram', target: { chatId: '1' }, on: ['always'] },
			{ type: 'telegram', target: { chatId: '2' }, on: ['always'] }
		], { message: 'm', status: 'ok' });
		assert.deepStrictEqual(cap.telegram.map(x => x.id).sort(), ['1', '2']);
		assert.strictEqual(cap.notify[0].browser, false);      // no browser target
	});

	await testAsync('on:[failure] target is skipped on a successful run', async () => {
		const cap = makeStub();
		await Notifier.deliver([{ type: 'telegram', target: { chatId: '9' }, on: ['failure'] }], { message: 'm', status: 'ok' });
		assert.strictEqual(cap.telegram.length, 0);            // did not fire
		assert.strictEqual(cap.notify.length, 1);              // history still written once
	});

	await testAsync('on:[failure] target fires on an error run', async () => {
		const cap = makeStub();
		await Notifier.deliver([{ type: 'telegram', target: { chatId: '9' }, on: ['failure'] }], { message: 'm', status: 'error' });
		assert.strictEqual(cap.telegram.length, 1);
	});

	await testAsync('email with no mailer is skipped gracefully (logged, no throw)', async () => {
		const cap = makeStub();   // no mailer
		await Notifier.deliver([{ type: 'email', target: { to: ['a@x.com'] }, on: ['always'] }], { message: 'm', status: 'ok' });
		assert.strictEqual(cap.email.length, 0);
		assert.ok(cap.logs.some(l => /email target configured but no mailer/.test(l)));
	});

	await testAsync('email with a ready mailer is delivered to the recipients', async () => {
		const cap = makeStub({ mailer: true });
		await Notifier.deliver([{ type: 'email', target: { to: ['a@x.com', 'b@y.com'] }, on: ['always'] }], { message: 'm', status: 'ok' });
		assert.strictEqual(cap.email.length, 1);
		assert.deepStrictEqual(cap.email[0].to, ['a@x.com', 'b@y.com']);
	});

	await testAsync('email with a not-ready mailer is skipped (nothing sent)', async () => {
		const cap = makeStub({ mailer: true, mailerReady: false });
		await Notifier.deliver([{ type: 'email', target: { to: ['a@x.com'] }, on: ['always'] }], { message: 'm', status: 'ok' });
		assert.strictEqual(cap.email.length, 0);
	});

	await testAsync('mixed channels fan out together', async () => {
		const cap = makeStub();
		await Notifier.deliver([
			{ type: 'browser', target: {}, on: ['always'] },
			{ type: 'telegram', target: { chatId: '1' }, on: ['always'] },
			{ type: 'webhook', target: { url: 'http://x' }, on: ['always'] }
		], { message: 'm', status: 'ok' });
		assert.strictEqual(cap.notify[0].browser, true);
		assert.strictEqual(cap.telegram.length, 1);
		await flush();
		assert.strictEqual(cap.webhook.length, 1);
		assert.strictEqual(cap.webhook[0].url, 'http://x');
	});

	await testAsync('telegram target with a blank id falls back to the global id', async () => {
		const cap = makeStub();
		await Notifier.deliver([{ type: 'telegram', target: {}, on: ['always'] }], { message: 'm', status: 'ok' });
		assert.strictEqual(cap.telegram.length, 1);
		assert.strictEqual(cap.telegram[0].id, 'GID');
	});

	await testAsync('telegram blank id with no global id is skipped and logged', async () => {
		const cap = makeStub({ telegramId: '' });
		await Notifier.deliver([{ type: 'telegram', target: {}, on: ['always'] }], { message: 'm', status: 'ok' });
		assert.strictEqual(cap.telegram.length, 0);
		assert.ok(cap.logs.some(l => /no chat id and no global id/.test(l)));
	});

	await testAsync('webhook POSTs the message as JSON to the url', async () => {
		const cap = makeStub();
		await Notifier.deliver([{ type: 'webhook', target: { url: 'http://x/hook' }, on: ['always'] }], { message: 'hello', status: 'ok' });
		await flush();
		assert.strictEqual(cap.webhook.length, 1);
		assert.strictEqual(cap.webhook[0].url, 'http://x/hook');
		assert.strictEqual(cap.webhook[0].options.method, 'POST');
		assert.deepStrictEqual(JSON.parse(cap.webhook[0].options.body), { text: 'hello' });
	});

	await testAsync('webhook with no url is skipped and logged', async () => {
		const cap = makeStub();
		await Notifier.deliver([{ type: 'webhook', target: {}, on: ['always'] }], { message: 'm', status: 'ok' });
		await flush();
		assert.strictEqual(cap.webhook.length, 0);
		assert.ok(cap.logs.some(l => /webhook target has no url/.test(l)));
	});

	// ── notifyFailure (scheduler-owned run-failure notice) ─────────────────────────
	console.log('\nScheduleNotifier — notifyFailure:');

	await testAsync('an errored run notifies a failure target with the label and reason', async () => {
		const cap = makeStub();
		const row = { label: 'Disk Monitor', type: 'resource_sentinel', schedule_id: 's1', settings: { notifications: [ { type: 'browser', on: [ 'failure' ] } ] } };
		await Notifier.notifyFailure(row, 'error', 'Run failed: boom');
		assert.strictEqual(cap.notify.length, 1, 'delivered once');
		assert.ok(/Disk Monitor/.test(cap.notify[0].message) && /failed/.test(cap.notify[0].message), 'message names the task and that it failed');
		assert.ok(/boom/.test(cap.notify[0].message), 'the failure detail is included');
	});

	await testAsync('a TIMED-OUT run reaches a failure target (timed_out counts as failure) and says so', async () => {
		const cap = makeStub();
		const row = { label: 'Slow Job', schedule_id: 's2', settings: { notifications: [ { type: 'browser', on: [ 'failure' ] } ] } };
		await Notifier.notifyFailure(row, 'timed_out', 'exceeded its time limit');
		assert.strictEqual(cap.notify.length, 1, 'a timed-out run still notifies the failure target');
		assert.ok(/timed out/.test(cap.notify[0].message), 'message says it timed out');
	});

	await testAsync('a success-only channel target is NOT delivered on a failure', async () => {
		// Assert routing on a telegram target: unlike the browser/history path (which deliver always logs),
		// a channel sender only fires when the target's `on` condition matches the run status.
		const cap = makeStub();
		const row = { label: 'X', schedule_id: 's3', settings: { notifications: [ { type: 'telegram', target: { chatId: 'C' }, on: [ 'success' ] } ] } };
		await Notifier.notifyFailure(row, 'error', 'nope');
		assert.strictEqual(cap.telegram.length, 0, 'a success-only telegram target stays quiet on failure');
	});

	await testAsync('notifyFailure never throws on a malformed row', async () => {
		const cap = makeStub();
		let threw = false;
		try { await Notifier.notifyFailure(null, 'error', null); } catch (e) { threw = true; }
		assert.strictEqual(threw, false, 'tolerates a null row');
	});

	console.log('\n' + passed + ' passed, ' + failed + ' failed');
	process.exit(failed ? 1 : 0);
})();