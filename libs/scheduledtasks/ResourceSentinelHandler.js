'use strict';


// The user-facing "resource_sentinel" scheduled recipe. On a schedule it samples HOST-level system
// resources — free disk on the data volume, free memory, CPU pressure, and event-loop responsiveness —
// and alerts ONLY when a resource crosses its warning threshold. Quiet when everything is healthy
// (no-news-is-good-news), so a well-provisioned instance is never spammed. It is READ-ONLY and fully
// isolated: it samples system metrics, it can never place, pause, cancel, or change a trade.
//
// Why these four: disk-full (DB writes and backups fail), out-of-memory (the process is killed),
// sustained CPU saturation, and a blocked event loop are the conditions that can actually make the
// trading loop's timing slip or stall — so warning BEFORE they bite is proactive hardening. The
// event-loop check is the most direct of these: it measures how long the loop was kept waiting, which
// is exactly what a stray synchronous call regresses, so it catches a "should have stayed non-blocking"
// mistake at runtime rather than after it has already delayed a trade.
//
// Cross-platform by design (Linux / macOS / Windows) using ONLY Node built-ins — no native modules and
// no shelling out: memory comes from the shared, platform-accurate Common.hostMemory() (Linux
// MemAvailable / Windows available / macOS free-with-caveat), disk from `fs.statfs` (Node ≥ 18.15; this
// project requires ≥ 22), and CPU pressure from sampling `os.cpus()` idle/total over a short interval
// rather than `os.loadavg()` (which is Unix-only and reports 0 on Windows).
//
// The Scheduler core owns timing, persistence, retries and run bookkeeping; this module owns only
// "what a resource check does when it runs". Every threshold is read from the schedule row's own
// `settings`, so ONE static handler serves any number of user-created sentinel schedules — users add /
// enable / disable / remove them as data, never by editing code here. A threshold of 0 (or less)
// disables that individual check.


const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const { monitorEventLoopDelay } = require('perf_hooks');

// The volume SymBot runs and writes on. Disk space is per-volume, so any path on it yields the same
// figure; the app root (two levels up from libs/scheduledtasks) is the data volume in a normal install.
const APP_ROOT = path.resolve(__dirname, '..', '..');

// Defaults applied when a schedule omits a knob. All three default ON: host memory comes from the
// shared, platform-accurate Common.hostMemory() (real AVAILABLE memory on Linux and Windows), so a
// modest free threshold no longer cries wolf there. On macOS that helper reports its figure as
// UNRELIABLE (the OS exposes no true availability without shelling out), and the handler simply does
// not alert on memory there — it still shows the reading. Users tune any of these per schedule; a
// threshold of 0 disables that individual check.
// event_loop_lag_ms is the worst tolerated loop delay (ms) over the sample window; above it the loop was
// blocked long enough to risk slipping the trading loop's timing. The default is generous so only a real
// stall alerts, never normal jitter. 0 disables the check, like the others.
const DEFAULTS = { disk_free_pct: 10, mem_free_pct: 10, cpu_busy_pct: 92, cpu_sample_ms: 500, event_loop_lag_ms: 250 };


function numOr(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }

// Bytes → a short human string. Local to this handler (display-only); no shared formatter exists.
function human(bytes) {
	const b = Number(bytes) || 0;
	if (b >= 1024 ** 3) { return (b / (1024 ** 3)).toFixed(1) + ' GB'; }
	if (b >= 1024 ** 2) { return (b / (1024 ** 2)).toFixed(0) + ' MB'; }
	return (b / 1024).toFixed(0) + ' KB';
}


async function diskInfo(diskPath) {
	try {
		const s = await fsp.statfs(diskPath);
		const total = s.blocks * s.bsize;
		const free = s.bavail * s.bsize;   // space available to an unprivileged user (the real headroom)
		if (!(total > 0)) { return null; }
		return { path: diskPath, freePct: Math.round((free / total) * 100), freeHuman: human(free), totalHuman: human(total) };
	}
	catch (e) { return null; }            // statfs unsupported / path gone → skip disk, never throw
}

// Host memory is read through the SHARED, platform-accurate Common.hostMemory() (Linux MemAvailable /
// Windows available / macOS free-with-caveat) so the platform logic lives in exactly one place, used
// by both this task and the System Tools health card. Returns null if the helper is unavailable.
function memInfo(shareData) {
	if (!shareData || !shareData.Common || typeof shareData.Common.hostMemory !== 'function') { return null; }
	const m = shareData.Common.hostMemory();
	if (!m || m.availablePct == null) { return null; }
	return { availPct: m.availablePct, availHuman: human(m.availableBytes), totalHuman: human(m.totalBytes), reliable: m.reliable, basis: m.basis };
}

function cpuSnapshot() {
	const cpus = os.cpus() || [];
	let idle = 0, total = 0;
	for (const c of cpus) { for (const k in c.times) { total += c.times[k]; } idle += c.times.idle; }
	return { idle, total, cores: cpus.length };
}

// Busy % across all cores, sampled over `sampleMs` (clamped so the check is always brief).
async function cpuBusy(sampleMs) {
	const ms = Math.min(Math.max(numOr(sampleMs, DEFAULTS.cpu_sample_ms), 100), 2000);
	const a = cpuSnapshot();
	await new Promise((r) => setTimeout(r, ms));
	const b = cpuSnapshot();
	const dTotal = b.total - a.total;
	const dIdle = b.idle - a.idle;
	if (!(dTotal > 0)) { return { busyPct: null, cores: b.cores }; }
	return { busyPct: Math.round((1 - dIdle / dTotal) * 100), cores: b.cores };
}

// Worst and p99 event-loop delay (ms) over `sampleMs`, using the built-in high-resolution histogram (no
// native module, no shelling out, cross-platform). It runs concurrently with the CPU sample so it adds no
// extra wall-clock. `maxMs` is the worst single stall in the window — the clearest sign a synchronous call
// blocked the loop. Never throws: if perf_hooks is unavailable the check is simply skipped.
async function eventLoopLag(sampleMs) {
	const ms = Math.min(Math.max(numOr(sampleMs, DEFAULTS.cpu_sample_ms), 100), 2000);
	let h;
	try { h = monitorEventLoopDelay({ resolution: 20 }); h.enable(); }
	catch (e) { return { maxMs: null, p99Ms: null }; }
	await new Promise((r) => setTimeout(r, ms));
	try {
		h.disable();
		return { maxMs: Math.round(h.max / 1e6), p99Ms: Math.round(h.percentile(99) / 1e6) };
	}
	catch (e) { return { maxMs: null, p99Ms: null }; }
}

// The pure threshold logic, split out so it is unit-testable without sampling real hardware and so the
// handler body stays a thin orchestrator. Returns a human-readable line for every resource that crossed
// its threshold; a threshold of 0 (or less) disables that individual check.
function evaluateFlags(metrics, th) {

	const flagged = [];
	const disk = metrics.disk, mem = metrics.mem, cpu = metrics.cpu, loop = metrics.loop;

	if (th.disk > 0 && disk && disk.freePct != null && disk.freePct < th.disk) {
		flagged.push('Disk low on ' + disk.path + ': ' + disk.freePct + '% free (' + disk.freeHuman + ' of ' + disk.totalHuman + ') — below the ' + th.disk + '% threshold.');
	}
	// Only alert on memory when the reading is RELIABLE (Linux/Windows). On macOS the figure is
	// free-pages-only and understates availability, so it is shown but never alerted on.
	if (th.mem > 0 && mem && mem.reliable && mem.availPct != null && mem.availPct < th.mem) {
		flagged.push('Memory low: ' + mem.availPct + '% available (' + mem.availHuman + ' of ' + mem.totalHuman + ') — below the ' + th.mem + '% threshold.');
	}
	if (th.cpu > 0 && cpu && cpu.busyPct != null && cpu.busyPct > th.cpu) {
		flagged.push('CPU saturated: ' + cpu.busyPct + '% busy across ' + cpu.cores + ' core(s) — above the ' + th.cpu + '% threshold.');
	}
	if (th.elag > 0 && loop && loop.maxMs != null && loop.maxMs > th.elag) {
		flagged.push('Event loop blocked: ' + loop.maxMs + ' ms worst delay (p99 ' + loop.p99Ms + ' ms) — above the ' + th.elag + ' ms threshold. Something held the loop synchronously, which can slip the trading loop’s timing.');
	}

	return flagged;
}


function register(scheduler, shareData) {

	scheduler.registerHandler('resource_sentinel', async (job) => {

		const settings = (job && job.settings) || {};

		const th = {
			disk: numOr(settings.disk_free_pct, DEFAULTS.disk_free_pct),
			mem:  numOr(settings.mem_free_pct,  DEFAULTS.mem_free_pct),
			cpu:  numOr(settings.cpu_busy_pct,  DEFAULTS.cpu_busy_pct),
			elag: numOr(settings.event_loop_lag_ms, DEFAULTS.event_loop_lag_ms)
		};
		const diskPath = (typeof settings.disk_path === 'string' && settings.disk_path.trim() !== '') ? settings.disk_path.trim() : APP_ROOT;

		try {

			// CPU and event-loop delay share the same sample window (both run for cpu_sample_ms), so adding
			// the loop check costs no extra wall-clock.
			const [ disk, cpu, loop ] = await Promise.all([ diskInfo(diskPath), cpuBusy(settings.cpu_sample_ms), eventLoopLag(settings.cpu_sample_ms) ]);
			const mem = memInfo(shareData);
			const metrics = { disk, mem, cpu, loop };

			const flagged = evaluateFlags(metrics, th);

			// Alert ONLY when a threshold is crossed. `status:'error'` so targets set to fire on
			// 'failure' (or 'always') deliver, while a routine healthy run stays quiet.
			if (flagged.length > 0) {

				const targets = shareData.ScheduleNotifier.resolveTargets(job.settings);

				await shareData.ScheduleNotifier.deliver(targets, {
					message: formatAlert(job, flagged, metrics),
					type: 'warning',
					status: 'error'
				});
			}

			return { status: 'ok', output: runSummary(job, flagged, metrics, th) };
		}
		catch (e) {

			shareData.Common.logger('Scheduler: resource_sentinel run failed for ' + (job && job.schedule_id) + ': ' + e.message);

			// A broken sentinel must be visible rather than silently failing to warn — surface the
			// failure itself as an alert (best-effort; never let notify failure mask the run error).
			try {
				const targets = shareData.ScheduleNotifier.resolveTargets(job.settings);
				await shareData.ScheduleNotifier.deliver(targets, {
					message: '⚠️ ' + (job.label || 'Resource sentinel') + ' check failed: ' + e.message,
					type: 'warning',
					status: 'error'
				});
			}
			catch (e2) { /* notify is best-effort */ }

			return { status: 'error', output: 'Resource check failed: ' + e.message };
		}
	});
}


// One line per current reading, so a healthy run is still informative (the reader sees the actual
// headroom, not just "all normal"). Unavailable metrics (e.g. disk on an exotic FS) are shown as such.
function metricLines(metrics) {

	const lines = [];
	lines.push('• Disk: ' + (metrics.disk ? (metrics.disk.freePct + '% free (' + metrics.disk.freeHuman + ' of ' + metrics.disk.totalHuman + ') on ' + metrics.disk.path) : 'unavailable'));
	lines.push('• Memory: ' + (metrics.mem
		? (metrics.mem.availPct + '% ' + metrics.mem.basis + ' (' + metrics.mem.availHuman + ' of ' + metrics.mem.totalHuman + ')' + (metrics.mem.reliable ? '' : ' — this OS reports only free memory, not true availability, so it is not alerted on'))
		: 'unavailable'));
	lines.push('• CPU: ' + (metrics.cpu && metrics.cpu.busyPct != null ? (metrics.cpu.busyPct + '% busy across ' + metrics.cpu.cores + ' core(s)') : 'unavailable'));
	lines.push('• Event loop: ' + (metrics.loop && metrics.loop.maxMs != null ? (metrics.loop.maxMs + ' ms worst delay (p99 ' + metrics.loop.p99Ms + ' ms)') : 'unavailable'));
	return lines;
}

function formatAlert(job, flagged, metrics) {

	const lines = [ '🚨 ' + (job.label || 'Resource sentinel'), '', flagged.length + ' resource(s) crossed a warning threshold:' ];
	for (const f of flagged) { lines.push('• ' + f); }
	lines.push('', 'Current readings:');
	for (const l of metricLines(metrics)) { lines.push(l); }
	return lines.join('\n');
}

function runSummary(job, flagged, metrics, th) {

	const head = flagged.length > 0
		? '🚨 ' + (job.label || 'Resource sentinel') + ': ' + flagged.length + ' resource(s) crossed a warning threshold.'
		: '✓ ' + (job.label || 'Resource sentinel') + ': all resources within their thresholds.';

	const thresholds = 'Thresholds: disk ≥ ' + th.disk + '% free, memory ≥ ' + th.mem + '% available, CPU ≤ ' + th.cpu + '% busy, event loop ≤ ' + th.elag + ' ms delay (0 = check disabled; memory only alerts where the OS reports true availability).';

	return head + '\n\n' + metricLines(metrics).join('\n') + '\n\n' + thresholds;
}


module.exports = { register, evaluateFlags };
