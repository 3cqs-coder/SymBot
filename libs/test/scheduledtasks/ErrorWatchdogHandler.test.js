'use strict';

// Tests the 'error_watchdog' scheduled-task recipe against synthetic logs, exercising the REAL
// error-baseline path (AITools.errorBaselineWindows + LogScan.getErrorBaselineDiff) — no model,
// no network. Verifies: (1) a NEW/SPIKING error type produces one detailed alert with evidence;
// (2) a clean scan (nothing unusual) stays SILENT; (3) a scan failure reports status 'error' and
// still surfaces an alert so a broken watchdog is visible.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const aiTools = require('../../ai/AITools.js');
const LogScan = require('../../queries/LogScan.js');
const ErrorWatchdogHandler = require('../../scheduledtasks/ErrorWatchdogHandler.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-'));
fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });

const DAY = 86400000;
const dstr = (d) => new Date(d).toISOString().slice(0, 10);
const now = Date.now();
const today = dstr(now);
const prior = [ dstr(now - DAY), dstr(now - 2 * DAY), dstr(now - 3 * DAY) ];

function writeLog(date, lines) { fs.writeFileSync(path.join(TMP, 'logs', date + '.log'), lines.join('\n') + '\n'); }

// Baseline days: a steady low level of RequestTimeout only (the "normal" mix).
for (const d of prior) {
	const L = [];
	for (let i = 0; i < 2; i++) { L.push(d + 'T12:0' + i + ':00.000Z Get X/USD error: {"name":"RequestTimeout"} timed out'); }
	writeLog(d, L);
}
// Today: RequestTimeout stays normal (~2), NetworkError is brand NEW (never in baseline), and
// RateLimitExceeded SPIKES (10 today vs 0 baseline → new/spiking territory).
{
	const L = [];
	for (let i = 0; i < 2; i++) { L.push(today + 'T12:0' + i + ':00.000Z Get X/USD error: {"name":"RequestTimeout"} timed out'); }
	for (let i = 0; i < 6; i++) { L.push(today + 'T13:0' + i + ':00.000Z Get Y/USD error: {"name":"NetworkError"} net down'); }
	for (let i = 0; i < 10; i++) { L.push(today + 'T14:' + String(i).padStart(2, '0') + ':00.000Z Get Z/USD error: {"name":"RateLimitExceeded"} 429 Too Many Requests'); }
	writeLog(today, L);
}

const Common = {
	getDateParts: (d) => ({ date: dstr(d) }),
	getInstanceName: async () => '',
	logger: () => {}
};
aiTools.init({ Common });
LogScan.init({ appData: { path_root: TMP }, Common });

// Capturing scheduler + notifier stubs.
function makeShareData(capture, opts) {
	return {
		Common: Object.assign({}, Common, opts && opts.commonOverride),
		ScheduleNotifier: {
			resolveTargets: (settings) => (settings && settings.notifications) || [ { type: 'browser', target: {}, on: [ 'always' ] } ],
			deliver: async (targets, payload) => { capture.push({ targets, payload }); return { delivered: (targets || []).length }; }
		}
	};
}

function registerAndGet(shareData) {
	let fn = null;
	const scheduler = { registerHandler: (type, handler) => { assert.strictEqual(type, 'error_watchdog'); fn = handler; } };
	ErrorWatchdogHandler.register(scheduler, shareData);
	assert.ok(typeof fn === 'function', 'handler registered');
	return fn;
}

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; console.log('  ok   - ' + m); }

(async () => {

	// (1) anomalies present → one detailed alert
	{
		const cap = [];
		const sd = makeShareData(cap);
		const handler = registerAndGet(sd);
		const res = await handler({ schedule_id: 's1', label: 'Error watchdog', settings: { target_days: 1, baseline_days: 3, notifications: [ { type: 'browser', target: {}, on: [ 'always' ] } ] } });

		ok(res.status === 'ok', 'clean-run status is ok even when it alerts (the run succeeded)');
		ok(cap.length === 1, 'exactly one alert delivered when error types are new/spiking');
		const msg = cap[0].payload.message;
		ok(cap[0].payload.type === 'warning' && cap[0].payload.status === 'error', 'alert is a warning with status error (so failure/always targets fire)');
		ok(/NetworkError/.test(msg) && /RateLimitExceeded/.test(msg), 'alert names the new/spiking error types');
		ok(/\[NEW\]|\[SPIKING\]/.test(msg), 'alert shows the anomaly status label');
		ok(/e\.g\./.test(msg), 'alert includes an example log line (detail/evidence)');
		ok(!/RequestTimeout/.test(msg), 'the steady/normal error type is NOT flagged');
		// The run history stores HUMAN-READABLE text (not JSON): the alert body plus the window/totals.
		ok(typeof res.output === 'string' && /NetworkError/.test(res.output) && /Scanned/.test(res.output) && /Errors:/.test(res.output), 'run output is human-readable text with the detail + window/totals');
	}

	// (2) clean scan → silent (no alert)
	{
		// A fresh window with no NEW/SPIKING types: make today mirror the baseline exactly.
		const clDay = dstr(now - 10 * DAY);
		const clPrior = [ dstr(now - 11 * DAY), dstr(now - 12 * DAY) ];
		for (const d of [ clDay, ...clPrior ]) {
			const L = []; for (let i = 0; i < 2; i++) { L.push(d + 'T12:0' + i + ':00.000Z Get X/USD error: {"name":"RequestTimeout"} timed out'); }
			writeLog(d, L);
		}
		const cap = [];
		const handler = registerAndGet(makeShareData(cap));
		const res = await handler({ schedule_id: 's2', label: 'Error watchdog', settings: { date: clDay, baseline_days: 2 } });
		ok(res.status === 'ok', 'clean scan returns ok');
		ok(cap.length === 0, 'a clean scan sends NO alert (no-news-is-good-news)');
	}

	// (3) failure → status error + best-effort alert
	{
		const cap = [];
		const sd = makeShareData(cap, { commonOverride: { getInstanceName: async () => { throw new Error('boom'); } } });
		const handler = registerAndGet(sd);
		const res = await handler({ schedule_id: 's3', label: 'Error watchdog', settings: { target_days: 1, baseline_days: 3 } });
		ok(res.status === 'error', 'a scan failure reports status error');
		ok(cap.length === 1 && /failed/i.test(cap[0].payload.message), 'the failure is surfaced as an alert (a broken watchdog is visible)');
	}

	try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
	console.log('\nErrorWatchdogHandler: ' + passed + ' assertions passed');
	process.exit(0);
})().catch(e => { console.error('FAIL', e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {} process.exit(1); });
