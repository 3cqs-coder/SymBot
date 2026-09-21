'use strict';

// Common.renameWithRetry — the Windows-robust half of the atomic config write. On POSIX a rename never
// fails because a reader holds the target open, so it must run exactly once; on Windows the same replace can
// throw a transient lock error, so it retries briefly. These tests pin: POSIX runs once and never retries,
// Windows retries a transient failure and then succeeds, a non-transient error is never retried, and an
// exhausted retry budget re-throws the last error. doRename and sleep are injected, so no real files move.

const assert = require('assert');
const Common = require('../../app/Common.js');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

function errno(code) { const e = new Error(code); e.code = code; return e; }
// A doRename that throws the given code for its first `failTimes` calls, then succeeds. Records call count.
function flaky(failTimes, code) { const s = { calls: 0 }; s.fn = function () { s.calls++; if (s.calls <= failTimes) { throw errno(code); } }; return s; }
function counter() { const s = { calls: 0 }; s.fn = function () { s.calls++; }; return s; }

console.log('\nCommon.renameWithRetry:');

test('POSIX: succeeds on the first try and never sleeps', () => {
	const dr = counter(), sl = counter();
	Common.renameWithRetry(dr.fn, sl.fn, false, 'a', 'b', 5);
	assert.strictEqual(dr.calls, 1);
	assert.strictEqual(sl.calls, 0);
});

test('POSIX: a transient error is NOT retried (rename never fails this way on POSIX)', () => {
	const dr = flaky(1, 'EBUSY'), sl = counter();
	assert.throws(() => Common.renameWithRetry(dr.fn, sl.fn, false, 'a', 'b', 5), /EBUSY/);
	assert.strictEqual(dr.calls, 1);   // one attempt only
	assert.strictEqual(sl.calls, 0);
});

test('Windows: retries a transient lock error, then succeeds', () => {
	const dr = flaky(2, 'EPERM'), sl = counter();
	Common.renameWithRetry(dr.fn, sl.fn, true, 'a', 'b', 5);
	assert.strictEqual(dr.calls, 3);   // 2 failures + 1 success
	assert.strictEqual(sl.calls, 2);   // slept between the failures
});

test('Windows: each transient errno (EPERM/EACCES/EBUSY/EEXIST) is retried', () => {
	for (const code of [ 'EPERM', 'EACCES', 'EBUSY', 'EEXIST' ]) {
		const dr = flaky(1, code), sl = counter();
		Common.renameWithRetry(dr.fn, sl.fn, true, 'a', 'b', 5);
		assert.strictEqual(dr.calls, 2, code + ' should retry once then succeed');
	}
});

test('Windows: a NON-transient error is thrown immediately, without retry', () => {
	const dr = flaky(1, 'ENOENT'), sl = counter();
	assert.throws(() => Common.renameWithRetry(dr.fn, sl.fn, true, 'a', 'b', 5), /ENOENT/);
	assert.strictEqual(dr.calls, 1);
	assert.strictEqual(sl.calls, 0);
});

test('Windows: an exhausted retry budget re-throws the last transient error', () => {
	const dr = flaky(99, 'EBUSY'), sl = counter();
	assert.throws(() => Common.renameWithRetry(dr.fn, sl.fn, true, 'a', 'b', 3), /EBUSY/);
	assert.strictEqual(dr.calls, 3);   // exactly `attempts` tries
	assert.strictEqual(sl.calls, 2);   // slept between, but not after the final failure
});

console.log('\n' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
