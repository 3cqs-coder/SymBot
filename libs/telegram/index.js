'use strict';

const fs = require('fs');
const path = require('path');

const pathRoot = path.dirname(fs.realpathSync(__dirname)).split(path.sep).join(path.posix.sep);

const { Telegraf } = require('telegraf');


let initSuccess = true;

let bot;
let shareData;



async function initApp(tokenId) {

	bot = new Telegraf(tokenId,  { handlerTimeout: 100 });

	bot.command('start', (ctx) => {

		startCommand(ctx);
	});


	bot.command('help', (ctx) => {

		helpCommand(ctx);
	});


	bot.command('uptime', (ctx) => {

		let id = ctx.from.id;
		let text = ctx.message.text;

		let dateStart = shareData.appData.started;

		let upTime = shareData.Common.timeDiff(new Date(), new Date(dateStart));

		sendMessage(id, shareData.appData.name + ' v' + shareData.appData.version + ' running for ' + upTime);
	});
	
	
	bot.on('message', (ctx) => {

		let id = ctx.from.id;

		sendMessage(id, 'Unknown command. Use /help to show available commands');
	});


	bot.catch(e => {

		shareData.Common.logger('Telegram Error: ' + JSON.stringify(e));
	});


	bot.launch().catch(err => { initSuccess = false; logError(err, ''); });
}


async function startCommand(ctx) {

	let id = ctx.from.id;

	sendMessage(id, 'Welcome to ' + shareData.appData.name);
}


async function helpCommand(ctx) {

	let data;
	let id = ctx.from.id;

	let fileName = pathRoot + '/telegram/help.txt';

	try {

		data = fs.readFileSync(fileName, 'utf8');
	}
	catch(e) {

	}

	data = data.replace(/\{APP_NAME\}/g, shareData.appData.name);

	sendMessage(id, data);
}


async function sendMessage(id, msg) {

	if (initSuccess) {

		if (id != shareData.appData.telegram_id) {

			msg = 'You are not authorized to access ' + shareData.appData.name;
		}

		if (bot) {

			bot.telegram.sendMessage(id, msg).catch(err => logError(err, id));
		}
	}
}


function logError(err, data) {

	let logData = 'Message: ' + JSON.stringify(err.message) + ' Stack: ' + JSON.stringify(err.stack) + ' Data: ' + JSON.stringify(data);

	shareData.Common.logger('Telegram Error: ' + logData);
}


function start(tokenId) {

	if (tokenId != undefined && tokenId != null && tokenId != '') {

		initApp(tokenId);
	}
	else {

		initSuccess = false;
	}
}


module.exports = {

	start,
	sendMessage,

	init: function(obj) {

		shareData = obj;
    }
}
