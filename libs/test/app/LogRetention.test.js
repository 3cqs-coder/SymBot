'use strict';

// Tests the manifest-based log retention wired into Common.retainLogs(): logs are pruned by their DATE
// (not filesystem mtime), today's actively-written log is always safe, and the Hub process (sharing the
// flat logs/ folder) only ever prunes its own "<date>-hub.log". Uses the dirOverride testability seam so it
// runs against a temp directory instead of the real per-instance logs dir.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Common = require('../../app/Common.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'symbot-logret-'));
function ymd(offsetDays) { return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10); }
function mklog(dir, name, mtimeMs) {
	const p = path.join(dir, name);
	fs.writeFileSync(p, 'line\n');
	if (mtimeMs) { const t = mtimeMs / 1000; fs.utimesSync(p, t, t); }
	return name;
}

try {
	// ── Per-instance worker: prune by date, keep recent + today, ignore non-logs ──
	Common.init({ appData: { server_id: 's1', worker_data: { name: 'NE', name_display: 'NE' } } });
	const d1 = path.join(TMP, 'inst'); fs.mkdirSync(d1, { recursive: true });
	const oldLog   = mklog(d1, ymd(-30) + '-NE.log');
	const oldDash  = mklog(d1, ymd(-30) + '-.log');    // trailing-dash edge (a name quirk) — must still prune
	const recent   = mklog(d1, ymd(-2)  + '-NE.log');
	const today    = mklog(d1, ymd(0)   + '-NE.log');
	const staleFresh = mklog(d1, ymd(-40) + '-NE.log', Date.now());   // old DATE, but mtime = NOW
	const notLog   = mklog(d1, 'notes.txt');

	Common.retainLogs(10, d1);

	const left = new Set(fs.readdirSync(d1));
	ok(!left.has(oldLog), '30-day-old log pruned');
	ok(!left.has(oldDash), 'a "<date>-.log" (trailing-dash) old log is tracked and pruned too (no log escapes cleanup)');
	ok(!left.has(staleFresh), '40-day-old log pruned by its DATE despite a fresh mtime (mtime bug fixed)');
	ok(left.has(recent), '2-day-old log kept');
	ok(left.has(today), "today's actively-written log is always safe");
	ok(left.has(notLog), 'a non-log file is untouched');
	// The manifest reflects the surviving logs.
	const ArtifactIndex = require('../../app/ArtifactIndex.js');
	const m = ArtifactIndex.load(d1, 'logs');
	ok(m.entries.every(e => fs.existsSync(path.join(d1, e.file))) && m.entries.length === 2, 'manifest matches survivors');

	// ── Hub process: shares the flat logs folder, must prune ONLY its own <date>-hub.log ──
	Common.init({ appData: { hub_config: 'hub.json', server_id: 'hub', worker_data: { name: 'hub' } } });
	const d2 = path.join(TMP, 'hub'); fs.mkdirSync(d2, { recursive: true });
	const hubOld  = mklog(d2, ymd(-30) + '-hub.log');
	const instLeftover = mklog(d2, ymd(-30) + '-NE.log');   // a not-yet-migrated instance log sitting in the flat dir
	Common.retainLogs(10, d2);
	const left2 = new Set(fs.readdirSync(d2));
	ok(!left2.has(hubOld), 'Hub prunes its own old hub log');
	ok(left2.has(instLeftover), "Hub NEVER prunes another instance's log sharing the flat folder");

	// ── maxDays < 1 disables age pruning (never wipes everything on a mis-read config) ──
	const d3 = path.join(TMP, 'guard'); fs.mkdirSync(d3, { recursive: true });
	mklog(d3, ymd(-100) + '-NE.log');
	Common.init({ appData: { server_id: 's1', worker_data: { name: 'NE' } } });
	Common.retainLogs(0, d3);
	ok(fs.readdirSync(d3).some(f => f.endsWith('.log')), 'maxDays<=0 disables pruning (safety)');

	console.log('LogRetention: ' + passed + ' assertions passed');
}
catch (e) { console.error('LogRetention FAIL: ' + (e && e.stack || e)); process.exitCode = 1; }
finally { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} }

process.exit(process.exitCode ? 1 : 0);
