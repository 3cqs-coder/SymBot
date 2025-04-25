'use strict';


/*

	SymBot Hub
	Copyright © 2023 - 2025 3CQS.com All Rights Reserved
	Licensed under Creative Commons Attribution-NonCommerical-ShareAlike 4.0 International (CC BY-NC-SA 4.0)

*/


const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Common = require(__dirname + '/libs/app/Common.js');
const Hub = require(__dirname + '/libs/app/Hub/Hub.js');
const HubMain = require(__dirname + '/libs/app/Hub/Main.js');
const HubWorker = require(__dirname + '/libs/app/Hub/Worker.js');
const WebServer = require(__dirname + '/libs/webserver/Hub');
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


async function startHub() {

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
					'HubMain': HubMain,
					'HubFilename': __filename,
					'workerMap': workerMap
		};

		HubMain.init(Worker, shareData, shutDown);

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

	HubMain.start(configs);

	setInterval(() => Hub.logMemoryUsage(), 5000);
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


async function start() {

	if (isMainThread) {

		startHub();
	}
	else {

		HubWorker.init(parentPort, shutdownTimeout);
		HubWorker.start(workerData);
	}
}


start();
