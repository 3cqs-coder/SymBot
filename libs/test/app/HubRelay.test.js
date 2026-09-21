'use strict';

// Integration test for the Hub email relay — the full chain with no worker threads and no
// SMTP:
//
//   instance Mailer (relay mode)  --SEND_EMAIL-->  real Main.js worker-message handler
//        -->  Hub Mailer.send
//
// The instance's parent_port is stubbed to hand the posted message straight to the real
// Main.processWorkerMessage handler, and the Hub's Mailer is a stub that records what it was
// asked to send. This proves the relay wiring end to end: an instance with no SMTP of its own
// hands the email to the Hub, and the Hub sends it.

const assert = require('assert');

const Main = require('../../app/Hub/Main.js');
const Mailer = require('../../app/Mailer.js');

let passed = 0;
let failed = 0;

async function testAsync(name, fn) {

	try { await fn(); console.log('  ✓ ' + name); passed++; }
	catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); failed++; }
}


(async () => {

	console.log('\nHub relay — instance → Hub → send:');

	await testAsync('an instance with no SMTP relays the email and the Hub sends it', async () => {

		// The Hub side: a stub Mailer that records sends, wired into the real Main handler.
		const hubSent = [];
		const hubShare = {
			Mailer: { ready: true, send: (msg) => { hubSent.push(msg); return { sent: true }; } },
			Hub: { logger: () => {} },
			workerMap: new Map()
		};

		Main.init(null, hubShare, () => {});

		const handler = Main.processWorkerMessage(1, 'instance-A');

		// The instance side: a real Mailer in relay mode. Its parent_port delivers whatever it
		// posts directly into the Hub's real message handler.
		const instShare = {
			// The Hub-worker channel lives on appData.parent_port (the production path); the mailer resolves
			// the relay mode through Common.getParentPort(), which reads exactly that.
			appData: { password: 'HASH', mailer: { enabled: false }, parent_port: { postMessage: (m) => handler(m) } },
			Common: { logger: () => {}, makeLogger: () => () => {}, getParentPort: function() { return instShare.appData.parent_port || null; } }
		};

		Mailer.init(instShare);
		const r = await Mailer.configure();

		assert.strictEqual(r.mode, 'relay', 'instance with no SMTP but under a Hub should be in relay mode');

		await Mailer.send({ to: ['ops@example.com'], subject: 'Deal alert', text: 'A deal failed.' });

		assert.strictEqual(hubSent.length, 1, 'the Hub Mailer should have been asked to send exactly one email');
		assert.deepStrictEqual(hubSent[0].to, ['ops@example.com']);
		assert.strictEqual(hubSent[0].subject, 'Deal alert');
		assert.strictEqual(hubSent[0].text, 'A deal failed.');
	});

	await testAsync('a relayed email with no Hub mailer configured is logged, not thrown', async () => {

		const logs = [];
		const hubShare = {
			Mailer: { ready: false, send: () => { throw new Error('should not be called'); } },
			Hub: { logger: (lvl, msg) => logs.push(msg) },
			workerMap: new Map()
		};

		Main.init(null, hubShare, () => {});

		const handler = Main.processWorkerMessage(2, 'instance-B');

		// Deliver a SEND_EMAIL message directly; the handler must skip (mailer not ready) and log.
		assert.doesNotThrow(() => handler({ type: 'send_email', payload: { to: ['x@y.com'], text: 'hi' } }));
		assert.ok(logs.some(l => /no SMTP configured/.test(l)), 'should log that the Hub has no SMTP');
	});

	console.log('\n' + passed + ' passed, ' + failed + ' failed');
	process.exit(failed ? 1 : 0);
})();
