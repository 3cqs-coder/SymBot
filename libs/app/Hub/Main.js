'use strict';

const fs = require('fs');
const path = require('path');
const colors = require('colors');

const pathRoot = path.resolve(__dirname, '..', '..', '..'); 
const { HUB_TO_WORKER, WORKER_TO_HUB } = require(__dirname + '/MessageTypes.js');

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

		if (message.type === WORKER_TO_HUB.LOG) {

			shareData.Hub.logger('info', message.data);
		}
		else if (message.type === WORKER_TO_HUB.MEMORY) {

			const workerInfo = shareData.workerMap.get(workerId);

			if (workerInfo) {

				let msgObj = {
					'instanceId': workerInfo.instance.id,
					'instanceName': instanceName,
					'workerId': workerId,
					'threadId': workerInfo.threadId,
					'memoryUsage': {
						'rss': message.data.rss,
						'heapTotal': message.data.heapTotal,
						'heapUsed': message.data.heapUsed
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
	};
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
	});
}


async function startAllWorkers(configs) {

	for (const config of configs) {

		const serverIdInUse = [...shareData.workerMap.values()].some(worker => worker.instance.server_id === (config.overrides.server_id || null));

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


async function start(configs) {

	startAllWorkers(configs);
}


module.exports = {

	start,
	startWorker,
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
