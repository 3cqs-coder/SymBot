'use strict';


let symbolList = {};


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

	const exchangeName = botConfig.data.exchange;

	if (symbolList[exchangeName] == undefined || symbolList[exchangeName] == null) {

		symbolList[exchangeName] = {};
		symbolList[exchangeName]['symbols'] = [];
		symbolList[exchangeName]['updated'] = 0;
	}
	
	const diffSec = (new Date().getTime() - new Date(symbolList[exchangeName]['updated']).getTime()) / 1000;

	// Get new list of symbols only after n minutes have passed
	if (diffSec > (60 * maxMins)) {

		const exchange = await shareData.DCABot.connectExchange(botConfig.data);
		const symbolData = await shareData.DCABot.getSymbolsAll(exchange);

		if (symbolData.success) {

			symbolList[exchangeName]['updated'] = new Date();
			symbolList[exchangeName]['symbols'] = [];
			symbolList[exchangeName]['symbols'] = symbolData.symbols;
		}
	}

	if (!botUpdate) {

		botData = botConfig.data;
	}

	res.render( 'strategies/DCABot/DCABotCreateUpdateView', { 'formAction': formAction, 'appData': shareData.appData, 'botUpdate': botUpdate, 'symbols': symbolList[exchangeName]['symbols'], 'botData': botData } );
}


async function viewActiveDeals(req, res) {

	res.render( 'strategies/DCABot/DCABotDealsActiveView', { 'appData': shareData.appData } );
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

			bot = await removeDbKeys(bot);
		}

		botsSort = shareData.Common.sortByKey(bots, 'date');
		botsSort = botsSort.reverse();
	}

	res.render( 'strategies/DCABot/DCABotsView', { 'appData': shareData.appData, 'getDateParts': shareData.Common.getDateParts, 'timeDiff': shareData.Common.timeDiff, 'bots': botsSort } );
}


async function viewHistoryDeals(req, res) {

	res.render( 'strategies/DCABot/DCABotDealsHistoryView', { 'appData': shareData.appData } );
}


async function apiGetMarkets(req, res) {

	let pair = req.query.pair;
	let exchangeName = req.query.exchange;

	let success = true;
	let data;

	if (exchangeName == undefined || exchangeName == null || exchangeName == '') {

		success = false;
		data = 'Exchange must be specified';
	}

	if (success) {

		let config = { 'exchange': exchangeName.toLowerCase() };

		const exchange = await shareData.DCABot.connectExchange(config);

		// Get all market symbols
		if (pair == undefined || pair == null || pair == '') {
		
			data = await shareData.DCABot.getSymbolsAll(exchange);

			if (!data['success']) {

				success = false;
				data = data['msg'];
			}
			else {

				let symbols = data.symbols;

				data = {};
				data['exchange'] = exchangeName.toLowerCase();
				data['symbols'] = symbols;
			}
		}
		else {

			// Get pair information
			pair = pair.replace(/[_-]/g, '/');

			data = await shareData.DCABot.getSymbol(exchange, pair.toUpperCase());

			if (data['invalid'] || (data['error'] != undefined && data['error'] != null && data['error'] != '')) {

				success = false;
				data = data['error'];
			}
			else {
				
				data = data['info'];
			}
		}
	}

	res.send( { 'date': new Date(), 'success': success, 'data': data } );
}


async function apiGetBots(req, res) {

	let query = {};
	let botsSort = [];

	let active = shareData.Common.convertBoolean(req.query.active);

	if (active != undefined && active != null) {

		query.active = active;
	}

	const botsDb = await shareData.DCABot.getBots(query);

	if (botsDb.length > 0) {

		const bots = JSON.parse(JSON.stringify(botsDb));

		for (let i = 0; i < bots.length; i++) {

			let bot = bots[i];

			bot = await removeDbKeys(bot);

			const config = JSON.parse(JSON.stringify(bot.config));

			delete bot.date;
			delete bot.config;

			const botData = Object.assign({}, bot, config);

			bots[i] = botData;
		}

		botsSort = shareData.Common.sortByKey(bots, 'createdAt');
		botsSort = botsSort.reverse();
	}

	res.send( { 'date': new Date(), 'data': botsSort } );
}


async function apiGetDealsHistory(req, res, sendResponse) {

	const days = 1;
	const maxResults = 100;

	let dateTo;
	let dateFrom;
	let dealsArr = [];

	let fromDate = req.query.from;
	let toDate = req.query.to;
	const botId = req.query.botId;

	if (toDate == undefined || toDate == null || toDate == '') {
		
		toDate = fromDate;
	}

	const tzData = shareData.Common.getTimeZone();

	const timeZoneOffset = tzData['offset'];

	let	query = { 'sellData': { '$exists': true }, 'status': 1 };

	let queryOptions = {
							'sort': { 'sellData.date': -1 }
					   };

	if (fromDate == undefined || fromDate == null || fromDate == '') {

		queryOptions['limit'] = maxResults;
		
		//dateFrom = new Date(new Date().getTime() - (days * 24 * 60 * 60 * 1000));
		//dateTo = new Date(new Date(dateFrom).getTime() + (days * 24 * 60 * 60 * 1000));
	}
	else {

		dateFrom = new Date(fromDate + 'T00:00:00' + timeZoneOffset);
		dateTo = new Date(toDate + 'T23:59:59' + timeZoneOffset);

		query['sellData.date'] = { '$gte': dateFrom, '$lte': dateTo };
	}

	if (botId && botId != 'Default') {

		query['botId'] = botId;
	}

	const dealsHistory = await shareData.DCABot.getDeals(query, queryOptions);

	if (dealsHistory != undefined && dealsHistory != null && dealsHistory != '') {

		for (let i = 0; i < dealsHistory.length; i++) {

			const deal = dealsHistory[i];
			const sellData = deal.sellData;
			const orders = deal.orders;

			let orderCount = 0;

			for (let x = 0; x < orders.length; x++) {

				const order = orders[x];

				if (order['filled']) {

					orderCount++;
				}
			}

			if (orderCount > 0 && (sellData.date != undefined && sellData.date != null)) {

				const profitPerc = Number(sellData.profit);

				const profit = Number((Number(orders[orderCount - 1]['sum']) * (profitPerc / 100)).toFixed(2));

				const dataObj = {
									'bot_id': deal.botId,
									'bot_name': deal.botName,
									'deal_id': deal.dealId,
									'pair': deal.pair.toUpperCase(),
									'date_start': new Date(deal.date),
									'date_end': new Date(sellData.date),
									'profit': profit,
									'profit_percent': profitPerc,
									'safety_orders': orderCount - 1
								};

				dealsArr.push(dataObj);
			}
		}
	}

	dealsArr = shareData.Common.sortByKey(dealsArr, 'date_end');

	let obj = { 'date': new Date(), 'data': dealsArr.reverse() };

	if (sendResponse) {

		res.send(obj);
	}
	else {

		return obj;
	}
}


async function apiGetActiveDeals(req, res) {

	let query = {};
	let dealsArr = [];
	let dealsSort = [];

	let botsActiveObj = {};

	const body = req.body;

	let active = body.active;

	if (active == undefined || active == null || active == '') {

		active = true;
	}

	const bots = await shareData.DCABot.getBots({ 'active': active });

	let dealsObj = JSON.parse(JSON.stringify(shareData.dealTracker));

	if (bots && bots.length > 0) {

		for (let i = 0; i < bots.length; i++) {

			let bot = bots[i];

			const botId = bot.botId;
			const botName = bot.botName;

			botsActiveObj[botId] = botName;
		}
	}

	// Remove sensitive data
	for (let dealId in dealsObj) {

		let botActive = true;

		let obj = {};

		let deal = dealsObj[dealId];

		let botId = deal['deal']['botId'];
		let config = deal['deal']['config'];
		let info = JSON.parse(JSON.stringify(deal['info']));

		let dealRoot = deal['deal'];
		dealRoot = await removeDbKeys(dealRoot);

		delete deal['info'];

		for (let key in config) {

			if (key.substring(0, 3).toLowerCase() == 'api') {

				delete config[key];
			}
		}

		if (botsActiveObj[botId] == undefined || botsActiveObj[botId] == null) {

			botActive = false;
		}

		obj = Object.assign({}, obj, dealRoot);

		obj['info'] = info;
		obj['info']['bot_active'] = botActive;

		dealsArr.push(obj);
	}

	dealsSort = shareData.Common.sortByKey(dealsArr, 'date');
	dealsSort = dealsSort.reverse();

	res.send( { 'date': new Date(), 'data': dealsSort } );
}


async function apiUpdateDeal(req, res) {

	let success = true;
	let isUpdate = false;

	let content;

	const body = req.body;
	const dealId = req.params.dealId;

	const dcaMaxOrder = body.dcaMaxOrder;
	const dcaTakeProfitPercent = body.dcaTakeProfitPercent;

	const data = await shareData.DCABot.getDeals({ 'dealId': dealId });

	if (data && data.length > 0) {

		let dealData = await removeDbKeys(JSON.parse(JSON.stringify(data[0])));

		const status = dealData['status'];
		const filledOrders = dealData.orders.filter(item => item.filled == 1);

		if (status != 0) {

			success = false;
			content = 'Deal ID ' + dealId + ' is not active';
		}
		else {

			content = 'Deal ID ' + dealId + ' updated';

			let config = dealData['config'];

			const configOrig = JSON.parse(JSON.stringify(config));

			const botId = configOrig['botId'];

			config['createStep'] = 'getOrders';
			config['pair'] = dealData['pair'];

			delete config['botId'];
			delete config['botName'];

			const ordersOrig = dealData['orders'];
			const price = ordersOrig[0]['price'];

			// Set first start condition
			config['startCondition'] = config['startConditions'][0];

			// Override price to recalculate from original starting price
			config['firstOrderPrice'] = price;

			// Override max safety orders if set
			if (dcaMaxOrder != undefined && dcaMaxOrder != null) {

				config['dcaMaxOrder'] = dcaMaxOrder;
				
				isUpdate = true;

				// Verify max orders
				if (dcaMaxOrder < (filledOrders.length - 1)) {

					success = false;
					content = 'Max DCA orders of ' + dcaMaxOrder + ' is less than currently filled orders of ' + (filledOrders.length - 1);
				}
			}

			// Override take profit if set
			if (dcaTakeProfitPercent != undefined && dcaTakeProfitPercent != null) {

				config['dcaTakeProfitPercent'] = dcaTakeProfitPercent;
				
				isUpdate = true;
			}

			if (success) {

				// Get newly calculated order steps
				let data = await calculateOrders(config);

				// Replace config data
				config['startCondition'] = configOrig['startCondition'];
				config['botId'] = configOrig['botId'];
				config['botName'] = configOrig['botName'];

				delete config['firstOrderPrice'];

				let orderSuccess = data['orders']['success'];

				if (orderSuccess) {

					let orderHeaders = data['orders']['data']['orders']['headers'];
					let orderSteps = data['orders']['data']['orders']['steps'];
					let orderContent = data['orders']['data']['content'];

					let maxDeviationPercent = orderContent['max_deviation_percent'];

					let ordersNew = await shareData.DCABot.updateOrders({ 'orig': [], 'new': orderSteps });
					let ordersValidate = await shareData.DCABot.ordersValid(dealData['pair'], ordersNew);

					// Verify new order step price averages
					if (!ordersValidate['success']) {

						success = false;
						content = ordersValidate['data'];
					}
					else if (isUpdate) {

						let stopData = await shareData.DCABot.stopDeal(dealId);

						// Verify deal is stopped
						if (stopData['success']) {

							// Apply new order calculations to deal, update db, then resume
							let ordersNew = await shareData.DCABot.updateOrders({ 'orig': ordersOrig, 'new': orderSteps });

							// Update deal in database
							let dataUpdate = await shareData.DCABot.updateDeal(botId, dealId, { 'config': config, 'orders': ordersNew });

							// Check for active deal and resume
							let dealActive = await shareData.DCABot.getDeals({ 'status': 0, 'dealId': dealId });

							if (dealActive && dealActive.length > 0) {

								let deal = dealActive[0];

								await shareData.DCABot.resumeDeal(deal);

								// DB update failed
								if (!dataUpdate['success']) {

									success = false;
									content = 'Error updating deal in database';
								}
							}
						}
						else {

							success = false;
							content = stopData['data'];
						}
					}
				}
				else {

					success = false;
					content = 'Unable to calculate orders';
				}
			}
		}
	}
	else {

		success = false;
		content = 'Invalid Deal ID';
	}

	res.send({ 'date': new Date(), 'success': success, 'data': content });
}


async function apiPanicSellDeal(req, res) {

	let success = true;

	let content = 'Success';

	const dealId = req.params.dealId;

	const data = await shareData.DCABot.getDeals({ 'dealId': dealId });

	if (data && data.length > 0) {

		let dealData = await removeDbKeys(JSON.parse(JSON.stringify(data[0])));

		const status = dealData['status'];
		
		if (status != 0) {

			success = false;
			content = 'Deal ID ' + dealId + ' is not active';
		}
		else {

			const closeData = await shareData.DCABot.panicSellDeal(dealId);

			if (!closeData['success']) {

				success = false;
				content = closeData['data'];
			}
		}
	}
	else {

		success = false;
		content = 'Invalid Deal ID';
	}

	res.send({ 'date': new Date(), 'success': success, 'data': content });
}


async function apiCreateUpdateBot(req, res) {

	let reqPath = req.path;

	let botOrig;
	let botIdMain;
	let botNameMain;

	let success = true;
	let isUpdate = false;

	let startCondition = 'asap';

	if (reqPath.indexOf('update') > -1) {

		isUpdate = true;
	}

	const body = req.body;

	const botNamePassed = body.botName;
	const createStep = body.createStep;

	if (body.pair == undefined || body.pair == null || body.pair == '') {

		success = false;
		res.send( { 'date': new Date(), 'success': success, 'data': 'Invalid Pair' } );

		return;
	}

	if (isUpdate) {

		botOrig = await shareData.DCABot.getBots({ 'botId': body.botId });

		if (botOrig && botOrig.length > 0) {

			botNameMain = botOrig[0]['config']['botName'];
		}
	}

	let data = await calculateOrders(body);

	let active = data['active'];
	let pairs = data['pairs'];
	let orders = data['orders'];
	let botData = data['botData'];

	if (botData.startConditions != undefined && botData.startConditions != null) {

		if (typeof botData.startConditions !== 'string' && botData.startConditions[0] != undefined && botData.startConditions[0] != null) {

			startCondition = botData.startConditions[0].toLowerCase();
		}
	}

	// Set pair to array
	botData['pair'] = pairs;

	if (!orders.success) {

		success = false;
	}
	else {

		if (createStep.toLowerCase() != 'getorders') {

			if (!isUpdate) {

				// Remove any bot id passed in
				delete botData['botId'];

				botData['active'] = active;

				// Save initial bot configuration
				const configObj = await shareData.DCABot.initBot(true, botData);

				botIdMain = configObj['botId'];

				if (active && startCondition == 'asap') {

					let pairCount = 0;
					let telegram = true;

					let pairMax = configObj.pairMax;

					if (pairMax == undefined || pairMax == null || pairMax == '') {

						pairMax = 0;
					}

					// Start bot
					for (let i = 0; i < pairs.length; i++) {

						if (pairMax == 0 || pairCount < pairMax) {

							let pair = pairs[i];

							let config = JSON.parse(JSON.stringify(configObj));
							config['pair'] = pair;

							if (i > 0) {
								
								telegram = false;
							}

							pairCount++;

							shareData.DCABot.startDelay({ 'config': config, 'delay': i + 1, 'telegram': telegram });
						}
					}
				}
			}
			else {

				const botId = botData.botId;
				let botName = botData.botName;

				botIdMain = botId;

				// If bot name was not passed then use original
				if (botNamePassed == undefined || botNamePassed == null || botNamePassed == '') {

					botName = botNameMain;
				}

				botData['botName'] = botName;

				if (botOrig && botOrig.length > 0) {

					// Update config data
					const configData = await shareData.DCABot.removeConfigData(botData);

					let dataObj = {
									'botName': botName,
									'active': active,
									'pair': pairs,
									'config': configData
								  };

					const data = await shareData.DCABot.updateBot(botId, dataObj);

					if (!data.success) {

					  	success = false;
					}

					const bot = await shareData.DCABot.getBots({ 'botId': botId });

					if (active != botOrig[0]['active']) {

						const status = await sendUpdateStatus(botId, botName, active, success);
					}

					// Get total active pairs currently running on bot
					let botDealsActive = await shareData.DCABot.getDeals({ 'botId': botId, 'status': 0 });

					let pairCount = botDealsActive.length;

					for (let i = 0; i < pairs.length; i++) {

						let pair = pairs[i];

						let dealsActive = await shareData.DCABot.getDeals({ 'botId': botId, 'pair': pair, 'status': 0 });

						let config = bot[0]['config'];

						let pairMax = config.pairMax;

						if (pairMax == undefined || pairMax == null || pairMax == '') {

							pairMax = 0;
						}

						config['pair'] = pair;
						config = await shareData.DCABot.applyConfigData(botId, botName, config);

						// Start bot if active, no deals are currently running and start condition is now asap
						if (bot && bot.length > 0 && bot[0]['active'] && dealsActive.length == 0 && (pairMax == 0 || pairCount < pairMax) && startCondition == 'asap') {

							pairCount++;

							shareData.DCABot.startDelay({ 'config': config, 'delay': i + 1, 'telegram': false });
						}
					}
				}
				else {

					// Invalid bot id
					success = false;

					orders.data.orders = '';
					orders.data.content = 'Invalid Bot ID';
				}
			}

			if (success) {

				// Set bot id
				orders.data.botId = botIdMain;
			}
		}
		else {

			// Remove bot id if only getting orders
			orders.data.botId = '';
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

	const data = await shareData.DCABot.updateBot(botId, { 'active': active });

	if (!data.success) {

		success = false;
	}

	const bot = bots[0];

	if (bot) {

		const botName = bot.botName;

		const status = await sendUpdateStatus(botId, botName, active, success);

		msg = 'Bot is now ' + status;

		if (active) {

			let pairs = bot['config']['pair'];

			// Get total active pairs currently running on bot
			let botDealsActive = await shareData.DCABot.getDeals({ 'botId': botId, 'status': 0 });

			let pairCount = botDealsActive.length;

			for (let i = 0; i < pairs.length; i++) {

				let pair = pairs[i];
				let dealsActive = await shareData.DCABot.getDeals({ 'botId': botId, 'pair': pair, 'status': 0 });

				let config = bot['config'];

				let pairMax = config.pairMax;

				if (pairMax == undefined || pairMax == null || pairMax == '') {

					pairMax = 0;
				}

				// Start bot if active and no deals currently running
				if (dealsActive.length == 0) {

					let startCondition;

					config['pair'] = pair;
					config = await shareData.DCABot.applyConfigData(botId, botName, config);

					if (config['startConditions'] != undefined && config['startConditions'] != null && config['startConditions'] != '') {

						startCondition = config['startConditions'][0].toLowerCase();
					}

					// Only start bot if first condition is asap
					if (startCondition == undefined || startCondition == null || startCondition == '' || startCondition == 'asap') {

						if (pairMax == 0 || pairCount < pairMax) {

							pairCount++;

							shareData.DCABot.startDelay({ 'config': config, 'delay': i + 1, 'telegram': false });
						}
					}
				}
			}
		}
		else {

			const botDealsActive = await shareData.DCABot.getDeals({ 'botId': botId, 'status': 0 });

			if (botDealsActive && botDealsActive.length > 0) {

				for (let i = 0; i < botDealsActive.length; i++) {

					let startCondition;

					const deal = botDealsActive[i];
					const dealId = deal.dealId;

					let config = deal.config;

					if (config['startConditions'] != undefined && config['startConditions'] != null && config['startConditions'] != '') {

						startCondition = config['startConditions'][0].toLowerCase();
					}

					if (startCondition != 'asap') {

						// Set last deal flag if not asap	
						config.dealLast = true;

						const data = await shareData.DCABot.updateDeal(botId, dealId, { 'config': config });
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

				// Get total active pairs currently running on bot
				let botDealsActive = await shareData.DCABot.getDeals({ 'botId': botId, 'status': 0 });

				let pairCount = botDealsActive.length;

				let config = bot['config'];

				let pairMax = config.pairMax;

				if (pairMax == undefined || pairMax == null || pairMax == '') {

					pairMax = 0;
				}

				// Start bot if active and no deals currently running
				if (dealsActive.length == 0) {

					if (pairMax == 0 || pairCount < pairMax) {

						config['pair'] = pair;
						config = await shareData.DCABot.applyConfigData(botId, botName, config);

						shareData.DCABot.startDelay({ 'config': config, 'delay': 1, 'telegram': false });
					}
					else {

						success = false;
						msg = 'Bot max pairs of ' + pairMax + ' reached';
					}
				}
				else {

					success = false;
					msg = pair + ' deal is already running';
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


async function removeDbKeys(bot) {

	for (let key in bot) {

		if (key.substr(0, 1) == '$' || key.substr(0, 1) == '_') {

			delete bot[key];
		}
	}
	
	return bot;
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

	if (typeof body.startCondition == 'string') {

		botData.startConditions.push(body.startCondition);
	}
	else {

		botData.startConditions = body.startCondition;
	}

	// Remove empty conditions
	botData.startConditions = botData.startConditions.filter((a) => a);

	botData.pair = pair;
	botData.dealMax = body.dealMax;
	botData.pairMax = body.pairMax;
	botData.volumeMin = body.volumeMin;
	botData.firstOrderPrice = body.firstOrderPrice;
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

	if (botData.pairMax == undefined || botData.pairMax == null || botData.pairMax == '') {

		botData.pairMax = 0;
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




module.exports = {

	apiStartDeal,
	apiGetMarkets,
	apiGetBots,
	apiGetActiveDeals,
	apiGetDealsHistory,
	apiUpdateDeal,
	apiPanicSellDeal,
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
