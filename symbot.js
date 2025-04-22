'use strict';


/*

	SymBot
	Copyright © 2023 - 2025 3CQS.com All Rights Reserved
	Licensed under Creative Commons Attribution-NonCommerical-ShareAlike 4.0 International (CC BY-NC-SA 4.0)

*/


const DB = require(__dirname + '/libs/mongodb');
const ServerDB = require(__dirname + '/libs/mongodb/ServerSchema');
const DCABot = require(__dirname + '/libs/strategies/DCABot/DCABot.js');
const DCABotManager = require(__dirname + '/libs/strategies/DCABot/DCABotManager.js');
const Signals3CQS = require(__dirname + '/libs/signals/3CQS/3cqs-signals-client.js');
const Common = require(__dirname + '/libs/app/Common.js');
const Queue = require(__dirname + '/libs/app/Queue.js');
const System = require(__dirname + '/libs/app/System.js');
const Telegram = require(__dirname + '/libs/telegram');
const WebServer = require(__dirname + '/libs/webserver');
const Ollama = require(__dirname + '/libs/ai/OllamaClient.js');
const packageJson = require(__dirname + '/package.json');
const Dependencies = require('check-dependencies').sync({ verbose: false });



let workerData;
let parentPortReference;
let appDataConfig;
let gotSigInt = false;
let shutdownTimeout = 2000;


process.on('SIGINT', shutDown);
process.on('SIGTERM', shutDown);


// Specifically for PM2 (Windows)
process.on('message', function(msg) {

	if (msg == 'shutdown') {

		shutDown();
	}
});


process.on('uncaughtException', function(err) {

	let logData = 'Uncaught Exception: ' + JSON.stringify(err.message) + ' Stack: ' + JSON.stringify(err.stack);

	Common.logger(logData, true);
});



async function init() {

	let apiKey;
	let apiKeySet;
	let apiKeyClear;
	let instanceName = '';

	let workerDataObj = {};
	let botConfigData = {};

	let isConfig = false;
	let isReset = false;
	let resetServerId = false;
	let consoleLog = false;
	let serverIdError = false;

	let appConfigFile = 'app.json';
	let botConfigFile = 'bot.json';
	let serverConfigFile = 'server.json';

	if (process.argv[2] && process.argv[2].toLowerCase() == 'consolelog') {

		consoleLog = true;
	}

	if (process.argv[2] && process.argv[2].toLowerCase() == 'config') {

		isConfig = true;
	}

	if(process.argv[2] && process.argv[2].toLowerCase() == 'clglite') {

		Common.logger('Lite mode enabled. All logs for this session will be written to console only.');
	}

	if (process.argv[2] && process.argv[2].toLowerCase() == 'reset') {

		isReset = true;

		if (process.argv[3] && process.argv[3].toLowerCase() == 'serverid') {

			resetServerId = true;
		}
	}

	if (workerData && typeof workerData === 'object') {

		workerDataObj = workerData;

		if (workerDataObj['name'] && workerDataObj['name'] != '') {

			instanceName = workerDataObj['name'];
		}

		if (workerDataObj['app_config'] && workerDataObj['app_config'] != '') {

			appConfigFile = workerDataObj['app_config'];
		}

		if (workerDataObj['bot_config'] && workerDataObj['bot_config'] != '') {

			botConfigFile = workerDataObj['bot_config'];
		}

		if (workerDataObj['server_config'] && workerDataObj['server_config'] != '') {

			serverConfigFile = workerDataObj['server_config'];
		}
	}

	Common.logger('Starting ' + packageJson.description + ' v' + packageJson.version, true);

	const { update_available } = await Common.validateAppVersion();
	await checkDependencies();

	let appConfig = await Common.getConfig(appConfigFile);
	let signalConfigs = await Common.getSignalConfigs();

	let signalConfigsData = signalConfigs.data;

	const botConfig = await Common.getConfig(botConfigFile);
	const serverConfig = await Common.getConfig(serverConfigFile);

	if (botConfig.success) {

		botConfigData = botConfig.data;
	}

	if (appConfig['data']['api']['key'] == undefined || appConfig['data']['api']['key'] == null || appConfig['data']['api']['key'] == '' || appConfig['data']['api']['key'].indexOf(':') == -1) {

		apiKeySet = false;

		apiKeyClear = Common.uuidv4();

		apiKey = await Common.genApiKey(apiKeyClear);

		appConfig['data']['api']['key'] = apiKey;

		let appConfigObj = JSON.parse(JSON.stringify(appConfig));

		await Common.saveConfig(appConfigFile, appConfigObj.data);
	}
	else {

		apiKeySet = true;
		apiKey = appConfig['data']['api']['key'];
	}

	if (appConfig['data']['password'] == undefined || appConfig['data']['password'] == null || appConfig['data']['password'] == '' || appConfig['data']['password'].indexOf(':') == -1) {

		const dataPass = await Common.genPasswordHash({'data': 'admin'});

		appConfig['data']['password'] = dataPass['salt'] + ':' + dataPass['hash'];

		let appConfigObj = JSON.parse(JSON.stringify(appConfig));

		await Common.saveConfig(appConfigFile, appConfigObj.data);
	}

	if (signalConfigs.success && Object.keys(signalConfigsData).length > 0) {

		let providerId;
		let providerName;

		let startSubsObj = {};
		let providerIdsObj = {};

		appConfig['data']['bots']['start_conditions_metadata'] = {};

		for (let key in signalConfigsData) {

			let signalObj = {};

			let startConditions = signalConfigsData[key]['start_conditions'];
			let startConditionsSub = signalConfigsData[key]['start_conditions_sub'];
			let startConditionsMeta = signalConfigsData[key]['metadata'];

			providerId = startConditionsMeta['provider_id'];
			providerName = startConditionsMeta['provider_name'];

			if (providerId == undefined || providerId == null || providerId == '') {

				signalConfigs.success = false;
				signalConfigs.error = 'Missing signal provider id: ' + signalConfigsData[key]['file'];

				break;
			}

			if (providerName == undefined || providerName == null || providerName == '') {

				signalConfigs.success = false;
				signalConfigs.error = 'Missing signal provider name: ' + signalConfigsData[key]['file'];

				break;
			}

			if (providerIdsObj[providerId] != undefined && providerIdsObj[providerId] != null) {

				signalConfigs.success = false;
				signalConfigs.error = 'Duplicate signal provider id: ' + providerId + ' in ' + signalConfigsData[key]['file'];

				break;
			}

			providerIdsObj[providerId] = 1;

			for (let num in startConditions) {

				let id = startConditions[num]['id'];
				let description = startConditions[num]['description'];

				let signalId = 'signal|' + providerId + '|' + id;

				description = 'Signal ' + providerName + ': ' + description;

				signalObj[signalId] = {};
				signalObj[signalId]['description'] = description;
			}

			if (startSubsObj[providerId] == undefined || startSubsObj[providerId] == null) {

				startSubsObj[providerId] = {};

				for (let num in startConditionsSub) {

					let id = startConditionsSub[num]['id'];
					let description = startConditionsSub[num]['description'];

					let signalId = 'signalsub|' + providerId + '|' + id;

					startSubsObj[providerId][signalId] = {};
					startSubsObj[providerId][signalId]['description'] = description;
				}

				appConfig['data']['bots']['start_conditions_sub'] = Object.assign({}, appConfig['data']['bots']['start_conditions_sub'], startSubsObj[providerId]);
			}

			appConfig['data']['bots']['start_conditions'] = Object.assign({}, appConfig['data']['bots']['start_conditions'], signalObj);
			appConfig['data']['bots']['start_conditions_metadata'][providerId] = startConditionsMeta;
		}
	}

	let telegramEnabled = appConfig['data']['telegram']['enabled'];

	let shareData = {
						'appData': {
										'name': packageJson.description + (instanceName ? '-' + instanceName : ''),
										'name_main': packageJson.description,
										'instance_name': instanceName,
										'version': packageJson.version,
										'update_available': update_available,
										'app_config': appConfigFile,
										'bot_config': botConfigFile,
										'server_config': serverConfigFile,
										'server_id': '',
										'app_filename': __filename,
										'console_log': consoleLog,
										'max_log_days': appConfig['data']['max_log_days'],
										'mongo_db_url': appConfig['data']['mongo_db_url'],
										'web_server_port': appConfig['data']['web_server']['port'],
										'web_socket_path': 'ws' + instanceName,
										'exchanges': {},
										'api_key': apiKey,
										'api_enabled': appConfig['data']['api']['enabled'],
										'webhook_enabled': appConfig['data']['webhook']['enabled'],
										'password': appConfig['data']['password'],
										'bots': appConfig['data']['bots'],
										'telegram_id': appConfig['data']['telegram']['notify_user_id'],
										'telegram_enabled': telegramEnabled,
										'telegram_enabled_config': telegramEnabled,
										'signals_3cqs_enabled': appConfig?.data?.signals?.['3CQS']?.enabled,
										'cron_backup': appConfig['data']['cron_backup'],
										'verboseLog': appConfig.data.verbose_log,
										'sig_int': false,
										'reset': isReset,
										'config_mode': false,
										'worker_data': workerData,
										'parent_port': parentPortReference,
										'started': new Date()
								   },
						'DB': DB,
						'Signals3CQS': Signals3CQS,
						'DCABot': DCABot,
						'DCABotManager': DCABotManager,
						'Common': Common,
						'Queue': Queue,
						'System': System,
						'Telegram': Telegram,
						'WebServer': WebServer,
						'Ollama': Ollama,
					};

	// Apply config overrides from hub
	if (Object.keys(workerDataObj).length > 0 && typeof workerDataObj['overrides'] === 'object') {

		const workerDataOverrides = workerDataObj['overrides'];

		if (workerDataOverrides['server_id'] != undefined && workerDataOverrides['server_id'] != null && workerDataOverrides['server_id'] != '') {

			const serverIdOverride = workerDataOverrides['server_id'];

			serverConfig['data']['server_id'] = serverIdOverride;
			serverConfig['data']['server_id_override'] = serverIdOverride;
		}

		if (workerDataOverrides['web_server_port'] != undefined && workerDataOverrides['web_server_port'] != null && workerDataOverrides['web_server_port'] != '') {

			shareData.appData['web_server_port'] = workerDataOverrides['web_server_port'];
		}

		if (workerDataOverrides['mongo_db_url'] != undefined && workerDataOverrides['mongo_db_url'] != null && workerDataOverrides['mongo_db_url'] != '') {

			shareData.appData['mongo_db_url'] = workerDataOverrides['mongo_db_url'];
		}

		if (workerDataOverrides['telegram_enabled'] !== undefined && workerDataOverrides['telegram_enabled'] !== null && workerDataOverrides['telegram_enabled'] !== '') {

			shareData.appData['telegram_enabled'] = Common.convertBoolean(workerDataOverrides['telegram_enabled'], false);
		}

		if (workerDataOverrides['signals_3cqs_enabled'] !== undefined && workerDataOverrides['signals_3cqs_enabled'] !== null && workerDataOverrides['signals_3cqs_enabled'] !== '') {

			shareData.appData['signals_3cqs_enabled'] = Common.convertBoolean(workerDataOverrides['signals_3cqs_enabled'], false);
		}
	}

	appDataConfig = shareData.appData;

	Common.init(shareData);
	Queue.init(shareData);
	DB.init(shareData);
	System.init(shareData, shutDown);
	Signals3CQS.init(shareData);
	DCABot.init(shareData);
	DCABotManager.init(shareData);
	Telegram.init(shareData);
	WebServer.init(shareData);
	Ollama.init(shareData);

	let success = true;

	if (!appConfig.success) {

		Common.logger('App configuration file error: ' + appConfig.data, true);

		success = false;
	}

	if (success) {

		if (!signalConfigs.success) {

			Common.logger('Signals configuration file error: ' + signalConfigs.error, true);

			success = false;
		}
	}

	if (success) {

		const dbUrl = appDataConfig.mongo_db_url;

		if (isConfig || (dbUrl == undefined || dbUrl == null || dbUrl == '')) {

			let setDbUrl;

			appDataConfig.config_mode = true;

			if (!process.env.DOCKER_RUNNING) {

				if (dbUrl) {

					setDbUrl = dbUrl;
				}
				else {

					setDbUrl = 'mongodb://127.0.0.1:27017/SymBot';
				}
			}
			else {

				if (dbUrl) {

					setDbUrl = dbUrl;
				}
				else {

					setDbUrl = 'mongodb://symbot:symbot123@database/symbot';
				}
			}

			appDataConfig.mongo_db_url = setDbUrl;

			Common.logger('WARNING: ' + appDataConfig.name + ' is running in configuration mode', true);
		}
		else {

			let dbStarted =	await DB.start(dbUrl);

			if (!dbStarted) {

				success = false;
			}
			else {

				await System.start(dbUrl);

				let res = await verifyServerId(serverConfigFile, serverConfig);

				serverIdError = res['server_id_error'];

				if (!res.success) {

					success = false;
				}
				else {

					shareData.appData.server_id = res.server_id;
				}
			}
		}
	}

	if (isReset && (success || serverIdError)) {

		await System.resetConsole(serverIdError, resetServerId);

		return({ 'nostart': true });
	}

	if (success) {

		// Set token
		await Common.setToken();

		if (!apiKeySet) {

			Common.logger('WARNING: ' + appDataConfig.name + ' API key was not set and has been auto generated as: ' + apiKeyClear + '. This will not be displayed again. It is strongly recommended to generate a new one using the web interface configuration.', true);
		}

		const processInfo = await Common.getProcessInfo();

		Telegram.start(appConfig['data']['telegram']['token_id'], appDataConfig['telegram_enabled']);
		WebServer.start(appDataConfig['web_server_port']);

		// Start AI / Ollama client
		const ollamaHost = appConfig['data']['ai']['ollama']['host'];
		const ollamaModel = appConfig['data']['ai']['ollama']['model'];

		Ollama.start(ollamaHost, ollamaModel);

		const TWELVE_HOURS = 12 * 60 * 60 * 1000;

		setInterval(async () => {

			const { update_available } = await Common.validateAppVersion();

			if(update_available && !shareData.appData.update_available) {

				shareData.appData.update_available = true;
			}
		}, TWELVE_HOURS)

		setTimeout(() => {

			let msg = appDataConfig.name + ' v' + appDataConfig.version + ' started at ' + new Date(appDataConfig.started).toISOString();

			Common.sendNotification({ 'message': msg, 'telegram_id': appDataConfig.telegram_id });

		}, 1000);
	}

	return({ 'success': success, 'app_config': appDataConfig, 'bot_config': botConfig });
}


async function verifyServerId(serverConfigFile, serverConfig) {

	let serverId;
	let success = true;
	let serverIdError = false;

	const serverData = await ServerDB.ServerSchema.findOne({ 'serverId': { $exists: true } });

	if (!serverData) {

		// Server ID not found in database
		let isOverride = false;

		const serverIdOverride = serverConfig.data.server_id_override;

		// Use override from Hub instead of generating new one
		if (serverIdOverride != undefined && serverIdOverride != null && serverIdOverride != '') {

			isOverride = true;
			serverId = serverIdOverride;
		}
		else {

			serverId = Common.uuidv4();
		}

		try {

				const data = new ServerDB.ServerSchema({

										'serverId': serverId,
										'created': Date.now(),
									});

				await data.save();

				// Only save if not override
				if (!isOverride) {

					await Common.saveConfig(serverConfigFile, { 'server_id': serverId });
				}
			}
			catch(e) {

				success = false;

				Common.logger('Failed to create server database', true);
			}
	}
	else {

		if (!process.env.DOCKER_RUNNING && serverConfig.data.server_id != serverData.serverId) {

			success = false;
			serverIdError = true;

			Common.logger('Server ID mismatch', true);
			Common.logger('Server ID database: ' + serverData.serverId, true);
			Common.logger('Server ID configuration: ' + serverConfig.data.server_id, true);
		}
		else {

			serverId = serverData.serverId;
		}
	}

	return ({ 'success': success, 'server_id': serverId, 'server_id_error': serverIdError });
}


async function checkDependencies() {

	if (Dependencies.error.length > 0) {

		const pref = 'WARNING: ';

		for (let i in Dependencies.error) {

			let dep = Dependencies.error[i];
	
			Common.logger(pref + dep, true);
		}

		Common.logger(pref + 'Packages installed do not match package list. You may want to update using npm install or another method', true);
	}
}


async function setInstanceConfig(config) {

	if (config && config.shutdownTimeout) {

		workerData = config;

		shutdownTimeout = config.shutdownTimeout;
	}
}


async function setInstanceParentPort(port) {

	parentPortReference = port;
}


async function start() {

	let initData;

	await Common.makeDir('backups');
	await Common.makeDir('uploads');
	await Common.makeDir('downloads');
	await Common.makeDir('temp');
	await Common.makeDir('logs');
	await Common.makeDir('logs/services');
	await Common.makeDir('logs/services/notifications');

	try {

		initData = await init();
	}
	catch(e) {

		Common.logger('Initialization error: ' + e, true);
		Common.logger('Please verify your configuration files have all required parameters', true);

		shutDown();
		return;
	}

	if (initData.nostart) {

		return;
	}

	if (initData.success) {

		const appConfig = initData.app_config;
		const botConfig = initData.bot_config;

		if (!botConfig.success) {

			Common.logger('Bot configuration file error: ' + botConfig.data, true);

			shutDown();
			return;
		}

		Common.logMonitor();
	}
	else {

		shutDown();
	}
}


function shutDown() {

	// Perform any post shutdown processes here

	if (!gotSigInt) {

		gotSigInt = true;

		Common.logger('Received kill signal. Shutting down gracefully.', true);

		if (appDataConfig != undefined && appDataConfig != null && appDataConfig != '') {

			appDataConfig['sig_int'] = true;

			let msg = appDataConfig.name + ' v' + appDataConfig.version + ' shutting down at ' + new Date().toISOString();

			Common.sendNotification({ 'message': msg, 'telegram_id': appDataConfig.telegram_id });
		}

		setTimeout(() => {
							process.exit(1);

						 }, shutdownTimeout);
	}
}


if (require.main === module) {

	start();
}


module.exports = {

	start,
	shutDown,
	setInstanceConfig,
	setInstanceParentPort,
	get DCABot() {
        return DCABot;
    },
	get System() {
        return System;
    }
}
