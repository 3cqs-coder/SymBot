'use strict';


let symbolList = { 'updated': 0, 'symbols': [] };


let shareData;


async function viewCreateUpdateBot(req, res, botId) {

	let maxMins = 60;

	let botData;
	let botUpdate = false;

	let formAction = '/api/bots/create';

	if (botId != undefined && botId != null && botId != '') {

		const bot = await shareData.DCABot.getBots({ 'botId': botId });

		if (bot && bot.length > 0) {

			botUpdate = true;
			botData = bot[0]['config'];
			
			botData.botId = botId;

			formAction = '/api/bots/update';
		}
	}

	const botConfig = await shareData.Common.getConfig('bot.json');

	const diffSec = (new Date().getTime() - new Date(symbolList['updated']).getTime()) / 1000;

	// Get new list of symbols only after n minutes have passed
	if (diffSec > (60 * maxMins)) {

		const exchange = await shareData.DCABot.connectExchange(botConfig.data);
		const symbols = await shareData.DCABot.getSymbolsAll(exchange);

		symbolList['updated'] = new Date();
		symbolList['symbols'] = [];
		symbolList['symbols'] = symbols;
	}

	if (!botUpdate) {

		botData = botConfig.data;
	}

	res.render( 'strategies/DCABot/DCABotCreateUpdateView', { 'formAction': formAction, 'appData': shareData.appData, 'botUpdate': botUpdate, 'symbols': symbolList['symbols'], 'botData': botData } );
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


async function viewBots(req, res) {

	let botsSort = [];

	const botsDb = await shareData.DCABot.getBots();

	if (botsDb.length > 0) {

		const bots = JSON.parse(JSON.stringify(botsDb));

		for (let i = 0; i < bots.length; i++) {

			let bot = bots[i];

			const botId = bot.botId;
			const botName = bot.botName;

			for (let key in bot) {

				if (key.substr(0, 1) == '$' || key.substr(0, 1) == '_') {

					delete bot[key];
				}
			}
		}

		botsSort = shareData.Common.sortByKey(bots, 'date');
		botsSort = botsSort.reverse();
	}

	res.render( 'strategies/DCABot/DCABotsView', { 'appData': shareData.appData, 'timeDiff': shareData.Common.timeDiff, 'bots': botsSort } );
}


async function viewHistoryDeals(req, res) {

	const deals = await shareData.DCABot.getDealsHistory();

	res.render( 'strategies/DCABot/DCABotDealsHistoryView', { 'appData': shareData.appData, 'timeDiff': shareData.Common.timeDiff, 'deals': JSON.parse(JSON.stringify(deals)) } );
}


async function apiGetActiveDeals(req, res) {

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


async function calculateOrders(body) {

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

	if (botData.dealMax == undefined || botData.dealMax == null || botData.dealMax == '') {

		botData.dealMax = 0;
	}
	
	// Check for bot id passed in from body for update
	if (body.botId != undefined && body.botId != null && body.botId != '') {

		botData.botId = body.botId;
	}

	// Set bot name
	let botName = body.botName;

	if (botName == undefined || botName == null || botName == '') {

		botName = 'DCA Bot ' + botData.pair.toUpperCase();
	}

	botData.botName = botName;

	// Only get orders, don't start bot
	let orders = await shareData.DCABot.start(botData, false);

	return ({ 'orders': orders, 'botData': botData });
}


async function apiCreateUpdateBot(req, res) {

	let reqPath = req.path;

	let success = true;
	let isUpdate = false;

	if (reqPath.indexOf('update') > -1) {

		isUpdate = true;
	}

	const body = req.body;
	const createStep = body.createStep;

	let data = await calculateOrders(body);

	let orders = data['orders'];
	let botData = data['botData'];

	if (!orders.success) {

		success = false;
	}
	else {

		if (createStep.toLowerCase() != 'getorders') {

			if (!isUpdate) {

				shareData.Telegram.sendMessage(shareData.appData.telegram_id, botData.botName + ' (' + botData.pair.toUpperCase() + ') Start command received.');

				// Start bot
				shareData.DCABot.start(botData, true, true);
			}
			else {

				// Update config data
				const configData = await shareData.DCABot.removeConfigData(botData);

				let dataObj = {
								'botName': botData.botName,
								'pair': botData.pair,
								'config': configData
							  };

				const data = await shareData.DCABot.update(botData.botId, dataObj);
			}
		}
	}

	res.send( { 'date': new Date(), 'success': success, 'step': createStep, 'data': orders.data } );
}


async function apiEnableDisableBot(req, res) {

	let active;
	let status;
	let success = true;

	const body = req.body;

	if (req.path.indexOf('enable') > -1) {

		active = true;
		status = 'enabled';
	}
	else {
	
		active = false;
		status = 'disabled';
	}

	const botId = req.params.botId;

	const bots = await shareData.DCABot.getBots({ 'botId': botId });

	const data = await shareData.DCABot.update(botId, { 'active': active });

	if (!data.success) {

		success = false;
	}

	const bot = bots[0];
	const botName = bot.botName;

	shareData.Common.logger('Bot Status Changed: ID: ' + botId + ' / Status: ' + status + ' / Success: ' + success);

	if (success) {

		shareData.Telegram.sendMessage(shareData.appData.telegram_id, botName + ' is now ' + status);
	}

	if (active) {

		const bot = await shareData.DCABot.getBots({ 'botId': botId });
		const dealsActive = await shareData.DCABot.getDeals({ 'botId': botId, 'status': 0 });

		// Start bot if active and no deals currently running
		if (bot && bot.length > 0 && dealsActive.length == 0) {

			let config = bot[0]['config'];

			// Pass bot id in config so existing bot is used
			config['botId'] = botId;
			config['botName'] = botName;
			config['dealCount'] = 0;

			// Start bot
			shareData.DCABot.start(config, true, true);
		}
	}

	res.send( { 'date': new Date(), 'success': success } );
}


module.exports = {

	apiGetActiveDeals,
	apiCreateUpdateBot,
	apiEnableDisableBot,
	viewBots,
	viewCreateUpdateBot,
	viewActiveDeals,
	viewHistoryDeals,

	init: function(obj) {

		shareData = obj;
    }
}
