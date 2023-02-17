/*
	3CQS Signals Client
	https://www.3cqs.com
*/

const fs = require('fs');
const path = require('path');

let pathRoot = path.dirname(fs.realpathSync(__dirname)).split(path.sep).join(path.posix.sep);
pathRoot = pathRoot.substring(0, pathRoot.lastIndexOf('/'));

const Schema = require(pathRoot + '/mongodb/Signals3CQSSchema');

const Signals = Schema.Signals3CQSSchema;



let fatalError = false;

let API_KEY;
let shareData;


setInterval(() => {

	removeDataDb();

}, (60000 * 60));



async function start(apiKey) {

	if (apiKey == undefined || apiKey == null || apiKey == '') {

		return;
	}

	API_KEY = apiKey;

	const socket = require('socket.io-client')('https://stream.3cqs.com', {

		extraHeaders: {

			'api-key': apiKey,
			'user-agent': shareData.appData.name + '/' + shareData.appData.version
		},
		transports: ['websocket', 'polling'],
		path: '/stream/v1/signals',
		reconnection: true,
		reconnectionDelay: 10000
	});


	socket.on('connect', (data) => {

		showLog('Connected to 3CQS Signals');

		let messageId = randomString(15);

		// Get max last n signals

		setTimeout(() => {

			socket.emit('signal_history', {
				'max': 100,
				'message_id_client': messageId
			});

		}, 500);
	});


	socket.on('signal', (data) => {

		let content = '3CQS SIGNAL RECEIVED';

		if (data['created_history'] != undefined && data['created_history'] != null && data['created_history'] != '') {

			content += ' (HISTORY)';
		}

		updateDb(data);

		processSignal(data);

		if (shareData.appData.verboseLog) {
		
			showLog(content, data);
		}
	});


	socket.on('info', (data) => {

		showLog('3CQS SIGNAL INFO', data);
	});


	socket.on('error', (data) => {

		if (data['code'] == 403) {

			fatalError = true;
		}

		// Too many tries
		if (data['code'] == 429) {

			// Disconnect and connect again after 30 seconds

			socket.disconnect();

			setTimeout(() => {

				socket.connect();				

			}, 30000);
		}

		showLog('3CQS SIGNAL ERROR', data);
	});


	socket.on('connect_error', (data) => {

		fatalError = true;

		showLog('3CQS SIGNAL CONNECT_ERROR', data);
	});


	socket.on('connect_failed', (data) => {

		fatalError = true;

		showLog('3CQS SIGNAL CONNECT_FAILED', data);
	});


	socket.on('disconnect', (reason) => {

		showLog('3CQS SIGNAL Client Disconnected: ' + reason);

		//Either 'io server disconnect' or 'io client disconnect'
		if (!fatalError && reason === 'io server disconnect') {

			showLog('3CQS SIGNAL Server disconnected the client. Trying to reconnect.');

			// Disconnected by server,so reconnect again
			socket.connect();
		}
	});


	return socket;
}


function randomString(len) {

	let chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

	let str = '';

	for (let i = 0; i < len; i++) {

		str += chars[Math.floor(Math.random() * chars.length)];
	}

	return str;
}


async function processSignal(data) {

	const symbol = data['symbol'];
	const signal = data['signal'];
	const signalNameId = data['signal_name_id'];

	const startCondition = 'signal|3CQS|' + signalNameId;

	let port = shareData.appData.web_server_port;
	let apiKey = shareData.appData.api_key;

	let headers = {
						'Accept': 'application/json',
						'Content-Type': 'application/json',
						'api-key': apiKey
				  };


	if (signal == 'BOT_START') {

		let query = {
						'active': true,
						'config.pair': {
											'$regex': '^' + symbol + '/',
											'$options': 'i'
									   },
						'config.startConditions': { '$eq': startCondition }
					};

		const bots = await shareData.DCABot.getBots(query);

		if (bots && bots.length > 0) {

			for (let i = 0; i < bots.length; i++) {

				let pairUse;

				const bot = bots[i];
				const botId = bot.botId;
				const config = bot.config;
				const pairs = config.pair;

				for (let x = 0; x < pairs.length; x++) {

					let pair = pairs[x];

					if (new RegExp(`^${symbol + '/'}`, 'i').test(pair)) {

						pairUse = pair;
						break;
					}
				}

				let body = { 'pair': pairUse };

				// Start deal
				let res = await shareData.Common.fetchURL('http://127.0.0.1:' + port + '/api/bots/' + botId + '/start_deal', 'post', headers, body);

				if (!res.success) {

					let data = res.data;

					let msg = '3CQS Signal Start Failed. Bot ID: ' + botId + ' / Info: ' + data;

					shareData.Common.logger(msg);
					shareData.Telegram.sendMessage(shareData.appData.telegram_id, msg);
				}
			}
		}
	}


	if (signal == 'BOT_STOP') {

		let botsDisable = {};

		let query = {
						'status': 0,
						'config.pair': {
											'$regex': '^' + symbol + '/',
											'$options': 'i'
									   },
						'config.startConditions': { '$eq': startCondition }
					};

		const deals = await shareData.DCABot.getDeals(query);

		if (deals && deals.length > 0) {

			for (let i = 0; i < deals.length; i++) {

				const deal = deals[i];
				const botId = deal.botId;

				botsDisable[botId] = 1;
			}

			// Disable bot
			for (let botId in botsDisable) {

				let res = await shareData.Common.fetchURL('http://127.0.0.1:' + port + '/api/bots/' + botId + '/disable', 'post', headers, {});
			}
		}
	}
}


async function removeDataDb() {

	// Delete signals after n days
	const days = 14;

	let res;

	const dateUse = new Date(new Date().getTime() - (days * 24 * 60 * 60 * 1000));

	const query = {
					'createdAt': {
									'$lt': new Date(dateUse)
								 }
				  };

	try {

		res = await Signals.deleteMany(query);
	}
	catch(e) {

		res = JSON.stringify(e);
	}

	return res;
}


async function updateDb(data) {

	const signal = new Signals({
									'signal_id': data.signal_id,
									'signal_id_parent': data.signal_id_parent,
									'created': data.created,
									'created_parent': data.created_parent,
									'signal_data': data
							  });

	await signal.save()
			.catch(err => {
							if (err.code === 11000) {

								// Duplicate entry
							}
						  });
}


function showLog(content, data) {

	let contentFormat = '<--{CONTENT}-->';

	content = contentFormat.replace(/\{CONTENT\}/g, content);

	if (data != undefined && data != null && data != '') {

		content += ' ' + JSON.stringify(data);
	}

	shareData.Common.logger(content);
}


module.exports = {

	start,

	init: function(obj) {

		shareData = obj;
	}
}
