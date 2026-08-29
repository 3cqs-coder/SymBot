'use strict';

// Signal Activity — a read-only, best-effort log of inbound Signal Bot activity.
//
// Every AUTHENTICATED webhook/API signal that reaches processWebHook (routes.js) is recorded here with
// the action, the target bot/pair, the source IP, and the OUTCOME once the action handler has decided it
// (deal opened, rejected with a reason, held below target, duplicate, …). It lets an operator confirm
// what an external source actually did to a Signal Bot — the TradingView / Signal Bot commands, the 3CQS
// client (which drives deals through the same internal webhook endpoint), and any other webhook source.
//
// It is entirely off the trading path: recording is fire-and-forget and fully guarded, so a logging
// failure can never delay, alter, or break a signal's response or the trade it triggers. Only recognized
// signal endpoints are logged (metaFromRequest returns null for anything else), and only AFTER the
// request has authenticated — so unauthenticated noise is never stored, and an operator whose token is
// wrong simply sees no entry (which is itself the diagnosis, mirroring how other platforms behave).

const Schema = require('../mongodb/SignalActivitySchema');
const SignalActivity = Schema.SignalActivitySchema;

const ACTIONS = ['entry', 'add_funds', 'close', 'panic_sell', 'close_all'];

// The normalized outcome values, in one place: what is stored on each row, what the view's
// dropdown offers, and what getActivity/summarize filter on. Keep in sync with the schema.
const OUTCOMES = ['started', 'processed', 'rejected', 'duplicate'];

// Map a stored row to its display outcome. Prefers the persisted `outcome`, falling back to the
// older success/duplicate/deal_id shape so rows written before `outcome` existed still classify.
function deriveOutcome(r) {

	return r.outcome || (r.duplicate ? 'duplicate' : (r.success ? (r.deal_id ? 'started' : 'processed') : 'rejected'));
}

// Resolve { botId -> botName } once (read-only, best-effort) so rows can show a friendly bot name.
async function botNameMap() {

	const map = {};

	try {

		const bots = await shareData.DCABot.getBots();
		(bots || []).forEach(function (b) { if (b && b.botId) { map[b.botId] = b.botName; } });
	}
	catch (e) {}

	return map;
}

// ── Per-instance scoping ──────────────────────────────────────────────────────
// Every read, prune and backup is scoped to this instance's server_id, so a Hub setup that shares one
// database across instances never mixes or cross-prunes their signal logs (the audit log scopes the same
// way). Empty string before server_id resolves — harmless, matches the field default.
function serverId() { return (shareData && shareData.appData && shareData.appData.server_id) || ''; }


// ── Source classification ─────────────────────────────────────────────────────
// The logical channel a signal arrived on. This is a RETENTION/label dimension, not a security control, so
// it is derived best-effort and always yields SOME stable slug. The set is open-ended ON PURPOSE: a future
// internal source only has to declare itself (see below) and the retention machinery picks it up with no
// code change; a removed source simply stops producing rows; a renamed one is just a new slug. External
// senders can NOT invent arbitrary sources (that would let an attacker spawn unbounded retention buckets):
// only a loopback caller (our own in-process clients, e.g. the 3CQS client, which posts to 127.0.0.1) is
// trusted to name itself via the X-Signal-Source header; everything else is classified from HOW it
// authenticated. Unknown → 'other'.
const SOURCE_MAX_LEN = 24;

function sanitizeSource(v) {

	const s = String(v == null ? '' : v).trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, SOURCE_MAX_LEN);
	return s || 'other';
}

function isLoopbackIp(ip) {

	const s = String(ip || '');
	return s === '127.0.0.1' || s === '::1' || s === 'localhost' || s === '::ffff:127.0.0.1';
}

function classifySource(req) {

	try {

		const headers = (req && req.headers) || {};
		const declared = headers['x-signal-source'];

		// A loopback caller is one of our own in-process signal clients; trust it to name its channel.
		// Read the RAW TCP peer address (req.socket.remoteAddress), NOT the proxy-aware client IP —
		// getClientIp honors client-controlled X-Forwarded-For / CF-Connecting-IP when trust_proxy is on
		// (the default), so a remote caller could spoof "127.0.0.1" there and forge a trusted source. The
		// real socket peer cannot be spoofed by a remote client, so it is the correct trust boundary. This
		// is how a new internal source becomes first-class with zero code change here.
		const socketIp = (req && ((req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress))) || '';

		if (declared && isLoopbackIp(socketIp)) { return sanitizeSource(declared); }

		// External / credentialed callers are classified by HOW they authenticated — never by a header
		// they could spoof. The shared webhook api-token is the TradingView / Signal Bot channel; anything
		// else that got this far (a resolved scoped API key or session) is the manual API channel.
		if (headers['api-token']) { return 'signal_bot'; }

		return 'api';
	}
	catch (e) {

		return 'other';
	}
}


// ── Retention policy (per source) ─────────────────────────────────────────────
// Retention has TWO dimensions, applied per source, so no single channel can crowd out another:
//   • the schema's 30-day TTL is the hard TIME ceiling for every row, and
//   • each source keeps at most `max_rows` of its OWN most-recent rows — a chatty 3CQS feed only ever
//     evicts its own oldest, never a rare Signal Bot entry.
// This map is only the DEFAULT; an operator can override any source's budget in app.json under
// `signal_activity.retention.<source>.max_rows`. A source with NO explicit entry — including any future,
// renamed, or legacy one — falls back to `default`, so the system needs no code change to stay correct as
// sources come and go. The prune discovers whatever sources actually exist (see pruneOverflow), so this
// map never has to be exhaustive.
const RETENTION_DEFAULTS = {
	'signal_bot': { 'max_rows': 50000 },    // rare, user-initiated, high-value → generous
	'api':        { 'max_rows': 50000 },    // manual API → generous
	'3cqs':       { 'max_rows': 200000 },   // provider firehose → capped to its own (large) pool
	'other':      { 'max_rows': 25000 },
	'default':    { 'max_rows': 25000 }     // any source without an explicit budget (new / renamed / legacy)
};

// Absolute safety ceiling on any single source's budget so a bad config value can never make the
// collection grow without bound. Worst-case total ≈ (distinct sources) × this.
const SOURCE_MAX_ROWS_CAP = 500000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;   // every 6 hours

// Resolve a source's row budget: operator override (app.json signal_activity.retention.<source>.max_rows,
// or a `default` override for sources with no built-in) else the built-in default, clamped to a sane
// range. Never throws.
function retentionFor(source) {

	let budget = null;

	try {

		const cfg = shareData && shareData.appData && shareData.appData.signal_activity && shareData.appData.signal_activity.retention;

		if (cfg && cfg[source] && cfg[source].max_rows != null) { budget = parseInt(cfg[source].max_rows, 10); }
		else if (cfg && cfg['default'] && cfg['default'].max_rows != null && !RETENTION_DEFAULTS[source]) { budget = parseInt(cfg['default'].max_rows, 10); }
	}
	catch (e) {}

	if (budget == null || isNaN(budget)) {

		const def = RETENTION_DEFAULTS[source] || RETENTION_DEFAULTS['default'];
		budget = def.max_rows;
	}

	if (!(budget > 0)) { budget = RETENTION_DEFAULTS['default'].max_rows; }
	if (budget > SOURCE_MAX_ROWS_CAP) { budget = SOURCE_MAX_ROWS_CAP; }

	return budget;
}


// Latency statistics for a set of latency_ms values: count, average, p95 (nearest-rank), max, and how many
// were "slow" (over SLOW_MS). summarize reports these overall and per source/action so an operator or the AI
// can diagnose WHERE signal latency comes from — e.g. a source whose signals back up behind the serial
// deal-start queue (the entry handler polls up to ~30s for the deal to open, so a deep queue shows near-30s
// latency). Pure; never throws.
const SLOW_MS = 10000;   // a signal reply taking longer than this is flagged as slow (queue backpressure)

function latencyStats(values) {

	if (!values || !values.length) { return { 'n': 0, 'avg': null, 'p95': null, 'max': null, 'slow': 0 }; }

	const sorted = values.slice().sort(function (a, b) { return a - b; });
	const n = sorted.length;

	let sum = 0;
	let slow = 0;
	for (let i = 0; i < n; i++) { sum += sorted[i]; if (sorted[i] > SLOW_MS) { slow++; } }

	const p95idx = Math.min(n - 1, Math.floor(0.95 * n));

	return {
		'n':    n,
		'avg':  Math.round(sum / n),
		'p95':  sorted[p95idx],
		'max':  sorted[n - 1],
		'slow': slow
	};
}


let shareData;


// Identify a recognized Signal Bot command from the (already webhook-rewritten) request path, and pull
// the bot id, pair, action and source IP out of it. Returns null for any path that is not a signal
// command, so nothing else is ever recorded. Never throws.
function metaFromRequest(req, reqPath) {

	try {

		const path = String(reqPath || req.url || '');
		const body = (req && req.body) || {};

		let action = null;
		let botId = null;
		let dealId = null;

		// Per-command bot endpoints: /api/bots/{botId}/start_deal | add_funds | close | panic_sell
		let m = path.match(/^\/api\/bots\/([^/]+)\/(start_deal|add_funds|close|panic_sell)(?:\/|$|\?)/);

		if (m) {

			botId = m[1];
			action = (m[2] === 'start_deal') ? 'entry' : m[2];
		}
		else if ((m = path.match(/^\/api\/deals\/([^/]+)\/(add_funds|close|panic_sell)(?:\/|$|\?)/))) {

			// Deal-scoped variants (used when a pair runs concurrent deals, so a bot endpoint would be
			// ambiguous): /api/deals/{dealId}/(add_funds|close|panic_sell). Keyed by deal id, no bot id.
			dealId = m[1];
			action = m[2];
		}
		else {

			// Single dispatcher endpoint: /api/signal/{botId} with the action in the body.
			m = path.match(/^\/api\/signal\/([^/]+)(?:\/|$|\?)/);

			if (m) {

				botId = m[1];
				action = (typeof body.action === 'string') ? body.action.trim().toLowerCase() : '';
			}
		}

		if (!action || ACTIONS.indexOf(action) === -1) {

			return null;
		}

		let pair = body.pair;
		if (pair != null && typeof pair !== 'string') { pair = String(pair); }

		let sourceIp = '';
		try { sourceIp = (shareData && shareData.Common && typeof shareData.Common.getClientIp === 'function') ? shareData.Common.getClientIp(req) : ''; } catch (e) {}

		// Correlation key — the same value the idempotency layer keys on — so a duplicate/retry of one
		// alert can be tied back to the original in the log.
		const headers = (req && req.headers) || {};
		const rawKey = headers['idempotency-key'] || (body && (body.idempotency_key || body.signal_id)) || '';
		const signalKey = String(rawKey).trim();

		// Optional sender-supplied timestamp (e.g. a TradingView {{timenow}} placed in the alert body) —
		// kept so signal-to-receipt lag can be analyzed later. Accept an epoch number or an ISO string.
		let signalTs = null;

		try {

			if (body && body.timestamp != null && body.timestamp !== '') {

				const t = (typeof body.timestamp === 'number') ? new Date(body.timestamp) : new Date(String(body.timestamp));
				if (!isNaN(t.getTime())) { signalTs = t; }
			}
		}
		catch (e) {}

		return {
			'server_id':  serverId(),
			'source':     classifySource(req),
			'action':     action,
			'bot_id':     (botId != null && typeof botId !== 'string') ? String(botId) : (botId || ''),
			'deal_id':    (dealId != null && typeof dealId !== 'string') ? String(dealId) : (dealId || ''),
			'pair':       pair || '',
			'source_ip':  sourceIp || '',
			'received':   Date.now(),   // for processing-latency measurement
			'signal_key': signalKey,
			'signal_ts':  signalTs
		};
	}
	catch (e) {

		return null;
	}
}


// Turn the action handler's response body into a { success, duplicate, reason, deal_id } outcome. The
// body may be an object (res.send(obj)) or a JSON string; a body-level failure is always { success:false,
// data:"<reason>" } (or "error" for the auth/rate layer), so the reason is picked up uniformly.
function parseOutcome(body) {

	let obj = body;

	if (typeof body === 'string') {

		try { obj = JSON.parse(body); } catch (e) { obj = { 'data': body }; }
	}

	obj = (obj && typeof obj === 'object') ? obj : {};

	const success = obj.success === true;
	const duplicate = obj.duplicate === true;

	let dealId = '';
	let reason = '';

	const d = obj.data;

	if (d && typeof d === 'object') {

		dealId = d.deal_id || d.dealId || '';
		reason = dealId ? ('Deal ' + dealId + ' opened') : 'Success';
	}
	else if (typeof d === 'string' && d !== '') {

		reason = d;
	}
	else if (typeof obj.error === 'string' && obj.error !== '') {

		reason = obj.error;
	}
	else {

		reason = success ? 'Success' : 'Rejected';
	}

	// Normalized outcome for clean, future-proof filtering (the reason text still carries the nuance,
	// e.g. a graceful close held below target reads success with a "left open" reason).
	let outcome;
	if (duplicate) { outcome = 'duplicate'; }
	else if (success) { outcome = dealId ? 'started' : 'processed'; }
	else { outcome = 'rejected'; }

	return { 'success': success, 'duplicate': duplicate, 'outcome': outcome, 'reason': reason, 'deal_id': dealId };
}


// Persist one activity row. Best-effort and self-contained: any failure is logged and swallowed so it can
// never surface as a rejection or block the caller. Always resolves.
async function record(meta, outcome, extra) {

	try {

		if (!meta || !SignalActivity) { return; }

		const o = outcome || {};
		const x = extra || {};

		const doc = {
			'server_id':  meta.server_id || serverId(),
			'source':     sanitizeSource(meta.source),
			'date':       new Date(),
			'action':     meta.action,
			'bot_id':     meta.bot_id || '',
			'pair':       meta.pair || '',
			'source_ip':  meta.source_ip || '',
			'success':    o.success === true,
			'duplicate':  o.duplicate === true,
			'outcome':    o.outcome || '',
			'reason':     (typeof o.reason === 'string') ? o.reason.slice(0, 500) : '',
			'deal_id':    o.deal_id || meta.deal_id || '',   // response deal id, else the deal-scoped path id
			'signal_key': meta.signal_key || ''
		};

		if (typeof x.http_status === 'number') { doc.http_status = x.http_status; }
		if (typeof x.latency_ms === 'number' && x.latency_ms >= 0) { doc.latency_ms = x.latency_ms; }
		if (meta.signal_ts) { doc.signal_ts = meta.signal_ts; }

		await SignalActivity.create(doc);
	}
	catch (e) {

		try { shareData.Common.logger('Signal activity record failed (non-fatal): ' + ((e && e.message) ? e.message : e)); } catch (le) {}
	}
}


// Fire-and-forget wrapper used from the response hook: parse the outcome and record without awaiting, so
// the signal's own response is never delayed. Never throws.
function recordFromResponse(meta, body, httpStatus) {

	try {

		if (!meta) { return; }

		const outcome = parseOutcome(body);

		const latencyMs = (meta.received != null) ? (Date.now() - meta.received) : null;

		const extra = {
			'http_status': (typeof httpStatus === 'number') ? httpStatus : undefined,
			'latency_ms':  (typeof latencyMs === 'number') ? latencyMs : undefined
		};

		Promise.resolve(record(meta, outcome, extra)).catch(() => {});
	}
	catch (e) {}
}


// Apply the from/to date window to a query, identically for the activity LIST and its SUMMARY so the two
// can never report a different window for the same inputs (they had drifted: the list treated `to` as an
// inclusive whole day, the summary as an exact instant). One rule for both: a date-only `to` (midnight,
// no time-of-day — what the view's date picker sends) is inclusive of that whole day; a `to` that carries
// a time-of-day (a precise programmatic window) is used exactly. `from` is always an inclusive lower bound.
function applyDateWindow(query, filters) {

	const from = filters.from ? new Date(filters.from) : null;
	const to   = filters.to   ? new Date(filters.to)   : null;
	const fromOk = from && !isNaN(from.getTime());
	const toOk   = to   && !isNaN(to.getTime());

	if (!fromOk && !toOk) { return; }

	query['date'] = {};
	if (fromOk) { query['date']['$gte'] = from; }
	if (toOk) {
		const dateOnly = to.getUTCHours() === 0 && to.getUTCMinutes() === 0 && to.getUTCSeconds() === 0 && to.getUTCMilliseconds() === 0;
		if (dateOnly) { query['date']['$lt'] = new Date(to.getTime() + 86400000); }
		else { query['date']['$lte'] = to; }
	}
}


// Read side: return recent activity, newest first, with optional bot / action / outcome / date filters.
// Read-only aggregation; resolves the bot NAME from the current bots so the view can show it without the
// hot recording path paying for a lookup. Never throws — returns [] on any error.
async function getActivity(filters) {

	try {

		filters = filters || {};

		// Scope to THIS instance (Hub-shared DB may hold several instances' rows). Legacy rows are adopted
		// to this server_id at init, so nothing recorded before this feature is lost.
		const query = { 'server_id': serverId() };

		if (filters.botId && filters.botId !== 'Default' && filters.botId !== 'all') {

			query['bot_id'] = String(filters.botId);
		}

		if (filters.source && filters.source !== 'all' && filters.source !== 'Default') {

			query['source'] = sanitizeSource(filters.source);
		}

		if (filters.action && ACTIONS.indexOf(String(filters.action)) !== -1) {

			query['action'] = String(filters.action);
		}

		// Filter on the normalized outcome field directly, matching what is stored and offered in the view.
		if (filters.outcome && OUTCOMES.indexOf(String(filters.outcome)) !== -1) {

			query['outcome'] = String(filters.outcome);
		}

		applyDateWindow(query, filters);

		const maxResults = 500;

		const rows = await SignalActivity.find(query).sort({ 'date': -1 }).limit(maxResults).lean();

		// Resolve bot names once (read-only) so each row can display a friendly name.
		const botNameById = await botNameMap();

		return (rows || []).map(function (r) {

			return {
				'date':       r.date,
				'source':     r.source || 'other',
				'action':     r.action,
				'bot_id':     r.bot_id,
				'bot_name':   botNameById[r.bot_id] || '',
				'pair':       r.pair,
				'source_ip':  r.source_ip,
				'success':    r.success === true,
				'duplicate':  r.duplicate === true,
				'outcome':    deriveOutcome(r),
				'reason':     r.reason,
				'deal_id':    r.deal_id,
				'http_status': r.http_status,
				'latency_ms':  r.latency_ms,
				'signal_key':  r.signal_key,
				'signal_ts':   r.signal_ts
			};
		});
	}
	catch (e) {

		try { shareData.Common.logger('Signal activity query failed: ' + ((e && e.message) ? e.message : e)); } catch (le) {}

		return [];
	}
}


// Compact, aggregate summary of recent signal activity for the AI tools (and any programmatic caller):
// totals by outcome and action, the top rejection reasons with counts, average processing latency, and a
// few recent examples. Read-only; never throws. Accepts the same filters as getActivity plus a precise
// from/to window (Date or parseable string). Aggregates the most recent rows up to a generous cap so the
// figures are accurate for troubleshooting windows without returning hundreds of raw rows to the model.
async function summarize(filters) {

	try {

		filters = filters || {};

		const query = { 'server_id': serverId() };

		if (filters.botId && filters.botId !== 'Default' && filters.botId !== 'all') { query['bot_id'] = String(filters.botId); }
		if (filters.source && filters.source !== 'all' && filters.source !== 'Default') { query['source'] = sanitizeSource(filters.source); }
		if (filters.action && ACTIONS.indexOf(String(filters.action)) !== -1) { query['action'] = String(filters.action); }

		if (filters.outcome && OUTCOMES.indexOf(String(filters.outcome)) !== -1) { query['outcome'] = String(filters.outcome); }

		applyDateWindow(query, filters);

		const rows = await SignalActivity.find(query).sort({ 'date': -1 }).limit(2000).lean();

			const botNameById = await botNameMap();

		const byOutcome = {};
		const byAction = {};
		const bySource = {};
		const rejections = {};
		const latAll = [];
		const latBySource = {};
		const latByAction = {};

		(rows || []).forEach(function (r) {

			const oc = deriveOutcome(r);
			const src = r.source || 'other';

			byOutcome[oc] = (byOutcome[oc] || 0) + 1;
			byAction[r.action] = (byAction[r.action] || 0) + 1;
			bySource[src] = (bySource[src] || 0) + 1;

			if (oc === 'rejected' && r.reason) { rejections[r.reason] = (rejections[r.reason] || 0) + 1; }

			if (typeof r.latency_ms === 'number') {

				latAll.push(r.latency_ms);
				(latBySource[src] = latBySource[src] || []).push(r.latency_ms);
				(latByAction[r.action] = latByAction[r.action] || []).push(r.latency_ms);
			}
		});

		// Per-source / per-action latency so the split is diagnosable ("which source is slow, and how slow").
		const latencyOverall = latencyStats(latAll);
		const latencyBySource = {};
		for (const s in latBySource) { latencyBySource[s] = latencyStats(latBySource[s]); }
		const latencyByAction = {};
		for (const a in latByAction) { latencyByAction[a] = latencyStats(latByAction[a]); }

		const topRejectionReasons = Object.keys(rejections)
			.map(function (reason) { return { 'reason': reason, 'count': rejections[reason] }; })
			.sort(function (a, b) { return b.count - a.count; })
			.slice(0, 10);

		const recent = (rows || []).slice(0, 10).map(function (r) {
			return {
				'date':    r.date,
				'action':  r.action,
				'source':  r.source || 'other',
				'bot':     botNameById[r.bot_id] || r.bot_id || '',
				'pair':    r.pair,
				'outcome': deriveOutcome(r),
				'reason':  r.reason,
				'deal_id': r.deal_id
			};
		});

		return {
			'total':                 rows.length,
			'truncated':             rows.length >= 2000,
			'by_outcome':            byOutcome,
			'by_action':             byAction,
			'by_source':             bySource,
			'top_rejection_reasons': topRejectionReasons,
			'avg_latency_ms':        latencyOverall.avg,
			// Full latency picture for diagnosis: overall + per source + per action. Each is
			// { n, avg, p95, max, slow } in ms, where slow counts replies over the slow_over_ms threshold.
			// latency_ms is the time SymBot's webhook handler took to reply, which for an entry signal
			// includes waiting for the deal to open through the serial deal-start queue — so a source with a
			// high p95 / max / slow count is backing up behind that queue, not a network problem.
			'latency':               { 'slow_over_ms': SLOW_MS, 'overall': latencyOverall, 'by_source': latencyBySource, 'by_action': latencyByAction },
			'recent':                recent
		};
	}
	catch (e) {

		try { shareData.Common.logger('Signal activity summarize failed: ' + ((e && e.message) ? e.message : e)); } catch (le) {}

		return { 'total': 0, 'by_outcome': {}, 'by_action': {}, 'top_rejection_reasons': [], 'recent': [], 'error': 'query_failed' };
	}
}


// Render the Signal Activity page (read-only). Mirrors the deal-history view render.
async function viewActivity(req, res) {

	res.render('strategies/DCABot/SignalActivityView', { 'appData': shareData.appData });
}


// JSON API for the page's data (and for a plain curl client). Read-only.
async function apiActivity(req, res, sendResponse = true) {

	const q = (req && req.query) || {};

	const data = await getActivity({
		'botId':   q.botId,
		'source':  q.source,
		'action':  q.action,
		'outcome': q.outcome,
		'from':    q.from,
		'to':      q.to
	});

	const resObj = { 'date': new Date(), 'success': true, 'data': data };

	if (sendResponse) { res.send(resObj); }

	return resObj;
}


// Source-aware count prune: under the 30-day TTL time ceiling, keep at most `retentionFor(source)` of the
// most-recent rows PER (server_id, source), so a chatty channel (a busy 3CQS feed) can only ever evict its
// OWN oldest rows and never a rare Signal Bot entry. It DISCOVERS whatever sources actually exist for this
// instance (distinct), so it stays correct with no code change as sources are added, removed, or renamed —
// a new source is trimmed to its budget (or the default), a removed source's leftovers still age out, and a
// renamed one is just another discovered slug. Best-effort and fully guarded — a failure logs and is
// swallowed, and it runs off the request/trading path. Always resolves.
async function pruneOverflow() {

	try {

		if (!SignalActivity) { return; }

		const sid = serverId();

		// Only the sources this instance actually has rows for — the list is data-driven, never hardcoded.
		const sources = await SignalActivity.distinct('source', { 'server_id': sid });

		for (let i = 0; i < (sources || []).length; i++) {

			const src = sources[i];
			const budget = retentionFor(sanitizeSource(src));

			const scope = { 'server_id': sid, 'source': src };

			// Cheap fast-path: skip a source that is under its budget without a skip-scan.
			const count = await SignalActivity.countDocuments(scope);

			if (count <= budget) { continue; }

			// The date of the budget-th newest row for this source is the cutoff; its older rows are trimmed.
			const cutoff = await SignalActivity.find(scope).sort({ 'date': -1 }).skip(budget).limit(1).select('date').lean();

			if (cutoff && cutoff[0] && cutoff[0].date) {

				await SignalActivity.deleteMany({ 'server_id': sid, 'source': src, 'date': { '$lt': cutoff[0].date } });
			}
		}
	}
	catch (e) {

		try { shareData.Common.logger('Signal activity prune failed (non-fatal): ' + ((e && e.message) ? e.message : e)); } catch (le) {}
	}
}


// One-time, best-effort migration: adopt any legacy rows that predate server_id/source scoping into THIS
// instance so nothing recorded before this feature disappears from the (now server_id-scoped) view. Rows
// with no server_id are stamped with this instance's id; rows with no source get 'legacy'. Guarded and
// fire-and-forget. In a Hub shared-DB where several instances upgrade at once the first booter adopts the
// shared legacy rows — a best-effort guess (they carried no instance attribution to begin with) that is
// self-correcting as they age out under the 30-day TTL. Never throws.
async function adoptLegacyRows() {

	try {

		if (!SignalActivity) { return; }

		const sid = serverId();
		if (!sid) { return; }   // wait until server_id is known; init re-invokes are idempotent

		await SignalActivity.updateMany({ 'server_id': { '$in': [ null, '' ] } }, { '$set': { 'server_id': sid } });
		await SignalActivity.updateMany({ '$or': [ { 'source': { '$exists': false } }, { 'source': null }, { 'source': '' } ] }, { '$set': { 'source': 'legacy' } });

		// Backfill the normalized `outcome` on rows written before that field existed, so filtering by
		// outcome (e.g. "rejected") includes them too. deriveOutcome already handles their DISPLAY; this
		// makes the STORED value match so the query filter agrees. Mirrors deriveOutcome's logic as a
		// server-side pipeline update, and is idempotent (only touches rows that still have no outcome).
		await SignalActivity.updateMany(
			{ '$or': [ { 'outcome': { '$exists': false } }, { 'outcome': null }, { 'outcome': '' } ] },
			[ { '$set': { 'outcome': {
				'$cond': [ { '$eq': [ '$duplicate', true ] }, 'duplicate',
					{ '$cond': [ { '$eq': [ '$success', true ] },
						{ '$cond': [ { '$and': [ { '$ne': [ '$deal_id', null ] }, { '$ne': [ '$deal_id', '' ] } ] }, 'started', 'processed' ] },
						'rejected' ] } ] } } } ]
		);
	}
	catch (e) {

		try { shareData.Common.logger('Signal activity legacy adoption skipped (non-fatal): ' + ((e && e.message) ? e.message : e)); } catch (le) {}
	}
}


function init(obj) {

	shareData = obj;

	// One-time best-effort adoption of pre-scoping (legacy) rows into this instance, then an initial prune —
	// both fire-and-forget so boot is never blocked or broken.
	try { Promise.resolve(adoptLegacyRows()).then(function () { return pruneOverflow(); }).catch(function () {}); } catch (e) {}

	// Keep each source under its per-(server_id, source) budget periodically (best-effort, unref'd so it
	// never keeps the process alive, and fire-and-forget so a slow prune can never block anything). The
	// 30-day TTL index is the hard time ceiling; this keeps a chatty source from crowding out a quiet one.
	try {

		const pruneTimer = setInterval(function () { Promise.resolve(pruneOverflow()).catch(function () {}); }, PRUNE_INTERVAL_MS);
		if (pruneTimer && pruneTimer.unref) { pruneTimer.unref(); }
	}
	catch (e) {}

	// Boot-time integrity check (warn-only, via the central Watchdog): the webhook recorder depends on
	// metaFromRequest still recognizing the canonical Signal Bot command paths. If a refactor breaks that
	// recognizer, inbound signals would silently stop being logged — this catches it at boot. It costs
	// nothing (pure string checks) and touches no trading state.
	try {

		if (shareData.Watchdog && typeof shareData.Watchdog.register === 'function') {

			shareData.Watchdog.register('signal_activity_recognizer', function () {

				const findings = [];

				const cases = [
					['/api/bots/B1/start_deal', 'entry'],
					['/api/bots/B1/add_funds',  'add_funds'],
					['/api/bots/B1/close',      'close'],
					['/api/bots/B1/panic_sell', 'panic_sell']
				];

				for (let i = 0; i < cases.length; i++) {

					let m = null;

					try { m = metaFromRequest({ 'body': {}, 'headers': {} }, cases[i][0]); } catch (e) {}

					if (!m || m.action !== cases[i][1]) {

						// Set the action explicitly (rather than leaning on the runner's default 'watchdog.<name>')
						// so this code is discoverable to the Diagnostics catalog-coverage test like every other check.
						findings.push({ 'action': 'watchdog.signal_activity_recognizer', 'target': cases[i][0], 'detail': 'Signal Activity recognizer no longer maps ' + cases[i][0] + ' to "' + cases[i][1] + '"; inbound signals may not be logged' });
					}
				}

				return findings;
			});
		}
	}
	catch (e) {}
}


module.exports = {

	init,
	metaFromRequest,
	recordFromResponse,
	getActivity,
	summarize,
	viewActivity,
	apiActivity,

	// exported for tests
	parseOutcome,
	classifySource,
	sanitizeSource,
	retentionFor,
	latencyStats,
	ACTIONS
};