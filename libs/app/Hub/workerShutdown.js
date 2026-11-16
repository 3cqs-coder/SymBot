'use strict';

const { HUB_TO_WORKER } = require(__dirname + '/MessageTypes.js');

// Gracefully shut down one Hub instance worker — the SINGLE source of truth shared by the full-Hub shutdown
// (symbot-hub.js) and the per-instance restart/stop (Hub.js), so the two can never drift.
//
// A worker self-exits (its own graceful shutDown() calls process.exit inside the thread — halting trading and
// flushing first) shortly after it receives SHUTDOWN, so this RESOLVES the instant the worker's 'exit' event
// fires, with no fixed grace delay (the old code idled a hardcoded multi-second wait, which pushed a full
// shutdown past the process-manager kill timeout and got it SIGKILLed). A safety timeout force-terminates a
// worker that never exits on its own, so one wedged instance can't hang the shutdown; it is a short, bounded
// margin over the base shutdown timeout and stays well under any PM2/systemd kill window.
//
// Pure control flow — no SymBot state. Resolves (never rejects) with { forced } so one stuck worker never
// blocks cleanup of the others.
//
// opts: { worker, label, log, shutdownTimeout }
//   worker          — the worker_threads Worker (needs once('exit'), terminate(), postMessage()).
//   label           — identifier for the log line (e.g. the worker id).
//   log             — function(message) used for the single terminated/forced log line (optional).
//   shutdownTimeout — base ms the worker is given to self-exit; the fallback fires at this + 2000ms.
function terminateWorkerGracefully(opts) {

	opts = opts || {};

	const worker = opts.worker;
	const label  = (opts.label != null) ? String(opts.label) : 'unknown';
	const log    = (typeof opts.log === 'function') ? opts.log : function () {};

	const base = Number(opts.shutdownTimeout);
	const timeoutMs = ((isFinite(base) && base >= 0) ? base : 2000) + 2000;

	return new Promise((resolve) => {

		let settled = false;
		let fallbackTimer;

		const finish = (forced) => {

			if (settled) { return; }
			settled = true;

			clearTimeout(fallbackTimer);

			log(forced
				? `Worker ${label} did not exit within ${timeoutMs}ms — forced termination.`
				: `Worker ${label} terminated.`);

			resolve({ forced: !!forced });
		};

		// Attach BEFORE sending SHUTDOWN so the exit can never be missed. The worker emits 'exit' when it
		// self-exits (or when force-terminated below).
		try { worker.once('exit', function () { finish(false); }); } catch (e) {}

		// Safety net: a worker that never exits on its own is force-terminated. Record the outcome as `forced`
		// FIRST — worker.terminate() itself fires 'exit', which would otherwise relabel this as a clean exit —
		// then force-stop the wedged worker (its now-redundant 'exit' is a no-op via the `settled` guard).
		fallbackTimer = setTimeout(() => {

			if (settled) { return; }

			finish(true);

			try { Promise.resolve(worker.terminate()).catch(function () {}); } catch (e) {}

		}, timeoutMs);

		// Ask the worker to shut down gracefully; it acks (SHUTDOWN_RECEIVED) and then self-exits. A throw here
		// (e.g. the worker already gone) is non-fatal — the fallback timer still resolves the promise.
		try { worker.postMessage({ type: HUB_TO_WORKER.SHUTDOWN }); } catch (e) {}
	});
}

module.exports = { terminateWorkerGracefully };
