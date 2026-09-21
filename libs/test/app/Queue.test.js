'use strict';

// Pins the serial async queue (libs/app/Queue.js) that serializes the deal-start path. This is money-adjacent:
// concurrent deal starts are funneled through this queue so the authoritative canStartDeal / pairMax / maxDeals
// checks inside each task run one-at-a-time and can't be raced past. A regression that broke the
// chain = chain.then(...) serialization (e.g. a "simplification" to fire-and-forget) would let simultaneous
// starts over-allocate funds — and nothing else would fail. These tests lock the three invariants the module
// guarantees: strict serialization, a rejecting task not breaking the chain, and enqueue resolving with the
// task's return value. No network/DB — the logger is stubbed.

const assert = require('assert');
const Queue = require('../../app/Queue.js');

Queue.init({ Common: { logger: function () {} } });

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok   - ' + msg); } else { failed++; process.exitCode = 1; console.log('  FAIL - ' + msg); } }

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {

	// ── Strict serialization: a task never starts until the previous one settles ──
	{
		const q = await Queue.create();
		const events = [];

		// A runs longer than B is scheduled after; if they overlapped, the markers would interleave.
		const a = q.enqueue(async () => { events.push('A-start'); await delay(30); events.push('A-end'); });
		const b = q.enqueue(async () => { events.push('B-start'); await delay(1); events.push('B-end'); });

		await Promise.all([ a, b ]);

		ok(events.join(',') === 'A-start,A-end,B-start,B-end',
			'tasks run strictly one-at-a-time, never interleaved (got: ' + events.join(',') + ')');
	}

	// ── enqueue resolves with the task's return value ──
	{
		const q = await Queue.create();
		const v = await q.enqueue(async () => 42);
		ok(v === 42, 'enqueue resolves with the task return value');
	}

	// ── A rejecting task rejects ITS promise but does not break the chain ──
	{
		const q = await Queue.create();
		const order = [];

		const bad = q.enqueue(async () => { order.push('bad'); throw new Error('boom'); });
		const good = q.enqueue(async () => { order.push('good'); return 'ok'; });

		let badRejected = false;
		await bad.catch(() => { badRejected = true; });
		const goodResult = await good;

		ok(badRejected, 'a throwing task rejects its own returned promise');
		ok(goodResult === 'ok', 'the task after a failing one still runs and resolves');
		ok(order.join(',') === 'bad,good', 'order preserved across a failing task');
	}

	// ── Serialization holds even when an earlier task rejects (next waits for it to settle) ──
	{
		const q = await Queue.create();
		const events = [];
		const t1 = q.enqueue(async () => { events.push('1-start'); await delay(20); events.push('1-end'); throw new Error('x'); });
		const t2 = q.enqueue(async () => { events.push('2-start'); });
		await t1.catch(() => {});
		await t2;
		ok(events.join(',') === '1-start,1-end,2-start', 'a later task waits for a rejecting earlier task to fully settle');
	}

	console.log('\n' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
	process.exit(failed ? 1 : 0);
})();
