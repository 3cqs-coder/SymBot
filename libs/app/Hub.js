'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const net = require('net');
const ccxt = require('ccxt');


let shareData;


async function validateConfig(configsArr, isNew) {

	let configs = JSON.parse(JSON.stringify(configsArr));

    const mongoUrlsFromOverrides = new Set();
    const effectiveMongoDbUrls = new Set();
    const webPorts = new Map();
    const botConfigs = new Set();
    const serverIds = new Set();
    const overrideServerIds = new Set();
    const instanceNames = new Set();
    const appConfigs = new Set();
    const rootServerIds = new Set();

    const isValid = value => value !== undefined && value !== null && value !== '';
    const isAlphanumericOrDash = value => /^[a-zA-Z0-9-]+$/.test(value);

    let errors = [];
    let warnings = [];

    for (const instance of configs) {
        // Validate instance name
        if (!isValid(instance.name) || !isValid(instance.bot_config)) {
            errors.push(`Invalid configuration for instance '${instance.name}': Missing required fields.`);
            continue;
        }
        
        // Ensure the instance name is alphanumeric or contains dashes
        if (!isAlphanumericOrDash(instance.name)) {
            errors.push(`Invalid instance name '${instance.name}': Only alphanumeric characters and dashes are allowed.`);
            continue;
        }

        // Check for duplicate instance names
        if (instanceNames.has(instance.name)) {
            errors.push(`Duplicate instance name found: '${instance.name}'`);
            continue;
        }
        instanceNames.add(instance.name);

        // Track app_config if valid
        if (isValid(instance.app_config)) {
            appConfigs.add(instance.app_config);
        }

        // Track root server_id
        const serverConfigServerId = instance.server_id;
        if (isValid(serverConfigServerId)) {
            rootServerIds.add(serverConfigServerId);
        }

        const { mongo_db_url, web_server_port, server_id } = instance.overrides || {};

        // Determine effective MongoDB URL (prefer override if present)
        const effectiveMongoDbUrl = isValid(mongo_db_url) ? mongo_db_url : instance.mongo_db_url;

        if (!isValid(effectiveMongoDbUrl)) {
            errors.push(`Invalid configuration for instance '${instance.name}': mongo_db_url is missing or empty.`);
            continue;
        }

        // Check and track mongo_db_url
        if (isValid(mongo_db_url) && mongoUrlsFromOverrides.has(mongo_db_url)) {
            errors.push(`Duplicate mongo_db_url found for instance '${instance.name}': ${mongo_db_url}`);
            continue;
        }
        if (isValid(mongo_db_url)) {
            mongoUrlsFromOverrides.add(mongo_db_url);
        }

        // Check and track effectiveMongoDbUrl
        if (effectiveMongoDbUrls.has(effectiveMongoDbUrl)) {
            errors.push(`Duplicate effectiveMongoDbUrl found for instance '${instance.name}': ${effectiveMongoDbUrl}`);
            continue;
        }
        effectiveMongoDbUrls.add(effectiveMongoDbUrl);

        // Determine effective web server port (prefer override if present)
        const effectiveWebPort = isValid(web_server_port) ? web_server_port : instance.web_server_port;
        const portNumber = Number(effectiveWebPort);

        if (!isValid(effectiveWebPort) || isNaN(portNumber)) {
            errors.push(`Invalid configuration for instance '${instance.name}': web_server_port is missing or invalid.`);
            continue;
        }

        // Track the web server port and check for duplicates
        if (webPorts.has(portNumber)) {
            webPorts.get(portNumber).push(instance.name);
        } else {
            webPorts.set(portNumber, [instance.name]);
        }

        // Check and track bot_config
        if (botConfigs.has(instance.bot_config)) {
            warnings.push(`*** WARNING ***: Duplicate bot_config found for instance '${instance.name}': ${instance.bot_config}. This could cause trading issues if set to the wrong exchange or with incorrect credentials`);
        }
        botConfigs.add(instance.bot_config);

        // Determine effective server_id (prefer override if present)
        const effectiveServerId = isValid(server_id) ? server_id : serverConfigServerId;

        if (!isValid(effectiveServerId) && !isNew) {
            errors.push(`Invalid configuration for instance '${instance.name}': server_id is missing or empty.`);
            continue;
        }

        // Check for duplicate server_ids in root config
        if (isValid(server_id)) {
            if (overrideServerIds.has(server_id)) {
                errors.push(`Invalid override for instance '${instance.name}': server_id '${server_id}' is already used in another override.`);
                continue;
            }
            overrideServerIds.add(server_id);
        }

        // Track root server_ids
        if (isValid(effectiveServerId) && !isNew && serverIds.has(effectiveServerId)) {
            errors.push(`Duplicate server_id found for instance '${instance.name}': ${effectiveServerId}`);
            continue;
        }
        serverIds.add(effectiveServerId);
    }

    // Check for duplicate web server ports
    for (const [port, instances] of webPorts.entries()) {
        if (instances.length > 1) {
            errors.push(`Duplicate web_server_port found for instances: ${instances.join(", ")}: ${port}`);
        }
    }

    // Return success as false if there are any errors, otherwise true
    return {
        'success': errors.length === 0,
        'error': errors,
        'warnings': warnings,
        'configs': {
            'mongo_db_urls_overrides': [...mongoUrlsFromOverrides],
            'mongo_db_urls': [...effectiveMongoDbUrls],
            'web_server_ports': Array.from(webPorts.keys()),
            'bot_configs': [...botConfigs],
            'server_ids': [...serverIds],
            'instance_names': [...instanceNames],
            'app_configs': [...appConfigs]
        }
    };
}


async function processConfig(configsArr) {

	let configs = JSON.parse(JSON.stringify(configsArr));

	let configsUpdated = [];

	for (let i = 0; i < configs.length; i++) {

		let instance = configs[i];

		const appConfig = await shareData.Common.getConfig(instance['app_config']);

		// Set primary configuration parameters
		if (appConfig.success) {

			let serverId;
			let isUpdated = false;

			const serverConfig = await shareData.Common.getConfig(instance['server_config']);

			if (serverConfig.success) {

				serverId = serverConfig['data']['server_id'];
			}

			// Verify if Hub configuration instance matches app config. If not, overwrite app config
			if (appConfig['data']['web_server']['port'] != instance['web_server_port']) {

				isUpdated = true;

				// Only apply if Hub instance config has a defined port, otherwise use app config
				if (instance['web_server_port'] != undefined && instance['web_server_port'] != null && instance['web_server_port'] != '') {

					appConfig['data']['web_server']['port'] = instance['web_server_port'];
				}
			}

			const mongoDbUrl = appConfig['data']['mongo_db_url'];
			const webServerPort = appConfig['data']['web_server']['port'];

			instance['server_id'] = serverId;
			instance['mongo_db_url'] = mongoDbUrl;
			instance['web_server_port'] = webServerPort;

			if (isUpdated) {

				const dataObj = { 'file_name': instance['app_config'], 'app_config': appConfig };

				configsUpdated.push(dataObj);
			}
		}
	}

	const validate = await validateConfig(configs);

	if (validate.success && configsUpdated.length > 0) {

		for (let i = 0; i < configsUpdated.length; i++) {

			const config = configsUpdated[i];

			const fileName = config.file_name;
			const appConfig = config.app_config;

			await shareData.Common.saveConfig(fileName, appConfig.data);
		}
	}

	const webServerPorts = validate.configs['web_server_ports'];

	return { 'success': validate.success, 'error': validate.error, 'configs': configs, 'web_server_ports': webServerPorts };
}


async function createConfigFiles(exchange, configs) {

	const pathRootConfig = shareData.appData.path_root + '/config/';

	for (let i = 0; i < configs.length; i++) {

		const config = configs[i];

		const appFile = config['app_config'];
		const botFile = config['bot_config'];

		const appFilePath = pathRootConfig + appFile;
		const botFilePath = pathRootConfig + botFile;

		if (!fs.existsSync(appFilePath)) {

			await copyAndClearValues(pathRootConfig + 'app.json', appFilePath, false);
		}

		if (!fs.existsSync(botFilePath)) {

			await copyAndClearValues(pathRootConfig + 'bot.json', botFilePath, false);

			// New bot config file. Set exchange and sandbox mode
			const botConfig = await shareData.Common.getConfig(botFile);

			let configObj = botConfig.data;

			// Remove credentials
			for (let key in configObj) {

				if (key.substring(0, 3).toLowerCase() == 'api') {
		
					configObj[key] = '';
				}
			}

			if (exchange != undefined && exchange != null && exchange != '') {

				configObj['exchange'] = exchange;
			}

			configObj['sandBox'] = true;

			await shareData.Common.saveConfig(botFile, configObj);
		}
	}
}


async function copyAndClearValues(dataFile, outputFile, clear) {

	const dataFilePath = dataFile;
	const outputFilePath = outputFile;

	try {

		// Check if the output file exists
		await fsp.access(outputFilePath).catch(async () => {

			// If outputFile does not exist, proceed with copying and clearing
			const fileData = JSON.parse(await fsp.readFile(dataFilePath, 'utf8'));

			// Clear all values in the fileData object
			const clearedData = Object.keys(fileData).reduce((acc, key) => {
				acc[key] = '';
				return acc;
			}, {});

			let outData = fileData;

			if (clear) {

				outData = clearedData;
			}

			await fsp.writeFile(outputFilePath, JSON.stringify(outData, null, 2), 'utf8');
		});
	} 
    catch (err) {

        logger('error', err.message);
	}
}


async function routeAddInstance(req, res) {

	let configs = [];

	let message;
	let enabled;
	let exchange;
	let instanceId;
	let appConfig;
	let serverConfig;
	let serverId;
	let serverIdOverride;
	let serverIdFound;
	let mongoDbUrl;
	let mongoDbUrlOverride;
	let webServerPort;
	let webServerPortOverride;
	let telegramEnabledOverride;
	let signals3CQSEnabledOverride;

	let success = true;
	let appConfigCopy = false;

	let maxSec = 20;

	const body = req.body;

	const instanceName = body['name'];

	const hubData = await shareData.Common.getConfig(shareData.appData.hub_config);

	if (hubData.success) {

		configs = hubData.data.instances;
	}

	if (!configs.some(c => c.name === instanceName)) {

		instanceId = shareData.Common.uuidv4();
		exchange = body['exchange'];
		appConfig = body['app_config'];
		//serverConfig = body['server_config'];
		//serverIdOverride = body['overrides']['server_id'];
		mongoDbUrl = body['mongo_db_url'];
		mongoDbUrlOverride = body['overrides']['mongo_db_url'];
		webServerPort = body['web_server_port'];
		webServerPortOverride = body['overrides']['web_server_port'];
		enabled = shareData.Common.convertBoolean(body['enabled'], false);
		telegramEnabledOverride = shareData.Common.convertBoolean(body['overrides']['telegram_enabled'], body['overrides']['telegram_enabled']);
		signals3CQSEnabledOverride = shareData.Common.convertBoolean(body['overrides']['signals_3cqs_enabled'], body['overrides']['signals_3cqs_enabled']);

		const validateOrig = await validateConfig(configs, true);

		const appConfigs = validateOrig.configs.app_configs;

		if (appConfigs.length < 1) {

			appConfigCopy = false;

			serverConfig = await genServerConfigName(appConfig);
		}
		else {
			
			// Find matching server config
			for (let i = 0; i < configs.length; i++) {

				let config = configs[i];

				if (appConfig == config['app_config']) {

					serverConfig = config['server_config'];
					break;
				}
			}

			for (let i = 0; i < appConfigs.length; i++) {

				if (appConfig == appConfigs[i] && mongoDbUrl != undefined && mongoDbUrl != null && mongoDbUrl != '') {
		
					appConfigCopy = true;
		
					//res.status(400).send(appConfig + ' already exists. Use Mongo DB URL override instead of change the app config name.');
		
					//return;
		
					const appConfigOrig = await shareData.Common.getConfig(appConfig);
					const serverConfigOrig = await shareData.Common.getConfig(serverConfig);
		
					if (serverConfigOrig.success) {
		
						serverId = serverConfigOrig['data']['server_id'];
		
						// Generate server ID to use for new instance
						serverIdOverride = shareData.Common.uuidv4();

						serverIdFound = serverIdOverride;
					}

					// Set Mongo DB Url override and other params instead since app config found and replace override
		
					webServerPortOverride = webServerPort;
					webServerPort = appConfigOrig['data']['web_server']['port'];
		
					mongoDbUrlOverride = mongoDbUrl;
					mongoDbUrl = appConfigOrig['data']['mongo_db_url'];
		
					break;
				}
				else {
	
					appConfigCopy = false;

					serverConfig = await genServerConfigName(appConfig);
				}
			}
		}

		const configNew = {
			'id': instanceId,
			'name': instanceName,
			'mongo_db_url': mongoDbUrl,
			'web_server_port': webServerPort,
			'app_config': appConfig,
			'bot_config': body['bot_config'],
			'server_config': serverConfig,
			'server_id': serverId,
			'enabled': enabled,
			'overrides': {
				'server_id': serverIdOverride,
				'mongo_db_url': mongoDbUrlOverride,
				'web_server_port': webServerPortOverride,
				'telegram_enabled': telegramEnabledOverride,
				'signals_3cqs_enabled': signals3CQSEnabledOverride
			}
		};

		configs.push(configNew);

		//console.log(configs);

		const validateNew = await validateConfig(configs, true);

		if (validateNew.success) {

			await createConfigFiles(exchange, configs);

			//if (appConfigCopy) {

				// Set and save to new app config after creating files
				const appConfigNew = await shareData.Common.getConfig(configNew.app_config);

				let appDataNew = appConfigNew.data;

				appDataNew['mongo_db_url'] = configNew.mongo_db_url;
				appDataNew['web_server']['port'] = configNew.web_server_port;

				await shareData.Common.saveConfig(configNew.app_config, appDataNew);
			//}

			/*
			let hubDataNew = hubData.data;
			hubDataNew.instances = configs;

			await shareData.Common.saveConfig(shareData.appData.hub_config, hubDataNew);
			*/

			try {
				await startInstance(configNew);

				logger('info', `Successfully started worker for ${instanceName}`);

				// Wait short delay for instance to come online
				await shareData.Common.delay(5000);

				// Terminate intance if not enabled after adding
				if (instanceId && !enabled) {
			
					await terminateInstance(instanceId);
				}
			}
			catch (err) {

				logger('error', `Error starting worker for ${instanceName}: ${err.message}`);
			}

			let count = 0;

			let finished = false;

			while (!finished && !appConfigCopy) {

				// Wait until SymBot starts and creates new server.config
				const serverConfigData = await shareData.Common.getConfig(serverConfig);

				if (serverConfigData.success) {
	
					const serverId = serverConfigData['data']['server_id'];

					serverIdFound = serverId;
					finished = true;
				}
				else {

					await shareData.Common.delay(1000);
				}

				if (count > maxSec) {

					finished = true;
				}

				count++;
			}

			if (appConfigCopy || (serverIdFound != undefined && serverIdFound != null && serverIdFound != '')) {

				for (let i = 0; i < configs.length; i++) {

					const config = configs[i];

					if (config.id == instanceId) {

						// Set server ID
						config.server_id = serverIdFound;

						break;
					}
				}

				let hubDataNew = hubData.data;
				hubDataNew.instances = configs;

				await shareData.Common.saveConfig(shareData.appData.hub_config, hubDataNew);

				const validate = await validateConfig(configs);

				if (validate.success) {

					await setProxyPorts(validate.configs['web_server_ports']);
				}
	
			}
			else {

				// Don't save configuration and remove new files here
				success = false;
				message = 'Failed: Unable to get new server ID';
			}
		}
		else {

			success = false;
			message = 'Failed: ' + JSON.stringify(validateNew.error);
		}
	}
	else {

		success = false;
		message = 'Instance already exists';
	}
	
	res.send({ 'success': success, 'message': message });
}


async function genServerConfigName(appConfig) {
		
	// New app configuration so set similar server name
	let baseName = appConfig.split('.')[0];
	let serverConfigName = `server-${baseName}.json`;

	return serverConfigName;
}


async function setProxyPorts(ports) {

	// Set any port changes for proxy
	shareData.appData['web_server_ports'] = ports;
}


async function routeUpdateInstances(req, res) {

	let updatedAppConfigs = {};
	let workersRestart = [];

	let workerTerminate = false;
	let success = true;
	let message = 'Success!';

	// Retrieve the original configurations
	const hubData = await shareData.Common.getConfig(shareData.appData.hub_config);

	if (!hubData.success) {

		success = false;
		message = 'Failed to retrieve hub configuration.';
	}
	else {

		try {

			const originalConfigs = hubData.data.instances;
			const updatedConfigs = req.body;

			const validate = await validateConfig(updatedConfigs);

			if (!validate.success) {

				success = false;
				message = 'Invalid configuration provided. ' + JSON.stringify(validate.error);
			}
			else {

				await setProxyPorts(validate.configs['web_server_ports']);
			}

			if (success) {

				// Convert to booleans
				updatedConfigs.forEach(config => {

					if (config.overrides && 'telegram_enabled' in config.overrides) {

						config.overrides.telegram_enabled = shareData.Common.convertBoolean(config.overrides.telegram_enabled);
					}

					if (config.overrides && 'signals_3cqs_enabled' in config.overrides) {

						config.overrides.signals_3cqs_enabled = shareData.Common.convertBoolean(config.overrides.signals_3cqs_enabled);
					}
				});


				updatedConfigs.forEach(config => {

					config.enabled = shareData.Common.convertBoolean(config.enabled, false);
					config.start_boot = shareData.Common.convertBoolean(config.start_boot, false);
				});


				const isConfigChanged = (original, updated) => {

					// Ignore 'name_orig' and 'updated' fields for comparison
					const {
						name_orig,
						exchange,
						updated: originalUpdated,
						...originalFiltered
					} = original;

					const {
						name_orig: _,
						exchange: __,
						updated: updatedUpdated,
						...updatedFiltered
					} = updated;

					// Apply 'updated' field from original to updated
					updated.updated = original.updated;

					return JSON.stringify(originalFiltered) !== JSON.stringify(updatedFiltered);
				};


				for (const updatedConfig of updatedConfigs) {

					let serverUpdated = false;
					let portUpdated = false;
					let mongoDbUrlUpdated = false;

					const appDataOrig = await shareData.Common.getConfig(updatedConfig.app_config);
					let appConfig = appDataOrig;

					// Add this to update check to not keep saving
					const serverConfig = await shareData.Common.getConfig(updatedConfig['server_config']);

					if (serverConfig.success) {

						const serverId = serverConfig['data']['server_id'];

						if (serverId != updatedConfig['server_id']) {

							serverUpdated = true;

							serverConfig.data.server_id = updatedConfig['server_id'];

							await shareData.Common.saveConfig(updatedConfig.server_config, serverConfig.data);
						}
					}

					if (!updatedConfig['overrides']['server_id'] && updatedConfig['mongo_db_url'] && (updatedConfig.mongo_db_url != updatedConfig['mongo_db_url'])) {

						mongoDbUrlUpdated = true;
					}

					// Update any port changes in app configs
					if (appConfig['data']['mongo_db_url'] != updatedConfig.mongo_db_url) {

						mongoDbUrlUpdated = true;

						if (!updatedAppConfigs[updatedConfig.app_config] || updatedAppConfigs[updatedConfig.app_config] !== updatedConfig.mongo_db_url) {

							appConfig['data']['mongo_db_url'] = updatedConfig.mongo_db_url;
							updatedAppConfigs[updatedConfig.app_config] = updatedConfig.mongo_db_url;
						}
					}

					if (!updatedConfig['overrides']['server_id'] && updatedConfig['overrides']['web_server_port'] && (updatedConfig.web_server_port != updatedConfig['overrides']['web_server_port'])) {

						// Port override set on primary instance
						//portUpdated = true;

						const webServerPortOverride = updatedConfig.web_server_port;
						const result = await checkPortInUse(webServerPortOverride);

						if (!result.success) {

							//console.log('Port is in use.');
						}
					}

					// Update any port changes in app configs
					if (appConfig['data']['web_server']['port'] != updatedConfig.web_server_port) {

						portUpdated = true;

						if (!updatedAppConfigs[updatedConfig.app_config] || updatedAppConfigs[updatedConfig.app_config] !== updatedConfig.web_server_port) {

							const webServerPort = updatedConfig.web_server_port
							const result = await checkPortInUse(webServerPort);

							if (!result.success) {

								//console.log('Port is in use.');
							}

							appConfig['data']['web_server']['port'] = webServerPort;
							updatedAppConfigs[updatedConfig.app_config] = webServerPort;
						}
					}

					// Find corresponding original config for comparison
					const originalConfig = originalConfigs.find(cfg => cfg.id === updatedConfig.id);

					// Check if there are any changes between original and updated config
					const configChanged = originalConfig && isConfigChanged(originalConfig, updatedConfig);

					const {
						id: instanceId,
						name: instanceName,
						name_orig: instanceNameOrig
					} = updatedConfig;

					if (!updatedConfig.enabled) {
	
						workerTerminate = true;

						await terminateInstance(instanceId);
					}

					// Only restart workers if the config has changed or portUpdated is true
					if (configChanged || serverUpdated || portUpdated || mongoDbUrlUpdated) {

						// Set new updated date
						updatedConfig.updated = new Date().toISOString();

						await shareData.Common.saveConfig(updatedConfig.app_config, appConfig.data);

						// Only restart if enabled
						if (!workerTerminate && updatedConfig.enabled) {

							const instanceResult = await getInstance(instanceId);

							if (instanceResult.success) {

								workersRestart.push({
									id: instanceId,
									name: instanceName,
									name_orig: instanceNameOrig,
									worker_id: instanceResult.worker_id,
									worker: instanceResult.worker,
									config: updatedConfig
								});
							}
						}
					}
				}

				// Restart workers for the modified instances
				if (workersRestart.length > 0) {

					for (const workerInstance of workersRestart) {

						const {
							id: instanceId,
							name: instanceName,
							name_orig: instanceNameOrig,
							worker_id: workerId,
							config
						} = workerInstance;

						await terminateInstance(instanceId);

						// Start a new worker with updated config
						try {

							await startInstance(config);

							logger('info', `Successfully restarted worker for ${instanceName}`);
						}
						catch (err) {

							logger('error', `Error restarting worker for ${instanceName}: ${err.message}`);
						}
					}
				}

				// Check for error above before saving
				await createConfigFiles('', updatedConfigs);

				const cleanedConfigs = updatedConfigs.map(({
					name_orig,
					...rest
				}) => rest);

				let hubDataNew = hubData.data;
				hubDataNew.instances = cleanedConfigs;

				await shareData.Common.saveConfig(shareData.appData.hub_config, hubDataNew);
			}
		}
		catch (error) {

			success = false;

			logger('error', `Error in routeUpdateInstances: ${error.message}`);
			message = 'Error: ' + error.message;
		}
	}

	res.send({ 'success': success, 'message': message });
}


async function getInstance(instanceId) {

    let worker;
    let workerId;
    let instanceName;
    let success = false;

    for (const [id, { worker: w, instance }] of shareData.workerMap.entries()) {

        if (instance.id === instanceId) {

            workerId = id;
            worker = w;
            instanceName = instance.name;

            success = true;

            break;
        }
    }

    return { success, name: instanceName, worker_id: workerId, worker };
}


async function startInstance(instanceConfig) {

	shareData.startWorker({
		...instanceConfig
	});
}


async function terminateInstance(instanceId) {

	try {

		const instanceResult = await getInstance(instanceId);

		if (instanceResult.success) {

			const workerId = instanceResult['worker_id'];
			const { worker } = shareData.workerMap.get(workerId) || {};

			if (worker) {

				// Wait until shutdown_received is received from worker and delay has passed
				await new Promise((resolve, reject) => {

					worker.on('message', async (message) => {

						if (message.type === 'shutdown_received') {

							try {

								// Wait additional delay to ensure graceful shutdown
								await shareData.Common.delay(shareData.appData['shutdown_timeout'] + 3000);

								// Terminate the worker after the delay
								await worker.terminate();

								logger('info', `Worker ${workerId} terminated.`);

								resolve();
							}
							catch (err) {
							
								logger('error', `Error terminating instance: ${err}`);
							
								reject(err);
							}
						}
					});

					// Send a "shutdown" message to the worker
					worker.postMessage({

						type: 'shutdown'
					});
				});
			}
		}
	}
	catch (error) {

		console.error(`Failed to retrieve instance ${instanceId}:`, error);
	}
}


async function routeStartWorker(req, res) {

	try {

		let configs;

		const hubData = await shareData.Common.getConfig(shareData.appData.hub_config);

		if (hubData.success) {

			configs = hubData.data.instances;
		}
		else {

			return res.status(500).send('Failed to retrieve hub configuration.');
		}

		const { id: instanceId } = req.body;

		// Find the instance config
		const instanceConfig = configs.find(c => c.id === instanceId);

		if (!instanceConfig) {

			return res.status(404).send('Instance config not found');
		}

		if (instanceConfig.enabled) {

			// Check if the instance is already running
			const {
				success,
				worker,
				worker_id: workerId
			} = await getInstance(instanceId);

			if (success && worker) {

				await terminateInstance(instanceId);
			}

			// Start worker with the new instance
			await startInstance(instanceConfig);

			res.redirect('/');
		}
		else {

			res.status(500).send('Instance is disabled');
		}
	}
	catch (error) {

		console.error('Error in routeStartWorker:', error);

		res.status(500).send('Server error: ' + error.message);
	}
}


async function routeUpdateConfig(req, res) {

	const body = req.body;
	const password = body.password;
	const passwordNew = body.passwordnew;
	const dataPass = shareData.appData.password.split(':');

	let success = await shareData.Common.verifyPasswordHash( { 'salt': dataPass[0], 'hash': dataPass[1], 'data': password } );

	if (success) {

		let data = await shareData.Common.getConfig('hub.json');

		let appConfig = data.data;

		if (passwordNew != undefined && passwordNew != null && passwordNew != '') {

			const dataPassNew = await shareData.Common.genPasswordHash({ 'data': passwordNew });

			const passwordHashed = dataPassNew['salt'] + ':' + dataPassNew['hash'];

			appConfig['password'] = passwordHashed;
			shareData['appData']['password'] = passwordHashed;
		}

		await shareData.Common.saveConfig('hub.json', appConfig);

		let obj = { 'success': true, 'data': 'Configuration Updated' };
		
		res.send(obj);
	}
	else {

		let obj = { 'success': false, 'data': 'Password Incorrect' };
		
		res.send(obj);
	}
}


async function getExchanges() {

	const exchanges = ccxt.exchanges;

	return exchanges;
}


async function checkPortInUse(port, host = '127.0.0.1') {

	return new Promise((resolve) => {
		const server = net.createServer();

		server.once('error', (err) => {

			if (err.code === 'EADDRINUSE') {
				resolve({
					success: true
				}); // Port is in use
			} else {
				resolve({
					success: false,
					error: err.message
				}); // Error occurred, port not in use but some issue
			}
		});

		server.once('listening', () => {

			server.close();

			resolve({ success: false });
		});

		server.listen(port, host);
	});
}


async function logger(type, msg) {

	const dateNow = new Date().toISOString();

	msg = dateNow + ' ' + msg;

	if (type == 'error') {

		console.error(msg);
	}
	else {

		console.log(msg);
	}

	try {

		// Relay message to WebSocket notifications room
		shareData.Common.sendSocketMsg({

			'room': 'notifications',
			'type': 'notification',
			'message': msg
		});
	}
	catch (e) {}
}



module.exports = {

	logger,
	routeAddInstance,
	routeUpdateInstances,
	routeUpdateConfig,
	routeStartWorker,
	processConfig,
	validateConfig,
	getExchanges,
	setProxyPorts,

	init: function(obj) {

		shareData = obj;
	},
};
