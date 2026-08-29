'use strict';


// The user-facing "resource_sentinel" scheduled recipe. On a schedule it samples HOST-level system
// resources — free disk on the data volume, free memory, and CPU pressure — and alerts ONLY when a
// resource crosses its warning threshold. Quiet when everything is healthy (no-news-is-good-news), so
// a well-provisioned instance is never spammed. It is READ-ONLY and fully isolated: it samples system
// metrics, it can never place, pause, cancel, or change a trade.
//
// Why these three: disk-full (DB writes and backups fail), out-of-memory (the process is killed), and
// sustained CPU saturation (the trading loop's timing slips) are the host conditions that can actually
// break trading — so warning BEFORE they bite is proactive hardening, not cosmetics.
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

// The volume SymBot runs and writes on. Disk space is per-volume, so any path on it yields the same
// figure; the app root (two levels up from libs/scheduledtasks) is the data volume in a normal install.
const APP_ROOT = path.resolve(__dirname, '..', '..');

// Defaults applied when a schedule omits a knob. All three default ON: host memory comes from the
// shared, platform-accurate Common.hostMemory() (real AVAILABLE memory on Linux and Windows), so a
// modest free threshold no longer cries wolf there. On macOS that helper reports its figure as
// UNRELIABLE (the OS exposes no true availability without shelling out), and the handler simply does
// not alert on memory there — it still shows the reading. Users tune any of these per schedule; a
// threshold of 0 disables that individual check.
const DEFAULTS = { disk_free_pct: 10, mem_free_pct: 10, cpu_busy_pct: 92, cpu_sample_ms: 500 };


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


function register(scheduler, shareData) {

	scheduler.registerHandler('resource_sentinel', async (job) => {

		const settings = (job && job.settings) || {};

		const th = {
			disk: numOr(settings.disk_free_pct, DEFAULTS.disk_free_pct),
			mem:  numOr(settings.mem_free_pct,  DEFAULTS.mem_free_pct),
			cpu:  numOr(settings.cpu_busy_pct,  DEFAULTS.cpu_busy_pct)
		};
		const diskPath = (typeof settings.disk_path === 'string' && settings.disk_path.trim() !== '') ? settings.disk_path.trim() : APP_ROOT;

		try {

			const [ disk, cpu ] = await Promise.all([ diskInfo(diskPath), cpuBusy(settings.cpu_sample_ms) ]);
			const mem = memInfo(shareData);
			const metrics = { disk, mem, cpu };

			// A threshold of 0 or less disables that individual check.
			const flagged = [];
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

	const thresholds = 'Thresholds: disk ≥ ' + th.disk + '% free, memory ≥ ' + th.mem + '% available, CPU ≤ ' + th.cpu + '% busy (0 = check disabled; memory only alerts where the OS reports true availability).';

	return head + '\n\n' + metricLines(metrics).join('\n') + '\n\n' + thresholds;
}


module.exports = { register };
