'use strict';

// Tests the consecutive-failure counter + escalation-emit decision (pure helpers).

const assert = require('assert');
const Scheduler = require('../../app/Scheduler.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

const next = Scheduler.nextConsecutiveFailures;
const emit = Scheduler.shouldEmitEscalation;

// counter transitions
ok(next(0, 'error') === 1, 'error increments from 0');
ok(next(2, 'timed_out') === 3, 'timed_out increments');
ok(next(5, 'ok') === 0, 'success resets to 0');
ok(next(3, 'missed') === 3, 'missed leaves the counter unchanged');
ok(next(3, 'skipped') === 3, 'skipped leaves the counter unchanged');
ok(next(undefined, 'error') === 1, 'undefined prior treated as 0');

// escalation emit at threshold and every-threshold thereafter (default 3)
ok(emit(1, 3) === false, '1 failure < threshold: no escalation');
ok(emit(2, 3) === false, '2 failures: no escalation');
ok(emit(3, 3) === true, 'exactly at threshold: escalate');
ok(emit(4, 3) === false, 'between multiples: no repeat');
ok(emit(6, 3) === true, 'next multiple: escalate again');
ok(emit(9, 3) === true, 'and again at 9');

// threshold floor (never below 2)
ok(emit(2, 1) === true, 'threshold clamps up to 2');

console.log('ScheduleEscalation: ' + passed + ' assertions passed');
