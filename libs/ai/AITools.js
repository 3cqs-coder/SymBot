'use strict';


// Read-only tool registry for the AI chat's tool-calling loop.
//
// The model, when tool-calling is enabled, can ask for exactly the deal / log
// data it needs instead of relying on the AIContext router to guess and prepend
// it. Every tool here is STRICTLY READ-ONLY: it reads deals and logs and nothing
// else. There is deliberately no tool that can pause, cancel, sell, or modify
// anything — trade-affecting capabilities are simply not registered, so the loop
// cannot take an action even if the model asks for one.
//
// Each tool is { name, description, parameters (JSON schema), handler(args) }.
// listSchemas() emits the provider-neutral function schema the adapters pass to
// Ollama/OpenAI; execute() dispatches by name and returns a compact object that
// the loop serializes into a role:'tool' message.


const DealQuery = require('../queries/DealQuery');
const LogScan   = require('../queries/LogScan');


// Cap the serialized size of any single tool result so a runaway query cannot blow the model's
// context. The underlying queries already cap rows / entries, so this is a backstop, not the primary
// limiter. Sized to comfortably hold a full default page of open deals AND a detail-rich result (an
// error summary now carries example lines + first/last-seen per type, an incident carries category
// roll-ups, a deal timeline carries findings) — ~12k chars ≈ 3k tokens. A genuinely oversized result
// (e.g. an internal cap bypassed) still trips it and asks the user to narrow the question.
const MAX_RESULT_CHARS = 12000;
const DEFAULT_DEAL_LIMIT = 15;
const DEFAULT_LOG_LINES = 80;

// A chat tool answers with counts/totals plus a REPRESENTATIVE sample of raw lines/rows — never a
// full dump, which only bloats the result and can trip the size guard (yielding an unusable
// {note,partial}). Cap the raw list a tool hands back to this many, and report the true total
// alongside so nothing is silently hidden. The user can always ask for a specific deal/day to drill in.
const RESULT_LINE_CAP = 40;

function capLines(lines, n) {
	const a = Array.isArray(lines) ? lines : [];
	const lim = n || RESULT_LINE_CAP;
	return (a.length > lim) ? a.slice(0, lim) : a;
}
const MAX_DEALS_FOR_COUNT = 1000;


// Concept → the phrases SymBot actually writes to its logs. A user says "errors"
// or "insufficient funds"; the log says "An error occurred" or "InsufficientFunds".
// search_logs expands a matching concept into these real phrases so a plain-language
// question stops missing events it should have found. Kept as substrings so matching
// stays a byte comparison in LogScan.
const LOG_CONCEPTS = {
	'insufficient funds': [ 'InsufficientFunds', 'not have enough funds' ],
	'circuit breaker':    [ 'CIRCUIT BREAKER' ],
	'cancel':             [ 'Exchange-cancelled' ],
	'invalid order':      [ 'Invalid order', 'Invalid base order' ],
	'finished':           [ 'DCA Bot Finished' ],
	'completed':          [ 'DCA Bot Finished' ],
	'recalculat':         [ 'Recalculating orders' ],
	'resuming':           [ 'Resuming' ],
	'terminat':           [ 'terminating' ],
	'paus':               [ 'Pausing any further' ],
	'max safety':         [ 'Max safety orders used' ],
	'disconnect':         [ 'Client Disconnected', 'Disconnected' ],
	'error':              [ 'An error occurred', 'InsufficientFunds', 'Invalid order', 'Invalid base order', 'retries exhausted', 'no pending order ID' ]
};


let shareData;

// Set by AIClient: consults a stronger reasoning model, single-shot, no tools.
let expertFn = null;
function setExpert(fn) { expertFn = fn; }

// Set by AIClient: runs a focused research SUB-AGENT — its own bounded tool-calling loop
// over the same read-only tools (minus `explore` itself, so it cannot recurse) — and
// returns a synthesized answer string. Lets the model delegate a broad, multi-step
// investigation without flooding the main conversation with every intermediate lookup.
let subAgentFn = null;
function setSubAgent(fn) { subAgentFn = fn; }

// True while an explore sub-agent run is in progress. Enforced at the execution seam (below) so a
// nested/structured `explore` tool call can never recurse, independent of which tools were
// advertised to the model.
let exploreActive = false;

// Whether the explore sub-agent is enabled in config. It is expensive (a nested loop of
// model calls), so it is exposed to the model only when explicitly turned on.
function exploreEnabled() {
	const t = shareData && shareData.appData && shareData.appData.ai && shareData.appData.ai.tools;
	return !!(t && (t.explore === true || t.explore === 'true'));
}


// Cap for DEAL-date windows (orderWindow: performance, top-deals, pair/bot performance, order
// counts). Deal queries filter an indexed sellData.date and are cheap, so this is generous
// enough to cover "this year" / "last couple of years" instead of silently truncating them to a
// quarter. The LOG tools do NOT use this — they cap their own window separately (recentDates),
// because scanning many days of log files is expensive.
const MAX_WINDOW_DAYS = 1461;   // ~4 years
const DAY_MS = 24 * 60 * 60 * 1000;


// Parse a day argument to YYYY-MM-DD. Tolerant of a full ISO datetime (the model
// sometimes sends "2026-08-13T00:00:00.000Z") by taking the leading date. Returns
// null when there is no usable date.
function parseDay(v) {

	if (typeof v !== 'string') { return null; }

	const s = v.trim().slice(0, 10);

	return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}


// Canonicalise a trading pair. The model often derives "W_USD" from a deal id, but
// the stored pair is "W/USD"; also upper-cases so a lower-case pair still matches.
function normPair(pair) {

	const s = String(pair || '').trim();

	if (s === '') { return ''; }

	return (s.indexOf('/') !== -1 ? s : s.replace('_', '/')).toUpperCase();
}


// Tolerant boolean-argument reader. Models frequently send booleans as the strings
// "true"/"True"/"false" rather than JSON booleans, so a strict === true check would
// silently ignore the flag (e.g. active_only, completed_only).
function truthyArg(v) {

	return v === true || v === 1 || v === '1' || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
}


// Reduce a full deal summary to the fields a list needs, so a page of deals stays
// well under the tool-result size cap (the verbose per-deal detail is available from
// get_deal for a single deal).
function compactDeal(d) {

	if (!d || typeof d !== 'object') { return d; }

	return {
		dealId: d.dealId, pair: d.pair, botName: d.botName,
		safetyOrdersUsed: d.safetyOrdersUsed, safetyOrdersMax: d.safetyOrdersMax,
		averagePrice: d.averagePrice, targetPrice: d.targetPrice,
		// Live state for active deals (present when the deal tracker has a fresh price) so a
		// per-deal answer ("how far underwater", "current price", "close to take-profit") is grounded.
		currentPrice: d.currentPrice, unrealizedPct: d.unrealizedPct, unrealizedPnl: d.unrealizedPnl,
		inProfit: d.inProfit, pctToTakeProfit: d.pctToTakeProfit, readyToTakeProfit: d.readyToTakeProfit,
		paused: d.paused, updated: d.updated,
		profitPercent: d.profitPercent, profitQuote: d.profitQuote
	};
}


// When a DealQuery result signals a DATA-LAYER FAILURE (success === false — e.g. the DB accessor was
// unavailable or a query threw and was caught), return an EXPLICIT "unavailable" marker instead of the
// tool's empty list. Otherwise a transient failure reaches the model as an authoritative "you have
// zero deals / bots", which a small model may then state as fact. Same anti-fabrication guard as
// get_balance. Returns null when the result is fine, so callers do `return failGuard(r) || {...}`.
function failGuard(r) {
	if (r && r.success === false) {
		return {
			available: false,
			error: r.error || 'data unavailable',
			note: 'The underlying data query failed — this is NOT a real zero/empty result. Tell the user the data is temporarily unavailable right now; do NOT report empty or invent figures.'
		};
	}
	return null;
}


// Parse a flexible UTC boundary: a full ISO timestamp, or a bare YYYY-MM-DD anchored to the
// START or END of that day (so a to-date is inclusive of the whole day). Returns null if absent
// or unparseable.
function parseBoundary(v, edge, tz) {

	if (v == null || v === '') { return null; }

	const s = String(v).trim();

	// Bare calendar day → start/end of that day IN timezone `tz` (UTC when unset), so "from 2026-06-01"
	// means the START of that day in the user's zone, not a fixed UTC instant.
	if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {

		const range = zonedDayRange(s, tz);
		return range ? (edge === 'end' ? range.to : range.from) : null;
	}

	const d = new Date(s);
	return isNaN(d.getTime()) ? null : d;
}


// Resolve a UTC time window from the model's arguments. Precedence: an explicit from/to range
// (arbitrary window — "between X and Y", "the previous week", a named month) wins; then a single
// UTC day; otherwise the last N days. A one-sided range is allowed (open start or open end).
// Is an optional argument actually SET? Small local models routinely emit the literal string "null"
// (or ""/"undefined"/"none"/"nan") for parameters they mean to leave blank; a naive truthiness check
// treats "null" as a real value. This normalizes all of those — plus real null/undefined — to "absent",
// so an unspecified period reliably means all-time instead of a garbage 1-day window. Single exit.
function argPresent(v) {

	let present = false;

	if (v != null) {
		const s = String(v).trim().toLowerCase();
		present = (s !== '' && s !== 'null' && s !== 'undefined' && s !== 'none' && s !== 'nan');
	}

	return present;
}

// The clean value of an optional arg, or undefined when it is absent (see argPresent).
function argVal(v) { return argPresent(v) ? v : undefined; }

function orderWindow(args) {

	args = args || {};
	const tz = argTz(args);   // the user's timezone (UTC by default), so a named day means the USER's day

	// Clean small-model "null"-string noise before parsing so a blank period never becomes a real window.
	const cFrom = argVal(args.from) != null ? args.from : argVal(args.start_date);
	const cTo   = argVal(args.to)   != null ? args.to   : argVal(args.end_date);
	const cDate = argVal(args.date);
	const cDays = argVal(args.days);

	let rFrom = parseBoundary(cFrom, 'start', tz);
	let rTo = parseBoundary(cTo, 'end', tz);

	if (rFrom || rTo) {

		// A reversed range ("from 2026-08-15 to 2026-08-10") is almost always the same span written
		// backwards, not an intentionally-empty window — swap the ends so it returns the data the user
		// meant instead of silently matching nothing.
		if (rFrom && rTo && rFrom.getTime() > rTo.getTime()) { const t = rFrom; rFrom = rTo; rTo = t; }

		return {
			from: rFrom || new Date('2000-01-01T00:00:00.000Z'),
			to: rTo || new Date()
		};
	}

	const day = parseDay(cDate);

	if (day) {

		// Honor the EXACT day the user named (in their timezone), however far in the past or future. A
		// future or long-ago date simply yields no matching deals (an honest empty result the caller can
		// report as "no data for that date") — it must NEVER silently fall back to "today", which would
		// misattribute today's activity to the date the user actually asked about.
		const range = zonedDayRange(day, tz);

		if (range && !isNaN(range.from.getTime())) {

			return range;
		}
	}

	const days = Math.min(Math.max(parseInt(cDays, 10) || 1, 1), MAX_WINDOW_DAYS);
	const to = new Date();
	const from = new Date(to.getTime() - (days * DAY_MS));

	return { from, to };
}


// Build a deal-date window ONLY when the user actually named a period; otherwise null (= all-time).
// Centralizes the guard several performance tools repeated verbatim, and — crucially — uses argPresent
// so a small model's "null"-string arguments don't silently collapse "most profitable pair EVER" into a
// one-day window that returns nothing. Single exit.
function windowIfNamed(args) {

	let win = null;

	if (args && (argPresent(args.date) || argPresent(args.days) || argPresent(args.from) || argPresent(args.to) || argPresent(args.start_date) || argPresent(args.end_date))) {
		win = orderWindow(args);
	}

	return win;
}


// One local date string, matching how the log file names are built (so a date derived
// here cannot drift from the file it was written under). Falls back to a UTC slice if
// Common isn't wired yet.
// The YYYY-MM-DD date of an instant in timezone `tz` (an IANA name), or the SERVER-local date when tz is
// omitted (used for FILE selection, since the logger names each day's file by the server's local date).
// Reuses the shared Common helper. Single exit.
function localDateStr(d, tz) {

	if (shareData && shareData.Common && typeof shareData.Common.zonedDateStr === 'function') {

		return shareData.Common.zonedDateStr(d, tz);
	}

	return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
}

// The request's timezone: the IANA name the browser sent (injected as args._tz by execute), VALIDATED,
// or 'UTC' when it is absent or unrecognized — a deterministic default that never depends on where the
// server happens to run. Callers thread it so "today"/"this month"/"on the 10th" mean the USER's day.
function argTz(args) {

	const raw = (args && typeof args._tz === 'string') ? args._tz.trim() : '';
	if (raw === '') { return 'UTC'; }

	if (shareData && shareData.Common && typeof shareData.Common.normalizeTimeZone === 'function') {
		return shareData.Common.normalizeTimeZone(raw) || 'UTC';   // invalid zone → deterministic UTC
	}

	return raw;
}

// The UTC [from,to] Date span of the local calendar day `dateStr` in timezone `tz` (reuses the shared
// Common helper; falls back to a literal-UTC day if Common isn't wired yet). Single exit.
function zonedDayRange(dateStr, tz) {

	if (shareData && shareData.Common && typeof shareData.Common.zonedDayRangeUTC === 'function') {

		return shareData.Common.zonedDayRangeUTC(dateStr, tz);
	}

	const p = String(dateStr || '').split('-').map(Number);
	return (p.length === 3 && !p.some(isNaN))
		? { from: new Date(Date.UTC(p[0], p[1] - 1, p[2], 0, 0, 0, 0)), to: new Date(Date.UTC(p[0], p[1] - 1, p[2], 23, 59, 59, 999)) }
		: null;
}


// The most recent dates (today first) in timezone `tz`. `def` is the count used when `days` is
// unset/invalid; `max` is the hard cap that keeps one question from walking the whole archive.
function recentDates(days, def, max, tz) {

	const count = Math.min(Math.max(parseInt(days, 10) || (def || 1), 1), (max || 3));
	const now = Date.now();
	const out = [];

	for (let i = 0; i < count; i++) { out.push(localDateStr(new Date(now - i * DAY_MS), tz)); }

	return out;
}


// Dates to scan for a log question: an exact day when given (isolates that one day), else the recent N
// days — both resolved in the request's timezone, so "yesterday" means the USER's yesterday.
function datesFor(args) {

	// An explicit list of YYYY-MM-DD dates (already resolved in the caller's timezone) wins — this is how a
	// relative-day phrase like "two days ago" or "yesterday and the day before" pins the scan to those exact
	// days rather than the last-N-days range that `days` expresses.
	if (Array.isArray(args && args.dates) && args.dates.length) {
		const valid = args.dates.filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
		if (valid.length) { return Array.from(new Set(valid)).slice(0, 14); }
	}

	const day = parseDay(args && args.date);
	const daysNum = (args && args.days != null) ? parseInt(args.days, 10) : NaN;

	// A single named date pins the window to that one day — UNLESS the caller ALSO asked for a multi-day
	// range (days > 1), which is the "last few days" intent. Small models sometimes emit BOTH: a spurious
	// single `date` (often echoing the "yesterday was YYYY-MM-DD" note) alongside days > 1, which used to
	// silently shrink a "last 3 days" scan to that one day and undercount. When both are present the RANGE
	// wins; a lone date (no days, or days = 1) is still honored exactly.
	if (day && !(Number.isFinite(daysNum) && daysNum > 1)) { return [ day ]; }

	return recentDates(args && args.days, 1, 3, argTz(args));
}

// The `count` dates immediately BEFORE the earliest of `targetDates` — the "normal" baseline window for
// the error-baseline comparison — in timezone `tz`.
function baselineDatesBefore(targetDates, count, tz) {

	const n = Math.min(Math.max(parseInt(count, 10) || 3, 1), 7);
	const earliest = (targetDates && targetDates.length) ? targetDates[targetDates.length - 1] : localDateStr(new Date(), tz);
	const start = new Date(earliest + 'T12:00:00.000Z');   // noon anchor avoids a tz-edge date slip
	const out = [];

	for (let i = 1; i <= n; i++) { out.push(localDateStr(new Date(start.getTime() - i * DAY_MS), tz)); }

	return out;
}


// Build the { targetDates, baselineDates } windows for an error-baseline comparison from the same
// flexible args the analyze_error_baseline tool accepts ({ days | date, baseline_days }): the TARGET
// window (today / last N days, or an explicit UTC date) and the N days immediately BEFORE it that
// count as "normal". Factored out so the tool and the scheduled watchdog frame the comparison
// identically — one definition of "today vs the prior N days", using the log-file-aligned dates.
function errorBaselineWindows(args) {

	const targetDates = datesFor(args || {});
	const baselineDates = baselineDatesBefore(targetDates, args && args.baseline_days, argTz(args));
	return { targetDates: targetDates, baselineDates: baselineDates };
}


// Which log dates to search for a specific deal. An explicit date/days wins; with
// neither, search around the deal's last activity (updatedAt) rather than today — a
// paused or idle deal's events are on the day it last acted, so defaulting to today
// would report "no events" for a deal that simply hasn't traded recently.
async function dealLogDates(dealId, args) {

	const day = parseDay(args && args.date);

	if (day) { return [ day ]; }

	if (args && args.days) {

		return recentDates(args.days);
	}

	try {

		const r = await DealQuery.getDeal(dealId);
		const deal = r && r.deals && r.deals[0];
		// Prefer the deal's true last-activity day (close day for a completed deal) over raw
		// updatedAt, which a fleet-wide re-save (e.g. a convert-to-sandbox restore) can push to
		// "today" — that would default an old deal's log search to today and find nothing.
		const upd = deal && (deal.lastActivity || deal.updated);

		if (upd) {

			const dt = new Date(upd);

			// Use the LOCAL date (localDateStr → the same getDateParts the logger uses to NAME the files),
			// not the UTC date: on a non-UTC host a UTC date can point at the wrong day's log file and find
			// no events for a deal that has them. This matches recentDates/datesFor, which are already local.
			if (!isNaN(dt.getTime())) { return [ localDateStr(dt) ]; }
		}
	}
	catch (e) { /* fall through to recent */ }

	return recentDates(1);
}


async function instanceName() {

	if (shareData && shareData.Common && typeof shareData.Common.getInstanceName === 'function') {

		try { return (await shareData.Common.getInstanceName()) || ''; }
		catch (e) { return ''; }
	}

	return ('');
}


// ── Tool definitions ────────────────────────────────────────────────────────
// ── Read-only tools ──────────────────────────────────────────────────────────
// Tool SCHEMAS (name / description / parameters / examples) live as DATA in
// ./data/tools.json — the provider-neutral tool contract the model sees. The executable
// HANDLERS (the read-only logic) stay here in code and are joined to their schema by name. A
// boot Watchdog check ('tool_schema_parity') enforces that every schema has a handler and every
// handler has a schema, so the two halves can never silently drift.
const TOOL_SCHEMAS = require('./data/tools.json');
const SCHEMA_BY_NAME = TOOL_SCHEMAS.reduce((m, s) => { m[s.name] = s; return m; }, {});

const TOOL_HANDLERS = [
	{
		name: "list_open_deals",
		handler: async (args) => {
			// Fetch all open deals (they are bounded) so the count is accurate, then show a
			// compact page (honoring the requested limit) so the result stays under the size cap.
			const limit = Math.max(1, Math.min(Number(args && args.limit) || 15, 50));
			const r = await DealQuery.getActiveDeals(100);
			const bad = failGuard(r); if (bad) { return bad; }
			const deals = (r.deals || []).map(compactDeal);
			const openTotal = r.count != null ? r.count : deals.length;
			// Authoritative per-BOT rollup of OPEN deals, computed from the full fetched set (not the shown
			// page), so "how many open deals does each bot have?" / "which bot has the most open deals?" can be
			// rendered deterministically instead of reaching the model loop (observed to hang, and to invent a
			// bot). Sorted most-deals-first; capped flag set if the fetch itself hit its bound.
			const counts = new Map();
			for (const d of deals) { const b = d.botName || '(unnamed bot)'; counts.set(b, (counts.get(b) || 0) + 1); }
			const by_bot = [ ...counts.entries() ].map(([botName, count]) => ({ botName, count }))
				.sort((a, b) => b.count - a.count || a.botName.localeCompare(b.botName));
			return { open_deals: deals.slice(0, limit), count: openTotal, open_deals_total: openTotal, shown: Math.min(deals.length, limit), by_bot, by_bot_capped: deals.length >= 100 };
		}
	},

	{
		name: "get_deal",
		handler: async (args) => {
			const r = await DealQuery.getDeal(String(args.deal_id || '').trim());
			// A data-layer failure must never read as an authoritative "no such deal" — without this the
			// {found:false} result looks like a strong answer and the model tells the user the deal does not
			// exist. Surface the unavailable marker instead (also the Hub case, where the deal accessor is absent).
			return failGuard(r) || { deal: (r.deals && r.deals[0]) || null, found: (r.count || 0) > 0 };
		}
	},

	{
		name: "list_recent_completed_deals",
		handler: async (args) => {
			const limit = Math.min(parseInt(args.limit, 10) || DEFAULT_DEAL_LIMIT, 18);
			const r = await DealQuery.getRecentDeals(null, null, limit);
			const deals = (r.deals || []).map(compactDeal);
			return failGuard(r) || { completed_deals: deals, count: deals.length };
		}
	},

	{
		name: "get_deals_for_pair",
		handler: async (args) => {
			const pair = normPair(args.pair);
			const limit = Math.min(parseInt(args.limit, 10) || DEFAULT_DEAL_LIMIT, 18);
			const win = windowIfNamed(args);
			const r = await DealQuery.getDealsByPair(pair, truthyArg(args.completed_only), limit, win);
			// `count` is the TRUE number of matching deals for the pair (not the truncated sample); `shown`
			// is how many are listed below it. So "how many deals for X" answers with the real total.
			const shown = (r.deals || []).length;
			return failGuard(r) || { pair, window: win ? { from: win.from.toISOString(), to: win.to.toISOString() } : null, deals: (r.deals || []).map(compactDeal), count: (r.total != null ? r.total : (r.count || 0)), shown };
		}
	},

	{
		name: "get_paused_deals",
		handler: async (args) => {
			const limit = Math.min(parseInt(args.limit, 10) || DEFAULT_DEAL_LIMIT, 18);
			const r = await DealQuery.getPausedDeals(null, limit);
			return failGuard(r) || { paused_deals: r.deals || [], count: r.count || 0 };
		}
	},

	{
		name: "get_signal_activity",
		handler: async (args) => {
			// Read-only summary of inbound Signal Bot signals (TradingView / 3CQS / any webhook) and what
			// SymBot did with each: counts by outcome and action, the top rejection reasons, average
			// processing latency, and a few recent examples. This is the tool for "did my signal/alert
			// arrive?", "why didn't a deal open for X?", "how many signals were rejected and why?".
			const SA = shareData && shareData.SignalActivity;

			if (!SA || typeof SA.summarize !== 'function') {

				// The Hub has no trading connection and does not record signals; degrade clearly rather
				// than look like an authoritative "no activity".
				return { unavailable: true, note: 'Signal activity is not available on this instance.' };
			}

			const filters = {};

			if (argPresent(args.action))  { filters.action  = String(args.action).trim().toLowerCase(); }
			if (argPresent(args.outcome)) { filters.outcome = String(args.outcome).trim().toLowerCase(); }
			if (argPresent(args.source))  { filters.source  = String(args.source).trim().toLowerCase(); }

			// Resolve an optional bot NAME or id to the stored bot id so a natural-language bot reference filters.
			if (argPresent(args.bot)) {

				let resolved = String(args.bot);

				try {
					const bots = (shareData.DCABot && typeof shareData.DCABot.getBots === 'function') ? await shareData.DCABot.getBots() : [];
					const m = (bots || []).find(b => b && (b.botId === args.bot || (b.botName || '').toLowerCase() === String(args.bot).toLowerCase()));
					if (m) { resolved = m.botId; }
				}
				catch (e) {}

				filters.botId = resolved;
			}

			const win = windowIfNamed(args);
			if (win) { filters.from = win.from; filters.to = win.to; }

			return await SA.summarize(filters);
		}
	},

	{
		name: "search_logs",
		handler: async (args) => {
			const raw = String(args.query || '').trim();

			// Explicit multi-term queries split on comma or pipe.
			let needles = raw.split(/[|,]/).map(s => s.trim()).filter(Boolean);

			// Expand any recognized concept into the phrases SymBot really logs.
			const lc = raw.toLowerCase();
			for (const concept of Object.keys(LOG_CONCEPTS)) {
				if (lc.includes(concept)) { needles.push(...LOG_CONCEPTS[concept]); }
			}

			// De-duplicate; fall back to the raw query when nothing expanded.
			needles = Array.from(new Set(needles.length ? needles : [ raw ])).filter(Boolean);

			const context = (args.context != null && !isNaN(parseInt(args.context, 10))) ? args.context : 1;

			const r = await LogScan.scanLogs({
				needles,
				dates: datesFor(args),
				instanceName: await instanceName(),
				maxLines: DEFAULT_LOG_LINES,
				context
			});

			// Keep the result within the model's size budget: a busy log can match far more
			// lines than fit, and an over-budget result gets truncated to nothing. Show the
			// most RECENT matching lines (logs are chronological — recent is most relevant for
			// "what happened / any errors") that fit, and report the true total.
			const allLines = r.lines || [];
			const LINES_BUDGET = 4500;

			let kept = allLines;
			if (allLines.length) {
				const picked = [];
				let used = 0;
				for (let i = allLines.length - 1; i >= 0; i--) {
					const sz = String(allLines[i]).length + 2;
					if (picked.length >= 1 && (used + sz) > LINES_BUDGET) { break; }
					picked.unshift(allLines[i]);
					used += sz;
				}
				kept = picked;
			}

			const note = kept.length < allLines.length
				? ('Showing the ' + kept.length + ' most recent matching lines of ' + allLines.length + ' found. Matches include surrounding context lines; an event\'s deal is often on the adjacent line.')
				: 'Matches include surrounding context lines; an event\'s deal is often on the adjacent line.';

			return { matches: kept, match_count: r.matchCount != null ? r.matchCount : allLines.length, shown: kept.length, lines_total: allLines.length, note: note, terms_used: needles, truncated: !!r.truncated };
		}
	},

	{
		name: "analyze_logs",
		handler: async (args) => {
			const terms = String(args.terms || '').split(/[|,]/).map(s => s.trim()).filter(Boolean);
			const r = await LogScan.analyzeLogs({
				terms,
				mode: args.mode,
				group_by: args.group_by,
				from: args.from, to: args.to,
				dates: (args.from || args.to) ? undefined : datesFor(args),
				instanceName: await instanceName()
			});
			// list mode can return a long run of matching lines; keep a representative page and report
			// the true total (total_matches already carries the real count) so the result stays compact.
			if (r && Array.isArray(r.lines) && r.lines.length > RESULT_LINE_CAP) {
				r.lines_total = r.lines.length;
				r.lines = capLines(r.lines);
				r.lines_shown = r.lines.length;
			}
			return r;
		}
	},

	{
		name: "get_events_in_window",
		handler: async (args) => {
			// `windows` (an array of [{from,to}]) and `errors_only` are internal extensions used by the
			// deterministic time-of-day BAND search; the model-facing schema only exposes from/to.
			const r = await LogScan.getEventsInWindow({ from: args.from, to: args.to, windows: args.windows, errors_only: args.errors_only, instanceName: await instanceName() });
			const all = r.lines || [];
			const events = capLines(all);   // representative page; event_count keeps the true total
			return { events, event_count: r.matchCount != null ? r.matchCount : all.length, shown: events.length, matched_lines: all.length, files: r.files, truncated: !!r.truncated || events.length < all.length };
		}
	},

	{
		name: "find_incident",
		handler: async (args) => await LogScan.findIncident({ around: args.around, window_minutes: args.window_minutes, instanceName: await instanceName() })
	},

	{
		name: "scan_price_anomalies",
		handler: async (args) => {
			const r = await LogScan.scanPriceAnomalies({
				from: args.from, to: args.to,
				dates: (args.from || args.to) ? undefined : datesFor(args),
				instanceName: await instanceName()
			});
			// Keep a representative page of flagged lines; anomalies_found keeps the true total.
			if (r && Array.isArray(r.lines) && r.lines.length > RESULT_LINE_CAP) {
				r.lines_total = r.lines.length;
				r.lines = capLines(r.lines);
				r.lines_shown = r.lines.length;
			}
			return r;
		}
	},

	{
		name: "count_orders",
		handler: async (args) => {
			const win = orderWindow(args);
			const r = await DealQuery.getOrderCounts(win.from, win.to, normPair(args.pair), MAX_DEALS_FOR_COUNT);
			const bad = failGuard(r); if (bad) { return Object.assign({ window: { from: win.from.toISOString(), to: win.to.toISOString() } }, bad); }
			return {
				window: { from: win.from.toISOString(), to: win.to.toISOString() },
				pair: args.pair || null,
				base_orders: r.base_orders || 0,
				safety_orders: r.safety_orders || 0,
				total_orders: r.total_orders || 0,
				deals_with_safety_orders: r.deals_with_safety_orders || 0,
				deals_scanned: r.deals_scanned || 0,
				scan_capped: !!r.scan_capped,
				// Authoritative per-deal breakdown (most safety orders first). Answers
				// "which deals" directly — do not re-derive counts from anything else.
				by_deal: r.by_deal || [],
				// Authoritative per-BOT rollup. Answers "how many orders did each bot place"
				// directly — do not infer a bot from the per-deal list.
				by_bot: r.by_bot || []
			};
		}
	},

	{
		name: "compare_deal_to_baseline",
		handler: async (args) => await DealQuery.compareDealOutcome(args.deal_id, args.baseline_count)
	},

	{
		name: "diagnose_deal",
		handler: async (args) => {
			const id = String(args.deal_id || '').trim();
			const dq = await DealQuery.getDeal(id);
			const deal = (dq.deals && dq.deals[0]) || null;
			const dates = await dealLogDates(id, args);
			const ev = await LogScan.getDealEvents(id, dates, await instanceName(), DEFAULT_LOG_LINES);

			// Compute EXPLICIT concerns from the deal's own fields, so the answer is a real diagnosis
			// rather than the model glancing at raw events and declaring "no issues". Each concern is a
			// plain finding the model can report as-is; an empty list genuinely means the deal looks healthy.
			const concerns = [];
			if (deal) {
				// OPEN-deal concerns describe present-tense state (paused, ladder room, age). They must NOT
				// fire on a COMPLETED deal — a closed deal cannot be paused, add safety orders, or "wait for
				// recovery", and a normal successful deal that used its whole ladder would otherwise be
				// wrongly flagged as EXHAUSTED. A closed deal is diagnosed on its OUTCOME instead.
				const isOpen = deal.status !== 'complete';
				if (isOpen) {
					if (deal.paused || deal.pausedBuy || deal.pausedSell) {
						concerns.push('The deal is PAUSED' + (deal.pauseReason ? ' (reason: ' + deal.pauseReason + ')' : '') + ' — it will not add safety orders or take profit until resumed.');
					}
					const days = (typeof deal.openForMins === 'number') ? deal.openForMins / 1440 : null;
					if (days != null && days > 30) {
						concerns.push('Open for a long time (' + Math.round(days) + ' days) — a position this old is likely stagnating well below its target.');
					}
					if (deal.ladderExhausted === true) {
						concerns.push('The safety-order ladder is EXHAUSTED (' + deal.safetyOrdersUsed + ' of ' + deal.safetyOrdersMax + ' used) — no further safety orders can be placed to lower the average, so the deal can only wait for price to recover to its target.');
					}
					else if (deal.safetyOrdersMax > 0 && (deal.safetyOrdersUsed / deal.safetyOrdersMax) >= 0.8) {
						concerns.push('Safety orders are nearly exhausted (' + deal.safetyOrdersUsed + ' of ' + deal.safetyOrdersMax + ' used).');
					}
				}
				else if (deal.profitable === false) {
					concerns.push('This deal is CLOSED and finished at a LOSS' + (deal.profitQuote != null ? ' (' + deal.profitQuote + (deal.profitCurrency ? ' ' + deal.profitCurrency : '') + (deal.profitPercent != null ? ', ' + deal.profitPercent + '%' : '') + ')' : '') + '.');
				}
			}
			const errorEvents = (ev.lines || []).filter(l => /\b(error|fail(ed|ure)?|exception|unable|invalid|timeout|rejected)\b/i.test(String(l)));
			if (errorEvents.length) {
				concerns.push(errorEvents.length + ' error-like log event(s) in the searched window — see events for detail.');
			}

			return {
				deal, found: !!deal,
				concerns, has_concerns: concerns.length > 0,
				assessment: !deal
					? 'No deal matched that id. If you were given a DESCRIPTION rather than an exact deal id (e.g. "my oldest deal", "the riskiest one", "my worst position"), do NOT report "not found" — first call the right lookup to get the exact dealId (find_oldest_open_deals for the oldest, get_open_risk_summary or get_top_deals for the riskiest/worst), then call diagnose_deal again with that id.'
					: (deal.status === 'complete'
						? (concerns.length ? 'This deal is CLOSED (it finished at a loss — see concerns).' : 'This deal is CLOSED and finished in profit — there is nothing to fix; report its outcome.')
						: (concerns.length ? 'This deal has one or more concerns (listed in concerns).' : 'No structural concerns detected from the deal record; report it as looking healthy.')),
				events: ev.lines || [], event_count: (ev.lines || []).length, truncated: !!ev.truncated
			};
		}
	},

	{
		name: "analyze_error_baseline",
		handler: async (args) => {
			const { targetDates, baselineDates } = errorBaselineWindows(args);
			const r = await LogScan.getErrorBaselineDiff(targetDates, baselineDates, await instanceName(), argTz(args));
			return Object.assign({ target_dates: targetDates, baseline_dates: baselineDates }, r);
		}
	},

	{
		name: "summarize_recent_errors",
		handler: async (args) => {
			const dates = datesFor(args);
			const r = await LogScan.getRecentErrors(dates, await instanceName(), DEFAULT_LOG_LINES, undefined, argTz(args));
			const byType = r.errors_by_type || [];
			const byDay = r.errors_by_day || [];
			const total = r.total_errors != null ? r.total_errors : (r.matchCount || 0);
			// A single authoritative sentence built from the pre-counted totals, so the reply can be
			// relayed verbatim. Small models otherwise re-tally the raw `examples` lines (which include
			// non-error context) and produce counts that contradict these figures — report `summary`.
			const plural = (n) => (n === 1 ? '' : 's');
			// State the window that was SEARCHED, not just the days that happened to have errors — otherwise a
			// "last 3 days" question whose errors all fell on one day reads as if only that day was scanned
			// ("across 1 day"). `dates` is the exact set of days scanned; sort so the range reads chronologically.
			const searched = dates.slice().sort();
			const daysSearched = searched.length;
			const rangeLabel = daysSearched === 1 ? searched[0] : (searched[0] + ' to ' + searched[searched.length - 1]);
			const windowPhrase = daysSearched === 1 ? 'on ' + searched[0] : 'over the ' + daysSearched + ' days searched (' + rangeLabel + ')';
			const daysWithErrors = byDay.length;
			// Where the errors actually landed inside that window.
			const spreadPhrase = (daysSearched > 1 && total > 0)
				? (daysWithErrors <= 1 ? (byDay[0] ? ', all on ' + byDay[0].date : '') : ', spread across ' + daysWithErrors + ' of those days')
				: '';
			const summary = (total === 0)
				? 'No errors were logged ' + windowPhrase + '.'
				: (total + ' error' + plural(total) + ' logged ' + windowPhrase + spreadPhrase
					+ (byType.length ? ' — by type: ' + byType.map((t) => t.count + '× ' + t.type).join(', ') : '')
					// "Busiest day" only adds information when errors span more than one day; with a single day it
					// just restates "all on X".
					+ (daysWithErrors > 1 && byDay[0] ? '. Busiest day: ' + byDay[0].date + ' (' + byDay[0].count + ' error' + plural(byDay[0].count) + ')' : '')
					+ '.');
			return {
				// Report `summary` verbatim; it is the ground-truth tally. Do NOT recount from `examples`
				// (those are sample log lines for context, not a per-error list).
				summary: summary,
				total_errors: total,
				// Pre-computed answers so the reply needs no counting/ranking by the model: report these verbatim.
				most_common_error: byType[0] || null,     // { type, count } — the single most frequent error
				busiest_day: byDay[0] || null,             // { date, count } — the day with the MOST errors
				errors_by_type: byType,                    // [{ type, count }] ranked, most-frequent first
				errors_by_day: byDay,                      // [{ date, count }] ranked by error count
				examples: (r.lines || []).slice(0, 12),
				shown: Math.min((r.lines || []).length, 12),
				truncated: !!r.truncated
			};
		}
	},

	{
		name: "count_restarts",
		handler: async (args) => {
			const r = await LogScan.getRestarts(datesFor(args), await instanceName(), DEFAULT_LOG_LINES, argTz(args));
			const lines = r.lines || [];
			// Files are scanned newest-day-first, so the array isn't globally chronological — pick
			// the most recent start by its (ISO, lexicographically sortable) timestamp, not array order.
			const mostRecent = lines.length ? lines.reduce((a, b) => (b > a ? b : a)) : null;
			return { restarts: r.matchCount != null ? r.matchCount : lines.length, most_recent_restart: mostRecent, start_records: lines.slice(0, 30), truncated: !!r.truncated };
		}
	},

	{
		name: "get_deal_orders",
		handler: async (args) => { const r = await DealQuery.getDealOrders(String(args.deal_id || '').trim(), args.order_no); return failGuard(r) || r; }
	},

	{
		name: "get_deal_timeline",
		handler: async (args) => {
			const id = String(args.deal_id || '').trim();
			// Center the log scan on the DEAL's own active day (its close day for a completed deal, or its
			// last-activity day) — like get_deal_events — instead of a fixed recent 7–10 day window, which
			// returned NO log events for any deal older than ~10 days (e.g. a deal that closed weeks ago).
			const dates = await dealLogDates(id, args);

			// Reconciliation (deal data + computed findings) plus the deal's log events.
			const [ rec, eventsRes ] = await Promise.all([
				DealQuery.reconcileDeal(id),
				LogScan.getDealEventsRange(id, dates, await instanceName(), 18)
			]);

			return Object.assign({}, rec, {
				log_events: eventsRes.lines || [],
				log_event_count: (eventsRes.lines || []).length,
				log_days_scanned: dates,
				log_truncated: !!eventsRes.truncated
			});
		}
	},

	{
		name: "get_deal_events",
		handler: async (args) => {
			const id = String(args.deal_id || '').trim();
			const dates = await dealLogDates(id, args);
			const r = await LogScan.getDealEvents(id, dates, await instanceName(), DEFAULT_LOG_LINES);
			return { events: r.lines || [], event_count: (r.lines || []).length, dates_searched: dates, truncated: !!r.truncated };
		}
	},

	{
		name: "get_performance_summary",
		handler: async (args) => {
			// Default to ALL-TIME unless a period is named. "how am I doing", "total profit", "win rate",
			// "how many deals for X" all mean over all history — a silent 7-day window gave tiny, wrong
			// figures (e.g. a pair's lifetime deal count read as just its last-7-days count).
			const win = windowIfNamed(args);
			const r = await DealQuery.getPerformanceSummary(win ? win.from : null, win ? win.to : null, normPair(args.pair), MAX_DEALS_FOR_COUNT);
			return Object.assign({ window: win ? { from: win.from.toISOString(), to: win.to.toISOString() } : 'all_time', pair: args.pair || null }, r);
		}
	},

	{
		name: "get_deals_over_time",
		handler: async (args) => {
			const win = orderWindow({ date: args.date, days: argPresent(args.days) ? args.days : 7, from: args.from, to: args.to });
			const r = await DealQuery.getDealStatsOverTime(win.from, win.to, args.group_by);
			const out = Object.assign({ window: { from: win.from.toISOString(), to: win.to.toISOString() } }, r);
			// A daily bucketing over a long window can be hundreds of rows — keep the MOST RECENT page
			// and point at `totals` for the whole-window figures, so the series stays readable and the
			// result never overflows. Weekly/monthly windows are small and pass through untouched.
			if (Array.isArray(out.buckets) && out.buckets.length > 60) {
				out.buckets_total = out.buckets.length;
				out.buckets = out.buckets.slice(-60);
				out.buckets_shown = out.buckets.length;
				out.note = 'Showing the most recent ' + out.buckets_shown + ' of ' + out.buckets_total + ' buckets — use `totals` for whole-window figures, or a coarser group_by (week/month) for fewer rows.';
			}
			return out;
		}
	},

	{
		name: "get_top_deals",
		handler: async (args) => {
			// Build a close-date window ONLY when the user named a period; otherwise rank all-time
			// (the natural meaning of "my best deals" with no period).
			const win = windowIfNamed(args);
			const r = await DealQuery.getTopDeals(args.scope, args.metric, args.limit, args.direction, win);
			return failGuard(r) || r;
		}
	},

	{
		name: "list_bots",
		handler: async (args) => {
			const r = await DealQuery.getBotsSummary(truthyArg(args.active_only));
			return failGuard(r) || { bots: r.bots || [], count: r.count || 0 };
		}
	},

	{
		name: "get_exchanges",
		handler: async () => {
			const r = await DealQuery.getExchanges();
			return failGuard(r) || { exchanges: r.exchanges || [], count: r.count || 0 };
		}
	},

	{
		name: "get_open_deals_status",
		handler: async () => { const r = await DealQuery.getOpenDealsStatus(); return failGuard(r) || r; }
	},

	{
		name: "get_deals_closest_to_take_profit",
		handler: async (args) => { const r = await DealQuery.getDealsClosestToTakeProfit(Number(args && args.limit) > 0 ? Number(args.limit) : undefined); return failGuard(r) || r; }
	},

	{
		name: "get_portfolio_summary",
		handler: async () => { const r = await DealQuery.getPortfolioSummary(); return failGuard(r) || r; }
	},

	{
		name: "get_pair_performance",
		handler: async (args) => {
			// Default to ALL-TIME unless a period is named. "most profitable pair" / "how did my X deals
			// perform" / "…ever" mean over all history — a silent 30-day window gave tiny, wrong figures.
			const win = windowIfNamed(args);
			const r = await DealQuery.getPairPerformance(win ? win.from : null, win ? win.to : null, MAX_DEALS_FOR_COUNT, args.top, args.order);
			return Object.assign({ window: win ? { from: win.from.toISOString(), to: win.to.toISOString() } : 'all_time' }, r);
		}
	},

	{
		name: "get_bot_performance",
		handler: async (args) => {
			// Default to ALL-TIME unless a period is named — "worst/best bot" means over all history,
			// not an arbitrary recent window. Only window when the user actually specifies a period.
			const win = windowIfNamed(args);
			const r = await DealQuery.getBotPerformance(win ? win.from : null, win ? win.to : null, args.order);
			return Object.assign({ window: win ? { from: win.from.toISOString(), to: win.to.toISOString() } : 'all_time' }, r);
		}
	},

	{
		// Head-to-head bot comparison. get_bot_performance ranks ALL bots; small models struggle to pull
		// two specific bots out of that list and diff them, so this tool juxtaposes the requested bots and
		// computes the gap explicitly ("SymSync 100 leads SymSync 90 by $X"). Builds on the same all-time
		// aggregation (no duplicate query logic). Read-only. With no bots named it just ranks them all.
		name: "compare_bot_performance",
		handler: async (args) => {
			const win = windowIfNamed(args);
			const r = await DealQuery.getBotPerformance(win ? win.from : null, win ? win.to : null, 'most_profitable');
			const guard = failGuard(r);
			if (guard) { return guard; }

			const all = Array.isArray(r.bots) ? r.bots : [];

			// Resolve the requested names against the real bot names (case/space-insensitive; exact match
			// wins, else a contains match), so "symsync 100" and "SymSync 100" both land.
			const wanted = [];
			if (Array.isArray(args && args.bots)) { for (const b of args.bots) { if (argPresent(b)) { wanted.push(String(b)); } } }
			else if (argPresent(args && args.bots)) { wanted.push(String(args.bots)); }
			else { if (argPresent(args && args.bot_a)) { wanted.push(String(args.bot_a)); } if (argPresent(args && args.bot_b)) { wanted.push(String(args.bot_b)); } }

			const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
			let selected = all;
			const unmatched = [];
			if (wanted.length) {
				selected = [];
				for (const name of wanted) {
					const n = norm(name);
					// Exact match wins. Otherwise fall back to a fuzzy contains match ONLY when it is
					// unambiguous (exactly one candidate) — so "SymSync 8" does not silently resolve to
					// "SymSync 80" when several bots share the prefix.
					let hit = all.find(b => norm(b.botName) === n);
					if (!hit) {
						const cands = all.filter(b => norm(b.botName).includes(n) || n.includes(norm(b.botName)));
						if (cands.length === 1) { hit = cands[0]; }
					}
					if (hit) { if (!selected.includes(hit)) { selected.push(hit); } }
					else { unmatched.push(name); }
				}
			}

			// Rank the selected bots and compute the leader's margin over each other. A numeric 0 profit is a
			// real value (break-even) and must outrank a loss — only a null total_profit (a bot that mixed
			// quote currencies, so it has no single figure) is sunk to the bottom, reported but not diffed.
			const rankKey = x => (typeof x.total_profit === 'number') ? x.total_profit : -Infinity;
			const ranked = selected.slice().sort((a, b) => rankKey(b) - rankKey(a));
			const leader = ranked.length ? ranked[0] : null;
			const bots = ranked.map(b => {
				const row = {
					bot: b.botName,
					completed_deals: b.completed_deals,
					total_profit: b.total_profit,
					profit_currency: b.profit_currency || null,
					win_rate_percent: b.win_rate_percent,
					avg_profit_percent: b.avg_profit_percent,
					avg_duration_mins: b.avg_duration_mins,
					avg_safety_orders: b.avg_safety_orders
				};
				if (leader && b !== leader && typeof b.total_profit === 'number' && typeof leader.total_profit === 'number') {
					row.behind_leader_by = Math.round((leader.total_profit - b.total_profit) * 100) / 100;
				}
				return row;
			});

			const out = {
				window: win ? { from: win.from.toISOString(), to: win.to.toISOString() } : 'all_time',
				compared: bots.length,
				leader: leader ? leader.botName : null,
				bots
			};
			if (unmatched.length) { out.not_found = unmatched; out.available_bots = all.map(b => b.botName); }
			return out;
		}
	},

	{
		name: "find_oldest_open_deals",
		handler: async (args) => { const r = await DealQuery.findOldestOpenDeals(args.limit, args.min_age_hours); return failGuard(r) || r; }
	},

	{
		name: "find_newest_open_deals",
		handler: async (args) => { const r = await DealQuery.findOldestOpenDeals(args.limit, undefined, true); return failGuard(r) || r; }
	},

	{
		name: "find_deals_near_max_safety_orders",
		handler: async (args) => { const r = await DealQuery.findDealsNearMaxSafetyOrders(args.min_used_fraction, args.limit); return failGuard(r) || r; }
	},

	{
		name: "find_deal_id",
		handler: async (args) => await DealQuery.resolveDeal(args.reference)
	},

	{
		name: "get_open_risk_summary",
		handler: async (args) => { const r = await DealQuery.getOpenRiskSummary(args.near_stop_loss_pct); return failGuard(r) || r; }
	},

	{
		name: "get_exposure_summary",
		handler: async (args) => { const r = await DealQuery.getExposureSummary(args.group_by); return failGuard(r) || r; }
	},

	{
		name: "get_expert_analysis",
		handler: async (args) => {
			if (typeof expertFn !== 'function') { return { error: 'Expert analysis is not available.' }; }
			const q = String(args.question || '').trim();
			if (!q) { return { error: 'No question provided.' }; }
			try {
				const answer = await expertFn(q);
				return { expert_analysis: (answer || '').trim() || '(no response)' };
			}
			catch (e) { return { error: 'Expert analysis failed: ' + e.message }; }
		}
	},

	{
		name: "explore",
		handler: async (args, ctx) => {
			// Enforce the config gate and the recursion guard at execution time, not just by which
			// tools were advertised — a structured `explore` call while disabled, or from inside the
			// sub-agent, is rejected here.
			if (!exploreEnabled()) { return { error: 'Deep research (explore) is not enabled.' }; }
			if (exploreActive) { return { error: 'Already researching — a nested explore is not allowed.' }; }
			if (typeof subAgentFn !== 'function') { return { error: 'The explore sub-agent is not available.' }; }
			const task = String((args && args.task) || '').trim();
			if (!task) { return { error: 'No task provided.' }; }
			exploreActive = true;
			try {
				// Forward the caller's keep-alive so a multi-step run keeps the chat's activity indicator
				// alive instead of going silent for the whole investigation.
				const findings = await subAgentFn(task, { onActivity: ctx && ctx.onActivity });
				const text = (typeof findings === 'string' ? findings : '').trim();
				return { findings: text || '(the sub-agent gathered no findings)' };
			}
			catch (e) { return { error: 'Explore failed: ' + e.message }; }
			finally { exploreActive = false; }
		}
	},

	{
		name: "get_circuit_breaker_status",
		handler: async () => {
			const app = (shareData && shareData.appData) || {};
			const cb = app.circuit_breaker || {};
			return {
				active: app.circuit_breaker_active === true || !!app.circuit_breaker_active,
				activated_at: app.circuit_breaker_activated_at || null,
				clears_at: app.circuit_breaker_clears_at || null,
				enabled: cb.enabled === true,
				price_drop_enabled: cb.price_drop_enabled === true
			};
		}
	},

	{
		name: "calculate",
		handler: async (args) => {
			const expr = (args && (args.expression != null ? args.expression : args.expr)) || '';
			const fn = (shareData && shareData.Common && typeof shareData.Common.safeEvalArithmetic === 'function') ? shareData.Common.safeEvalArithmetic : null;
			if (!fn) { return { error: 'Calculator not available' }; }
			const r = fn(expr);
			return r.ok ? { expression: String(expr), result: r.value } : { error: r.error || 'invalid expression', expression: String(expr) };
		}
	},

	{
		name: "get_system_status",
		handler: async () => {
			const fn = (shareData && shareData.Common && typeof shareData.Common.getSystemHealth === 'function') ? shareData.Common.getSystemHealth : null;
			if (!fn) { return { error: 'System status not available' }; }
			const h = await fn();
			if (!h) { return { error: 'System status not available' }; }
			// Human-readable uptime so the model states it directly instead of converting seconds itself.
			const secs = Number(h.uptime_seconds);
			let uptime_human = null;
			if (Number.isFinite(secs) && secs >= 0) {
				const d = Math.floor(secs / 86400), hr = Math.floor((secs % 86400) / 3600), mn = Math.floor((secs % 3600) / 60);
				uptime_human = ((d ? d + 'd ' : '') + (hr ? hr + 'h ' : '') + mn + 'm').trim();
			}
			return {
				uptime_seconds: h.uptime_seconds != null ? h.uptime_seconds : null,
				uptime_human: uptime_human,
				started: h.started || null,
				active_deals: h.active_deals != null ? h.active_deals : null,
				memory_mb: h.memory ? h.memory.primary_mb : null,
				memory_label: h.memory ? h.memory.primary_label : null,
				cpu_load_avg: h.load_avg || null,
				cpu_count: h.cpu_count != null ? h.cpu_count : null,
				app_version: h.app_version || null,
				platform: h.platform || null
			};
		}
	},

	{
		name: "get_balance",
		handler: async () => {
			const fn = (shareData && shareData.DCABot && typeof shareData.DCABot.getBalanceCache === 'function') ? shareData.DCABot.getBalanceCache : null;
			if (!fn) { return { error: 'Balance data not available' }; }

			const cache = fn() || {};
			const exchanges = {};

			for (const key of Object.keys(cache)) {

				if (key === 'updated') { continue; }

				const bal = cache[key];
				if (!bal || typeof bal !== 'object') { continue; }

				const coins = {};

				for (const cur of Object.keys(bal)) {

					const v = bal[cur];

					// Per-currency entries look like { free, used, total }; the aggregate
					// free/used/total maps hold plain numbers and are skipped here.
					if (v && typeof v === 'object' && (Number(v.total) > 0 || Number(v.free) > 0)) {

						coins[cur] = { free: Number(v.free) || 0, total: Number(v.total) || 0 };
					}
				}

				exchanges[key] = coins;
			}

			// If nothing is cached, say so EXPLICITLY and instruct against fabrication — otherwise a small
			// model handed an empty object tends to invent a plausible-looking balance (e.g. "BTC 0.12345678").
			const hasAny = Object.values(exchanges).some(coins => coins && Object.keys(coins).length > 0);
			if (!hasAny) {
				return { available: false, note: 'No wallet balance data is currently available for this instance (balances are not being tracked, or none have been fetched yet). Tell the user their balance is unavailable right now — do NOT estimate, guess, or invent any balance figures.' };
			}

			return { available: true, updated: cache.updated || null, exchanges };
		}
	},

	{
		// Scheduled-task / automation status — read-only view of the scheduler (backups, reports, watchdog
		// scans, notifications). Answers "what schedules do I have", "did my morning summary run", "is any
		// schedule failing". Never creates, edits, enables, or runs a schedule.
		name: "list_schedules",
		handler: async (args) => {
			const sched = shareData && shareData.Scheduler;
			if (!sched || typeof sched.list !== 'function') { return { available: false, note: 'The scheduler is not available on this instance.' }; }
			const r = await sched.list();
			if (!r || r.success === false) { return { available: false, error: (r && r.error) || 'could not read schedules', note: 'Could not read the schedule list; tell the user it is unavailable and do not invent schedules.' }; }
			let rows = Array.isArray(r.schedules) ? r.schedules : [];
			// Optional filters the model may pass: only enabled, or only currently-failing schedules.
			if (args && (args.enabled_only === true || args.enabled_only === 'true')) { rows = rows.filter(s => s && s.enabled); }
			if (args && (args.failing_only === true || args.failing_only === 'true')) { rows = rows.filter(s => s && (Number(s.consecutive_failures) > 0 || s.last_status === 'error' || s.last_status === 'failed')); }
			const schedules = rows.map(s => ({
				name: s.label || s.name || s.schedule_id || '(unnamed)',
				type: s.kind || s.type || null,
				enabled: s.enabled === true,
				cron: s.cron || s.schedule || null,
				last_run: s.last_run || null,
				last_status: s.last_status || null,
				run_count: (s.run_count != null) ? s.run_count : null,
				consecutive_failures: (s.consecutive_failures != null) ? Number(s.consecutive_failures) : 0
			}));
			return { count: schedules.length, failing: schedules.filter(s => s.consecutive_failures > 0 || s.last_status === 'error' || s.last_status === 'failed').length, schedules };
		}
	},

	{
		// Audit trail — read-only "what changed / who did what" from the tamper-evident audit log (settings
		// changes, key mint/revoke, logins, deal actions, system backup/restore). Answers "what changed
		// recently", "who created an API key", "show recent logins". Never writes.
		name: "list_audit_events",
		handler: async (args) => {
			const audit = shareData && shareData.Audit;
			if (!audit || typeof audit.list !== 'function') { return { available: false, note: 'The audit log is not available on this instance.' }; }
			const opts = {};
			if (argPresent(args && args.action)) { opts.action = String(args.action).trim(); }
			if (argPresent(args && args.actor))  { opts.actor = String(args.actor).trim(); }
			const win = windowIfNamed(args);
			if (win) { opts.since = win.from; }
			opts.limit = Math.min(Math.max(parseInt(args && args.limit, 10) || 50, 1), 200);
			const rows = await audit.list(opts);
			const events = (Array.isArray(rows) ? rows : []).map(e => ({
				time: e.ts || null, actor: e.actor || null, action: e.action || null, target: e.target || null, detail: e.detail || null, ip: e.ip || null
			}));
			return { count: events.length, window: win ? { from: win.from.toISOString(), to: win.to.toISOString() } : 'all_time', events };
		}
	},

	{
		// Drawdown / underwater-position risk — ranked list of OPEN deals that are underwater beyond a
		// threshold and/or have used most of their safety-order ladder. Answers "which deals are underwater
		// by more than 15%", "my worst-drawdown positions with little ladder left". Read-only.
		name: "get_drawdown_risk",
		handler: async (args) => {
			const uw = argPresent(args && args.underwater_pct) ? Number(args.underwater_pct) : null;
			const soFrac = argPresent(args && args.so_used_fraction) ? Number(args.so_used_fraction) : null;
			const limit = argPresent(args && args.limit) ? Number(args.limit) : null;
			const r = await DealQuery.getDrawdownRisk(uw, soFrac, limit);
			return failGuard(r) || r;
		}
	},

	{
		// Aggregate order usage across ALL open deals in ONE number, so "how many safety orders are used
		// across my open deals" is answered exactly instead of the model summing a per-deal list by hand.
		// Read-only.
		name: "get_open_orders_summary",
		handler: async (args) => {
			const r = await DealQuery.getOpenOrdersSummary(argPresent(args && args.top) ? args.top : null);
			return failGuard(r) || r;
		}
	}
];

// Join each schema with its handler by name (schema fields first, then the handler).
const TOOLS = TOOL_HANDLERS.map(h => Object.assign({}, SCHEMA_BY_NAME[h.name], { handler: h.handler }));


const TOOL_MAP = TOOLS.reduce((m, t) => { m[t.name] = t; return m; }, {});


// Provider-neutral function schemas (OpenAI / Ollama share this shape).
// Emit provider-neutral function schemas. With `names` (an array of tool names) only
// those are returned, in that order — used by tool shortlisting so a small model sees a
// short, relevant list rather than all ~25 tools (selection accuracy drops sharply past
// ~10–15 tools). Without `names`, all tools are returned.
function listSchemas(names) {

	const src = (Array.isArray(names) && names.length)
		? names.map(n => TOOL_MAP[n]).filter(Boolean)
		: TOOLS;

	return src.map(t => {

		// Fold each tool's example questions into the description the model sees. Concrete example
		// phrases are the single biggest lever on reliable tool selection (especially for the harder
		// multi-tool cases), and giving every tool a declared `examples` array is how new/updated
		// tools stay easy to route without editing prompt logic.
		let description = t.description;

		if (Array.isArray(t.examples) && t.examples.length) {

			description += ' Example questions: ' + t.examples.map(e => '"' + e + '"').join('; ') + '.';
		}

		return {
			type: 'function',
			function: { name: t.name, description, parameters: t.parameters }
		};
	});
}


// ── Grounded-identifier argument constraint ──────────────────────────────────
// A small local model can invent a deal id or pair to look up ("get_deal(SHIB_USD-…)" for a deal that
// does not exist, or a truncated form of a real id). Rather than only catch that after the fact, we
// constrain the id/pair ARGUMENT of a follow-up tool call to identifiers that actually appeared in this
// turn — the prior tool results plus the user's own question. Two layers, both fed by the same grounded
// set: `constrainToolSchemas` injects an `enum` into the deal_id / pair parameter schema (grammar-
// constrained on capable Ollama builds, and a strong hint to the model otherwise); `reconcileToolArgs`
// is the deterministic backstop that snaps a fabricated/truncated id to its real grounded form (or a
// mis-cased pair to the canonical one) before the call runs, so a non-existent identifier is never
// queried. The grounded set starts empty (nothing to constrain on the first call — the id is discovered
// via find_deal_id or supplied by the user) and grows as tools return data.

const ID_PARAM = 'deal_id';
const PAIR_PARAM = 'pair';

// Inject the grounded enum into the id/pair parameters of each schema, WITHOUT mutating the shared
// TOOL_SCHEMAS objects (a fresh copy only where a constraint is actually added). Returns the schemas
// unchanged when there is nothing grounded yet. Single exit.
function constrainToolSchemas(schemas, grounded) {

	const ids = (grounded && grounded.ids instanceof Set) ? Array.from(grounded.ids) : (Array.isArray(grounded && grounded.ids) ? grounded.ids : []);
	const pairs = (grounded && grounded.pairs instanceof Set) ? Array.from(grounded.pairs) : (Array.isArray(grounded && grounded.pairs) ? grounded.pairs : []);

	if ((!ids.length && !pairs.length) || !Array.isArray(schemas)) { return schemas; }

	return schemas.map(s => {

		const params = s && s.function && s.function.parameters;
		const props = params && params.properties;
		if (!props) { return s; }

		let touched = false;
		const newProps = {};

		for (const key of Object.keys(props)) {
			if (key === ID_PARAM && ids.length) { newProps[key] = Object.assign({}, props[key], { enum: ids }); touched = true; }
			else if (key === PAIR_PARAM && pairs.length) { newProps[key] = Object.assign({}, props[key], { enum: pairs }); touched = true; }
			else { newProps[key] = props[key]; }
		}

		if (!touched) { return s; }

		return Object.assign({}, s, {
			function: Object.assign({}, s.function, {
				parameters: Object.assign({}, params, { properties: newProps })
			})
		});
	});
}

// Snap a fabricated identifier to its real grounded form. Conservative: an id is only snapped when the
// resolution is unambiguous — an exact match (after trimming trailing ellipsis/space the model adds), a
// UNIQUE prefix relationship (the classic truncation "ME_USD-1MBI6KO-17" → the full id), or when there
// is only a single grounded id in play. Otherwise it is left untouched (the tool returns not-found and
// the grounding backstop handles it). Never invents an id when none is grounded. Single exit.
function closestGroundedId(candidate, ids) {

	let out = null;
	const c = String(candidate || '').replace(/[\s.…]+$/, '');

	if (c) {
		if (ids.indexOf(c) !== -1) { out = c; }
		else {
			const rel = ids.filter(id => id.startsWith(c) || c.startsWith(id));
			if (rel.length === 1) { out = rel[0]; }
			else if (ids.length === 1) { out = ids[0]; }
		}
	}

	return out;
}

// Reconcile a tool call's id/pair arguments against the grounded set. Returns a (possibly new) args
// object; the original is never mutated. Only acts when the grounded set for that identifier type is
// non-empty — with nothing grounded there is no basis to correct, so a user-supplied id passes through.
// Single exit.
function reconcileToolArgs(args, grounded) {

	if (!args || typeof args !== 'object') { return args; }

	const ids = (grounded && grounded.ids instanceof Set) ? Array.from(grounded.ids) : [];
	const pairs = (grounded && grounded.pairs instanceof Set) ? Array.from(grounded.pairs) : [];

	let out = args;

	if (out[ID_PARAM] && ids.length && ids.indexOf(String(out[ID_PARAM])) === -1) {
		const snap = closestGroundedId(out[ID_PARAM], ids);
		if (snap && snap !== out[ID_PARAM]) { out = Object.assign({}, out, { [ID_PARAM]: snap }); }
	}

	if (out[PAIR_PARAM] && pairs.length) {
		const up = String(out[PAIR_PARAM]).toUpperCase();
		if (out[PAIR_PARAM] !== up && pairs.indexOf(up) !== -1) { out = Object.assign({}, out, { [PAIR_PARAM]: up }); }
	}

	return out;
}


// Tokenize a query/tool text for the lexical shortlist fallback: lowercase words of 3+ chars,
// minus common stopwords. Kept dependency-free and deterministic (the corpus/BM25 guidance is to
// stay lexical, not embeddings).
const SELECT_STOPWORDS = new Set([
	'the','and','for','are','was','were','have','has','had','with','you','your','this','that','what',
	'which','how','why','when','who','does','did','can','could','would','should','about','any','all',
	'some','get','got','show','tell','give','list','see','look','into','over','from','out','now',
	'right','currently','please','there','their','them','they','been','being','deal','deals'
]);

function selectTokens(s) {

	return String(s || '')
		.toLowerCase()
		.replace(/[^a-z0-9/ ]+/g, ' ')
		.split(/\s+/)
		.filter(w => w.length >= 3 && !SELECT_STOPWORDS.has(w));
}

function toolSearchText(t) {

	const ex = Array.isArray(t.examples) ? t.examples.join(' ') : '';

	return (String(t.name).replace(/_/g, ' ') + ' ' + (t.description || '') + ' ' + ex).toLowerCase();
}


// ── Tool shortlisting ────────────────────────────────────────────────────────
// Pick the handful of tools relevant to a query so the tool-call step isn't drowned by
// ~25 flat tools. Keyword→tool routing (the same concept-expansion idea used for log
// search); a small CORE set is always included, and the result is capped. Over-inclusion
// is fine (still far fewer than the full set); the risk is EXCLUDING a needed tool, so
// keep the cap generous and the routes broad.
const CORE_TOOLS = [ 'get_open_deals_status', 'get_performance_summary', 'find_deal_id' ];

const TOOL_ROUTES = [
	// Schedules / automation status, the audit trail, and drawdown-risk — the three read-only tools that
	// answer "what's automated", "what changed / who did what", and "which positions are most at risk".
	{ re: /\b(schedule|schedules|scheduled task|scheduled tasks|automation|automations|cron|recurring (task|job)|backup job|report job|did .* run|next (backup|report|run))\b/i, tools: [ 'list_schedules' ] },
	{ re: /\b(audit|audit log|audit trail|who (created|revoked|changed|added|deleted|made|disabled|enabled|logged|signed)|recent (logins?|changes|activity)|what changed|admin actions?|settings? (change|changed)|key (created|revoked)|login history|log(ged|ging)?[\s-]?in|sign(ed|ing)?[\s-]?in|who .*(log|sign)(ged|ned)?[\s-]?in)\b/i, tools: [ 'list_audit_events' ] },
	{ re: /\b(drawdown|underwater by|deep(est)? in the red|worst[- ]?drawdown|most at risk|riskiest|used (most|all) .*(safety|ladder)|no (safety|averaging) .*(left|room)|underwater beyond|down more than)\b/i, tools: [ 'get_drawdown_risk', 'get_open_risk_summary' ] },
	// Aggregate safety-order usage across ALL open deals — "total/across/overall/average safety orders",
	// "in play right now". Before the generic per-deal order route so a total question leads with the
	// one-number tool instead of the per-deal counter.
	{ re: /\b((total|overall|average|avg|combined|sum(med)?|aggregate|how many)\b[^.]{0,30}\bsafety orders?\b)|(\bsafety orders?\b[^.]{0,30}\b(across|in total|overall|in play|altogether|combined|all (my |the )?(open )?(deals?|positions?)))|((most|deepest|highest|greatest|max(imum)?)\b[^.]{0,20}\bsafety orders?\b)|(how deep .*(ladders?|safety))\b/i, tools: [ 'get_open_orders_summary', 'find_deals_near_max_safety_orders', 'count_orders' ] },
	// Head-to-head bot comparison — "bot X vs bot Y", "compare my bots" — before the generic bot route so
	// a comparison leads with the tool that juxtaposes and diffs them rather than a single-bot ranking.
	{ re: /\b((bot|bots)\b[^.]{0,40}\b(vs\.?|versus|compared? (to|with|against)|stack up|better than|against (each other|one another))|compare[sd]?\b[^.]{0,20}\bbots?\b|how (do|does) .*\bbots?\b.*(compare|stack|do against)|which bot (is )?(better|best|performs? better))\b/i, tools: [ 'compare_bot_performance', 'get_bot_performance' ] },
	// "close soon / closest to profit" → the focused ranked tool FIRST (it returns only the
	// answer). Listed before the general open-deals route so it leads the shortlist.
	{ re: /\b(close soon|clos(e|ing) soonest|closest to (profit|take[- ]?profit|target|closing)|most likely to close|about to close|will close|near(est)? (take[- ]?profit|profit|closing|target)|which .*(close|profit) (first|soon)|likely to close)\b/i, tools: [ 'get_deals_closest_to_take_profit', 'get_open_deals_status' ] },
	{ re: /\b(list (my )?open deals?|what deals? do i have( open)?|deals? i have open|show (me )?(my )?open deals?)\b/i, tools: [ 'list_open_deals', 'get_open_deals_status' ] },
	{ re: /\b(deals? for (a |this |the )?[a-z0-9]|deals? for pair|how (did|have|are) my .*(pair|[a-z0-9]+\/[a-z]+).*(do|perform|done|going))\b/i, tools: [ 'get_deals_for_pair', 'get_pair_performance' ] },
	{ re: /\b(open deals?|open positions?|underwater|unrealized|unrealized|p\/?l|pnl|profit|loss|losing|winning|gain|biggest|rank|take[- ]?profit|\btp\b|closest|about to hit)\b/i, tools: [ 'get_open_deals_status', 'get_deals_closest_to_take_profit', 'list_open_deals' ] },
	{ re: /\b(risk|stop[- ]?loss|\bsl\b|deep in the red|in the red|how (deep|far).*(red|underwater|down)|overall.*(risk|exposure)|how much.*(underwater|down|at risk))\b/i, tools: [ 'get_open_risk_summary', 'get_open_deals_status' ] },
	{ re: /\b(portfolio|exposure|exposed|deployed|dry powder|committed|capital|invested|over[- ]?exposed|cash (available|to trade|on hand|free)|(available|spare) (cash|funds)|buying power|funds to trade)\b/i, tools: [ 'get_portfolio_summary', 'get_exposure_summary' ] },
	{ re: /\b(by currency|per currency|by pair|per pair|by coin|per coin|shortfall|enough.*(fund|cover|safety)|could i fund|ties? up|tied up)\b/i, tools: [ 'get_exposure_summary', 'get_portfolio_summary' ] },
	{ re: /\b(balance|available|wallet|usdc|usdt|free funds|how much.*(have|left|available))\b/i, tools: [ 'get_balance' ] },
	{ re: /\b(order|orders|safety[- ]?order|\bso\b|placed|filled)\b/i, tools: [ 'count_orders', 'get_deal_orders' ] },
	{ re: /\b(near max|near .{0,12}max|max safety|ladder|exhaust|running out|no more safety|least room|cushion|averaging down)\b/i, tools: [ 'find_deals_near_max_safety_orders' ] },
	{ re: /\b(oldest|longest|stagnat|stale|how long|age|open for|dragging)\b/i, tools: [ 'find_oldest_open_deals' ] },
	// Newest / most-recently-opened OPEN deal — steer to the dedicated newest-first tool, not the oldest.
	{ re: /\b(newest|most recent(ly)?|latest|just opened|opened (last|most recent|newest|latest)|recently opened|my last (open )?deal)\b[^.]{0,20}\b(deal|position|trade)\b|\b(newest|latest|most recently opened)\s+(deal|position|trade)\b/i, tools: [ 'find_newest_open_deals' ] },
	{ re: /\b(paused|stuck|halted|frozen|not (opening|trading|buying))\b/i, tools: [ 'get_paused_deals', 'diagnose_deal' ] },
	{ re: /\b(top|best|worst|most|highest|lowest)\b.{0,30}\b(performing|performer|deals?|trades?|winners?|losers?|gainers?)\b|\b(biggest|largest)\b.{0,15}\b(winners?|losers?|gainers?)\b|\btop\s+\d+\b|\bleaderboard\b|\b(deals?|trades?)\b.{0,20}\b(ranked|ranking|best and worst)\b|\bbest and worst\b.{0,20}\b(deals?|trades?)\b/i, tools: [ 'get_top_deals' ] },
	// Deals that CLOSED at a loss (completed losers) — steer to the ranked leaderboard's 'worst' end, not
	// the open-deals tools that a bare "loss" keyword would otherwise pull in.
	{ re: /\b(losing (deals?|trades?)|deals? that (closed|ended|finished)[^.]{0,12}(at |in |with )?a? ?loss|closed (at|in|with) a loss|deals? i lost|deals? that lost|which deals? lost|unprofitable (deals?|trades?))\b/i, tools: [ 'get_top_deals', 'list_recent_completed_deals' ] },
	{ re: /\b(win[- ]?rate|performance|how did i do|profit last|best deal|worst deal|average profit|total profit|how (am|are) (i|we))\b/i, tools: [ 'get_performance_summary' ] },
	{ re: /\b(pairs?|which pairs?|most profitable pairs?|most active|most traded|best pairs?|worst pairs?)\b/i, tools: [ 'get_pair_performance' ] },
	{ re: /\b(which bot|best bot|worst bot|compare bots?|bot.*(perform|profit|best|worst|doing))\b/i, tools: [ 'get_bot_performance' ] },
	{ re: /\b(bot|bots|enabled|disabled|bot config|bot setting)\b/i, tools: [ 'list_bots', 'get_bot_performance' ] },
	{ re: /\b(completed|closed|finished|recent deals?|last few|deal history)\b/i, tools: [ 'list_recent_completed_deals', 'get_performance_summary' ] },
	{ re: /\b(more (errors?|problems?) than usual|unusual|abnormal|spik(e|ing)|elevated|higher than (usual|normal)|vs\.? (usual|normal)|compared to (usual|normal)|anomal(y|ous)|out of the ordinary|weird|baseline|(vs\.?|versus|compared to|against)[^.]{0,20}(baseline|prior|previous|before|normal)|prior (period|window|baseline|days?)|new or spiking)\b/i, tools: [ 'analyze_error_baseline', 'summarize_recent_errors' ] },
	{ re: /\b(error|errors|problem|failed|failure|issue|warning|insufficient|not enough)\b/i, tools: [ 'summarize_recent_errors', 'search_logs' ] },
	{ re: /\b(log|logs|search the log|grep)\b/i, tools: [ 'search_logs' ] },
	{ re: /\b(restart|restarted|shutdown|shut down|reboot|start(ed)? up|crash)\b/i, tools: [ 'count_restarts' ] },
	{ re: /\b(uptime|how long (?:has|have|it'?s|its)[^.]{0,30}\b(?:running|been up|been online|been live|up for)|memory (?:usage|used)|how much (?:memory|ram)|cpu load|system status|system health|is (?:it|symbot|the system) healthy|what version|which version|app version)\b/i, tools: [ 'get_system_status' ] },
	{ re: /\b(calculate|compute|work out the math|to the power of|squared|cubed|compound(?:ed|ing)?|\d\s*\^\s*\d|how much (?:bigger|larger|smaller|more)\b[^.]{0,40}\b(?:scale|multiplier|times|step|so|safety order))\b/i, tools: [ 'calculate' ] },
	{ re: /\b(circuit breaker|breaker|halt|kill switch)\b/i, tools: [ 'get_circuit_breaker_status' ] },
	{ re: /\b(what happened|went wrong|reconcile|blow[- ]?by[- ]?blow|walk me through|timeline)\b/i, tools: [ 'get_deal_timeline', 'diagnose_deal' ] },
	{ re: /\b(compare[sd]?|compared to|contrast|versus|(do|did|does|doing)[^.]{0,15}(worse|better)|worse than|better than|differently|under[- ]?perform|out[- ]?perform|than (my |the )?(other|others|usual|winner|winners|winning|loser|losers|losing|successful|good|best))\b/i, tools: [ 'compare_deal_to_baseline', 'diagnose_deal' ] },
	{ re: /\b(diagnose|why is|why did|problem with)\b/i, tools: [ 'diagnose_deal', 'get_deal_timeline', 'compare_deal_to_baseline' ] },
	{ re: /\b(event|events|log line|raw log)\b/i, tools: [ 'get_deal_events' ] },
	// Supplementary synonym routes (added from the corpus eval-gate — broaden phrasing coverage).
	{ re: /\b(active|running|in play|currently open|open right now|holding open|whats open|what'?s open|open trades?|open positions?)\b/i, tools: [ 'list_open_deals', 'get_open_deals_status' ] },
	{ re: /\bdeals? (for|on)\b/i, tools: [ 'get_deals_for_pair', 'get_deal' ] },
	{ re: /\b[A-Z]{2,6}(\/[A-Z]{2,6})?\s+(deals?|positions?|trades?|market)\b/, tools: [ 'get_deals_for_pair', 'get_deal' ] },
	{ re: /\b(safety orders? (left|remaining|used|to spare|filled)|out of safety|used (most|all|up)[^.]*(safety|dca)|exhaust|deployed most[^.]*safety|barely any safety|no averaging|little[^.]*cushion|maxed[^.]*(safeties|safety))\b/i, tools: [ 'find_deals_near_max_safety_orders' ] },
	{ re: /\b(gone wrong|went wrong|whats wrong|going wrong|issues|problems|failures|troubles?|anything (broken|failing|wrong)|sideways|healthy)\b/i, tools: [ 'summarize_recent_errors', 'search_logs' ] },
	{ re: /\b(coins?|markets?|symbols?)\b/i, tools: [ 'get_pair_performance' ] },
	{ re: /\b(each (day|week|month)|per[- ](day|week|month)|by (day|week|month)|dai?ly|weekly|monthly|day[- ]?by[- ]?day|over time|time[- ]?series|breakdown (by|over|per)|closed (each|per)|how many.*(each|per) (day|week|month))\b/i, tools: [ 'get_deals_over_time' ] },
	{ re: /\b(reboot(ed|s)?|relaunch(ed|es)?|reload(ed)?|came? back online|started? up|boot(ed|up)?|restart(s|ed|ing)?)\b/i, tools: [ 'count_restarts' ] },
	{ re: /\b(uptime|how long (?:has|have|it'?s|its)[^.]{0,30}\b(?:running|been up|been online|been live|up for)|memory (?:usage|used|footprint)|how much (?:memory|ram)|cpu load|resource usage|system (?:status|health)|is (?:it|symbot|the system) (?:healthy|ok|up)|running for how long|what version|which version|app version)\b/i, tools: [ 'get_system_status' ] },
	{ re: /\b(calculate|compute|work out the math|to the power of|squared|cubed|compound(?:ed|ing)?|\d\s*\^\s*\d|how much (?:bigger|larger|smaller|more)\b[^.]{0,40}\b(?:scale|multiplier|times|step|so|safety order))\b/i, tools: [ 'calculate' ] },
	{ re: /\b(nearest|approaching|about to|on the verge|edge of|almost (at|done|ready)|near(ing)?)\b[^.]{0,18}(target|take[- ]?profit|profit|clos|complet|finish|sell target)\b/i, tools: [ 'get_deals_closest_to_take_profit' ] },
	{ re: /\b(soonest|close first|close next|wrap up soon|near the finish|likeliest to close)\b/i, tools: [ 'get_deals_closest_to_take_profit' ] },
	{ re: /\b(stagnant|stagnan|sitting open|forever|most days|aged|dustiest|stalest|ancient|long-lived|been alive|hanging around|open the longest|opened earliest|greatest number of days)\b/i, tools: [ 'find_oldest_open_deals' ] },
	{ re: /\b(underwater by|in the red|deep[^.]*red|downside|drawdown|stop[- ]?loss|stopped out|paper loss|floating loss|red ink|risk (report|snapshot|on)|badly down|worst[^.]*(deal|drawdown))\b/i, tools: [ 'get_open_risk_summary', 'get_open_deals_status' ] },
	{ re: /\b(max commitment|working vs|dry powder|buying power|funds? (deployed|available|free)|capital (usage|overview|allocation)|utilization|worst case (commitment|outlay)|deployment ratio)\b/i, tools: [ 'get_portfolio_summary' ] },
	{ re: /\b(whats wrong|what'?s wrong|isn'?t (placing|buying|closing|doing|selling|taking)|troubleshoot|broken|not (triggering|working|placing|selling)|misbehav|blocking|hung up|halted|stalled|seems? (broken|off)|what'?s (blocking|causing))\b/i, tools: [ 'diagnose_deal', 'get_deal_timeline' ] },
	{ re: /\b(full story|narrate|play.?by.?play|reconstruct|reconcile|history of|unfold|chronology|sequence of events|blow.?by.?blow|what actually happened|step by step|deep dive)\b/i, tools: [ 'get_deal_timeline', 'diagnose_deal' ] },
	{ re: /\b(last (trades?|deals?)|wrapped up|just (wrapped|closed)|recently (closed|finished|completed|ended)|latest (closed|finished|deal)|freshest closed|closing out|close today|newest completed)\b/i, tools: [ 'list_recent_completed_deals' ] },
	{ re: /\b(balances?|available (funds|cash|balance)|cash on hand|wallet|free cash|spendable|funds?[^.]*(exchange|account)|how much[^.]*(usdt|usdc|btc|eth|bitcoin|stablecoin)[^.]*(have|hold|available|free))\b/i, tools: [ 'get_balance' ] },
	// Which exchange(s) the user is on / live vs sandbox — a grounded single-value answer, not a guess.
	{ re: /\b(which|what)\s+exchanges?\b|\bexchanges?\s+am\s+i\b|\b(exchange|sandbox|live)\s+(am\s+i|do\s+i)\b|\bam\s+i\s+(on|trading on|live|in\s+sandbox)\b|\bwhat\s+exchange\s+do\s+i\b/i, tools: [ 'get_exchanges', 'list_bots' ] },
	{ re: /\b(strateg(y|ies))\b/i, tools: [ 'get_bot_performance', 'list_bots' ] },
	{ re: /\b(log (events|entries|lines|records|trail|output)|logged events|raw (events|log)|events? (for|in|logged|recorded)|logs? (say|show|captured)|system log)\b/i, tools: [ 'get_deal_events' ] },
	{ re: /\b(config(uration)?s?[^.]*(bot|strateg)|bot config|take[- ]?profit (percentage|configured|set on)|safety order (settings?|config|count)|deviation setting|base order[^.]*size|how are my bots configured|bots configured)\b/i, tools: [ 'list_bots' ] },
	{ re: /\b(fills?|orders? (placed|filled|executed|triggered|opened)|how many (orders?|fills?|base orders?|safety orders?|sos|trades)|order count|tally[^.]*(fills?|orders?)|count[^.]*(orders?|fills?))\b/i, tools: [ 'count_orders' ] },
	{ re: /\b(on hold|not running|aren'?t running|suspended|halted|frozen|stuck|paused|on pause|suspended)\b/i, tools: [ 'get_paused_deals', 'diagnose_deal' ] },
	{ re: /\b(safety cutoff|emergency (brake|halt)|kill switch|trading (halt|stopped|frozen)|auto[- ]?halt|protection halt|breaker|cutout|locked out)\b/i, tools: [ 'get_circuit_breaker_status' ] },
	{ re: /\b(tying up|over[- ]?concentrat|concentration|come up short|shortfall|hogging|committed to|allocation[^.]*(coin|pair|currency)|per (coin|pair|currency)|by (coin|base asset)|exposure (map|figures|breakdown|split))\b/i, tools: [ 'get_exposure_summary', 'get_portfolio_summary' ] },
	{ re: /\b(dca ladder|order ladder|order (stack|sequence|breakdown)|fill (amounts?|times?)|filled orders?)\b/i, tools: [ 'get_deal_orders' ] },
	{ re: /\b(search|grep|find|look(ing)? (up|in|for|through)|scan|hunt|comb|trawl|pull up)\b[^.]{0,25}\blog(s|file)?\b/i, tools: [ 'search_logs' ] },
	// Second round from the eval-gate.
	{ re: /\b(used|use|nearly|almost|close to|running low|out of|barely|little|few|least)\b[^.]{0,22}(safety orders?|safeties|\bsos?\b|averaging|dca (cushion|budget|room))\b/i, tools: [ 'find_deals_near_max_safety_orders' ] },
	{ re: /\b(current deals?|deals that are open|positions? (i have|do i have)[^.]*(going|open|moment)|have (going|open|running)|running positions?|deals? open right now)\b/i, tools: [ 'list_open_deals', 'get_open_deals_status' ] },
	{ re: /\b(powder|bankroll|stack|put to work|working capital|out there working|in play|to deploy|left to deploy)\b/i, tools: [ 'get_portfolio_summary' ] },
	{ re: /\b(underwater (past|by|more than|over|beyond)|near[^.]{0,10}(stop|stopped out)|danger|how bad|paper losses?|big[^.]*losses|floating loss|the danger)\b/i, tools: [ 'get_open_risk_summary', 'get_open_deals_status' ] },
	{ re: /\b(nearest to|nearly at (target|take)|verge of clos|about to close|close to (target|closing|take[- ]?profit)|nearly ready to sell)\b/i, tools: [ 'get_deals_closest_to_take_profit' ] },
	{ re: /\b(won'?t[^.]{0,15}(close|take|sell|buy|fill|do)|isn'?t[^.]{0,15}(placing|buying|closing|doing|selling|taking|working|filling))\b/i, tools: [ 'diagnose_deal', 'get_deal_timeline' ] },
	{ re: /\b(narrative|trace[^.]{0,15}(life|history|whole)|from open to now|whole life)\b/i, tools: [ 'get_deal_timeline' ] },

	// Abstract data-analysis / forensic tools.
	{ re: /\b(how many times|how often|count[^.]{0,20}(by hour|per hour|by day|each|occurrenc|times)|when did[^.]{0,20}(spike|happen|start|occur|begin)|spik(e|ed|ing)|burst of|frequency of|correlate|group(ed)? by|by hour|per hour|how frequently)\b/i, tools: [ 'analyze_logs', 'search_logs' ] },
	{ re: /\b(what (happened|events?|was happening)[^.]{0,25}(between|around|in the window|near|during)|events?[^.]{0,20}(between|around|occurred|happened)|(activity|everything|anything|all[^.]{0,10}happenings?)[^.]{0,15}between|between\s+\d[^.]{0,20}(and|to|-)[^.]{0,10}\d|between[^.]{0,25}timestamps?|in this window|around (this|that) time|around the (restart|reboot|outage)|sequence of events|timeline of events)\b/i, tools: [ 'get_events_in_window', 'find_incident' ] },
	{ re: /\b(incident|outage|what went wrong (around|at|near)|batch of deals|closed at once|(all|those|these)[^.]{0,20}(closed|finished)[^.]{0,10}(at once|together)|(finish|clos)(ed)? together|caused[^.]{0,25}(deals|batch|bunch|group)[^.]{0,15}(finish|clos)|why did[^.]{0,20}(batch|bunch|group)[^.]{0,20}(close|finish)|correlate[^.]{0,25}(deals?|finished|errors?)|auth(entication)? (error|storm|failure)|api (error|failure|down|outage|hiccup))\b/i, tools: [ 'find_incident', 'get_events_in_window' ] },
	{ re: /\b((garbage|bad|crazy|weird|wrong|invalid|zero|implausible|impossible|anomal\w*|glitch\w*)[^.]{0,12}(prices?|profit)|prices?[^.]{0,10}(glitch\w*|spike|error|anomal|wrong|bad|garbage|invalid|zero)|crazy (number|percent)|insane (profit|number)|impossible profit|price glitch)\b/i, tools: [ 'scan_price_anomalies' ] },

	{ re: /\b(deal|position)\b/i, tools: [ 'get_deal', 'find_deal_id' ] },
	{ re: /\b(opinion|assess|judge|should i|concerning|interpret|is (this|that) (good|bad|ok|concerning|normal))\b/i, tools: [ 'get_expert_analysis' ] }
];

const SELECT_CAP = 10;

// Reciprocal-rank fusion of two ranked candidate lists. Each list contributes weight/(k + rank + 1) to
// a tool's score, so a tool ranked by BOTH signals rises above one ranked strongly by only one — the
// standard rank-fusion technique, applied here to the regex-route ranking and the lexical ranking.
const RRF_K = 60;
const RRF_W_ROUTE = 0.7;   // the precise regex routes are the stronger signal (like keyword precision)
const RRF_W_LEX = 0.3;
function rrfScore(routeRank, lexRank) {
	return (routeRank != null ? RRF_W_ROUTE / (RRF_K + routeRank + 1) : 0)
	     + (lexRank   != null ? RRF_W_LEX   / (RRF_K + lexRank   + 1) : 0);
}

function selectTools(query) {

	const q = String(query || '');

	// 1. Precise regex routes → matched tools, ranked by the order they were pushed (route order, then
	//    within-route order). These are the high-precision signal.
	const routeRank = new Map();
	for (const route of TOOL_ROUTES) {
		if (route.re.test(q)) {
			// Exclude 'explore' here (as the lexical path does): it is appended separately, and only when
			// enabled — so a future route that lists it can't leak a disabled sub-agent into the shortlist.
			for (const t of route.tools) { if (TOOL_MAP[t] && t !== 'explore' && CORE_TOOLS.indexOf(t) < 0 && !routeRank.has(t)) { routeRank.set(t, routeRank.size); } }
		}
	}

	// 2. Lexical signal (BM25-lite): rank tools by how many DISTINCT query keywords appear in each
	//    tool's searchable text (name + description + examples). This is what lets a NEW tool with good
	//    examples be shortlisted automatically, with no regex to hand-write.
	const lexRank = new Map();
	const qTokens = Array.from(new Set(selectTokens(q)));
	if (qTokens.length) {
		TOOLS
			.filter(t => t.name !== 'explore' && CORE_TOOLS.indexOf(t.name) < 0)
			.map(t => { const text = toolSearchText(t); let s = 0; for (const tok of qTokens) { if (text.indexOf(tok) >= 0) { s++; } } return { name: t.name, score: s }; })
			.filter(x => x.score >= 2)
			.sort((a, b) => b.score - a.score)
			.forEach((x, i) => lexRank.set(x.name, i));
	}

	// 3. Fuse the two rankings. Order every non-core candidate by its fused score so a tool matched by
	//    both a route AND the lexical signal leads over one matched weakly by only one.
	const scoreOf = (n) => rrfScore(routeRank.has(n) ? routeRank.get(n) : null, lexRank.has(n) ? lexRank.get(n) : null);
	const candidates = Array.from(new Set([ ...routeRank.keys(), ...lexRank.keys() ])).sort((a, b) => scoreOf(b) - scoreOf(a));

	// 4. Assemble: CORE always first. Then EVERY route-matched tool (the precise signal the routing eval
	//    relies on is never dropped), plus the top lexical-only tools filling the remaining cap slots —
	//    all in fused order.
	const routeMatched = candidates.filter(n => routeRank.has(n));
	const lexOnly = candidates.filter(n => !routeRank.has(n));
	// Firm cap on the shortlist. Route-matched tools lead (highest precision) so the ONE expected tool the
	// routing eval requires is always kept, but when many routes match we no longer let the list balloon past
	// the cap — a smaller shortlist is both faster (fewer schema tokens in the prompt) AND more accurate for a
	// small model (selection degrades past ~10-15 tools). Route-matched still come before lexical-only fills.
	const nonCoreCap = SELECT_CAP - CORE_TOOLS.length;
	const nonCore = routeMatched.concat(lexOnly).slice(0, nonCoreCap).sort((a, b) => scoreOf(b) - scoreOf(a));

	let selected = CORE_TOOLS.filter(n => TOOL_MAP[n]).concat(nonCore);

	// Expose the explore sub-agent only when it is enabled, and always keep it (appended, never trimmed)
	// so the model can reach for deep research when needed.
	if (exploreEnabled() && selected.indexOf('explore') < 0 && TOOL_MAP['explore']) { selected = selected.concat('explore'); }

	return selected;
}


// Execute a tool by name with an arguments object. Always resolves (never
// throws) to a compact, size-capped object the loop turns into a tool message.
const TOOL_TIMEOUT_MS = 25000;

// Per-tool timeout overrides. Most tools are a single DB/log query and must not hang a turn, so 25s is
// right. `explore` is different: it is an orchestrator that runs its OWN bounded sub-agent (single pass)
// or the multi-step deep analysis (plan → several sub-question loops → synthesis), each already governed
// by its own internal wall-clock budget. Holding it to the generic 25s would strangle it (the sub-agent
// is designed to run far longer), so it gets a much larger execute-layer ceiling and lets its internal
// budgeting do the real bounding.
const TOOL_TIMEOUT_OVERRIDES = { explore: 360000 };

// Shape of a full SymBot deal id (PAIR_QUOTE-XXXXXXX-epoch) — anchored so it matches only a complete
// id, never a free-text description. Used to decide whether a mis-named id argument (see execute) is
// really a deal id worth folding into `deal_id`.
const DEAL_ID_SHAPE = /^[A-Z0-9]{1,12}_[A-Z0-9]{2,10}-[A-Z0-9]{4,12}-\d{6,}$/;

async function execute(name, args, ctx) {

	// Enum-lock the emitted name onto a canonical tool (exact / alias / formatting variant) before
	// dispatch, so a camelCase or aliased name runs instead of wasting a round. No fuzzy match here —
	// the shortlist-scoped nearest-match is applied earlier, at the tool-call boundary.
	const canonical = resolveTool(name) || name;
	const tool = TOOL_MAP[canonical];

	if (!tool) {

		return { error: 'Unknown tool: ' + name + '. Do not call it again.' };
	}

	name = canonical;

	// Thread the request's timezone (the IANA name the browser sent) into the args as a reserved key, so
	// every date helper (orderWindow/datesFor/…) resolves "today"/"this month"/"on the 10th" in the USER's
	// zone. Always cloned so the model's own args object is never mutated; absent → the helpers default to UTC.
	const tzName = (ctx && typeof ctx.timezone === 'string' && ctx.timezone.trim() !== '') ? ctx.timezone.trim() : null;
	const callArgs = Object.assign({}, args || {});
	if (tzName) { callArgs._tz = tzName; }

	// Deal-id synonym repair. Small models frequently emit the required id under a synonym — e.g.
	// diagnose_deal / get_deal called with `reference` (or `dealId` / `id` / `deal`) instead of the
	// schema's `deal_id`. That left deal_id blank, the tool reported "no deal found", and the model
	// then REFUSED the whole question (the production "I can't analyze that" on a bare deal id). If the
	// tool declares a `deal_id` parameter, the call omitted it, and an alias holds something shaped like
	// a full deal id, fold that alias into deal_id. Purely additive and shape-gated: an explicit deal_id
	// always wins; a descriptive `reference` ("my oldest deal") is NOT deal-id-shaped so it is left for
	// the resolver; tools whose real parameter is `reference` (resolve_deal) have no deal_id and are
	// untouched.
	const _props = tool.parameters && tool.parameters.properties;
	if (_props && _props.deal_id && (callArgs.deal_id == null || String(callArgs.deal_id).trim() === '')) {
		const _alias = callArgs.reference || callArgs.dealId || callArgs.deal || callArgs.id;
		if (typeof _alias === 'string' && DEAL_ID_SHAPE.test(_alias.trim())) { callArgs.deal_id = _alias.trim(); }
	}

	try {

		// Per-tool timeout: a slow log scan or DB query must not hang the whole turn.
		// A late rejection from the losing promise is swallowed so it cannot crash later.
		// `ctx` (optional) carries a keep-alive the explore sub-agent forwards; ordinary handlers ignore it.
		const handlerPromise = Promise.resolve().then(() => tool.handler(callArgs, ctx));
		handlerPromise.catch(() => {});

		const timeoutMs = TOOL_TIMEOUT_OVERRIDES[name] || TOOL_TIMEOUT_MS;

		let timer;
		const timeoutPromise = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs); });

		const result = await Promise.race([ handlerPromise, timeoutPromise ]);
		clearTimeout(timer);

		if (result && result.__timeout) {

			return { error: 'Tool ' + name + ' timed out after ' + Math.round(timeoutMs / 1000) + 's. Narrow the request (a specific deal, pair, or a single day) rather than retrying the same call.' };
		}

		let payload = result;

		// Size guard: if the serialized result is too large, note the truncation
		// so the model asks a narrower question rather than getting silent garbage.
		let json = JSON.stringify(result);

		if (json && json.length > MAX_RESULT_CHARS) {

			payload = { note: 'Result truncated — it was too large. Ask a narrower question (e.g. a specific deal or pair).', partial: json.slice(0, MAX_RESULT_CHARS) };
		}

		return payload;
	}
	catch (e) {

		return { error: 'Tool ' + name + ' failed: ' + e.message };
	}
}


// A grouped, plain-language guide to which tool answers which kind of question, with
// the disambiguations small models get wrong most often. Injected into the system
// prompt alongside the JSON schemas so tool selection stays reliable across ~25 tools.
const TOOL_GUIDE = [
	'Tool guide — pick the most specific tool, and you may call several at once:',
	'• Open positions: list_open_deals (names/summary of what is open); get_open_deals_status (live unrealized P/L, which deal gained or lost the most, which is closest to take-profit or its next safety order, and to rank open deals); get_portfolio_summary (funds deployed vs available).',
	'• Open-deal risk: get_open_risk_summary (the aggregate risk view — total unrealized P/L, how many deals are underwater by >2/5/10%, and the stop-loss picture including deals near their stop; use for "how much am I underwater", "overall risk", "am I near a stop-loss"); find_deals_near_max_safety_orders (deals with the least safety-order cushion left / ladder nearly exhausted); find_oldest_open_deals (longest-running / stagnating open deals by age); find_newest_open_deals (the most recently OPENED open deals, newest first — for "my newest deal", "most recently opened deal", "my latest position").',
	'• Capital & exposure: get_portfolio_summary (single portfolio-wide total — deployed vs available, "dry powder"); get_exposure_summary (the SAME exposure broken down by quote currency or by pair, with a potential-shortfall flag; use for "exposure by currency", "which pair ties up the most capital", "could I fund all safety orders").',
	'• A specific deal: if the user names a deal by pair or description ("the BTC deal", "my newest one") rather than an exact id, call find_deal_id FIRST to get the id. Then: get_deal (current snapshot); get_deal_orders (its order ladder, or one order by position); get_deal_timeline (RECONCILE / "what happened" — returns computed findings; use this for any detailed deal analysis); diagnose_deal ("why is it stuck/failing", state plus log events); get_deal_events (raw log lines only); get_paused_deals (what is stuck and why). When unsure among these, prefer get_deal_timeline.',
	'• Orders placed: count_orders (how many base/safety orders were PLACED and which deals placed them, for a day or range). This is a count of activity — NOT the same as find_deals_near_max_safety_orders (which is ladder-cushion risk).',
	'• Finished trades & performance: get_performance_summary (HOW MANY completed, total profit, win rate, average %, best/worst over a period — counts and totals of completed deals); get_pair_performance (rank PAIRS most/least profitable or most active); get_bot_performance (rank BOTS most/least profitable or most active — "which bot is doing best"); list_recent_completed_deals (only to show the latest few closed deals).',
	'• Bots & system: list_bots (bot SETTINGS / which are enabled — configuration, not results; for which bot earns most use get_bot_performance); get_exchanges (which exchange(s) the user actually trades on, live vs sandbox — for "which exchange am I on", "am I live or in sandbox"); get_circuit_breaker_status; get_balance (raw wallet balances) vs get_portfolio_summary (exposure, deployed vs available, "dry powder"); count_restarts; get_system_status (live runtime status — UPTIME / how long it has been running, memory use, CPU load, active-deal count, app version; the ONLY source for uptime, never guess a product age); calculate (evaluate an arithmetic expression exactly — use it for any multi-step math like safety-order size compounding 1.5^3 or percentage/break-even math instead of doing it in your head).',
	'• Logs: search_logs (plain-language log search; it returns surrounding context, so a deal id on the neighboring line is included); summarize_recent_errors (genuine errors/problems only).',
	'• Signals, risk, audit & schedules: get_signal_activity (inbound Signal Bot / webhook activity — every authenticated signal from TradingView, 3CQS or the API, what SymBot did with it, plus per-source counts and latency; use for "why are my 3CQS signals slow", "did my TradingView alert arrive", "how many signals were rejected"); get_drawdown_risk (the portfolio drawdown-risk view); list_audit_events (the security/audit trail — who or which API key performed a sensitive action such as a settings change, deal action, or key/user change); list_schedules (the configured scheduled tasks and their state).',
	'• Ranking & multi-deal views: get_top_deals (leaderboard of deals by performance — set direction best/worst); get_deals_closest_to_take_profit (open deals ranked by nearest to take-profit — "which will close soonest"); get_deals_for_pair (the deal or deals for a specific pair, with live status); get_open_orders_summary (total order usage across ALL open deals at once — total safety orders used, base and filled orders); get_deals_over_time (completed deals bucketed by day/week/month); compare_bot_performance (named bots head-to-head); compare_deal_to_baseline (diagnose one completed deal by contrasting it with opposite-outcome deals on the same pair).',
	'• Log analysis & incidents: analyze_logs (flexible "how many / when / how often / correlate" questions the fixed log tools do not cover); analyze_error_baseline (compare the error mix in a window against the days before it — flags new or spiking errors); find_incident (correlate an incident around an approximate time — clusters errors, auth and network failures, restarts and resumes); get_events_in_window ("what happened between T1 and T2" across ALL deals); scan_price_anomalies (flag implausible follow-loop prices — zero or invalid, a wild profit %, or a big deviation).',
	'• Deeper reasoning: get_expert_analysis (consult a stronger model for a judgement on figures you have ALREADY gathered — include those figures in the question; use sparingly); explore (delegate a BROAD, multi-step research question to a sub-agent that calls the read-only tools itself and returns one synthesized answer — for open-ended investigations, use sparingly).',
	'For the current date or time (including other time zones), answer directly from the "Current date and time" note — do NOT call a tool. There is no tool for live market prices or price predictions; say you do not have that.'
].join('\n');


// ── Corpus resilience: tool aliases + tool-set fingerprint ───────────────────────
// A saved corpus (seed, community, Hub) references tools by NAME, so renaming or replacing
// a tool would otherwise orphan every pattern that used it. To change how something works
// WITHOUT rebuilding the corpus, add the retired name here → its current equivalent. On
// import, verifyPack resolves aliases before the whitelist check and stores the CURRENT
// name, so old packs keep working across refactors. (Merging two tools into one: point both
// old names at the new one. Splitting one into two: point the old name at the primary.)
const TOOL_ALIASES = {
	// 'old_tool_name': 'current_tool_name',
};

const TOOL_NAME_SET = new Set(TOOLS.map(t => t.name));

// ── Enum-locked tool decoding ────────────────────────────────────────────────────
// The set of valid tool names IS a closed enum. A small model, or the JSON-in-text fallback,
// sometimes emits a name that is off by formatting (camelCase, spaces, hyphens) or by a character
// or two (get_performance → get_performance_summary). Rather than burn a whole tool round on
// "Unknown tool", coerce the emitted name back onto the enum here, or reject it as genuinely
// unknown. This never invents a call the model did not make — it only canonicalises the name.

// Canonical form: lowercase, camelCase→snake, any run of non-alphanumerics → one underscore.
// So getPerformanceSummary, "get performance summary" and get-performance-summary all fold to
// get_performance_summary.
function normalizeToolName(name) {
	return String(name || '')
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
}

// Lookup of canonical name by normalized form (built once).
const NORMALIZED_NAME_MAP = TOOLS.reduce((m, t) => { m[normalizeToolName(t.name)] = t.name; return m; }, {});

// Bounded Levenshtein distance — returns early (max+1) once it is clearly over the cap, so the
// last-resort nearest-match stays cheap even across the whole shortlist.
function boundedEditDistance(a, b, max) {
	if (Math.abs(a.length - b.length) > max) { return max + 1; }
	let prevRow = []; for (let j = 0; j <= b.length; j++) { prevRow[j] = j; }
	for (let i = 1; i <= a.length; i++) {
		const row = [ i ]; let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			row[j] = Math.min(prevRow[j] + 1, row[j - 1] + 1, prevRow[j - 1] + cost);
			if (row[j] < rowMin) { rowMin = row[j]; }
		}
		if (rowMin > max) { return max + 1; }
		prevRow = row;
	}
	return prevRow[b.length];
}

// Resolve a possibly-off tool name to a canonical registry name, or null if genuinely unknown.
// Order, safest first: exact → alias → normalized (exact or aliased) → (only when `candidates`
// is given) nearest by edit distance ≤ 2 among that shortlist. The fuzzy step is deliberately
// scoped to the tools we actually offered the model this turn, so a near-miss repairs to a tool
// that was on the table rather than to some arbitrary registry entry.
function resolveTool(name, candidates) {
	if (typeof name !== 'string' || !name) { return null; }
	if (TOOL_NAME_SET.has(name)) { return name; }
	if (TOOL_ALIASES[name] && TOOL_NAME_SET.has(TOOL_ALIASES[name])) { return TOOL_ALIASES[name]; }

	const norm = normalizeToolName(name);
	if (NORMALIZED_NAME_MAP[norm]) { return NORMALIZED_NAME_MAP[norm]; }
	if (TOOL_ALIASES[norm] && TOOL_NAME_SET.has(TOOL_ALIASES[norm])) { return TOOL_ALIASES[norm]; }

	if (Array.isArray(candidates) && candidates.length) {
		let best = null, bestDist = 3;
		for (const c of candidates) {
			const canonical = TOOL_NAME_SET.has(c) ? c : NORMALIZED_NAME_MAP[normalizeToolName(c)];
			if (!canonical) { continue; }
			const d = boundedEditDistance(norm, normalizeToolName(canonical), 2);
			if (d < bestDist) { bestDist = d; best = canonical; }
		}
		if (best) { return best; }
	}

	return null;
}

// A short, stable fingerprint of the current tool set — recorded in a pack card so drift
// between where a pack was built and this install is visible (informational, not enforced).
function toolSignature() {
	const names = TOOLS.map(t => t.name).slice().sort().join(',');
	return require('crypto').createHash('sha256').update(names).digest('hex').slice(0, 16);
}


// Detect DRIFT between the shipped learning corpus and the live tool registry — the safety net that
// keeps the AI learning from silently breaking when tools change. Returns an array of Watchdog-shaped
// findings ({ action, target, detail }); empty when clean. Two kinds of drift:
//   • ORPHANS — a corpus pattern names a tool that no longer RESOLVES (renamed or removed WITHOUT a
//     TOOL_ALIASES mapping). Such patterns are dropped on import, so learning silently forgets the
//     tool. This is the "a tool rename broke learning" alarm; the fix is a TOOL_ALIASES old→new entry.
//   • COVERAGE — registered tools that have NO corpus pattern at all (added since the corpus was last
//     built). Routing still works via the keyword rules, but retrieval has nothing to learn from, so
//     the seed corpus should be refreshed to include them. Tools that are never a routed retrieval
//     target (explore, get_expert_analysis) are excluded.
const NO_CORPUS_NEEDED = new Set([ 'explore', 'get_expert_analysis' ]);

// Watchdog check: the tool SCHEMAS (data, ./data/tools.json) and the tool HANDLERS (code) must
// stay in sync. TOOLS is built by merging schema-by-name with handler-by-name, so a handler with
// no schema becomes a nameless tool the model can never select, and a schema with no handler is
// dead weight. This catches an editor renaming one half but not the other. Returns null when the
// two halves match exactly.
function auditToolSchemaParity() {

	const schemaNames = new Set(TOOL_SCHEMAS.map(s => s && s.name).filter(Boolean));
	const handlerNames = new Set(TOOL_HANDLERS.map(h => h && h.name).filter(Boolean));

	const handlersNoSchema = [ ...handlerNames ].filter(n => !schemaNames.has(n));
	const schemasNoHandler = [ ...schemaNames ].filter(n => !handlerNames.has(n));
	const brokenTools = TOOLS.filter(t => !t.name || !t.description || !t.parameters).map(t => t.name || '(unnamed)');

	if (handlersNoSchema.length || schemasNoHandler.length || brokenTools.length) {

		return {
			action: 'watchdog.tool_schema_mismatch',
			target: String(handlersNoSchema.length + schemasNoHandler.length + brokenTools.length),
			detail: 'tool schema/handler drift — handlers with no schema in tools.json: [' + handlersNoSchema.join(', ') + ']; schemas with no handler: [' + schemasNoHandler.join(', ') + ']; merged tools missing schema fields: [' + brokenTools.join(', ') + ']'
		};
	}

	return null;
}


function auditToolGuideCoverage() {

	// Every registered tool should be mentioned in TOOL_GUIDE (the prose disambiguation injected into the
	// system prompt). Routing still works without it, but a tool missing from the guide is under-documented
	// for the model. Flag any tool whose name does not appear in the guide text so it can't silently drift.
	// Match on a word boundary rather than a bare substring, so a short tool name (e.g. get_deal) is not
	// counted as "covered" merely because it appears inside a longer one (get_deal_orders). Tool names are
	// [a-z0-9_], and `\b` treats `_` as a word char, so the boundary correctly delimits whole names.
	const missing = TOOLS.map(t => t.name).filter(n => n && !new RegExp('\\b' + n + '\\b').test(TOOL_GUIDE));

	if (missing.length) {

		return {
			action: 'watchdog.tool_guide_coverage',
			target: String(missing.length),
			detail: 'registered tools missing from the TOOL_GUIDE prose (add a mention so the model can disambiguate them): ' + missing.sort().join(', ')
		};
	}

	return null;
}


function auditLearningDrift() {

	let seed;
	try { seed = require('./data/seed-learning.json'); }
	catch (e) { return []; }

	const records = (seed && Array.isArray(seed.records)) ? seed.records : [];
	if (!records.length) { return []; }

	const orphans = new Set();
	const covered = new Set();

	for (const rec of records) {
		for (const t of (rec.tools || [])) {
			const canonical = resolveTool(t);
			if (canonical) { covered.add(canonical); }
			else { orphans.add(t); }
		}
	}

	const findings = [];

	if (orphans.size) {
		findings.push({ action: 'watchdog.ai_learning_orphans', target: String(orphans.size),
			detail: 'learning corpus references tools that no longer resolve — add a TOOL_ALIASES entry mapping each old name to its replacement: ' + Array.from(orphans).sort().join(', ') });
	}

	const uncovered = TOOLS.map(t => t.name).filter(n => !covered.has(n) && !NO_CORPUS_NEEDED.has(n));
	if (uncovered.length) {
		findings.push({ action: 'watchdog.ai_learning_coverage', target: String(uncovered.length),
			detail: 'registered tools with no learning-corpus patterns (refresh the seed corpus to cover them): ' + uncovered.sort().join(', ') });
	}

	return findings;
}


module.exports = {
	TOOLS,
	TOOL_GUIDE,
	TOOL_ALIASES,
	listSchemas,
	constrainToolSchemas,
	reconcileToolArgs,
	selectTools,
	resolveTool,
	normalizeToolName,
	errorBaselineWindows,
	toolSignature,
	auditLearningDrift,
	auditToolSchemaParity,
	auditToolGuideCoverage,
	execute,
	setExpert,
	setSubAgent,
	exploreEnabled,
	// Exported for testing: the period-window helpers whose robustness to small-model "null"-string
	// arguments is what keeps "best/worst/top pair" answering over all-time instead of a garbage window.
	argPresent,
	windowIfNamed,
	orderWindow,
	// Tools that intentionally need no learning-corpus coverage (orchestrators/meta-tools), so the
	// coverage report and the watchdog agree on what counts as "uncovered".
	NO_CORPUS_NEEDED,
	init: function (obj) { shareData = obj; }
};