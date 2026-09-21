'use strict';

// Unit tests for the pure clock-time parser behind the deterministic time-window log search
// (AIClient.parseClockToken). No model, no timezone state — just the 12h/24h/bare-hour parsing that the
// weak model gets wrong. The wall-clock → UTC conversion itself is DST-correct via Common.tzOffsetMsAt and
// is exercised live; this pins the token parsing that feeds it.

const assert = require('assert');
const AIClient = require('../../ai/AIClient.js');
const parse = AIClient.parseClockToken;

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function eq(a, b, m) { assert.strictEqual(a, b, m); passed++; }

// 12-hour with meridiem
eq(parse('10:43 PM').h, 22, '10:43 PM -> hour 22');
eq(parse('10:43 PM').m, 43, '10:43 PM -> minute 43');
eq(parse('12:00 AM').h, 0, '12:00 AM -> midnight (hour 0)');
eq(parse('12:00 PM').h, 12, '12:00 PM -> noon (hour 12)');
eq(parse('6:25am').h, 6, '6:25am (no space) -> hour 6');
eq(parse('6:25am').m, 25, '6:25am -> minute 25');
eq(parse('6 AM').h, 6, 'bare "6 AM" -> hour 6');
eq(parse('6 AM').m, 0, 'bare "6 AM" -> minute 0');
eq(parse('3 p.m.').h, 15, '"3 p.m." (dotted) -> hour 15');

// 24-hour
eq(parse('22:43').h, 22, '24h 22:43 -> hour 22');
eq(parse('06:05').m, 5, '24h 06:05 -> minute 5');
eq(parse('00:30').h, 0, '24h 00:30 -> hour 0');

// Bare hour: only usable when a meridiem is inheritable (from a sibling token in a range)
eq(parse('6', null), null, 'bare "6" with no inheritable meridiem -> null (ambiguous)');
eq(parse('6', 'am').h, 6, 'bare "6" inheriting am -> hour 6');
eq(parse('6', 'pm').h, 18, 'bare "6" inheriting pm -> hour 18');
eq(parse('7', 'pm').h, 19, 'bare "7" inheriting pm -> hour 19');

// Non-times
eq(parse('the deal'), null, 'non-time text -> null');
eq(parse(''), null, 'empty -> null');

// ── Routing: a time-scoped error query must DEFER to the time-window search, not the day survey ──
const errIntent = AIClient.recentErrorsIntent;
const offs = (q) => { const r = errIntent(q); return r ? r.offsets : null; };
assert.deepStrictEqual(offs('any errors today?'), [ 0 ], '"today" -> offset [0]'); passed++;
assert.deepStrictEqual(offs('what errors over the last 2 days'), [ 0, 1 ], '"last 2 days" -> range [0,1]'); passed++;
eq(errIntent('are there any errors around 5pm?'), null, 'an error query with a clock time defers (null) so the time-window search handles it');
eq(errIntent('any errors between 11am and 8pm?'), null, 'an error query with a time range defers (null)');
eq(errIntent('errors at 22:43?'), null, 'an error query with a 24h clock time defers (null)');
ok(errIntent('anything going wrong lately?'), 'a survey with no clock time is still handled here');

// ── Relative-day parsing (the "two days ago" family) ──
const rel = AIClient.parseRelativeDays;
assert.deepStrictEqual(rel('errors two days ago'), { offsets: [ 2 ], span: 'single' }, '"two days ago" -> that one day (offset 2)'); passed++;
assert.deepStrictEqual(rel('errors 3 days ago'), { offsets: [ 3 ], span: 'single' }, '"3 days ago" -> offset 3'); passed++;
assert.deepStrictEqual(rel('errors the day before yesterday'), { offsets: [ 2 ], span: 'single' }, '"day before yesterday" -> offset 2'); passed++;
assert.deepStrictEqual(rel('errors yesterday'), { offsets: [ 1 ], span: 'single' }, '"yesterday" -> offset 1 (single day, not today+yesterday)'); passed++;
assert.deepStrictEqual(rel('errors yesterday and the day before'), { offsets: [ 1, 2 ], span: 'list' }, '"yesterday and the day before" -> [1,2]'); passed++;
assert.deepStrictEqual(rel('errors last 2 days'), { offsets: [ 0, 1 ], span: 'range' }, '"last 2 days" -> range from today [0,1]'); passed++;
assert.deepStrictEqual(rel('errors in the last few days'), { offsets: [ 0, 1, 2 ], span: 'range' }, '"few days" -> [0,1,2]'); passed++;
assert.deepStrictEqual(rel('any errors today'), { offsets: [ 0 ], span: 'single' }, '"today"/default -> [0]'); passed++;
eq(rel('errors five days ago').offsets[0], 5, 'word number "five days ago" -> offset 5');

// ── Band span parser (how many recent days a time-of-day band covers) ──
const bandDays = AIClient.parseBandDays;
eq(bandDays('errors around 5pm', 3).days, 3, 'no span phrase -> default (3)');
eq(bandDays('errors around 5pm', 3).explicit, false, 'no span phrase -> not explicit');
eq(bandDays('errors around 5pm over the last week', 3).days, 7, '"over the last week" -> 7');
eq(bandDays('errors around 5pm over the last week', 3).explicit, true, 'a named span is explicit');
eq(bandDays('errors around 5pm over the last 5 days', 3).days, 5, '"last 5 days" -> 5');
eq(bandDays('errors between 11am and 8pm past 2 weeks', 3).days, 14, '"past 2 weeks" -> 14');
eq(bandDays('errors around 5pm over the last 90 days', 3).days, 14, 'span is capped at 14 days');

// ── Window half-width parser (± minutes around a moment) ──
const win = AIClient.parseWindowMinutes;
eq(win('errors around 5pm', 30), 30, 'no width phrase -> default');
eq(win('logs within 15 minutes of 5pm', 30), 15, '"within 15 minutes" -> 15');
eq(win('logs within an hour of 5pm', 30), 60, '"within an hour" -> 60');
eq(win('logs within 2 hours of 5pm', 30), 120, '"within 2 hours" -> 120');
eq(win('logs give or take 20 min', 30), 20, '"give or take 20 min" -> 20');
eq(win('logs within 999 hours', 30), 720, 'width is capped at 12 hours (720 min)');

console.log('TimeSearch: ' + passed + ' assertions passed');
