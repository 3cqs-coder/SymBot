'use strict';


/*

	SymBot
	Copyright © 2023 3CQS.com All Rights Reserved
	Licensed under Creative Commons Attribution-NonCommerical-ShareAlike 4.0 International (CC BY-NC-SA 4.0)

*/


const DB = require(__dirname + '/libs/mongodb');
const DCABot = require(__dirname + '/libs/strategies/DCABot/DCABot.js');
const DCABotManager = require(__dirname + '/libs/strategies/DCABot/DCABotManager.js');
const Signals3CQS = require(__dirname + '/libs/signals/3CQS/3cqs-signals-client.js');
const Common = require(__dirname + '/libs/Common.js');
const WebServer = require(__dirname + '/libs/webserver');
const packageJson = require(__dirname + '/package.json');

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

	Common.logger(logData);
});





async function init() {

	let success = true;

	Common.logger(DCABot.colors.bgBrightGreen.bold('Starting ' + packageJson.description + ' v' + packageJson.version));

	const appConfig = await Common.getConfig('app.json');

	let shareData = {
						'appData': {
										'name': packageJson.description,
										'version': packageJson.version,
										'verboseLog': appConfig.data.verbose_log,
										'started': new Date()
								   },
						'DB': DB,
						'DCABot': DCABot,
						'DCABotManager': DCABotManager,
						'Common': Common,
						'WebServer': WebServer
					};

	DB.init(shareData);
	DCABot.init(shareData);
	DCABotManager.init(shareData);
	WebServer.init(shareData);
	Signals3CQS.init(shareData);
	Common.init(shareData);

	if (!appConfig.success) {

		Common.logger('App configuration file error: ' + appConfig.data);

		success = false;
	}

	if (success) {

		let dbStarted =	await DB.start(appConfig.data.mongo_db_url);

		if (!dbStarted) {

			success = false;
		}
	}

	if (success) {

		WebServer.start(appConfig['data']['web_server']['port']);
	}

	return({ 'success': success, 'app_config': appConfig });
}


async function start() {

	let initData = await init();

	if (initData.success) {

		const appConfig = initData.app_config;
		const botConfig = await Common.getConfig('bot.json');

		if (!botConfig.success) {

			Common.logger('Bot configuration file error: ' + botConfig.data);

			shutDown();
			return;
		}

		// Get signals and start bot accordingly
		//const socket = await Signals3CQS.start(appConfig['data']['signals']['3CQS']['api_key']);
	}
	else {

		shutDown();
	}
}


function shutDown() {

	// Perform any post shutdown processes here

	if (!gotSigInt) {

		gotSigInt = true;

		Common.logger('Received kill signal. Shutting down gracefully.');

		setTimeout(() => {
							process.exit(1);

						 }, 1000);
	}
}


start();
