'use strict';

// Tests LogScan.logFilesForDates — how the log reader resolves which files to scan for a set of dates by
// SCANNING the directory (no "<date>-<name>.log" reconstruction). The property under test is the date-budget
// semantics: `maxFiles` bounds how many DISTINCT DATES are covered (its callers derive it from a date count),
// and a covered date always contributes ALL of its files, so a day that has two logs after an instance rename
// (a bare "<date>.log" plus a legacy "<date>-<name>.log") is never split into a partial day just to hit the
// cap. Runs against a synthetic logs directory; no model, no network.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LogScan = require('../../queries/LogScan.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'logfiles-'));
const LOGS = path.join(TMP, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

// Common is not wired, so getLogDir() falls back to <path_root>/logs and isLogFile() falls back to the
// local shape regex — exactly the standalone path this helper must also work on.
LogScan.init({ appData: { path_root: TMP } });

// Aug 12 has TWO files (the rename case); Aug 11 and Aug 10 have one each. A stray non-log and the manifest
// must be ignored.
fs.writeFileSync(path.join(LOGS, '2026-08-12.log'), 'a');
fs.writeFileSync(path.join(LOGS, '2026-08-12-oldname.log'), 'b');   // same DAY, legacy naming after a rename
fs.writeFileSync(path.join(LOGS, '2026-08-11.log'), 'c');
fs.writeFileSync(path.join(LOGS, '2026-08-10.log'), 'd');
fs.writeFileSync(path.join(LOGS, 'notes.txt'), 'x');
fs.writeFileSync(path.join(LOGS, '.index.json'), '{}');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

function distinctDates(files) {
	return new Set(files.map(f => f.slice(0, 10))).size;
}

try {
	// A day with two logs is returned WHOLE — both files, never a partial day — even though that is 2 files
	// for a 1-date budget. The cap counts dates, not files.
	const one = LogFiles([ '2026-08-12' ], 1);
	ok(one.length === 2 && one.indexOf('2026-08-12.log') >= 0 && one.indexOf('2026-08-12-oldname.log') >= 0, 'both files for a single dual-log day are returned (day never split)');
	ok(distinctDates(one) === 1, 'still only one distinct date covered');

	// Budget of 2 distinct dates over three requested → covers the two newest dates, all their files, and
	// stops before the third. Aug 12 (2 files) + Aug 11 (1 file) = 3 files across 2 dates; Aug 10 excluded.
	const two = LogFiles([ '2026-08-12', '2026-08-11', '2026-08-10' ], 2);
	ok(distinctDates(two) === 2, 'exactly the date budget (2) worth of distinct dates');
	ok(two.length === 3, 'all files for both covered dates (2 for Aug 12 + 1 for Aug 11)');
	ok(two.indexOf('2026-08-10.log') === -1, 'the date beyond the budget is excluded');

	// A generous budget returns everything, de-duped, and never the non-log or the manifest.
	const all = LogFiles([ '2026-08-12', '2026-08-11', '2026-08-10' ], 10);
	ok(all.length === 4, 'all four real logs returned when the budget is generous');
	ok(all.indexOf('notes.txt') === -1 && all.indexOf('.index.json') === -1, 'non-log files and the manifest are never returned');

	// A date with no file simply contributes nothing and does not consume budget.
	const gap = LogFiles([ '2099-01-01', '2026-08-11' ], 1);
	ok(gap.length === 1 && gap[0] === '2026-08-11.log', 'an empty date is skipped and the budget is spent on the date that has a log');

	console.log('LogFilesForDates: ' + passed + ' assertions passed');
}
catch (e) { console.error('LogFilesForDates FAIL: ' + (e && e.stack || e)); process.exitCode = 1; }
finally { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} }

function LogFiles(dates, maxFiles) { return LogScan.logFilesForDates(dates, maxFiles); }

process.exit(process.exitCode ? 1 : 0);
