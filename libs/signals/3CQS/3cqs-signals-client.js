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


let initVerify = false;
let fatalError = false;

let API_KEY;
let shareData;


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
				'max': 10,
				'message_id_client': messageId
			});

		}, 500);


		// Check if connected every n minutes
		if (!initVerify) {

			initVerify = true;

			setInterval(() => {

				checkSocket(socket);

			}, (60000 * 1));
		}
	});


	socket.on('signal', (data) => {

		let content = '3CQS SIGNAL RECEIVED';

		if (data['created_history'] != undefined && data['created_history'] != null && data['created_history'] != '') {

			content += ' (HISTORY)';
		}

		updateDb(data);

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

			// Disconnect after 30 seconds to let auto-reconnect again
			setTimeout(() => {

				socket.disconnect();

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


async function checkSocket(socket) {

	const socketId = socket.id;

	if (!socket.connected) {

		start(API_KEY);
	}
}


function randomString(len) {

	let chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

	let str = '';

	for (let i = 0; i < len; i++) {

		str += chars[Math.floor(Math.random() * chars.length)];
	}

	return str;
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

	content += ' ' + JSON.stringify(data);

	shareData.Common.logger(content);
}


module.exports = {

	start,

	init: function(obj) {

		shareData = obj;
	}
}
