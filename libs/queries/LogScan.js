'use strict';


// Read-only log retrieval for the AI assistant.
//
// Scans SymBot's own log files with pure Node.js streams. No shell, no spawn,
// no external process. Files are opened read-only and never written, moved or
// removed.
//
// Access is restricted to <path_root>/logs and to files whose names match the
// pattern SymBot itself writes (see Common.logger): YYYY-MM-DD[-InstanceName].log
// Nothing outside that directory is reachable: callers supply a date and an
// optional instance name, never a path, and every resolved candidate is checked
// for containment, subdirectories, symlinks and file type before it is opened.
//
// Scanning is deliberately byte-oriented. Lines are split on \n in the raw
// buffer and only the lines that match are decoded to UTF-8 strings, which keeps
// both time and memory flat regardless of how large the log is. Multi-byte
// characters that straddle a chunk boundary are reassembled before decoding
// because decoding only ever happens once a complete line has been isolated.


const fs = require('fs');
const path = require('path');


// A log file is a date-prefixed ".log": "<date>.log", "<date>-<name>.log", or any other suffix a naming
// quirk once produced ("<date>-.log"). Matched by shape only, consistent with the retention/index predicate,
// so log SEARCH and log CLEANUP never disagree about what a log is. Traversal/symlink safety is enforced
// separately in resolveLogFile (basename containment + lstat), not by this pattern.
const LOG_FILE_RE = /^\d{4}-\d{2}-\d{2}.*\.log$/;

// Whether a filename is a log, deferring to Common's single definition of the shape (so search and cleanup
// can never diverge) and falling back to the local pattern when Common isn't wired — the same delegate-with-
// fallback approach used for logDir/logFileName below.
function isLogFile(name) {
	if (shareData && shareData.Common && typeof shareData.Common.isLogArtifact === 'function') {
		return shareData.Common.isLogArtifact(name);
	}
	return typeof name === 'string' && LOG_FILE_RE.test(name);
}

// Restart and shutdown records. These are meaningful in their own right, but
// when tracing a single deal they say only that the process stopped or resumed
// and crowd out the deal's own events, so per-deal scans suppress them.
const RESTART_RE = /Resuming Deal ID|SymBot is terminating/;

// Guard rails so a single question can never scan the whole archive.
const MAX_FILES_DEFAULT = 2;
const MAX_BYTES_DEFAULT = 400 * 1024 * 1024;
const MAX_LINES_DEFAULT = 400;
const MAX_LINE_CHARS = 2000;
const READ_CHUNK_BYTES = 1 << 20;

// Map-reduce ceiling for AGGREGATE scans (counts / group_by / error summaries). These keep only
// small per-key buckets and a bounded line sample in memory — never the raw lines — so a scan can
// safely span a long window (map each day's file, reduce the buckets) where a plain LIST scan (which
// must hold every matching line) still caps at a couple of files. ~2 months is plenty for "this
// quarter"-scale questions without ever loading the archive.
const AGG_MAX_FILES = 62;

// Soft wall-clock budget for a single scan, comfortably under the 25s per-tool timeout in AITools so
// a very large range degrades to an HONEST partial answer (correct totals for the days it did reach,
// truncated:true, stopped_reason:'time') instead of a hard tool timeout with nothing to show. The
// baseline diff runs two scans back-to-back, so it passes each a smaller slice of this budget.
const SCAN_SOFT_TIME_MS = 15000;

// Routine per-tick status lines. They repeat thousands of times per deal and
// carry no diagnostic value, so they are dropped unless explicitly requested.
const NOISE_RE = /Last Price:.*DCA Price:/;

// Exchange/API errors are logged as `... error: {"name":"RateLimitExceeded"} ...`; this pulls
// out the error TYPE so errors can be counted and ranked by kind.
const ERROR_NAME_RE = /error:\s*\{"name":"([^"]+)"\}/;

// In-scan aggregation modes. Defined ONCE so scanFile (which builds the buckets) and scanLogs
// (which must keep scanning every file when aggregating, not stop at a full line sample) can
// never drift — a mismatch silently truncated multi-file counts before this was centralized.
const AGGREGATE_MODES = new Set([ 'hour', 'day', 'needle', 'error_type' ]);

// How many example lines to retain per error-type bucket during an error_type aggregation, so every
// ranked type can show real evidence (not just the frequent one that dominates the global sample).
const BUCKET_EXAMPLES_PER = 3;

// Lines that must never be fed back to the assistant.
//
// AI request logging writes the full prompt and response into the log, so a deal
// discussed in chat accumulates transcripts of previous questions and answers
// under its own deal id. Returning those as evidence would let an earlier reply
// be recycled as fact, so they are always dropped.
//
// Nothing else is excluded. Restart and shutdown lines were filtered here at one
// point as background chatter, which meant a question about restarts searched
// logs with the restart records removed and was answered with a confident zero.
// Operational lines are evidence, not noise: the caller decides what is relevant.
//
// "AI tools (…)" lines are the assistant's own record of which tools it ran for a
// chat room. They carry a room id and tool names but no event, and one is written
// the instant a tool loop runs — so a follow-up log search within the same question
// would otherwise match the assistant's own just-written line and quote it back as
// if it were evidence. They belong with AI requests: meta-activity, never a fact.
const EXCLUDE_RE = /AI Request \(|AI context:|AI tools \(/;

// Event phrases worth surfacing when no specific deal is named. Kept as plain
// substrings so matching stays a byte comparison.
const EVENT_PATTERNS = [
	'CIRCUIT BREAKER',
	'Exchange-cancelled',
	'InsufficientFunds',
	'DCA Bot Finished',
	'Pausing any further',
	'Invalid order',
	'Invalid base order',
	'retries exhausted',
	'An error occurred',
	'Max safety orders used',
	'no pending order ID'
];

// Written once per launch (unlike the per-deal "SymBot is terminating" lines), so
// this is the reliable count of how many times the process started.
const RESTART_MARKER = 'Starting SymBot';

// ── Event-template registry ──────────────────────────────────────────────────────
// ONE source of truth for the log events the analysis tools recognize. Each template maps a set of
// line markers (`needles`) to a stable canonical `category` and a `severity`, and declares whether
// it counts as a genuine error (`isError`). Both the error-scan needle list (ERROR_PATTERNS) and the
// broader incident needle list (INCIDENT_NEEDLES) are DERIVED from this table, and the incident
// correlator rolls its per-marker counts up into these categories — so the two lists can no longer
// drift apart and "cluster the incident by kind" produces stable, documented categories rather than
// whatever raw substrings happened to be listed. Exchange/API failures are matched dynamically
// (their type lives inside `error:{"name":"X"}`, see ERROR_NAME_RE) and mapped to a category by name.
const EVENT_TEMPLATES = [
	// Genuine errors — these (plus the dynamic exchange/API marker) define ERROR_PATTERNS. Needle
	// order is preserved so the derived list matches the long-standing scan order exactly.
	{ category: 'error',  severity: 'error', isError: true,  needles: [ 'An error occurred' ] },
	{ category: 'funds',  severity: 'error', isError: true,  needles: [ 'InsufficientFunds', 'not have enough funds' ] },
	{ category: 'order',  severity: 'error', isError: true,  needles: [ 'Invalid order', 'Invalid base order' ] },
	{ category: 'order',  severity: 'error', isError: true,  needles: [ 'retries exhausted' ] },
	{ category: 'order',  severity: 'error', isError: true,  needles: [ 'no pending order ID', 'Exchange-cancelled' ] },
	// ACTIVATED only — the breaker firing is a genuine incident. The paired "CIRCUIT BREAKER CLEARED —
	// resuming normal deal processing" line is a healthy RECOVERY, not an error; it is classified as info
	// below so it is never counted in an error tally (the bare-substring needle used to fold both together).
	{ category: 'system', severity: 'error', isError: true,  needles: [ 'CIRCUIT BREAKER ACTIVATED' ] },
	// Incident-scan context — NOT counted as standalone errors. Auth/network failures already count
	// via the dynamic {"name":"X"} marker; listing them as plain substrings also catches the same
	// events when logged as free text and gives the correlator its category. Lifecycle/system markers
	// bound an incident (a restart or a wave of completions around the moment of interest).
	{ category: 'auth',      severity: 'error', isError: false, needles: [ 'AuthenticationError' ] },
	{ category: 'network',   severity: 'error', isError: false, needles: [ 'NetworkError' ] },
	{ category: 'network',   severity: 'error', isError: false, needles: [ 'RequestTimeout' ] },
	{ category: 'order',     severity: 'error', isError: false, needles: [ 'Giving up' ] },
	{ category: 'price',     severity: 'warn',  isError: false, needles: [ 'Invalid Price' ] },
	{ category: 'system',    severity: 'info',  isError: false, needles: [ 'CIRCUIT BREAKER CLEARED' ] },
	{ category: 'lifecycle', severity: 'info',  isError: false, needles: [ 'Resuming Deal ID' ] },
	{ category: 'lifecycle', severity: 'info',  isError: false, needles: [ 'DCA Bot Finished' ] },
	{ category: 'system',    severity: 'info',  isError: false, needles: [ RESTART_MARKER ] }
];

// The dynamic exchange/API marker: one substring catches the whole `error:{"name":"X"}` class and
// any future ccxt error name. In real logs this is BY FAR the most common error class, so without it
// an "errors?" question misses the dominant class and reports a misleadingly tiny count.
const EXCHANGE_ERROR_MARKER = 'error: {"name"';

// Map a known ccxt error NAME (from the dynamic marker) to a category; anything else is 'exchange'.
const EXCHANGE_NAME_CATEGORY = {
	'AuthenticationError': 'auth',
	'NetworkError': 'network',
	'RequestTimeout': 'network',
	'ExchangeNotAvailable': 'network',
	'DDoSProtection': 'network'
};

// Genuine errors / problems only. Derived from the registry so it can never drift from the templates.
const ERROR_PATTERNS = EVENT_TEMPLATES
	.filter(t => t.isError)
	.reduce((acc, t) => acc.concat(t.needles), [])
	.concat([ EXCHANGE_ERROR_MARKER ]);

// Classify a single log line to its registry category (auth, network, order, funds, price, system,
// lifecycle, exchange) and severity. A dynamic exchange/API error is sub-split by its ccxt NAME —
// so an AuthenticationError becomes 'auth' and a RequestTimeout 'network', rather than all collapsing
// into one coarse 'exchange' bucket the way the whole-class needle would. Registry order breaks ties.
function classifyLine(text) {

	const m = ERROR_NAME_RE.exec(text);
	if (m) { const name = m[1]; return { type: name, category: EXCHANGE_NAME_CATEGORY[name] || 'exchange', severity: 'error' }; }

	for (const t of EVENT_TEMPLATES) {
		for (const n of t.needles) { if (text.indexOf(n) !== -1) { return { type: n, category: t.category, severity: t.severity }; } }
	}

	return { type: 'other', category: 'other', severity: 'info' };
}

// Defensive cap on the trailing partial-line buffer. A well-formed SymBot log is always
// newline-terminated, so `carry` only ever holds one short line; this bound only matters for
// a pathological/corrupt file with a very long run and no newline, where it stops `carry`
// (and the O(n) concat that grows it) from ballooning toward the whole file size.
const MAX_CARRY_BYTES = 8 * 1024 * 1024;

// Normalize a user/model-supplied ISO window bound to the log's full-precision form
// (YYYY-MM-DDTHH:MM:SS.mmmZ) so a plain lexicographic compare is correct at the boundary.
// SymBot log timestamps always carry milliseconds; a bound like "2026-08-12T09:19:00Z" (no
// ms) or "2026-08-12T09:19" (no seconds) would otherwise mis-sort by up to a second and drop
// the line exactly at `from` / over-include the final second at `to`. The lower bound is
// padded to the earliest instant it can mean and the upper bound to the latest, so the window
// stays inclusive of the second the caller named. UTC is assumed (the logs are UTC): a bare
// timestamp is treated as UTC and any numeric offset is dropped.
const TS_TEMPLATE_LO = '0000-01-01T00:00:00.000';
const TS_TEMPLATE_HI = '9999-12-31T23:59:59.999';

function normWindowBound(bound, isUpper) {

	if (typeof bound !== 'string' || bound.trim() === '') { return null; }

	let s = bound.trim();

	if (s.endsWith('Z') || s.endsWith('z')) { s = s.slice(0, -1); }
	s = s.replace(/[+-]\d{2}:?\d{2}$/, '');                 // strip any numeric tz offset (treat as UTC)
	s = s.replace(/^(\d{4}-\d{2}-\d{2})[ tT]/, '$1T');       // accept a space (or lowercase t) as the date/time separator

	const template = isUpper ? TS_TEMPLATE_HI : TS_TEMPLATE_LO;

	if (s.length > template.length) { s = s.slice(0, template.length); }

	return s + template.slice(s.length) + 'Z';
}


let shareData;


// Root of the only directory this module will ever read from.
function getLogDir() {

	// Delegate to the single source of truth (Common.logDir) so the reader can never diverge from
	// Common.logger's writer path. Falls back to the legacy location only when Common isn't wired
	// (e.g. a standalone unit test that inits LogScan without the full app).
	if (shareData && shareData.Common && typeof shareData.Common.logDir === 'function') {
		return shareData.Common.logDir();
	}

	const root = (shareData && shareData.appData && shareData.appData.path_root)
		? shareData.appData.path_root
		: path.resolve(__dirname, '..', '..');

	return path.join(root, 'logs');
}


// Resolve a log file name to an absolute path, or explain why it was refused.
// Single exit: every rejection sets result and falls through.
function resolveLogFile(fileName) {

	const logDir = getLogDir();

	let result = { 'success': false, 'error': 'Log file not available', 'path': null };

	if (typeof fileName === 'string' && fileName !== '' && isLogFile(fileName)) {

		const full = path.resolve(logDir, fileName);
		const rel = path.relative(logDir, full);

		const contained = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
		const sameDir = path.dirname(full) === path.resolve(logDir);

		if (contained && sameDir) {

			let stat;

			try {

				// lstat, not stat: a symlink must be rejected rather than followed.
				stat = fs.lstatSync(full);
			}
			catch (e) {

				stat = null;
			}

			if (stat && stat.isFile()) {

				result = { 'success': true, 'error': null, 'path': full, 'size': stat.size };
			}
		}
	}

	return (result);
}


// Every EXISTING log file for the requested dates, resolved by SCANNING the logs directory instead of
// reconstructing "<date>-<name>.log". This finds a date's log whatever its naming — a bare "<date>.log",
// a legacy "<date>-<name>.log", or both after a rename — needs no instance name (the directory already
// scopes to this instance), and de-dupes across dates. `maxFiles` bounds how many DATES are covered (its
// callers derive it from a date count), and a covered date always contributes ALL of its files, so a day
// that happens to have two logs after a rename is never split into a partial day just to hit the cap.
// Returns basenames in the order dates were requested (newest-first). One directory read serves all dates.
// Never throws.
function logFilesForDates(dates, maxFiles) {

	let dirFiles = [];
	try { dirFiles = fs.readdirSync(getLogDir()); }
	catch (e) { dirFiles = []; }

	const out = [];
	const seen = new Set();
	let datesCovered = 0;

	for (const d of dates) {

		if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) { continue; }
		if (datesCovered >= maxFiles) { break; }

		let anyForDate = false;

		for (const f of dirFiles) {

			// Must start with the exact date AND have a separator (".", for "<date>.log", or "-", for a legacy
			// "<date>-<name>.log") right after it — so date "2026-08-02" can never prefix-match "2026-08-020941.log".
			if (f.indexOf(d) === 0 && (f.charAt(10) === '.' || f.charAt(10) === '-') && isLogFile(f) && !seen.has(f)) {

				seen.add(f);
				out.push(f);
				anyForDate = true;
			}
		}

		if (anyForDate) { datesCovered++; }
	}

	return out;
}


// List the log files present, newest first. Used to discover which dates and
// instances exist rather than guessing file names.
// Scan one file for lines containing any of the given needles.
//
// Reads in fixed-size chunks and splits on newline bytes. Only matching lines
// are turned into strings; everything else stays as raw bytes and is discarded,
// which is what keeps this fast and flat in memory on very large files.
async function scanFile(filePath, needles, options) {

	const opts = options || {};

	// A numeric maxLines is honored literally, INCLUDING 0 — a count/aggregate pass keeps
	// no sample lines yet still accumulates matchCount/buckets, which is how scanLogs keeps
	// counts accurate across files once the shared line sample is full (see scanLogs).
	const maxLines = (typeof opts.maxLines === 'number' && opts.maxLines >= 0) ? opts.maxLines : MAX_LINES_DEFAULT;
	const includeNoise = opts.includeNoise === true;
	const skipRestarts = opts.skipRestarts === true;

	// Optional time-window filter. Log lines start with an ISO-8601 UTC timestamp
	// (e.g. 2026-08-11T22:00:00.095Z) which sorts lexicographically, so a plain string
	// comparison is a correct range check once the bounds are normalized to the same
	// full-precision form (normWindowBound). Only active when a bound is supplied.
	const tsFrom = normWindowBound(opts.tsFrom, false);
	const tsTo   = normWindowBound(opts.tsTo, true);

	// Optional MULTI-window filter: a line passes if its timestamp falls in ANY of these [from,to] windows.
	// This lets one pass over a date span answer a recurring time-of-day BAND ("around 5pm each day over the
	// last week") — the caller supplies one absolute window per day, and a single scan covers them all instead
	// of one scan per day. Bounds are normalized like tsFrom/tsTo so the lexicographic compare is exact.
	const tsWindows = (Array.isArray(opts.tsWindows) && opts.tsWindows.length)
		? opts.tsWindows.map(w => ({ from: normWindowBound(w.from, false), to: normWindowBound(w.to, true) }))
		: null;

	const inWindow = (text) => {
		const sp = text.indexOf(' ');
		const ts = sp > 0 ? text.slice(0, sp) : text.slice(0, 24);
		if (tsWindows) {
			for (const w of tsWindows) { if ((!w.from || ts >= w.from) && (!w.to || ts <= w.to)) { return true; } }
			return false;
		}
		if (!tsFrom && !tsTo) { return true; }
		if (tsFrom && ts < tsFrom) { return false; }
		if (tsTo && ts > tsTo) { return false; }
		return true;
	};

	// Optional in-scan aggregation, so a count over a huge log never materialises every
	// line: 'hour' buckets matches by their timestamp hour (YYYY-MM-DDTHH); 'needle'
	// buckets by which search term matched. Memory stays flat regardless of match count.
	const aggregate = AGGREGATE_MODES.has(opts.aggregate) ? opts.aggregate : null;
	const buckets = {};
	// A free, always-on temporal tally by day (YYYY-MM-DD) whenever aggregating, so a caller can
	// answer "which day had the most …" from the same single pass, independent of the primary mode.
	const dayBuckets = {};
	// A few example lines PER error-type bucket, captured during the pass. Without this, examples are
	// filtered from the global line SAMPLE afterward, which skews to the most frequent type — so a rarer
	// type (Invalid order, CIRCUIT BREAKER) would show a count with no evidence. Bounded per key.
	const bucketExamples = {};

	const bucketMatch = (text, lineBuf) => {
		if (!aggregate) { return; }
		dayBuckets[text.slice(0, 10)] = (dayBuckets[text.slice(0, 10)] || 0) + 1;
		if (aggregate === 'day') {
			buckets[text.slice(0, 10)] = (buckets[text.slice(0, 10)] || 0) + 1;
		}
		else if (aggregate === 'hour') {
			const key = text.slice(0, 13);
			buckets[key] = (buckets[key] || 0) + 1;
		}
		else if (aggregate === 'needle') {
			for (let i = 0; i < needleBufs.length; i++) {
				if (lineBuf.includes(needleBufs[i])) { buckets[needles[i]] = (buckets[needles[i]] || 0) + 1; break; }
			}
		}
		else if (aggregate === 'error_type') {
			// Rank errors by KIND. Exchange/API failures carry their type inside `{"name":"X"}`
			// (RateLimitExceeded, RequestTimeout, …) — bucket by that; otherwise fall back to the
			// plain-language needle that matched (e.g. "not have enough funds", "CIRCUIT BREAKER").
			const m = text.match(ERROR_NAME_RE);
			let key = m ? m[1] : null;
			if (!key) { for (let i = 0; i < needleBufs.length; i++) { if (lineBuf.includes(needleBufs[i])) { key = needles[i]; break; } } }
			if (!key) { key = 'other'; }
			buckets[key] = (buckets[key] || 0) + 1;
			if (!bucketExamples[key]) { bucketExamples[key] = []; }
			if (bucketExamples[key].length < BUCKET_EXAMPLES_PER) {
				bucketExamples[key].push(text.length > 300 ? text.slice(0, 300) : text);
			}
		}
	};

	// How many surrounding log lines to include around each match. Some events carry
	// their identifying detail on the neighboring line (e.g. a funds warning is
	// immediately followed by the "Starting new deal … Deal ID:" line), so a little
	// context turns a bare match into an answerable result. Bounded to keep results
	// compact; only active when requested (the default keeps the fast, match-only path).
	const context = Math.min(Math.max(parseInt(opts.context, 10) || 0, 0), 3);

	const needleBufs = needles.map(n => Buffer.from(n, 'utf8'));

	const lines = [];

	let bytesRead = 0;
	let truncated = false;
	let matchCount = 0;

	const matches = (lineBuf) => needleBufs.some(nb => lineBuf.includes(nb));

	const clip = (text) => text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) + ' …[truncated]' : text;

	const pushLine = (text) => {

		if (lines.length < maxLines) { lines.push(clip(text)); }
		else { truncated = true; }
	};

	// Context-aware path: decode every line so before/after context is available.
	// A ring of recent non-match lines supplies "before"; a counter emits "after".
	const beforeRing = [];
	let afterRemaining = 0;

	const keepWithContext = (lineBuf) => {

		const text = lineBuf.toString('utf8');

		// Never surface AI-request transcripts, even as context.
		if (EXCLUDE_RE.test(text)) { return false; }

		const isNoise = !includeNoise && NOISE_RE.test(text);
		const isRestart = skipRestarts && RESTART_RE.test(text);
		const isMatch = matches(lineBuf) && !isNoise && !isRestart && inWindow(text);

		if (isMatch) {

			matchCount++;
			bucketMatch(text, lineBuf);

			for (const b of beforeRing) { pushLine(b); }
			beforeRing.length = 0;

			pushLine(text);
			afterRemaining = context;

			return true;
		}

		if (afterRemaining > 0) {

			pushLine(text);
			afterRemaining--;

			return true;
		}

		// Candidate "before" context for a later match (skip pure noise).
		if (!isNoise) {

			beforeRing.push(text);
			while (beforeRing.length > context) { beforeRing.shift(); }
		}

		return false;
	};

	const keepMatchOnly = (lineBuf) => {

		let kept = false;

		if (matches(lineBuf)) {

			const text = lineBuf.toString('utf8');

			const isRestart = skipRestarts && RESTART_RE.test(text);
			const isNoise = !includeNoise && NOISE_RE.test(text);

			// A phrase appearing inside a logged AI request is the assistant quoting
			// itself, not the event happening, so such lines are neither counted nor
			// shown. Counting them would report a total higher than the events that
			// actually occurred, and would leave the count unsupported by the lines
			// displayed alongside it.
			const isTranscript = EXCLUDE_RE.test(text);

			if (!isRestart && !isNoise && !isTranscript && inWindow(text)) {

				matchCount++;
				bucketMatch(text, lineBuf);

				if (lines.length < maxLines) {

					lines.push(clip(text));

					kept = true;
				}
				else {

					truncated = true;
				}
			}
		}

		return (kept);
	};

	const keep = context > 0 ? keepWithContext : keepMatchOnly;

	const stream = fs.createReadStream(filePath, { 'highWaterMark': READ_CHUNK_BYTES });

	let carry = Buffer.alloc(0);
	let chunkCount = 0;

	try {

		for await (const chunk of stream) {

			bytesRead += chunk.length;

			const buf = carry.length ? Buffer.concat([ carry, chunk ]) : chunk;

			let start = 0;

			while (true) {

				const nl = buf.indexOf(10, start);

				if (nl === -1) {

					break;
				}

				keep(buf.subarray(start, nl));

				start = nl + 1;
			}

			// Whatever follows the last newline is an incomplete line. Holding it
			// here is also what reunites a multi-byte character split by the chunk
			// boundary, since decoding happens only on complete lines.
			carry = buf.subarray(start);

			// Pathological guard: never let an un-terminated line grow carry without bound.
			if (carry.length > MAX_CARRY_BYTES) { truncated = true; carry = carry.subarray(0, 0); }

			// Cooperative yield — SymBot is a trading platform first. A tight for-await loop
			// can drain microtasks while starving the event loop's timer/IO phase (where the
			// follow loop's ticks live), so hand control back via setImmediate every few MB.
			// The scan resumes on the next macrotask; trading keeps running throughout.
			if ((++chunkCount % 8) === 0) { await new Promise(resolve => setImmediate(resolve)); }
		}

		// Final line when the file does not end with a newline.
		if (carry.length) {

			keep(carry);
		}
	}
	finally {

		stream.destroy();
	}

	return ({ 'lines': lines, 'bytesRead': bytesRead, 'truncated': truncated, 'matchCount': matchCount, 'buckets': buckets, 'dayBuckets': dayBuckets, 'bucketExamples': bucketExamples });
}


// Scan a set of log files for needles, honoring the byte and file budgets.
// Single exit.
async function scanLogs(params) {

	const opts = params || {};

	const needles = (opts.needles || []).filter(n => typeof n === 'string' && n !== '');
	const dates = (opts.dates || []).filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));

	const instanceName = opts.instanceName;
	const maxFiles = opts.maxFiles || MAX_FILES_DEFAULT;
	const maxBytes = opts.maxBytes || MAX_BYTES_DEFAULT;
	const maxLines = opts.maxLines || MAX_LINES_DEFAULT;

	let result = { 'success': false, 'error': null, 'lines': [], 'files': [], 'truncated': false };

	if (needles.length === 0 || dates.length === 0) {

		result.error = 'No search terms or dates provided';
	}
	else {

		const wanted = logFilesForDates(dates, maxFiles);

		// When aggregating (a count or group_by), the totals must stay correct across EVERY
		// file: the shared line SAMPLE filling up must not stop later files from being scanned
		// for their matchCount/buckets — only the sample stops growing. In plain list mode there
		// is nothing to keep accumulating, so a full sample legitimately ends the scan.
		const aggregating = AGGREGATE_MODES.has(opts.aggregate);

		let bytesBudget = maxBytes;
		let linesBudget = maxLines;

		const collected = [];
		const filesScanned = [];
		const buckets = {};
		const dayBuckets = {};
		const bucketExamples = {};

		let totalMatches = 0;

		// Partial from the outset if we won't cover every requested DATE. Compare DISTINCT DATES on both sides,
		// NOT the file count: `wanted` is a file list, and a single day can contribute two files (a bare
		// "<date>.log" plus a legacy "<date>-<name>.log" after a rename), which would otherwise inflate the
		// count and mask a genuinely dropped date — reporting a partial answer as complete.
		const validDatesRequested = dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(String(d))).length;
		const distinctDatesCovered = new Set(wanted.map(f => String(f).slice(0, 10))).size;
		let truncated = distinctDatesCovered < validDatesRequested;
		let stoppedReason = truncated ? 'file_cap' : null;
		let failure = null;

		// Map-reduce over the day files: each file is streamed and reduced into the shared buckets,
		// bounded by a byte budget and a SOFT wall-clock deadline so a long window cannot blow the
		// per-tool timeout — it stops cleanly with an honest partial result instead.
		const startedAt = Date.now();
		const softMs = (typeof opts.softTimeMs === 'number' && opts.softTimeMs > 0) ? opts.softTimeMs : SCAN_SOFT_TIME_MS;

		for (const name of wanted) {

			if (bytesBudget <= 0) { truncated = true; stoppedReason = stoppedReason || 'bytes'; continue; }

			// Only stop early on a full line sample in list mode; aggregation keeps counting.
			if (!aggregating && linesBudget <= 0) { truncated = true; continue; }

			// Soft deadline: stop before the tool timeout so what we already reduced is returned.
			if (filesScanned.length > 0 && (Date.now() - startedAt) > softMs) { truncated = true; stoppedReason = stoppedReason || 'time'; break; }

			const resolved = resolveLogFile(name);

			if (resolved.success) {

				try {

					const scan = await scanFile(resolved.path, needles, { 'maxLines': Math.max(linesBudget, 0), 'includeNoise': opts.includeNoise, 'skipRestarts': opts.skipRestarts, 'context': opts.context, 'tsFrom': opts.tsFrom, 'tsTo': opts.tsTo, 'tsWindows': opts.tsWindows, 'aggregate': opts.aggregate });

					collected.push(...scan.lines);
					filesScanned.push(name);

					if (scan.buckets) { for (const k of Object.keys(scan.buckets)) { buckets[k] = (buckets[k] || 0) + scan.buckets[k]; } }
					if (scan.dayBuckets) { for (const k of Object.keys(scan.dayBuckets)) { dayBuckets[k] = (dayBuckets[k] || 0) + scan.dayBuckets[k]; } }
					if (scan.bucketExamples) {
						for (const k of Object.keys(scan.bucketExamples)) {
							if (!bucketExamples[k]) { bucketExamples[k] = []; }
							for (const ex of scan.bucketExamples[k]) { if (bucketExamples[k].length < BUCKET_EXAMPLES_PER) { bucketExamples[k].push(ex); } }
						}
					}

					totalMatches += (scan.matchCount || 0);

					bytesBudget -= scan.bytesRead;
					linesBudget -= scan.lines.length;

					if (scan.truncated) {

						truncated = true;
					}
				}
				catch (e) {

					failure = e.message;
				}
			}

			// Cooperative yield between files — the per-file stream already yields internally, but a
			// long multi-file scan must also let the trade loop run between files. Trading comes first.
			if (aggregating) { await new Promise(resolve => setImmediate(resolve)); }
		}

		result = {
			'success': failure == null,
			'error': failure,
			'lines': collected,
			'files': filesScanned,
			'truncated': truncated,
			'stopped_reason': stoppedReason,
			'files_requested': dates.length,
			'files_scanned': filesScanned.length,
			'matchCount': totalMatches,
			'buckets': buckets,
			'dayBuckets': dayBuckets,
			'bucketExamples': bucketExamples
		};
	}

	return (result);
}


// Everything logged for one deal, noise removed. This is the common case: a
// deal id reduces a day's log to a handful of lines.
async function getDealEvents(dealId, dates, instanceName, maxLines) {

	return (await scanLogs({
		'needles': [ dealId ],
		'dates': dates,
		'instanceName': instanceName,
		'maxLines': maxLines,
		'skipRestarts': true
	}));
}


// A wider deal scan for in-depth timeline analysis: scans every date supplied (not
// just the default two files) so a deal's behavior can be traced across the whole
// retained log window. Restart chatter is still suppressed. Reuses scanLogs.
async function getDealEventsRange(dealId, dates, instanceName, maxLines) {

	return (await scanLogs({
		'needles': [ dealId ],
		'dates': dates,
		'instanceName': instanceName,
		'maxLines': maxLines,
		'maxFiles': Math.min((dates || []).length || 1, 10),
		'skipRestarts': true
	}));
}


// Notable events across all deals for the given dates.
async function getNotableEvents(dates, instanceName, maxLines) {

	return (await scanLogs({
		'needles': EVENT_PATTERNS,
		'dates': dates,
		'instanceName': instanceName,
		'maxLines': maxLines
	}));
}


// Attach EVIDENCE to a ranked list of error types: for each entry, up to `perType` example log
// lines (that mention the type) and the first/last time it was seen, taken from the sampled lines.
// Mutates and returns the list. Shared by the error summary and the baseline diff so both can give
// real detail (example lines + timing) on request, not just a count.
const TS_LINE_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/;

function attachTypeExamples(items, lines, perType, bucketExamples) {

	const lim = perType || 3;
	const src = (lines || []).filter(l => typeof l === 'string');

	for (const item of (items || [])) {

		// Per-type examples captured during the scan are present for EVERY ranked type (even rare ones);
		// the global-sample filter is the fallback for a type that predates this capture or is 'other'.
		const captured = (bucketExamples && Array.isArray(bucketExamples[item.type])) ? bucketExamples[item.type] : [];
		const matches = src.filter(l => l.indexOf(item.type) !== -1);
		const chosen = (captured.length ? captured : matches).slice(0, lim);
		item.examples = chosen.map(l => l.length > 300 ? l.slice(0, 300) + ' …' : l);

		// Timestamp span: use the widest set of lines available for this type (captured examples ∪ global
		// matches) so first/last-seen is as accurate as the data allows.
		const timeSrc = captured.length ? captured.concat(matches) : matches;
		const times = timeSrc.map(l => { const m = TS_LINE_RE.exec(l); return m ? m[1] : null; }).filter(Boolean).sort();
		if (times.length) { item.first_seen = times[0]; item.last_seen = times[times.length - 1]; }
	}

	return items;
}


// Genuine errors / problems only (see ERROR_PATTERNS). One line of context is
// included because some warnings (e.g. a funds warning) carry the identifying deal
// on the adjacent "Starting new deal … Deal ID:" line.
async function getRecentErrors(dates, instanceName, maxLines, softMs, tz) {

	// Scan the requested days AND their neighbors, filtered to the requested days' real UTC window,
	// so lines that spilled into an adjacent-named file (see expandScanDates) are still counted.
	const scanDates = expandScanDates(dates);
	const win = utcWindowFor(dates, tz);

	const res = await scanLogs({
		'needles': ERROR_PATTERNS,
		'dates': scanDates,
		'instanceName': instanceName,
		'maxLines': maxLines,
		'context': 1,
		'tsFrom': win.from,
		'tsTo': win.to,
		'aggregate': 'error_type',                                  // rank by error KIND, counted across every day
		'maxFiles': Math.min(scanDates.length || 2, AGG_MAX_FILES), // aggregate → span the full window (map-reduce)
		'softTimeMs': softMs                                        // undefined ⇒ the default single-scan budget
	});

	// A ranked "type → count" summary so "most errors" can be answered with real totals, and a
	// grand total (the true count, not just the sampled lines) — both survive the line-sample cap.
	const byType = res.buckets || {};
	const ranked = Object.keys(byType).map(k => ({ type: k, count: byType[k] })).sort((a, b) => b.count - a.count);

	res.by_type = byType;
	// Enrich each ranked type with example lines + first/last seen so "give me detail on those
	// errors" is answerable from the same result (shared with the baseline diff).
	res.errors_by_type = attachTypeExamples(ranked, res.lines, undefined, res.bucketExamples);
	res.total_errors = ranked.reduce((n, r) => n + r.count, 0);

	// Per-day totals (from the same pass) so "which day had the most errors" is answerable.
	const byDay = res.dayBuckets || {};
	res.errors_by_day = Object.keys(byDay).map(d => ({ date: d, count: byDay[d] })).sort((a, b) => b.count - a.count);

	return res;
}


// Baseline-deviation error analysis: count genuine errors by TYPE over a target
// window and over a baseline window, then rank each type by how anomalous it is versus normal —
// NEW (never seen in the baseline), SPIKING (per-day rate ≥2× baseline), ELEVATED, NORMAL, or GONE.
// All counting is deterministic in code; the model only narrates which types are unusual. Missing
// baseline log files are tolerated (scanLogs skips them) — the per-day normalization keeps the
// comparison fair when the windows differ in length or coverage.
async function getErrorBaselineDiff(targetDates, baselineDates, instanceName, tz) {

	const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

	// Two scans run back-to-back here, so give each a slice of the soft budget rather than the full
	// single-scan default — together they still finish inside the per-tool timeout. Both windows use the
	// same timezone so target and baseline days are measured consistently.
	const perScanMs = Math.floor(SCAN_SOFT_TIME_MS * 0.55);
	const target = await getRecentErrors(targetDates, instanceName, undefined, perScanMs, tz);
	const baseline = await getRecentErrors(baselineDates, instanceName, undefined, perScanMs, tz);

	const tDays = Math.max((targetDates || []).length, 1);
	const bDays = Math.max((baselineDates || []).length, 1);
	const tBy = target.by_type || {};
	const bBy = baseline.by_type || {};

	const types = new Set(Object.keys(tBy).concat(Object.keys(bBy)));
	const anomalies = [];

	for (const type of types) {

		const tc = tBy[type] || 0;
		const bc = bBy[type] || 0;
		const tpd = r2(tc / tDays);
		const bpd = r2(bc / bDays);

		let status;
		let ratio = null;

		if (bc === 0 && tc > 0) { status = 'new'; }
		else if (tc === 0 && bc > 0) { status = 'gone'; }
		else {
			ratio = bpd > 0 ? r2(tpd / bpd) : null;
			status = (ratio != null && ratio >= 2 && tc >= 3) ? 'spiking'
				: (ratio != null && ratio >= 1.3 ? 'elevated' : 'normal');
		}

		anomalies.push({ 'type': type, 'target_count': tc, 'baseline_count': bc, 'target_per_day': tpd, 'baseline_per_day': bpd, 'ratio': ratio, 'status': status });
	}

	const rank = (s) => ({ 'new': 0, 'spiking': 1, 'elevated': 2, 'normal': 3, 'gone': 4 }[s] != null ? { 'new': 0, 'spiking': 1, 'elevated': 2, 'normal': 3, 'gone': 4 }[s] : 5);
	anomalies.sort((a, b) => (rank(a.status) - rank(b.status)) || (b.target_count - a.target_count));

	const flagged = anomalies.filter(a => a.status === 'new' || a.status === 'spiking');

	// Attach EVIDENCE to the flagged types so the assistant can give real detail on request — a few
	// example log lines and when they first/last occurred — rather than only a bare count.
	attachTypeExamples(flagged, target.lines);

	return {
		'success': true, 'error': null,
		'target_days': tDays, 'baseline_days': bDays,
		'target_total_errors': target.total_errors || 0,
		'baseline_total_errors': baseline.total_errors || 0,
		'anomalies': anomalies,
		'flagged_count': flagged.length,
		'summary': flagged.length
			? (flagged.length + ' error type(s) are NEW or SPIKING versus the baseline — report those first (see status), and when the user wants detail use each one\'s `examples` (sample log lines) and first_seen/last_seen to be specific.')
			: 'No error types are new or spiking versus the baseline period; error mix looks normal.'
	};
}


// How many times SymBot started in the given dates. matchCount is the true total;
// lines are a capped sample of the start records.
async function getRestarts(dates, instanceName, maxLines, tz) {

	// Neighbor-day files + UTC window, so restarts stamped "today" that landed in yesterday's
	// file (local-date filename vs UTC line stamp) are still counted for today.
	const scanDates = expandScanDates(dates);
	const win = utcWindowFor(dates, tz);

	return (await scanLogs({
		'needles': [ RESTART_MARKER ],
		'dates': scanDates,
		'instanceName': instanceName,
		'maxLines': maxLines,
		'tsFrom': win.from,
		'tsTo': win.to,
		'aggregate': 'needle',                                      // keep counting across every file (don't stop at a full line sample)
		'maxFiles': Math.min(scanDates.length || 2, 9)              // days + neighbors
	}));
}


// ── Abstract data analysis: window / query-aggregate / anomaly / incident ────────
//
// All four stream the log byte-by-byte with the same flat-memory, cooperatively-yielding
// scanner (SymBot is a trading platform first — a scan never loads a file or blocks the
// follow loop), and all are strictly read-only.

const clipLine = (text) => text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) + ' …[truncated]' : text;

// The YYYY-MM-DD dates a UTC ISO from/to window spans (so the right log files are opened).
function datesInWindow(from, to) {

	const out = [];
	const f = (typeof from === 'string' && from.length >= 10) ? from.slice(0, 10) : null;
	const t = (typeof to === 'string' && to.length >= 10) ? to.slice(0, 10) : f;

	if (!f && !t) { return out; }

	let d = new Date((f || t) + 'T00:00:00Z');
	const end = new Date((t || f) + 'T00:00:00Z');
	let guard = 0;

	while (d.getTime() <= end.getTime() && guard < 32) {
		out.push(d.toISOString().slice(0, 10));
		d = new Date(d.getTime() + 86400000);
		guard++;
	}
	return out;
}

// Log files are named for the WRITER'S LOCAL date, but every line is stamped in UTC (UTC logging
// is intentional — forensic clarity). Near midnight the two disagree, so a day's UTC lines can
// land in the file named for the adjacent local day (e.g. 08-15 UTC lines inside 2026-08-14.log).
// To count "day D" correctly we therefore open D's neighbors too and filter by D's real UTC
// window, so a line is counted by its timestamp, never by which file happens to hold it.
function expandScanDates(dates) {

	const set = new Set();

	for (const d of (dates || [])) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { continue; }
		const t = new Date(d + 'T00:00:00Z').getTime();
		set.add(new Date(t - 86400000).toISOString().slice(0, 10));
		set.add(d);
		set.add(new Date(t + 86400000).toISOString().slice(0, 10));
	}

	return Array.from(set).sort();
}

// The inclusive UTC timestamp window spanning the requested dates (earliest 00:00:00.000 →
// latest 23:59:59.999), so neighbor-day spillover is captured but out-of-range lines are not.
function utcWindowFor(dates, tz) {

	const valid = (dates || []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
	if (!valid.length) { return { from: null, to: null }; }

	// When a timezone is supplied, the date labels are the USER's calendar days — convert each to its true
	// UTC span (DST-correct, via the shared Common helper). With NO timezone (the curl/API path and
	// internal callers), treat the labels as literal UTC days: a deterministic default that matches the
	// long-standing behavior. Neighbor files are scanned by expandScanDates; this only BOUNDS the result.
	if (tz && shareData && shareData.Common && typeof shareData.Common.zonedDayRangeUTC === 'function') {

		const first = shareData.Common.zonedDayRangeUTC(valid[0], tz);
		const last = shareData.Common.zonedDayRangeUTC(valid[valid.length - 1], tz);

		if (first && last) { return { from: first.from.toISOString(), to: last.to.toISOString() }; }
	}

	return { from: valid[0] + 'T00:00:00.000Z', to: valid[valid.length - 1] + 'T23:59:59.999Z' };
}


// Broad needle sets for the window / incident scans — events, genuine errors, and the
// operational markers (auth failures, network timeouts, invalid prices, resumes, restarts)
// that matter when reconstructing what happened. Includes the full ERROR_PATTERNS set (derived from the
// template registry) so an error logged only as free text — "…does not have enough funds…" — or as a dynamic
// exchange `error:{"name":"X"}` is caught too; EVENT_PATTERNS alone missed those, so a time-window scan could
// report "no activity" for a window that in fact contained errors.
const WINDOW_NEEDLES = Array.from(new Set(
	ERROR_PATTERNS
		.concat(EVENT_PATTERNS)
		.concat([ 'AuthenticationError', 'NetworkError', 'RequestTimeout', 'Invalid Price', 'Resuming Deal ID', RESTART_MARKER, 'Giving up' ])
));
// Every genuine-error marker plus every incident-context marker from the registry — deduped. Derived
// so it stays in lock-step with the templates instead of re-listing the same strings by hand.
const INCIDENT_NEEDLES = Array.from(new Set(
	ERROR_PATTERNS.concat(EVENT_TEMPLATES.filter(t => !t.isError).reduce((acc, t) => acc.concat(t.needles), []))
));


// General log query + aggregation. `terms` are OR'd plain phrases; `mode` is 'list' (matching
// lines) or 'count' (totals). `group_by` buckets a count by 'hour' or by 'term'. `from`/`to`
// (ISO UTC) restrict to a time window. This one tool answers most abstract log questions.
async function analyzeLogs(params) {

	const opts = params || {};

	const terms = (opts.terms || []).filter(t => typeof t === 'string' && t.trim() !== '');
	const mode = (opts.mode === 'count') ? 'count' : 'list';
	const group = (opts.group_by === 'hour') ? 'hour'
		: (opts.group_by === 'day' || opts.group_by === 'date') ? 'day'
		: (opts.group_by === 'term' || opts.group_by === 'pattern') ? 'needle'
		: null;

	let dates = opts.dates;
	if ((!dates || !dates.length) && (opts.from || opts.to)) { dates = datesInWindow(opts.from, opts.to); }

	const aggregate = group || ((mode === 'count') ? 'needle' : null);

	// A COUNT / group_by only keeps small buckets, so it can map-reduce across the whole window; a
	// plain LIST must hold every line, so it stays capped at a few files (it truncates anyway).
	const maxFiles = aggregate
		? Math.min((dates || []).length || 2, AGG_MAX_FILES)
		: Math.min((dates || []).length || 2, 4);

	const res = await scanLogs({
		'needles': terms,
		'dates': dates,
		'instanceName': opts.instanceName,
		'maxLines': (mode === 'count') ? 30 : (opts.maxLines || 200),
		'tsFrom': opts.from,
		'tsTo': opts.to,
		'aggregate': aggregate,
		'includeNoise': opts.include_ticks === true,
		'maxFiles': maxFiles
	});

	return {
		'success': res.success,
		'error': res.error,
		'mode': mode,
		'total_matches': res.matchCount || 0,
		'by_group': res.buckets || {},
		'lines': (mode === 'count') ? (res.lines || []).slice(0, 8) : res.lines,
		'files': res.files,
		'days_scanned': res.files_scanned,
		'days_requested': res.files_requested,
		'truncated': res.truncated,
		'stopped_reason': res.stopped_reason
	};
}


// Everything notable across ALL deals in a time window — the "what happened between T1 and T2" question.
// Events, errors, auth/network failures, invalid prices, resumes, restarts. Two extensions:
//   • `windows`: an array of [{from,to}] UTC windows scanned in ONE pass (a line passes if it is in ANY of
//     them) — how a recurring time-of-day BAND across several days is answered without one scan per day.
//   • `errors_only`: scan the error markers only (ERROR_PATTERNS) instead of the full event set, so an
//     error-focused question is not diluted by routine events before the result is capped.
async function getEventsInWindow(params) {

	const opts = params || {};
	const windows = (Array.isArray(opts.windows) && opts.windows.length) ? opts.windows : null;
	const needles = opts.errors_only ? ERROR_PATTERNS : WINDOW_NEEDLES;

	let dates = opts.dates;
	// Open every window's UTC day(s) AND their neighbors: log files are named for the WRITER'S LOCAL date but
	// stamped in UTC, so a window near local midnight can have its lines in the adjacent-named file. The
	// tsFrom/tsTo (or tsWindows) bounds keep the result exact regardless of which file held the line.
	if (!dates || !dates.length) {
		if (windows) {
			const set = new Set();
			for (const w of windows) { for (const d of datesInWindow(w.from, w.to)) { set.add(d); } }
			dates = expandScanDates(Array.from(set));
		}
		else if (opts.from || opts.to) { dates = expandScanDates(datesInWindow(opts.from, opts.to)); }
	}

	return await scanLogs({
		'needles': needles,
		'dates': dates,
		'instanceName': opts.instanceName,
		'maxLines': opts.maxLines || (windows ? 400 : 250),
		'tsFrom': windows ? undefined : opts.from,
		'tsTo': windows ? undefined : opts.to,
		'tsWindows': windows || undefined,
		'maxFiles': Math.min((dates || []).length || 2, windows ? 20 : 6)
	});
}


// Correlate an incident around an approximate time: cluster errors, auth/network failures,
// invalid prices, restarts, resumes and deal completions in a ± window, count them by kind,
// and surface the deal ids caught up in it.
async function findIncident(params) {

	const opts = params || {};
	const around = opts.around;

	if (typeof around !== 'string' || around.length < 10) {
		return { 'success': false, 'error': 'Provide an approximate time (e.g. 2026-08-12T09:20 or a full ISO timestamp) to center the scan.' };
	}

	const windowMin = Math.min(Math.max(parseInt(opts.window_minutes, 10) || 10, 1), 180);
	// Always interpret `around` as UTC (the tool documents UTC): normWindowBound completes a
	// partial timestamp and appends Z, so a bare "2026-08-12T09:20:30" is not parsed as host
	// local time (which would shift the whole ± window by the machine's offset).
	const center = new Date(normWindowBound(around, false));

	if (isNaN(center.getTime())) { return { 'success': false, 'error': 'Could not parse the time provided.' }; }

	const from = new Date(center.getTime() - windowMin * 60000).toISOString();
	const to = new Date(center.getTime() + windowMin * 60000).toISOString();
	const dates = datesInWindow(from, to);

	const res = await scanLogs({
		'needles': INCIDENT_NEEDLES,
		'dates': dates,
		'instanceName': opts.instanceName,
		'maxLines': opts.maxLines || 200,
		'tsFrom': from,
		'tsTo': to,
		'aggregate': 'needle',
		'maxFiles': Math.min(dates.length || 1, 3)
	});

	const dealIds = Array.from(new Set((res.lines || [])
		.map(l => { const m = l.match(/\b[A-Z0-9]+_[A-Z0-9]+-[A-Z0-9]+-\d+\b/); return m ? m[0] : null; })
		.filter(Boolean))).slice(0, 30);

	// Roll the incident up into stable CATEGORIES via the registry (auth, network, order, funds,
	// price, system, lifecycle, exchange) so "what kind of incident was it" has a documented answer
	// rather than a scatter of raw substrings. Classified per line so exchange/API failures sub-split
	// into auth vs network by their name — which the coarse whole-class marker in by_kind cannot do.
	const byKind = res.buckets || {};
	const byCategory = {};
	for (const l of (res.lines || [])) {
		const cat = classifyLine(l).category;
		byCategory[cat] = (byCategory[cat] || 0) + 1;
	}

	return {
		'success': res.success,
		'error': res.error,
		'window': { 'from': from, 'to': to },
		'by_kind': byKind,
		'by_category': byCategory,
		'total': res.matchCount || 0,
		'affected_deals': dealIds,
		'lines': res.lines,
		'files': res.files,
		'truncated': res.truncated
	};
}


// Parse the follow-loop tick lines and flag PRICE anomalies: a zero/invalid price, an
// implausibly large |profit|, or a last price that deviates wildly from the deal's DCA
// average (the class of bug where a garbage recovery price closes a deal at +154921%).
// Streams and yields like scanFile; only flagged ticks are kept (capped).
const TICK_PARSE_RE = /Pair:\s*([^\s\t]+)[\s\S]*?Last Price:\s*\$?([0-9.]+)[\s\S]*?DCA Price:\s*\$?([0-9.]+)[\s\S]*?Profit:\s*(-?[0-9.]+)/;

async function scanFileForAnomalies(filePath, opts) {

	// Honor 0 literally so the caller can cap the total flagged lines across files precisely.
	const maxLines = (typeof opts.maxLines === 'number' && opts.maxLines >= 0) ? opts.maxLines : 100;
	const profitThreshold = (typeof opts.profitThreshold === 'number') ? opts.profitThreshold : 500;   // abs %
	const deviationFactor = (typeof opts.deviationFactor === 'number') ? opts.deviationFactor : 5;      // last vs DCA
	const tsFrom = normWindowBound(opts.tsFrom, false);
	const tsTo = normWindowBound(opts.tsTo, true);

	const inWindow = (t) => {
		if (!tsFrom && !tsTo) { return true; }
		const sp = t.indexOf(' ');
		const ts = sp > 0 ? t.slice(0, sp) : t.slice(0, 24);
		if (tsFrom && ts < tsFrom) { return false; }
		if (tsTo && ts > tsTo) { return false; }
		return true;
	};

	const NEEDLE = Buffer.from('Last Price:', 'utf8');
	const flagged = [];
	let ticks = 0, anomalies = 0, bytesRead = 0, truncated = false;

	const handle = (lineBuf) => {

		if (!lineBuf.includes(NEEDLE)) { return; }
		const text = lineBuf.toString('utf8');
		if (EXCLUDE_RE.test(text) || !inWindow(text)) { return; }

		ticks++;
		let reason = null;

		if (/Invalid Price/.test(text)) { reason = 'invalid price'; }

		const m = text.match(TICK_PARSE_RE);
		if (m) {
			const last = parseFloat(m[2]), dca = parseFloat(m[3]), profit = parseFloat(m[4]);
			if (!reason && last === 0) { reason = 'zero price'; }
			if (!reason && Number.isFinite(profit) && Math.abs(profit) >= profitThreshold) { reason = 'implausible profit ' + profit + '%'; }
			if (!reason && dca > 0 && last > 0 && (last / dca >= deviationFactor || last / dca <= 1 / deviationFactor)) {
				reason = 'price ' + last + ' deviates ' + Math.round(last / dca) + 'x from DCA ' + dca;
			}
		}

		if (reason) {
			anomalies++;
			if (flagged.length < maxLines) { flagged.push(clipLine(text) + '   <<ANOMALY: ' + reason); }
			else { truncated = true; }
		}
	};

	const stream = fs.createReadStream(filePath, { 'highWaterMark': READ_CHUNK_BYTES });
	let carry = Buffer.alloc(0), chunkCount = 0;

	try {
		for await (const chunk of stream) {
			bytesRead += chunk.length;
			const buf = carry.length ? Buffer.concat([ carry, chunk ]) : chunk;
			let start = 0;
			while (true) {
				const nl = buf.indexOf(10, start);
				if (nl === -1) { break; }
				handle(buf.subarray(start, nl));
				start = nl + 1;
			}
			carry = buf.subarray(start);
			if (carry.length > MAX_CARRY_BYTES) { truncated = true; carry = carry.subarray(0, 0); }
			// Yield twice as often as the plain scanner: each tick line runs the multi-segment
			// TICK_PARSE_RE, so a tick-dense span is more CPU per chunk — hand control back to the
			// trading loop every ~2 MB rather than ~8 MB.
			if ((++chunkCount % 2) === 0) { await new Promise(resolve => setImmediate(resolve)); }
		}
		if (carry.length) { handle(carry); }
	}
	finally {
		stream.destroy();
	}

	return { 'ticksScanned': ticks, 'anomalies': anomalies, 'lines': flagged, 'bytesRead': bytesRead, 'truncated': truncated };
}


async function scanPriceAnomalies(params) {

	const opts = params || {};

	let dates = opts.dates;
	if ((!dates || !dates.length) && (opts.from || opts.to)) { dates = datesInWindow(opts.from, opts.to); }
	dates = (dates || []).filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));

	if (dates.length === 0) { return { 'success': false, 'error': 'No dates provided' }; }

	const maxFiles = Math.min(dates.length, 3);
	const lineCap = (typeof opts.maxLines === 'number' && opts.maxLines >= 0) ? opts.maxLines : 100;
	const flagged = [];
	const filesScanned = [];
	let ticks = 0, anomalies = 0, truncated = false, failure = null;

	for (const name of logFilesForDates(dates, maxFiles)) {

		// The flagged-line sample is capped ACROSS files — once it is full, later files are
		// still scanned for accurate anomaly COUNTS but keep no more sample lines.
		const remaining = lineCap - flagged.length;

		const resolved = resolveLogFile(name);
		if (!resolved.success) { continue; }

		try {
			const r = await scanFileForAnomalies(resolved.path, {
				'maxLines': Math.max(remaining, 0),
				'profitThreshold': opts.profitThreshold,
				'deviationFactor': opts.deviationFactor,
				'tsFrom': opts.from,
				'tsTo': opts.to
			});
			ticks += r.ticksScanned;
			anomalies += r.anomalies;
			flagged.push(...r.lines);
			filesScanned.push(name);
			if (r.truncated) { truncated = true; }
		}
		catch (e) { failure = e.message; }
	}

	return {
		'success': failure == null,
		'error': failure,
		'ticks_scanned': ticks,
		'anomalies_found': anomalies,
		'lines': flagged,
		'files': filesScanned,
		'truncated': truncated,
		'note': anomalies === 0 ? 'No implausible prices found in the scanned range.' : 'Flagged ticks whose price/profit is implausible — a likely garbage price (e.g. from an API/auth hiccup), not a real market move.'
	};
}


module.exports = {

	scanLogs,
	scanFile,
	getDealEvents,
	getDealEventsRange,
	getNotableEvents,
	getRecentErrors,
	getErrorBaselineDiff,
	getRestarts,
	analyzeLogs,
	getEventsInWindow,
	findIncident,
	scanPriceAnomalies,
	datesInWindow,
	resolveLogFile,
	logFilesForDates,   // exposed for tests (date-budget cap + never-split-a-day)

	EVENT_PATTERNS,
	ERROR_PATTERNS,

	init: function(obj) {

		shareData = obj;
	}
};