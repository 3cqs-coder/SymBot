'use strict';


/*

	SymBot Hub
	Copyright © 2023 - 2026 3CQS.com All Rights Reserved
	Licensed under Creative Commons Attribution-NonCommerical-ShareAlike 4.0 International (CC BY-NC-SA 4.0)

*/


const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Common = require(__dirname + '/libs/app/Common.js');
const Hub = require(__dirname + '/libs/app/Hub/Hub.js');
const HubMain = require(__dirname + '/libs/app/Hub/Main.js');
const HubWorker = require(__dirname + '/libs/app/Hub/Worker.js');
const WebServer = require(__dirname + '/libs/webserver/Hub');
const packageJson = require(__dirname + '/package.json');
const { HUB_TO_WORKER, WORKER_TO_HUB } = require(__dirname + '/libs/app/Hub/MessageTypes.js');


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


async function startHub() {

	let port;
	let configs;
	let maxLogDays;
	let memoryPollIntervalMs;

	let success = true;

	initSignalHandlers();

	let hubData = await Common.getConfig(hubConfigFile);

	if (hubData.success) {

		port = hubData.data.port;
		configs = hubData.data.instances;
		maxLogDays = hubData.data.max_log_days;
		memoryPollIntervalMs = hubData.data.memory_poll_interval_ms;

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
							'hub_filename': __filename,
							'web_server_ports': undefined,
							'web_socket_path': 'ws',
							'hub_config': hubConfigFile,
							'shutdown_timeout': shutdownTimeout,
							'sig_int': false,
							'started': new Date(),
							// worker_data.name drives the Hub log filename in Hub.logger.
							// 'hub' produces YYYY-MM-DD-hub.log, kept in the same /logs
							// directory as instance logs and cleaned up automatically by
							// Common.logMonitor() on the same schedule.
							'worker_data': { 'name': 'hub' },
							'console_log': true,
							'max_log_days': (maxLogDays != undefined && maxLogDays != null && maxLogDays > 0) ? maxLogDays : 10
						},
					'Common': Common,
					'WebServer': WebServer,
					'Hub': Hub,
					'HubMain': HubMain,
					'workerMap': workerMap
		};

		Common.freezeProperty(shareData['appData'], [ 'path_root', 'hub_filename' ]);

		HubMain.init(Worker, shareData, shutDown);

		Common.init(shareData);
		WebServer.init(shareData);
		Hub.init(shareData);

		// Start Hub log rotation on the same schedule as SymBot instances.
		// Cleans YYYY-MM-DD-hub.log files from /logs alongside instance logs.
		Common.logMonitor();

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

	HubMain.start(configs);

	// Poll worker memory usage on a configurable interval.
	// Set memory_poll_interval_ms in hub.json to override the default.
	// Shorter intervals increase WebSocket traffic; longer intervals reduce it.
	const memoryPollMs = (memoryPollIntervalMs != undefined && memoryPollIntervalMs != null && memoryPollIntervalMs >= 1000)
		? memoryPollIntervalMs
		: 30000;

	// Store in appData so the Hub manage view can read it at render time and set
	// its staleness threshold to match the actual polling rate
	shareData.appData['memory_poll_ms'] = memoryPollMs;

	// Fire an initial poll shortly after startup so instances appear online as
	// soon as the page loads. The delay gives workers time to come online before
	// the first request is sent — without it the workerMap may still be empty.
	// The interval then handles all subsequent refreshes.
	setTimeout(() => Hub.logMemoryUsage(), 3000);
	setInterval(() => Hub.logMemoryUsage(), memoryPollMs);
}


async function startWorker() {

	HubWorker.init(parentPort, shutdownTimeout);
	HubWorker.start(workerData);
}


async function shutDown() {

	// Perform any post-shutdown processes here

	if (!gotSigInt) {

		gotSigInt = true;

		Hub.logger('info', 'Received kill signal. Shutting down gracefully.');
		Hub.logger('info', 'Cleaning up instances...');

		// Signal Main to suppress crash-restart logic during intentional shutdown
		HubMain.setShuttingDown();

		const terminationPromises = [];

		// Set timer to force shutdown if cleanup takes too long
		let timeOutShutdown = setTimeout(() => {

			Hub.logger('info', `Cleanup timed out. Forcing shutdown.`);

			process.exit(1);
		
		}, (shutdownTimeout + 20000));

		for (const [workerId, { worker, instance }] of workerMap.entries()) {

			const dateStart = instance.dateStart;
			const upTime = Common.timeDiff(new Date(dateStart), new Date());

			// Create a promise to track the worker shutdown process.
			// worker.once ensures the listener is removed after the first fire.
			// The per-worker timeout resolves (not rejects) so one unresponsive
			// worker does not prevent the others from being cleaned up.
			const workerTimeoutMs = shutdownTimeout + 10000;

			const shutdownPromise = new Promise((resolve) => {

				let workerShutdownTimeout;

				const onShutdownReceived = async (message) => {

					if (message.type !== WORKER_TO_HUB.SHUTDOWN_RECEIVED) return;

					// Acknowledged — cancel the safety timeout
					clearTimeout(workerShutdownTimeout);

					// Wait additional short delay to ensure worker shutdown gracefully
					await Common.delay(shutdownTimeout + 3000);

					// Once shutdown is complete, terminate the worker
					try {

						await worker.terminate();

						Hub.logger('info', `Worker ${workerId} terminated after ${upTime}.`);
					}
					catch (err) {

						Hub.logger('error', `Error terminating instance: ${err}`);
					}

					resolve();
				};

				// Use once — listener removed automatically after first matching message
				worker.once('message', onShutdownReceived);

				// Safety timeout — force-terminate and resolve if worker never responds
				workerShutdownTimeout = setTimeout(async () => {

					worker.off('message', onShutdownReceived);

					Hub.logger('info', `Worker ${workerId} did not acknowledge shutdown within ${workerTimeoutMs}ms. Forcing termination.`);

					try {

						await worker.terminate();
					}
					catch (e) {}

					resolve();

				}, workerTimeoutMs);

				// Send a "shutdown" message to the worker
				worker.postMessage({

					type: HUB_TO_WORKER.SHUTDOWN
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


async function start() {

	if (isMainThread) {

		startHub();
	}
	else {

		startWorker();
	}
}


start();
