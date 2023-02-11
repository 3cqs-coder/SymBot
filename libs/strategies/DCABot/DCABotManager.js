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

			botData.active = bot[0].active;
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

	if (bots && bots.length > 0) {

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

	res.render( 'strategies/DCABot/DCABotsView', { 'appData': shareData.appData, 'getDateParts': shareData.Common.getDateParts, 'timeDiff': shareData.Common.timeDiff, 'bots': botsSort } );
}


async function viewHistoryDeals(req, res) {

	const deals = await shareData.DCABot.getDealsHistory();

	res.render( 'strategies/DCABot/DCABotDealsHistoryView', { 'appData': shareData.appData, 'getDateParts': shareData.Common.getDateParts, 'timeDiff': shareData.Common.timeDiff, 'deals': JSON.parse(JSON.stringify(deals)) } );
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

	let active = data['active'];
	let pairs = data['pairs'];
	let orders = data['orders'];
	let botData = data['botData'];
	let startCondition = botData.startConditions[0].toLowerCase();

	// Set pair to array
	botData['pair'] = pairs;

	if (!orders.success) {

		success = false;
	}
	else {

		if (createStep.toLowerCase() != 'getorders') {

			if (!isUpdate) {

				// Save initial bot configuration				
				botData['active'] = active;

				const configObj = await shareData.DCABot.initBot(true, botData);

				if (active && startCondition == 'asap') {

					// Start bot
					for (let i = 0; i < pairs.length; i++) {

						let pair = pairs[i];

						let config = JSON.parse(JSON.stringify(configObj));
						config['pair'] = pair;

						startDelay({ 'config': config, 'delay': i + 1, 'telegram': true });
					}
				}
			}
			else {

				let success = true;

				const botId = botData.botId;
				const botName = botData.botName;

				const botOrig = await shareData.DCABot.getBots({ 'botId': botId });

				// Update config data
				const configData = await shareData.DCABot.removeConfigData(botData);

				let dataObj = {
								'botName': botName,
								'active': active,
								'pair': pairs,
								'config': configData
							  };

				const data = await shareData.DCABot.update(botId, dataObj);

				if (!data.success) {

					success = false;
				}

				const bot = await shareData.DCABot.getBots({ 'botId': botId });

				if (active != botOrig[0]['active']) {

					const status = await sendUpdateStatus(botId, botName, active, success);
				}

				for (let i = 0; i < pairs.length; i++) {

					let pair = pairs[i];

					let dealsActive = await shareData.DCABot.getDeals({ 'botId': botId, 'pair': pair, 'status': 0 });

					let config = bot[0]['config'];
				
					config['pair'] = pair;
					config = await applyConfigData(botId, botName, config);

					// Start bot if active, no deals are currently running and start condition is now asap
					if (bot && bot.length > 0 && bot[0]['active'] && dealsActive.length == 0 && startCondition == 'asap') {

						startDelay({ 'config': config, 'delay': i + 1, 'telegram': false });
					}
				}
			}
		}
	}

	res.send( { 'date': new Date(), 'success': success, 'step': createStep, 'data': orders.data } );
}


async function apiEnableDisableBot(req, res) {

	let msg;
	let active;
	let success = true;

	const body = req.body;

	if (req.path.indexOf('enable') > -1) {

		active = true;
	}
	else {
	
		active = false;
	}

	const botId = req.params.botId;

	const bots = await shareData.DCABot.getBots({ 'botId': botId });

	const data = await shareData.DCABot.update(botId, { 'active': active });

	if (!data.success) {

		success = false;
	}

	const bot = bots[0];

	if (bot) {

		const botName = bot.botName;

		const status = await sendUpdateStatus(botId, botName, active, success);

		msg = 'Bot is now ' + status;

		if (active) {

			const bot = await shareData.DCABot.getBots({ 'botId': botId });

			if (bot && bot.length > 0) {

				let pairs = bot[0]['config']['pair'];

				for (let i = 0; i < pairs.length; i++) {

					let pair = pairs[i];
					let dealsActive = await shareData.DCABot.getDeals({ 'botId': botId, 'pair': pair, 'status': 0 });

					// Start bot if active and no deals currently running
					if (dealsActive.length == 0) {

						let startCondition;

						let config = bot[0]['config'];

						config['pair'] = pair;
						config = await applyConfigData(botId, botName, config);

						if (config['startConditions'] != undefined && config['startConditions'] != null && config['startConditions'] != '') {

							startCondition = config['startConditions'][0].toLowerCase();
						}

						// Only start bot if first condition is asap
						if (startCondition == undefined || startCondition == null || startCondition == '' || startCondition == 'asap') {

							startDelay({ 'config': config, 'delay': i + 1, 'telegram': false });
						}
					}
				}
			}
		}
	}
	else {

		msg = 'Invalid Bot ID';
	}

	res.send( { 'date': new Date(), 'success': success, 'data': msg } );
}


async function apiStartDeal(req, res) {

	let msg;
	let success = true;

	const body = req.body;

	let pair = body.pair;

	const botId = req.params.botId;

	const bots = await shareData.DCABot.getBots({ 'botId': botId });

	const bot = bots[0];

	if (bot) {

		let pairFound = false;
		let pairPassed = false;

		const active = bot.active;
		const pairs = bot.config.pair;
		const botName = bot.botName;

		if (!active) {

			success = false;
			msg = 'Bot is disabled';
		}
		else {

			if (pair != undefined && pair != null && pair != '') {

				pairPassed = true;

				for (let i = 0; i < pairs.length; i++) {

					if (pair.toUpperCase() == pairs[i].toUpperCase()) {

						pairFound = true;
						break;
					}				
				}
			}

			if (!pairPassed && pairs.length == 1) {

				pairFound = true;
				pair = bot.config.pair[0];
			}

			if (!pairFound) {

				success = false;
				msg = 'Pair is not in bot configuration';
			}

			if (success) {

				let dealsActive = await shareData.DCABot.getDeals({ 'botId': botId, 'pair': pair, 'status': 0 });

				// Start bot if active and no deals currently running
				if (dealsActive.length == 0) {

					let config = bot['config'];

					config['pair'] = pair;
					config = await applyConfigData(botId, botName, config);

					startDelay({ 'config': config, 'delay': 1, 'telegram': false });
				}
				else {

					success = false;
					msg = pair + ' deal is already running'
				}
			}
		}
	}
	else {

		success = false;
		msg = 'Invalid Bot ID';
	}

	res.send( { 'date': new Date(), 'success': success, 'data': msg } );
}


async function sendUpdateStatus(botId, botName, active, success) {

	let status;

	if (active) {

		status = 'enabled';
	}
	else {
	
		status = 'disabled';
	}

	shareData.Common.logger('Bot Status Changed: ID: ' + botId + ' / Status: ' + status + ' / Success: ' + success);

	if (success) {

		shareData.Telegram.sendMessage(shareData.appData.telegram_id, botName + ' is now ' + status);
	}
	
	return status;
}


async function calculateOrders(body) {

	let pair;
	let active;

	let pairs = body.pair;
	const botConfig = await shareData.Common.getConfig('bot.json');

	let botData = botConfig.data;

	botData.startConditions = [];

	if (typeof pairs !== 'string') {

		pair = pairs[0];
	}
	else {

		pair = pairs;

		pairs = [];
		pairs.push(pair);
	}

	if (body.active == undefined || body.active == null || body.active == '' || body.active == 'false' || !body.active) {

		active = false;
	}
	else {

		active = true;
	}

	botData.pair = pair;
	botData.dealMax = body.dealMax;
	botData.startConditions.push(body.startCondition);
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

	return ({ 'active': active, 'pairs': pairs, 'orders': orders, 'botData': botData });
}


async function applyConfigData(botId, botName, config) {

	// Pass bot id in config so existing bot is used
	config['botId'] = botId;
	config['botName'] = botName;
	config['dealCount'] = 0;

	return config;
}


async function startDelay(obj) {

	const configObj = JSON.parse(JSON.stringify(obj));

	const config = configObj['config'];
	const telegram = configObj['telegram'];

	// Start bot
	setTimeout(() => {
						if (telegram) {

							shareData.Telegram.sendMessage(shareData.appData.telegram_id, config.botName + ' (' + config.pair.toUpperCase() + ') Start command received.');
						}

						shareData.DCABot.start(config, true, true);

					 }, (1000 * (configObj['delay'])));
}



module.exports = {

	apiStartDeal,
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
