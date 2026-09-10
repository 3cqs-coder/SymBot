'use strict';

const fs = require('fs');
const path = require('path');

let pathRoot = path.dirname(fs.realpathSync(__dirname)).split(path.sep).join(path.posix.sep);
pathRoot = pathRoot.substring(0, pathRoot.lastIndexOf('/'));

const { Telegraf } = require('telegraf');


// Sending a Telegram message is a plain, stateless Bot-API call; LISTENING for commands is a
// long-poll (getUpdates via bot.launch()). Telegram allows only ONE getUpdates consumer per bot
// token at a time, so if two processes poll the same token the newer one is rejected with a 409
// Conflict. These two concerns are kept independent here: `bot` existing is all that is required to
// SEND, and the command poll is best-effort on top. That way a lost poll — another instance already
// owns it, or a restart racing the previous poll's release — never silences notifications.
//
// Polling policy: a standalone install listens for commands; a Hub instance (identified by a
// worker_data name) defaults to send-only so many instances sharing one token don't fight over the
// single poll. Callers may override via start()'s options.pollCommands.

let bot;
let polling = false;
let shareData;



function isHubInstance() {

	// Mirrors how Common derives "am I a Hub instance": a non-empty worker_data name means this process
	// was launched by the Hub as one of several instances (a standalone has no worker_data name).
	try {

		const wd = shareData && shareData.appData && shareData.appData.worker_data;

		return !!(wd && wd.name && String(wd.name).trim() !== '');
	}
	catch (e) {

		return false;
	}
}


async function initApp(tokenId, pollCommands) {

	try {

		bot = new Telegraf(tokenId, { handlerTimeout: 100 });
	}
	catch (e) {

		// A malformed token can throw here; keep it contained so it can never surface as an unhandled
		// rejection. Without a bot we simply can't send until reconfigured.
		bot = null;
		logError(e, '');

		return;
	}

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


	if (!pollCommands) {

		// Send-only mode: never open a getUpdates poll. Notifications still work (they don't need the
		// poll); this instance just doesn't listen for /start, /help or /uptime.
		polling = false;

		return;
	}

	polling = true;

	bot.launch()
		.then(() => {
			polling = true;
		})
		.catch(err => {
			polling = false;
			handleLaunchError(err);
	});
}


function handleLaunchError(err) {

	// The bot is kept so notifications keep sending; we just failed to acquire the command poll. A 409
	// means another process/instance already owns getUpdates for this token — expected under the Hub, or
	// briefly when a restart races the previous poll's release. Do NOT retry: retrying would only steal
	// the poll back and forth. Any other launch error is logged in full.
	const code = err && ((err.response && err.response.error_code) || err.code);
	const message = (err && err.message) ? String(err.message) : String(err);

	const conflict = code === 409 || /\b409\b|conflict|terminated by other getUpdates/i.test(message);

	if (conflict) {

		shareData.Common.logger('Telegram: another listener already owns command polling for this bot token — notifications will still send; commands are handled by the other listener.');
	}
	else {

		logError(err, '');
	}
}


async function startCommand(ctx) {

	let id = ctx.from.id;

	sendMessage(id, 'Welcome to ' + shareData.appData.name);
}


async function helpCommand(ctx) {

	let data;
	let id = ctx.from.id;

	let fileName = pathRoot + '/libs/telegram/help.txt';

	try {

		data = fs.readFileSync(fileName, 'utf8');
	}
	catch(e) {

	}

	// Guard against a missing/unreadable help.txt — otherwise data stays undefined and .replace() throws,
	// and because this handler is invoked un-awaited that would surface as an unhandled rejection.
	if (data == null) {

		sendMessage(id, 'Help is currently unavailable.');
		return;
	}

	data = data.replace(/\{APP_NAME\}/g, shareData.appData.name);

	sendMessage(id, data);
}


async function sendMessage(id, msg) {

	// Independent of the command poll: as long as we have a bot for the token and Telegram is enabled we
	// can send, even if bot.launch() failed or was never started (send-only mode). This is what keeps
	// notifications alive when another instance holds the poll.
	if (!bot || !shareData.appData.telegram_enabled) {

		return;
	}

	if (id != shareData.appData.telegram_id) {

		msg = 'You are not authorized to access ' + shareData.appData.name;
	}

	// Telegram rejects messages over 4096 characters, and it fetches any URL in the text to build a
	// "web page preview" — for an API URL that returns JSON (e.g. a failed exchange /currencies
	// call) that preview arrives as a bogus file attachment on the alert. Cap the length and turn
	// link previews OFF so notifications stay plain, self-contained text.
	let text = String(msg == null ? '' : msg);

	if (text.length > 4000) { text = text.slice(0, 4000) + '\n… (truncated)'; }

	bot.telegram.sendMessage(id, text, { 'disable_web_page_preview': true }).catch(err => logError(err, id));
}


function logError(err, data) {

	let logData = 'Message: ' + JSON.stringify(err.message) + ' Stack: ' + JSON.stringify(err.stack) + ' Data: ' + JSON.stringify(data);

	shareData.Common.logger('Telegram Error: ' + logData);
}


function start(tokenId, enabled, options) {

	if (enabled && (tokenId != undefined && tokenId != null && tokenId != '')) {

		// Standalone listens for commands; a Hub instance is send-only by default so instances sharing one
		// token don't contend for the single poll. An explicit options.pollCommands wins when provided.
		const pollCommands = (options && typeof options.pollCommands === 'boolean')
			? options.pollCommands
			: !isHubInstance();

		initApp(tokenId, pollCommands);
	}
	else {

		polling = false;
	}
}


function stop() {

	try {

		if (bot) { bot.stop(); }
	}
	catch(e) {}

	bot = null;
	polling = false;
}


module.exports = {

	start,
	stop,
	sendMessage,

	init: function(obj) {

		shareData = obj;
    }
}
