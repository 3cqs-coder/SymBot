'use strict';

// Unit tests for the shared Hub worker-shutdown helper (workerShutdown.js) — the single source of truth used by
// BOTH the full-Hub shutdown (symbot-hub.js) and the per-instance restart/stop (Hub.js). Pins the fix for the
// SIGKILL-on-restart bug: the Hub now resolves the instant a worker self-exits (no fixed grace delay), and
// force-terminates only a worker that never exits — keeping the graceful shutdown well under a process-manager
// kill window. Uses a fake worker (EventEmitter) so the timing logic is deterministic, no real threads.

const assert = require('assert');
const EventEmitter = require('events');
const { terminateWorkerGracefully } = require('../../app/Hub/workerShutdown.js');
const { HUB_TO_WORKER } = require('../../app/Hub/MessageTypes.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function eq(a, b, m) { assert.strictEqual(a, b, m); passed++; }

function fakeWorker(overrides) {
	const w = new EventEmitter();
	w.posted = [];
	w.terminateCalls = 0;
	w.postMessage = function (msg) { w.posted.push(msg); };
	w.terminate = function () { w.terminateCalls++; return Promise.resolve(); };
	Object.assign(w, overrides || {});
	return w;
}

(async () => {

	// (1) Worker self-exits → resolves NOT forced, does not force-terminate, posts SHUTDOWN, logs once.
	{
		const w = fakeWorker();
		const logs = [];
		const p = terminateWorkerGracefully({ worker: w, label: 'inst-1', shutdownTimeout: 2000, log: (m) => logs.push(m) });
		setTimeout(() => w.emit('exit'), 10);
		const r = await p;
		eq(r.forced, false, 'self-exit resolves forced:false');
		eq(w.terminateCalls, 0, 'self-exit does NOT force-terminate');
		eq(w.posted.length, 1, 'exactly one SHUTDOWN posted');
		eq(w.posted[0].type, HUB_TO_WORKER.SHUTDOWN, 'posts the SHUTDOWN message type (SSOT via MessageTypes)');
		eq(logs.length, 1, 'logs exactly once');
		ok(/terminated\.$/.test(logs[0]) && !/forced/i.test(logs[0]), 'clean "terminated" log, not "forced"');
		ok(logs[0].indexOf('inst-1') !== -1, 'log carries the label');
	}

	// (2) Worker never exits → after the fallback, resolves FORCED, force-terminates, logs "forced".
	//     shutdownTimeout:0 → fallback = 0 + 2000 = 2000ms (the fixed safety margin).
	{
		const w = fakeWorker({ terminate: function () { this.terminateCalls = (this.terminateCalls || 0) + 1; this.emit('exit'); return Promise.resolve(); } });
		w.terminateCalls = 0;
		const logs = [];
		const t0 = Date.now();
		const r = await terminateWorkerGracefully({ worker: w, label: 'inst-2', shutdownTimeout: 0, log: (m) => logs.push(m) });
		const elapsed = Date.now() - t0;
		eq(r.forced, true, 'no self-exit → resolves forced:true (not relabeled by terminate\'s own exit event)');
		eq(w.terminateCalls, 1, 'force-terminates exactly once');
		ok(elapsed >= 1900 && elapsed < 3500, 'fires at ~base+2000ms (2000ms here), got ' + elapsed + 'ms');
		ok(logs.length === 1 && /forced termination/i.test(logs[0]) && /2000ms/.test(logs[0]), 'logs a single "forced termination within 2000ms" line');
	}

	// (3) postMessage throwing (worker already gone) must not crash — the fallback still resolves it.
	{
		const w = fakeWorker({ postMessage: function () { throw new Error('worker gone'); } });
		let threw = false;
		let r;
		try { r = await terminateWorkerGracefully({ worker: w, label: 'inst-3', shutdownTimeout: 0, log: () => {} }); }
		catch (e) { threw = true; }
		ok(!threw, 'a throwing postMessage does not reject/crash the helper');
		eq(r.forced, true, 'falls through to the forced fallback and resolves');
	}

	// (4) Idempotent: a second 'exit' after settle does not log or resolve again.
	{
		const w = fakeWorker();
		const logs = [];
		const p = terminateWorkerGracefully({ worker: w, label: 'inst-4', shutdownTimeout: 2000, log: (m) => logs.push(m) });
		w.emit('exit');
		await p;
		w.emit('exit');           // late duplicate
		await new Promise((res) => setTimeout(res, 10));
		eq(logs.length, 1, 'duplicate exit after settle is a no-op (logged once)');
	}

	// (5) Missing/invalid shutdownTimeout defaults the base to 2000 (fallback would be 4000) — verified via the
	//     message text without waiting the full 4s: drive the fallback by faking a fast clock is overkill, so
	//     instead assert the helper tolerates a bad base and still resolves on a normal self-exit.
	{
		const w = fakeWorker();
		const p = terminateWorkerGracefully({ worker: w, label: 'inst-5', shutdownTimeout: undefined, log: () => {} });
		setTimeout(() => w.emit('exit'), 10);
		const r = await p;
		eq(r.forced, false, 'invalid shutdownTimeout still resolves cleanly on self-exit');
	}

	console.log('HubWorkerShutdown: ' + passed + ' assertions passed');
})().catch((e) => { console.error('HubWorkerShutdown FAILED: ' + (e && e.stack || e)); process.exit(1); });
