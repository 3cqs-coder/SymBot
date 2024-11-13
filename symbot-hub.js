'use strict';


/*

	SymBot Hub
	Copyright © 2023 - 2024 3CQS.com All Rights Reserved
	Licensed under Creative Commons Attribution-NonCommerical-ShareAlike 4.0 International (CC BY-NC-SA 4.0)

*/


const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Common = require(__dirname + '/libs/app/Common.js');
const Hub = require(__dirname + '/libs/app/Hub.js');
const WebServer = require(__dirname + '/libs/webserver/hub');
const packageJson = require(__dirname + '/package.json');


let gotSigInt = false;

const shutdownTimeout = 2000;
const hubConfigFile = 'hub.json';
const workerMap = new Map();

let shareData;



function initSignalHandlers() {

	process.on('SIGINT', shutDown);
	process.on('SIGTERM', shutDown);

	process.on('message', function(msg) {

		if (msg == 'shutdown') {

			shutDown();
		}
	});

	process.on('uncaughtException', function(err) {

		let logData = 'Uncaught Exception: ' + JSON.stringify(err.message) + ' Stack: ' + JSON.stringify(err.stack);

		Hub.logger('error', logData);
	});
}


function startWorker(instanceData) {

	const workerId = Common.uuidv4();
	const instanceName = instanceData.name;
	const currentDate = new Date().toISOString();

	instanceData.dateStart = currentDate;

	const worker = new Worker(__filename, {
		workerData: {
			...instanceData,
			workerId
		}
	});

	worker.on('message', processWorkerMessageMain(workerId, instanceName));
	worker.on('error', (error) => Hub.logger('error', `Instance for ${instanceName} encountered an error:`, error));
	worker.on('exit', processWorkerExitMain(workerId));

	worker.once('online', () => {

		Hub.logger('info', `Instance: ${instanceName} (Worker ID: ${workerId}, Thread ID: ${worker.threadId}) started`);

		// Store worker and instanceData in workerMap
		workerMap.set(workerId, {
			worker,
			instance: instanceData,
			threadId: worker.threadId
		});
	});
}


async function startAllWorkers(configs) {

	for (const config of configs) {

		const serverIdInUse = [...workerMap.values()].some(worker => worker.instance.server_id === (config.overrides.server_id || null));

		if (!serverIdInUse) {

			const enabled = config['enabled'];
			const startBoot = config['start_boot'];

			if (enabled && startBoot) {

				startWorker({
					//instanceId: config.id,
					//instanceName: config.name,
					...config
				});

				await Common.delay(1000);
			}
		}
		else {

			Hub.logger('info', `Instance for ${config.name} already running.`);
		}
	}
}


if (isMainThread) {

	start();

} else {

	// Worker thread logic
	async function processWorkerTask(data) {

		try {

			const instanceName = data.name;
			const prefData = `[WORKER-LOG] [${instanceName}] `;

			// Override all console methods to send messages back to the main thread
			['log', 'error', 'warn', 'info', 'debug'].forEach((method) => {

				console[method] = (...args) => parentPort.postMessage({
					type: 'log',
					level: method, // 'log', 'error', 'warn', etc.
					data: prefData + args.join(' ')
				});
			});

			console.log(`Starting Instance: ${instanceName}`);

			const SymBot = require(__dirname + '/symbot.js');

			SymBot.setInstanceConfig(Object.assign({},
				data,
				{ shutdownTimeout }
			));

			SymBot.setInstanceParentPort(parentPort); 

			await SymBot.start();

			console.log(`Finished Starting Instance: ${instanceName}`);

			// Listen for command requests from the main thread
			parentPort.on('message', (message) => {

				processWorkerTaskMessage(SymBot, message);
			});

		}
		catch (error) {

			// Log the error and inform the main thread
			console.error(`Error performing task for ${data.name}: ${error.message}`);
		}
	}

	processWorkerTask(workerData);
}


async function processWorkerTaskMessage(SymBot, message) {

	// Get worker instance memory usage
	if (message.type === 'memory') {

		const memoryUsage = process.memoryUsage();

		parentPort.postMessage({

			type: 'memory',
			data: memoryUsage
		});
	}

	// Get worker instance active deals
	if (message.type === 'deals_active') {

		const dealTracker = await SymBot.DCABot.getDealTracker();

		const msg = 'Active Deals: ' + Object.keys(dealTracker).length;

		parentPort.postMessage({

			type: 'deals_active',
			data: msg
		});
	}

	// System pause received for SymBot worker
	if (message.type === 'system_pause') {

		parentPort.postMessage({

			type: 'system_pause_received'
		});

		const data = message.data;

		const isPause = data.pause;
		const pauseMessage = data.message;

		await SymBot.System.pause(isPause, pauseMessage);
	}

	// Shutdown received for SymBot worker
	if (message.type === 'shutdown') {

		parentPort.postMessage({

			type: 'shutdown_received'
		});

		SymBot.shutDown();
	}
}


function processWorkerMessageMain(workerId, instanceName) {

	// Messsages received from worker

	return (message) => {

		if (message.type === 'log') {

			Hub.logger('info', message.data);
		}
		else if (message.type === 'memory') {

			const workerInfo = workerMap.get(workerId);

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
				Common.sendSocketMsg({

					'room': 'memory',
					'type': 'log_memory',
					'message': msgObj
				});
			}
			else {

				Hub.logger('error', `Information for Worker ID ${workerId} not found.`);
			}
		}
		else if (message.type === 'deals_active') {

			//console.log(message.data);
		}
		else if (message.type === 'system_pause_all') {

			// Worker sent system pause for all instances
			Hub.logger('info', `Worker ID ${workerId} [${instanceName}] requested system pause for all instances`);

			// Relay message to all workers
			for (const { worker } of workerMap.values()) {

				worker.postMessage({
					type: 'system_pause',
					data: message.data
				});
			}
		}
		else if (message.type === 'shutdown_hub') {

			// Worker sent global Hub shutdown
			Hub.logger('info', `Worker ID ${workerId} [${instanceName}] requested Hub shutdown`);

			shutDown();
		}
	};
}


function processWorkerExitMain(workerId) {

	return (code) => {

		Hub.logger('info', `Instance exited with code ${code}, Worker ID: ${workerId}`);

		const workerInfo = workerMap.get(workerId);

		if (workerInfo) {

			const { instance } = workerInfo;

			const instanceName = instance.name;

			workerMap.delete(workerId);

			if (code !== 0) {

				Hub.logger('error', `Instance for ${instanceName} exited with code ${code}.`);

				// Optionally restart the instance
				// startWorker(instance);
			}
			else {

				Hub.logger('info', `Instance for ${instanceName} completed successfully.`);
			}
		}
		else {

			Hub.logger('error', `Worker ID ${workerId} does not exist in workerMap.`);
		}
	};
}


async function start() {

	let port;
	let configs;

	let success = true;

	initSignalHandlers();

	let hubData = await Common.getConfig(hubConfigFile);

	if (hubData.success) {

		port = hubData.data.port;
		configs = hubData.data.instances;

		const password = hubData['data']['password'];

		if (password == undefined || password == null || password == '') {

			// Set default password
			const dataPass = await Common.genPasswordHash({ 'data': 'admin' });

			hubData['data']['password'] = dataPass['salt'] + ':' + dataPass['hash'];

			await Common.saveConfig(hubConfigFile, hubData.data);
		}

		// Create initial Hub instance
		if (configs.length < 1) {

			const instanceObj = {
				"name": "Instance-1",
				"app_config": "app.json",
				"bot_config": "bot.json",
				"server_config": "server.json",
				"server_id": "",
				"mongo_db_url": "",
				"web_server_port": null,
				"enabled": true,
				"start_boot": true,
				"overrides": { },
				"updated": new Date().toISOString()
			}

			configs.push(instanceObj);
		}
	}
	else {

		success = false;

		Hub.logger('error', 'Hub Configuration Error: ' + hubData.data);
	}

	if (success) {

		shareData = {
						'appData': {
						
							'name': packageJson.description + ' Hub',
							'version': packageJson.version,
							'password': hubData['data']['password'],
							'path_root': __dirname,
							'web_server_ports': undefined,
							'web_socket_path': 'wsHub_',
							'hub_config': hubConfigFile,
							'shutdown_timeout': shutdownTimeout,
							'sig_int': false,
							'started': new Date()
						},
					'Common': Common,
					'WebServer': WebServer,
					'Hub': Hub,
					'startWorker': startWorker,
					'workerMap': workerMap
		};

		Common.init(shareData);
		WebServer.init(shareData);
		Hub.init(shareData);

		let processData = await Hub.processConfig(configs);

		if (!processData.success) {

			success = false;

			Hub.logger('error', JSON.stringify(processData.error));
		}
		else {

			await Hub.setProxyPorts(processData['web_server_ports']);

			let foundMissing = false;

			for (let i = 0; i < configs.length; i++) {

				const config = configs[i];

				let id = config['id'];

				if (id == undefined || id == null || id == '') {

					foundMissing = true;

					config['id'] = Common.uuidv4();
				}
			}

			// Update data if found missing id's
			if (foundMissing) {

				processData = null;

				processData = await Hub.processConfig(configs);

				configs = processData.configs;
				hubData['data']['instances'] = configs;

				await Common.saveConfig(hubConfigFile, hubData.data);
			}

			configs = processData.configs;			
		}
	}

	if (!success) {

		Hub.logger('error', 'Aborting due to configuration errors.');

		process.exit(1);
	}

	await WebServer.start(port);

	startAllWorkers(configs);

	setInterval(() => logMemoryUsage(), 5000);
}


async function logMemoryUsage() {

	for (const { worker } of workerMap.values()) {

		worker.postMessage({
			type: 'memory'
		});
	}
}


async function shutDown() {

	// Perform any post-shutdown processes here

	if (!gotSigInt) {

		gotSigInt = true;

		Hub.logger('info', 'Received kill signal. Shutting down gracefully.');
		Hub.logger('info', 'Cleaning up instances...');

		const terminationPromises = [];

		// Set timer to force shutdown if cleanup takes too long
		let timeOutShutdown = setTimeout(() => {

			Hub.logger('info', `Cleanup timed out. Forcing shutdown.`);

			process.exit(1);
		
		}, (shutdownTimeout + 20000));

		for (const [workerId, { worker, instance }] of workerMap.entries()) {

			const dateStart = instance.dateStart;
			const upTime = Common.timeDiff(new Date(dateStart), new Date());

			// Create a promise to track the worker shutdown process
			const shutdownPromise = new Promise((resolve, reject) => {

				// Wait for the worker to handle the shutdown
				worker.on('message', async (message) => {

					if (message.type === 'shutdown_received') {

						// Wait additional short delay to ensure worker shutdown gracefully
						await Common.delay(shutdownTimeout + 3000);

						// Once shutdown is complete, terminate the worker
						try {

							await worker.terminate();

							Hub.logger('info', `Worker ${workerId} terminated after ${upTime}.`);

							resolve();
						}
						catch (err) {

							Hub.logger('error', `Error terminating instance: ${err}`);

							reject(err);
						}
					}
				});

				// Send a "shutdown" message to the worker
				worker.postMessage({

					type: 'shutdown'
				});
			});

			terminationPromises.push(shutdownPromise);
		}

		// Wait for all workers to finish before starting the shutdown timeout
		try {

			await Promise.all(terminationPromises);

			clearTimeout(timeOutShutdown);

			Hub.logger('info', 'All workers have been terminated. Proceeding with shutdown.');

			// Start shutdown timeout after all workers are processed
			setTimeout(() => {

				process.exit(1);

			}, (shutdownTimeout + 3000));

		}
		catch (err) {

			Hub.logger('error', `Error during shutdown: ${err}`);
		}
	}
}
