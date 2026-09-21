'use strict';

// Tests the forensic log-analysis tools against a synthetic incident log — deterministic,
// no model, no network. Reproduces the real-world case: an auth-error storm, zero/invalid
// prices, a garbage $65.11 recovery tick that closes a deal at +154921%, and completions.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LogScan = require('../../queries/LogScan.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'logscan-'));
fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });

const LINES = [
	'2026-08-12T08:00:00.000Z Starting SymBot',
	'2026-08-12T09:19:00.000Z Get symbol WAL/USDC error: {"name":"AuthenticationError"} binance requires "apiKey" credential',
	'2026-08-12T09:19:30.000Z Get symbol APT/USDC error: {"name":"AuthenticationError"} binance requires "apiKey" credential',
	'2026-08-12T09:20:00.000Z Invalid Price: 0',
	'2026-08-12T09:20:05.000Z Pair: WAL/USDC\tLast Price: $0\tDCA Price: $0.1508\tProfit: -101.25%',
	'2026-08-12T09:21:04.000Z Resuming Deal ID WAL_USDC-4A05CC7-1786751891',
	'2026-08-12T09:21:04.000Z Pair: WAL/USDC\tQty: 305752.8\tLast Price: $65.11\tDCA Price: $0.042\tSell Price: $0.0425\tStatus: SELL\tProfit: 154921.56',
	'2026-08-12T09:21:05.000Z Deal ID WAL_USDC-4A05CC7-1786751891 DCA Bot Finished.',
	'2026-08-12T11:00:00.000Z Pair: BTC/USD\tLast Price: $62000\tDCA Price: $61000\tProfit: 1.6%',
	''
];
fs.writeFileSync(path.join(TMP, 'logs', '2026-08-12.log'), LINES.join('\n'));

LogScan.init({ appData: { path_root: TMP } });

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

(async () => {

	// analyze_logs — count + group_by hour
	const count = await LogScan.analyzeLogs({ terms: ['AuthenticationError'], dates: ['2026-08-12'], mode: 'count' });
	ok(count.total_matches === 2, 'analyze_logs counts the 2 auth errors');

	const byHour = await LogScan.analyzeLogs({ terms: ['AuthenticationError'], dates: ['2026-08-12'], group_by: 'hour' });
	ok(byHour.by_group['2026-08-12T09'] === 2, 'analyze_logs group_by hour buckets both under 09:00');

	// window filter — restrict to 09:19–09:22
	const win = await LogScan.getEventsInWindow({ from: '2026-08-12T09:19:00Z', to: '2026-08-12T09:22:00Z' });
	const winText = (win.lines || []).join('\n');
	ok(/AuthenticationError/.test(winText) && /DCA Bot Finished/.test(winText) && /Resuming Deal/.test(winText), 'get_events_in_window surfaces the incident events');
	ok(!/11:00:00/.test(winText) && !/08:00:00/.test(winText), 'events outside the window are excluded');

	// find_incident — correlate + affected deals
	const inc = await LogScan.findIncident({ around: '2026-08-12T09:20', window_minutes: 5 });
	ok(inc.success && inc.total > 0, 'find_incident returns clustered events');
	ok(inc.affected_deals.includes('WAL_USDC-4A05CC7-1786751891'), 'find_incident surfaces the affected deal id');

	// scan_price_anomalies — flags the zero tick and the garbage $65.11 close
	const an = await LogScan.scanPriceAnomalies({ dates: ['2026-08-12'] });
	ok(an.success && an.anomalies_found >= 2, 'scan_price_anomalies flags the zero price and the $65.11 tick');
	const anText = (an.lines || []).join('\n');
	ok(/65\.11/.test(anText) && /(implausible profit|deviates)/.test(anText), 'the garbage $65.11 recovery price is flagged as anomalous');
	ok(!/62000/.test(anText), 'the normal BTC tick is NOT flagged');

	// dates helper
	const ds = LogScan.datesInWindow('2026-08-11T23:00:00Z', '2026-08-12T01:00:00Z');
	ok(ds.length === 2 && ds[0] === '2026-08-11' && ds[1] === '2026-08-12', 'datesInWindow spans the right days');

	// analyze_logs count is accurate ACROSS files even when the first day alone fills the line
	// sample (regression: the shared 30-line budget used to stop later days being counted).
	for (const d of [ '2026-08-20', '2026-08-21', '2026-08-22' ]) {
		const L = [];
		for (let i = 0; i < 40; i++) { const mm = String(i % 60).padStart(2, '0'); L.push(d + 'T10:' + mm + ':00.000Z Get symbol X/USDC error: {"name":"AuthenticationError"}'); }
		fs.writeFileSync(path.join(TMP, 'logs', d + '.log'), L.join('\n') + '\n');
	}
	const multi = await LogScan.analyzeLogs({ terms: [ 'AuthenticationError' ], dates: [ '2026-08-20', '2026-08-21', '2026-08-22' ], mode: 'count' });
	ok(multi.total_matches === 120, 'analyze_logs count sums all 3 days (120), not just the first');
	const grp = await LogScan.analyzeLogs({ terms: [ 'AuthenticationError' ], dates: [ '2026-08-20', '2026-08-21', '2026-08-22' ], group_by: 'hour' });
	ok(grp.by_group['2026-08-20T10'] === 40 && grp.by_group['2026-08-22T10'] === 40, 'group_by hour buckets every day, not only the first');

	// Window bounds WITHOUT milliseconds must still be inclusive at the exact from-second and
	// exclude the instant just past the to-second (regression: raw string compare was off by ~1s).
	fs.writeFileSync(path.join(TMP, 'logs', '2026-08-23.log'), [
		'2026-08-23T09:19:00.000Z EVENT AuthenticationError atfrom',
		'2026-08-23T09:20:00.999Z EVENT AuthenticationError lastsec',
		'2026-08-23T09:20:01.000Z EVENT AuthenticationError justafter',
		''
	].join('\n'));
	const bw = await LogScan.getEventsInWindow({ from: '2026-08-23T09:19:00Z', to: '2026-08-23T09:20:00Z' });
	const bwText = (bw.lines || []).join('\n');
	ok(/atfrom/.test(bwText) && /lastsec/.test(bwText), 'window includes the from-second and the whole to-second');
	ok(!/justafter/.test(bwText), 'window excludes the instant just past the to-second');

	// summarize_recent_errors must RANK by error type with real counts summed across ALL days —
	// including the exchange/API `error:{"name":"X"}` class, which is the most common in real logs
	// and used to be invisible (regression: narrow ERROR_PATTERNS + single-mode aggregation gate).
	for (const [d, rate, timeout] of [ [ '2026-09-01', 30, 5 ], [ '2026-09-02', 40, 10 ] ]) {
		const L = [];
		for (let i = 0; i < rate; i++) { L.push(d + 'T10:00:0' + (i % 10) + '.000Z Get symbol X/USD error: {"name":"RateLimitExceeded"} coinbase 429 Too Many Requests'); }
		for (let i = 0; i < timeout; i++) { L.push(d + 'T11:00:0' + (i % 10) + '.000Z Get symbol Y/USD error: {"name":"RequestTimeout"} coinbase request timed out'); }
		L.push(d + 'T12:00:00.000Z Your wallet does not have enough funds for all DCA orders!');
		fs.writeFileSync(path.join(TMP, 'logs', d + '.log'), L.join('\n') + '\n');
	}
	const er = await LogScan.getRecentErrors([ '2026-09-01', '2026-09-02' ], '', 20);
	ok(er.total_errors === 87, 'error totals sum across all days (30+40 rate, 5+10 timeout, 2 funds = 87), not just day one');
	ok(er.files.length === 2, 'both days are scanned for counts even after the line sample fills');
	ok(er.errors_by_type[0].type === 'RateLimitExceeded' && er.errors_by_type[0].count === 70, 'errors ranked by kind, API class counted (RateLimitExceeded=70)');
	ok(er.errors_by_type.some(e => e.type === 'not have enough funds' && e.count === 2), 'non-API errors bucket by their plain-language type too');
	// Per-type examples: EVERY ranked type must carry its own real example lines (captured per bucket during
	// the scan), not just the dominant one that happens to fill the global sample.
	ok(er.errors_by_type.every(e => Array.isArray(e.examples) && e.examples.length > 0), 'every ranked error type carries at least one real example line');
	const fundsType = er.errors_by_type.find(e => e.type === 'not have enough funds');
	ok(fundsType && /does not have enough funds/.test((fundsType.examples || []).join('\n')), 'a non-dominant error type still gets its own verbatim example line');

	// get_events_in_window must surface an error logged only as FREE TEXT ("…does not have enough funds…"),
	// not just the EVENT_PATTERNS markers — regression for a window scan reporting "no activity" for a window
	// that in fact contained funds/exchange errors.
	const fw = await LogScan.getEventsInWindow({ from: '2026-09-01T11:59:00Z', to: '2026-09-01T12:01:00Z' });
	ok(/does not have enough funds/.test((fw.lines || []).join('\n')), 'get_events_in_window surfaces a free-text funds error (WINDOW_NEEDLES includes ERROR_PATTERNS)');

	// Multi-window (time-of-day BAND) scan: ONE pass keeps lines from ANY supplied window across several days,
	// and errors_only narrows to the error markers so a busy day of routine events cannot dilute them.
	fs.writeFileSync(path.join(TMP, 'logs', '2026-10-01.log'), [
		'2026-10-01T09:00:00.000Z Deal ID X_USD-a-1 DCA Bot Finished.',                              // outside the 17:00 band
		'2026-10-01T17:00:00.000Z CIRCUIT BREAKER ACTIVATED (60s): Deal ratio: 5/9',
		''
	].join('\n'));
	fs.writeFileSync(path.join(TMP, 'logs', '2026-10-02.log'), [
		'2026-10-02T17:05:00.000Z Your wallet does not have enough funds for all DCA orders!',
		''
	].join('\n'));
	const mw = await LogScan.getEventsInWindow({ windows: [
		{ from: '2026-10-01T16:55:00Z', to: '2026-10-01T17:10:00Z' },
		{ from: '2026-10-02T16:55:00Z', to: '2026-10-02T17:10:00Z' }
	] });
	const mwText = (mw.lines || []).join('\n');
	ok(/CIRCUIT BREAKER/.test(mwText) && /does not have enough funds/.test(mwText), 'multi-window scan returns lines from ALL windows in a single pass');
	ok(!/09:00:00/.test(mwText), 'a line outside every window is excluded');
	const eo = await LogScan.getEventsInWindow({ windows: [ { from: '2026-10-01T00:00:00Z', to: '2026-10-01T23:59:59Z' } ], errors_only: true });
	const eoText = (eo.lines || []).join('\n');
	ok(/CIRCUIT BREAKER/.test(eoText) && !/DCA Bot Finished/.test(eoText), 'errors_only keeps error markers and drops routine lifecycle events');

	// Circuit-breaker ACTIVATED is a genuine incident; the paired "CIRCUIT BREAKER CLEARED — resuming normal
	// deal processing" recovery must NOT be counted as an error (the bare-substring needle used to fold both
	// together and inflate the tally). A plain window scan still surfaces the recovery line as context.
	fs.writeFileSync(path.join(TMP, 'logs', '2026-10-15.log'), [
		'2026-10-15T05:09:19.059Z CIRCUIT BREAKER ACTIVATED (60s): Deal ratio: 5/9 deals triggered safety orders within 31s',
		'2026-10-15T05:10:19.059Z CIRCUIT BREAKER CLEARED — resuming normal deal processing',
		'2026-10-15T05:11:19.059Z CIRCUIT BREAKER ACTIVATED (60s): Deal ratio: 6/9 deals triggered safety orders within 31s',
		''
	].join('\n'));
	const cb = await LogScan.getRecentErrors([ '2026-10-15' ], '', 20);
	ok(cb.total_errors === 2, 'only the two CIRCUIT BREAKER ACTIVATED lines count as errors — the CLEARED recovery is excluded');
	ok(cb.errors_by_type.some(e => e.type === 'CIRCUIT BREAKER ACTIVATED' && e.count === 2), 'the error type is the specific ACTIVATED marker, not the bare "CIRCUIT BREAKER" substring');
	ok(!cb.errors_by_type.some(e => /CLEARED/.test(e.type)), 'no CLEARED recovery line appears in the error breakdown');
	const cbEo = await LogScan.getEventsInWindow({ windows: [ { from: '2026-10-15T00:00:00Z', to: '2026-10-15T23:59:59Z' } ], errors_only: true });
	ok(!/CLEARED/.test((cbEo.lines || []).join('\n')), 'errors_only drops the CIRCUIT BREAKER CLEARED recovery line');
	const cbAll = await LogScan.getEventsInWindow({ windows: [ { from: '2026-10-15T00:00:00Z', to: '2026-10-15T23:59:59Z' } ] });
	ok(/CIRCUIT BREAKER CLEARED/.test((cbAll.lines || []).join('\n')), 'a plain window scan still surfaces the recovery line as context');

	// Timezone spillover: a line stamped for day D can live in the file NAMED for the previous day
	// (filename = writer's local date, line stamp = UTC). "Errors on D" must still find them by
	// scanning the neighbor file and filtering to D's real UTC window.
	fs.writeFileSync(path.join(TMP, 'logs', '2026-09-09.log'), [
		'2026-09-09T23:59:00.000Z Get symbol Z/USD error: {"name":"RateLimitExceeded"} 429',   // belongs to the 09th
		'2026-09-10T00:01:00.000Z Get symbol Z/USD error: {"name":"RateLimitExceeded"} 429',   // stamped the 10th, but in the 09th file
		'2026-09-10T00:02:00.000Z Get symbol Z/USD error: {"name":"RequestTimeout"} timeout',  // stamped the 10th, in the 09th file
		''
	].join('\n'));
	fs.writeFileSync(path.join(TMP, 'logs', '2026-09-10.log'), [
		'2026-09-10T12:00:00.000Z Get symbol Z/USD error: {"name":"NetworkError"} net',         // stamped + named the 10th
		''
	].join('\n'));
	const spill = await LogScan.getRecentErrors([ '2026-09-10' ], '', 20);
	ok(spill.total_errors === 3, 'errors "on the 10th" include the two that spilled into the 09th-named file (3 total), not just the 1 physically in the 10th file');
	ok(!spill.errors_by_day.some(d => d.date === '2026-09-09'), 'the 09th line in the same neighbor file is excluded by the UTC window');

	// Map-reduce over a WIDE window: an aggregate count must span far more than the old 4-file cap.
	// Ten days of errors, all counted, with honest coverage fields.
	const wideDates = [];
	for (let i = 0; i < 10; i++) {
		const d = '2026-10-' + String(i + 1).padStart(2, '0');
		wideDates.push(d);
		fs.writeFileSync(path.join(TMP, 'logs', d + '.log'), d + 'T10:00:00.000Z Get X/USD error: {"name":"NetworkError"} net\n');
	}
	const wide = await LogScan.analyzeLogs({ terms: [ 'NetworkError' ], dates: wideDates, mode: 'count' });
	ok(wide.total_matches === 10, 'aggregate count spans all 10 days (map-reduce), not just the first few');
	ok(wide.days_scanned === 10 && wide.days_requested === 10, 'coverage fields report full scan (10/10 days)');
	ok(wide.truncated === false && wide.stopped_reason == null, 'a fully-covered wide scan is not flagged truncated');

	// Soft wall-clock budget: with a near-zero budget the scan stops early and returns an HONEST partial —
	// correct total for the days actually reached, truncated with stopped_reason 'time'. Use a LARGE file
	// set (not the 10-day one) so the 1 ms budget reliably trips: the per-file deadline check is only
	// meaningful once real I/O has elapsed, and a handful of tiny files can finish inside a single
	// millisecond tick on a fast machine (which made this assertion flaky). Hundreds of files cannot.
	const budgetDates = [];
	for (let i = 0; i < 400; i++) {
		const base = new Date(Date.UTC(2027, 0, 1) + i * 86400000);   // 2027-01-01 onward, one file per day
		const d = base.toISOString().slice(0, 10);
		budgetDates.push(d);
		fs.writeFileSync(path.join(TMP, 'logs', d + '.log'), d + 'T10:00:00.000Z Get X/USD error: {"name":"NetworkError"} net\n');
	}
	const partial = await LogScan.scanLogs({ needles: [ 'NetworkError' ], dates: budgetDates, instanceName: '', aggregate: 'day', maxFiles: budgetDates.length, maxLines: 5, softTimeMs: 1 });
	ok(partial.files_scanned >= 1 && partial.files_scanned < budgetDates.length, 'soft time budget stops the scan EARLY (before all days)');
	ok(partial.truncated === true && partial.stopped_reason === 'time', 'partial scan is flagged truncated with reason "time"');
	ok(partial.matchCount === partial.files_scanned, 'only the days actually reached are counted (no fabricated totals)');

	// Truncation must be judged by DISTINCT DATES, not the file count. A day with TWO logs (a bare
	// "<date>.log" plus a legacy "<date>-<name>.log" after a rename) previously inflated the file count and
	// MASKED a genuinely dropped later date — reporting a partial answer as complete. Here a 1-date budget
	// over two requested dates must still flag truncated even though the covered day contributes two files.
	fs.writeFileSync(path.join(TMP, 'logs', '2027-06-01.log'), '2027-06-01T10:00:00.000Z marker-A\n');
	fs.writeFileSync(path.join(TMP, 'logs', '2027-06-01-oldname.log'), '2027-06-01T11:00:00.000Z marker-A\n');   // same DAY, legacy naming
	fs.writeFileSync(path.join(TMP, 'logs', '2027-06-02.log'), '2027-06-02T10:00:00.000Z marker-A\n');
	const dualDay = await LogScan.scanLogs({ needles: [ 'marker-A' ], dates: [ '2027-06-01', '2027-06-02' ], instanceName: '', aggregate: 'day', maxFiles: 1, maxLines: 50 });
	ok(dualDay.files_scanned === 2, 'the single covered day contributes BOTH of its files (day never split)');
	ok(dualDay.truncated === true && dualDay.stopped_reason === 'file_cap', 'the dropped second date is still reported as truncated despite the inflated file count');

	// Event-template registry: find_incident must roll its per-marker counts up into stable
	// CATEGORIES (auth, network, order, exchange, …) so "what kind of incident" is answerable.
	fs.writeFileSync(path.join(TMP, 'logs', '2026-11-05.log'), [
		'2026-11-05T14:00:01.000Z Get X/USD error: {"name":"AuthenticationError"} key rejected',
		'2026-11-05T14:00:05.000Z Get X/USD error: {"name":"NetworkError"} net down',
		'2026-11-05T14:00:07.000Z Get X/USD error: {"name":"RequestTimeout"} timed out',
		'2026-11-05T14:00:09.000Z ABC_USD-bot-1 Invalid order rejected by exchange',
		'2026-11-05T14:00:11.000Z Your wallet does not have enough funds for all DCA orders!',
		''
	].join('\n'));
	const incReg = await LogScan.findIncident({ around: '2026-11-05T14:00:06', window_minutes: 5 });
	ok(incReg.by_category && incReg.by_category.auth === 1, 'incident rolls the AuthenticationError up into the auth category');
	ok(incReg.by_category.network === 2, 'NetworkError + RequestTimeout roll up into the network category');
	ok(incReg.by_category.order === 1 && incReg.by_category.funds === 1, 'order and funds categories are counted from the registry');

	try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

	console.log('LogScan: ' + passed + ' assertions passed');
})().catch(e => { console.error('FAIL', e); process.exit(1); });