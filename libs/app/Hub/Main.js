'use strict';

const path = require('path');
const colors = require('colors');

const pathRoot = path.resolve(__dirname, '..', '..', '..');
const { HUB_TO_WORKER, WORKER_TO_HUB } = require(__dirname + '/MessageTypes.js');
// Reuse the instance-side learning module for its PURE pack helpers (buildPack / packKey /
// verifyPack) — no init/store needed on the Hub; it only pools and repackages patterns.
const aiMemory = require(pathRoot + '/libs/ai/AIMemory.js');

const LEARNING_BROADCAST_MS = 300000; // push the pooled learning pack to instances every 5 min

// Build the current pooled learning pack from the Hub store, or null if there is nothing
// to send. Shared by the on-online push and the periodic broadcast.
function buildHubLearningPack() {

	try {

		if (!shareData.HubStore || typeof shareData.HubStore.listLearningPatterns !== 'function') { return null; }

		const patterns = shareData.HubStore.listLearningPatterns();
		if (!patterns.length) { return null; }

		return aiMemory.buildPack(patterns, { source: 'hub', created: Date.now() });
	}
	catch (e) { return null; }
}

let Worker;
let shutDownFunction;
let shareData;

const crashRestartMap = new Map();
const CRASH_RESTART_BASE_DELAY_MS  = 5000;
const CRASH_RESTART_MAX_DELAY_MS   = 300000; // 5 minutes
const CRASH_RESTART_MAX_ATTEMPTS   = 10;
// A worker must stay online this long before its crash-attempt counter is cleared. Without a stability
// window a worker that reaches 'online' and then exits shortly after (OOM, a late init failure) would be
// treated as attempt #1 every time and restart forever, never hitting the max-attempts ceiling.
const CRASH_RESTART_STABILITY_MS   = 60000;

// Pure decision helpers for the crash-restart supervisor, factored out (and exported) so the money-adjacent
// backoff math and the give-up ceiling are unit-tested and can never silently drift. crashRestartDelay is
// exponential backoff (BASE * 2^(attempt-1)) capped at the max; crashRestartShouldGiveUp is the attempt
// ceiling. No side effects, no shareData — safe to call from a test.
function crashRestartDelay(attempt) {

	return Math.min(CRASH_RESTART_BASE_DELAY_MS * Math.pow(2, attempt - 1), CRASH_RESTART_MAX_DELAY_MS);
}

function crashRestartShouldGiveUp(attempt) {

	return attempt > CRASH_RESTART_MAX_ATTEMPTS;
}

// Is an effective server_id already claimed by an ONLINE worker or a PRE-ONLINE reservation? This is the one
// guard that keeps two DCA engines off a single exchange account, so both the boot-time (startAllWorkers) and
// runtime (startWorker) start paths route through it — they must never drift (they did once: one side compared
// only the root server_id, missing an override, and the pre-online window was invisible to both). Pure and
// side-effect-free: it takes the worker/reservation values as iterables, so it is unit-tested directly. A null
// effective id is never "in use" (an unconfigured/just-reset instance has no account to collide on).
function isServerIdInUse(effectiveServerId, workerEntries, pendingEntries) {

	if (effectiveServerId == null) { return false; }

	for (const w of workerEntries) {

		const inst = (w && w.instance) || {};
		const wid = (inst.overrides && inst.overrides.server_id) || inst.server_id || null;

		if (wid === effectiveServerId) { return true; }
	}

	for (const p of pendingEntries) {

		if (p && p.effectiveServerId === effectiveServerId) { return true; }
	}

	return false;
}

// Worker IDs whose exit was caused by an INTENTIONAL termination (stop / delete / config-update restart),
// so the crash supervisor must NOT auto-restart them. terminateInstance adds the id before forcing
// worker.terminate(); processWorkerExit consumes it. This closes the window where a slow/wedged worker's
// forced termination looked like a crash and resurrected a stopped or deleted instance — a real-money risk
// (a zombie engine trading an account with no config entry). The explicit start paths handle any real
// restart separately, so suppressing the crash-restart here never prevents a legitimate one.
const suppressRestart = new Set();

// A worker takes real time to reach 'online' (it requires symbot.js, connects Mongo, etc.), but workerMap is
// populated only in the 'online' handler. Without a synchronous reservation the spawn→online window is invisible
// to BOTH the duplicate-server_id guard (two rapid starts, or a crash-restart timer racing an explicit start,
// could each spawn a worker for the same exchange account — two DCA engines on one account) AND the crash
// supervisor (a worker that dies before 'online', e.g. a transient boot failure that exits non-zero for
// supervised restart, would never be restarted). pendingWorkers holds the reservation from the moment the Worker
// is constructed until it is promoted into workerMap on 'online' (or cleared on exit). Kept SEPARATE from
// workerMap so the deal/bot/learning fan-out still targets only truly-online workers and never posts to a
// not-yet-listening engine. Keyed by workerId; each value carries the instance and its effective server_id.
const pendingWorkers = new Map();

let isShuttingDown = false;



function processWorkerMessage(workerId, instanceName) {

	// Messsages received from worker

	return (message) => {

	  // One guard around the WHOLE dispatcher: a malformed or unexpected message from any worker can
	  // never throw past this point into the Hub's last-resort uncaughtException net (a Hub crash would
	  // take every worker down). Individual branches keep their own try/catch for finer handling; this
	  // is the backstop that isolates one bad message to a logged warning.
	  try {

		if (message.type === WORKER_TO_HUB.LOG) {

			shareData.Hub.logger('info', message.data);
		}
		else if (message.type === WORKER_TO_HUB.LOG_BATCH) {

			// A batch of relayed lines — log each exactly as a single LOG would be (prefix, ordered
			// async append, broadcast), so batching changes only the cross-thread message count.
			const lines = Array.isArray(message.lines) ? message.lines : [];
			for (let i = 0; i < lines.length; i++) { shareData.Hub.logger('info', lines[i]); }
		}
		else if (message.type === WORKER_TO_HUB.MEMORY) {

			const workerInfo = shareData.workerMap.get(workerId);

			if (workerInfo) {

				// Memory attributable to this instance. rss is deliberately kept
				// separate: it reports the whole process (all worker threads share
				// it), so it is a single process-level figure rather than a
				// per-instance one.
				const memData = message.data || {};
				const memoryAttributed = (memData.heapUsed || 0) + (memData.external || 0) + (memData.arrayBuffers || 0);

				let msgObj = {
					'instanceId': workerInfo.instance.id,
					'instanceName': instanceName,
					'workerId': workerId,
					'threadId': workerInfo.threadId,
					'memoryUsage': {
						'rss': memData.rss,
						'heapTotal': memData.heapTotal,
						'heapUsed': memData.heapUsed,
						'external': memData.external || 0,
						'arrayBuffers': memData.arrayBuffers || 0,
						'attributed': memoryAttributed,
						// Host CPU load (same for every instance on this host) — carried
						// on the same channel so the Manage view can show it per row.
						'loadAvg': memData.loadAvg || null,
						'loadAvgSupported': memData.loadAvgSupported === true,
						'cpuCount': memData.cpuCount != null ? memData.cpuCount : null
					}
				};				

				// Send memory usage to client
				shareData.Common.sendSocketMsg({

					'room': 'memory',
					'type': 'log_memory',
					'message': msgObj
				});
			}
			else {

				shareData.Hub.logger('error', `Information for Worker ID ${workerId} not found.`);
			}
		}
		else if (message.type === WORKER_TO_HUB.DEALS_ACTIVE_RECEIVED) {

			//console.log(message.data);
		}
		else if (message.type === WORKER_TO_HUB.SYSTEM_PAUSE_ALL) {

			// Worker sent system pause for all instances
			shareData.Hub.logger('info', `Worker ID ${workerId} [${instanceName}] requested system pause for all instances`);

			// Relay message to all workers
			for (const { worker } of shareData.workerMap.values()) {

				worker.postMessage({
					type: HUB_TO_WORKER.SYSTEM_PAUSE,
					data: message.data
				});
			}
		}
		else if (message.type === WORKER_TO_HUB.SHUTDOWN_HUB) {

			// Worker sent global Hub shutdown
			shareData.Hub.logger('info', `Worker ID ${workerId} [${instanceName}] requested Hub shutdown`);

			shutDownFunction();
		}
		else if (message.type === WORKER_TO_HUB.SEND_EMAIL) {

			// An instance with no SMTP of its own relayed an outbound email; deliver it
			// through the Hub's shared mailer. Fire-and-forget — must never block the
			// message loop or throw back into it.
			if (shareData.Mailer && typeof shareData.Mailer.send === 'function' && shareData.Mailer.ready !== false) {

				try { shareData.Mailer.send(message.payload || {}); }
				catch (e) { shareData.Hub.logger('error', `Hub mailer relay send failed: ${e.message}`); }
			}
			else {

				shareData.Hub.logger('error', `Worker ID ${workerId} [${instanceName}] relayed an email but the Hub has no SMTP configured`);
			}
		}
		else if (message.type === WORKER_TO_HUB.LEARNING) {

			// An instance relayed a patterns-only learning note; pool it so instances that do
			// not share a database still learn from each other. Deduped by the same key the
			// instances use. Fire-and-forget — must never throw back into the message loop.
			try {

				const p = message.payload || {};

				if (p.question && shareData.HubStore && typeof shareData.HubStore.addLearningPattern === 'function') {

					shareData.HubStore.addLearningPattern(p, aiMemory.packKey(p));
				}
			}
			catch (e) { shareData.Hub.logger('error', `Hub learning relay failed: ${e.message}`); }
		}

		else if (message.type === WORKER_TO_HUB.TOOLS) {

			// An instance reported its AI-tool names. Record them on the workerMap entry so a
			// maintainer aggregating contributed learning packs can validate against the union of
			// tools the fleet actually has, and see which instances support a given tool. Best-effort.
			try {

				const names = Array.isArray(message.payload) ? message.payload.filter(n => typeof n === 'string') : [];
				const info = shareData.workerMap.get(workerId);

				if (info) { info.tools = names; }
			}
			catch (e) { /* best-effort — must never throw back into the message loop */ }
		}

	  }
	  catch (e) { try { shareData.Hub.logger('error', 'Hub worker-message dispatch failed (type ' + (message && message.type) + '): ' + (e && e.message)); } catch (_) {} }
	};
}


// Push the pooled learning pack to a single worker (used when an instance comes online).
function pushLearningPackToWorker(worker) {

	try {

		const pack = buildHubLearningPack();
		if (pack && worker && typeof worker.postMessage === 'function') {

			worker.postMessage({ type: HUB_TO_WORKER.LEARNING_PACK, payload: pack });
		}
	}
	catch (e) { /* best-effort */ }
}


// Broadcast the pooled learning pack to every running worker, so patterns learned by one
// instance reach the others without waiting for a restart.
function broadcastLearningPack() {

	try {

		const pack = buildHubLearningPack();
		if (!pack) { return; }

		for (const entry of shareData.workerMap.values()) {

			if (entry && entry.worker && typeof entry.worker.postMessage === 'function') {

				entry.worker.postMessage({ type: HUB_TO_WORKER.LEARNING_PACK, payload: pack });
			}
		}
	}
	catch (e) { /* best-effort */ }
}


function scheduleRestart(instance, attempt) {

	const instanceId   = instance.id;
	const instanceName = instance.name;

	if (crashRestartShouldGiveUp(attempt)) {

		shareData.Hub.logger('error', colors.red.bold(`Instance ${instanceName} has exceeded maximum restart attempts (${CRASH_RESTART_MAX_ATTEMPTS}). Giving up.`));

		crashRestartMap.delete(instanceId);

		return;
	}

	const delay = crashRestartDelay(attempt);

	shareData.Hub.logger('info', colors.yellow.bold(`Scheduling restart for ${instanceName} (attempt ${attempt}/${CRASH_RESTART_MAX_ATTEMPTS}) in ${Math.round(delay / 1000)}s...`));

	crashRestartMap.set(instanceId, { attempt, timer: setTimeout(async () => {

		// Before respawning, confirm the instance STILL EXISTS and is STILL ENABLED in the live config. A
		// crash leaves no live worker in workerMap, so a delete/disable during this backoff window cannot be
		// caught by terminateInstance's suppress path — without this re-check the timer would resurrect a
		// removed or disabled instance (a zombie engine trading an account with no config entry). Fail safe:
		// if the config read throws, fall through to the original restart behavior rather than dropping it.
		try {

			const hubData = await shareData.Common.getConfig(shareData.appData.hub_config);
			const cfg = (hubData && hubData.success && hubData.data && Array.isArray(hubData.data.instances))
				? hubData.data.instances.find(c => c.id === instanceId) : null;

			if (!cfg || cfg.enabled === false) {

				shareData.Hub.logger('info', colors.yellow.bold(`Instance ${instanceName} was removed or disabled during restart backoff — canceling auto-restart.`));
				crashRestartMap.delete(instanceId);
				return;
			}
		}
		catch (e) { /* config read failed — fall through and restart as before */ }

		shareData.Hub.logger('info', colors.yellow.bold(`Restarting instance ${instanceName} (attempt ${attempt})...`));

		// Keep the map entry (with its attempt count) instead of deleting it — the count must survive across
		// restart cycles so a worker that keeps dying accumulates attempts toward the ceiling instead of
		// resetting to 1 each time. It is cleared only after the worker stays online for the stability window
		// (see the 'online' handler), or when it gives up / exits cleanly. Mark the timer as fired.
		const e = crashRestartMap.get(instanceId);
		if (e) { e.timer = null; }

		startWorker({ ...instance, _crashAttempt: attempt });

	}, delay) });
}


// Cancel any pending crash-restart (and its stability timer) for an instance. Called on an INTENTIONAL
// stop/delete/disable so a restart scheduled from an earlier crash can't fire after the user has removed or
// disabled the instance — the case terminateInstance's live-worker suppress path cannot reach (a crashed
// instance has no live worker). Safe to call when nothing is scheduled. Keyed by instanceId.
function cancelScheduledRestart(instanceId) {

	const entry = crashRestartMap.get(instanceId);

	if (entry) {

		if (entry.timer) { clearTimeout(entry.timer); }
		if (entry.stabilityTimer) { clearTimeout(entry.stabilityTimer); }
		crashRestartMap.delete(instanceId);
	}
}


function processWorkerExit(workerId) {

	return (code) => {

		shareData.Hub.logger('info', `Instance exited with code ${code}, Worker ID: ${workerId}`);

		// A worker can exit AFTER it reached 'online' (entry in workerMap) or BEFORE it ever came online (only a
		// pre-online reservation in pendingWorkers — e.g. an init failure that exits non-zero for supervised
		// restart). Resolve the instance from whichever map holds it and clear BOTH, so a pre-online crash is
		// still supervised (restarted with backoff) instead of being silently dropped.
		const workerInfo = shareData.workerMap.get(workerId) || pendingWorkers.get(workerId);

		shareData.workerMap.delete(workerId);
		pendingWorkers.delete(workerId);

		if (workerInfo) {

			const { instance } = workerInfo;

			const instanceName = instance.name;
			const instanceId   = instance.id;

			// An INTENTIONAL termination (stop / delete / config-update restart) must never be auto-restarted
			// as if it were a crash — even when the exit code is non-zero because the worker was force-terminated
			// after not acknowledging shutdown in time. Consume the one-shot suppress flag first, and also clear
			// any pending crash-restart timer so a restart already scheduled from an earlier flap can't fire.
			if (suppressRestart.has(workerId)) {

				suppressRestart.delete(workerId);

				cancelScheduledRestart(instanceId);   // clears both the pending restart timer and any stability timer

				shareData.Hub.logger('info', `Instance ${instanceName} was stopped intentionally — skipping auto-restart.`);
				return;
			}

			if (code !== 0) {

				// Skip restart if Hub is shutting down intentionally
				if (isShuttingDown) {

					shareData.Hub.logger('info', `Instance ${instanceName} exited during shutdown — skipping auto-restart.`);
					return;
				}

				shareData.Hub.logger('error', colors.red.bold(`Instance ${instanceName} crashed with exit code ${code}.`));

				// Only restart if instance is still enabled
				const enabled = instance['enabled'];

				if (!enabled) {

					shareData.Hub.logger('info', `Instance ${instanceName} is disabled — skipping auto-restart.`);
					return;
				}

				const existing = crashRestartMap.get(instanceId);
				// A worker that came online then died before the stability window leaves a stability timer
				// pending; clear it so it can't later delete the fresh entry scheduleRestart is about to set.
				if (existing && existing.stabilityTimer) { clearTimeout(existing.stabilityTimer); }
				const attempt  = existing ? existing.attempt + 1 : 1;

				scheduleRestart(instance, attempt);
			}
			else {

				// Clean exit — clear any pending restart or stability timer
				const existing = crashRestartMap.get(instanceId);

				if (existing) {

					if (existing.timer) { clearTimeout(existing.timer); }
					if (existing.stabilityTimer) { clearTimeout(existing.stabilityTimer); }
					crashRestartMap.delete(instanceId);
				}

				shareData.Hub.logger('info', colors.green.bold(`Instance ${instanceName} shut down cleanly.`));
			}
		}
		else {

			shareData.Hub.logger('error', colors.red.bold(`Worker ID ${workerId} does not exist in workerMap.`));
		}
	};
}


function startWorker(instanceData) {

	// Refuse to spawn a second worker for a server_id that already has a live worker. Without this guard a
	// scheduled crash-restart and an explicit start (or a config-update restart) could each spawn a worker
	// for the same effective server_id — two DCA engines trading one exchange account at once. Mirrors the
	// check startAllWorkers already applies at boot. Compare on the EFFECTIVE id (override, else config).
	const effectiveServerId = (instanceData.overrides && instanceData.overrides.server_id) || instanceData.server_id || null;

	// Refuse a second worker for a server_id already claimed by an online worker OR a pre-online reservation.
	if (isServerIdInUse(effectiveServerId, shareData.workerMap.values(), pendingWorkers.values())) {

		shareData.Hub.logger('info', `Instance ${instanceData.name} already has a running worker for its server id — not starting a duplicate.`);
		return;
	}

	const workerId = shareData.Common.uuidv4();
	const instanceName = instanceData.name;
	const currentDate = new Date().toISOString();

	instanceData.dateStart = currentDate;

	// Reserve the server_id synchronously, BEFORE the worker exists, so the duplicate guard above and the crash
	// supervisor (processWorkerExit) both see this worker during the spawn→online window. Promoted into
	// workerMap on 'online' and cleared on 'exit'.
	pendingWorkers.set(workerId, { instance: instanceData, effectiveServerId });

	let worker;

	try {

		worker = new Worker(shareData.appData.hub_filename, {
			workerData: {
				...instanceData,
				workerId
			}
		});
	}
	catch (err) {

		// Constructing the worker failed synchronously (no 'exit' event will fire), so clear the reservation
		// here or it would block every future start for this server_id. Let the caller's own retry/restart
		// path handle recovery.
		pendingWorkers.delete(workerId);

		shareData.Hub.logger('error', colors.red.bold(`Failed to start worker for ${instanceName}: ${err && err.message ? err.message : err}`));

		return;
	}

	// The Hub attaches short-lived per-poll 'message' listeners (deals/bots/etc.) on top of the persistent
	// one; concurrent dashboard polling can briefly exceed Node's default 10-listener ceiling and emit a
	// misleading MaxListenersExceededWarning. The listeners are always removed on resolve/timeout, so this
	// only silences noise, not a real leak.
	worker.setMaxListeners(0);

	worker.on('message', processWorkerMessage(workerId, instanceName));
	worker.on('error', (error) => shareData.Hub.logger('error', `Instance for ${instanceName} encountered an error: ${error}`));
	worker.on('exit', processWorkerExit(workerId));

	worker.once('online', () => {

		shareData.Hub.logger('info', `Instance: ${instanceName} (Worker ID: ${workerId}, Thread ID: ${worker.threadId}) started`);

		// The worker is now truly online — promote it from the pre-online reservation into workerMap so the
		// deal/bot/learning fan-out (which iterates workerMap) can reach it.
		pendingWorkers.delete(workerId);

		// Store worker and instanceData in workerMap
		shareData.workerMap.set(workerId, {
			worker,
			instance: instanceData,
			threadId: worker.threadId
		});

		// The worker is online. Do NOT clear the crash-attempt count yet — a worker that comes up and then
		// dies again shortly after must keep accumulating attempts toward the ceiling, not reset to 1 each
		// cycle. Cancel only the pending restart timer, then start a stability timer that clears the count
		// once the worker has stayed online long enough to be considered recovered. If it exits before then,
		// processWorkerExit clears this stability timer and increments the attempt count.
		const instanceId = instanceData.id;
		const existing   = crashRestartMap.get(instanceId);

		if (existing) {

			if (existing.timer) { clearTimeout(existing.timer); existing.timer = null; }
			if (existing.stabilityTimer) { clearTimeout(existing.stabilityTimer); }
			existing.stabilityTimer = setTimeout(() => { crashRestartMap.delete(instanceId); }, CRASH_RESTART_STABILITY_MS);
			if (existing.stabilityTimer.unref) { existing.stabilityTimer.unref(); }
		}

		// Log if this was a crash recovery restart
		if (instanceData._crashAttempt) {

			shareData.Hub.logger('info', colors.green.bold(`Instance ${instanceName} recovered successfully after crash (attempt ${instanceData._crashAttempt}).`));
		}

		// Give the newly-online instance the pooled AI-learning pack so it starts with what
		// every other instance has already learned. A brief delay lets it finish wiring its
		// AI client first; it's best-effort either way.
		setTimeout(() => pushLearningPackToWorker(worker), 8000);
	});
}


async function startAllWorkers(configs) {

	for (const config of configs) {

		// Compare on the EFFECTIVE server_id (override, else root config.server_id) on BOTH sides, and also
		// against the pre-online reservations — mirroring startWorker's guard — so no two engines can reach one
		// exchange account. Safe today (runs once at boot on an empty map) but correct for any later re-entry.
		const effectiveServerId = (config.overrides && config.overrides.server_id) || config.server_id || null;
		const serverIdInUse = isServerIdInUse(effectiveServerId, shareData.workerMap.values(), pendingWorkers.values());

		if (!serverIdInUse) {

			const enabled = config['enabled'];
			const startBoot = config['start_boot'];

			if (process.argv.length > 2) {

				config['args'] = process.argv.slice(2);
			}

			if (enabled && startBoot) {

				startWorker({
					//instanceId: config.id,
					//instanceName: config.name,
					...config
				});

				await shareData.Common.delay(1000);
			}
		}
		else {

			shareData.Hub.logger('info', `Instance for ${config.name} already running.`);
		}
	}
}


let learningBroadcastTimer = null;

async function start(configs) {

	startAllWorkers(configs);

	// Periodically share the pooled AI-learning pack with every running instance, so a
	// pattern learned by one propagates to the others without waiting for a restart. Cheap
	// (patterns only, deduped, capped) and best-effort. `unref` so it never holds the Hub open.
	if (!learningBroadcastTimer) {

		learningBroadcastTimer = setInterval(broadcastLearningPack, LEARNING_BROADCAST_MS);
		if (typeof learningBroadcastTimer.unref === 'function') { learningBroadcastTimer.unref(); }
	}
}


module.exports = {

	start,
	startWorker,
	// Exposed so the worker-message routing (e.g. the SEND_EMAIL relay) can be unit-tested
	// against the real handler with a stub shareData; production never calls this directly.
	processWorkerMessage,
	buildHubLearningPack,
	broadcastLearningPack,
	// Pure crash-restart decision helpers + their tuning constants, exported for unit testing (the backoff
	// math and the give-up ceiling are money-adjacent, so a regression here must be caught).
	crashRestartDelay,
	crashRestartShouldGiveUp,
	// The single duplicate-engine guard (online + pre-online), exported so its "never two engines on one
	// exchange account" invariant is locked by a unit test and the two start paths can't silently drift again.
	isServerIdInUse,
	CRASH_RESTART_BASE_DELAY_MS,
	CRASH_RESTART_MAX_DELAY_MS,
	CRASH_RESTART_MAX_ATTEMPTS,
	get shutDown() {
        return shutDownFunction;
    },

	setShuttingDown: function() {

		isShuttingDown = true;

		// Cancel all pending crash-restart and stability timers
		for (const [id, entry] of crashRestartMap.entries()) {

			if (entry.timer) { clearTimeout(entry.timer); }
			if (entry.stabilityTimer) { clearTimeout(entry.stabilityTimer); }
			crashRestartMap.delete(id);
		}
	},

	// Mark a worker's imminent exit as INTENTIONAL so the crash supervisor won't auto-restart it. Called by
	// terminateInstance (stop / delete / config-update restart) right before it forces termination.
	suppressWorkerRestart: function(workerId) {

		if (workerId != null) { suppressRestart.add(workerId); }
	},

	// Cancel a pending crash-restart for an instance (by instanceId). Called on stop/delete/disable to cover
	// the window where a worker has already CRASHED and is waiting out its restart backoff — there is no live
	// worker for suppressWorkerRestart to flag, so this proactively clears the scheduled restart so a removed
	// or disabled instance can't be resurrected when the timer fires.
	cancelScheduledRestart: function(instanceId) {

		cancelScheduledRestart(instanceId);
	},

	// Read-only: the instance IDs that currently have a crash-restart scheduled or are waiting out their
	// backoff window. The Hub liveness watchdog consults this so it never flags an instance that is already
	// being restarted (mid-backoff) as "down". Returns a fresh array; mutating it does not affect the map.
	getScheduledRestartInstanceIds: function() {

		return Array.from(crashRestartMap.keys());
	},

	init: function(WorkerInit, shareDataInit, shutDown) {

		Worker = WorkerInit;
		shareData = shareDataInit;
		shutDownFunction = shutDown;
	}
};
