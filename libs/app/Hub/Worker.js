'use strict';

const path = require('path');
const os = require('os');
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

		// Relay log lines to the Hub. Previously this posted ONE cross-thread message per line — a
		// firehose under normal trading. Now lines are BATCHED and flushed together on a short timer
		// (or when the buffer fills), collapsing many postMessages into one; the Hub logs each line
		// identically. EXCEPTION: an `error` line is relayed immediately (flushing any pending batch
		// first to preserve order) — a worker may crash right after logging it, and that line is
		// exactly what must reach the Hub, so it is never left sitting in a buffer.
		const LOG_FLUSH_MS = 400;
		const LOG_BATCH_MAX = 250;
		let logBuffer = [];
		let logFlushTimer = null;

		function flushLogs() {
			if (logFlushTimer) { clearTimeout(logFlushTimer); logFlushTimer = null; }
			if (!logBuffer.length) { return; }
			const lines = logBuffer;
			logBuffer = [];
			parentPort.postMessage({ type: WORKER_TO_HUB.LOG_BATCH, lines });
		}

		function sendLog(level, msg) {

			const line = prefData + msg;

			if (level === 'error') {
				flushLogs();
				parentPort.postMessage({ type: WORKER_TO_HUB.LOG_BATCH, lines: [ line ] });
				return;
			}

			logBuffer.push(line);
			if (logBuffer.length >= LOG_BATCH_MAX) { flushLogs(); }
			else if (!logFlushTimer) { logFlushTimer = setTimeout(flushLogs, LOG_FLUSH_MS); if (logFlushTimer.unref) { logFlushTimer.unref(); } }
		}

		// Override console methods
		['log', 'error', 'warn', 'info', 'debug'].forEach((method) => {

			console[method] = (...args) => {

				let text = args.join(' ');
				if (method === 'error') text = 'ERROR: ' + text;

				sendLog(method, text);
			};
		});

		// Override stream writes. Like the console.* overrides above, this RELAYS the line to the
		// Hub (the canonical path — Hub.logger prefixes, files, and broadcasts it) and does NOT also
		// forward the raw chunk to the parent stdout. Previously it did both, so a direct stdout
		// write appeared twice on the Hub console (once relayed+prefixed, once raw). The write
		// contract is still honored: the callback fires and we return true.
		function overrideWrite(stream, level, prefix = '') {

			stream.write = (chunk, encoding, callback) => {

				const enc = (typeof encoding === 'string') ? encoding : undefined;
				const text = Buffer.isBuffer(chunk) ? chunk.toString(enc) : chunk;

				sendLog(level, prefix + text);

				const cb = (typeof encoding === 'function') ? encoding : callback;
				if (typeof cb === 'function') { cb(); }

				return true;
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

		// Host CPU load. os.loadavg() is host-level (every worker in this process
		// shares the same host, so this is the same for all of them) — it reports
		// how loaded the machine hosting these instances is. Paired with the core
		// count so the Hub can show an easy-to-read "% of cores" figure.
		const loadAvg = os.loadavg();
		const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : null;

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
				'arrayBuffers': memoryUsage.arrayBuffers || 0,
				'loadAvg': Array.isArray(loadAvg) ? loadAvg.map(l => Math.round(l * 100) / 100) : null,
				'cpuCount': cpuCount
			}
		});
	}

	// Aggregated AI-learning pack pushed down by the Hub — validate + import (patterns only).
	if (message.type === HUB_TO_WORKER.LEARNING_PACK) {

		try {

			if (SymBot && SymBot.AIClient && typeof SymBot.AIClient.importHubLearningPack === 'function') {

				await SymBot.AIClient.importHubLearningPack(message.payload);
			}
		}
		catch (e) { /* best-effort; a learning import must never disturb the worker */ }
	}

	// Get worker instance active deals
	if (message.type === HUB_TO_WORKER.DEALS_ACTIVE) {

		try {
			// Use apiGetActiveDeals (not DCABot.getActiveDeals) so the portfolio
			// summary is included — needed by the Hub dashboard cards.
			// Pass a mock req with empty query so req.query access doesn't throw.
			const mockReq = { query: {} };
			const result = await SymBot.DCABotManager.apiGetActiveDeals(mockReq, null, false);

			parentPort.postMessage({

				type: WORKER_TO_HUB.DEALS_ACTIVE_RECEIVED,
				id: message.id,
				requestId: message.requestId,   // echo so the Hub matches THIS poll, not an overlapping one
				data: {
						'name':      message.name,
						'deals':     result.data     || [],
						'portfolio': result.portfolio || null
					  }
			});
		}
		catch (e) {
			// ALWAYS reply so the Hub's poll resolves immediately instead of hitting its 5s timeout and
			// dropping this instance from the dashboard refresh. Empty data + an error the Hub can log.
			try { parentPort.postMessage({ type: WORKER_TO_HUB.DEALS_ACTIVE_RECEIVED, id: message.id, requestId: message.requestId, data: { 'name': message.name, 'deals': [], 'portfolio': null, 'error': (e && e.message) || 'deals fetch failed' } }); } catch (_) {}
		}
	}
	
	// System pause received for SymBot worker
	if (message.type === HUB_TO_WORKER.SYSTEM_PAUSE) {

		// Acknowledge FIRST so the Hub never waits on the pause taking effect, then apply it guarded —
		// a pause failure must not throw out of the message handler.
		try { parentPort.postMessage({ type: WORKER_TO_HUB.SYSTEM_PAUSE_RECEIVED }); } catch (_) {}

		try {
			const data = message.data || {};
			await SymBot.System.pause(data.pause, data.message);
		}
		catch (e) { try { SymBot.Common.logger('Hub SYSTEM_PAUSE failed: ' + ((e && e.message) || e)); } catch (_) {} }
	}

	// Get worker instance bots
	if (message.type === HUB_TO_WORKER.BOTS_ACTIVE) {

		try {
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
				requestId: message.requestId,   // echo so the Hub matches THIS poll, not an overlapping one
				data: {
						'name': message.name,
						'bots': bots
					  }
			});
		}
		catch (e) {
			// Always reply so the Hub poll resolves instead of stalling for 5s and dropping this instance.
			try { parentPort.postMessage({ type: WORKER_TO_HUB.BOTS_ACTIVE_RECEIVED, id: message.id, requestId: message.requestId, data: { 'name': message.name, 'bots': [], 'error': (e && e.message) || 'bots fetch failed' } }); } catch (_) {}
		}
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
				const isSignal   = SymBot.DCABotManager.buildIsSignalBot(data.botData || {});

				result = { 'success': true, 'data': Object.assign({}, scStrings, { symbolString: symString, activeChecked: actChecked, isSignalBot: isSignal }) };
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