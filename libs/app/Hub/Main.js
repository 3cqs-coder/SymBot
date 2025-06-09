'use strict';

const fs = require('fs');
const path = require('path');
const colors = require('colors');

const pathRoot = path.resolve(__dirname, '..', '..', '..');

let Worker;
let shutDownFunction;
let shareData;



function processWorkerMessage(workerId, instanceName) {

	// Messsages received from worker

	return (message) => {

		if (message.type === 'log') {

			shareData.Hub.logger('info', message.data);
		}
		else if (message.type === 'memory') {

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
		else if (message.type === 'deals_active') {

			//console.log(message.data);
		}
		else if (message.type === 'system_pause_all') {

			// Worker sent system pause for all instances
			shareData.Hub.logger('info', `Worker ID ${workerId} [${instanceName}] requested system pause for all instances`);

			// Relay message to all workers
			for (const { worker } of shareData.workerMap.values()) {

				worker.postMessage({
					type: 'system_pause',
					data: message.data
				});
			}
		}
		else if (message.type === 'shutdown_hub') {

			// Worker sent global Hub shutdown
			shareData.Hub.logger('info', `Worker ID ${workerId} [${instanceName}] requested Hub shutdown`);

			shutDownFunction();
		}
	};
}


function processWorkerExit(workerId) {

	return (code) => {

		shareData.Hub.logger('info', colors.red.bold(`Instance exited with code ${code}, Worker ID: ${workerId}`));

		const workerInfo = shareData.workerMap.get(workerId);

		if (workerInfo) {

			const { instance } = workerInfo;

			const instanceName = instance.name;

			shareData.workerMap.delete(workerId);

			if (code !== 0) {

				shareData.Hub.logger('error', colors.red.bold(`Instance for ${instanceName} exited with code ${code}.`));

				// Optionally restart the instance
				// startWorker(instance);
			}
			else {

				shareData.Hub.logger('info', colors.green.bold(`Instance for ${instanceName} completed successfully.`));
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
	worker.on('error', (error) => Hub.logger('error', `Instance for ${instanceName} encountered an error:`, error));
	worker.on('exit', processWorkerExit(workerId));

	worker.once('online', () => {

		shareData.Hub.logger('info', `Instance: ${instanceName} (Worker ID: ${workerId}, Thread ID: ${worker.threadId}) started`);

		// Store worker and instanceData in workerMap
		shareData.workerMap.set(workerId, {
			worker,
			instance: instanceData,
			threadId: worker.threadId
		});
	});
}


async function startAllWorkers(configs) {

	for (const config of configs) {

		const serverIdInUse = [...shareData.workerMap.values()].some(worker => worker.instance.server_id === (config.overrides.server_id || null));

		if (!serverIdInUse) {

			const enabled = config['enabled'];
			const startBoot = config['start_boot'];

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

	init: function(WorkerInit, shareDataInit, shutDown) {

		Worker = WorkerInit;
		shareData = shareDataInit;
		shutDownFunction = shutDown;
	}
};
