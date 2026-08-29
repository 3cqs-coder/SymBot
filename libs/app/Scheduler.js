'use strict';


// Central scheduling core.
//
// One place tracks every timed job in the instance, of two origins:
//
//   • System jobs  — defined in app.json config and owned by a feature (e.g. the
//                    database backup). Their definition lives in config, not the
//                    database; the owner (re-)registers them with registerSystemJob().
//
//   • User jobs    — user-defined records stored in the `schedules` collection and
//                    managed through add/update/remove/setEnabled/runNow. Each carries
//                    a `type` that maps to a handler registered via registerHandler().
//
// Both kinds share one in-memory registry and one arming engine that understands two
// scheduling `kind`s: 'once' (a single run via setTimeout) and 'cron' (a recurring
// node-cron job). All cron expressions are evaluated in UTC so stored schedules are
// timezone-stable; the UI converts to/from the browser's local time at the edges.
//
// The core itself is feature-agnostic: it knows nothing about AI, backups, or trading.
// It only arms timers and dispatches to handlers. User jobs are scoped by server_id so
// that, under the Hub, an instance only runs its own schedules (see the multi-instance
// note in the docs for the shared-database edge case).


const cron = require('node-cron');
const ScheduleDB = require('../mongodb/ScheduleSchema');
const ScheduleRunDB = require('../mongodb/ScheduleRunSchema');


const MAX_TIMEOUT = 2147483647;                         // setTimeout ceiling (~24.8 days)
const MAX_ONCE_HORIZON_MS = 60 * 24 * 60 * 60 * 1000;   // 60 days out, max, for a one-off
const MAX_PROMPT_CHARS = 2000;
const MAX_RUNS_PER_SCHEDULE = 25;                       // run-history retention (successes / normal runs)
const MAX_FAILURE_RUNS = 50;                            // failures are kept longer — they are what you debug
const FAILURE_STATUSES = [ 'error', 'timed_out' ];      // statuses that count against the failure retention cap
const ESCALATE_AFTER_DEFAULT = 3;                       // consecutive failures before a schedule escalates

// Next consecutive-failure count after a run: a genuine failure increments, a success resets to zero,
// and a missed/skipped run leaves it unchanged (it is not a real failure signal). Pure/testable.
function nextConsecutiveFailures(prev, status) {
	const p = Number(prev) || 0;
	if (status === 'error' || status === 'timed_out') { return p + 1; }
	if (status === 'ok') { return 0; }
	return p;
}

// Whether a run that has just failed should raise an escalation alert: on first reaching the threshold
// and every `threshold` failures thereafter, so a persistently broken job keeps reminding without
// alerting on every single failure. Pure/testable.
function shouldEmitEscalation(consec, threshold) {
	const t = Math.max(2, Number(threshold) || ESCALATE_AFTER_DEFAULT);
	return consec >= t && (consec === t || (consec % t) === 0);
}
const RUN_TIMEOUT_DEFAULT_MS = 15 * 60 * 1000;          // a handler that runs longer is abandoned as timed_out
const DEFAULT_TYPE = 'ai_analysis';

const CATCHUP_MODES = [ 'skip', 'once', 'all' ];        // missed-run policy after downtime
const CATCHUP_MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;// never make up occurrences older than this
const CATCHUP_MAX_RUNS = 10;                            // cap make-up runs per schedule (mode 'all')
const CONCURRENCY_MODES = [ 'forbid', 'allow' ];        // what to do when a run is already active
const RETRY_MODES = [ 'fixed', 'exponential' ];         // backoff growth between retry attempts
const MAX_RETRIES = 5;                                  // hard cap on extra attempts
const RETRY_BASE_DELAY_MS = 5000;                       // default delay between attempts when none set
const RETRY_MAX_DELAY_MS = 5 * 60 * 1000;               // cap a single backoff delay
const SCHEDULE_SCHEMA_VERSION = 5;                      // current schedule-document shape (matches the ScheduleSchema default; bumped when the off-site upload tracking fields were added)


let shareData;

// jobId -> { origin: 'system'|'user', kind, task | timeoutId }
const handles = new Map();

// type -> async (job, shareData) => { status, ... }
const handlers = new Map();

// name -> { name, type, kind, cron, run_at, enabled, task }  (config-sourced definitions)
const systemJobs = new Map();

// schedule_id currently executing — prevents a schedule from running twice at once
// (e.g. a second "Run now" click, or a cron tick landing on a manual run).
const activeRuns = new Set();


let logger = function () {};   // assigned in init() via Common.makeLogger


function uuid() {

	if (shareData && shareData.Common && typeof shareData.Common.uuidv4 === 'function') { return shareData.Common.uuidv4(); }
	return require('crypto').randomUUID();
}


function serverId() {

	return (shareData && shareData.appData && shareData.appData.server_id) || '';
}


// ── Handler registry ─────────────────────────────────────────────────────────

// Register the function that runs when a user job of the given `type` fires. The
// handler receives the public job object and shareData, and should return an object
// with a `status` ('ok' | 'error'); it owns whatever the job does, including delivery.
function registerHandler(type, fn) {

	handlers.set(type, fn);
}


// The set of job types that currently have a registered handler.
// Integrity check (Watchdog): every schedule row's `type` must map to a registered handler. A row
// whose type has no handler will NEVER run when it fires — the classic silent failure after a handler
// is renamed or removed (e.g. an old 'ai_watchdog' row left behind after that type became
// 'error_watchdog'). Async (queries the DB); returns a finding or null. Registered from start().
async function scheduleHandlerCoverageCheck() {

	const registered = new Set(handlers.keys());

	let types;
	try { types = await ScheduleDB.ScheduleSchema.distinct('type', { 'server_id': serverId() }); }
	catch (e) { return null; }   // DB unreachable at check time — skip rather than raise a false alarm

	const orphaned = (types || []).filter(t => t && !registered.has(t));

	if (orphaned.length) {
		return {
			action: 'watchdog.orphaned_schedule_types',
			target: String(orphaned.length),
			detail: 'schedule rows use a type with no registered handler (they will never run) — usually a renamed or removed handler type: ' + orphaned.sort().join(', ')
		};
	}

	return null;
}


// ── Schedule heartbeat (Watchdog): is every enabled schedule actually primed to fire? ────────
// A DB schedule is armed under its own schedule_id (see armUser). An ENABLED schedule that is NOT in
// the armed set will never fire — the classic silent failure, most often an enabled cron whose cron
// expression was rejected at arm time (armSchedule skips an invalid cron). This is the missed-run
// detector: it catches exactly the schedules that would silently stop producing runs.
//
// PURE core, separated from DB/handle gathering so it is unit-testable. Returns the human labels of
// schedules that are not primed to run.
function evaluateHeartbeat(rows, armedIds, now) {

	const armed = (armedIds instanceof Set) ? armedIds : new Set(armedIds || []);
	const stalled = [];

	for (const row of (rows || [])) {

		if (!row || !row.enabled) { continue; }

		const name = row.label || row.schedule_id || row.type || 'schedule';

		if (row.kind === 'cron') {

			// An enabled cron must always be armed while the process is up.
			if (!armed.has(row.schedule_id)) { stalled.push(name + ' (cron not armed — will never fire)'); }
		}
		else if (row.kind === 'once') {

			// Only a FUTURE one-shot needs to be armed; a past one-shot has either run or been made
			// up/disabled by the catch-up logic, so it is never a heartbeat concern.
			const runAtMs = row.run_at ? new Date(row.run_at).getTime() : NaN;
			if (isFinite(runAtMs) && runAtMs > now && !armed.has(row.schedule_id)) {
				stalled.push(name + ' (future one-shot not armed — will miss its run time)');
			}
		}
	}

	return stalled;
}

async function scheduleHeartbeatCheck() {

	let rows;
	try { rows = await ScheduleDB.ScheduleSchema.find({ 'server_id': serverId(), 'enabled': true }); }
	catch (e) { return null; }   // DB unreachable at check time — skip rather than raise a false alarm

	const stalled = evaluateHeartbeat(rows, new Set(handles.keys()), Date.now());

	if (stalled.length) {
		return {
			action: 'watchdog.schedule_heartbeat',
			target: String(stalled.length),
			detail: 'enabled schedule(s) not primed to run (a silent scheduling failure): ' + stalled.join('; ')
		};
	}

	return null;
}


// Watchdog: the enabled BACKUP schedule's most recent run FAILED. The granular escalation notification only
// fires after several CONSECUTIVE failures, so a backup that has failed once or twice — already long enough to
// leave the instance without a fresh backup — otherwise has no standing surface, and a missed or muted
// notification leaves nothing at all. This is a quiet, always-visible boot-time backstop: warn-only, scoped to
// the backup singleton (a lapsed backup is a data-protection risk, so high signal / low noise), and driven by
// `consecutive_failures` — scheduled runs only, so a failed manual TEST backup never raises it — which resets to
// zero on the next successful backup, so the warning clears itself.
// Pure decision (testable without a database): given the enabled backup schedule row — or null/undefined when
// there is none — return a finding when its last run(s) failed, else null.
function evaluateBackupHealth(row) {

	if (!row) { return null; }   // no enabled backup schedule → nothing to check

	const consec = Number(row.consecutive_failures) || 0;
	if (consec < 1) { return null; }

	// A successful run SINCE the failing scheduled one clears the warning — including a manual "Run now",
	// which deliberately does not reset the scheduled-failure counter (that counter drives escalation and must
	// reflect scheduled runs only). So if the most recent run of any kind succeeded, the backup is working
	// again; don't nag until the next SCHEDULED failure. (The off-site counter needs no such escape hatch — a
	// manual run records its upload outcome directly, resetting it on success.)
	if (row.last_status === 'ok') { return null; }

	return {
		action: 'watchdog.backup_last_run_failed',
		target: String(consec),
		detail: 'the scheduled database backup has failed its last ' + consec + ' run(s) in a row, so this instance may have no fresh backup. Check the Backups configuration and the logs; the warning clears once a backup succeeds.'
	};
}

// Pure decision (testable without a database) for the OFF-SITE half of backup health: given the enabled backup
// schedule row, return a finding when its last off-site (SFTP) upload(s) failed, else null. The off-site upload
// is fire-and-forget (it must never fail the local backup), so its outcome is tracked on its own fields and
// evaluated here — separately from evaluateBackupHealth, which covers the local backup. Gated on the off-site
// destination actually being configured, so a failure from before the user turned SFTP off never lingers.
function evaluateOffsiteBackupHealth(row) {

	if (!row) { return null; }   // no enabled backup schedule → nothing to check

	const sftp = row.settings && row.settings.sftp;
	if (!sftp || !sftp.enabled || !sftp.host) { return null; }   // off-site upload not configured → nothing to check

	const consec = Number(row.offsite_consecutive_failures) || 0;
	if (consec < 1) { return null; }

	return {
		action: 'watchdog.offsite_backup_last_upload_failed',
		target: String(consec),
		detail: 'the off-site (SFTP) copy of the database backup has failed to upload its last ' + consec + ' time(s) in a row, so the off-site backup may be stale even though the local backup succeeded. Check the off-site destination in the Backups configuration and the logs; the warning clears once an upload succeeds.'
	};
}

// One boot Watchdog for backup health, covering BOTH the local run and the off-site upload from a single query.
// The two concerns stay separated in their pure evaluators above; this shared wrapper just loads the backup
// singleton once and returns whichever findings apply (0, 1, or 2 — the Watchdog runner accepts an array). Each
// finding carries its own action code, so both remain individually explained in the Diagnostics catalog.
async function backupHealthCheck() {

	let row;
	try { row = await ScheduleDB.ScheduleSchema.findOne({ 'server_id': serverId(), 'type': 'backup', 'enabled': true }); }
	catch (e) { return null; }   // DB unreachable at check time — skip rather than raise a false alarm

	return [ evaluateBackupHealth(row), evaluateOffsiteBackupHealth(row) ].filter(Boolean);
}


// Record the outcome of a fire-and-forget off-site (SFTP) backup upload onto the backup singleton, so the
// offsite_backup_last_upload_failed Watchdog can surface a persistently failing off-site copy at startup. Mirrors
// the run-tracking fields (last_status / consecutive_failures): the failure counter resets to zero on a success.
// Best-effort and self-contained — it must NEVER throw back into the upload's promise chain or the backup job.
async function recordBackupSftpResult(ok) {

	try {

		const set = { last_offsite_status: ok ? 'ok' : 'error', last_offsite_at: new Date() };
		const update = ok
			? { $set: { ...set, offsite_consecutive_failures: 0 } }
			: { $set: set, $inc: { offsite_consecutive_failures: 1 } };

		await ScheduleDB.ScheduleSchema.updateOne({ server_id: serverId(), type: 'backup' }, update);
	}
	catch (e) { try { logger('off-site upload result record failed: ' + e.message); } catch (le) {} }
}


// ── Arming engine (shared by system + user jobs) ─────────────────────────────

// Arm a one-off timer, chunking delays longer than setTimeout can hold.
function armOnce(jobId, origin, runAtMs, onFire) {

	const delay = runAtMs - Date.now();

	if (delay <= 0) { return; }   // past due — caller handles this

	if (delay > MAX_TIMEOUT) {

		const t = setTimeout(() => armOnce(jobId, origin, runAtMs, onFire), MAX_TIMEOUT);
		handles.set(jobId, { origin, kind: 'once', timeoutId: t });
		return;
	}

	const t = setTimeout(() => { Promise.resolve().then(onFire).catch(() => {}); }, delay);
	handles.set(jobId, { origin, kind: 'once', timeoutId: t });
}


// Arm a cron or once schedule under a stable id, calling onFire when it triggers.
function armSchedule(jobId, origin, def, onFire) {

	disarm(jobId);

	if (def.kind === 'cron') {

		if (!cron.validate(def.cron)) { logger('invalid cron on arm, skipping ' + jobId); return; }

		// Evaluate the cron in the schedule's own timezone when one is set (so a local time
		// stays fixed across daylight-saving changes); blank means UTC, the legacy behavior.
		const tz = (def.timezone && validTimezone(def.timezone)) ? def.timezone : 'UTC';

		const task = cron.schedule(def.cron, () => { Promise.resolve().then(onFire).catch(() => {}); }, { timezone: tz });
		handles.set(jobId, { origin, kind: 'cron', task });
	}
	else if (def.kind === 'once' && def.run_at) {

		armOnce(jobId, origin, new Date(def.run_at).getTime(), onFire);
	}
}


function disarm(jobId) {

	const h = handles.get(jobId);
	if (!h) { return; }

	try {
		if (h.kind === 'cron' && h.task) { h.task.stop(); if (typeof h.task.destroy === 'function') { h.task.destroy(); } }
		else if (h.timeoutId) { clearTimeout(h.timeoutId); }
	}
	catch (e) { /* best effort */ }

	handles.delete(jobId);
}


// ── System jobs (config-sourced, e.g. database backup) ───────────────────────

// Register/re-register a config-defined job and (re-)arm it. Called by the feature
// that owns it (with the schedule read from app.json). Passing enabled=false, or a
// blank cron, disarms it. The `task` is the function to run when it fires.
function registerSystemJob(def) {

	const name = String(def.name || '').trim();
	if (!name) { return { success: false, error: 'System job requires a name.' }; }

	const jobId = 'system:' + name;

	const record = {
		name,
		type: def.type || name,
		kind: def.kind === 'once' ? 'once' : 'cron',
		cron: String(def.cron || '').trim(),
		run_at: def.run_at || null,
		enabled: def.enabled !== false,
		task: def.task
	};

	systemJobs.set(name, record);
	disarm(jobId);

	if (!record.enabled) { return { success: true }; }
	if (record.kind === 'cron' && !record.cron) { return { success: true }; }
	if (typeof record.task !== 'function') { return { success: false, error: 'System job requires a task function.' }; }

	armSchedule(jobId, 'system', record, () => record.task());
	logger('armed system job ' + name + ' (' + (record.kind === 'cron' ? record.cron + ' UTC' : 'once') + ')');

	return { success: true };
}


function unregisterSystemJob(name) {

	disarm('system:' + String(name));
	systemJobs.delete(String(name));
}


// ── User jobs (database-backed) ──────────────────────────────────────────────

// Whether a string is an IANA timezone the runtime can evaluate (Intl throws on an
// unknown zone). Blank/non-string is not valid here — callers treat that as "unset".
function validTimezone(tz) {

	if (typeof tz !== 'string' || tz.trim() === '') { return false; }

	try { new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }); return true; }
	catch (e) { return false; }
}


// Validate + normalize an incoming user-job definition. Returns { ok, error, doc }.
function validate(data, opts) {

	const kind = data.kind === 'cron' ? 'cron' : (data.kind === 'once' ? 'once' : null);
	if (!kind) { return { ok: false, error: 'kind must be "once" or "cron".' }; }

	const type = String(data.type || DEFAULT_TYPE).trim() || DEFAULT_TYPE;

	// A prompt is the payload for AI analysis jobs; other job types (e.g. backup) carry
	// their configuration in `settings` instead.
	const prompt = String(data.prompt || '').trim();
	if (type === 'ai_analysis') {
		if (prompt === '') { return { ok: false, error: 'A prompt (what to analyze) is required.' }; }
		if (prompt.length > MAX_PROMPT_CHARS) { return { ok: false, error: 'Prompt is too long (max ' + MAX_PROMPT_CHARS + ' characters).' }; }
	}

	const doc = { kind, type, prompt, label: String(data.label || '').trim(), schema_version: SCHEDULE_SCHEMA_VERSION };
	if (data.settings && typeof data.settings === 'object') { doc.settings = data.settings; }

	// Missed-run policy after downtime; default 'skip' is the historical behavior.
	doc.catchup = CATCHUP_MODES.indexOf(data.catchup) >= 0 ? data.catchup : 'skip';

	// Optional IANA timezone for DST-correct cron evaluation; blank means evaluate the
	// cron as UTC (the legacy behavior). An unrecognized zone is rejected rather than
	// silently stored, so a schedule never fires against a zone the runtime can't honor.
	if (data.timezone != null && String(data.timezone).trim() !== '') {
		if (!validTimezone(data.timezone)) { return { ok: false, error: 'Unrecognized timezone.' }; }
		doc.timezone = String(data.timezone).trim();
	}
	else { doc.timezone = ''; }

	// Concurrency policy: what to do if a run is already active ('forbid' default | 'allow').
	doc.concurrency = CONCURRENCY_MODES.indexOf(data.concurrency) >= 0 ? data.concurrency : 'forbid';

	// Retry-on-failure: extra attempts (clamped) + backoff shape + base delay.
	const retries = parseInt(data.retries, 10);
	doc.retries = Math.min(Math.max(isNaN(retries) ? 0 : retries, 0), MAX_RETRIES);
	doc.retry_backoff = RETRY_MODES.indexOf(data.retry_backoff) >= 0 ? data.retry_backoff : 'fixed';
	const rdelay = parseInt(data.retry_delay_ms, 10);
	doc.retry_delay_ms = (!isNaN(rdelay) && rdelay > 0) ? Math.min(rdelay, RETRY_MAX_DELAY_MS) : 0;

	if (kind === 'cron') {

		const expr = String(data.cron || '').trim();
		if (!cron.validate(expr)) { return { ok: false, error: 'Invalid cron expression (use 5 fields, UTC).' }; }
		// Enforce the 5-field NUMERIC contract. node-cron also accepts a 6-field form (with
		// seconds) and named tokens (MON, JAN), but those get no missed-run catch-up (the catch-up
		// engine can only compute plain 5-field numeric expressions) and a 6-field form could
		// smuggle in a runs-every-few-seconds schedule. Reject anything parseCron can't handle so
		// what the UI promises (5-field UTC) is what actually runs — including catch-up.
		if (!parseCron(expr)) { return { ok: false, error: 'Use a plain 5-field cron (minute hour day-of-month month day-of-week) with numeric fields only, in UTC.' }; }
		doc.cron = expr;
		doc.run_at = null;
	}
	else {

		const at = new Date(data.run_at);
		if (isNaN(at.getTime())) { return { ok: false, error: 'run_at must be a valid date/time.' }; }

		const now = Date.now();
		// allowPastOnce: an EDIT that doesn't change run_at (e.g. relabel or change notification targets on
		// a one-shot that already fired) must not be rejected just because its time is now in the past. A
		// caller setting a NEW run_at still gets the future-time check.
		const allowPastOnce = !!(opts && opts.allowPastOnce);
		if (!allowPastOnce && at.getTime() <= now) { return { ok: false, error: 'run_at must be in the future.' }; }
		if (at.getTime() - now > MAX_ONCE_HORIZON_MS) { return { ok: false, error: 'run_at is too far in the future (max 60 days).' }; }

		doc.run_at = at;
		doc.cron = '';
	}

	return { ok: true, error: null, doc };
}


// Run one user job now. `manual` (a Run-now) records the run but does not consume or
// disable a one-off, and leaves the armed timer untouched. Guarded so the same schedule
// never runs concurrently — a second attempt while one is in flight is refused.
// Race a promise against a timeout. Resolves with the promise's value, or rejects with a
// tagged error (err.timedOut) after `ms`. The timer is unref'd and always cleared so it
// never keeps the process alive, and a handler that finishes late becomes a harmless no-op
// (its result is ignored). Note: JavaScript cannot cancel the underlying work — the point
// is to free the schedule (record the run, release the concurrency lock) rather than leave
// it stuck forever behind a hung handler. Single exit via the race.
function withTimeout(promise, ms) {
	// Shared timeout logic (shareData.Common.withTimeout); tag the rejection with err.timedOut so runUserJob
	// can tell a timed-out run from a genuine handler error (it is NOT retried, and frees the concurrency lock).
	return shareData.Common.withTimeout(promise, ms, { message: 'Scheduler run timed out after ' + ms + 'ms', timedOut: true });
}


// The execution time limit for a run: a positive per-schedule override in
// settings.timeout_ms, otherwise the default. Single exit.
function resolveTimeout(row) {

	const v = row && row.settings ? Number(row.settings.timeout_ms) : NaN;

	return (!isNaN(v) && v > 0) ? v : RUN_TIMEOUT_DEFAULT_MS;
}


// Whether a run status counts as a failure for retention (kept longer than successes).
function isFailureStatus(status) {

	return FAILURE_STATUSES.indexOf(status) >= 0;
}


// The number of extra attempts a failed run may make, clamped to the hard cap.
function resolveRetries(row) {

	const v = row ? parseInt(row.retries, 10) : 0;

	return Math.min(Math.max(isNaN(v) ? 0 : v, 0), MAX_RETRIES);
}


// The delay before a given retry attempt (attempt is 1-based: 1 = first retry). Fixed
// keeps the base delay; exponential doubles it each attempt. Capped. Single exit.
function retryDelay(row, attempt) {

	const base = (row && parseInt(row.retry_delay_ms, 10) > 0) ? parseInt(row.retry_delay_ms, 10) : RETRY_BASE_DELAY_MS;
	const mode = row && RETRY_MODES.indexOf(row.retry_backoff) >= 0 ? row.retry_backoff : 'fixed';

	const ms = (mode === 'exponential') ? base * Math.pow(2, Math.max(attempt - 1, 0)) : base;

	return Math.min(ms, RETRY_MAX_DELAY_MS);
}


// A non-blocking sleep whose timer never keeps the process alive.
function sleep(ms) {

	return new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t && typeof t.unref === 'function') { t.unref(); } });
}


// ── Cron occurrence engine (dependency-free, timezone-aware) ─────────────────
//
// node-cron only fires the future; it can't tell us which occurrences were MISSED while
// the process was down. To make up missed runs we compute occurrences of a 5-field cron
// expression between two instants. It is timezone-aware from the start (via Intl, no
// dependency): a schedule's occurrences are matched against the wall-clock time in its
// own timezone, defaulting to UTC — which is exactly how existing UTC-cron schedules are
// already stored and evaluated, so their behavior is unchanged.

// Expand one cron field ("*", "*/5", "1-5", "0,30", "1-5/2") into the set of matching
// integers within [min,max]. Returns { set, star }. star is true for a bare "*".
function cronFieldSet(field, min, max) {

	const set = new Set();
	let star = false;

	for (const tokRaw of String(field).split(',')) {

		const tok = tokRaw.trim();
		if (tok === '') { continue; }

		let range = tok;
		let step = 1;

		const slash = tok.indexOf('/');
		if (slash >= 0) { range = tok.slice(0, slash); step = parseInt(tok.slice(slash + 1), 10) || 1; }

		let lo, hi;

		if (range === '*') { lo = min; hi = max; if (step === 1) { star = true; } }
		else if (range.indexOf('-') >= 0) { const parts = range.split('-'); lo = parseInt(parts[0], 10); hi = parseInt(parts[1], 10); }
		else { lo = hi = parseInt(range, 10); }

		if (isNaN(lo) || isNaN(hi)) { continue; }

		for (let v = lo; v <= hi; v += step) { set.add(v); }
	}

	return { set, star };
}


// Parse a 5-field cron into per-field sets, or null if it is not a plain 5-field
// expression. Day-of-week 7 is normalized to 0 (both mean Sunday).
function parseCron(expr) {

	const f = String(expr || '').trim().split(/\s+/);
	if (f.length !== 5) { return null; }

	const minute = cronFieldSet(f[0], 0, 59);
	const hour   = cronFieldSet(f[1], 0, 23);
	const dom    = cronFieldSet(f[2], 1, 31);
	const month  = cronFieldSet(f[3], 1, 12);
	const dow    = cronFieldSet(f[4], 0, 7);

	if (dow.set.has(7)) { dow.set.add(0); }

	if (!minute.set.size || !hour.set.size || !dom.set.size || !month.set.size || !dow.set.size) { return null; }

	return { minute, hour, dom, month, dow };
}


// Build a function returning a Date's wall-clock parts (minute/hour/day/month/dow) in the
// given IANA timezone, reusing one formatter. Falls back to UTC on an invalid zone.
function tzPartsFactory(tz) {

	const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

	let dtf;
	try { dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hour12: false, weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }); }
	catch (e) { dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour12: false, weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }); }

	return function(date) {

		const o = {};
		for (const p of dtf.formatToParts(date)) { o[p.type] = p.value; }

		return {
			minute: Number(o.minute),
			hour: Number(o.hour) % 24,   // some locales render midnight as "24"
			day: Number(o.day),
			month: Number(o.month),
			dow: DOW[o.weekday]
		};
	};
}


// Whether the parsed cron matches the given wall-clock parts. Follows standard cron
// day semantics: when BOTH day-of-month and day-of-week are restricted, either matching
// is enough; when only one is restricted, that one must match.
function cronPartsMatch(parsed, wc) {

	if (!parsed.minute.set.has(wc.minute)) { return false; }
	if (!parsed.hour.set.has(wc.hour)) { return false; }
	if (!parsed.month.set.has(wc.month)) { return false; }

	const domOk = parsed.dom.set.has(wc.day);
	const dowOk = parsed.dow.set.has(wc.dow);

	if (!parsed.dom.star && !parsed.dow.star) { return domOk || dowOk; }
	if (!parsed.dom.star) { return domOk; }
	if (!parsed.dow.star) { return dowOk; }
	return true;   // both '*'
}


// List cron occurrences in (fromMs, toMs], minute-aligned, in the given timezone, up to
// `limit`. Bounded by a hard iteration cap so a huge window can never spin. Single exit.
function cronOccurrences(expr, tz, fromMs, toMs, limit) {

	const parsed = parseCron(expr);
	const out = [];

	if (parsed && toMs > fromMs) {

		const partsOf = tzPartsFactory(tz);
		const cap = Math.min(limit || CATCHUP_MAX_RUNS, CATCHUP_MAX_RUNS);

		// First minute boundary strictly after fromMs.
		let t = Math.floor(fromMs / 60000) * 60000 + 60000;

		let guard = 0;
		const MAX_ITERS = 100000;

		// De-duplicate by wall-clock slot. On a DST fall-back night a local minute (e.g. 01:30)
		// occurs at TWO distinct absolute instants; both would match the same cron slot and, during
		// catch-up, fire the make-up run twice. Keep only the FIRST absolute instant per local slot.
		const seenSlots = new Set();

		while (t <= toMs && out.length < cap && guard++ < MAX_ITERS) {

			const wc = partsOf(new Date(t));

			if (cronPartsMatch(parsed, wc)) {

				const slot = wc.month + '-' + wc.day + '-' + wc.hour + '-' + wc.minute;

				if (!seenSlots.has(slot)) { seenSlots.add(slot); out.push(t); }
			}

			t += 60000;
		}
	}

	return out;
}


// Decide what catch-up a schedule needs on boot, from its own fields and the current
// time. Pure (no DB / no side effects) so it is unit-testable. Returns:
//   { action: 'none' }                     — nothing to make up (arm normally)
//   { action: 'disable_missed' }           — a past one-off with catchup 'skip'
//   { action: 'fire', count, missed }      — run `count` make-up executions now
// The lookback is capped so a long outage never triggers a flood, and mode 'once'
// collapses any number of missed occurrences to a single make-up run. Single exit.
function planCatchup(row, nowMs) {

	let plan = { action: 'none' };

	const catchup = CATCHUP_MODES.indexOf(row.catchup) >= 0 ? row.catchup : 'skip';

	if (row.kind === 'once') {

		const past = row.run_at && new Date(row.run_at).getTime() <= nowMs;

		if (past) {
			plan = (catchup === 'skip') ? { action: 'disable_missed' } : { action: 'fire', count: 1, missed: 1 };
		}
	}
	else if (row.kind === 'cron' && catchup !== 'skip') {

		const ref = row.last_run ? new Date(row.last_run).getTime()
			: (row.createdAt ? new Date(row.createdAt).getTime() : nowMs);

		const from = Math.max(ref, nowMs - CATCHUP_MAX_LOOKBACK_MS);
		const cap = (catchup === 'all') ? CATCHUP_MAX_RUNS : 1;

		const occ = cronOccurrences(row.cron, row.timezone || 'UTC', from, nowMs, cap);
		const count = (catchup === 'once') ? (occ.length ? 1 : 0) : occ.length;

		if (count > 0) { plan = { action: 'fire', count: count, missed: occ.length }; }
	}

	return plan;
}


async function fireUser(scheduleId, manual) {

	if (activeRuns.has(scheduleId)) {

		// A run is already active. The concurrency policy decides: 'forbid' (default)
		// refuses — and a scheduled (non-manual) collision is recorded as 'skipped' so the
		// overlap shows in the history; 'allow' lets this run proceed alongside the other
		// (it runs outside the single-run guard so neither clears the other's lock).
		const policy = await scheduleConcurrency(scheduleId);

		if (policy !== 'allow') {

			if (!manual) { await recordSkipped(scheduleId); }
			return { success: false, error: 'A run is already in progress for this schedule.', busy: true };
		}

		return await runUserJob(scheduleId, manual);
	}

	activeRuns.add(scheduleId);
	try { return await runUserJob(scheduleId, manual); }
	finally { activeRuns.delete(scheduleId); }
}


// Load just the concurrency policy for a schedule (collision path only, so the extra
// read is rare). Defaults to 'forbid' on any doubt. Single exit.
async function scheduleConcurrency(scheduleId) {

	let policy = 'forbid';

	try {

		const row = await ScheduleDB.ScheduleSchema.findOne({ 'schedule_id': scheduleId, 'server_id': serverId() }).select({ 'concurrency': 1 });
		if (row && row.concurrency === 'allow') { policy = 'allow'; }
	}
	catch (e) { /* keep forbid */ }

	return policy;
}


async function runUserJob(scheduleId, manual) {

	let row;

	try { row = await ScheduleDB.ScheduleSchema.findOne({ 'schedule_id': scheduleId, 'server_id': serverId() }); }
	catch (e) { logger('load failed on fire: ' + e.message); return { success: false, error: e.message }; }

	if (!row) { return { success: false, error: 'Schedule not found.' }; }
	if (!manual && !row.enabled) { return { success: false, error: 'Schedule is disabled.' }; }

	logger((manual ? 'running (manual) ' : 'firing ') + scheduleId + ' (' + (row.label || row.type) + ')');

	const handler = handlers.get(row.type);

	let status = 'ok';
	let output = '';
	let attempts = 0;
	let noHandler = false;
	const startedAt = Date.now();

	if (typeof handler !== 'function') {

		status = 'error';
		output = 'No handler registered for type "' + row.type + '".';
		logger('no handler registered for type "' + row.type + '"');
		attempts = 1;
		noHandler = true;
	}
	else {

		const timeoutMs = resolveTimeout(row);
		const maxAttempts = 1 + resolveRetries(row);

		while (attempts < maxAttempts) {

			attempts++;
			status = 'ok';
			output = '';

			try {
				// Promise.resolve wraps a handler that might throw synchronously so the timeout
				// race still governs it. A handler that runs past the limit is abandoned as
				// timed_out and the schedule is freed rather than left stuck forever.
				const result = await withTimeout(Promise.resolve().then(() => handler(publicRow(row), shareData)), timeoutMs);
				if (result && result.status) { status = result.status; }
				if (result && typeof result.output === 'string') { output = result.output; }
			}
			catch (e) {
				if (e && e.timedOut) {
					status = 'timed_out';
					output = 'Run exceeded its time limit (' + Math.round(timeoutMs / 1000) + 's) and was abandoned.';
					logger('handler timed out for ' + scheduleId + ' after ' + timeoutMs + 'ms');
				}
				else {
					status = 'error';
					output = 'Run failed: ' + e.message;
					logger('handler failed for ' + scheduleId + ' (attempt ' + attempts + '/' + maxAttempts + '): ' + e.message);
				}
			}

			// Retry only a genuine error, and only while attempts remain. A timeout is NOT
			// retried — the abandoned handler may still be running, so re-firing could overlap
			// it — and a success obviously stops.
			if (status !== 'error' || attempts >= maxAttempts) { break; }

			const delay = retryDelay(row, attempts);
			logger('retrying ' + scheduleId + ' in ' + delay + 'ms (attempt ' + (attempts + 1) + '/' + maxAttempts + ')');
			await sleep(delay);
		}

		if (attempts > 1 && status === 'error') { output += '\n\n(failed after ' + attempts + ' attempts)'; }
	}

	const ranAt = new Date();
	const durationMs = Math.max(0, Date.now() - startedAt);

	// Record the run on the schedule. A scheduled (non-manual) one-off disables itself.
	try {

		const set = { 'last_run': ranAt, 'last_status': status };
		if (!manual && row.kind === 'once') { set.enabled = false; }

		// Consecutive-failure tracking (scheduled runs only — a manual test run must not count). The
		// counter drives the escalation below.
		const settings = (row.settings && typeof row.settings === 'object') ? row.settings : {};
		const escalateAfter = Math.min(Math.max(parseInt(settings.escalate_after, 10) || ESCALATE_AFTER_DEFAULT, 2), 100);
		const escalatePause = settings.escalate_pause === true;
		let consec = Number(row.consecutive_failures) || 0;

		if (!manual) {
			consec = nextConsecutiveFailures(consec, status);
			set.consecutive_failures = consec;

			// Auto-quarantine (opt-in, off by default): after enough consecutive failures, disable the
			// schedule so a persistently broken job stops re-running, hammering a provider or spamming.
			if ((status === 'error' || status === 'timed_out') && consec >= escalateAfter && escalatePause) {
				set.enabled = false;
			}
		}

		await ScheduleDB.ScheduleSchema.updateOne({ 'schedule_id': scheduleId, 'server_id': serverId() }, { '$set': set, '$inc': { 'run_count': 1 } });

		// If this run tripped auto-quarantine (`set.enabled` is present only in that branch), disarm the
		// live timer too — otherwise a disabled CRON keeps firing every tick as a no-op early-return until
		// the process restarts. Mirrors the once-schedule disarm below.
		if (set.enabled === false) { disarm(scheduleId); }

		// Escalate through the granular alert pipeline (event 'system', raised severity) so N consecutive
		// failures surface prominently and route per the user's notification config. Never blocks recording.
		if (!manual && (status === 'error' || status === 'timed_out') && shouldEmitEscalation(consec, escalateAfter)) {

			try {
				const paused = escalatePause;   // was disabled above at the same condition
				const sev = paused ? 'critical' : 'error';
				const label = row.label || row.type || scheduleId;
				const msg = 'Scheduled task "' + label + '" has failed ' + consec + ' times in a row' + (paused ? ' and has been paused. Re-enable it once fixed.' : '.');

				// Own event key ('schedule_failure') so a broken recurring job can't be silently un-alerted by
				// muting generic 'system' events.
				if (shareData && shareData.Common && typeof shareData.Common.sendNotification === 'function') {
					await shareData.Common.sendNotification({ 'message': msg, 'type': 'warning', 'event': 'schedule_failure', 'severity': sev, 'telegram_id': shareData.appData && shareData.appData.telegram_id });
				}

				// Ensure a durable audit trace. sendNotification already audits CRITICAL severity, so only write
				// the explicit entry for the non-paused 'error' case — avoiding a duplicate row for the paused
				// ('critical') escalation.
				try {
					if (sev !== 'critical' && shareData && shareData.Audit && typeof shareData.Audit.audit === 'function') {
						shareData.Audit.audit('scheduler', 'schedule.failure_escalation', scheduleId, msg.slice(0, 300));
					}
				}
				catch (ae) {}
			}
			catch (e) {}
		}
	}
	catch (e) { logger('record failed for ' + scheduleId + ': ' + e.message); }

	// Append to the run history (full output) and prune to the retention cap.
	await recordRun(row, { ranAt, status, manual: !!manual, durationMs, output, attempts });

	// Per-run FAILURE notification for the two cases a handler cannot notify for itself: a TIMED-OUT run
	// (the handler was abandoned mid-await, so its own error-path notify never ran) and a run with NO
	// registered handler. A handler that returns/throws a normal error still delivers its own failure notice,
	// so those are deliberately excluded here to avoid a double alert. Scheduled runs only (a manual test run
	// is watched live). Fire-and-forget: notifyFailure never throws, and this can never block the run record.
	if (!manual && (status === 'timed_out' || noHandler) && shareData && shareData.ScheduleNotifier && typeof shareData.ScheduleNotifier.notifyFailure === 'function') {

		try { await shareData.ScheduleNotifier.notifyFailure(row, status, output); }
		catch (e) { logger('failure-notify skipped for ' + scheduleId + ': ' + e.message); }
	}

	if (!manual && row.kind === 'once') { disarm(scheduleId); }

	return { success: true, status };
}


// Insert a run-history record and prune old runs for this schedule beyond the cap.
async function recordRun(row, run) {

	try {

		await new ScheduleRunDB.ScheduleRunSchema({
			run_id: uuid(),
			schedule_id: row.schedule_id,
			server_id: row.server_id || serverId(),
			type: row.type,
			label: row.label,
			ran_at: run.ranAt,
			status: run.status,
			manual: run.manual,
			duration_ms: run.durationMs,
			attempts: run.attempts || 1,
			output: run.output || ''
		}).save();

		await pruneRuns(row.schedule_id);
	}
	catch (e) { logger('run-history record failed for ' + row.schedule_id + ': ' + e.message); }
}


// Record a run that never executed because the previous one was still active when this
// schedule fired again. Loads the row for its identifying fields and appends a 'skipped'
// history entry; it does NOT touch last_run / last_status, which should reflect the last
// real execution. Single exit.
async function recordSkipped(scheduleId) {

	try {

		const row = await ScheduleDB.ScheduleSchema.findOne({ 'schedule_id': scheduleId, 'server_id': serverId() });

		if (row) {

			logger('skipped ' + scheduleId + ' (previous run still in progress)');

			await recordRun(row, {
				ranAt: new Date(),
				status: 'skipped',
				manual: false,
				durationMs: 0,
				output: 'Skipped: the previous run was still in progress when this schedule fired again.'
			});
		}
	}
	catch (e) { logger('record skipped failed for ' + scheduleId + ': ' + e.message); }
}


// Retention: keep the newest runs per schedule, but keep FAILURES (error / timed_out)
// longer than successes and other runs, since failures are what you look back at. The two
// buckets are pruned independently against their own caps. Single exit.
async function pruneRuns(scheduleId) {

	await pruneBucket(scheduleId, { 'status': { '$in': FAILURE_STATUSES } }, MAX_FAILURE_RUNS);
	await pruneBucket(scheduleId, { 'status': { '$nin': FAILURE_STATUSES } }, MAX_RUNS_PER_SCHEDULE);
}


async function pruneBucket(scheduleId, statusFilter, cap) {

	const query = Object.assign({ 'schedule_id': scheduleId }, statusFilter);

	const total = await ScheduleRunDB.ScheduleRunSchema.countDocuments(query);

	if (total > cap) {

		const excess = await ScheduleRunDB.ScheduleRunSchema
			.find(query)
			.sort({ ran_at: 1 })
			.limit(total - cap)
			.select({ _id: 1 });

		if (excess.length) {

			await ScheduleRunDB.ScheduleRunSchema.deleteMany({ '_id': { '$in': excess.map(function (d) { return d._id; }) } });
		}
	}
}


function armUser(row) {

	armSchedule(row.schedule_id, 'user', { kind: row.kind, cron: row.cron, run_at: row.run_at, timezone: row.timezone }, () => fireUser(row.schedule_id, false));
}


async function add(data) {

	const v = validate(data);
	if (!v.ok) { return { success: false, error: v.error }; }

	const doc = Object.assign({
		schedule_id: uuid(),
		server_id: serverId(),
		enabled: data.enabled === false ? false : true
	}, v.doc);

	try {

		const row = new ScheduleDB.ScheduleSchema(doc);
		await row.save();
		if (row.enabled) { armUser(row); }
		return { success: true, schedule: publicRow(row) };
	}
	catch (e) { return { success: false, error: e.message }; }
}


async function update(scheduleId, data) {

	let row;
	try { row = await ScheduleDB.ScheduleSchema.findOne({ 'schedule_id': scheduleId, 'server_id': serverId() }); }
	catch (e) { return { success: false, error: e.message }; }
	if (!row) { return { success: false, error: 'Schedule not found.' }; }

	// The backup schedule is a protected singleton managed from Backups configuration (saveBackupSchedule),
	// which keeps appData.cron_backup and its encrypted credentials in sync. Editing it through the generic
	// schedules API would bypass that sync (stale cron_backup, un-re-encrypted secrets), so refuse it here —
	// the UI already hides it from the editable list, but the API must enforce the same rule.
	if (row.type === 'backup') {
		return { success: false, error: 'The backup schedule is managed from the Backups configuration, not the schedules list — edit it there so its stored credentials and app settings stay in sync.' };
	}

	const merged = {
		kind: data.kind || row.kind,
		type: data.type != null ? data.type : row.type,
		prompt: data.prompt != null ? data.prompt : row.prompt,
		label: data.label != null ? data.label : row.label,
		cron: data.cron != null ? data.cron : row.cron,
		run_at: data.run_at != null ? data.run_at : row.run_at,
		catchup: data.catchup != null ? data.catchup : row.catchup,
		timezone: data.timezone != null ? data.timezone : row.timezone,
		concurrency: data.concurrency != null ? data.concurrency : row.concurrency,
		retries: data.retries != null ? data.retries : row.retries,
		retry_backoff: data.retry_backoff != null ? data.retry_backoff : row.retry_backoff,
		retry_delay_ms: data.retry_delay_ms != null ? data.retry_delay_ms : row.retry_delay_ms,
		// MERGE settings rather than replace, so an edit that sends only some keys (e.g. the
		// notifications editor) preserves the rest — a recipe's recipe_id / parameters / provenance
		// must survive an ordinary edit. A caller that omits settings entirely leaves them untouched.
		// A caller that wants a clean slate (e.g. "reset recipe to shipped defaults", which must be
		// able to DROP stale keys a merge would keep) passes `replaceSettings: true` to overwrite.
		settings: (data.settings && typeof data.settings === 'object')
			? (data.replaceSettings === true
				? Object.assign({}, data.settings)
				: Object.assign({}, (row.settings && typeof row.settings.toObject === 'function') ? row.settings.toObject() : (row.settings || {}), data.settings))
			: (row.settings || {})
	};
	// Allow the existing (possibly already-past) one-shot time when run_at is NOT actually changing, so
	// non-time edits (label, notifications, retries…) succeed. The schedule editor always re-sends run_at
	// pre-filled from the stored value, so compare VALUES rather than mere presence — otherwise every edit
	// of a fired one-shot would fail the future-time check. A genuinely new run_at still gets that check.
	const runAtUnchanged = data.run_at == null
		|| (row.run_at && new Date(data.run_at).getTime() === new Date(row.run_at).getTime());
	const v = validate(merged, { allowPastOnce: runAtUnchanged });
	if (!v.ok) { return { success: false, error: v.error }; }

	// A multi-field edit routes here instead of setEnabled(), so apply the same guard: don't let a past
	// one-shot be (re-)enabled into an inert state (a past one-off can't be armed — armOnce returns on a
	// non-positive delay), which would show as "enabled" but never fire.
	const wantsEnable = (data.enabled === true || data.enabled === 'true');
	if (wantsEnable && merged.kind === 'once' && v.doc.run_at && new Date(v.doc.run_at).getTime() <= Date.now()) {
		return { success: false, error: 'This one-time schedule\'s run time has already passed — edit its run time to run it again.' };
	}

	Object.assign(row, v.doc);
	row.markModified('settings');   // Mixed field — ensure the merged settings persist
	if (data.enabled != null) { row.enabled = data.enabled === true || data.enabled === 'true'; }

	try {
		await row.save();
		if (row.enabled) { armUser(row); } else { disarm(scheduleId); }
		return { success: true, schedule: publicRow(row) };
	}
	catch (e) { return { success: false, error: e.message }; }
}


async function setEnabled(scheduleId, enabled) {

	const on = enabled === true || enabled === 'true';

	try {

		// Turning a one-shot back on whose run time has already passed would leave it enabled but inert
		// (a past one-off can't be armed — armOnce returns on a non-positive delay). Refuse with a clear
		// message so the UI never shows an "enabled" schedule that can never fire; the user edits its run
		// time to run it again.
		if (on) {
			const existing = await ScheduleDB.ScheduleSchema.findOne({ 'schedule_id': scheduleId, 'server_id': serverId() });
			if (existing && existing.kind === 'once' && existing.run_at && new Date(existing.run_at).getTime() <= Date.now()) {
				return { success: false, error: 'This one-time schedule\'s run time has already passed — edit its run time to run it again.' };
			}
		}

		const row = await ScheduleDB.ScheduleSchema.findOneAndUpdate({ 'schedule_id': scheduleId, 'server_id': serverId() }, { '$set': { 'enabled': on } }, { 'returnDocument': 'after' });
		if (!row) { return { success: false, error: 'Schedule not found.' }; }
		if (on) { armUser(row); } else { disarm(scheduleId); }
		return { success: true, schedule: publicRow(row) };
	}
	catch (e) { return { success: false, error: e.message }; }
}


async function runNow(scheduleId) {

	return await fireUser(scheduleId, true);
}


async function remove(scheduleId) {

	// The backup schedule is a protected singleton managed from Backups configuration (saveBackupSchedule),
	// which keeps appData.cron_backup and its encrypted credentials in sync. Deleting it through the generic
	// schedules API would strip cron_backup out of sync until restart and drop its re-encryptable secrets, so
	// refuse it here — the UI hides it from the editable list, but the API must enforce the same rule.
	try {
		const backupRow = await ScheduleDB.ScheduleSchema.findOne({ 'schedule_id': scheduleId, 'server_id': serverId() });
		if (backupRow && backupRow.type === 'backup') {
			return { success: false, error: 'The backup schedule cannot be deleted here — manage it from the Backups configuration.' };
		}
	}
	catch (e) { return { success: false, error: e.message }; }

	disarm(scheduleId);
	try {
		await ScheduleDB.ScheduleSchema.deleteOne({ 'schedule_id': scheduleId, 'server_id': serverId() });
		await ScheduleRunDB.ScheduleRunSchema.deleteMany({ 'schedule_id': scheduleId });   // drop its run history too
		return { success: true };
	}
	catch (e) { return { success: false, error: e.message }; }
}


async function list() {

	try {
		const rows = await ScheduleDB.ScheduleSchema.find({ 'server_id': serverId() }).sort({ createdAt: -1 });
		return { success: true, schedules: rows.map(publicRow) };
	}
	catch (e) { return { success: false, error: e.message, schedules: [] }; }
}


// ── Run history ──────────────────────────────────────────────────────────────

function publicRun(r) {

	return {
		run_id: r.run_id,
		schedule_id: r.schedule_id,
		label: r.label,
		type: r.type,
		ran_at: r.ran_at ? new Date(r.ran_at).toISOString() : null,
		status: r.status,
		manual: !!r.manual,
		duration_ms: r.duration_ms,
		output: r.output || ''
	};
}


// All run-history records for this instance (across schedules), newest first — used
// by the "download all history" export.
async function listAllRuns() {

	try {
		const rows = await ScheduleRunDB.ScheduleRunSchema.find({ server_id: serverId() }).sort({ ran_at: -1 }).limit(5000);
		return { success: true, runs: rows.map(publicRun) };
	}
	catch (e) { return { success: false, error: e.message, runs: [] }; }
}


async function listRuns(scheduleId, limit) {

	try {
		const n = Math.min(Math.max(parseInt(limit, 10) || MAX_RUNS_PER_SCHEDULE, 1), MAX_RUNS_PER_SCHEDULE);
		const rows = await ScheduleRunDB.ScheduleRunSchema.find({ schedule_id: scheduleId }).sort({ ran_at: -1 }).limit(n);
		return { success: true, runs: rows.map(publicRun) };
	}
	catch (e) { return { success: false, error: e.message, runs: [] }; }
}


async function deleteRun(scheduleId, runId) {

	try { await ScheduleRunDB.ScheduleRunSchema.deleteOne({ schedule_id: scheduleId, run_id: runId }); return { success: true }; }
	catch (e) { return { success: false, error: e.message }; }
}


async function clearRuns(scheduleId) {

	try { const r = await ScheduleRunDB.ScheduleRunSchema.deleteMany({ schedule_id: scheduleId }); return { success: true, deleted: r.deletedCount || 0 }; }
	catch (e) { return { success: false, error: e.message }; }
}


function publicRow(row) {

	return {
		schedule_id: row.schedule_id,
		type: row.type,
		label: row.label,
		kind: row.kind,
		cron: row.cron,
		run_at: row.run_at ? new Date(row.run_at).toISOString() : null,
		prompt: row.prompt,
		settings: row.settings || {},
		enabled: row.enabled,
		timezone: row.timezone || '',
		catchup: row.catchup || 'skip',
		concurrency: row.concurrency || 'forbid',
		retries: row.retries || 0,
		retry_backoff: row.retry_backoff || 'fixed',
		retry_delay_ms: row.retry_delay_ms || 0,
		last_run: row.last_run ? new Date(row.last_run).toISOString() : null,
		last_status: row.last_status,
		run_count: row.run_count,
		consecutive_failures: Number(row.consecutive_failures) || 0,
		schema_version: row.schema_version || 1
	};
}


// ── Lifecycle ────────────────────────────────────────────────────────────────

// An instance owns its database: server_id is derived from the database's own `server`
// collection, so a database only ever has ONE valid server_id at a time. If that id
// changes — a database restore, or a "Reset server ID" — schedule rows can be left under
// the previous id. Since every schedule in this database belongs to this instance, adopt
// any such rows on start so none are orphaned and the backup is always identified. The
// backup is a singleton, handled specially to respect the unique (server_id, type) index.
// In a (discouraged) shared-database setup every instance reads the same server_id, so
// nothing here matches and it is a harmless no-op.
async function adoptOrphanSchedules() {

	const sid = serverId();
	if (!sid) { return; }   // no identity yet — nothing to adopt safely

	try {

		// Backup singleton: adopt one orphan if we don't already own one, drop any extras.
		const owned = await ScheduleDB.ScheduleSchema.findOne({ type: 'backup', server_id: sid });

		if (!owned) {

			const orphan = await ScheduleDB.ScheduleSchema.findOne({ type: 'backup', server_id: { $ne: sid } }).sort({ updatedAt: -1 });

			if (orphan) {

				const prev = orphan.server_id;
				orphan.server_id = sid;
				await orphan.save();
				logger('adopted orphaned backup schedule (previous server_id: ' + prev + ')');
			}
		}

		await ScheduleDB.ScheduleSchema.deleteMany({ type: 'backup', server_id: { $ne: sid } });

		// All other (non-singleton) schedules: claim any left under a previous server_id.
		const res = await ScheduleDB.ScheduleSchema.updateMany({ type: { $ne: 'backup' }, server_id: { $ne: sid } }, { $set: { server_id: sid } });
		if (res && res.modifiedCount) { logger('adopted ' + res.modifiedCount + ' non-backup schedule(s) left under a previous server_id'); }
	}
	catch (e) { logger('orphan schedule adoption failed: ' + e.message); }
}


async function start(obj) {

	shareData = obj;
	logger = obj.Common.makeLogger('Scheduler: ');

	// Self-policing: flag schedule rows whose type has no handler (they would never run). Registered
	// here, after all handlers are registered by boot, so the check sees the full handler set.
	if (shareData.Watchdog && typeof shareData.Watchdog.register === 'function') {
		shareData.Watchdog.register('schedule_handler_coverage', scheduleHandlerCoverageCheck);
		// Heartbeat: flag enabled schedules that aren't primed to fire (e.g. an invalid cron that was
		// skipped at arm time). Registered here (before the arming loop below); the check itself RUNS
		// later, during the boot Watchdog pass after start() returns, so it sees the fully-armed state.
		shareData.Watchdog.register('schedule_heartbeat', scheduleHeartbeatCheck);
		// Backup health: one check that flags a lapsed LOCAL backup and/or a failing OFF-SITE (SFTP) upload —
		// quiet, always-visible backstops for failures that have not yet crossed the louder escalation (local) or
		// that never fail the backup at all and so have no other standing surface (off-site).
		shareData.Watchdog.register('backup_health', backupHealthCheck);
	}

	await adoptOrphanSchedules();

	let rows = [];
	try { rows = await ScheduleDB.ScheduleSchema.find({ 'server_id': serverId() }); }
	catch (e) { logger('load-all failed on start: ' + e.message); return; }

	let armed = 0;
	const catchups = [];   // make-up runs to fire after arming (background, non-blocking)

	for (const row of rows) {

		if (!row.enabled) { continue; }

		const pastOnce = row.kind === 'once' && row.run_at && new Date(row.run_at).getTime() <= Date.now();

		// Decide catch-up from the schedule's own missed-run policy (default 'skip'): a
		// one-off whose time passed while the process was down, and any cron occurrences
		// missed during the outage.
		const plan = planCatchup(row, Date.now());

		if (pastOnce) {

			// A past one-off is never armed (its time is gone); with 'skip' it is disabled
			// and marked missed (the long-standing default), otherwise it is made up once.
			if (plan.action === 'fire') {

				catchups.push({ id: row.schedule_id, count: 1, label: row.label || row.type });
				logger('catch-up: one-off ' + row.schedule_id + ' will run once (missed while down)');
			}
			else {

				// Only notify once the row is actually marked disabled+missed. If this write fails (a
				// transient boot-time DB hiccup), the row stays enabled+past and the next boot re-enters this
				// branch — so gating the notification on the write succeeding stops a persistent failure from
				// re-sending the "missed" alert every reboot.
				let markedMissed = false;
				try { await ScheduleDB.ScheduleSchema.updateOne({ 'schedule_id': row.schedule_id }, { '$set': { 'enabled': false, 'last_status': 'missed' } }); markedMissed = true; }
				catch (e) { /* leave markedMissed false — retried on the next boot, notification deferred with it */ }

				// Best-effort "on missed" notification: this one-off's run time passed while the instance
				// was down and its catch-up policy is 'skip', so it did not run. Deliver a 'missed' status
				// so targets subscribed to it (or to 'always') are told. Fully guarded and fire-and-forget
				// so it can never slow or break boot / catch-up; targets not subscribed to 'missed' no-op.
				try {
					if (markedMissed && shareData.ScheduleNotifier && typeof shareData.ScheduleNotifier.deliver === 'function') {
						const targets = shareData.ScheduleNotifier.resolveTargets(row.settings);
						const label = row.label || row.type || 'Scheduled task';
						Promise.resolve(shareData.ScheduleNotifier.deliver(targets, {
							'message': '⚠️ Scheduled task "' + label + '" was missed — its run time passed while SymBot was not running and its catch-up policy is set to skip, so it did not run.',
							'type': 'warning',
							'status': 'missed'
						})).catch((e) => { try { logger('missed-notify failed for ' + row.schedule_id + ': ' + ((e && e.message) ? e.message : e)); } catch (le) {} });
					}
				}
				catch (e) { /* a notification must never break catch-up */ }
			}

			continue;
		}

		armUser(row);
		armed++;

		if (row.kind === 'cron' && plan.action === 'fire') {

			catchups.push({ id: row.schedule_id, count: plan.count, label: row.label || row.type });
			logger('catch-up: cron ' + row.schedule_id + ' missed ' + plan.missed + ' run(s) while down; making up ' + plan.count);
		}
	}

	logger('armed ' + armed + ' user schedule(s)');

	// Fire make-up runs in the background so boot is never blocked by (possibly slow)
	// handlers. The activeRuns guard prevents a live cron tick and a make-up from
	// overlapping — whichever is second is recorded as skipped.
	if (catchups.length) { Promise.resolve(runCatchups(catchups)).catch(() => {}); }
}


// Execute the planned make-up runs sequentially (not awaited by start). Each goes through
// the normal fire path, so it records a run and respects concurrency. Never throws.
async function runCatchups(list) {

	for (const item of list) {

		for (let i = 0; i < item.count; i++) {

			try {
				logger('catch-up run ' + (i + 1) + '/' + item.count + ' for ' + item.id + ' (' + item.label + ')');
				await fireUser(item.id, false);
			}
			catch (e) { logger('catch-up run failed for ' + item.id + ': ' + e.message); }
		}
	}
}


// ── Singleton typed schedules (e.g. the database backup) ─────────────────────
//
// Some job types are a single per-instance schedule managed by their own settings
// panel rather than the add-schedule form (the database backup is the built-in case).
// These helpers find-or-update that one row by type + server_id and keep it armed.

async function getSingleton(type) {

	try { return await ScheduleDB.ScheduleSchema.findOne({ 'type': type, 'server_id': serverId() }); }
	catch (e) { logger('getSingleton(' + type + ') failed: ' + e.message); return null; }
}


// Create or update the single row of `type` for this instance. `data` may include
// kind, cron, run_at, enabled, label, and a settings object. Re-arms afterwards.
async function upsertSingleton(type, data) {

	let row = await getSingleton(type);

	const patch = {
		type,
		kind: data.kind === 'once' ? 'once' : 'cron',
		cron: data.cron != null ? String(data.cron) : (row ? row.cron : ''),
		run_at: data.run_at != null ? data.run_at : (row ? row.run_at : null),
		enabled: data.enabled != null ? (data.enabled === true || data.enabled === 'true') : (row ? row.enabled : true),
		label: data.label != null ? data.label : (row ? row.label : ''),
		timezone: data.timezone != null ? data.timezone : (row ? row.timezone : ''),
		// Carry catchup through so a singleton's missed-run policy (the backup migrates with
		// catchup:'once') isn't silently reset to the schema default 'skip' — otherwise the backup
		// never makes up a run missed while the process was down, contrary to its documented behavior.
		catchup: data.catchup != null ? data.catchup : (row ? row.catchup : 'skip'),
		settings: data.settings != null ? data.settings : (row ? row.settings : {})
	};

	try {

		if (!row) {

			row = new ScheduleDB.ScheduleSchema(Object.assign({ schedule_id: uuid(), server_id: serverId() }, patch));
		}
		else {

			Object.assign(row, patch);
			if (typeof row.markModified === 'function') { row.markModified('settings'); }
		}

		await row.save();
		if (row.enabled && (row.kind !== 'cron' || cron.validate(row.cron))) { armUser(row); } else { disarm(row.schedule_id); }
		return { success: true, schedule: publicRow(row) };
	}
	catch (e) {

		// Lost a create race with a sibling instance (unique index on server_id+type):
		// update the row the other instance just created instead.
		if (e && e.code === 11000) {

			const existing = await getSingleton(type);
			if (existing) {

				Object.assign(existing, patch);
				if (typeof existing.markModified === 'function') { existing.markModified('settings'); }
				try {
					await existing.save();
					if (existing.enabled && (existing.kind !== 'cron' || cron.validate(existing.cron))) { armUser(existing); } else { disarm(existing.schedule_id); }
					return { success: true, schedule: publicRow(existing) };
				}
				catch (e2) { return { success: false, error: e2.message }; }
			}
		}

		return { success: false, error: e.message };
	}
}


module.exports = {
	start,
	registerHandler,
	scheduleHandlerCoverageCheck,
	scheduleHeartbeatCheck,
	backupHealthCheck,
	evaluateBackupHealth,
	evaluateOffsiteBackupHealth,
	recordBackupSftpResult,
	evaluateHeartbeat,
	registerSystemJob,
	unregisterSystemJob,
	add,
	update,
	setEnabled,
	remove,
	list,
	runNow,
	validate,
	getSingleton,
	upsertSingleton,
	publicRow,
	listRuns,
	listAllRuns,
	deleteRun,
	clearRuns,

	// Exposed for unit testing the run-robustness + catch-up helpers (no DB needed).
	withTimeout,
	resolveTimeout,
	isFailureStatus,
	nextConsecutiveFailures,
	shouldEmitEscalation,
	cronOccurrences,
	parseCron,
	planCatchup,
	resolveRetries,
	retryDelay,
	RUN_TIMEOUT_DEFAULT_MS,
	CATCHUP_MAX_RUNS,
	MAX_RETRIES
};