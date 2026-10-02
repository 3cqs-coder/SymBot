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
 * Body:      { apiToken, action, pair, volume?, deal_id?, signal_id?, timestamp?, dry_run? }
 * Actions:   entry | add_funds | close | panic_sell | close_all
 *
 * Targeting: when a bot runs several deals, add `deal_id` (the id returned by `entry`; `dealId` also works)
 *            to aim add_funds / close / panic_sell / close_all at ONE specific deal. Without it the action
 *            resolves the bot's single active deal (and errors if several are open). This sample's --deal-id sets it.
 * Dry run:   pass `dry_run: true` (this sample's --dry-run flag) to VALIDATE a signal — auth, capability, and the
 *            deal target are all checked — WITHOUT executing it. The reply is
 *            `{ success:true, dry_run:true, would:{ action, botId, dealId, pair, signal_id } }`; nothing is
 *            started, funded, or closed. A safe way to test wiring and permissions.
 * Staleness: this sample stamps `timestamp` (epoch ms) in the body and `X-Signal-Timestamp` in the header. If the
 *            bot's `webhook.max_age_seconds` is configured, a signal older than that is rejected with
 *            `{ stale:true, reason:'too_old'|'future', ageSec }`, so a delayed or replayed alert can't fire late.
 *            (When max_age_seconds is not set, the timestamp is simply ignored — always safe to send.)
 * Batch:     to run several actions from one alert, POST `{ apiToken, actions:[ {action,pair,volume?,deal_id?}, … ] }`
 *            (max 10, executed IN ORDER). The reply is
 *            `{ batch:true, count, success, results:[ {index,action,status,result} ] }`, and a top-level
 *            `dry_run` applies to every sub-action. See README.md for a worked batch example.
 *
 * Idempotency: each signal carries a stable key (the `Idempotency-Key` header, mirrored into the
 *            `signal_id` body field for header-less senders such as TradingView). If the SAME key is
 *            re-sent to the same bot within a few minutes the server ignores it — replying
 *            `{ success: true, duplicate: true }` — instead of opening or funding a deal twice. That
 *            makes a retry after a dropped connection safe: this example reuses the one key across its
 *            retry, so a first attempt that actually landed cannot double-open a deal. Set
 *            IDEMPOTENCY_KEY to reuse a key across separate runs; otherwise one is generated per run.
 *
 * Usage (CLI flags preferred; BASE_URL / WEBHOOK_TOKEN / BOT_ID / IDEMPOTENCY_KEY env vars still work as a fallback):
 *   node signal-bot.js entry BTC/USD --base-url http://localhost:3000 --token xxxx --bot my-bot
 *   node signal-bot.js add_funds BTC/USD 25 --token xxxx --bot my-bot
 *   node signal-bot.js close BTC/USD --token xxxx --bot my-bot
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

// Per-request transport timeout (ms). A server that accepts the connection but never responds must not hang
// the script forever — the timeout below turns that stall into a transport error so the same-key retry runs.
const REQUEST_TIMEOUT_MS = 15000;

// Read a "--name value" or "--name=value" flag from argv, or null. SymBot is configured through CLI args
// and config files rather than environment variables, so these flags are the preferred way to configure this
// sample; the environment variables remain as a fallback for existing setups.
function cliFlag(name) {
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--' + name && argv[i + 1] != null) { return argv[i + 1]; }
		if (argv[i].indexOf('--' + name + '=') === 0) { return argv[i].slice(('--' + name + '=').length); }
	}
	return null;
}

// Boolean flags take NO value, so the positional parser must not swallow the token after them.
const BOOLEAN_FLAGS = new Set([ 'dry-run' ]);

// Is a boolean flag (e.g. --dry-run) present?
function hasFlag(name) { return process.argv.slice(2).includes('--' + name); }

// The positional arguments (action, pair, volume) — everything that is not a --flag or a value-taking flag's value.
function positionals() {
	const argv = process.argv.slice(2);
	const out = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.indexOf('--') === 0) {
			const name = a.slice(2).split('=')[0];
			// A value-taking "--name value" consumes the next token; a boolean flag and "--name=value" do not.
			if (a.indexOf('=') === -1 && !BOOLEAN_FLAGS.has(name) && argv[i + 1] != null && argv[i + 1].indexOf('--') !== 0) { i++; }
			continue;
		}
		out.push(a);
	}
	return out;
}

const BASE_URL      = cliFlag('base-url') || process.env.BASE_URL      || 'http://localhost:3000';
const WEBHOOK_TOKEN = cliFlag('token')    || process.env.WEBHOOK_TOKEN || 'REPLACE_WITH_YOUR_WEBHOOK_TOKEN';
const BOT_ID        = cliFlag('bot')      || process.env.BOT_ID        || 'my-bot';

// One idempotency key for this signal. Generated per run (or pinned via --idempotency-key) and REUSED across
// the retry below, so a resend never opens or funds a deal twice. See the header note.
const IDEMPOTENCY_KEY = cliFlag('idempotency-key') || process.env.IDEMPOTENCY_KEY || crypto.randomUUID();

// Optional, opt-in. --deal-id targets ONE specific deal (for add_funds/close/panic_sell/close_all when a bot
// runs several); --dry-run validates the signal without executing it. Both default off.
const DEAL_ID = cliFlag('deal-id') || process.env.DEAL_ID || null;
const DRY_RUN = hasFlag('dry-run') || process.env.DRY_RUN === 'true';


// POST a JSON body and resolve with { status, body }. Uses http or https by URL scheme.
function postSignal(action, pair, volume) {

	const url = new URL(BASE_URL.replace(/\/$/, '') + '/webhook/api/signal/' + encodeURIComponent(BOT_ID));
	const lib = url.protocol === 'https:' ? https : http;

	const ts = Date.now();

	const payload = { apiToken: WEBHOOK_TOKEN, action };
	if (pair) { payload.pair = pair; }
	if (volume != null) { payload.volume = Number(volume); }
	// Target one specific deal when the bot runs several (add_funds/close/panic_sell/close_all); omit to let the
	// server resolve the bot's single active deal.
	if (DEAL_ID) { payload.deal_id = DEAL_ID; }
	// Validate-without-executing: the server checks auth, capability and the target, then returns a `would` plan.
	if (DRY_RUN) { payload.dry_run = true; }
	// Send time (epoch ms). A bot with webhook.max_age_seconds set rejects a signal older than that; when it is
	// not set the timestamp is ignored, so stamping it is always safe.
	payload.timestamp = ts;
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
			timeout:  REQUEST_TIMEOUT_MS,
			headers:  {
				'Content-Type':    'application/json',
				'Content-Length':  Buffer.byteLength(data),
				'Idempotency-Key': IDEMPOTENCY_KEY,
				'X-Signal-Timestamp': String(ts)
			}
		}, (res) => {
			let buf = '';
			res.on('data', (c) => { buf += c; });
			res.on('end', () => { let body; try { body = JSON.parse(buf); } catch (e) { body = buf; } resolve({ status: res.statusCode, body }); });
		});

		// A stalled connection (accepted but never answered) fires 'timeout' but NOT 'error', so destroy the
		// request with an error — that surfaces as a transport failure and the same-key retry can run, instead
		// of the script hanging forever.
		req.on('timeout', () => { req.destroy(new Error('request timeout after ' + REQUEST_TIMEOUT_MS + 'ms')); });
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

	const [ action, pair, volume ] = positionals();

	if (!action) {
		console.log('Usage: node signal-bot.js <entry|add_funds|close|panic_sell|close_all> [pair] [volume] \\');
		console.log('         [--base-url URL] [--token TOKEN] [--bot BOT_ID] [--idempotency-key KEY] [--deal-id ID] [--dry-run]');
		console.log('Example: node signal-bot.js entry BTC/USD --base-url http://localhost:3000 --token xxxx --bot my-bot');
		console.log('  Dry run (validate only): node signal-bot.js close BTC/USD --token xxxx --bot my-bot --dry-run');
		console.log('  Target one deal:         node signal-bot.js add_funds BTC/USD 25 --token xxxx --bot my-bot --deal-id <ID>');
		console.log('(Environment variables BASE_URL, WEBHOOK_TOKEN, BOT_ID, IDEMPOTENCY_KEY, DEAL_ID, DRY_RUN are also honored as a fallback.)');
		process.exit(1);
	}

	// Reject a non-numeric volume before sending, for a clear client-side error rather than a server rejection.
	if (volume != null && !Number.isFinite(Number(volume))) {
		console.error('Volume must be a number (got "' + volume + '").');
		process.exit(1);
	}

	console.log('→ ' + action + (pair ? ' ' + pair : '') + (volume != null ? ' vol=' + volume : '') + (DEAL_ID ? ' deal=' + DEAL_ID : '') + (DRY_RUN ? ' [dry-run]' : '') + ' → bot "' + BOT_ID + '" at ' + BASE_URL + ' (idempotency ' + IDEMPOTENCY_KEY + ')');

	try {
		const r = await postSignalSafe(action, pair, volume);
		console.log('← HTTP ' + r.status + ': ' + JSON.stringify(r.body));

		// A repeat of the same key within the window is acknowledged but takes no new action.
		if (r.body && r.body.duplicate) { console.log('  (duplicate signal — ignored by idempotency; no new deal opened or funded)'); }

		// A dry run validated the signal without executing it — the `would` object is the plan the server accepted.
		if (r.body && r.body.dry_run) { console.log('  (dry run — validated only, nothing executed; would: ' + JSON.stringify(r.body.would) + ')'); }

		// The bot has webhook.max_age_seconds set and judged this signal too old (or too far in the future).
		if (r.body && r.body.stale) { console.log('  (rejected as STALE: ' + r.body.reason + ', age ' + r.body.ageSec + 's — the bot\'s max_age_seconds dropped it)'); }

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
