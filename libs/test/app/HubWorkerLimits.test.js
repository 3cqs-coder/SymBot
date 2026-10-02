'use strict';

// Two Hub supervisor additions:
//   - resolveWorkerMaxOldGenMb: the OPT-IN per-instance V8 heap cap. Because Hub instances run as worker_threads
//     that share one process, one instance's heap OOM aborts the WHOLE Hub (every instance's trading loop) unless
//     that worker was spawned with a resourceLimits cap. This resolver picks the cap: a per-instance value wins
//     over the Hub-global, values below a 256 MB floor are ignored (so a mistyped tiny cap can't instantly kill
//     every worker), and unset → null (no cap, the default — nothing changes unless the operator opts in).
//   - markStarted / getHubStartedAt: the Hub start-time marker the liveness watchdog uses for its startup grace.
//     It must be idempotent (the first mark wins) so an explicit early mark in startHub is not overwritten later.
//
// process.exit(0) at the end: requiring Main.js pulls in modules that may register timers.

const assert = require('assert');
const HubMain = require('../../app/Hub/Main.js');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

console.log('\nHub worker heap cap + startup marker:');

const r = HubMain.resolveWorkerMaxOldGenMb;

test('unset → null (no cap; default behavior is unchanged)', () => {
	assert.strictEqual(r({}, {}), null);
	assert.strictEqual(r(null, null), null);
});

test('a per-instance cap is honored', () => {
	assert.strictEqual(r({ max_old_gen_mb: 1024 }, {}), 1024);
});

test('the Hub-global cap is honored when no per-instance value is set', () => {
	assert.strictEqual(r({}, { instance_max_old_gen_mb: 768 }), 768);
});

test('a per-instance cap overrides the Hub-global', () => {
	assert.strictEqual(r({ max_old_gen_mb: 2048 }, { instance_max_old_gen_mb: 768 }), 2048);
});

test('a value below the 256 MB floor is ignored (treated as no cap — a foot-gun guard)', () => {
	assert.strictEqual(r({ max_old_gen_mb: 64 }, {}), null);
	assert.strictEqual(r({}, { instance_max_old_gen_mb: 100 }), null);
});

test('a non-numeric value is ignored (no cap, no throw)', () => {
	assert.strictEqual(r({ max_old_gen_mb: 'big' }, {}), null);
	assert.strictEqual(r({ max_old_gen_mb: null }, { instance_max_old_gen_mb: undefined }), null);
});

test('a fractional value is floored to an integer MB', () => {
	assert.strictEqual(r({ max_old_gen_mb: 512.9 }, {}), 512);
});

test('markStarted sets a positive start time and is idempotent (first mark wins)', () => {
	assert.strictEqual(HubMain.getHubStartedAt(), 0, 'not started yet in a freshly-required module');
	HubMain.markStarted();
	const t1 = HubMain.getHubStartedAt();
	assert.ok(t1 > 0, 'markStarted set a start time');
	HubMain.markStarted();
	assert.strictEqual(HubMain.getHubStartedAt(), t1, 'a second markStarted does not move the time');
});

console.log('\nHubWorkerLimits: ' + passed + ' passed' + (failed ? (', ' + failed + ' failed') : ''));
process.exit(failed ? 1 : 0);
