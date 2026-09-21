'use strict';

// ResourceSentinelHandler.evaluateFlags — the pure threshold logic behind the "resource_sentinel" recipe.
// It decides which host resources (disk, memory, CPU, event-loop delay) crossed their warning threshold.
// These tests pin: each check fires only above/below its threshold, a threshold of 0 disables that check,
// an unreliable memory reading (macOS) is never alerted on, the event-loop check flags a real stall but not
// normal jitter, and a missing/unavailable metric is skipped rather than throwing.

const assert = require('assert');
const { evaluateFlags } = require('../../scheduledtasks/ResourceSentinelHandler.js');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

// Every check comfortably within its threshold — nothing should flag.
const healthy = {
	disk: { path: '/', freePct: 80, freeHuman: '80 GB', totalHuman: '100 GB' },
	mem:  { availPct: 60, availHuman: '6 GB', totalHuman: '10 GB', reliable: true, basis: 'available' },
	cpu:  { busyPct: 10, cores: 8 },
	loop: { maxMs: 30, p99Ms: 25 }
};
const TH = { disk: 10, mem: 10, cpu: 92, elag: 250 };

console.log('\nResourceSentinelHandler.evaluateFlags:');

test('a healthy host flags nothing', () => {
	assert.deepStrictEqual(evaluateFlags(healthy, TH), []);
});

test('disk below threshold flags, and only disk', () => {
	const m = Object.assign({}, healthy, { disk: { path: '/', freePct: 5, freeHuman: '5 GB', totalHuman: '100 GB' } });
	const f = evaluateFlags(m, TH);
	assert.strictEqual(f.length, 1);
	assert.ok(/Disk low/.test(f[0]));
});

test('reliable memory below threshold flags; an UNRELIABLE reading (macOS) never does', () => {
	const low = { availPct: 5, availHuman: '0.5 GB', totalHuman: '10 GB', basis: 'free' };
	assert.strictEqual(evaluateFlags(Object.assign({}, healthy, { mem: Object.assign({ reliable: true }, low) }), TH).length, 1);
	assert.strictEqual(evaluateFlags(Object.assign({}, healthy, { mem: Object.assign({ reliable: false }, low) }), TH).length, 0);
});

test('CPU above threshold flags', () => {
	const f = evaluateFlags(Object.assign({}, healthy, { cpu: { busyPct: 96, cores: 8 } }), TH);
	assert.strictEqual(f.length, 1);
	assert.ok(/CPU saturated/.test(f[0]));
});

console.log('\n  event-loop delay:');

test('a worst delay above the threshold flags the loop', () => {
	const f = evaluateFlags(Object.assign({}, healthy, { loop: { maxMs: 900, p99Ms: 400 } }), TH);
	assert.strictEqual(f.length, 1);
	assert.ok(/Event loop blocked/.test(f[0]));
	assert.ok(f[0].indexOf('900 ms') !== -1);
});

test('normal jitter at/under the threshold does not flag', () => {
	assert.deepStrictEqual(evaluateFlags(Object.assign({}, healthy, { loop: { maxMs: 250, p99Ms: 60 } }), TH), []);   // equal is not "above"
	assert.deepStrictEqual(evaluateFlags(Object.assign({}, healthy, { loop: { maxMs: 40, p99Ms: 30 } }), TH), []);
});

test('a threshold of 0 disables the event-loop check', () => {
	const th0 = Object.assign({}, TH, { elag: 0 });
	assert.deepStrictEqual(evaluateFlags(Object.assign({}, healthy, { loop: { maxMs: 5000, p99Ms: 5000 } }), th0), []);
});

test('an unavailable loop metric is skipped, never throwing', () => {
	assert.deepStrictEqual(evaluateFlags(Object.assign({}, healthy, { loop: { maxMs: null, p99Ms: null } }), TH), []);
	assert.doesNotThrow(() => evaluateFlags(Object.assign({}, healthy, { loop: null }), TH));
	assert.deepStrictEqual(evaluateFlags(Object.assign({}, healthy, { loop: null }), TH), []);
});

test('multiple simultaneous breaches all flag', () => {
	const m = {
		disk: { path: '/', freePct: 2, freeHuman: '2 GB', totalHuman: '100 GB' },
		mem:  { availPct: 3, availHuman: '0.3 GB', totalHuman: '10 GB', reliable: true, basis: 'available' },
		cpu:  { busyPct: 99, cores: 4 },
		loop: { maxMs: 1200, p99Ms: 800 }
	};
	assert.strictEqual(evaluateFlags(m, TH).length, 4);
});

console.log('\n' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
