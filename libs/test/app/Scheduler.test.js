'use strict';

// Unit tests for the central Scheduler core (libs/app/Scheduler.js).
//
// These cover the parts that need no database connection: the validate() logic and
// the arming engine exercised through system jobs (registerSystemJob / unregister).
// The database-backed user-job CRUD (add/update/remove/list/runNow) is covered by
// live testing against a running instance, since it requires Mongo.

const assert = require('assert');
const Scheduler = require('../../app/Scheduler.js');

let passed = 0;
let failed = 0;

function test(name, fn) {

	try { fn(); console.log('  ✓ ' + name); passed++; }
	catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); failed++; }
}

const soon = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();   // 1h out
const past = () => new Date(Date.now() - 60 * 1000).toISOString();        // 1m ago
const tooFar = () => new Date(Date.now() + 61 * 24 * 60 * 60 * 1000).toISOString(); // 61 days

console.log('\nvalidate() — kind + payload:');

test('rejects an unknown kind', () => {
	assert.strictEqual(Scheduler.validate({ kind: 'weekly', prompt: 'x' }).ok, false);
});

test('rejects a missing/blank prompt', () => {
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '0 8 * * *', prompt: '   ' }).ok, false);
});

test('rejects an over-long prompt', () => {
	const long = 'a'.repeat(2001);
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '0 8 * * *', prompt: long }).ok, false);
});

console.log('\nvalidate() — cron:');

test('accepts a valid 5-field cron and defaults type to ai_analysis', () => {
	const v = Scheduler.validate({ kind: 'cron', cron: '30 13 * * 1,5', prompt: 'summary' });
	assert.strictEqual(v.ok, true);
	assert.strictEqual(v.doc.cron, '30 13 * * 1,5');
	assert.strictEqual(v.doc.type, 'ai_analysis');
	assert.strictEqual(v.doc.run_at, null);
});

test('rejects an invalid cron expression', () => {
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: 'not a cron', prompt: 'x' }).ok, false);
});

test('accepts valid 5-field crons with steps/ranges/lists', () => {
	[ '*/30 * * * *', '0 9-17 * * 1-5', '0,30 8 * * *', '15 3 1 * *' ].forEach(c => {
		assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: c, prompt: 'x' }).ok, true, c);
	});
});

test('rejects a 6-field (seconds) cron and named tokens — the 5-field UTC contract', () => {
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '*/30 * * * * *', prompt: 'x' }).ok, false, '6-field seconds');
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '0 8 * * MON', prompt: 'x' }).ok, false, 'named day');
});

test('cronOccurrences de-duplicates a DST fall-back slot (fires the make-up once, not twice)', () => {
	// America/New_York fall-back 2024-11-03: local 01:30 occurs at 05:30 UTC (EDT) AND 06:30 UTC (EST).
	const from = Date.UTC(2024, 10, 3, 4, 0);
	const to   = Date.UTC(2024, 10, 3, 8, 0);
	const occ = Scheduler.cronOccurrences('30 1 * * *', 'America/New_York', from, to, 10);
	assert.strictEqual(occ.length, 1, 'one occurrence for the repeated local 01:30, got ' + occ.length);
});

console.log('\nvalidate() — once:');

test('accepts a future run_at', () => {
	assert.strictEqual(Scheduler.validate({ kind: 'once', run_at: soon(), prompt: 'x' }).ok, true);
});

test('rejects a past run_at', () => {
	assert.strictEqual(Scheduler.validate({ kind: 'once', run_at: past(), prompt: 'x' }).ok, false);
});

test('rejects a run_at beyond 60 days', () => {
	assert.strictEqual(Scheduler.validate({ kind: 'once', run_at: tooFar(), prompt: 'x' }).ok, false);
});

test('rejects an unparseable run_at', () => {
	assert.strictEqual(Scheduler.validate({ kind: 'once', run_at: 'whenever', prompt: 'x' }).ok, false);
});

// ── allowPastOnce: the edit-that-doesn't-move-run_at exemption ──────────────────────────────────────
// A brand-new one-off with a past time is nonsense and stays rejected (the default above). But EDITING an
// existing one-off — relabel it, change its notification targets, tweak retries — must not fail just
// because its run_at is now in the past (it may already have fired, or be mid-window). update() detects
// "run_at unchanged" and passes allowPastOnce:true so those edits go through; a real reschedule (run_at
// changed) drops the flag and is re-validated as future. These pin that primitive so the edit path and
// the re-enable guard that sit on top of it can't silently regress.
console.log('\nvalidate() — allowPastOnce (edit without moving run_at):');

test('a past run_at is ACCEPTED when allowPastOnce is set (editing a fired/at-time one-off)', () => {
	assert.strictEqual(Scheduler.validate({ kind: 'once', run_at: past(), prompt: 'x' }, { allowPastOnce: true }).ok, true);
});

test('allowPastOnce:false is identical to the default (a past run_at is still rejected)', () => {
	assert.strictEqual(Scheduler.validate({ kind: 'once', run_at: past(), prompt: 'x' }, { allowPastOnce: false }).ok, false);
});

test('allowPastOnce does NOT loosen the other once rules (60-day cap, unparseable still rejected)', () => {
	assert.strictEqual(Scheduler.validate({ kind: 'once', run_at: tooFar(), prompt: 'x' }, { allowPastOnce: true }).ok, false, 'beyond-60-days still rejected');
	assert.strictEqual(Scheduler.validate({ kind: 'once', run_at: 'whenever', prompt: 'x' }, { allowPastOnce: true }).ok, false, 'unparseable still rejected');
});

console.log('\nsystem jobs — registry + arming engine:');

test('a system job with no task function is refused', () => {
	const r = Scheduler.registerSystemJob({ name: 'test_notask', kind: 'cron', cron: '0 0 * * *', enabled: true });
	assert.strictEqual(r.success, false);
});

test('a disabled system job registers without arming (task never runs)', () => {
	let ran = false;
	const r = Scheduler.registerSystemJob({ name: 'test_disabled', kind: 'cron', cron: '* * * * *', enabled: false, task: () => { ran = true; } });
	assert.strictEqual(r.success, true);
	assert.strictEqual(ran, false);
	Scheduler.unregisterSystemJob('test_disabled');
});

// ── validate(): catch-up policy + timezone ──
console.log('\nvalidate() — catchup + timezone:');

test('catchup defaults to skip and accepts once/all', () => {
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '0 9 * * *', prompt: 'x' }).doc.catchup, 'skip');
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '0 9 * * *', prompt: 'x', catchup: 'once' }).doc.catchup, 'once');
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '0 9 * * *', prompt: 'x', catchup: 'bogus' }).doc.catchup, 'skip');
});
test('validate stamps the current schema_version', () => {
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '0 9 * * *', prompt: 'x' }).doc.schema_version, 5);
});
test('concurrency defaults to forbid and accepts allow', () => {
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '0 9 * * *', prompt: 'x' }).doc.concurrency, 'forbid');
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '0 9 * * *', prompt: 'x', concurrency: 'allow' }).doc.concurrency, 'allow');
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '0 9 * * *', prompt: 'x', concurrency: 'replace' }).doc.concurrency, 'forbid');
});
test('retries are clamped to the cap and default to 0', () => {
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '0 9 * * *', prompt: 'x' }).doc.retries, 0);
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '0 9 * * *', prompt: 'x', retries: 3 }).doc.retries, 3);
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '0 9 * * *', prompt: 'x', retries: 99 }).doc.retries, Scheduler.MAX_RETRIES);
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '0 9 * * *', prompt: 'x', retries: -5 }).doc.retries, 0);
});
test('retry backoff grows only when exponential', () => {
	assert.strictEqual(Scheduler.resolveRetries({ retries: 2 }), 2);
	const fixed = { retry_backoff: 'fixed', retry_delay_ms: 1000 };
	assert.strictEqual(Scheduler.retryDelay(fixed, 1), 1000);
	assert.strictEqual(Scheduler.retryDelay(fixed, 3), 1000);
	const exp = { retry_backoff: 'exponential', retry_delay_ms: 1000 };
	assert.strictEqual(Scheduler.retryDelay(exp, 1), 1000);
	assert.strictEqual(Scheduler.retryDelay(exp, 2), 2000);
	assert.strictEqual(Scheduler.retryDelay(exp, 3), 4000);
});
test('a valid timezone is kept, an unknown one is rejected', () => {
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '0 9 * * *', prompt: 'x', timezone: 'America/New_York' }).doc.timezone, 'America/New_York');
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '0 9 * * *', prompt: 'x', timezone: 'Not/AZone' }).ok, false);
	assert.strictEqual(Scheduler.validate({ kind: 'cron', cron: '0 9 * * *', prompt: 'x' }).doc.timezone, '');
});

// ── cron occurrence engine ──
console.log('\ncron engine — occurrences (UTC + DST):');

const _D = 86400000, _H = 3600000;
const _base = Date.UTC(2026, 0, 1, 0, 0); // 2026-01-01 00:00 UTC (Thursday)

test('hourly cron yields one occurrence per hour', () => {
	assert.strictEqual(Scheduler.cronOccurrences('0 * * * *', 'UTC', _base, _base + 3 * _H + 30 * 60000, 100).length, 3);
});
test('daily cron yields one per day', () => {
	assert.strictEqual(Scheduler.cronOccurrences('30 9 * * *', 'UTC', _base, _base + 3 * _D, 100).length, 3);
});
test('day-of-week cron matches only that weekday', () => {
	const occ = Scheduler.cronOccurrences('0 12 * * 1', 'UTC', _base, _base + 7 * _D, 100); // Mondays
	assert.strictEqual(occ.length, 1);
	assert.strictEqual(new Date(occ[0]).getUTCDay(), 1);
});
test('limit and the invalid-expression guard hold', () => {
	assert.strictEqual(Scheduler.cronOccurrences('*/1 * * * *', 'UTC', _base, _base + _D, 5).length, 5); // capped
	assert.strictEqual(Scheduler.parseCron('nonsense'), null);
	assert.strictEqual(Scheduler.cronOccurrences('nonsense', 'UTC', _base, _base + _D, 5).length, 0);
});
test('DST: a 9am local cron stays 9am local across the spring-forward', () => {
	const from = Date.UTC(2026, 2, 7, 0, 0); // Mar 7 2026, around US DST change (Mar 8)
	const occ = Scheduler.cronOccurrences('0 9 * * *', 'America/New_York', from, from + 3 * _D, 10);
	const fmt = (t) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
	occ.forEach((t) => assert.strictEqual(fmt(t), '09:00'));   // local time constant despite the UTC offset shift
	assert.strictEqual(occ.length, 3);
});

// ── planCatchup: missed-run policy ──
console.log('\ncatch-up — planCatchup:');

const _now = Date.UTC(2026, 0, 8, 12, 0);

test('cron all makes up every missed occurrence', () => {
	const p = Scheduler.planCatchup({ kind: 'cron', cron: '0 9 * * *', catchup: 'all', last_run: new Date(_now - 3 * _D) }, _now);
	assert.strictEqual(p.action, 'fire'); assert.strictEqual(p.count, 3);
});
test('cron once collapses many misses to a single make-up', () => {
	const p = Scheduler.planCatchup({ kind: 'cron', cron: '0 9 * * *', catchup: 'once', last_run: new Date(_now - 3 * _D) }, _now);
	assert.strictEqual(p.count, 1);
});
test('cron skip makes up nothing', () => {
	assert.strictEqual(Scheduler.planCatchup({ kind: 'cron', cron: '0 9 * * *', catchup: 'skip', last_run: new Date(_now - 3 * _D) }, _now).action, 'none');
});
test('cron all is bounded by the lookback window', () => {
	const p = Scheduler.planCatchup({ kind: 'cron', cron: '0 9 * * *', catchup: 'all', last_run: new Date(_now - 30 * _D) }, _now);
	assert.ok(p.count <= 7 + 1);   // 7-day lookback, not 30 days of misses
});
test('a past one-off: skip disables-missed, once/all makes up once', () => {
	assert.strictEqual(Scheduler.planCatchup({ kind: 'once', run_at: new Date(_now - _D), catchup: 'skip' }, _now).action, 'disable_missed');
	assert.strictEqual(Scheduler.planCatchup({ kind: 'once', run_at: new Date(_now - _D), catchup: 'once' }, _now).action, 'fire');
});
test('a future one-off needs no catch-up', () => {
	assert.strictEqual(Scheduler.planCatchup({ kind: 'once', run_at: new Date(_now + _D), catchup: 'once' }, _now).action, 'none');
});

// Crash-safety: runUserJob CLAIMS last_run (writes it to the fire time) BEFORE running the handler, so an
// occurrence that already fired is never re-run on the next boot — even if the process was killed after the
// handler's side-effect but before the run was recorded. These pin the property the claim relies on: once
// last_run is at/after the latest occurrence, planCatchup makes up nothing; it only makes up occurrences
// that are genuinely newer than the claimed last_run.
test('a just-claimed last_run (>= the latest occurrence) re-fires nothing — no double run after a crash', () => {
	// Today's 09:00 occurrence already fired and was claimed at 09:00:01; catch-up at noon must NOT re-fire it.
	const claimed = new Date(Date.UTC(2026, 0, 8, 9, 0, 1));
	assert.strictEqual(Scheduler.planCatchup({ kind: 'cron', cron: '0 9 * * *', catchup: 'all', last_run: claimed }, _now).action, 'none');
	assert.strictEqual(Scheduler.planCatchup({ kind: 'cron', cron: '0 9 * * *', catchup: 'once', last_run: claimed }, _now).action, 'none');
});
test('catch-up still makes up an occurrence that is genuinely newer than the claimed last_run', () => {
	// last_run claimed yesterday → today's 09:00 occurrence is a real miss and is made up exactly once.
	const p = Scheduler.planCatchup({ kind: 'cron', cron: '0 9 * * *', catchup: 'all', last_run: new Date(_now - _D) }, _now);
	assert.strictEqual(p.action, 'fire'); assert.strictEqual(p.count, 1);
});

// Async section: the once arming engine actually fires, and unregister cancels it.
(async () => {

	await new Promise((resolve) => {

		let fired = false;
		Scheduler.registerSystemJob({
			name: 'test_once_fire',
			kind: 'once',
			run_at: new Date(Date.now() + 150).toISOString(),
			enabled: true,
			task: () => { fired = true; }
		});

		setTimeout(() => {
			test('a once system job fires its task at the scheduled time', () => { assert.strictEqual(fired, true); });
			Scheduler.unregisterSystemJob('test_once_fire');
			resolve();
		}, 400);
	});

	await new Promise((resolve) => {

		let fired = false;
		Scheduler.registerSystemJob({
			name: 'test_once_cancel',
			kind: 'once',
			run_at: new Date(Date.now() + 150).toISOString(),
			enabled: true,
			task: () => { fired = true; }
		});
		Scheduler.unregisterSystemJob('test_once_cancel');   // cancel before it fires

		setTimeout(() => {
			test('unregister cancels a pending once job (task never runs)', () => { assert.strictEqual(fired, false); });
			resolve();
		}, 400);
	});

	// ── run robustness: timeout + retention classification (no DB) ──
	console.log('\nrun robustness — timeout / retention:');

	test('resolveTimeout defaults when there is no override', () => {
		assert.strictEqual(Scheduler.resolveTimeout({}), Scheduler.RUN_TIMEOUT_DEFAULT_MS);
		assert.strictEqual(Scheduler.resolveTimeout({ settings: {} }), Scheduler.RUN_TIMEOUT_DEFAULT_MS);
		assert.strictEqual(Scheduler.resolveTimeout(null), Scheduler.RUN_TIMEOUT_DEFAULT_MS);
	});
	test('resolveTimeout uses a positive settings.timeout_ms override', () => {
		assert.strictEqual(Scheduler.resolveTimeout({ settings: { timeout_ms: 5000 } }), 5000);
	});
	test('resolveTimeout ignores an invalid/negative override', () => {
		assert.strictEqual(Scheduler.resolveTimeout({ settings: { timeout_ms: -1 } }), Scheduler.RUN_TIMEOUT_DEFAULT_MS);
		assert.strictEqual(Scheduler.resolveTimeout({ settings: { timeout_ms: 'abc' } }), Scheduler.RUN_TIMEOUT_DEFAULT_MS);
	});
	test('isFailureStatus: error/timed_out are failures, ok/skipped are not', () => {
		assert.strictEqual(Scheduler.isFailureStatus('error'), true);
		assert.strictEqual(Scheduler.isFailureStatus('timed_out'), true);
		assert.strictEqual(Scheduler.isFailureStatus('ok'), false);
		assert.strictEqual(Scheduler.isFailureStatus('skipped'), false);
	});

	// Scheduler.withTimeout is now a thin wrapper over the shared Common.withTimeout (passing
	// { timedOut: true } so a timed-out run is distinguishable from a genuine error). The timeout behavior —
	// resolve-on-win, reject-on-timeout, and the err.timedOut tag — is covered directly in WithTimeout.test.js,
	// so it is not re-tested here against the trivial delegation.

	console.log('\nschedule heartbeat — evaluateHeartbeat:');

	const nowMs = Date.now();
	const future = nowMs + 3600 * 1000;
	const gone = nowMs - 3600 * 1000;

	test('an enabled cron that is armed is NOT flagged', () => {
		const out = Scheduler.evaluateHeartbeat([ { schedule_id: 'a', kind: 'cron', enabled: true } ], new Set([ 'a' ]), nowMs);
		assert.strictEqual(out.length, 0);
	});
	test('an enabled cron that is NOT armed is flagged (silent failure)', () => {
		const out = Scheduler.evaluateHeartbeat([ { schedule_id: 'a', label: 'Nightly', kind: 'cron', enabled: true } ], new Set(), nowMs);
		assert.strictEqual(out.length, 1);
		assert.ok(/Nightly/.test(out[0]) && /not armed/.test(out[0]));
	});
	test('a DISABLED cron that is not armed is NOT flagged (disabled is intentional)', () => {
		const out = Scheduler.evaluateHeartbeat([ { schedule_id: 'a', kind: 'cron', enabled: false } ], new Set(), nowMs);
		assert.strictEqual(out.length, 0);
	});
	test('a FUTURE one-shot that is not armed is flagged', () => {
		const out = Scheduler.evaluateHeartbeat([ { schedule_id: 'b', kind: 'once', enabled: true, run_at: new Date(future).toISOString() } ], new Set(), nowMs);
		assert.strictEqual(out.length, 1);
		assert.ok(/one-shot/.test(out[0]));
	});
	test('a future one-shot that IS armed is not flagged', () => {
		const out = Scheduler.evaluateHeartbeat([ { schedule_id: 'b', kind: 'once', enabled: true, run_at: new Date(future).toISOString() } ], new Set([ 'b' ]), nowMs);
		assert.strictEqual(out.length, 0);
	});
	test('a PAST one-shot that is not armed is NOT flagged (already ran or was made up)', () => {
		const out = Scheduler.evaluateHeartbeat([ { schedule_id: 'b', kind: 'once', enabled: true, run_at: new Date(gone).toISOString() } ], new Set(), nowMs);
		assert.strictEqual(out.length, 0);
	});
	test('mixed set: only the unarmed enabled cron is reported', () => {
		const rows = [
			{ schedule_id: 'ok',  kind: 'cron', enabled: true },
			{ schedule_id: 'bad', label: 'Broken', kind: 'cron', enabled: true },
			{ schedule_id: 'off', kind: 'cron', enabled: false }
		];
		const out = Scheduler.evaluateHeartbeat(rows, new Set([ 'ok' ]), nowMs);
		assert.strictEqual(out.length, 1);
		assert.ok(/Broken/.test(out[0]));
	});
	test('empty / nullish inputs never throw', () => {
		assert.strictEqual(Scheduler.evaluateHeartbeat(null, null, nowMs).length, 0);
		assert.strictEqual(Scheduler.evaluateHeartbeat([], undefined, nowMs).length, 0);
	});

	console.log('\nbackup health — evaluateBackupHealth:');

	test('no enabled backup schedule (null row) → no finding', () => {
		assert.strictEqual(Scheduler.evaluateBackupHealth(null), null);
		assert.strictEqual(Scheduler.evaluateBackupHealth(undefined), null);
	});
	test('backup with a clean last run (no consecutive failures) → no finding', () => {
		assert.strictEqual(Scheduler.evaluateBackupHealth({ consecutive_failures: 0 }), null);
		assert.strictEqual(Scheduler.evaluateBackupHealth({}), null);   // field absent counts as zero
	});
	test('backup that failed its last run → finding names the streak', () => {
		const f = Scheduler.evaluateBackupHealth({ consecutive_failures: 1 });
		assert.ok(f && f.action === 'watchdog.backup_last_run_failed');
		assert.strictEqual(f.target, '1');
		assert.ok(/failed its last 1 run/.test(f.detail));
	});
	test('a sustained failure streak is reported with its count', () => {
		const f = Scheduler.evaluateBackupHealth({ consecutive_failures: 4 });
		assert.ok(f && f.target === '4' && /last 4 run/.test(f.detail));
	});
	test('a successful run since (e.g. a manual Run now) clears it even while the scheduled counter stands', () => {
		// A manual "Run now" does not reset consecutive_failures, but last_status becomes 'ok' — the backup
		// is working again, so the warning must clear rather than nag until the next scheduled run.
		assert.strictEqual(Scheduler.evaluateBackupHealth({ consecutive_failures: 2, last_status: 'ok' }), null);
		// A still-failing last run keeps the finding.
		assert.ok(Scheduler.evaluateBackupHealth({ consecutive_failures: 2, last_status: 'error' }));
	});

	console.log('\noff-site backup health — evaluateOffsiteBackupHealth:');

	const withSftp = (extra) => Object.assign({ settings: { sftp: { enabled: true, host: 'h' } } }, extra);

	test('no enabled backup schedule (null row) → no finding', () => {
		assert.strictEqual(Scheduler.evaluateOffsiteBackupHealth(null), null);
	});
	test('off-site not configured (no sftp / disabled / no host) → no finding, even with failures', () => {
		assert.strictEqual(Scheduler.evaluateOffsiteBackupHealth({ offsite_consecutive_failures: 3 }), null);
		assert.strictEqual(Scheduler.evaluateOffsiteBackupHealth({ settings: { sftp: { enabled: false, host: 'h' } }, offsite_consecutive_failures: 3 }), null);
		assert.strictEqual(Scheduler.evaluateOffsiteBackupHealth({ settings: { sftp: { enabled: true } }, offsite_consecutive_failures: 3 }), null);
	});
	test('off-site configured, uploads clean → no finding', () => {
		assert.strictEqual(Scheduler.evaluateOffsiteBackupHealth(withSftp({ offsite_consecutive_failures: 0 })), null);
		assert.strictEqual(Scheduler.evaluateOffsiteBackupHealth(withSftp({})), null);   // field absent counts as zero
	});
	test('off-site configured and last upload(s) failed → finding names the streak', () => {
		const f = Scheduler.evaluateOffsiteBackupHealth(withSftp({ offsite_consecutive_failures: 2 }));
		assert.ok(f && f.action === 'watchdog.offsite_backup_last_upload_failed');
		assert.strictEqual(f.target, '2');
		assert.ok(/last 2 time/.test(f.detail) && /off-site/.test(f.detail));
	});

	console.log('\n' + passed + ' checks passed' + (failed ? ', ' + failed + ' failed' : ''));
	process.exit(failed ? 1 : 0);
})();
