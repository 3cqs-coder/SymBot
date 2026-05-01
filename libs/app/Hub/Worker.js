'use strict';

const fs = require('fs');
const path = require('path');
const colors = require('colors');

const pathRoot = path.resolve(__dirname, '..', '..', '..'); 
const { HUB_TO_WORKER, WORKER_TO_HUB } = require(__dirname + '/MessageTypes.js');

let parentPort;
let shutdownTimeout;



async function processWorkerTask(instanceData) {

	// Worker thread logic

	try {

		const instanceName = instanceData.name;
		const prefData = `[WORKER-LOG] [${instanceName}] `;

		// Override all console methods to send messages back to the main thread
		function sendLog(level, msg) {
			
			parentPort.postMessage({
				type: WORKER_TO_HUB.LOG,
				level,
				data: prefData + msg
			});
		}

		// Override console methods
		['log', 'error', 'warn', 'info', 'debug'].forEach((method) => {

			console[method] = (...args) => {

				let text = args.join(' ');
				if (method === 'error') text = 'ERROR: ' + text;

				sendLog(method, text);
			};
		});

		// Override stream writes
		function overrideWrite(stream, level, prefix = '') {

			const origWrite = stream.write.bind(stream);

			stream.write = (chunk, encoding, callback) => {

				const text = Buffer.isBuffer(chunk) ? chunk.toString(encoding) : chunk;

				sendLog(level, prefix + text);

				return origWrite(chunk, encoding, callback);
			};
		}

		overrideWrite(process.stdout, 'log');
		overrideWrite(process.stderr, 'error', 'ERROR: ');

		console.log(colors.bgBlack.brightYellow.bold(`Starting Instance: ${instanceName}`));

		const SymBot = require(path.join(pathRoot, 'symbot.js'));

		SymBot.setInstanceConfig(Object.assign({},
			instanceData,
			{ shutdownTimeout }
		));

		SymBot.setInstanceParentPort(parentPort); 

		await SymBot.start(instanceData.args);

		console.log(colors.bgBlack.brightGreen.bold(`Finished Starting Instance: ${instanceName}`));

		// Listen for command requests from the main thread
		parentPort.on('message', (message) => {

			processWorkerTaskMessage(SymBot, message);
		});

	}
	catch (error) {

		// Log the error and inform the main thread
		console.log(colors.bgBlack.brightRed.bold(`Error performing task for ${instanceData.name}: ${error.message}`));
	}
}


async function processWorkerTaskMessage(SymBot, message) {

	// Get worker instance memory usage
	if (message.type === HUB_TO_WORKER.MEMORY) {

		const memoryUsage = process.memoryUsage();
	
		parentPort.postMessage({
	
			type: WORKER_TO_HUB.MEMORY,
			data: memoryUsage
		});
	}

	// Get worker instance active deals
	if (message.type === HUB_TO_WORKER.DEALS_ACTIVE) {
	
		const deals = await SymBot.DCABot.getActiveDeals();
	
		parentPort.postMessage({
	
			type: WORKER_TO_HUB.DEALS_ACTIVE_RECEIVED,
			id: message.id,
			data: {
					'name': message.name,
					'deals': deals
				  }
		});
	}
	
	// System pause received for SymBot worker
	if (message.type === HUB_TO_WORKER.SYSTEM_PAUSE) {
	
		parentPort.postMessage({
	
			type: WORKER_TO_HUB.SYSTEM_PAUSE_RECEIVED
		});
	
		const data = message.data;
	
		const isPause = data.pause;
		const pauseMessage = data.message;
	
		await SymBot.System.pause(isPause, pauseMessage);
	}

	// Get worker instance bots
	if (message.type === HUB_TO_WORKER.BOTS_ACTIVE) {

		const botsRaw = await SymBot.DCABot.getBots({});
		const bots = [];

		if (botsRaw && botsRaw.length > 0) {

			for (let i = 0; i < botsRaw.length; i++) {

				let bot = JSON.parse(JSON.stringify(botsRaw[i]));

				bot = await SymBot.DCABot.removeDbKeys(bot);

				const config = JSON.parse(JSON.stringify(bot.config || {}));
				const maxFundsObj = await SymBot.DCABot.calculateMaxFunds(config);

				delete bot.date;
				delete bot.config;

				const botData = Object.assign({}, bot, config, maxFundsObj);

				bots.push(botData);
			}
		}

		parentPort.postMessage({

			type: WORKER_TO_HUB.BOTS_ACTIVE_RECEIVED,
			id: message.id,
			data: {
					'name': message.name,
					'bots': bots
				  }
		});
	}

	// Deal action received — cancel, stop, pause, close, update, add_funds, bot_enable, bot_disable
	if (message.type === HUB_TO_WORKER.DEAL_ACTION) {

		const { requestId, action, dealId, botId, data } = message;

		let result = { 'success': false, 'data': 'Unknown action' };

		try {

			if (action === 'cancel') {

				result = await SymBot.DCABot.cancelDeal(dealId);
			}
			else if (action === 'stop') {

				result = await SymBot.DCABot.stopDeal(dealId);
			}
			else if (action === 'panic_sell') {

				result = await SymBot.DCABot.panicSellDeal(dealId);
			}
			else if (action === 'pause') {

				result = await SymBot.DCABot.pauseDeal(botId, dealId, data.pause, data.pauseBuy, data.pauseSell);
			}
			else if (action === 'update_deal') {

				result = await SymBot.DCABotManager.apiUpdateDeal(null, null, false, dealId, data);
			}
			else if (action === 'bot_disable') {

				result = await SymBot.DCABotManager.apiEnableDisableBot(null, null, false, botId, false);
			}
			else if (action === 'bot_enable') {

				result = await SymBot.DCABotManager.apiEnableDisableBot(null, null, false, botId, true);
			}
		}
		catch (err) {

			result = { 'success': false, 'data': err?.message || String(err) };
		}

		parentPort.postMessage({

			type: WORKER_TO_HUB.DEAL_ACTION_RECEIVED,
			requestId,
			data: result
		});
	}

	// Shutdown received for SymBot worker
	if (message.type === HUB_TO_WORKER.SHUTDOWN) {
	
		parentPort.postMessage({
	
			type: WORKER_TO_HUB.SHUTDOWN_RECEIVED
		});
	
		SymBot.shutDown();
	}
}


async function start(instanceData) {

	processWorkerTask(instanceData);
}


module.exports = {

	start,

	init: function(parentPortInit, shutdownTimeoutInit) {

		parentPort = parentPortInit;
		shutdownTimeout = shutdownTimeoutInit;
	}
};
