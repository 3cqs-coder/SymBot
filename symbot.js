'use strict';


/*

	SymBot
	Copyright © 2023 3CQS.com All Rights Reserved
	Licensed under Creative Commons Attribution-NonCommerical-ShareAlike 4.0 International (CC BY-NC-SA 4.0)

*/


const DB = require(__dirname + '/libs/mongodb');
const ServerDB = require(__dirname + '/libs/mongodb/ServerSchema');
const DCABot = require(__dirname + '/libs/strategies/DCABot/DCABot.js');
const DCABotManager = require(__dirname + '/libs/strategies/DCABot/DCABotManager.js');
const Signals3CQS = require(__dirname + '/libs/signals/3CQS/3cqs-signals-client.js');
const Common = require(__dirname + '/libs/Common.js');
const Telegram = require(__dirname + '/libs/telegram');
const WebServer = require(__dirname + '/libs/webserver');
const packageJson = require(__dirname + '/package.json');
const Dependencies = require('check-dependencies').sync({ verbose: false });



const prompt = require('prompt-sync')({
	sigint: true
});

let appDataConfig;
let gotSigInt = false;


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
	let consoleLog = false;

	if (process.argv[2] && process.argv[2].toLowerCase() == 'consolelog') {

		consoleLog = true;
	}

	Common.logger('Starting ' + packageJson.description + ' v' + packageJson.version, true);

	await checkDependencies();

	let appConfig = await Common.getConfig('app.json');
	let signalConfigs = await Common.getSignalConfigs();

	let signalConfigsData = signalConfigs.data;

	const serverConfig = await Common.getConfig('server.json');

	if (appConfig['data']['api_key'] == undefined || appConfig['data']['api_key'] == null || appConfig['data']['api_key'] == '') {

		let appConfigObj = JSON.parse(JSON.stringify(appConfig));

		apiKey = Common.uuidv4();
		appConfigObj['data']['api_key'] = apiKey;

		await Common.saveConfig('app.json', appConfigObj.data);
	}
	else {

		apiKey = appConfig['data']['api_key'];
	}

	if (appConfig['data']['password'] == undefined || appConfig['data']['password'] == null || appConfig['data']['password'] == '' || appConfig['data']['password'].indexOf(':') == -1) {

		const dataPass = await Common.genPasswordHash('admin');

		appConfig['data']['password'] = dataPass['salt'] + ':' + dataPass['hash'];

		let appConfigObj = JSON.parse(JSON.stringify(appConfig));

		await Common.saveConfig('app.json', appConfigObj.data);
	}

	if (signalConfigs.success && Object.keys(signalConfigsData).length > 0) {

		let startSubsObj = {};

		for (let key in signalConfigsData) {

			let signalObj = {};

			let startConditions = signalConfigsData[key]['start_conditions'];
			let startConditionsSub = signalConfigsData[key]['start_conditions_sub'];

			for (let num in startConditions) {

				let id = startConditions[num]['id'];
				let description = startConditions[num]['description'];

				let signalId = 'signal|' + key + '|' + id;

				description = 'Signal ' + key + ': ' + description;

				signalObj[signalId] = {};
				signalObj[signalId]['description'] = description;
			}

			if (startSubsObj[key] == undefined || startSubsObj[key] == null) {

				startSubsObj[key] = {};

				for (let num in startConditionsSub) {

					let id = startConditionsSub[num]['id'];
					let description = startConditionsSub[num]['description'];

					let signalId = 'signalsub|' + key + '|' + id;

					startSubsObj[key][signalId] = {};
					startSubsObj[key][signalId]['description'] = description;
				}

				appConfig['data']['bots']['start_conditions_sub'] = Object.assign({}, appConfig['data']['bots']['start_conditions_sub'], startSubsObj[key]);
			}

			appConfig['data']['bots']['start_conditions'] = Object.assign({}, appConfig['data']['bots']['start_conditions'], signalObj);
		}
	}

	let shareData = {
						'appData': {
										'name': packageJson.description,
										'version': packageJson.version,
										'server_id': '',
										'app_filename': __filename,
										'console_log': consoleLog,
										'mongo_db_url': appConfig['data']['mongo_db_url'],
										'web_server_port': appConfig['data']['web_server']['port'],
										'exchanges': {},
										'api_key': apiKey,
										'password': appConfig['data']['password'],
										'bots': appConfig['data']['bots'],
										'telegram_id': appConfig['data']['telegram']['notify_user_id'],
										'telegram_enabled': appConfig['data']['telegram']['enabled'],
										'webhook_enabled': appConfig['data']['webhook']['enabled'],
										'verboseLog': appConfig.data.verbose_log,
										'sig_int': false,
										'started': new Date()
								   },
						'DB': DB,
						'Signals3CQS': Signals3CQS,
						'DCABot': DCABot,
						'DCABotManager': DCABotManager,
						'Common': Common,
						'Telegram': Telegram,
						'WebServer': WebServer
					};

	appDataConfig = shareData.appData;

	DB.init(shareData);
	Signals3CQS.init(shareData);
	DCABot.init(shareData);
	DCABotManager.init(shareData);
	Telegram.init(shareData);
	WebServer.init(shareData);
	Common.init(shareData);

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

		let dbStarted =	await DB.start(appConfig.data.mongo_db_url);

		if (!dbStarted) {

			success = false;
		}
		else {

			let res = await verifyServerId(serverConfig);
			
			if (!res.success) {

				success = false;
			}
			else {

				shareData.appData.server_id = res.server_id;
			}
		}
	}

	if (success && process.argv[2] && process.argv[2].toLowerCase() == 'reset') {

		reset();

		return({ 'nostart': true });
	}

	if (success) {

		const processInfo = await Common.getProcessInfo();

		Telegram.start(appConfig['data']['telegram']['token_id']);
		WebServer.start(appConfig['data']['web_server']['port']);

		setTimeout(() => {

			let msg = appDataConfig.name + ' v' + appDataConfig.version + ' started at ' + new Date(appDataConfig.started).toISOString();

			Common.sendNotification({ 'message': msg, 'telegram_id': appDataConfig.telegram_id });

		}, 1000);
	}

	return({ 'success': success, 'app_config': appConfig });
}


async function verifyServerId(serverConfig) {

	let success = true;
	let serverId;

	const serverData = await ServerDB.ServerSchema.findOne({ 'serverId': { $exists: true } });

	if (!serverData) {

		serverId = Common.uuidv4();

		try {

				const data = new ServerDB.ServerSchema({

										'serverId': serverId,
										'created': Date.now(),
									});

				await data.save();

				await Common.saveConfig('server.json', { 'server_id': serverId });
			}
			catch(e) {

				success = false;

				Common.logger('Failed to create server database', true);
			}
	}
	else {

		if (!process.env.DOCKER_RUNNING && serverConfig.data.server_id != serverData.serverId) {

			success = false;

			Common.logger('Server ID mismatch', true);
		}
		else {

			serverId = serverData.serverId;
		}
	}

	return ({ 'success': success, 'server_id': serverId });
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


async function reset() {

	// Reset database from command line

	let success = false;

	let confirm;
	let resetCode = Math.floor(Math.random() * 1000000000);

	console.log('\n*** CAUTION *** You are about to reset ' + appDataConfig.name + ' database!\n');

	confirm = prompt('Do you want to continue? (Y/n): ');

	if (confirm == 'Y') {

		console.log('\nReset code: ' + resetCode);

		confirm = prompt('Enter the reset code above to reset ' + appDataConfig.name + ' database: ');
			
		if (confirm == resetCode) {

			confirm = prompt('Final warning before reset. Do you want to continue? (Y/n): ');

			if (confirm == 'Y') {

				success = true;

				let collectionBots = await DB.mongoose.connection.db.dropCollection('bots').catch(e => {});
				let collectionDeals = await DB.mongoose.connection.db.dropCollection('deals').catch(e => {});

				console.log('Bots reset: ' + collectionBots);
				console.log('Deals reset: ' + collectionDeals);

				console.log('\nReset finished.');
			}
		}
		else {

			console.log('\nReset code incorrect.');
		}
	}

	if (!success) {

		console.log('\nReset aborted.');
	}

	process.exit(1);
}


async function start() {

	let initData;

	await Common.makeDir('logs');
	await Common.makeDir('logs/services');
	await Common.makeDir('logs/services/notifications');

	try {

		initData = await init();
	}
	catch(e) {

		Common.logger('Initialization error: ' + e, true);

		shutDown();
		return;
	}

	if (initData.nostart) {

		return;
	}

	if (initData.success) {

		const appConfig = initData.app_config;
		const botConfig = await Common.getConfig('bot.json');

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

						 }, 2000);
	}
}


start();
