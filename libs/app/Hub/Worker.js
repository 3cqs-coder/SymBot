'use strict';

const fs = require('fs');
const path = require('path');
const colors = require('colors');

const pathRoot = path.resolve(__dirname, '..', '..', '..');

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
				type: 'log',
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

		await SymBot.start();

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
	if (message.type === 'memory') {

		const memoryUsage = process.memoryUsage();
	
		parentPort.postMessage({
	
			type: 'memory',
			data: memoryUsage
		});
	}

	// Get worker instance active deals
	if (message.type === 'deals_active') {
	
		const deals = await SymBot.DCABot.getActiveDeals();
	
		parentPort.postMessage({
	
			type: 'deals_active_received',
			id: message.id,
			data: {
					'name': message.name,
					'deals': deals
				  }
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
