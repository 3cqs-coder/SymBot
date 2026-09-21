'use strict';

// Regression tests for the AI tool period-window helpers. The bug these lock in: small local models
// (e.g. llama3.1:8b) emit the literal STRING "null" for optional parameters they mean to leave blank.
// A naive truthiness check treated "null" as a real value, so "which pair made the most money EVER"
// silently collapsed to a one-day window and returned nothing. argPresent + windowIfNamed must treat
// "null"/""/"undefined"/"none" (and real null/undefined) as ABSENT so an unnamed period means all-time.

const assert = require('assert');
const AITools = require('../../ai/AITools.js');
const Common = require('../../app/Common.js');

// Wire Common so the zoned-day helpers delegate to it (its tz primitives are pure — no shareData needed).
AITools.init({ Common });

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// ── argPresent: the blank-ish values are all "absent" ──
for (const v of [ null, undefined, '', '   ', 'null', 'NULL', ' null ', 'undefined', 'none', 'None', 'nan', 'NaN' ]) {
	ok(AITools.argPresent(v) === false, 'argPresent treats ' + JSON.stringify(v) + ' as absent');
}
// ── argPresent: real values are present ──
for (const v of [ '7', 7, '2026-01-01', 'BTC/USD', 0, '0' ]) {
	ok(AITools.argPresent(v) === true, 'argPresent treats ' + JSON.stringify(v) + ' as present');
}

// ── windowIfNamed: the exact llama payload that caused the empty "best pair" must yield all-time ──
const llamaPayload = { days: 'null', date: 'null', from: 'null', to: 'null', order: 'most_profitable', top: '1' };
ok(AITools.windowIfNamed(llamaPayload) === null, 'all-"null" args → all-time (null window), not a garbage window');

// No period at all → all-time.
ok(AITools.windowIfNamed({ order: 'most_profitable' }) === null, 'no period args → all-time');
ok(AITools.windowIfNamed({}) === null, 'empty args → all-time');
ok(AITools.windowIfNamed(null) === null, 'null args → all-time');

// A REAL period → an actual window.
const w = AITools.windowIfNamed({ days: 30 });
ok(w && w.from instanceof Date && w.to instanceof Date, 'days:30 → a real window');
ok((w.to.getTime() - w.from.getTime()) > 25 * 24 * 3600 * 1000, 'days:30 window spans ~30 days');

// A real single date still windows; the string "null" alongside it is ignored.
const wd = AITools.windowIfNamed({ date: '2026-01-05', days: 'null' });
ok(wd && wd.from instanceof Date, 'a real date still produces a window even with days:"null"');

// orderWindow directly: "null" strings never fabricate a from/to boundary.
const ow = AITools.orderWindow({ from: 'null', to: 'null', date: 'null', days: 'null' });
ok(ow && ow.from instanceof Date && ow.to instanceof Date, 'orderWindow with all-"null" still returns a usable default window');

// A named date is honored EXACTLY — a future or long-ago date must NOT fall back to "today" (which
// would misattribute today's activity to the date the user asked about).
const future = AITools.orderWindow({ date: '2027-01-01' });
ok(future.from.toISOString().slice(0, 10) === '2027-01-01', 'a future date yields THAT day\'s window, not today');
const old = AITools.orderWindow({ date: '2020-01-01' });
ok(old.from.toISOString().slice(0, 10) === '2020-01-01', 'a >2-year-old date yields THAT day\'s window, not today');
const today = new Date().toISOString().slice(0, 10);
ok(future.from.toISOString().slice(0, 10) !== today, 'the future date did not silently become today');

// A reversed from/to range is swapped, not silently emptied.
const rev = AITools.orderWindow({ from: '2026-08-15', to: '2026-08-10' });
ok(rev.from.getTime() <= rev.to.getTime(), 'a reversed range is swapped so from <= to');
ok(rev.from.toISOString().slice(0, 10) === '2026-08-10' && rev.to.toISOString().slice(0, 10) === '2026-08-15', 'the swapped range covers the span the user meant');

// ── Timezone-aware windows: a named day means the USER's calendar day, not a fixed UTC instant ──
// With no _tz the default is UTC (deterministic for the curl/API path).
ok(AITools.orderWindow({ date: '2026-08-18' }).from.toISOString() === '2026-08-18T00:00:00.000Z', 'no tz → UTC day start');
ok(AITools.orderWindow({ date: '2026-08-18', _tz: 'UTC' }).from.toISOString() === '2026-08-18T00:00:00.000Z', 'tz=UTC → 00:00Z');
// America/New_York in August is EDT (UTC-4): local midnight = 04:00Z, end = next-day 03:59:59Z.
const ny = AITools.orderWindow({ date: '2026-08-18', _tz: 'America/New_York' });
ok(ny.from.toISOString() === '2026-08-18T04:00:00.000Z', 'NY summer day starts at 04:00Z (EDT)');
ok(ny.to.toISOString() === '2026-08-19T03:59:59.999Z', 'NY summer day ends at next-day 03:59:59Z');
// A winter date is EST (UTC-5) — proves DST-awareness, not a fixed offset.
ok(AITools.orderWindow({ date: '2026-01-15', _tz: 'America/New_York' }).from.toISOString() === '2026-01-15T05:00:00.000Z', 'NY winter day starts at 05:00Z (EST) — DST-correct');
// A from/to range is interpreted in the user's zone on both ends.
const nyRange = AITools.orderWindow({ from: '2026-08-10', to: '2026-08-12', _tz: 'America/New_York' });
ok(nyRange.from.toISOString() === '2026-08-10T04:00:00.000Z' && nyRange.to.toISOString() === '2026-08-13T03:59:59.999Z', 'NY from/to range spans local days');
// A bogus/absent tz falls back to UTC, never throwing.
ok(AITools.orderWindow({ date: '2026-08-18', _tz: 'Not/AZone' }).from.toISOString() === '2026-08-18T00:00:00.000Z', 'invalid tz falls back to UTC');

console.log('ToolWindow: ' + passed + ' assertions passed');
