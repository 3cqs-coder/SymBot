'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const pathRoot = path.resolve(__dirname, ...Array(3).fill('..'));

let shareData;
// Deal starts are serialised by DCABot.requestDealStart via dealStartQueue
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

	const botConfigFile = shareData.appData.bot_config;
	const botConfig = await shareData.Common.getConfig(botConfigFile);

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

			bot = await shareData.DCABot.removeDbKeys(bot);

			const config = JSON.parse(JSON.stringify(bot.config));

			const maxFundsObj = await shareData.DCABot.calculateMaxFunds(config);

			const maxFundsCamelCaseObj = shareData.Common.convertToCamelCase(maxFundsObj);

			bot.config = Object.assign({}, config, maxFundsCamelCaseObj);
		}

		botsSort = shareData.Common.sortByKey(bots, 'date');
		botsSort = botsSort.reverse();
	}

	res.render( 'strategies/DCABot/DCABotsView', { 'appData': shareData.appData, 'getDateParts': shareData.Common.getDateParts, 'timeDiff': shareData.Common.timeDiff, 'bots': botsSort } );
}


async function viewHistoryDeals(req, res) {

	res.render( 'strategies/DCABot/DCABotDealsHistoryView', { 'appData': shareData.appData } );
}


async function apiAiAnalyzeDeal(req, res, sendResponse = true) {

	let dataOut;
	let prompt = {};
	let success = false;

	const body = req.body;

	const queryOverride = {			
		'dealId': body.dealId,
		'timeframe': body.timeframe ?? '1h',
		'limit': body.limit ?? 200,
		'prompt': body.prompt,
		'template': body.template,
		'timeZoneOffset': body.timeZoneOffset ?? '+00:00'
	}

	req.queryOverride = queryOverride;

	if (queryOverride.prompt && queryOverride.prompt != '') {

		const data = await shareData.DCABot.getDeals({ 'dealId': queryOverride.dealId });

		if (data && data.length > 0) {

			prompt.success = true;
			prompt.data = queryOverride.prompt;

			success = true;
		}
		else {

			prompt.error = 'Deal ID ' + queryOverride.dealId + ' not found';

			success = false;
		}
	}
	else {

		prompt = await apiAiAnalyzeDealPrompt(req, res, false);
	}

	if (prompt.success) {

		const aiBody = {
						'message': {
							'content': prompt.data,
 							'room': 'aiAnalyze' + Math.floor(1000 + Math.random() * 90000),
							'stream': false
						}
					};

		let aiOut;

		try {

			aiOut = await shareData.AIClient.streamChat(JSON.stringify(aiBody));

		}
		catch (e) {

			aiOut = { success: false, data: e.message };
		}

		if (aiOut.success) {

			success = true;
		}

		dataOut = aiOut.data;
	}
	else {

		success = false;

		dataOut = prompt.error;
	}

	const obj = { 'date': new Date(), 'success': success, 'data': dataOut };

	if (sendResponse) {

		res.send(obj);
	}
	else {

		return obj;
	}
}


async function apiAiAnalyzeDealPrompt(req, res, sendResponse = true) {

	let success = true;
	let error = null;

	let sumTotal = 0;
	let qtySumTotal = 0;
	let ohlcvData = null;
	let indicators = null;
	let renderedHtml = null;

	const query = req.queryOverride ?? req.query;

	const dealId = query.dealId;
	const timeframe = query.timeframe;
	const since = query.since;
	const limit = query.limit;
	const timeZoneOffset = query.timeZoneOffset;

	const template = (typeof query.template === 'string' && query.template.trim())
		? query.template
		: 'aiAnalyzeDealView.ejs';

	try {

		const dealTracker = await shareData.DCABot.getDealTracker();
		const dealEntry = dealTracker?.[dealId];

		if (!dealEntry?.deal) {

			throw new Error(`Deal ID not found: ${dealId}`);
		}

		const deal = dealEntry.deal;
		const pair = deal.config.pair;
		const exchangeName = deal.exchange;
		const orders = deal.orders;

		const filledOrders = (orders || []).filter(o => o && o.filled);

		const exchange = await shareData.DCABot.connectExchange({
			exchange: exchangeName.toLowerCase()
		});

		const dataObj = await shareData.DCABot.getOHLCV(
			exchange,
			pair,
			timeframe,
			since,
			limit
		);

		if (dataObj.success) {

			ohlcvData = dataObj.data;
		}

		if (Array.isArray(ohlcvData)) {

			try {

				indicators = shareData.TradingSignals.computeMarketIndicators(ohlcvData, { timeframe });
			}
			catch {

				indicators = null;
			}
		}

		for (const order of filledOrders) {

			sumTotal += order.amount || 0;
			qtySumTotal += order.qty || 0;
		}

		// ---------- RENDER ----------
		const renderData = {
			dealId,
			dealInfo: dealTracker[dealId].info,
			dealDate: deal.date,
			config: deal.config,
			pair,
			orders: filledOrders,
			sumTotal,
			qtySumTotal,
			ohlcvData: JSON.stringify(ohlcvData),
			indicators,
			timeframe,
			timeZoneOffset,
			getDateParts: shareData.Common.getDateParts
		};

		// Inline template support
		if (template && template.includes('<%')) {

			renderedHtml = await ejs.render(template, renderData, {
				async: true
			});
		}
		else {

			const viewPath = pathRoot + '/libs/webserver/public/views/strategies/DCABot/ai/' + template;

			renderedHtml = await ejs.renderFile(viewPath, renderData, {
				async: true
			});
		}
	}
	catch (err) {

		success = false;
		error = err?.message || err.toString();
	}

	const obj = {
		date: new Date(),
		success,
		error,
		data: renderedHtml
	};

	if (sendResponse) {

		res.send(obj);
	}
	else {

		return obj;
	}
}


async function apiGetMarkets(req, res, sendResponse = true) {

	const apiPath = req.params.path;

	let pair = req.query.pair;
	let exchangeName = req.query.exchange;
	let timeframe = req.query.timeframe ?? '5m';
	let since = req.query.since || undefined;
	let limit = req.query.limit || undefined;

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
		if (!apiPath && (pair == undefined || pair == null || pair == '')) {

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

			if (apiPath != undefined && apiPath != null && apiPath != '') {

				if (apiPath == 'ohlcv' && exchange.has['fetchOHLCV']) {

					const dataObj = await shareData.DCABot.getOHLCV(exchange, pair, timeframe, since, limit);

					data = dataObj.data;
					success = dataObj.success;
				}
				else {

					success = false;
					data = 'Invalid path or unable to retrieve data';
				}
			}
			else {

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
	}

	const obj = { 'date': new Date(), 'success': success, 'data': data };

	if (sendResponse) {

		res.send(obj);
	}
	else {

		return obj;
	}
}


async function apiGetBots(req, res, sendResponse = true) {

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

			bot = await shareData.DCABot.removeDbKeys(bot);

			const config = JSON.parse(JSON.stringify(bot.config));

			const maxFundsObj = await shareData.DCABot.calculateMaxFunds(config);

			delete bot.date;
			delete bot.config;

			const maxFundsCamelCaseObj = shareData.Common.convertToCamelCase(maxFundsObj);

			const botData = Object.assign({}, bot, config, maxFundsCamelCaseObj);

			bots[i] = botData;
		}

		botsSort = shareData.Common.sortByKey(bots, 'createdAt');
		botsSort = botsSort.reverse();
	}

	const resObj = { 'date': new Date(), 'data': botsSort };

	if (sendResponse) {

		res.send(resObj);
	}
	else {

		return resObj;
	}
}


async function apiGetDealsHistory(req, res, sendResponse) {

	const days = 1;
	const maxResults = 100;

	let fromDate = req.query.from;
	let toDate = req.query.to || fromDate;
	const timeZoneOffset = req.query.timeZoneOffset;
	const botId = req.query.botId;

	let query = { 'sellData': { '$exists': true }, 'status': 1 };
	let queryOptions = { sort: { 'sellData.date': -1 } };

	if (!fromDate) {

		queryOptions['limit'] = maxResults;
	}
	else {

		const dateFrom = new Date(`${fromDate}T00:00:00${timeZoneOffset}`);
		const dateTo = new Date(new Date(`${toDate}T00:00:00${timeZoneOffset}`).getTime() + 86400000);

		query['sellData.date'] = { '$gte': dateFrom, '$lt': dateTo };
	}

	if (botId && botId !== 'Default') {

		query['botId'] = botId;
	}

	const dealsHistory = await shareData.DCABot.getDeals(query, queryOptions);
	const dealsArr = await getProcessedDeals(dealsHistory || []);

	const obj = { date: new Date(), data: dealsArr };

	if (sendResponse) {

		res.send(obj);
	}
	else {

		return obj;
	}
}


async function apiShowDeal(req, res, dealId, sendResponse = true) {

	let content;
	let priceLast;

	let active = true;
	let success = true;

	const data = await shareData.DCABot.getDeals({ 'dealId': dealId });

	if (data && data.length > 0) {

		let price;

		const dealDataDb = await shareData.DCABot.removeDbKeys(JSON.parse(JSON.stringify(data[0])));

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

	const resObj = { 'date': new Date(), 'success': success, 'data': content };

	if (sendResponse) {

		res.send(resObj);
	}
	else {

		return resObj;
	}
}


async function apiGetActiveDeals(req, res, sendResponse = true) {

	const body = req.query;

	let active = body.active;

	const deals = await shareData.DCABot.getActiveDeals(active);

	const obj = { 'date': new Date(), 'data': deals };

	if (sendResponse) {

		res.send(obj);
	}
	else {

		return obj;
	}
}


async function apiUpdateDeal(req, res, sendResponse = true, directDealId = null, directData = null) {

	let success = true;
	let isUpdate = false;
	let dealLastUpdate = false;

	let content;

	// Extract params from req for HTTP path, or from direct params for Worker path
	const dealId          = directDealId   ?? req?.params?.dealId;
	const body            = directData     ?? req?.body ?? {};

	let dealLast              = body.dealLast;
	const dcaMaxOrder         = body.dcaMaxOrder;
	const dcaTakeProfitPercent = body.dcaTakeProfitPercent;
	const profitCurrency      = body.profitCurrency;

	const data = await shareData.DCABot.getDeals({ 'dealId': dealId });

	if (data && data.length > 0) {

		let dealData = await shareData.DCABot.removeDbKeys(JSON.parse(JSON.stringify(data[0])));

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

			// Set profitCurrency if defined to not change current status
			if (profitCurrency != undefined && profitCurrency != null && profitCurrency != '') {

				config['profitCurrency'] = profitCurrency;
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

				//success = false;
				//content = 'Take profit percentage or max safety orders cannot be changed when manual orders are placed';
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

						// Reserve the pair slot in startDealTracker before stopping the deal.
						// This prevents the fast pre-enqueue pairMax check in requestDealStart
						// from allowing a competing signal or ASAP start to claim the slot
						// during the gap between stopDeal and resumeDeal.
						const editReserveId = shareData.Common.uuidv4();
						await shareData.DCABot.createStartDealTracker(editReserveId, botId);

						let stopData = await shareData.DCABot.stopDeal(dealId);

						// Verify deal is stopped
						if (stopData['success']) {

							// Apply new order calculations to deal, update db, then resume
							let ordersNew = await shareData.DCABot.updateOrders({ 'orig': ordersOrig, 'new': orderSteps, 'metadata': ordersMetadata });

							// Update deal in database
							let dataUpdate = await shareData.DCABot.updateDeal(botId, dealId, { 'config': config, 'orders': ordersNew });

							let recalcObj = await shareData.DCABot.recalculateOrders({
								'exchange': undefined,
								'dealId': dealId,
								'orderIndex': undefined,
								'orderNo': 1,
								'orderId': undefined,
								'price': undefined,
								'dryRun': false
							});

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

						// Release the reservation once resumeDeal has completed (or failed)
						await shareData.DCABot.deleteStartDealTracker(editReserveId);
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

	if (sendResponse) {

		res.send(resObj);
	}
	else {

		return resObj;
	}
}


async function apiPanicSellDeal(req, res, sendResponse = true) {

	let success = true;

	let content = 'Success';

	const dealId = req.params.dealId;

	const data = await shareData.DCABot.getDeals({ 'dealId': dealId });

	if (data && data.length > 0) {

		let dealData = await shareData.DCABot.removeDbKeys(JSON.parse(JSON.stringify(data[0])));

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

	if (sendResponse) {

		res.send(resObj);
	}

	return resObj;
}


async function apiPauseDeal(req, res, sendResponse = true) {

	let success = true;

	let content = 'Success';

	const dealId = req.params.dealId;

	let pause = shareData.Common.convertBoolean(req.body.pause);
	let pauseBuy = shareData.Common.convertBoolean(req.body.pauseBuy);
	let pauseSell = shareData.Common.convertBoolean(req.body.pauseSell);

	const data = await shareData.DCABot.getDeals({ 'dealId': dealId });

	if (data && data.length > 0) {

		let dealData = await shareData.DCABot.removeDbKeys(JSON.parse(JSON.stringify(data[0])));

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

			// Clear pauseReason on manual pause/resume — user is taking control
			const pauseData = await shareData.DCABot.pauseDeal(botId, dealId, pause, pauseBuy, pauseSell, '');

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

	if (sendResponse) {

		res.send(resObj);
	}

	return resObj;
}


async function apiCancelDeal(req, res, sendResponse = true) {

	let success = true;

	let content = 'Success';

	const dealId = req.params.dealId;

	const data = await shareData.DCABot.getDeals({ 'dealId': dealId });

	if (data && data.length > 0) {

		let dealData = await shareData.DCABot.removeDbKeys(JSON.parse(JSON.stringify(data[0])));

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

	if (sendResponse) {

		res.send(resObj);
	}

	return resObj;
}


async function apiAddFundsDeal(req, res, sendResponse = true) {

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

		let dealData = await shareData.DCABot.removeDbKeys(JSON.parse(JSON.stringify(data[0])));

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

	if (sendResponse) {

		res.send(resObj);
	}

	return resObj;
}


async function apiGetBalances(req, res, sendResponse = true) {

	let success = true;

	const balances = await shareData.DCABot.getBalanceTracker();

	const resObj = { 'date': new Date(), 'success': success, 'data': balances };

	shareData.Common.logger('API Get Balances: ' + JSON.stringify(resObj));

	if (sendResponse) {

		res.send(resObj);
	}
	else {

		return resObj;
	}
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
	const createStep = body.createStep ?? '';

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

					// requestDealStart handles all checks (blacklist, pairMax, globalPairLimit)
					// inside the serial queue — no pre-check needed here
					for (let i = 0; i < pairs.length; i++) {

						const pair = pairs[i];

						let config = JSON.parse(JSON.stringify(configObj));
						config['pair'] = pair;

						if (i === 0 && notify) {

							const msg = config.botName + ' (' + pair.toUpperCase() + ') Start command received.';
							shareData.Common.sendNotification({ 'message': msg, 'type': 'bot_start', 'telegram_id': shareData.appData.telegram_id });
						}

						shareData.DCABot.requestDealStart(config, i + 1, 'bot create');
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

						const dealsActive = await shareData.DCABot.getDeals({ 'botId': botId, 'pair': pair, 'status': 0 });

						let config = bot[0]['config'];
						config['pair'] = pair;
						config = await shareData.DCABot.applyConfigData({ 'bot_id': botId, 'bot_name': botName, 'config': config });

						if (bot && bot.length > 0 && bot[0]['active'] && startCondition == 'asap') {

							// requestDealStart handles all checks inside the serial queue
							shareData.DCABot.requestDealStart(config, i + 1, 'bot update');
							pairCount++;
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


async function apiEnableDisableBot(req, res, sendResponse = true, directBotId = null, directActive = null) {

	let msg;
	let active;
	let success = true;

	// Extract params from req for HTTP path, or from direct params for Worker path
	if (directActive !== null && directActive !== undefined) {

		active = directActive;
	}
	else {

		active = req?.path?.indexOf('enable') > -1;
	}

	const botId = directBotId ?? req?.params?.botId;

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

			const pairMax = Number(bot['config']['pairMax']) || 0;

			for (let i = 0; i < pairs.length; i++) {

				// Early exit — no point enqueueing starts that are guaranteed to be blocked
				if (pairMax > 0 && pairCount >= pairMax) break;

				const pair = pairs[i];
				const dealsActive = await shareData.DCABot.getDeals({ 'botId': botId, 'pair': pair, 'status': 0 });

				let config = bot['config'];
				config['pair'] = pair;
				config = await shareData.DCABot.applyConfigData({ 'bot_id': botId, 'bot_name': botName, 'config': config });

				const startCondition = config['startConditions']?.[0]?.toLowerCase() || 'asap';

				// Only start if first condition is asap
				// requestDealStart handles all checks inside the serial queue
				if (startCondition === 'asap') {

					shareData.DCABot.requestDealStart(config, i + 1, 'bot enable');
					pairCount++;
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

	if (sendResponse) {

		res.send(resObj);
	}
	else {

		return resObj;
	}
}


async function apiDeleteBot(req, res) {

	let success = false;
	let message = '';

	try {

		const botId = req?.params?.botId;

		if (!botId) {

			message = 'Bot ID is required.';
		}
		else {

			// Check for active deals
			const activeDeals = await shareData.DCABot.getDeals({ 'botId': botId, 'status': 0 });

			if (activeDeals && activeDeals.length > 0) {

				message = `Cannot delete bot: ${activeDeals.length} active deal(s) exist. Close or cancel all deals before deleting.`;
			}
			else {

				// Delete all deal history for this bot
				const dealsDeleted = await shareData.DCABot.deleteDeals({ 'botId': botId });

				// Delete the bot
				const botDeleted = await shareData.DCABot.deleteBot({ 'botId': botId });

				if (botDeleted) {

					success = true;
					message = 'Bot and all associated deal history deleted successfully.';

					shareData.Common.logger(`Bot deleted: ${botId} — ${dealsDeleted} deal history records removed.`);
				}
				else {

					message = 'Bot not found.';
				}
			}
		}
	}
	catch (error) {

		message = 'Error deleting bot: ' + error.message;
		shareData.Common.logger(message);
	}

	res.json({ success, message });
}


async function apiStartDeal(req, res, sendResponse = true) {

	let msg;
	let dealId;
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

			if (pairFound && success) {

				let config = bot['config'];
				config['pair'] = pair;
				config = await shareData.DCABot.applyConfigData({ 'signal_id': signalId, 'bot_id': botId, 'bot_name': botName, 'config': config });

				// All further checks (blacklist, pairMax, globalPairLimit, active deals)
				// are handled authoritatively inside requestDealStart on the serial queue.
				startDelayConfig = config;
			}
		}
	}
	else {

		success = false;
		msg = 'Invalid Bot ID';
	}


	if (startDelayConfig != undefined && startDelayConfig != null) {

		const startId = await shareData.DCABot.startDelay({ 'config': startDelayConfig, 'delay': startDelaySec, 'notify': false });

		// Poll until the startDealTracker entry is removed, which confirms the
		// deal has been committed to the database and entered the deal tracker.
		// Timeout after 30 seconds to avoid hanging the response indefinitely.
		const maxWaitMs  = 30000;
		const pollMs     = 250;
		const startedAt  = Date.now();

		while (Date.now() - startedAt < maxWaitMs) {

			const trackerData = await shareData.DCABot.getStartDealTracker(startId);

			if (trackerData == undefined || trackerData == null) {

				// Start tracker removed — deal is live. Find the dealId from meta.
				const dealTracker = await shareData.DCABot.getDealTracker();

				if (dealTracker && typeof dealTracker === 'object') {

					dealId = Object.keys(dealTracker).find(id => dealTracker[id].meta?.start_id === startId);
				}

				if (dealId) {

					msg = { 'deal_id': dealId };
				}

				break;
			}

			await shareData.Common.delay(pollMs);
		}
	}

	const resObj = { 'date': new Date(), 'success': success, 'data': msg };

	shareData.Common.logger('API Start Deal: ' + JSON.stringify(resObj));

	if (sendResponse) {

		res.send(resObj);
	}

	return resObj;
}


async function calculateOrders(body) {

	let pair;
	let active;

	let pairs = body.pair;

	const botConfigFile = shareData.appData.bot_config;
	const botConfig = await shareData.Common.getConfig(botConfigFile);

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
	botData.profitCurrency = body.profitCurrency;
	botData.pairMax = body.pairMax;
	botData.pairDealsMax = body.pairDealsMax;
	botData.pairBotsDealsMax = body.pairBotsDealsMax;
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

	if (botData.pairBotsDealsMax == undefined || botData.pairBotsDealsMax == null || botData.pairBotsDealsMax == '') {

		botData.pairBotsDealsMax = 0;
	}

	if (botData.profitCurrency == undefined || botData.profitCurrency == null || botData.profitCurrency == '') {

		botData.profitCurrency = 'quote';
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


async function calculateMaxFundsExchange(configObj) {

	let config = JSON.parse(JSON.stringify(configObj));

	config['createStep'] = 'getOrders';
	config['pair'] = config['pair'][0];

	// Remove data to only calculate orders
	delete config['botId'];
	delete config['botName'];

	// Set first start condition for calculate orders
	config['startCondition'] = config['startConditions'][0];

	const orderData = await calculateOrders(config);
	const maxFunds = orderData.orders.data.content;

	return maxFunds;
}


async function getProcessedDeals(deals) {

	const processedDeals = [];

	const extractQtyValues = obj => Object.entries(obj).flatMap(([k, v]) => k === 'qty' ? [v] : (typeof v === 'object' && v ? extractQtyValues(v) : []));

	for (const deal of deals) {

		const sellData = deal.sellData;
		const orders = deal.orders;
		const config = deal.config;
		const profitCurrency = config?.profitCurrency || 'quote';

		let orderCount = orders.filter(o => o.filled).length;

		if (orderCount > 0 && sellData?.date) {

			let profitBase, profitQuote, minMoveAmount;

			const feeData = sellData.feeData;
			const profitPerc = Number(sellData.profit);

			const profitQuoteEstimate = shareData.Common.roundAmount(Number(orders[orderCount - 1]?.sum) * (profitPerc / 100));

			minMoveAmount = feeData?.minMoveAmount ?? orders[orderCount - 1]?.orderMetadata?.minimum_movement_amount;

			profitQuote = sellData.profitQuote ? Number(sellData.profitQuote) : profitQuoteEstimate;

			if (sellData.profitBase) {

				profitBase = Number(sellData.profitBase);
			}
			else {

				let profitBaseEstimate = profitQuote / Number(sellData.price);
				let adjusted = shareData.Common.adjustDecimals(profitBaseEstimate, minMoveAmount);

				if (adjusted == 0) {

					const qtyArr = extractQtyValues(orders);
					adjusted = shareData.Common.adjustDecimals(profitBaseEstimate, minMoveAmount, qtyArr);
				}

				profitBase = Number(adjusted);
			}

			processedDeals.push({
				bot_id: deal.botId,
				bot_name: deal.botName,
				deal_id: deal.dealId,
				pair: deal.pair.toUpperCase(),
				date_start: new Date(deal.date),
				date_end: new Date(sellData.date),
				price: Number(sellData.price),
				profit: profitQuote,
				profit_base: profitBase,
				profit_percent: profitPerc,
				profit_currency: profitCurrency,
				minimum_movement_amount: minMoveAmount,
				safety_orders: orderCount - 1
			});
		}
	}

	return shareData.Common.sortByKey(processedDeals, 'date_end').reverse();
}


async function getDashboardData({ duration, timeZoneOffset }) {

	let maxDealsPerBot = 1;

	const cleanedOffset = timeZoneOffset.replace(':', '');
    const offsetSign = cleanedOffset.startsWith('-') ? -1 : 1;
    const offsetHours = parseInt(cleanedOffset.slice(1, 3), 10);
    const offsetMinutes = parseInt(cleanedOffset.slice(3), 10);
    const totalOffsetMinutes = offsetSign * (offsetHours * 60 + offsetMinutes);

    const localNow = new Date(Date.now() + totalOffsetMinutes * 60000);
    const localDateOnly = new Date(localNow.getFullYear(), localNow.getMonth(), localNow.getDate());
    const localMidnightUTC = new Date(localDateOnly.getTime() - totalOffsetMinutes * 60000);

    const dateTo = new Date(localMidnightUTC.getTime() + 86400000 - 1);
    const X_DAYS_AGO = new Date(localMidnightUTC.getTime() - duration * 86400000);

    const botConfigFile = shareData.appData.bot_config;
    const { data } = await shareData.Common.getConfig(botConfigFile);

    const active_deals = await shareData.DCABot.getDeals({ status: 0 });
    const raw_deals = await shareData.DCABot.getDeals({
        status: 1,
        'sellData.date': { $gte: X_DAYS_AGO, $lt: new Date(dateTo.getTime() + 1) }
    });
    const complete_deals = await getProcessedDeals(raw_deals);

    const max_funds_deals = await shareData.DCABot.getDealsMaxUsedFunds(maxDealsPerBot);
    const deal_tracker = await shareData.DCABot.getDealTracker();

    const adjustedEndDate = new Date(dateTo.getTime() - 86400000);
    const startParts = shareData.Common.getDateParts(X_DAYS_AGO, false);
    const endParts = shareData.Common.getDateParts(adjustedEndDate, false);
    const period = `${startParts.month}/${startParts.day}/${startParts.year} - ${endParts.month}/${endParts.day}/${endParts.year}`;

    const isLoading = active_deals.length !== Object.keys(deal_tracker).length;

    let profit_by_bot_map = {};
    let active_pl_map = {};
    let profit_by_day_map = {};
    let adjusted_pl_map = {};
    let bot_deal_duration_map = {};
    let bot_funds_in_use_map = {};
    let max_funds_deals_map = {};
    let win_rate_map = {};
    let pair_profit_map = {};
    let so_utilisation_map = {};
    let total_profit = 0;
    let total_in_deals = 0;
    let total_pl = 0;
    let currencies = [];

    // Available balance
    const available_balance = await (async () => {
        const exchangeObj = shareData.appData.bots?.exchange;
        if (exchangeObj) {
            for (let exchangeName in exchangeObj) {
                if (exchangeName.toLowerCase() === 'default') {
                    const exchangeSingleObj = exchangeObj[exchangeName];
                    const currenciesArr = exchangeSingleObj['account_balance_currencies'];
                    if (Array.isArray(currenciesArr)) currencies = currenciesArr;
                }
            }
        }

        if (data.sandBox) return Object.fromEntries(currencies.map(c => [c, data.sandBoxWallet]));

        const exchange = await shareData.DCABot.connectExchange(data);
        const { success, balance } = await shareData.DCABot.getBalance(exchange);
        return success ? balance : {};
    })();

    // Bot map helpers
    const allBots = await shareData.DCABot.getBots();
    const botIdNameMap = {};
    allBots.forEach(bot => botIdNameMap[bot.botId] = bot.botName || `Bot (${bot.botId})`);

    const getBotKey = (botIdOrName) => botIdNameMap[botIdOrName] || botIdOrName;

    // Process completed deals
    complete_deals.forEach(deal => {
        const botKey = getBotKey(deal.botId || deal.bot_name);

        // Profit by bot
        if (!profit_by_bot_map[botKey]) profit_by_bot_map[botKey] = 0;
        if (typeof deal.profit === 'number') {
            profit_by_bot_map[botKey] += deal.profit;
            total_profit += deal.profit;
        }

        // Profit by day
        const dayKey = deal.date_end.toDateString();
        profit_by_day_map[dayKey] = (profit_by_day_map[dayKey] || 0) + (deal.profit || 0);

        // Deal duration
        const durationMinutes = shareData.Common.dealDurationMinutes(deal.date_start, deal.date_end);
        if (!bot_deal_duration_map[botKey]) bot_deal_duration_map[botKey] = [];
        bot_deal_duration_map[botKey].push(durationMinutes);

        // Win rate
        if (!win_rate_map[botKey]) win_rate_map[botKey] = { wins: 0, total: 0 };
        win_rate_map[botKey].total++;
        if ((deal.profit || 0) > 0) win_rate_map[botKey].wins++;

        // Profit by pair
        const pairKey = deal.pair || 'Unknown';
        pair_profit_map[pairKey] = (pair_profit_map[pairKey] || 0) + (deal.profit || 0);

        // Safety order utilisation
        if (!so_utilisation_map[botKey]) so_utilisation_map[botKey] = [];
        so_utilisation_map[botKey].push(deal.safety_orders || 0);
    });

    // Average deal durations
    for (const key in bot_deal_duration_map) {
        const durations = bot_deal_duration_map[key];
        bot_deal_duration_map[key] = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
    }

    // Average SO utilisation
    for (const key in so_utilisation_map) {
        const sos = so_utilisation_map[key];
        so_utilisation_map[key] = Number((sos.reduce((a, b) => a + b, 0) / sos.length).toFixed(1));
    }

    // Win rate as percentage
    for (const key in win_rate_map) {
        const { wins, total } = win_rate_map[key];
        win_rate_map[key] = total > 0 ? Math.round((wins / total) * 100) : 0;
    }

    // Sort profit by day
    profit_by_day_map = Object.fromEntries(
        Object.entries(profit_by_day_map).sort((a, b) => new Date(a[0]) - new Date(b[0]))
    );

    // Equity curve — cumulative profit over time
    let running = 0;
    const equity_curve_map = Object.fromEntries(
        Object.entries(profit_by_day_map).map(([day, profit]) => {
            running += profit;
            return [day, Number(running.toFixed(2))];
        })
    );

    // Active P/L and Funds in Use
    for (const key in deal_tracker) {

        const { deal: { botId, botName, orders }, info: { profit } } = deal_tracker[key];
        const botKey = getBotKey(botId || botName);
        if (!profit) continue;

        active_pl_map[botKey] = (active_pl_map[botKey] || 0) + profit;
        total_pl += profit;

        let inDeal = 0;
        for (const order of orders) {
            if (order.filled) inDeal = Number(order.sum);
            else break;
        }
        bot_funds_in_use_map[botKey] = (bot_funds_in_use_map[botKey] || 0) + inDeal;
        total_in_deals += inDeal;
    }

    // Adjusted P/L
    for (const botKey in profit_by_bot_map) {

        if (active_pl_map[botKey] != null) {
            adjusted_pl_map[botKey] = active_pl_map[botKey] + profit_by_bot_map[botKey];
        }
    }

    // Max funds deals
    max_funds_deals.data.forEach(bot => {
        const botKey = getBotKey(bot.botId);
        if (botKey) max_funds_deals_map[botKey] = bot.maxLastSum || 0;
    });

    const sortDesc = obj => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]));
    const sortAsc = obj => Object.fromEntries(Object.entries(obj).sort((a, b) => a[1] - b[1]));

    profit_by_bot_map = sortDesc(profit_by_bot_map);
    active_pl_map = sortAsc(active_pl_map);

    // Adjusted P/L follows active P/L order
    const adjustedPlSorted = {};
    for (const botKey of Object.keys(active_pl_map)) {
        if (adjusted_pl_map[botKey] !== undefined) {
            adjustedPlSorted[botKey] = adjusted_pl_map[botKey];
        }
    }
    adjusted_pl_map = adjustedPlSorted;

    bot_deal_duration_map = sortDesc(bot_deal_duration_map);
    bot_funds_in_use_map = sortDesc(bot_funds_in_use_map);
    so_utilisation_map = sortDesc(so_utilisation_map);
    win_rate_map = sortDesc(win_rate_map);
    // Split pair profit into profitable and losing
    const pair_profit_pos_map = Object.fromEntries(
        Object.entries(pair_profit_map)
            .filter(([, v]) => v > 0)
            .sort((a, b) => b[1] - a[1])
    );

    const pair_profit_neg_map = Object.fromEntries(
        Object.entries(pair_profit_map)
            .filter(([, v]) => v <= 0)
            .sort((a, b) => a[1] - b[1])
    );

    pair_profit_map = sortDesc(pair_profit_map);

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
            bot_funds_in_use_map,
            max_funds_deals_map,
            equity_curve_map,
            win_rate_map,
            pair_profit_map,
            pair_profit_pos_map,
            pair_profit_neg_map,
            so_utilisation_map
        },
        botIdNameMap,
        currencies,
        isLoading,
        period
    };
}


async function initApp() {

	// queueStartDeal removed — deal serialisation handled by DCABot.dealStartQueue
}




async function apiUpdateBotsExchange(req, res) {

	const body     = req.body;
	const exchange = (body.exchange || '').trim().toLowerCase();

	let updated = 0;
	let skipped = 0;
	let success = exchange !== '';

	if (success) {

		try {

			const bots = await shareData.DCABot.getBots({});

			if (bots && bots.length > 0) {

				for (const bot of bots) {

					const botId = bot.botId;

					// Check for active deals — skip bots that have live trading
					const activeDeals = await shareData.DCABot.getDeals({ 'botId': botId, 'status': 0 });

					if (activeDeals && activeDeals.length > 0) {

						skipped++;
						continue;
					}

					// No active deals — safe to update exchange
					const result = await shareData.DCABot.updateBot(botId, { 'config.exchange': exchange });

					if (result.success) {

						updated++;
					}
					else {

						skipped++;
					}
				}
			}
		}
		catch (err) {

			success = false;
			shareData.Common.logger('apiUpdateBotsExchange error: ' + err.message);
		}
	}

	const resObj = { 'success': success, 'updated': updated, 'skipped': skipped };

	shareData.Common.logger('API Update Bots Exchange: ' + JSON.stringify(resObj));

	res.send(resObj);
}


module.exports = {

	apiStartDeal,
	apiUpdateBotsExchange,
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
	apiDeleteBot,
	apiGetBalances,
	apiAiAnalyzeDeal,
	apiAiAnalyzeDealPrompt,
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
