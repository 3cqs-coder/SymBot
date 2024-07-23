'use strict';

let shareData;
let queueStartDeal;
let symbolList = {};


async function viewCreateUpdateBot(req, res, botId) {

	let maxMins = 60;

	let errMsg;
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

		if (exchange) {

			let symbolData;
			let count = 0;

			let success = false;
			let finished = false;

			while (!finished) {

				symbolData = await shareData.DCABot.getSymbolsAll(exchange);

				if (symbolData.success) {

					success = true;
					finished = true;
				}
				else if (count >= 5) {

					// Timeout
					errMsg = symbolData.msg;

					success = false;
					finished = true;
				}
				else {

					await shareData.Common.delay(1000);
				}

				count++;
			}

			if (success) {

				symbolList[exchangeName]['updated'] = new Date();
				symbolList[exchangeName]['symbols'] = [];
				symbolList[exchangeName]['symbols'] = symbolData.symbols;
			}
		}
		else {

			errMsg = 'Unable to connect to exchange';
		}
	}

	if (!botUpdate) {

		botData = botConfig.data;
	}

	res.render( 'strategies/DCABot/DCABotCreateUpdateView', { 'formAction': formAction, 'appData': shareData.appData, 'botUpdate': botUpdate, 'symbols': symbolList[exchangeName]['symbols'], 'botData': botData, 'errorData': errMsg } );
}


async function viewActiveDeals(req, res) {

	res.render( 'strategies/DCABot/DCABotDealsActiveView', { 'appData': shareData.appData, 'convertBoolean': shareData.Common.convertBoolean.toString() } );
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

				data = data['data'];
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

				const profit = shareData.Common.roundAmount(Number((Number(orders[orderCount - 1]['sum']) * (profitPerc / 100))));

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


async function apiShowDeal(req, res, dealId) {

	let content;
	let priceLast;

	let active = true;
	let success = true;

	const data = await shareData.DCABot.getDeals({ 'dealId': dealId });

	if (data && data.length > 0) {

		let price;

		const dealDataDb = await removeDbKeys(JSON.parse(JSON.stringify(data[0])));

		const updated = dealDataDb['updatedAt'];
		const sellData = dealDataDb['sellData'];

		const dealTracker = await shareData.DCABot.getDealTracker();

		if (dealTracker[dealId] != undefined && dealTracker[dealId] != null) {

			priceLast = dealTracker[dealId]['info']['price_last'];
		}

		if (sellData != undefined && sellData != null) {

			price = sellData['price'];
		}

		// Use current price from deal tracker if sell price does not exist
		if (price == undefined || price == null) {

			price = priceLast;
		}

		if (dealDataDb['status']) {

			active = false;
		}

		const transformConfig = shareData.Common.convertStringToNumeric(dealDataDb['config']);
		const transformOrders = shareData.Common.convertStringToNumeric(dealDataDb['orders']);

		const dealData = await shareData.DCABot.getDealInfo({ 'updated': new Date(updated), 'active': active, 'deal_id': dealId, 'price': price, 'config': transformConfig, 'orders': transformOrders });

		content = dealData;
	}
	else {

		success = false;
		content = 'Invalid Deal ID';
	}

	res.send({ 'date': new Date(), 'success': success, 'data': content });
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

	const dealTracker = await shareData.DCABot.getDealTracker();

	if (bots && bots.length > 0) {

		for (let i = 0; i < bots.length; i++) {

			let bot = bots[i];

			const botId = bot.botId;
			const botName = bot.botName;

			botsActiveObj[botId] = botName;
		}
	}

	// Remove sensitive data
	for (let dealId in dealTracker) {

		let botActive = true;

		let obj = {};

		let deal = dealTracker[dealId];

		let botId = deal['deal']['botId'];
		let config = deal['deal']['config'];
		let info = JSON.parse(JSON.stringify(deal['info']));

		let dealRoot = deal['deal'];

		dealRoot = await removeDbKeys(dealRoot);
		dealRoot['config'] = await shareData.DCABot.removeConfigData(config);

		if (botsActiveObj[botId] == undefined || botsActiveObj[botId] == null) {

			botActive = false;
		}

		obj = Object.assign({}, obj, dealRoot);

		obj['info'] = info;
		obj['info']['bot_active'] = botActive;

		obj = shareData.Common.convertStringToNumeric(obj);

		dealsArr.push(obj);
	}

	dealsSort = shareData.Common.sortByKey(dealsArr, 'date');
	dealsSort = dealsSort.reverse();

	res.send( { 'date': new Date(), 'data': dealsSort } );
}


async function apiUpdateDeal(req, res) {

	let success = true;
	let isUpdate = false;
	let dealLastUpdate = false;

	let content;

	const body = req.body;
	const dealId = req.params.dealId;

	let dealLast = body.dealLast;
	const dcaMaxOrder = body.dcaMaxOrder;
	const dcaTakeProfitPercent = body.dcaTakeProfitPercent;

	const data = await shareData.DCABot.getDeals({ 'dealId': dealId });

	if (data && data.length > 0) {

		let dealData = await removeDbKeys(JSON.parse(JSON.stringify(data[0])));

		const status = dealData['status'];
		const filledOrders = dealData.orders.filter(item => item.filled == 1);
		const manualOrders = filledOrders.filter(item => item.manual);

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

			// Remove data to only calculate orders
			delete config['botId'];
			delete config['botName'];

			const ordersOrig = dealData['orders'];
			const price = ordersOrig[0]['price'];

			// Set first start condition for calculate orders, then remove when updating
			config['startCondition'] = config['startConditions'][0];

			// Override price to recalculate from original starting price
			config['firstOrderPrice'] = price;

			// Only set deal last flag if value exists and to not change current status
			if (dealLast != undefined && dealLast != null) {

				dealLast = shareData.Common.convertBoolean(dealLast, false);
				
				if (dealLast) {
					
					config['dealLast'] = true;
				}
				else {
					
					delete config['dealLast'];
				}

				dealLastUpdate = true;
			}

			// Override max safety orders if set
			if (dcaMaxOrder != undefined && dcaMaxOrder != null) {

				if (dcaMaxOrder != config['dcaMaxOrder']) {

					isUpdate = true;
					config['dcaMaxOrder'] = dcaMaxOrder;
				}

				// Verify max orders
				if (dcaMaxOrder < (filledOrders.length - 1)) {

					success = false;
					content = 'Max DCA orders of ' + dcaMaxOrder + ' is less than currently filled orders of ' + (filledOrders.length - 1);
				}
			}

			// Override take profit if set
			if (dcaTakeProfitPercent != undefined && dcaTakeProfitPercent != null) {

				if (dcaTakeProfitPercent != config['dcaTakeProfitPercent']) {

					isUpdate = true;
					config['dcaTakeProfitPercent'] = dcaTakeProfitPercent;
				}
			}

			// Block updating until refactoring calculations can be implemented
			if (isUpdate && manualOrders.length > 0) {

				success = false;
				content = 'Take profit percentage or max safety orders cannot be changed when manual orders are placed';
			}

			if (success) {

				let data;

				if (isUpdate) {

					// Get newly calculated order steps if update required
					data = await calculateOrders(config);
				}

				// Remove and replace config data
				delete config['createStep'];
				delete config['startCondition'];
				delete config['firstOrderPrice'];

				config['botId'] = configOrig['botId'];
				config['botName'] = configOrig['botName'];

				// Only calculate if orders or tp were set
				if (data && data['orders']['success']) {

					let orderHeaders = data['orders']['data']['orders']['headers'];
					let orderSteps = data['orders']['data']['orders']['steps'];
					let orderContent = data['orders']['data']['content'];
					let ordersMetadata = data['orders']['data']['metadata'];

					let maxDeviationPercent = orderContent['max_deviation_percent'];

					let ordersNew = await shareData.DCABot.updateOrders({ 'orig': [], 'new': orderSteps, 'metadata': ordersMetadata });
					let ordersValidate = await shareData.DCABot.ordersValid(dealData['pair'], ordersNew);

					// Verify new order step price averages
					if (!ordersValidate['success']) {

						success = false;
						content = ordersValidate['data'];
					}
					else {

						let stopData = await shareData.DCABot.stopDeal(dealId);

						// Verify deal is stopped
						if (stopData['success']) {

							// Apply new order calculations to deal, update db, then resume
							let ordersNew = await shareData.DCABot.updateOrders({ 'orig': ordersOrig, 'new': orderSteps, 'metadata': ordersMetadata });

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

					if (dealLastUpdate && !isUpdate) {

						// Update last deal flag without stopping deal
						let dataUpdate = await shareData.DCABot.updateDeal(botId, dealId, { 'config': config });

						// Notify deal tracker to update
						let dataRefresh = await shareData.DCABot.refreshUpdateDeal({ 'deal_id': dealId, 'config': config });
					}
					else {

						success = false;
						content = 'Unable to calculate orders';
					}
				}
			}
		}
	}
	else {

		success = false;
		content = 'Invalid Deal ID';
	}

	const resObj = { 'date': new Date(), 'success': success, 'data': content };

	shareData.Common.logger('API Update Deal: ' + JSON.stringify(resObj));

	res.send(resObj);
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

	const resObj = { 'date': new Date(), 'success': success, 'data': content };

	shareData.Common.logger('API Panic Sell Deal: ' + JSON.stringify(resObj));

	res.send(resObj);
}


async function apiPauseDeal(req, res) {

	let success = true;

	let content = 'Success';

	const dealId = req.params.dealId;

	let pause = shareData.Common.convertBoolean(req.body.pause);
	let pauseBuy = shareData.Common.convertBoolean(req.body.pauseBuy);
	let pauseSell = shareData.Common.convertBoolean(req.body.pauseSell);

	const data = await shareData.DCABot.getDeals({ 'dealId': dealId });

	if (data && data.length > 0) {

		let dealData = await removeDbKeys(JSON.parse(JSON.stringify(data[0])));

		const botId = dealData.botId;
		const status = dealData['status'];
		
		if (status != 0) {

			success = false;
			content = 'Deal ID ' + dealId + ' is not active';
		}
		else {

			if (pauseBuy && pauseSell) {

				pause = true;

				pauseBuy = false;
				pauseSell = false;
			}

			const pauseData = await shareData.DCABot.pauseDeal(botId, dealId, pause, pauseBuy, pauseSell);

			if (!pauseData['success']) {

				success = false;
				content = pauseData['data'];
			}
		}
	}
	else {

		success = false;
		content = 'Invalid Deal ID';
	}

	const resObj = { 'date': new Date(), 'success': success, 'data': content };

	shareData.Common.logger('API Pause Deal: ' + JSON.stringify(resObj));

	res.send(resObj);
}


async function apiCancelDeal(req, res) {

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

			const cancelData = await shareData.DCABot.cancelDeal(dealId);

			if (!cancelData['success']) {

				success = false;
				content = cancelData['data'];
			}
		}
	}
	else {

		success = false;
		content = 'Invalid Deal ID';
	}

	const resObj = { 'date': new Date(), 'success': success, 'data': content };

	shareData.Common.logger('API Cancel Deal: ' + JSON.stringify(resObj));

	res.send(resObj);
}


async function apiAddFundsDeal(req, res) {

	let success = true;
	let isValid = true;

	let content = 'Success';
	
	const dealId = req.params.dealId;
	const volume = parseFloat(req.body.volume);
	const data = await shareData.DCABot.getDeals({ 'dealId': dealId });

	if (volume == undefined || volume == null || volume == 0) {

		isValid = false;
	}

	if (isValid && data && data.length > 0) {

		let dealData = await removeDbKeys(JSON.parse(JSON.stringify(data[0])));

		const status = dealData['status'];
		
		if (status != 0) {

			success = false;
			content = 'Deal ID ' + dealId + ' is not active';
		}
		else {

			const stopData = await shareData.DCABot.stopDeal(dealId);

			// Verify deal is stopped
			if (stopData['success']) {

				const addData = await shareData.DCABot.addFundsDeal(dealId, volume);

				if (!addData['success']) {

					success = false;
					content = addData['data'];
				}

				// Check for active deal and resume
				let dealActive = await shareData.DCABot.getDeals({ 'status': 0, 'dealId': dealId });

				if (dealActive && dealActive.length > 0) {

					let deal = dealActive[0];
				
					await shareData.DCABot.resumeDeal(deal);
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

		if (!isValid) {

			content = 'Volume must be greater than zero';
		}
		else {

			content = 'Invalid Deal ID';
		}
	}

	const resObj = { 'date': new Date(), 'success': success, 'data': content };

	shareData.Common.logger('API Add Funds: ' + JSON.stringify(resObj));

	res.send(resObj);
}


async function apiCreateUpdateBot(req, res) {

	let reqPath = req.path;

	let botOrig;
	let botIdMain;
	let botNameMain;

	let success = true;
	let isUpdate = false;
	let isPreview = false;

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

	if (!orders) {

		orders = {};
		orders.success = false;
		orders.data = 'Unable to calculate orders. Pair may be invalid.';
	}

	// Only process max funds if orders were successful
	if (orders.success) {

		let dealMaxFunds = orders['data']['content']['max_funds'];

		const pairMax = parseInt(botData['pairMax']);
		const pairDealsMax = Math.max(parseInt(botData['pairDealsMax']), 1);

		const bot_maxFunds = () => {
		
			if (pairMax == 0) return Math.round(dealMaxFunds * pairs.length * pairDealsMax);
			if (pairMax > pairs.length) return Math.round(dealMaxFunds * pairs.length * pairDealsMax);

			return Math.round(dealMaxFunds * pairMax * pairDealsMax);
		};

		// Add property bot_max_funds to orders object by calculating deal max funds multiplied by numbers of pairs
		orders['data']['content']['bot_max_funds'] = bot_maxFunds();
	}

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
				const configObj = await shareData.DCABot.initBot({ 'create': true, 'config': botData });

				botIdMain = configObj['botId'];

				if (active && startCondition == 'asap') {

					let pairCount = 0;
					let notify = true;

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

								notify = false;
							}

							pairCount++;

							shareData.DCABot.startDelay({ 'config': config, 'delay': i + 1, 'notify': notify });
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

						const statusObj = await shareData.DCABot.sendBotStatus({ 'bot_id': botId, 'bot_name': botName, 'active': active, 'success': success });
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
						config = await shareData.DCABot.applyConfigData({ 'bot_id': botId, 'bot_name': botName, 'config': config });

						// Start bot if active, no deals are currently running and start condition is now asap
						if (bot && bot.length > 0 && bot[0]['active'] && dealsActive.length == 0 && (pairMax == 0 || pairCount < pairMax) && startCondition == 'asap') {

							pairCount++;

							shareData.DCABot.startDelay({ 'config': config, 'delay': i + 1, 'notify': false });
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

			isPreview = true;

			// Remove bot id if only getting orders
			orders.data.botId = '';
		}
	}

	const resObj = { 'date': new Date(), 'success': success, 'step': createStep, 'data': orders.data };

	// Only log if creating or updating bot to conserve space
	if (!isPreview) {

		let isNewBot = false;

		if (!isUpdate) {

			isNewBot = true;
		}

		shareData.Common.logger('API Create / Update Bot (New Bot: ' + isNewBot + '): ' + JSON.stringify(resObj));
	}

	res.send(resObj);
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

		const statusObj = await shareData.DCABot.sendBotStatus({ 'bot_id': botId, 'bot_name': botName, 'active': active, 'success': success });

		msg = 'Bot is now ' + statusObj.status;

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
					config = await shareData.DCABot.applyConfigData({ 'bot_id': botId, 'bot_name': botName, 'config': config });

					if (config['startConditions'] != undefined && config['startConditions'] != null && config['startConditions'] != '') {

						startCondition = config['startConditions'][0].toLowerCase();
					}

					// Only start bot if first condition is asap
					if (startCondition == undefined || startCondition == null || startCondition == '' || startCondition == 'asap') {

						if (pairMax == 0 || pairCount < pairMax) {

							pairCount++;

							shareData.DCABot.startDelay({ 'config': config, 'delay': i + 1, 'notify': false });
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

	const resObj = { 'date': new Date(), 'success': success, 'data': msg };

	shareData.Common.logger('API Enable / Disable Bot: ' + JSON.stringify(resObj));

	res.send(resObj);
}


async function apiStartDeal(req, res) {

	const taskObj = { 'req': req, 'res': res, 'name': 'start_deal' };

	queueStartDeal.add(taskObj, apiStartDealProcess);
}


async function apiStartDealProcess(req, res, taskObj) {

	let msg;
	let startDelayConfig;

	let success = true;
	let startDelaySec = 1;

	const body = req.body;

	let pair = body.pair;
	let signalId = body.signalId;

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
				let pairDealsMax = config.pairDealsMax;

				if (pairMax == undefined || pairMax == null || pairMax == '') {

					pairMax = 0;
				}

				if (pairDealsMax == undefined || pairDealsMax == null || pairDealsMax == '') {

					pairDealsMax = 0;
				}

				// Start bot if active and no deals currently running or pair deals is less than max set
				if (dealsActive.length == 0 || dealsActive.length < pairDealsMax) {

					if (pairMax == 0 || pairCount < pairMax) {

						config['pair'] = pair;
						config = await shareData.DCABot.applyConfigData({ 'signal_id': signalId, 'bot_id': botId, 'bot_name': botName, 'config': config });

						startDelayConfig = config;
					}
					else {

						success = false;
						msg = 'Bot max ' + pairMax + ' pairs reached';
					}
				}
				else {

					let displayMax = pairDealsMax;

					if (displayMax < 2) {

						displayMax = 1;
					}

					success = false;
					msg = pair + ' pair max ' + displayMax + ' deals already running';
				}
			}
		}
	}
	else {

		success = false;
		msg = 'Invalid Bot ID';
	}


	if (startDelayConfig != undefined && startDelayConfig != null) {

		let finished = false;

		const startId = await shareData.DCABot.startDelay({ 'config': startDelayConfig, 'delay': startDelaySec, 'notify': false });

		// Wait for start deal tracker to be removed to confirm deal started
		while (!finished) {

			let trackerData = await shareData.DCABot.getStartDealTracker(startId);

			if (trackerData == undefined || trackerData == null) {

				finished = true;
			}
			else {

				await shareData.Common.delay(500);
			}
		}
	}

	const resObj = { 'date': new Date(), 'success': success, 'data': msg };

	shareData.Common.logger('API Start Deal: ' + JSON.stringify(resObj));

	queueStartDeal.callBack(res, resObj, taskObj);
}


async function removeDbKeys(bot) {

	for (let key in bot) {

		if (key.substr(0, 1) == '$' || key.substr(0, 1) == '_') {

			delete bot[key];
		}
	}
	
	return bot;
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
	botData.dealCoolDown = body.dealCoolDown;
	botData.pairMax = body.pairMax;
	botData.pairDealsMax = body.pairDealsMax;
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

	if (botData.dealCoolDown == undefined || botData.dealCoolDown == null || botData.dealCoolDown == '') {

		botData.dealCoolDown = 0;
	}

	if (botData.pairMax == undefined || botData.pairMax == null || botData.pairMax == '') {

		botData.pairMax = 0;
	}

	if (botData.pairDealsMax == undefined || botData.pairDealsMax == null || botData.pairDealsMax == '') {

		botData.pairDealsMax = 0;
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
	let orders = await shareData.DCABot.start({ 'create': false, 'config': botData });

	return ({ 'active': active, 'pairs': pairs, 'orders': orders, 'botData': botData });
}


function insertValueToMap(map, key, value) {
	if(!map[key]) {
		map[key] = Number(value);
	} else {
		map[key] += Number(value);
	}
}

async function getDashboardData({ duration }) {
	const { year, month, day } = shareData.Common.getDateParts(new Date());
	const today = new Date(`${year}-${month}-${day}` + 'T23:59:59');
	const X_DAYS_AGO = new Date();
	X_DAYS_AGO.setDate(X_DAYS_AGO.getDate() - duration);
	X_DAYS_AGO.setHours(0, 0, 0);

	const { data } = await shareData.Common.getConfig('bot.json');

	const active_deals = await shareData.DCABot.getDeals({ status: 0 });
	const complete_deals = await shareData.DCABot.getDeals({ status: 1, "sellData.date": { $gte: X_DAYS_AGO, $lte: today } });
	const deal_tracker = await shareData.DCABot.getDealTracker();
	const period = `${X_DAYS_AGO.toLocaleDateString()} - ${today.toLocaleDateString()}`

	const isLoading = active_deals.length != Object.keys(deal_tracker).length;

	let profit_by_bot_map = {};
	let active_pl_map = {};
	let profit_by_day_map = {};
	let adjusted_pl_map = {};
	let bot_deal_duration_map = {};
	let bot_funds_in_use_map = {};
	let total_profit = 0;
	let total_in_deals = 0;
	let total_pl = 0;

	let currencies = [];

	const available_balance = await (async () => {

		if (shareData.appData.bots['exchange'] != undefined && shareData.appData.bots['exchange'] != null && typeof shareData.appData.bots['exchange'] == 'object') {

			const exchangeObj = shareData.appData.bots['exchange'];
	
			for (let exchangeName in exchangeObj) {
	
				if (exchangeName.toLowerCase() == 'default') {
	
					const exchangeSingleObj = exchangeObj[exchangeName];
	
					const currenciesArr = exchangeSingleObj['account_balance_currencies'];

					if (typeof currenciesArr == 'object') {

						currencies = currenciesArr;
					}
				}
			}
		}

		if (data.sandBox) {

			let resObj = {};

			for (let i = 0; i < currencies.length; i++) {

				let currency = currencies[i];

				resObj[currency] = data.sandBoxWallet;
			}

			return resObj;
		}

		const exchange = await shareData.DCABot.connectExchange(data);
		const { success, balance } = await shareData.DCABot.getBalance(exchange);
		if(!success) return {};
		return balance;
	})();

	complete_deals.forEach((deal) => {
		let orderCount = 0;

		const { sellData, orders} = deal;

		for(let i = 0; i<orders.length;i++) {
			const order = orders[i];

			if (order['filled']) {

				orderCount++;
			}
		}

		if (orderCount > 0 && (sellData.date != undefined && sellData.date != null)) {
			if(sellData.profit && typeof sellData.profit == 'number') {
				const profitPer = Number(sellData.profit);
				const deal_profit = shareData.Common.roundAmount(Number((Number(orders[orderCount - 1]['sum']) * (profitPer / 100))));
				insertValueToMap(profit_by_bot_map, deal.botName, deal_profit);
				insertValueToMap(profit_by_day_map, deal.sellData.date.toDateString(), deal_profit);
				total_profit += Number(deal_profit ?? 0);
			}
		}

		// Add to Deal Duration Obj
		const { date: dateStarted, sellData: { date: dateEnd } } = deal;
		const duration = shareData.Common.dealDurationMinutes(dateStarted, dateEnd);
		if(!bot_deal_duration_map[deal.botName]) {
			bot_deal_duration_map[deal.botName] = [duration];
		} else {
			bot_deal_duration_map[deal.botName].push(duration);
		}
	})

	for (const key in bot_deal_duration_map) {
		const durations = bot_deal_duration_map[key];
		const average = durations.reduce((acc, curr) => acc + curr, 0) / durations.length;
		bot_deal_duration_map[key] = Math.round(average);
	}

	// Sort the object by date
	profit_by_day_map = Object.fromEntries(Object.entries(profit_by_day_map).sort((a, b) => new Date(a[0]) - new Date(b[0])));


	for(const key in deal_tracker) {
		const { deal: { botName }, info: { profit } } = deal_tracker[key];
		if(!profit || !botName) { continue; };
		insertValueToMap(active_pl_map, botName, profit);
		total_pl += profit;

		const orders = deal_tracker[key].deal.orders;
		let in_deal = 0;
		for(let i=0; i < orders.length; i++) {
			if(orders[i].filled) {
				in_deal = Number(orders[i].sum);
			} else {
				break;
			}
		}
		insertValueToMap(bot_funds_in_use_map, botName, in_deal);
		total_in_deals += in_deal;
	}

	for(const key in profit_by_bot_map) {
		const total = profit_by_bot_map[key] + active_pl_map[key];
		if(total) {
			adjusted_pl_map[key] = total;
		}
	}

	// -- Sort Maps -- //
	const bot_profit_array = Object.entries(profit_by_bot_map);
	bot_profit_array.sort((a,b) =>  b[1] - a[1]);
	profit_by_bot_map = Object.fromEntries(bot_profit_array)

	const active_profit_array = Object.entries(active_pl_map);
	active_profit_array.sort((a,b) =>  a[1] - b[1] );
	active_pl_map = Object.fromEntries(active_profit_array);

	const adjusted_pl_array = Object.entries(adjusted_pl_map);
	adjusted_pl_array.sort((a,b) =>  b[1] - a[1]);
	adjusted_pl_map = Object.fromEntries(adjusted_pl_array);

	const bot_deal_duration_array = Object.entries(bot_deal_duration_map);
	bot_deal_duration_array.sort((a,b) =>  b[1] - a[1]);
	bot_deal_duration_map = Object.fromEntries(bot_deal_duration_array);

	const bot_funds_in_use_array = Object.entries(bot_funds_in_use_map);
	bot_funds_in_use_array.sort((a,b) =>  b[1] - a[1]);
	bot_funds_in_use_map = Object.fromEntries(bot_funds_in_use_array);


	return {
		kpi: {
			active_deals: Object.keys(deal_tracker).length,
			total_in_deals,
			available_balance,
			total_profit,
			total_pl
		},
		charts: {
			profit_by_bot_map,
			profit_by_day_map,
			active_pl_map,
			adjusted_pl_map,
			bot_deal_duration_map,
			bot_funds_in_use_map
		},
		currencies: currencies,
		isLoading,
		period
	}
}


async function initApp() {

	queueStartDeal = await shareData.Queue.create(1);
}


module.exports = {

	apiStartDeal,
	apiGetMarkets,
	apiGetBots,
	apiGetActiveDeals,
	apiGetDealsHistory,
	apiShowDeal,
	apiPauseDeal,
	apiCancelDeal,
	apiUpdateDeal,
	apiAddFundsDeal,
	apiPanicSellDeal,
	apiCreateUpdateBot,
	apiEnableDisableBot,
	viewBots,
	viewCreateUpdateBot,
	viewActiveDeals,
	viewHistoryDeals,
	getDashboardData,

	init: function(obj) {

		shareData = obj;

		initApp();
    }
}
