'use strict';


let shareData;


async function viewCreateBot(req, res) {

	const botConfig = await shareData.Common.getConfig('bot.json');

	res.render( 'strategies/DCABot/DCABotCreateView', { 'appData': shareData.appData, 'botData': botConfig.data } );
}


async function viewActiveDeals(req, res) {

	let botsActiveObj = {};

	const bots = await shareData.DCABot.getBots({ 'active': true });

	let deals = JSON.parse(JSON.stringify(shareData.dealTracker));

	if (bots.length > 0) {

		for (let i = 0; i < bots.length; i++) {

			let bot = bots[i];

			const botId = bot.botId;
			const botName = bot.botName;

			botsActiveObj[botId] = botName;
		}
	}

	for (let dealId in deals) {

		let botActive = true;

		let deal = deals[dealId];
		let botId = deal['info']['bot_id'];

		if (botsActiveObj[botId] == undefined || botsActiveObj[botId] == null) {

			botActive = false;
		}

		deal['info']['bot_active'] = botActive;
	}

	res.render( 'strategies/DCABot/DCABotDealsActiveView', { 'appData': shareData.appData, 'timeDiff': shareData.Common.timeDiff, 'deals': deals } );
}


async function viewHistoryDeals(req, res) {

	const deals = await shareData.DCABot.getDealsHistory();

	res.render( 'strategies/DCABot/DCABotDealsHistoryView', { 'appData': shareData.appData, 'timeDiff': shareData.Common.timeDiff, 'deals': JSON.parse(JSON.stringify(deals)) } );
}


async function apiGetDeals(req, res) {

	let dealsObj = JSON.parse(JSON.stringify(shareData.dealTracker));

	// Remove sensitive data
	for (let dealId in dealsObj) {

		let deal = dealsObj[dealId];
		let config = deal['deal']['config'];

		for (let key in config) {

			if (key.substring(0, 3).toLowerCase() == 'api') {

				delete config[key];
			}
		}
	}

	res.send( { 'date': new Date(), 'data': dealsObj } );
}


async function apiCreateBot(req, res) {

	let orders;
	let resData;

	let success = true;

	const body = req.body;
	const createStep = body.createStep;

	const botConfig = await shareData.Common.getConfig('bot.json');

	let botData = botConfig.data;

	botData.pair = body.pair;
	botData.dealMax = body.dealMax;
	botData.firstOrderAmount = body.firstOrderAmount;
	botData.dcaOrderAmount = body.dcaOrderAmount;
	botData.dcaMaxOrder = body.dcaMaxOrder;
	botData.dcaOrderSizeMultiplier = body.dcaOrderSizeMultiplier;
	botData.dcaOrderStartDistance = body.dcaOrderStepPercent;
	botData.dcaOrderStepPercent = body.dcaOrderStepPercent;
	botData.dcaOrderStepPercentMultiplier = body.dcaOrderStepPercentMultiplier;
	botData.dcaTakeProfitPercent = body.dcaTakeProfitPercent;

	// Set bot name
	let botName = body.botName;

	if (botName == undefined || botName == null || botName == '') {

		botName = 'DCA Bot ' + botData.pair.toUpperCase();
	}

	botData.botName = botName;

	// Only get orders, don't start bot
	orders = await shareData.DCABot.start(botData, false);

	resData = orders.data;

	if (!orders.success) {

		success = false;
	}
	else {

		if (createStep.toLowerCase() != 'getorders') {

			shareData.Telegram.sendMessage(shareData.appData.telegram_id, botName + ' (' + botData.pair.toUpperCase() + ') Started');

			// Start bot
			shareData.DCABot.start(botData, true, true);
		}
	}

	res.send( { 'date': new Date(), 'success': success, 'step': createStep, 'data': resData } );
}


async function apiStopBot(req, res) {

	let success = true;

	const body = req.body;

	const botId = body.bot_id;

	const bots = await shareData.DCABot.getBots({ 'botId': botId });

	const data = await shareData.DCABot.update(botId, { 'active': false });;

	if (!data.success) {

		success = false;
	}

	const bot = bots[0];
	const botName = bot.botName;

	shareData.Common.logger('Bot Stop ID ' + botId + ' / Success: ' + success);

	if (success) {

		shareData.Telegram.sendMessage(shareData.appData.telegram_id, botName + ' Stopped');
	}

	res.send( { 'date': new Date(), 'success': success } );
}



module.exports = {

	apiGetDeals,
	apiCreateBot,
	apiStopBot,
	viewCreateBot,
	viewActiveDeals,
	viewHistoryDeals,

	init: function(obj) {

		shareData = obj;
    }
}
