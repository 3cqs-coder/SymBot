'use strict';

const nodemailer = require('nodemailer');
const { WORKER_TO_HUB } = require(__dirname + '/Hub/MessageTypes.js');

// Outbound mailer (SMTP).
//
// One mailer module serves both roles, resolved at configure() time into a `mode`:
//   'own'   — this process has its own SMTP configured (enabled + host); it builds a local
//             transport and sends directly. Used by a standalone instance, by an instance
//             that overrides the Hub, and by the Hub itself (whose SMTP lives in hub.json).
//   'relay' — no own SMTP, but the process is a Hub worker (shareData.parent_port is set);
//             email is handed to the Hub over the existing worker channel and the Hub sends
//             it through its shared mailer. This keeps the UX simple:
//             set SMTP once on the Hub and every instance inherits it, with the instance's
//             own SMTP acting purely as an override.
//   'none'  — no own SMTP and no Hub to relay through; send() logs and skips.
//
// Two hard requirements carried from those platforms:
//   1. A "Test SMTP" action that verifies the settings (and sends a test message) BEFORE
//      anything relies on them — see testSMTP().
//   2. Fully ASYNC / NON-BLOCKING send — email must never block the request path, the
//      scheduler, or the trading loop. send() is fire-and-forget: it returns a promise the
//      caller may ignore, never rejects to the caller, and logs failures rather than
//      propagating them.
//
// Transport credentials live in config (the SMTP password encrypted at rest, like the SFTP
// secrets); per-feature records (e.g. a schedule's notifications) carry only recipient
// addresses, never credentials. Relayed email crosses the in-process worker channel only —
// the password never leaves the Hub.

let shareData;
let transport = null;
let mode = 'none';   // 'own' | 'relay' | 'none' — resolved in configure()
let cfg = { enabled: false, from: '', host: '' };


let log = function () {};   // assigned in init() via Common.makeLogger


// Build a nodemailer transport from a plain SMTP config object. Returns null without a host.
function buildTransport(c) {

	if (!c || !c.host) { return null; }

	const port = Number(c.port) || 587;

	return nodemailer.createTransport({
		host: String(c.host),
		port: port,
		secure: (c.secure === true || c.secure === 'true' || port === 465),   // 465 = implicit TLS
		auth: (c.user) ? { user: String(c.user), pass: String(c.pass || '') } : undefined,
		connectionTimeout: 15000,
		greetingTimeout: 10000,
		socketTimeout: 20000
	});
}


// (Re)build the live transport from the app's mailer config, decrypting the stored SMTP
// password. Called on start and after a config save. Single exit.
async function configure() {

	const m = (shareData && shareData.appData && shareData.appData.mailer) || {};

	cfg = {
		enabled: m.enabled === true || m.enabled === 'true',
		from: m.from || m.user || '',
		host: m.host || '',
		port: m.port,
		secure: m.secure,
		user: m.user || ''
	};

	// Resolve the SMTP password the same way Common.readSecret handles every other secret:
	// decrypt only when the stored value is in the encrypted format ("<32-hex IV>:..."); any
	// other value is treated as legacy plaintext and used as-is. This means a plaintext password
	// saved by an older version keeps working instead of silently decrypting to '' (which would
	// break auth with the UI still showing "password set"). A corrupt/undecryptable encrypted
	// value falls back to empty.
	let pass = (typeof m.password === 'string') ? m.password : '';

	if (pass && shareData && shareData.Common && typeof shareData.Common.isEncrypted === 'function'
		&& shareData.Common.isEncrypted(pass) && shareData.System && typeof shareData.System.decrypt === 'function') {

		pass = '';

		try {
			const d = await shareData.System.decrypt(m.password, shareData.appData.password);
			if (d && d.success && d.data != null) { pass = d.data; }
		}
		catch (e) { log('password decrypt failed: ' + e.message); }
	}

	// Own SMTP wins when it is enabled and a host is set; otherwise a Hub worker relays to
	// the Hub, and a standalone process with no SMTP can't send.
	const own = !!(cfg.enabled && cfg.host);

	transport = own ? buildTransport({ host: m.host, port: m.port, secure: m.secure, user: m.user, pass }) : null;

	if (own && transport) { mode = 'own'; }
	else if (shareData && shareData.parent_port) { mode = 'relay'; }
	else { mode = 'none'; }

	log('mode ' + mode + (mode === 'own' ? ' (host ' + cfg.host + ')' : (mode === 'relay' ? ' (via Hub)' : '')));

	return { mode: mode, ready: isReady() };
}


// Whether the mailer can deliver: an own transport, or a Hub to relay through.
function isReady() { return mode === 'own' ? !!transport : mode === 'relay'; }


// Fire-and-forget send. Returns a promise the caller MAY ignore; it never rejects to the
// caller and never blocks — email must not hold up the scheduler or trading loop. The outer
// function returns synchronously with the pending promise. Single exit.
function send(msg) {

	const p = (async () => {

		// Recipient presence is required in every mode; normalize an array to a string only
		// for the local-send path (relay passes the payload through untouched).
		const rawTo = msg && msg.to;
		const hasTo = Array.isArray(rawTo) ? rawTo.filter(Boolean).length > 0 : !!rawTo;

		if (!hasTo) { log('send skipped — no recipient'); return { sent: false }; }

		if (mode === 'relay') {

			const port = shareData && shareData.parent_port;

			if (!port || typeof port.postMessage !== 'function') { log('relay skipped — no Hub channel'); return { sent: false }; }

			try {

				port.postMessage({
					type: WORKER_TO_HUB.SEND_EMAIL,
					payload: {
						to: rawTo,
						subject: (msg && msg.subject) || '',
						text: (msg && msg.text) || '',
						html: (msg && msg.html) || undefined
					}
				});

				log('relayed to Hub');
				return { sent: true, relayed: true };
			}
			catch (e) { log('relay failed: ' + e.message); return { sent: false, error: e.message }; }
		}

		if (mode !== 'own' || !transport) { log('send skipped — no mailer available (own SMTP unset and no Hub)'); return { sent: false }; }

		const to = Array.isArray(rawTo) ? rawTo.filter(Boolean).join(', ') : rawTo;

		try {

			await transport.sendMail({
				from: cfg.from,
				to: to,
				subject: (msg && msg.subject) || 'SymBot notification',
				text: (msg && msg.text) || '',
				html: (msg && msg.html) || undefined
			});

			log('sent to ' + to);
			return { sent: true };
		}
		catch (e) { log('send failed to ' + to + ': ' + e.message); return { sent: false, error: e.message }; }
	})();

	if (p && typeof p.catch === 'function') { p.catch(function () {}); }

	return p;
}


// Verify a candidate SMTP config (the values entered in the form, not yet saved) and send a
// test message so a user can confirm the settings work before relying on them. Returns
// { success, error, sent_to }. Never throws. Single exit.
async function testSMTP(c) {

	let result = { success: false, error: 'SMTP host is required' };

	const t = buildTransport(c);

	if (t) {

		try {

			await t.verify();

			const to = (c && (c.test_to || c.from || c.user)) || '';

			if (to) {

				const rendered = renderEmail(
					'This is a test message from SymBot confirming your SMTP settings are working.',
					{ title: 'SMTP Test', subject: 'SymBot SMTP test' }
				);

				await t.sendMail({
					from: (c.from || c.user),
					to: to,
					subject: rendered.subject,
					text: rendered.text,
					html: rendered.html
				});
			}

			result = { success: true, error: null, sent_to: to || null };
		}
		catch (e) { result = { success: false, error: e.message }; }
	}

	return result;
}


// Build a candidate SMTP config from a raw config-form request body and verify it (see testSMTP).
// When the password field is left blank, fall back to the currently-stored (encrypted) mailer
// password so a user can re-test without re-typing it. Shared by the instance and Hub
// /api/mailer/test routes so the two can never drift. Never throws.
async function testFromRequest(body) {

	body = body || {};

	let pass = body.mailer_password;

	if ((pass === undefined || pass === null || pass === '') && shareData && shareData.appData && shareData.appData.mailer && shareData.appData.mailer.password) {

		try {

			const dec = await shareData.System.decrypt(shareData.appData.mailer.password, shareData.appData.password);

			if (dec && dec.success) { pass = dec.data; }
		}
		catch (e) { /* fall through with a blank password */ }
	}

	const candidate = {
		host: (body.mailer_host || '').trim(),
		port: Number(body.mailer_port ?? 587) || 587,
		secure: body.mailer_secure === true || body.mailer_secure === 'true' || body.mailer_secure === '1',
		user: (body.mailer_user || '').trim(),
		pass: pass || '',
		from: (body.mailer_from || '').trim(),
		test_to: (body.mailer_test_to || body.mailer_from || body.mailer_user || '').trim()
	};

	return await testSMTP(candidate);
}


// Wrap a plain-text notification into a consistent, lightly-branded SymBot email: a sensible
// subject and a simple responsive HTML body, with the original text kept as the text/plain
// fallback so it renders in every client. One template for every SymBot email so notifications
// look the same wherever they come from. `meta` is optional: { subject } forces the subject;
// { title } is used as the heading and subject when no explicit subject is given; { footer }
// overrides the footer line. Pure/deterministic — safe to call from any send path.
function renderEmail(message, meta) {

	meta = meta || {};

	const text = String(message == null ? '' : message);

	const esc = (s) => String(s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');

	// Subject: explicit wins, then a provided title, then the first non-empty line of the
	// message (trimmed), then a generic fallback.
	let subject = meta.subject;

	if (!subject) {

		const firstLine = text.split('\n').map(s => s.trim()).find(Boolean) || '';
		const base = meta.title || firstLine;
		subject = base ? ('SymBot: ' + base.slice(0, 140)) : 'SymBot Notification';
	}

	const heading = esc(meta.title || 'SymBot');
	const footer = esc(meta.footer || 'Automated message from your SymBot instance.');
	const bodyHtml = esc(text).replace(/\n/g, '<br>');

	const html =
		'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
		'<body style="margin:0;padding:0;background:#f4f5f7;">' +
		'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0;"><tr><td align="center">' +
		'<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #e3e5e8;border-radius:8px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">' +
		'<tr><td style="background:#111827;padding:16px 24px;color:#ffffff;font-size:18px;font-weight:600;">' + heading + '</td></tr>' +
		'<tr><td style="padding:24px;color:#1f2933;font-size:14px;line-height:1.6;white-space:normal;">' + bodyHtml + '</td></tr>' +
		'<tr><td style="padding:14px 24px;border-top:1px solid #eceef0;color:#8a94a6;font-size:12px;">' + footer + '</td></tr>' +
		'</table></td></tr></table></body></html>';

	return { subject, text, html };
}


module.exports = {
	init: function (obj) { shareData = obj; log = obj.Common.makeLogger('Mailer: '); },
	renderEmail,
	configure,
	send,
	testSMTP,
	testFromRequest,
	get enabled() { return cfg.enabled === true; },
	get ready() { return isReady(); },
	get mode() { return mode; }
};