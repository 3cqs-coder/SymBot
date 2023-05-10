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


let signalTracker = {};

let fatalError = false;

let API_KEY;
let shareData;


setInterval(() => {

	removeDataDb();

}, (60000 * 60));


setInterval(() => {

	checkTracker();

}, (60000 * 3));



async function start(apiKey) {

	if (apiKey == undefined || apiKey == null || apiKey == '') {

		return;
	}

	API_KEY = apiKey;

	const socket = require('socket.io-client')('https://stream.3cqs.com', {

		'extraHeaders': {

			'api-key': apiKey,
			'user-agent': shareData.appData.name + '/' + shareData.appData.version
		},
		'forceNew': true,
		'transports': ['websocket', 'polling'],
		'path': '/stream/v1/signals',
		'reconnection': true,
		'reconnectionDelay': 10000
	});


	socket.on('connect', (data) => {

		let msg = 'Connected to 3CQS Signals';

		sendTelegram(msg, true);

		let messageId = randomString(15);

		// Get max last n signals

		setTimeout(() => {

			socket.emit('signal_history', {
				'max': 100,
				'message_id_client': messageId
			});

		}, 1000);
	});


	socket.io.on('ping', (data) => {

		//showLog('3CQS SIGNAL PING', data);
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

		let msg = '3CQS SIGNAL Client Disconnected: ' + reason;

		sendTelegram(msg, true);

		//Either 'io server disconnect' or 'io client disconnect'
		if (reason === 'io server disconnect') {

			let msg = '3CQS SIGNAL Server disconnected the client. Trying to reconnect.';

			sendTelegram(msg, true);

			// Disconnected by server,so reconnect again
			setTimeout(() => {

				socket.connect();				

			}, 10000);
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

	const maxMins = 5;

	const symbol = data['symbol'];
	const created = data['created'];
	const signal = data['signal'];
	const signalId = data['signal_id'];
	const signalNameId = data['signal_name_id'];

	const symRank = data['sym_rank'];
	const symScore = data['sym_score'];
	const volatilityScore = data['volatility_score'];
	const priceActionScore = data['price_action_score'];
	const marketCapRank = data['market_cap_rank'];
	const rsi1415m = data['rsi14_15m'];

	const startCondition = 'signal|3CQS|' + signalNameId;

	let port = shareData.appData.web_server_port;
	let apiKey = shareData.appData.api_key;

	let headers = {
						'Accept': 'application/json',
						'Content-Type': 'application/json',
						'api-key': apiKey
				  };


	let isNew = await trackSignal(signalId);

	let diffSec = (new Date().getTime() - new Date(created).getTime()) / 1000;

	if (isNew && signal == 'BOT_START' && diffSec < (60 * maxMins)) {

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
				const botName = bot.botName;
				const config = bot.config;
				const pairs = config.pair;

				if (config.startConditions != undefined && config.startConditions != null) {

					if (typeof config.startConditions !== 'string' && config.startConditions.length > 1) {

						let condition = '';

						for (let x = 1; x < config.startConditions.length; x++) {

							let startCondition = config.startConditions[x];

							let conditionData = startCondition.split('|');

							let id = conditionData[2];
							let operator = conditionData[3];
							let content = conditionData[4];

							if (x > 1) {

								condition += ' && ';
							}

							condition += '("' + data[id] + '" ' + operator + ' "' + content + '")';
						}

						let signalValid = eval(condition);

						if (!signalValid) {

							return;
						}
					}
				}
	
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

					if (typeof data != 'string') {

						data = JSON.stringify(data);
					}

					let msg = '3CQS Signal Start Failed: ' + botName + ' (' + pairUse + '). Reason: ' + data;

					sendTelegram(msg, true);
				}
				else {

					let msg = '3CQS Signal Start: ' + botName + ' (' + pairUse + ')';

					sendTelegram(msg, true);
				}
			}
		}
	}


	if (isNew && signal == 'BOT_STOP') {

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
				const botName = deal.botName;
				const dealId = deal.dealId;
				const pair = deal.pair;

				let config = deal.config;

				// Set last deal flag				
				config.dealLast = true;

				const data = await shareData.DCABot.updateDeal(botId, dealId, { 'config': config });

				let msg = '3CQS Signal Stop: ' + botName + ' (' + pair + ')';

				sendTelegram(msg, false);

				botsDisable[botId] = 1;
			}

			// Disable bot
			for (let botId in botsDisable) {

				//let res = await shareData.Common.fetchURL('http://127.0.0.1:' + port + '/api/bots/' + botId + '/disable', 'post', headers, {});
			}
		}
	}
}


async function trackSignal(signalId) {

	let isNew = false;

	if (signalTracker[signalId] == undefined || signalTracker[signalId] == null) {

		isNew = true;

		signalTracker[signalId] = {};

		signalTracker[signalId]['created'] = new Date();
	}

	return isNew;
}


async function checkTracker() {

	const maxMins = 60;

	for (let signalId in signalTracker) {

		let created = signalTracker[signalId]['created'];

		let diffSec = (new Date().getTime() - new Date(created).getTime()) / 1000;

		if (diffSec > (60 * maxMins)) {

			delete signalTracker[signalId];
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


async function sendTelegram(msg, logMsg) {

	if (logMsg) {

		showLog(msg);
	}

	shareData.Common.sendNotification({ 'message': msg, 'telegram_id': shareData.appData.telegram_id });
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
