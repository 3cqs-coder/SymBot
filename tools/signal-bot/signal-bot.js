'use strict';

/**
 * SymBot Signal Bot — sample client
 * ---------------------------------
 * A minimal, dependency-free example of driving a SymBot Signal Bot from your own code or
 * from a TradingView / third-party alert. It sends signals to the Signal Bot webhook, which
 * starts, funds, and closes deals on the bot you target.
 *
 * Endpoint:  POST {BASE_URL}/webhook/api/signal/{BOT_ID}
 * Auth:      a token sent as `apiToken` in the JSON body. It can be EITHER:
 *              • a scoped API key (Access Control → API Keys) with the `deal.create`
 *                capability — recommended, because it can be revoked or rotated on its own
 *                without disturbing anything else; or
 *              • the legacy per-instance Webhook API Token (Configuration → Webhook API Token).
 *            Both work. A header-capable sender may instead pass the same value as an
 *            `api-token`/`api-key` header (checked before the body), which keeps it out of any
 *            request-body logs; TradingView and similar senders that cannot set headers use the
 *            body field. See ../README.md.
 * Body:      { apiToken, action, pair, volume?, signal_id? }
 * Actions:   entry | add_funds | close | panic_sell | close_all
 *
 * Idempotency: each signal carries a stable key (the `Idempotency-Key` header, mirrored into the
 *            `signal_id` body field for header-less senders such as TradingView). If the SAME key is
 *            re-sent to the same bot within a few minutes the server ignores it — replying
 *            `{ success: true, duplicate: true }` — instead of opening or funding a deal twice. That
 *            makes a retry after a dropped connection safe: this example reuses the one key across its
 *            retry, so a first attempt that actually landed cannot double-open a deal. Set
 *            IDEMPOTENCY_KEY to reuse a key across separate runs; otherwise one is generated per run.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 WEBHOOK_TOKEN=xxxx BOT_ID=my-bot node signal-bot.js entry BTC/USD
 *   node signal-bot.js add_funds BTC/USD 25
 *   node signal-bot.js close BTC/USD
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const BASE_URL      = process.env.BASE_URL      || 'http://localhost:3000';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || 'REPLACE_WITH_YOUR_WEBHOOK_TOKEN';
const BOT_ID        = process.env.BOT_ID        || 'my-bot';

// One idempotency key for this signal. Generated per run (or pinned via env) and REUSED across the
// retry below, so a resend never opens or funds a deal twice. See the header note.
const IDEMPOTENCY_KEY = process.env.IDEMPOTENCY_KEY || crypto.randomUUID();


// POST a JSON body and resolve with { status, body }. Uses http or https by URL scheme.
function postSignal(action, pair, volume) {

	const url = new URL(BASE_URL.replace(/\/$/, '') + '/webhook/api/signal/' + encodeURIComponent(BOT_ID));
	const lib = url.protocol === 'https:' ? https : http;

	const payload = { apiToken: WEBHOOK_TOKEN, action };
	if (pair) { payload.pair = pair; }
	if (volume != null) { payload.volume = Number(volume); }
	// Body copy of the key for senders that cannot set headers (TradingView, etc.). The header below
	// is checked first and keeps the key out of request-body logs when the sender can set one.
	payload.signal_id = IDEMPOTENCY_KEY;

	const data = JSON.stringify(payload);

	return new Promise((resolve, reject) => {

		const req = lib.request({
			hostname: url.hostname,
			port:     url.port || (url.protocol === 'https:' ? 443 : 80),
			path:     url.pathname,
			method:   'POST',
			headers:  {
				'Content-Type':    'application/json',
				'Content-Length':  Buffer.byteLength(data),
				'Idempotency-Key': IDEMPOTENCY_KEY
			}
		}, (res) => {
			let buf = '';
			res.on('data', (c) => { buf += c; });
			res.on('end', () => { let body; try { body = JSON.parse(buf); } catch (e) { body = buf; } resolve({ status: res.statusCode, body }); });
		});

		req.on('error', reject);
		req.write(data);
		req.end();
	});
}


// Send the signal, retrying ONCE on a transport error (no HTTP response — a dropped connection or
// timeout). The retry reuses the same Idempotency-Key, so if the first attempt actually reached the
// server the resend is ignored rather than acted on a second time. Resolves with { status, body }.
async function postSignalSafe(action, pair, volume) {

	let lastErr;

	for (let attempt = 1; attempt <= 2; attempt++) {

		try { return await postSignal(action, pair, volume); }
		catch (e) {
			lastErr = e;
			if (attempt < 2) { console.warn('  transport error (' + e.message + ') — retrying with the same idempotency key…'); await new Promise(r => setTimeout(r, 1000)); }
		}
	}

	throw lastErr;
}


async function main() {

	const [ action, pair, volume ] = process.argv.slice(2);

	if (!action) {
		console.log('Usage: node signal-bot.js <entry|add_funds|close|panic_sell|close_all> [pair] [volume]');
		console.log('Env:   BASE_URL, WEBHOOK_TOKEN, BOT_ID');
		process.exit(1);
	}

	console.log('→ ' + action + (pair ? ' ' + pair : '') + (volume != null ? ' vol=' + volume : '') + ' → bot "' + BOT_ID + '" at ' + BASE_URL + ' (idempotency ' + IDEMPOTENCY_KEY + ')');

	try {
		const r = await postSignalSafe(action, pair, volume);
		console.log('← HTTP ' + r.status + ': ' + JSON.stringify(r.body));

		// A repeat of the same key within the window is acknowledged but takes no new action.
		if (r.body && r.body.duplicate) { console.log('  (duplicate signal — ignored by idempotency; no new deal opened or funded)'); }

		// A 403 means the credential lacks permission; a success:false in the body carries a
		// human-readable reason (e.g. an unknown action lists the valid ones).
		if (r.status === 403) { console.error('Forbidden — check the webhook token and that webhooks are enabled.'); process.exit(2); }
		process.exit(r.body && r.body.success === false ? 3 : 0);
	}
	catch (e) {
		console.error('Request failed: ' + e.message + ' (is SymBot running and reachable at ' + BASE_URL + '?)');
		process.exit(1);
	}
}

main();
