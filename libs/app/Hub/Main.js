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

	if (attempt > CRASH_RESTART_MAX_ATTEMPTS) {

		shareData.Hub.logger('error', colors.red.bold(`Instance ${instanceName} has exceeded maximum restart attempts (${CRASH_RESTART_MAX_ATTEMPTS}). Giving up.`));

		crashRestartMap.delete(instanceId);

		return;
	}

	const delay = Math.min(CRASH_RESTART_BASE_DELAY_MS * Math.pow(2, attempt - 1), CRASH_RESTART_MAX_DELAY_MS);

	shareData.Hub.logger('info', colors.yellow.bold(`Scheduling restart for ${instanceName} (attempt ${attempt}/${CRASH_RESTART_MAX_ATTEMPTS}) in ${Math.round(delay / 1000)}s...`));

	crashRestartMap.set(instanceId, { attempt, timer: setTimeout(() => {

		shareData.Hub.logger('info', colors.yellow.bold(`Restarting instance ${instanceName} (attempt ${attempt})...`));

		crashRestartMap.delete(instanceId);

		startWorker({ ...instance, _crashAttempt: attempt });

	}, delay) });
}


function processWorkerExit(workerId) {

	return (code) => {

		shareData.Hub.logger('info', `Instance exited with code ${code}, Worker ID: ${workerId}`);

		const workerInfo = shareData.workerMap.get(workerId);

		if (workerInfo) {

			const { instance } = workerInfo;

			const instanceName = instance.name;
			const instanceId   = instance.id;

			shareData.workerMap.delete(workerId);

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
				const attempt  = existing ? existing.attempt + 1 : 1;

				scheduleRestart(instance, attempt);
			}
			else {

				// Clean exit — clear any pending restart
				const existing = crashRestartMap.get(instanceId);

				if (existing) {

					clearTimeout(existing.timer);
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

	const workerId = shareData.Common.uuidv4();
	const instanceName = instanceData.name;
	const currentDate = new Date().toISOString();

	instanceData.dateStart = currentDate;

	const worker = new Worker(shareData.appData.hub_filename, {
		workerData: {
			...instanceData,
			workerId
		}
	});

	worker.on('message', processWorkerMessage(workerId, instanceName));
	worker.on('error', (error) => shareData.Hub.logger('error', `Instance for ${instanceName} encountered an error: ${error}`));
	worker.on('exit', processWorkerExit(workerId));

	worker.once('online', () => {

		shareData.Hub.logger('info', `Instance: ${instanceName} (Worker ID: ${workerId}, Thread ID: ${worker.threadId}) started`);

		// Store worker and instanceData in workerMap
		shareData.workerMap.set(workerId, {
			worker,
			instance: instanceData,
			threadId: worker.threadId
		});

		// Clear any pending crash restart now that the worker is online
		const instanceId = instanceData.id;
		const existing   = crashRestartMap.get(instanceId);

		if (existing) {

			clearTimeout(existing.timer);
			crashRestartMap.delete(instanceId);
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

		// Compare against the EFFECTIVE server_id (override, else root config.server_id) — not just the
		// override. An instance whose id comes from the root config had `null` on the right here, so the
		// equality never held and a duplicate could slip past. Safe today (runs once at boot on an empty
		// map) but correct now for any later re-entry.
		const effectiveServerId = (config.overrides && config.overrides.server_id) || config.server_id || null;
		const serverIdInUse = [...shareData.workerMap.values()].some(worker => worker.instance.server_id === effectiveServerId);

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
	get shutDown() {
        return shutDownFunction;
    },

	setShuttingDown: function() {

		isShuttingDown = true;

		// Cancel all pending crash restart timers
		for (const [id, { timer }] of crashRestartMap.entries()) {

			clearTimeout(timer);
			crashRestartMap.delete(id);
		}
	},

	init: function(WorkerInit, shareDataInit, shutDown) {

		Worker = WorkerInit;
		shareData = shareDataInit;
		shutDownFunction = shutDown;
	}
};
