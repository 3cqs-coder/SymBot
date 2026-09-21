'use strict';

// Unit tests for the outbound mailer (libs/app/Mailer.js).
//
// No real SMTP or worker threads: nodemailer.createTransport is monkey-patched to a fake
// transport, and the Hub worker channel is a stub that records postMessage calls. We assert
// the behavior that matters — the own/relay/none mode resolution, async non-blocking send in
// each mode, the relay payload handed to the Hub, the enabled/ready/mode getters, and
// testSMTP verifying + sending before anything relies on the settings.

const assert = require('assert');
const nodemailer = require('nodemailer');

let created = [];

const realCreateTransport = nodemailer.createTransport;

nodemailer.createTransport = function(opts) {

	const t = {
		opts: opts,
		sent: [],
		verified: 0,
		failVerify: false,
		failSend: false,
		verify: async function() { this.verified++; if (this.failVerify) { throw new Error('verify failed'); } return true; },
		sendMail: async function(msg) { if (this.failSend) { throw new Error('send failed'); } this.sent.push(msg); return { messageId: 'x' }; }
	};

	created.push(t);

	return t;
};

const Mailer = require('../../app/Mailer.js');
const { WORKER_TO_HUB } = require('../../app/Hub/MessageTypes.js');

let passed = 0;
let failed = 0;

async function testAsync(name, fn) {

	try { await fn(); console.log('  ✓ ' + name); passed++; }
	catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); failed++; }
}

// shareData stub. opts.parentPort adds a Hub worker channel (records postMessage calls).
// System.decrypt returns the stored value prefixed so the decrypt path is observable.
function makeShare(mailerCfg, opts) {

	opts = opts || {};

	const share = {
		appData: { password: 'HASH', mailer: mailerCfg || {} },
		Common: {
			logger: function() {},
			makeLogger: function() { return function() {}; },
			// Mirror the real Common.isEncrypted so the mailer's decrypt path (which only decrypts
			// values in the encrypted-at-rest format) behaves as in production.
			isEncrypted: function(v) { return typeof v === 'string' && /^[0-9a-f]{32}:/i.test(v); },
			// Canonical Hub-worker channel accessor, mirroring the real Common.getParentPort(), which reads
			// shareData.appData.parent_port. The mailer resolves the relay mode through this, so seeding the
			// port on appData (the PRODUCTION path), not a top-level property, is what actually exercises it.
			getParentPort: function() { return share.appData.parent_port || null; }
		},
		System: { decrypt: async function(v) { return { success: true, data: 'DEC:' + v }; } }
	};

	if (opts.parentPort) { share.posted = []; share.appData.parent_port = { postMessage: function(m) { share.posted.push(m); } }; }

	return share;
}


(async () => {

	console.log('\nMailer — mode resolution:');

	await testAsync('disabled, no Hub → mode none, not ready', async () => {
		created = [];
		Mailer.init(makeShare({ enabled: false, host: 'smtp.example.com' }));
		const r = await Mailer.configure();
		assert.strictEqual(r.mode, 'none');
		assert.strictEqual(Mailer.ready, false);
		assert.strictEqual(Mailer.mode, 'none');
		assert.strictEqual(created.length, 0);
	});

	await testAsync('enabled but no host, no Hub → mode none', async () => {
		created = [];
		Mailer.init(makeShare({ enabled: true, host: '' }));
		const r = await Mailer.configure();
		assert.strictEqual(r.mode, 'none');
		assert.strictEqual(Mailer.enabled, true);   // config toggle still reflects the checkbox
		assert.strictEqual(Mailer.ready, false);
	});

	await testAsync('enabled + host → mode own, ready, transport built, encrypted password decrypted', async () => {
		created = [];
		// An encrypted-at-rest value (32-hex IV : ciphertext) so the decrypt path runs.
		const ENC = '0123456789abcdef0123456789abcdef:CIPHER';
		Mailer.init(makeShare({ enabled: true, host: 'smtp.example.com', port: 587, user: 'u', password: ENC }));
		const r = await Mailer.configure();
		assert.strictEqual(r.mode, 'own');
		assert.strictEqual(Mailer.ready, true);
		assert.strictEqual(created.length, 1);
		assert.strictEqual(created[0].opts.auth.pass, 'DEC:' + ENC);
	});

	await testAsync('a legacy PLAINTEXT password is used as-is (not run through decrypt)', async () => {
		created = [];
		Mailer.init(makeShare({ enabled: true, host: 'smtp.example.com', port: 587, user: 'u', password: 'plainpw' }));
		await Mailer.configure();
		assert.strictEqual(created.length, 1);
		assert.strictEqual(created[0].opts.auth.pass, 'plainpw', 'plaintext password passes through unchanged');
	});

	await testAsync('no own SMTP but under a Hub → mode relay, ready', async () => {
		created = [];
		Mailer.init(makeShare({ enabled: false }, { parentPort: true }));
		const r = await Mailer.configure();
		assert.strictEqual(r.mode, 'relay');
		assert.strictEqual(Mailer.ready, true);
		assert.strictEqual(created.length, 0);   // no local transport in relay mode
	});

	await testAsync('own SMTP set takes precedence over the Hub (mode own, not relay)', async () => {
		created = [];
		Mailer.init(makeShare({ enabled: true, host: 'smtp.example.com' }, { parentPort: true }));
		const r = await Mailer.configure();
		assert.strictEqual(r.mode, 'own');
	});

	await testAsync('port 465 implies secure', async () => {
		created = [];
		Mailer.init(makeShare({ enabled: true, host: 'smtp.example.com', port: 465 }));
		await Mailer.configure();
		assert.strictEqual(created[0].opts.secure, true);
	});


	console.log('\nMailer — send (own):');

	await testAsync('own send delivers via the local transport', async () => {
		created = [];
		Mailer.init(makeShare({ enabled: true, host: 'smtp.example.com', from: 'me@x.com' }));
		await Mailer.configure();
		const p = Mailer.send({ to: ['a@x.com', 'b@y.com'], text: 'hi' });
		assert.ok(p && typeof p.then === 'function');   // fire-and-forget handle
		const r = await p;
		assert.strictEqual(r.sent, true);
		assert.strictEqual(created[0].sent[0].to, 'a@x.com, b@y.com');
		assert.strictEqual(created[0].sent[0].from, 'me@x.com');
	});

	await testAsync('own send with no recipient is skipped', async () => {
		created = [];
		Mailer.init(makeShare({ enabled: true, host: 'smtp.example.com' }));
		await Mailer.configure();
		const r = await Mailer.send({ to: [], text: 'hi' });
		assert.strictEqual(r.sent, false);
	});

	await testAsync('a transport send failure never rejects to the caller', async () => {
		created = [];
		Mailer.init(makeShare({ enabled: true, host: 'smtp.example.com' }));
		await Mailer.configure();
		created[0].failSend = true;
		const r = await Mailer.send({ to: ['a@x.com'], text: 'hi' });
		assert.strictEqual(r.sent, false);
		assert.ok(r.error);
	});


	console.log('\nMailer — send (relay):');

	await testAsync('relay send posts the email to the Hub channel', async () => {
		created = [];
		const share = makeShare({ enabled: false }, { parentPort: true });
		Mailer.init(share);
		await Mailer.configure();
		const r = await Mailer.send({ to: ['a@x.com'], subject: 'S', text: 'hi' });
		assert.strictEqual(r.sent, true);
		assert.strictEqual(r.relayed, true);
		assert.strictEqual(share.posted.length, 1);
		assert.strictEqual(share.posted[0].type, WORKER_TO_HUB.SEND_EMAIL);
		assert.deepStrictEqual(share.posted[0].payload.to, ['a@x.com']);
		assert.strictEqual(share.posted[0].payload.subject, 'S');
		assert.strictEqual(created.length, 0);   // never sent locally
	});

	await testAsync('relay send with no recipient is skipped (nothing posted)', async () => {
		created = [];
		const share = makeShare({ enabled: false }, { parentPort: true });
		Mailer.init(share);
		await Mailer.configure();
		const r = await Mailer.send({ to: [], text: 'hi' });
		assert.strictEqual(r.sent, false);
		assert.strictEqual(share.posted.length, 0);
	});


	console.log('\nMailer — send (none):');

	await testAsync('none mode skips gracefully without throwing', async () => {
		created = [];
		Mailer.init(makeShare({ enabled: false }));
		await Mailer.configure();
		const r = await Mailer.send({ to: ['a@x.com'], text: 'hi' });
		assert.strictEqual(r.sent, false);
	});


	console.log('\nMailer — testSMTP:');

	await testAsync('testSMTP with no host fails without building a transport', async () => {
		created = [];
		const r = await Mailer.testSMTP({ host: '' });
		assert.strictEqual(r.success, false);
		assert.strictEqual(created.length, 0);
	});

	await testAsync('testSMTP verifies and sends a test message', async () => {
		created = [];
		const r = await Mailer.testSMTP({ host: 'smtp.example.com', port: 587, user: 'u', pass: 'p', from: 'me@x.com', test_to: 'you@x.com' });
		assert.strictEqual(r.success, true);
		assert.strictEqual(r.sent_to, 'you@x.com');
		assert.strictEqual(created[0].verified, 1);
		assert.strictEqual(created[0].sent.length, 1);
		assert.strictEqual(created[0].sent[0].to, 'you@x.com');
	});

	await testAsync('testSMTP reports a verify failure and does not send', async () => {
		created = [];
		const prev = nodemailer.createTransport;
		nodemailer.createTransport = function(o) { const t = prev(o); t.failVerify = true; return t; };
		const r = await Mailer.testSMTP({ host: 'smtp.example.com', from: 'me@x.com' });
		nodemailer.createTransport = prev;
		assert.strictEqual(r.success, false);
		assert.ok(/verify failed/.test(r.error));
		assert.strictEqual(created[created.length - 1].sent.length, 0);
	});

	nodemailer.createTransport = realCreateTransport;

	console.log('\n' + passed + ' passed, ' + failed + ' failed');
	process.exit(failed ? 1 : 0);
})();