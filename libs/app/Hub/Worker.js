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

		// rss is process-wide (shared by every worker thread in this process), so it
		// cannot be attributed to a single instance. heapUsed + external + arrayBuffers
		// is the portion attributable to THIS worker, including its off-heap buffers.
		parentPort.postMessage({

			type: WORKER_TO_HUB.MEMORY,
			data: {
				'rss': memoryUsage.rss,
				'heapTotal': memoryUsage.heapTotal,
				'heapUsed': memoryUsage.heapUsed,
				'external': memoryUsage.external || 0,
				'arrayBuffers': memoryUsage.arrayBuffers || 0
			}
		});
	}

	// Get worker instance active deals
	if (message.type === HUB_TO_WORKER.DEALS_ACTIVE) {

		// Use apiGetActiveDeals (not DCABot.getActiveDeals) so the portfolio
		// summary is included — needed by the Hub dashboard cards.
		// Pass a mock req with empty query so req.query access doesn't throw.
		const mockReq = { query: {} };
		const result = await SymBot.DCABotManager.apiGetActiveDeals(mockReq, null, false);

		parentPort.postMessage({

			type: WORKER_TO_HUB.DEALS_ACTIVE_RECEIVED,
			id: message.id,
			data: {
					'name':      message.name,
					'deals':     result.data     || [],
					'portfolio': result.portfolio || null
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

	// Deal action received — cancel, stop, panic_sell, pause, update_deal
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

	// Bot action received — create, update, delete, start_deal
	if (message.type === HUB_TO_WORKER.BOT_ACTION) {

		const { requestId, action, botId, data } = message;

		let result = { 'success': false, 'data': 'Unknown bot action' };

		try {

			if (action === 'bot_enable' || action === 'bot_disable') {

				result = await SymBot.DCABotManager.apiEnableDisableBot(null, null, false, botId, action === 'bot_enable');
			}
			else if (action === 'create' || action === 'update') {

				// Build a mock req/res to reuse the existing apiCreateUpdateBot handler
				const mockReq = {
					path:   action === 'update' ? '/api/bots/update' : '/api/bots/create',
					body:   data,
					params: {},
					query:  {}
				};

				let responseData;

				const mockRes = {
					send: (d) => { responseData = d; },
					json: (d) => { responseData = d; }
				};

				await SymBot.DCABotManager.apiCreateUpdateBot(mockReq, mockRes);

				result = responseData || { 'success': false, 'data': 'No response from apiCreateUpdateBot' };
			}
			else if (action === 'delete') {

				const mockReq = {
					params: { botId },
					body:   {},
					query:  {}
				};

				let responseData;

				const mockRes = {
					json: (d) => { responseData = d; },
					send: (d) => { responseData = d; }
				};

				await SymBot.DCABotManager.apiDeleteBot(mockReq, mockRes);

				result = responseData || { 'success': false, 'data': 'No response from apiDeleteBot' };
			}
			else if (action === 'start_deal') {

				const mockReq = {
					params: { botId },
					body:   data || {},
					query:  {}
				};

				let responseData;

				const mockRes = {
					send: (d) => { responseData = d; },
					json: (d) => { responseData = d; }
				};

				await SymBot.DCABotManager.apiStartDeal(mockReq, mockRes);

				result = responseData || { 'success': false, 'data': 'No response from apiStartDeal' };
			}
			else if (action === 'get_defaults') {

				// getDefaultBotConfig reads shareData via DCABotManager's own
				// module-level reference — SymBot.shareData is not exported from symbot.js.
				const defaults = await SymBot.DCABotManager.getDefaultBotConfig();

				result = { 'success': true, 'data': defaults };
			}
			else if (action === 'get_sc_strings') {

				// getBotsConfig reads shareData via DCABotManager's own module-level
				// reference — SymBot.shareData is not exported from symbot.js.
				const botsConfig = SymBot.DCABotManager.getBotsConfig();
				const scStrings  = SymBot.DCABotManager.buildStartConditionStrings(botsConfig, data.botData || {});
				const symString  = SymBot.DCABotManager.buildSymbolString(data.symbols || [], data.botData || {});
				const actChecked = SymBot.DCABotManager.buildActiveChecked(data.botData || {});

				result = { 'success': true, 'data': Object.assign({}, scStrings, { symbolString: symString, activeChecked: actChecked }) };
			}
			else if (action === 'get_start_conditions') {

				// getBotsConfig reads shareData from DCABotManager's own module-level
				// reference — SymBot.shareData is not exported from symbot.js.
				const botsConfig = SymBot.DCABotManager.getBotsConfig();

				result = { 'success': true, 'data': botsConfig };
			}
			else if (action === 'get_symbols') {

				// getSymbolList reads bot_config from shareData internally —
				// no need to pass config from the Worker side.
				const symbols = await SymBot.DCABotManager.getSymbolList();

				result = { 'success': true, 'data': symbols };
			}
			else if (action === 'get_bot') {

				const botsRaw = await SymBot.DCABot.getBots({ 'botId': botId });

				if (botsRaw && botsRaw.length > 0) {

					let bot = JSON.parse(JSON.stringify(botsRaw[0]));

					bot = await SymBot.DCABot.removeDbKeys(bot);

					// Flatten config into top-level same as BOTS_ACTIVE so the
					// edit form receives the same field structure the table uses
					const config = JSON.parse(JSON.stringify(bot.config || {}));

					delete bot.date;
					delete bot.config;

					const botFlat = Object.assign({}, bot, config);

					result = { 'success': true, 'data': botFlat };
				}
				else {

					result = { 'success': false, 'data': 'Bot not found' };
				}
			}
		}
		catch (err) {

			result = { 'success': false, 'data': err?.message || String(err) };
		}

		parentPort.postMessage({

			type: WORKER_TO_HUB.BOT_ACTION_RECEIVED,
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
