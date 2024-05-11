'use strict';

const fs = require('fs');
const path = require('path');

let pathRoot = path.dirname(fs.realpathSync(__dirname)).split(path.sep).join(path.posix.sep);
pathRoot = pathRoot.substring(0, pathRoot.lastIndexOf('/', pathRoot.lastIndexOf('/') - 1));

const colors = require('colors');
const ccxt = require('ccxt');
const Table = require('easy-table');
const Percentage = require('percentagejs');
const Common = require(pathRoot + '/libs/app/Common.js');
const Schema = require(pathRoot + '/libs/mongodb/DCABotSchema');

const Bots = Schema.Bots;
const Deals = Schema.Deals;

const insufficientFundsMsg = 'Your wallet does not have enough funds for all DCA orders!';

// Max minutes before trackers are removed
const maxMinsDeals = 2;
const maxMinsVolume = 5;

// Exchange timeout in seconds
const exchangeTimeoutSec = 10;

// Max number of times a deal will attempt to sell when an error occurs and apply additional fees if there are insufficient funds
const maxSellErrorCount = 45;

// Max time in seconds sell errors will be counted before counter is reset
const maxSellErrorResetSec = 300;

// Additional multiplier that will be applied each time a sell error occurs for a deal
const sellErrorAddFeeMultiplier = 0.25;

// Max additional percentage fee that will be applied if a sell error occurs for a deal
const sellErrorAddFeeMaxPerc = 0.05;


let dealTracker = {};
let timerTracker = {};
let startDealTracker = {};
let resumeDealTracker = {};
let balanceTracker = {};
let exchangeMarkets = {};

let shareData;


async function start(dataObj, startId) {

	let startBot = dataObj['create'];

	let data = await initBot({ 'create': startBot, 'config': JSON.parse(JSON.stringify(dataObj['config'])) });

	const dealResumeId = data['dealResumeId'];
	const firstOrderPrice = data['firstOrderPrice'];
	const isPairData = (data['pairData'] === undefined || data['pairData'] === null) ? false : data['pairData'];

	delete data['pairData'];
	delete data['dealResumeId'];
	delete data['firstOrderPrice'];

	const config = Object.freeze(JSON.parse(JSON.stringify(data)));

	let dealIdMain;
	let botConfigDb;

	let botActive = true;
	let botFoundDb = false;
	let pairFoundDb = false;
	let dealLast = false;
	let dealStop = false;
	let pairDealsLast = false;
	let checkActivePairOverride = false;

	let totalOrderSize = 0;
	let totalAmount = 0;

	let pair = '';
	let pairConfig = config.pair;
	let botIdMain = config.botId;
	let botNameMain = config.botName;
	let dealCount = config.dealCount;
	let dealMax = config.dealMax;
	let pairMax = config.pairMax;
	let pairDealsMax = config.pairDealsMax;

	if (dealCount == undefined || dealCount == null) {

		dealCount = 0;
	}

	if (dealMax == undefined || dealMax == null) {

		dealMax = 0;
	}

	if (pairMax == undefined || pairMax == null) {

		pairMax = 0;
	}

	if (pairDealsMax == undefined || pairDealsMax == null) {

		pairDealsMax = 0;
	}

	let exchange = await connectExchange(config);

	if (exchange == undefined || exchange == null) {

		return ( { 'success': false, 'data': 'Invalid exchange: ' + config.exchange } );
	}

	
	try {

		//Load markets
		//const markets = await exchange.loadMarkets();

		if (pairConfig == undefined || pairConfig == null || pairConfig == '') {

			return;
		}
		else {

			pair = pairConfig;
		}

		pair = pair.toUpperCase();

		const pairArr = pair.split('/');

		const pairBase = pairArr[0];
		const pairQuote = pairArr[1];
 
		const isActive = await checkActiveDeal(botIdMain, pair);
		const pairDealsActive = await getDeals({ 'botId': botIdMain, 'pair': pair, 'status': 0 });
		const symbolData = await getSymbol(exchange, pair);
		const symbol = symbolData.data;

		// Verify number of same pairs running on bot before start to allow override
		if (pairDealsMax > 1 && pairDealsActive.length < pairDealsMax) {

			// Only override if not resuming deal
			if (dealResumeId == undefined || dealResumeId == null || dealResumeId == '') {

				checkActivePairOverride = true;
			}
		}

		// Check for valid symbol data on start
		if (symbolData.invalid) {

			if (Object.keys(dealTracker).length == 0) {

				//process.exit(0);
			}

			return ( { 'success': false, 'data': 'Invalid Pair' } );
		}
		else if (symbolData.error != undefined && symbolData.error != null) {

			// Try again if resuming existing bot deal
			if (dealResumeId != undefined && dealResumeId != null && dealResumeId != '') {

				const retryDelay = Number((1000 + (Math.random() * 5000)).toFixed(4));

				let configObj = JSON.parse(JSON.stringify(config));

				// Reset dealResume flag
				configObj['dealResumeId'] = dealResumeId;

				const msg = 'Unable to resume ' + configObj.botName + ' / Pair: ' + pair + ' / Error: ' + symbolData.error + ' Trying again in ' + retryDelay + ' seconds';

				if (shareData.appData.verboseLog) { Common.logger( colors.bgYellow.bold(msg) ); }

				setTimeout(() => {

					start({ 'create': startBot, 'config': configObj });

				}, retryDelay);
			}

			return ( { 'success': false, 'data': JSON.stringify(symbolData.error) } );
		}

		// Remove from resumeDealTracker
		await deleteResumeDealTracker(dealResumeId);

		let askPrice = symbol.ask;

		// Override price if passed in
		if (firstOrderPrice != undefined && firstOrderPrice != null && firstOrderPrice != 0) {

			askPrice = firstOrderPrice;
		}

		const orders = [];

		if (startBot && isActive && !checkActivePairOverride) {

			dealIdMain = isActive.dealId;

			if (dealResumeId != undefined && dealResumeId != null && dealResumeId != '') {

				dealIdMain = dealResumeId;
			}

			// Config reloaded from db so continue
			//await Common.delay(1000);

			let followSuccess = false;
			let followFinished = false;
			let followConfig = config;

			while (!followFinished) {

				let followRes = await dcaFollow(followConfig, exchange, dealIdMain);

				let followConfigRes = followRes['config'];

				// Refresh config without stopping bot
				if (followConfigRes != undefined && followConfigRes != null && followConfigRes != '') {

					followConfig = JSON.parse(JSON.stringify(followConfigRes));
				}

				followSuccess = followRes['success'];
				followFinished = followRes['finished'];

				if (!followSuccess) {

					await Common.delay(1000);
				}
			}

			if (followFinished) {

				//break;
			}
		}
		else {

			let lastDcaOrderAmount = 0;
			let lastDcaOrderSize = 0;
			let lastDcaOrderSum = 0;
			let lastDcaOrderQtySum = 0;
			let lastDcaOrderPrice = 0;

			let minMoveAmount;

			if (!await volumeValid(startBot, pair, symbol, config)) {

				// Delete start deal tracker to allow immediate response from start deal API
				deleteStartDealTracker(startId);

				return;
			}

			if (config.firstOrderType.toUpperCase() == 'MARKET') {

				//first order market

				minMoveAmount = await getPairPrecision(exchange, config.exchange, pair, isPairData);

				if (shareData.appData.verboseLog) { Common.logger(colors.bgGreen('Calculating orders for ' + pair)); }

				await Common.delay(1000);

				let firstOrderSize = Number(config.firstOrderAmount) / askPrice;

				const adjustments = await calculateAdjustments({

					'exchange': exchange,
					'pair': pair,
					'amount': Number(askPrice * firstOrderSize),
					'orderSize': firstOrderSize,
					'exchangeFee': config.exchangeFee,
					'minMoveAmount': minMoveAmount
				});

				firstOrderSize = adjustments['order_qty'];
				let amount = adjustments['order_amount'];

				if (!firstOrderSize) {

					if (shareData.appData.verboseLog) { Common.logger(colors.bgRed('First order amount not valid.')); }

					return false;
				}
				else {

					totalOrderSize = firstOrderSize;
					totalAmount = config.firstOrderAmount;

					const price = await filterPrice(exchange, pair, askPrice);

					let amount = price * firstOrderSize;

					const adjustments = await calculateAdjustments({

						'exchange': exchange,
						'pair': pair,
						'amount': amount,
						'orderSize': firstOrderSize,
						'exchangeFee': config.exchangeFee,
						'minMoveAmount': minMoveAmount
					});

					firstOrderSize = adjustments['order_qty'];
					amount = adjustments['order_amount'];

					let targetPrice = await calculateTargetPrice({

						'exchange': exchange,
						'pair': pair,
						'price': price,
						'takeProfit': config.dcaTakeProfitPercent,
						'exchangeFee': config.exchangeFee
					});

					orders.push({
						orderNo: 1,
						orderId: '',
						price: price,
						average: price,
						target: targetPrice,
						qty: firstOrderSize,
						amount: amount,
						qtySum: firstOrderSize,
						sum: amount,
						type: 'MARKET',
						filled: 0,
						orderMetadata: adjustments
					});

					lastDcaOrderAmount = amount;
					lastDcaOrderSize = firstOrderSize;
					lastDcaOrderSum = amount;
					lastDcaOrderQtySum = firstOrderSize;
					lastDcaOrderPrice = price;
				}

				for (let i = 0; i < config.dcaMaxOrder; i++) {

					if (i == 0) {

						let price = Percentage.subPerc(
							lastDcaOrderPrice,
							config.dcaOrderStartDistance
						);

						price = await filterPrice(exchange, pair, price);

						let dcaOrderSize = config.dcaOrderAmount / price;
						let dcaOrderAmount = dcaOrderSize * price;

						const adjustments = await calculateAdjustments({

							'exchange': exchange,
							'pair': pair,
							'amount': dcaOrderAmount,
							'orderSize': dcaOrderSize,
							'exchangeFee': config.exchangeFee,
							'minMoveAmount': minMoveAmount
						});

						dcaOrderSize = adjustments['order_qty'];
						dcaOrderAmount = adjustments['order_amount'];

						let dcaOrderSum = parseFloat(dcaOrderAmount) + parseFloat(lastDcaOrderAmount);
						dcaOrderSum = await filterPrice(exchange, pair, dcaOrderSum);

						let dcaOrderQtySum = parseFloat(dcaOrderSize) + parseFloat(firstOrderSize);
						dcaOrderQtySum = await filterAmount(exchange, pair, dcaOrderQtySum);

						lastDcaOrderAmount = dcaOrderAmount;
						lastDcaOrderSize = dcaOrderSize;
						lastDcaOrderSum = dcaOrderSum;
						lastDcaOrderPrice = price;
						lastDcaOrderQtySum = dcaOrderQtySum;

						const average = await filterPrice(
							exchange,
							pair,
							parseFloat(lastDcaOrderSum) / parseFloat(lastDcaOrderQtySum)
						);

						let targetPrice = await calculateTargetPrice({

							'exchange': exchange,
							'pair': pair,
							'price': average,
							'takeProfit': config.dcaTakeProfitPercent,
							'exchangeFee': config.exchangeFee
						});

						orders.push({
							orderNo: i + 2,
							orderId: '',
							price: price,
							average: average,
							target: targetPrice,
							qty: dcaOrderSize,
							amount: dcaOrderAmount,
							qtySum: dcaOrderQtySum,
							sum: dcaOrderSum,
							type: 'MARKET',
							filled: 0,
							orderMetadata: adjustments
						});
					}
					else {

						const deviationPerc = await getDeviationDca(
							config.dcaOrderStepPercent,
							config.dcaOrderStepPercentMultiplier,
							i + 1
						);

						let price = Percentage.subPerc(askPrice, deviationPerc);

						price = await filterPrice(exchange, pair, price);

						let amount = lastDcaOrderAmount * config.dcaOrderSizeMultiplier;

						let dcaOrderSize = amount / price;

						// Get adjustments without exchange fee since already previously included
						const adjustments = await calculateAdjustments({

							'exchange': exchange,
							'pair': pair,
							'amount': amount,
							'orderSize': dcaOrderSize,
							'exchangeFee': 0,
							'minMoveAmount': null
						});

						// Call again to get fees
						const adjustmentsFees = await calculateAdjustments({

							'exchange': exchange,
							'pair': pair,
							'amount': amount,
							'orderSize': dcaOrderSize,
							'exchangeFee': config.exchangeFee,
							'minMoveAmount': minMoveAmount
						});

						// Set fees in original adjustments
						for (let key in adjustments) {

							if (adjustments[key] == undefined || adjustments[key] == null || adjustments[key] == 0) {

								adjustments[key] = adjustmentsFees[key];
							}
						}

						dcaOrderSize = adjustments['order_qty'];
						amount = adjustments['order_amount'];

						let dcaOrderSum = parseFloat(amount) + parseFloat(lastDcaOrderSum);
						dcaOrderSum = await filterPrice(exchange, pair, dcaOrderSum);

						let dcaOrderQtySum = parseFloat(dcaOrderSize) + parseFloat(lastDcaOrderQtySum);
						dcaOrderQtySum = await filterAmount(exchange, pair, dcaOrderQtySum);

						lastDcaOrderAmount = amount;
						lastDcaOrderSize = dcaOrderSize;
						lastDcaOrderSum = dcaOrderSum;
						lastDcaOrderPrice = price;
						lastDcaOrderQtySum = dcaOrderQtySum;

						const average = await filterPrice(
							exchange,
							pair,
							parseFloat(lastDcaOrderSum) / parseFloat(lastDcaOrderQtySum)
						);

						let targetPrice = await calculateTargetPrice({

							'exchange': exchange,
							'pair': pair,
							'price': average,
							'takeProfit': config.dcaTakeProfitPercent,
							'exchangeFee': config.exchangeFee
						});

						orders.push({
							orderNo: i + 2,
							orderId: '',
							price: price,
							average: average,
							target: targetPrice,
							qty: dcaOrderSize,
							amount: amount,
							qtySum: dcaOrderQtySum,
							sum: dcaOrderSum,
							type: 'MARKET',
							filled: 0,
							orderMetadata: adjustments
						});
					}
				}

				if (orders.length > 1) {

					let res = await ordersValid(pair, orders);

					if (!res['success']) {

						return ( { 'success': false, 'data': res['data'] } );
					}
				}

				let orderData = await ordersCreateTable({ 'config': config, 'orders': orders });

				let t = orderData['table'];
				let maxDeviation = orderData['max_deviation'];
				let ordersMetadata = orderData['metadata'];

				let balanceObj;
				let wallet = 0;

				if (config.sandBox) {

					wallet = config.sandBoxWallet;
				}
				else {

					balanceObj = await getBalance(exchange, pairQuote);

					const balance = balanceObj.balance;
					wallet = balance;
				}

				if (config.sandBox) {

					if (shareData.appData.verboseLog) { Common.logger( colors.bgYellow.bold('WARNING: Your bot will run in SANDBOX MODE!') ); }
				}
				else {

					if (shareData.appData.verboseLog) { Common.logger( colors.bgRed.bold('WARNING: Your bot will run in LIVE MODE!') ); }
				}

				if (shareData.appData.verboseLog) {
					
					Common.logger(colors.bgWhite('Your Balance: $' + wallet));
					Common.logger(colors.bgWhite('Max Funds: $' + lastDcaOrderSum));
				}

				if (wallet < lastDcaOrderSum) {

					if (shareData.appData.verboseLog) { Common.logger( colors.red.bold.italic(insufficientFundsMsg)); }
				}

				let sendOrders;

				if (startBot == undefined || startBot == null || startBot == false) {

					let contentAdd = await ordersAddContent(wallet, lastDcaOrderSum, maxDeviation, balanceObj);

					let ordersTable = await ordersToData(t.toString());

					return ({
								'success': true,
								'data': {
											'pair': pair,
											'orders': ordersTable,
											'metadata': ordersMetadata,
											'content': contentAdd,
										}
							});
				}

				if (startBot) {

					const dealObj = await createDeal(pair, pairMax, dealCount, dealMax, config, orders);

					const deal = dealObj['deal'];
					const dealId = dealObj['deal_id'];

					dealIdMain = dealId;

					await createDealTracker({ 'deal_id': dealId, 'deal': deal, 'start_id': startId });

					let followSuccess = false;
					let followFinished = false;
					let followConfig = config;

					while (!followFinished) {

						let followRes = await dcaFollow(followConfig, exchange, dealId);

						let followConfigRes = followRes['config'];

						// Refresh config without stopping bot
						if (followConfigRes != undefined && followConfigRes != null && followConfigRes != '') {
		
							followConfig = JSON.parse(JSON.stringify(followConfigRes));
						}

						followSuccess = followRes['success'];
						followFinished = followRes['finished'];

						if (!followSuccess) {

							await Common.delay(1000);
						}
					}

					if (followFinished) {

						//break;
					}
				}
				else {
/*
					if (Object.keys(dealTracker).length == 0) {

						Common.logger(colors.bgRed.bold(shareData.appData.name + ' is stopping... '));
						process.exit(0);
					}
*/
				}
			}
			else {

				// Limit order logic
			}
		}
	}
	catch (e) {

		Common.logger(e);
	}


	// Refresh bot config in case any settings changed

	try {

		const bot = await getBots({ 'botId': botIdMain });

		if (bot && bot.length > 0) {

			botFoundDb = true;

			botNameMain = bot[0]['botName'];

			let botPairsDb = bot[0]['config']['pair'];

			// Make sure pair was not removed from bot configuration
			for (let pairDb of botPairsDb) {

				if (pair.toUpperCase() == pairDb.toUpperCase()) {

					pairFoundDb = true;
				}
 			}
 
			if (!bot[0]['active']) {

				botActive = false;
			}
			else {

				botConfigDb = bot[0]['config'];

				dealMax = botConfigDb['dealMax'];
				pairMax = botConfigDb['pairMax'];
				pairDealsMax = botConfigDb['pairDealsMax'];
			}
		}
	}
	catch(e) {

	}


	// Deactivate bot if max deals reached
	if (dealCount >= dealMax && dealMax > 0) {

		const data = await updateBot(botIdMain, { 'active': false });
		
		if (shareData.appData.verboseLog) {
			
			Common.logger( colors.bgYellow.bold(config.botName + ': Max deal count reached. Bot will not start another deal.') );
		}

		const statusObj = await sendBotStatus({ 'bot_id': botIdMain, 'bot_name': botNameMain, 'active': false, 'success': data.success });
	}

	// Check if deal stop was requested
	try {

		if (dealTracker[dealIdMain]['update']['deal_stop']) {

			dealStop = true;
		}
	}
	catch(e) {

	}

	// Check for any resuming deals before continuing
	await processResumeDealTracker({ 'deal_id': dealIdMain });

	// Get total active same pairs currently running on bot
	let pairDealsActive = await getDeals({ 'botId': botIdMain, 'pair': pair, 'status': 0 });

	if (pairDealsMax > 1 && pairDealsActive.length >= pairDealsMax) {

		pairDealsLast = true;
	}

	// Get total active pairs currently running on bot
	let botDealsActive = await getDeals({ 'botId': botIdMain, 'status': 0 });

	let pairCount = botDealsActive.length;

	// Check if last deal flag is set
	let botDealCurrent = await getDeals({ 'botId': botIdMain, 'dealId': dealIdMain });

	if (botDealCurrent && botDealCurrent.length > 0) {

		for (let i = 0; i < botDealCurrent.length; i++) {

			let deal = botDealCurrent[i];

			let dealId = deal['dealId'];		
			let config = deal['config'];

			if (config['dealLast']) {

				dealLast = true;
			}
		}
	}


	// Start another bot deal if max deals and max pairs have not been reached
	if (!pairDealsLast && !dealStop && botFoundDb && botActive && !dealLast && (pairCount < pairMax || pairMax == 0)) {

		let configObj = JSON.parse(JSON.stringify(config));

		if (pairFoundDb && (dealCount < dealMax || dealMax == 0)) {

			botConfigDb['pair'] = pair; // Set single pair
			botConfigDb['dealCount'] = configObj['dealCount'];

			// Increment deal count
			botConfigDb['dealCount']++;

			// Apply config data again
			botConfigDb = await applyConfigData({ 'signal_id': configObj.signalId, 'bot_id': botIdMain, 'bot_name': botNameMain, 'config': botConfigDb });

			if (shareData.appData.verboseLog) {

				Common.logger(colors.bgGreen('Starting new bot deal for ' + pair.toUpperCase() + ' ' + botConfigDb['dealCount'] + ' / ' + botConfigDb['dealMax']));
			}

			if (botConfigDb['dealCoolDown'] == 0) {

				start({ 'create': true, 'config': botConfigDb });
			}
			else {

				if (shareData.appData.verboseLog) {

					Common.logger(colors.bgYellow.bold('Waiting ' + botConfigDb['dealCoolDown'] + ' seconds for ' + pair.toUpperCase() + ' cooldown before starting new deal.'));
				}

				startDelay({ 'config': botConfigDb, 'delay': botConfigDb['dealCoolDown'], 'notify': false });
			}
		}
		else {

			// Check for another pair to start if deal max reached above on current pair
			// Deal max will be reset so current pair could still begin again at some point

			startAsap(pair);
		}
	}

	// Ensure deal tracker is removed
	deleteDealTracker(dealIdMain);
}


const dcaFollow = async (configDataObj, exchange, dealId) => {

	let success = true;
	let finished = false;
	let isDealCancel = false;
	let isDealPanicSell = false;

	let { priceSlippageBuyPercent, priceSlippageSellPercent } = await getSlippage(true);

	if (shareData.appData.database_error != undefined && shareData.appData.database_error != null && shareData.appData.database_error != '') {

		Common.logger(colors.red.bold(shareData.appData.database_error + ' - Not processing'));

		return ( { 'success': false, 'finished': false } );
	}

	if (shareData.appData.sig_int) {

		Common.logger(colors.red.bold(shareData.appData.name + ' is terminating. Not processing deal ' + dealId));

		return ( { 'success': false, 'finished': false } );
	}

	if (dealTracker[dealId]['update'] != undefined && dealTracker[dealId]['update'] != null) {

		if (dealTracker[dealId]['update']['deal_cancel']) {

			isDealCancel = true;
		}
		
		if (dealTracker[dealId]['update']['deal_panic_sell']) {

			isDealPanicSell = true;
		}

		// Deal stop
		if (dealTracker[dealId]['update']['deal_stop']) {

			Common.logger(colors.red.bold('Deal ID ' + dealId + ' stop requested. Not processing'));
	
			return ( { 'success': false, 'finished': true } );
		}

		// Deal pause
		if (dealTracker[dealId]['update']['deal_pause']) {
	
			Common.logger(colors.red.bold('Deal ID ' + dealId + ' pause requested. Not processing'));
	
			return ( { 'success': false, 'finished': false } );
		}

		// Refresh config without restarting deal
		if (dealTracker[dealId]['update']['config']) {

			const configRefresh = JSON.parse(JSON.stringify(dealTracker[dealId]['update']['config']));

			delete dealTracker[dealId]['update']['config'];

			return ( { 'success': true, 'finished': false, 'config': configRefresh } );
		}

		// Deal sell error
		if (dealTracker[dealId]['update']['deal_sell_error']) {

			let diffSec = (new Date().getTime() - new Date(dealTracker[dealId]['update']['deal_sell_error']['date']).getTime()) / 1000;

			if (dealTracker[dealId]['update']['deal_sell_error']['count'] > maxSellErrorCount || diffSec > maxSellErrorResetSec) {

				delete dealTracker[dealId]['update']['deal_sell_error'];
			}
		}
	}

	const config = Object.freeze(JSON.parse(JSON.stringify(configDataObj)));

	try {

		const deal = await Deals.findOne({
			dealId: dealId,
			status: 0
		});

		if (deal) {

			const pair = deal.pair;
			const symbolData = await getSymbol(exchange, pair);
			const symbol = symbolData.data;

			// Error getting symbol data
			if (symbolData.error != undefined && symbolData.error != null) {

				success = false;

				if (Object.keys(dealTracker).length == 0) {

					//process.exit(0);
				}

				return ( { 'success': success, 'finished': finished } );
			}

			const bidPrice = symbol.bid;
			const askPrice = symbol.ask;

			const price = parseFloat(bidPrice);

			let targetPrice = 0;

			let orders = deal.orders;

			if (deal.isStart == 0) {

				let buyError;
				let buyOrderId = '';
				let buySuccess = true;

				const baseOrder = deal.orders[0];
				targetPrice = baseOrder.target;

				if (baseOrder.type == 'MARKET') {
					//Send market order to exchange

					if (!config.sandBox) {

						const priceFiltered = await filterPrice(exchange, pair, price);

						const buy = await buyOrder(exchange, dealId, pair, baseOrder.qty, priceFiltered);

						if (!buy.success) {

							buySuccess = false;
							buyError = buy.message;
						}
						else {

							buyOrderId = buy['data']['id'];
						}
					}

					if (buySuccess) {

						orders[0].filled = 1;
						orders[0].orderId = buyOrderId;
						orders[0].dateFilled = new Date();

						if (shareData.appData.verboseLog) {

							Common.logger(
								colors.green.bold.italic(
								'Pair: ' +
								pair +
								'\tQty: ' +
								baseOrder.qty +
								'\tPrice: ' +
								baseOrder.price +
								'\tAmount: ' +
								baseOrder.amount +
								'\tStatus: Filled'
								)
							);
						}

						await Deals.updateOne({
							dealId: dealId
						}, {
							isStart: 1,
							orders: orders
						});
					}

					await updateDealTracker({ 'deal_id': dealId, 'price': price, 'config': config, 'orders': orders, 'error': buyError });

					if (!buySuccess) {

						// Initial buy failed
						let finished = false;

						const statusObj = await orderError({ 'bot_id': config.botId, 'bot_name': config.botName, 'deal_id': dealId });

						if (statusObj['success']) {

							await deleteDeal(dealId);

							finished = true;
						}

						return ( { 'success': false, 'finished': finished } );
					}
				}
				else {

					// Limit order logic
				}
			}
			else {

				const filledOrders = deal.orders.filter(item => item.filled == 1);
				const currentOrder = filledOrders.pop();

				const profitData = await calculateProfit(price, config.sandBox, currentOrder.average, currentOrder.sum, config.dcaTakeProfitPercent, config.exchangeFee);
				
				let profit = profitData['profit_percentage'];

				let profitPerc = profit;

				profit =
					profit > 0 ?
					colors.green.bold(profit + '%') :
					colors.red.bold(profit + '%');

				let count = 0;
				let buyError;
				let buySuccess = true;
				let isBuy = false;
				let maxSafetyOrdersUsed = false;
				let ordersFilledTotal = filledOrders.length;

				if (ordersFilledTotal >= (orders.length - 1)) {

					maxSafetyOrdersUsed = true;
				}

				for (let i = 0; i < orders.length; i++) {

					let buyOrderId = '';

					const order = orders[i];

					// Check if max safety orders used, otherwise sell order condition will not be checked
					if (order.filled == 0 || maxSafetyOrdersUsed) {

						if (config.sandBox) {

							//priceSlippageBuyPercent = 0;
							//priceSlippageSellPercent = 0;
						}

						const priceBuyOrder = parseFloat(Number(order.price) - (Number(order.price) * priceSlippageBuyPercent));
						const priceSellOrder = parseFloat(Number(currentOrder.target) + (Number(currentOrder.target) * priceSlippageSellPercent));

						if ((price <= priceBuyOrder && order.filled == 0) && !isDealCancel && !isDealPanicSell) {
							//Buy DCA

							isBuy = true;

							if (!config.sandBox) {

								const priceFiltered = await filterPrice(exchange, pair, price);

								const buy = await buyOrder(exchange, dealId, pair, order.qty, priceFiltered);

								if (!buy.success) {

									buySuccess = false;
									buyError = buy.message;
								}
								else {

									buyOrderId = buy['data']['id'];
								}
							}

							if (buySuccess) {

								orders[i].filled = 1;
								orders[i].orderId = buyOrderId;
								orders[i].dateFilled = new Date();

								if (shareData.appData.verboseLog) {
		
									Common.logger(
										colors.blue.bold.italic(
										'Pair: ' +
										pair +
										'\tQty: ' +
										currentOrder.qtySum +
										'\tLast Price: $' +
										price +
										'\tDCA Price: $' +
										currentOrder.average +
										'\tSell Price: $' +
										currentOrder.target +
										'\tStatus: ' +
										colors.green('BUY') +
										'' +
										'\tProfit: ' +
										profit +
										''
										)
									);
								}

								await Deals.updateOne({
									dealId: dealId
								}, {
									orders: orders
								});
							}
							
							await updateDealTracker({ 'deal_id': dealId, 'price': price, 'config': config, 'orders': orders, 'error': buyError });

							if (!buySuccess) {

								// DCA buy failed
								return ( { 'success': false, 'finished': false } );
							}
						}
						else if (price >= priceSellOrder || isDealCancel || isDealPanicSell) {

							//Sell order

							if (deal.isStart == 1) {

								let sellOrderId = '';
								let isNSF = false;
								let sellSuccess = true;

								const sellDataObj = await processSellData(pair, price, dealId, exchange, config, currentOrder, filledOrders);

								const feeData = sellDataObj['fee_data'];

								const qtySumSell = feeData['dcaOrderQtySumNet'];
								const priceFiltered = feeData['priceFiltered'];
								const exchangeFeePercent = feeData['exchangeFeePercent'];

								// Calculate profit based on new exchange fee percent
								//const profitData = await calculateProfit(price, config.sandBox, currentOrder.average, currentOrder.sum, config.dcaTakeProfitPercent, exchangeFeePercent);
								//const profitPercFinal = profitData['profit_percentage'];
								const profitPercFinal = Number(Number(profitPerc - feeData['exchangeFeeSumDiffPercent']).toFixed(2));

								if (!config.sandBox && !isDealCancel) {

									const sell = await sellOrder(exchange, dealId, pair, qtySumSell, priceFiltered);

									isNSF = sell.nsf;

									if (!sell.success) {

										sellSuccess = false;
									}
									else {

										sellOrderId = sell['data']['id'];
									}
								}

								if (sellSuccess) {

									await updateDealTracker({ 'deal_id': dealId, 'price': price, 'config': config, 'orders': orders });

									if (shareData.appData.verboseLog) {

										Common.logger(
											colors.blue.bold.italic(
											'Pair: ' +
											pair +
											'\tQty: ' +
											currentOrder.qtySum +
											'\tLast Price: $' +
											price +
											'\tDCA Price: $' +
											currentOrder.average +
											'\tSell Price: $' +
											currentOrder.target +
											'\tStatus: ' +
											colors.red('SELL') +
											'' +
											'\tProfit: ' +
											profit +
											''
											)
										);
									}

									const sellData = {
														'date': new Date(),
														'orderId': sellOrderId,
														'qtySum': currentOrder.qtySum,
														'qtySumSell': qtySumSell,
														'price': price,
														'average': currentOrder.average,
														'target': currentOrder.target,
														'profit': profitPercFinal,
														'feeData': feeData
													 };

									await Deals.updateOne({
										dealId: dealId
									}, {
										'sellData': sellData,
										'panicSell': isDealPanicSell,
										'canceled': isDealCancel,
										'status': 1
									});

									finished = true;

									await deleteDealTracker(dealId);

									if (shareData.appData.verboseLog) { Common.logger(colors.bgRed('Deal ID ' + dealId + ' DCA Bot Finished.')); }

									sendNotificationFinish(config.botName, dealId, pair, sellData);
								}
								else {

									// Sell failed
									dealTracker[dealId]['update']['deal_sell_error']['nsf'] = isNSF;
									dealTracker[dealId]['update']['deal_sell_error']['count']++;
									dealTracker[dealId]['update']['deal_sell_error']['date'] = new Date();

									await Common.delay(1000);
								}

								success = true;

								return ( { 'success': success, 'finished': finished } );
							}
						}
						else {

							await updateDealTracker({ 'deal_id': dealId, 'price': price, 'config': config, 'orders': orders });

							if (shareData.appData.verboseLog) {
							
								Common.logger(
								'Pair: ' +
								pair +
								'\tLast Price: $' +
								price +
								'\tDCA Price: $' +
								currentOrder.average +
								'\t\tTarget: $' +
								currentOrder.target +
								'\t\tNext Order: $' +
								order.price +
								'\tProfit: ' +
								profit +
								''
								);
							}
						}

						count++;

						break;
					}
				}

				if (maxSafetyOrdersUsed && isBuy) {

					if (shareData.appData.verboseLog) { Common.logger( colors.bgYellow.bold(pair + ' Max safety orders used.') + '\tLast Price: $' + price + '\tTarget: $' + currentOrder.target + '\tProfit: ' + profit); }
					
					//await Common.delay(2000);
				}

			}

			// Delay before following again
			await Common.delay(2000);

			return ( { 'success': success, 'finished': finished } );
		}
		else {

			if (!followFinished) {

				if (shareData.appData.verboseLog) { Common.logger('No deal ID found for ' + config.pair); }
			}
		}
	}
	catch (e) {

		success = false;

		Common.logger(JSON.stringify(e));
	}

	return ( { 'success': success, 'finished': finished } );
};


const getSymbolsAll = async (exchange) => {

	let errMsg;

	let symbols = [];
	let success = true;

	try {

		const markets = await exchange.loadMarkets();
		symbols = exchange.symbols;
	}
	catch(e) {

		success = false;

		let symbolError = e;
		let msg = '';

		if (symbolError.message != undefined && symbolError.message != null) {

			msg = ' ' + symbolError.message;
		}

		symbolError = JSON.stringify(symbolError) + msg;

		errMsg = 'Unable to get symbols: ' + symbolError;

		Common.logger(colors.bgRed.bold.italic(errMsg));
	}

	return ( { 'date': new Date(), 'success': success, 'symbols': symbols, 'msg': errMsg } );
}


const getSymbol = async (exchange, pair) => {

	const maxTries = 5;

	let symbolData;
	let symbolError;

	let success = false;
	let finished = false;
	let symbolInvalid = false;

	let count = 0;

	while (!finished) {

		// Clear error
		symbolError = undefined;

		try {

			const symbol = await exchange.fetchTicker(pair);
			symbolData = symbol;

			finished = true;
		}
		catch (e) {

			symbolError = e;

			if (typeof symbolError != 'string') {

				let msg = '';

				if (symbolError.message != undefined && symbolError.message != null) {

					msg = ' ' + symbolError.message;
				}

				symbolError = JSON.stringify(symbolError) + msg;
			}

			symbolError = 'Get symbol ' + pair + ' error: ' + symbolError;

			Common.logger(colors.bgRed.bold.italic(symbolError));

			if (e instanceof ccxt.RateLimitExceeded && count < maxTries) {

				// Delay and try again
				await Common.delay(1000 + (Math.random() * 100));
			}
			else if (e instanceof ccxt.BadSymbol) {

				symbolInvalid = true;

				finished = true;
			}
			else if (e instanceof ccxt.InsufficientFunds) {

				finished = true;
			}
			else if (e instanceof ccxt.NetworkError) {

				finished = true;
			}
			else if (e instanceof ccxt.ExchangeNotAvailable) {

				finished = true;
			}
			else if (e instanceof ccxt.ExchangeError && count < maxTries) {

				// Delay and try again
				await Common.delay(1000 + (Math.random() * 100));
			}
			else {

				finished = true;
			}

			count++;
		}
	}

	if (symbolError == undefined || symbolError == null || symbolError == '') {

		success = true;
	}

	return ( { 'date': new Date(), 'success': success, 'data': symbolData, 'invalid': symbolInvalid, 'error': symbolError } );
};


const filterMinMovement = async (amount, minMoveAmount) => {

	let incrementValue = 0.05;

	let amountFinal = 0;

	// No minimum detected
	if (minMoveAmount == undefined || minMoveAmount == null) {

		return amount;
	}

	// Set slightly higher than zero for precision
	if (minMoveAmount == 0) {

		incrementValue = 0;

		//minMoveAmount = 0.00001;
		minMoveAmount = 0.000001;
	}

	amountFinal = Math.round(amount / minMoveAmount) * minMoveAmount;

	// Double increment value when whole numbers are required for movement
	if (minMoveAmount == 1) {

		//incrementValue = minMoveAmount;
	}

	if (amountFinal < 1 && amountFinal > 0) {

		let amountString = amountFinal.toString();
        let decimalPrecision = amountString.split('.')[1].length;

        let multipliedAmount = amountFinal * Math.pow(10, decimalPrecision);

        multipliedAmount += incrementValue;

        let result = multipliedAmount / Math.pow(10, decimalPrecision);

        amountFinal = result.toFixed(decimalPrecision);
    }
	else {

        amountFinal = (amountFinal + incrementValue).toString();
    }

	return Number(amountFinal);
};


const filterAmount = async (exchange, pair, amount) => {

	try {

		return exchange.amountToPrecision(pair, amount);
	}
	catch (e) {

		// Prevent log spam when minimum precision error occur
		if (!e instanceof ccxt.InvalidOrder) {

			let errMsg = 'FILTER AMOUNT ERROR: ' + e.name + ' ' + e.message;

			if (typeof errMsg != 'string') {

				errMsg = JSON.stringify(errMsg);
			}

			Common.logger(errMsg);
		}

		return false;
	}
};


const filterPrice = async (exchange, pair, price) => {

	try {

		return exchange.priceToPrecision(pair, price);
	}
	catch (e) {

		// Prevent log spam when minimum precision error occur
		if (!e instanceof ccxt.InvalidOrder) {

			let errMsg = 'FILTER PRICE ERROR: ' + e.name + ' ' + e.message;

			if (typeof errMsg != 'string') {

				errMsg = JSON.stringify(errMsg);
			}

			Common.logger(errMsg);
		}

		return false;
	}
};


const checkActiveDeal = async (botId, pair) => {

	try {

		const deal = await Deals.findOne({
			botId: botId,
			pair: pair,
			status: 0
		});

		return deal;
	}
	catch (e) {

		Common.logger(JSON.stringify(e));
	}
};


const getDeals = async (query, options, projection) => {

	if (query == undefined || query == null) {

		query = {};
	}

	if (options == undefined || options == null) {

		options = {};
	}

	if (projection == undefined || projection == null) {

		projection = {};
	}

	try {

		const deals = await Deals.find(query, projection, options);

		return deals;
	}
	catch (e) {

		Common.logger(JSON.stringify(e));
	}
};


const getBots = async (query) => {

	if (query == undefined || query == null) {

		query = {};
	}


	try {

		const bots = await Bots.find(query);

		return bots;
	}
	catch (e) {

		Common.logger(JSON.stringify(e));
	}
};


const getBalance = async (exchange, symbol) => {

	let limit = 100;

	let success = true;
	let balance;
	let errMsg;

	try {

		let allBalances = {};
		let starting_after = null;
		let starting_after_last = null;

		while (true) {

			let options = {};

			//options['limit'] = limit;

			if (starting_after != undefined && starting_after != undefined && starting_after != '') {

				options['starting_after'] = starting_after;
			}

			const partialResponse = await exchange.fetchBalance(options);

			const partialBalances = partialResponse.free;

			Object.keys(partialBalances).forEach((key) => {

				if (!allBalances[key]) {

					allBalances[key] = parseFloat(partialBalances[key]);
				}
				else {

					allBalances[key] += parseFloat(partialBalances[key]);
				}
			});

			if (partialResponse.info && partialResponse.info.pagination?.next_starting_after) {

				starting_after = partialResponse.info.pagination.next_starting_after;

				// Same value found so break
				if (starting_after == starting_after_last) {

					break;
				}
				else {

					starting_after_last = starting_after;
				}

				await Common.delay(500);
			}
			else {

				break;
			}
		}

		for (let key in allBalances) {

			if (allBalances[key] === null || allBalances[key] === 0) {

				delete allBalances[key];
			}
		}

		if (symbol != undefined && symbol != null && symbol != '') {

			balance = allBalances[symbol] || 0;
		}
		else {

			balance = allBalances;
		}

	} catch (e) {

		success = false;

		errMsg = 'BALANCE ERROR: ' + e.name + ' ' + e.message;

		Common.logger(errMsg);
	}

	return { 'success': success, 'balance': balance, 'error': errMsg };
};


const getOrder = async (exchange, orderId, pair, dealId) => {

	const maxTries = 15;

	let success = true;
	let finished = false;
	let orderInvalid = false;
	let timeOut = false;
	let count = 0;

	let order;
	let errMsg;
	let orderStatus;

	// Only try if exchange supports fetchOrder
	if (exchange != undefined && exchange != null && exchange.has['fetchOrder']) {

		while (!finished) {

			try {

				order = await exchange.fetchOrder(orderId, pair);

				errMsg = null;
				success = true;
				finished = true;
			}
			catch(e) {

				success = false;

				errMsg = 'GET ORDER ERROR: ' + e.name + ' ' + e.message;
	
				if (typeof errMsg != 'string') {
	
					errMsg = JSON.stringify(errMsg);
				}

				if (e instanceof ccxt.NetworkError && count < maxTries) {

					// Delay and try again
					await Common.delay(500 + (Math.random() * 100));
				}
				else if (e instanceof ccxt.ExchangeNotAvailable && count < maxTries) {

					// Delay and try again
					await Common.delay(500 + (Math.random() * 100));
				}
				else if (e instanceof ccxt.ExchangeError && count < maxTries) {

					// Order invalid or not found
					if (e.message.toLowerCase().includes('invalid') || e.message.toLowerCase().includes('found')) {

						orderInvalid = true;
						finished = true;
					}
					else {

						// Delay and try again
						await Common.delay(500 + (Math.random() * 100));
					}
				}
				else {

					timeOut = true;
					finished = true;
				}

				count++;
			}
		}
	}
	else {

		// Mimic closed order response since fetchOrder is not supported
		order = {};
		order['status'] = 'closed'; 
		order['_message'] = 'fetchOrder not supported by exchange';
	}

	if (order != undefined && order != null && typeof order == 'object') {

		orderStatus = order.status;
		orderStatus = orderStatus?.toLowerCase();
	}

	let msg = 'Get Order Complete. Order ID: ' + orderId + ' / Pair: ' + pair + ' / Deal ID: ' + dealId + ' / Success: ' + success;

	const dataObj = { 
						'success': success,
						'message': msg,
						'data': order,
						'status': orderStatus,
						'error': errMsg,
						'timeout': timeOut,
						'invalid': orderInvalid
					};

	if (shareData.appData.verboseLog) {
		
		Common.logger(dataObj);
	}

	return dataObj;
}


const cancelOrder = async (exchange, orderId, pair, dealId) => {

	let success = true;

	let order;
	let errMsg;

	if (exchange != undefined && exchange != null) {

		try {

			order = await exchange.cancelOrder(orderId, pair);

			errMsg = null;
			success = true;
		}
		catch(e) {

			success = false;

			errMsg = 'CANCEL ORDER ERROR: ' + e.name + ' ' + e.message;

			errMsg += ' / Order ID: ' + orderId + ' / Pair: ' + pair + ' / Deal ID: ' + dealId;

			if (typeof errMsg != 'string') {
	
				errMsg = JSON.stringify(errMsg);
			}
		}
	}

	let msg = 'Cancel Order Complete. Order ID: ' + orderId + ' / Pair: ' + pair + ' / Deal ID: ' + dealId + ' / Success: ' + success;

	const dataObj = { 
						'success': success,
						'message': msg,
						'data': order,
						'error': errMsg
					};

	if (shareData.appData.verboseLog) {
		
		Common.logger(dataObj);
	}

	return dataObj;
}


const verifyOrder = async (exchange, orderId, pair, dealId) => {

	const maxSec = 75;
	const maxTries = 5;

	let success = true;
	let finished = false;
	let timeOutOrder = false;
	let timeOutVerify = false;
	let orderInvalid = false;

	let count = 0;
	let orderCount = 0;
	let cancelCount = 0;
	let invalidCount = 0;

	let order;
	let msg;
	let errMsg;
	let dateCancel;
	let orderStatus;

	msg = 'Verifying Order ID: ' + orderId + ' / Pair: ' + pair + ' / Deal ID: ' + dealId;

	Common.logger(msg);

	//const botConfig = await Common.getConfig('bot.json');

	//let configBot = botConfig.data;
	//let config = await initConfigData(configBot);
	//let exchange = await connectExchange(config);

	while (!finished) {

		orderCount++;

		const orderData = await getOrder(exchange, orderId, pair, dealId);

		// Set date for cancel order timeout
		if (dateCancel == undefined || dateCancel == null || dateCancel == '') {

			dateCancel = new Date();
		}

		order = orderData.data;

		timeOutOrder = orderData.timeout;
		orderInvalid = orderData.invalid;

		if (!orderData.success) {

			// Some error occurred getting order
			errMsg = orderData.error;

			if (orderInvalid) {

				invalidCount++;

				// Reduce count to allow more time for other error retries
				count--;

				if (invalidCount > maxTries) {

					success = false;
					finished = true;
				}
				else {

					// Exchange may not be responding correctly, so delay and try again
					await Common.delay(1000 + (Math.random() * 100));
				}
			}
			else if (count < maxTries) {

				// Delay and try again
				await Common.delay(1000 + (Math.random() * 100));
			}
			else {

				success = false;
				timeOutVerify = true;

				finished = true;
			}

			count++;
		}
		else {

			errMsg = null;

			orderStatus = order.status;
			orderStatus = orderStatus?.toLowerCase();

			if (orderStatus == undefined || orderStatus == null || orderStatus == '') {

				// Consider successful if field is missing or undefined
				finished = true;
			}
			else if (orderStatus === 'open' || orderStatus === 'pending' || orderStatus.includes('partial')) {

				let diffSec = (new Date().getTime() - new Date(dateCancel).getTime()) / 1000;

				// Open order exceeds n seconds. Try canceling.
				if (diffSec > maxSec) {

					// Reset date
					dateCancel = null;

					cancelCount++;

					let msg = 'Open order exceeds ' + maxSec + ' seconds. Canceling Order ID: ' + orderId + ' / Pair: ' + pair + ' / Deal ID: ' + dealId + ' / Attempt: ' + cancelCount;

					Common.logger(msg);

					let cancelOrderData = await cancelOrder(exchange, orderId, pair, dealId);

					// Cancel failed
					if (!cancelOrderData.success) {

					}

					// Delay and let loop again to check if canceled to finish
					await Common.delay(1000);
				}
				else {

					// Order still open, so try again after brief delay
					await Common.delay(500);
				}
			}
			else if (orderStatus === 'closed' || orderStatus === 'ok' || orderStatus === 'filled') {

				// Successfully filled
				finished = true;
			}
			else {

				// Some other error occurred
				if (orderStatus.includes('cancel')) {

				}

				success = false;
				finished = true;
			}
		}
	}

	msg = 'Verify Order Complete. Order ID: ' + orderId + ' / Pair: ' + pair + ' / Deal ID: ' + dealId + ' / Success: ' + success;

	const dataObj = { 
						'success': success,
						'message': msg,
						'data': order,
						'status': orderStatus,
						'attempts': orderCount,
						'invalid': orderInvalid,
						'timeout_order': timeOutOrder,
						'timeout_verify': timeOutVerify,
						'error': errMsg
					}; 

	Common.logger(dataObj);

	return dataObj;
}


const buyOrder = async (exchange, dealId, pair, qty, price) => {

	const maxTries = 5;

	let msg;
	let order;
	let isErr;
	let success;

	let nsf = false;
	let finished = false;
	let finishedVerify = false;
	let successVerify = false;

	let count = 0;

	while (!finished) {
	
		try {

			isErr = null;
			success = true;

			msg = 'BUY SUCCESS';

			order = await exchange.createOrder(pair, 'market', 'buy', qty, price);

			finished = true;
		}
		catch (e) {

			isErr = e;
			success = false;

			msg = 'BUY ERROR: ' + e.name + ' ' + e.message;

			if (e instanceof ccxt.InsufficientFunds) {

				nsf = true;

				finished = true;
			}
			else if ((e instanceof ccxt.ExchangeError || e instanceof ccxt.BadRequest) && msg.toLowerCase().includes('insufficient')) {

				nsf = true;

				finished = true;
			}
			else if (e instanceof ccxt.ExchangeError && count < maxTries) {

				// Delay and try again
				await Common.delay(500 + (Math.random() * 100));
			}
			else {

				finished = true;
			}

			count++;
		}
	}

	if (success) {

		// Verify order on exchange
		const orderId = order['id'];

		if (orderId != undefined && orderId != null && orderId != '') {

			while (!finishedVerify) {

				let orderVerify = await verifyOrder(exchange, orderId, pair, dealId);

				if (orderVerify.success) {

					// Verification successful
					successVerify = true;
					finishedVerify = true;
				}
				else {

					// Verification failed, consider buy order unsuccessful

					if (orderVerify['timeout_order'] || orderVerify['timeout_verify']) {

						// Handle cases of timeouts
						// Circuit breaker

						// Timeout occurred so delay and try again
						await Common.delay(1000);
					}
					else {

						success = false;
						successVerify = false;
						finishedVerify = true;
					}
				}
			}
		}
		else {

			successVerify = false;

			let msg = 'Unable to verify order. No order ID received from exchange. Deal ID: ' + dealId;

			Common.logger(msg);
		}
	}

	const dataObj = {
						'date': new Date(),
						'success': success,
						'success_verify': successVerify,
						'data': order,
						'error': isErr,
						'verified': finishedVerify,
						'nsf': nsf,
						'message': msg,
						'deal_id': dealId,
						'pair': pair,
						'quantity': qty,
						'price': price
					};

	Common.logger(dataObj);

	return dataObj;
};


const sellOrder = async (exchange, dealId, pair, qty, price) => {

	const maxTries = 5;

	let msg;
	let order;
	let isErr;
	let success;

	let finished = false;
	let nsf = false;

	let count = 0;

	while (!finished) {

		try {

			isErr = null;
			success = true;

			msg = 'SELL SUCCESS';

			order = await exchange.createOrder(pair, 'market', 'sell', qty, price);

			finished = true;
		}
		catch (e) {

			isErr = e;
			success = false;

			msg = 'SELL ERROR: ' + e.name + ' ' + e.message;

			if (e instanceof ccxt.InsufficientFunds) {

				nsf = true;

				finished = true;
			}
			else if ((e instanceof ccxt.ExchangeError || e instanceof ccxt.BadRequest) && msg.toLowerCase().includes('insufficient')) {

				nsf = true;

				finished = true;
			}
			else if (e instanceof ccxt.ExchangeError && count < maxTries) {

				// Delay and try again
				await Common.delay(500 + (Math.random() * 100));
			}
			else {

				finished = true;
			}

			count++;
		}
	}

	const dataObj = {
						'date': new Date(),
						'success': success,
						'data': order,
						'error': isErr,
						'nsf': nsf,
						'message': msg,
						'deal_id': dealId,
						'pair': pair,
						'quantity': qty,
						'price': price
					};

	Common.logger(dataObj);

	return dataObj;
};


const getDeviation = async (a, b) => {

	return (Math.abs( (a - b) / ( (a + b) / 2 ) ) * 100);
}


const getDeviationDca = async (dcaOrderStepPercent, dcaOrderStepPercentMultiplier, dcaMaxOrder) => {

	let maxDeviation;

	if (Number(dcaOrderStepPercentMultiplier) == 1) {

		maxDeviation = Number(dcaMaxOrder) * Number(dcaOrderStepPercent);
	}
	else {

		maxDeviation = Number(dcaOrderStepPercent) * (1 - Number(dcaOrderStepPercentMultiplier) ** Number(dcaMaxOrder)) / (1 - Number(dcaOrderStepPercentMultiplier));
	}

	return maxDeviation;
}


const getSlippage = async(normalize) => {

	let priceSlippageBuyPercent = 0;
	let priceSlippageSellPercent = 0;

	let divisor = 1;

	if (normalize) {

		divisor = 100;
	}

	if (shareData.appData.bots['exchange'] != undefined && shareData.appData.bots['exchange'] != null && typeof shareData.appData.bots['exchange'] == 'object') {

		const exchangeObj = shareData.appData.bots['exchange'];

		for (let exchangeName in exchangeObj) {

			if (exchangeName.toLowerCase() == 'default') {

				const exchangeSingleObj = exchangeObj[exchangeName];

				priceSlippageBuyPercent = Number(exchangeSingleObj['orders']['buy']['slippage_percent']) / divisor;
				priceSlippageSellPercent = Number(exchangeSingleObj['orders']['sell']['slippage_percent']) / divisor;
			}
		}
	}

	return { priceSlippageBuyPercent, priceSlippageSellPercent };
}


const calculateProfit = async (price, sandBox, orderAverage, orderSum, takeProfitPercent, exchangeFeePercent) => {

	let profitPerc = await Percentage.subNumsAsPerc(
		price,
		orderAverage
	);

	let { priceSlippageBuyPercent, priceSlippageSellPercent } = await getSlippage(false);

	if (sandBox) {

		//priceSlippageBuyPercent = 0;
		//priceSlippageSellPercent = 0;
	}

	profitPerc = profitPerc - Number(exchangeFeePercent) - (Number(priceSlippageSellPercent));
	profitPerc = Number(Number(profitPerc).toFixed(2));

	const takeProfit = shareData.Common.roundAmount(Number(Number(orderSum) * ((Number(takeProfitPercent) - Number(exchangeFeePercent) - priceSlippageSellPercent) / 100)));
	const currentProfit = shareData.Common.roundAmount(Number((Number(orderSum) * (Number(profitPerc) / 100))));

	const data = {
					'profit': currentProfit,
					'take_profit': takeProfit,
					'profit_percentage': profitPerc
				 };

	return data;
}


const calculateTargetPrice = async ({ exchange, pair, price, takeProfit, exchangeFee }) => {

	let targetPrice = Percentage.addPerc(
		price,
		(Number(takeProfit) + Number(exchangeFee))
	);

	targetPrice = await filterPrice(exchange, pair, targetPrice);

	return targetPrice;
}


const processSellData = async(pair, price, dealId, exchange, config, currentOrder, filledOrders) => {

	// Keep max n history keys
	const maxKeys = 10;
	const maxTries = 5;

	// Stop applying fees if additional percentage exceeds this amount
	const maxFee = sellErrorAddFeeMaxPerc;

	let addFee;
	let feeData;
	let isError;
	let sellErrorCount;
	let sellErrorCountDupes;
	let sellErrorHistory;

	let success = true;
	let finished = false;

	let count = 0;

	await createSellErrorTracker(dealId);

	while (!finished) {

		try {

			const dateNow = new Date();

			let sellErrorLastFee;
			let sellErrorLastQty;

			sellErrorCount = dealTracker[dealId]['update']['deal_sell_error']['count'];
			sellErrorCountDupes = dealTracker[dealId]['update']['deal_sell_error']['count_dupes'];
			sellErrorHistory = dealTracker[dealId]['update']['deal_sell_error']['history'];

			if (Object.keys(sellErrorHistory).length > 0) {

				const keyDates = Object.keys(sellErrorHistory).map(dateString => new Date(dateString));
				const keyLast = new Date(Math.max(...keyDates));

				sellErrorLastFee = sellErrorHistory[keyLast]['add_fee'];
				sellErrorLastQty = sellErrorHistory[keyLast]['qty'];
			}

			// Only apply additional fees if insufficient funds
			if (dealTracker[dealId]['update']['deal_sell_error']['nsf']) {

				addFee = (sellErrorAddFeeMultiplier * (sellErrorCount + sellErrorCountDupes));
			}
			else {

				addFee = 0;
			}

			if (addFee == undefined || addFee == null) {

				addFee = 0;
			}

			feeData = await calculateSellData(pair, price, exchange, config, addFee, currentOrder, filledOrders);

			const dcaOrderQtySumNet = feeData['dcaOrderQtySumNet'];
			const exchangeFeeQtySumDiffPercent = feeData['exchangeFeeQtySumDiffPercent'];

			// Finish only if quantity is not equal to previous result
			if (sellErrorLastQty != dcaOrderQtySumNet) {

				if (addFee > 0) {

					if (shareData.appData.verboseLog) {

						Common.logger('Applying additional exchange fee factor of ' + addFee + ' to reduce sell quantity for deal ' + dealId + '. Attempt: ' + sellErrorCount + '/' + maxSellErrorCount);
					}
				}

				sellErrorHistory[dateNow] = {
												'add_fee': addFee,
												'qty': dcaOrderQtySumNet,
												'dupes': sellErrorCountDupes
											};

				// Keep only last n results
				if (Object.keys(sellErrorHistory).length > maxKeys) {

					for (let key in sellErrorHistory) {

						delete sellErrorHistory[key];

						if (Object.keys(sellErrorHistory).length <= maxKeys) {

							break;
						}
					}
				}

				finished = true;
			}
			else if (exchangeFeeQtySumDiffPercent > maxFee) {

				// Max reached. Stop applying additional fees
				finished = true;
			}
			else if (count >= maxTries) {

				finished = true;
			}
			else {

				dealTracker[dealId]['update']['deal_sell_error']['count_dupes']++;

				// Delay very briefly and try again
				await Common.delay(100 + (Math.random() * 100));
			}
		}
		catch(e) {

			isError = e;

			success = false;
			finished = true;
		}

		count++;
	}

	const resObj = {
						'success': success,
						'count': count,
						'fee_data': feeData,
						'error': isError
				   };

	return resObj;
}


const calculateAdjustments = async ({ exchange, pair, amount, orderSize, exchangeFee, minMoveAmount }) => {

	let resObj;
	let finished = false;

	exchangeFee = Number(exchangeFee);
	exchangeFee = exchangeFee * 2;

	if (!amount || !orderSize) {

		return {};
	}

	while (!finished) {

		const exchangeFeeQty = (Number(orderSize) / 100) * (Number(exchangeFee));
		const exchangeFeeAmount = (Number(amount) / 100) * (Number(exchangeFee));

		const exchangeFeeQtyFiltered = await filterAmount(exchange, pair, Number(exchangeFeeQty));
		const exchangeFeeAmountFiltered = await filterPrice(exchange, pair, Number(exchangeFeeAmount));

		let orderSizeNew = await filterMinMovement((Number(orderSize) + Number(exchangeFeeQty)), minMoveAmount);
		let amountNew = await filterMinMovement((Number((amount)) + Number(exchangeFeeAmount)), minMoveAmount);

		orderSizeNew = await filterAmount(exchange, pair, orderSizeNew);

		// Filtering may reduce amounts and remove decimals for some pairs
		amountNew = await filterPrice(exchange, pair, amountNew);

		amountNew = Math.round(amountNew * 100) / 100;

		resObj = {
					'order_qty': orderSizeNew,
					'order_amount': amountNew,
					'order_qty_orig': orderSize,
					'order_amount_orig': amount,
					'exchange_fee_qty': Number(exchangeFeeQtyFiltered),
					'exchange_fee_amount': Number(exchangeFeeAmountFiltered),
					'minimum_movement_amount': minMoveAmount
				 };

		if (exchangeFee == 0 || exchangeFeeQtyFiltered > 0) {

			finished = true;
		}
		else {
		
			exchangeFee = exchangeFee + (exchangeFee * 0.25);
		}
	}

	return resObj;
}


const calculateSellData = async (pair, price, exchange, configObj, addFee, currentOrderObj, ordersFilledArr) => {

	const config = JSON.parse(JSON.stringify(configObj));
	const currentOrder = JSON.parse(JSON.stringify(currentOrderObj));
	const filledOrders = JSON.parse(JSON.stringify(ordersFilledArr));

	const dcaOrderSum = currentOrder.sum;
	const dcaOrderQtySum = currentOrder.qtySum;

	// Merge orders into array
	let allOrders = filledOrders;
	allOrders.push(currentOrder);

	let exchangeFeeQtySum = 0;
	let exchangeFeeAmountSum = 0;

	for (let i = 0; i < allOrders.length; i++) {

		const order = allOrders[i];

		let orderMetadata = order['orderMetadata'];

		if (orderMetadata == undefined || orderMetadata == null || orderMetadata == '') {

			orderMetadata = {};
		}

		const exchangeFeeQty = orderMetadata['exchange_fee_qty'];
		const exchangeFeeAmount = orderMetadata['exchange_fee_amount'];

		exchangeFeeQtySum += exchangeFeeQty;
		exchangeFeeAmountSum += exchangeFeeAmount;
	}

	const priceFiltered = await filterPrice(exchange, pair, price);

	if (addFee == undefined || addFee == null) {

		addFee = 0;
	}

	exchangeFeeQtySum = await filterAmount(exchange, pair, exchangeFeeQtySum);

	if (!exchangeFeeQtySum) {

		exchangeFeeQtySum = 0;
	}

	let exchangeFeeAmountSumFinal = exchangeFeeAmountSum / 2;
	let exchangeFeeQtySumFinal = exchangeFeeQtySum / 2;

	const exchangeFeeSubAmount = exchangeFeeAmountSumFinal * (Number(addFee));
	const exchangeFeeSubQty = exchangeFeeQtySumFinal * (Number(addFee));

	exchangeFeeAmountSumFinal += exchangeFeeSubAmount;
	exchangeFeeQtySumFinal += exchangeFeeSubQty;

	exchangeFeeQtySumFinal = await filterAmount(exchange, pair, exchangeFeeQtySumFinal);

	if (!exchangeFeeQtySumFinal) {

		exchangeFeeQtySumFinal = 0;
	}

	const exchangeFeePercent = Number(config.exchangeFee) + Number(addFee);

	const dcaOrderSumNet = await filterPrice(exchange, pair, (dcaOrderSum - exchangeFeeAmountSumFinal));
	const dcaOrderQtySumNet = await filterAmount(exchange, pair, (dcaOrderQtySum - exchangeFeeQtySumFinal));

	const exchangeFeeSumDiffPercent = Number((1 - (dcaOrderSumNet / dcaOrderSum)).toFixed(2));
	const exchangeFeeQtySumDiffPercent = Number((1 - (dcaOrderQtySumNet / dcaOrderQtySum)).toFixed(2));

	const resObj = {
						'dcaOrderSum': dcaOrderSum,
						'dcaOrderQtySum': dcaOrderQtySum,
						'dcaOrderSumNet': dcaOrderSumNet,
						'dcaOrderQtySumNet': dcaOrderQtySumNet,
						'exchangeFeeSum': exchangeFeeAmountSumFinal,
						'exchangeFeeQtySum': exchangeFeeQtySumFinal,
						'exchangeFeeSumDiffPercent': exchangeFeeSumDiffPercent,
						'exchangeFeeQtySumDiffPercent': exchangeFeeQtySumDiffPercent,
						'exchangeFeePercent': exchangeFeePercent,
						'priceFiltered': priceFiltered
				   };

	return resObj;
}


async function calculatePairData(arr) {

	let sum = 0;
	let count = 0;
	let wholeNumberCount = 0;
	let differenceSum = 0;

	let totalLength = arr.length;

	arr.forEach((num, index) => {

		const parts = num.split('.');

		if (parts.length === 2) {

			// If contains decimal, add to the sum and increment count
			sum += parseFloat(`0.${parts[1]}`);
			count++;

		} else {

			// Whole number found
			wholeNumberCount++;
		}

		// Calculate difference with the next number
		if (index < totalLength - 1) {

			const currentNum = parseFloat(num);
			const nextNum = parseFloat(arr[index + 1]);
			differenceSum += Math.abs(nextNum - currentNum);
		}
	});

	// Calculate average decimal
	const average = count > 0 ? sum / count : 0;

	// Calculate average difference
	const averageDifference = totalLength > 1 ? differenceSum / (totalLength - 1) : 1;

	// Calculate average whole number percentage
	const wholeNumberPercentage = (wholeNumberCount / totalLength) * 100;

	// Calculate addFeePercentage
	const addFeePercentage = average * (wholeNumberPercentage / 100);

	// Calculate minQty
	const minAmount = +(wholeNumberCount / totalLength);

	return {
		'average_decimal': Number(average.toFixed(2)),
		'total_count': totalLength,
		'whole_number_count': wholeNumberCount,
		'whole_number_percent': Number(wholeNumberPercentage.toFixed(2)),
		'add_fee_percent': Number(addFeePercentage.toFixed(4)),
		'minimum_movement_amount': Number(minAmount.toFixed(4))
	};
}


async function getPairPrecision(exchange, exchangeName, pair, isPairData) {

	let minMoveAmount;

	try {

		minMoveAmount = exchangeMarkets[exchangeName][pair]['precision']['amount'];

		// DECIMAL_PLACES = 2
		// SIGNIFICANT_DIGITS = 3
		// TICK_SIZE = 4

		// If not TICK_SIZE then convert amount
		if (exchange['precisionMode'] != 4) {

			if (minMoveAmount >= 0) {

				minMoveAmount = 1 / Math.pow(10, minMoveAmount);
			}
		}
	}
	catch(e) {

	}

	// No precision found, so calculate initial movement
	if (!isPairData && (minMoveAmount == undefined || minMoveAmount == null)) {

		const pairData = await getPairData(pair);
		minMoveAmount = pairData['pair_data']['minimum_movement_amount'];
	}

	return minMoveAmount;
}


async function getPairData(pair) {

	let pairData;
	let errMsg = '';
	let qtyArr = [];
	let success = true;

	if (pair == undefined || pair == null || pair == '') {

		return ({'success': false});
	}

	const botConfig = await shareData.Common.getConfig('bot.json');

	let config = botConfig.data;

	config.pair = pair;
	config.firstOrderAmount = 20;
	config.dcaOrderAmount = 20;
	config.dcaMaxOrder = 50;
	config.dcaOrderSizeMultiplier = 1.0;
	config.dcaOrderStepPercent = 1.0;
	config.dcaOrderStepPercentMultiplier = 1.0;
	config.dcaTakeProfitPercent = 1.0;

	// Set pairData flag to avoid recursion 
	config.pairData = true;

	if (shareData.appData.verboseLog) { Common.logger( colors.bgCyan.bold('Getting pair data for: ' + pair) ); }

	const orders = await start({ 'create': false, 'config': config });

	if (!orders.success) {

		success = false;
		errMsg = orders.data;
	}
	else {

		const orderData = JSON.parse(JSON.stringify(orders.data.orders));

		const orderDataSteps = orderData.steps;

		for (let i = 0; i < orderDataSteps.length; i++) {

			qtyArr.push(orderDataSteps[i][5])
		}

		pairData = await calculatePairData(qtyArr);
	}

	const resObj = {
						'success': success,
						'pair': pair,
						'pair_data': pairData,
						'error': errMsg
				   };

	return resObj;
}


async function loadExchangeMarkets(exchangeObj) {

	const maxTries = 5;

	let isErr;
	let success;
	let exchanges;

	if (exchangeObj == undefined || exchangeObj == null || exchangeObj == '') {

		exchanges = shareData.appData.exchanges;
	}
	else {

		// Only load markets for one exchange
		exchanges = exchangeObj;
	}

	for (let exchangeId in exchanges) {

		let count = 0;
		let finished = false;

		let exchange = exchanges[exchangeId];

		while (!finished) {

			try {

				success = true;

				const markets = await exchange.loadMarkets();

				await processExchangeMarkets(exchangeId, markets);

				finished = true;
			}
			catch(e) {

				isErr = null;

				if (count < maxTries) {
	
					// Delay and try again
					await Common.delay(1000 + (Math.random() * 100));
				}
				else {

					isErr = e;

					success = false;
					finished = true;
				}
			}

			count++;
		}
	}

	return { 'success': success, 'error': isErr };
}


async function processExchangeMarkets(exchangeId, markets) {

	let marketData = {};

	for (let pair in markets) {

		let pairUpper = pair.toUpperCase();

		let pairData = markets[pair];

		let precision = pairData['precision'];

		if (marketData[pairUpper] == undefined || marketData[pairUpper] == null || marketData[pairUpper] == '') {

			marketData[pairUpper] = {};
		}

		marketData[pairUpper]['precision'] = precision;
	}

	if (exchangeMarkets[exchangeId] == undefined || exchangeMarkets[exchangeId] == null || exchangeMarkets[exchangeId] == '') {

		exchangeMarkets[exchangeId] = {};
	}

	exchangeMarkets[exchangeId] = marketData;

	return marketData;
}


async function connectExchange(configObj) {

	const config = JSON.parse(JSON.stringify(configObj));

	let success;
	let exchange;
	let isErr;
	let isNew = false;
	let options = { 'defaultType': 'spot' };

	try {

		success = true;

		if (config.exchangeOptions != undefined && config.exchangeOptions != null && config.exchangeOptions != '') {

			options = config.exchangeOptions;
		}

		if (shareData.appData.exchanges[config.exchange] != undefined && shareData.appData.exchanges[config.exchange] != null) {

			exchange = shareData.appData.exchanges[config.exchange];
		}
		else {

			isNew = true;

			exchange = new ccxt.pro[config.exchange]({

				'timeout': (exchangeTimeoutSec * 1000),
				'enableRateLimit': true,
				'apiKey': config.apiKey,
				'secret': config.apiSecret,
				'passphrase': config.apiPassphrase,
				'password': config.apiPassword,
				'options': options
			});

			shareData.appData.exchanges[config.exchange] = exchange;
		}
	}
	catch(e) {

		isErr = e;
		success = false;
	}

	// Load markets if newly connected
	if (success && isNew) {

		let exchangeObj = {};
		exchangeObj[config.exchange] = exchange;

		let loadData = await loadExchangeMarkets(exchangeObj);

		success = loadData['success'];
		isErr = loadData['error'];
	}

	if (isErr != undefined && isErr != null && isErr != '') {

		success = false;

		let msg = 'Connect exchange error: ' + isErr;

		Common.logger(msg);

		Common.sendNotification({ 'message': msg, 'type': 'error', 'telegram_id': shareData.appData.telegram_id });

		delete shareData.appData.exchanges[config.exchange];
	}

	return exchange;
}


async function orderError(data) {

	let active = false;
	let success = true;

	let botId = data['bot_id'];
	let botName = data['bot_name'];
	let dealId = data['deal_id'];

	const dataBot = await updateBot(botId, { 'active': active });

	if (!dataBot.success) {

		// An error occurred updating bot so treat as unsuccessful
		success = false;
	}

	if (success) {

		let msg = 'An error occurred starting deal ID ' + dealId + '. Disabling bot. Check the logs for details.';

		await Common.sendNotification({ 'message': msg, 'type': 'deal_error', 'telegram_id': shareData.appData.telegram_id });
		const statusObj = await sendBotStatus({ 'bot_id': botId, 'bot_name': botName, 'active': active, 'success': success });
	}

	return ( { 'success': success } );
}


async function sendBotStatus(data) {

	let status;

	let botId = data['bot_id'];
	let botName = data['bot_name'];
	let active = data['active'];
	let success = data['success'];

	if (active) {

		status = 'enabled';
	}
	else {
	
		status = 'disabled';
	}

	Common.logger('Bot Status Changed: ID: ' + botId + ' / Status: ' + status + ' / Success: ' + success);

	if (success) {

		let msg = botName + ' is now ' + status;

		Common.sendNotification({ 'message': msg, 'type': 'bot_' + status.toLowerCase(), 'telegram_id': shareData.appData.telegram_id });
	}

	return ( { 'status': status } );
}


async function updateBot(botId, data) {

	let botData;
	let success = true;

	try {

		botData = await Bots.updateOne({
						botId: botId
					}, data);
	}
	catch (e) {

		success = false;

		Common.logger(JSON.stringify(e));
	}


	if (botData == undefined || botData == null || botData['matchedCount'] < 1) {

		success = false;
	}

	return( { 'success': success } );
}


async function updateDeal(botId, dealId, data) {

	let dealData;
	let success = true;

	try {

		dealData = await Deals.updateOne({
						botId: botId,
						dealId: dealId
					}, data);
	}
	catch (e) {

		success = false;

		Common.logger(JSON.stringify(e));
	}


	if (dealData == undefined || dealData == null || dealData['matchedCount'] < 1) {

		success = false;
	}

	return( { 'success': success } );
}


async function deleteDeal(dealId) {

	let dealData;
	let success = true;

	try {

		dealData = await Deals.deleteOne({
						dealId: dealId
					});
	}
	catch (e) {

		success = false;

		Common.logger(JSON.stringify(e));
	}

	if (dealData == undefined || dealData == null || dealData['deletedCount'] < 1) {

		success = false;
	}

	return( { 'success': success } );
}


async function updateOrders(data) {

	let orderData = JSON.parse(JSON.stringify(data));

	let ordersOrig = orderData['orig'];
	let orderSteps = orderData['new'];
	let orderMetadata = orderData['metadata'];

	let ordersNew = [];

	for (let i = 0; i < orderSteps.length; i++) {

		let orderNew;

		let priceTargetNew = orderSteps[i][4].replace(/[^0-9.]/g, '');

		// Use existing order data if available
		if (ordersOrig[i] != undefined && ordersOrig[i] != null) {

			let priceTargetOrig = ordersOrig[i]['target'];

			orderNew = ordersOrig[i];

			orderNew['target'] = priceTargetNew;
		}
		else {

			let orderObj = {
								orderNo: orderSteps[i][0],
								orderId: '',
								price: orderSteps[i][2].replace(/[^0-9.]/g, ''),
								average: orderSteps[i][3].replace(/[^0-9.]/g, ''),
								target: priceTargetNew,
								qty: orderSteps[i][5].replace(/[^0-9.]/g, ''),
								amount: orderSteps[i][6].replace(/[^0-9.]/g, ''),
								qtySum: orderSteps[i][7].replace(/[^0-9.]/g, ''),
								sum: orderSteps[i][8].replace(/[^0-9.]/g, ''),
								type: orderSteps[i][9],
								filled: 0,
								orderMetadata: orderMetadata[i]
							};

			orderNew = orderObj;
		}

		ordersNew.push(orderNew);
	}

	return ordersNew;
}


async function checkTrackers() {

	// Monitor existing deals if they weren't updated after n minutes to take potential action

	for (let dealId in dealTracker) {

		let deal = dealTracker[dealId]['info'];

		let diffSec = (new Date().getTime() - new Date(deal['updated']).getTime()) / 1000;

		if (diffSec > (60 * maxMinsDeals)) {

			diffSec = (diffSec / 60).toFixed(2);

			let msg = 'WARNING: ' + dealId + ' exceeds last updated time by ' + diffSec + ' minutes. Check the logs for details.';

			Common.logger(msg);

			Common.sendNotification({ 'message': msg, 'type': 'warning', 'telegram_id': shareData.appData.telegram_id });
		}
	}


	// Remove delayed volume timers
	for (let key in timerTracker) {

		let timerObj = timerTracker[key];

		let diffSec = (new Date().getTime() - new Date(timerObj['started']).getTime()) / 1000;

		if (diffSec > (60 * (maxMinsVolume + 1.5))) {

			clearTimeout(timerObj['id']);

			timerTracker[key] = null;
			delete timerTracker[key];
		}
	}
}


async function checkStartDealTracker() {

	// Remove start deal trackers that exceed n seconds

	for (let id in startDealTracker) {

		let diffSec = (new Date().getTime() - new Date(startDealTracker[id]['date']).getTime()) / 1000;

		if (diffSec > 15) {

			deleteStartDealTracker(id);
		}
	}
}


async function checkResumeDealTracker() {

	// Remove resume deal trackers that exceed n seconds

	const maxMins = 15;

	for (let dealId in resumeDealTracker) {

		let diffSec = (new Date().getTime() - new Date(resumeDealTracker[dealId]['date']).getTime()) / 1000;

		if (diffSec > (60 * maxMins)) {

			deleteResumeDealTracker(dealId);

			let msg = 'WARNING: Resume deal tracker exceeds ' + maxMins + ' minutes and has been automatically removed for deal id: ' + dealId;

			Common.logger( colors.bgCyan.bold(msg) );

			Common.sendNotification({ 'message': msg, 'type': 'warning', 'telegram_id': shareData.appData.telegram_id });
		}
	}
}


async function createSellErrorTracker(dealId) {

	try {

		if (dealTracker[dealId]['update']['deal_sell_error'] == undefined || dealTracker[dealId]['update']['deal_sell_error'] == null) {

			dealTracker[dealId]['update']['deal_sell_error'] = {};
			dealTracker[dealId]['update']['deal_sell_error']['history'] = {};
			dealTracker[dealId]['update']['deal_sell_error']['nsf'] = false;
			dealTracker[dealId]['update']['deal_sell_error']['count'] = 0;
			dealTracker[dealId]['update']['deal_sell_error']['count_dupes'] = 0;
			dealTracker[dealId]['update']['deal_sell_error']['date'] = new Date();
		}
	}
	catch(e) {}
}


async function createDealTracker(data) {

	const dealId = data['deal_id'];
	const startId = data['start_id'];

	dealTracker[dealId] = {};
	dealTracker[dealId]['deal'] = {};
	dealTracker[dealId]['info'] = {};
	dealTracker[dealId]['update'] = {};

	dealTracker[dealId]['deal'] = JSON.parse(JSON.stringify(data['deal']));

	// Confirm deal started by deleting start deal tracker
	deleteStartDealTracker(startId);
}


async function updateDealTracker(data) {	

	let dataObj = JSON.parse(JSON.stringify(data));

	dataObj['active'] = true;
	dataObj['updated'] = new Date();

	const dealId = data['deal_id'];

	const dealData = await getDealInfo(dataObj);

	if (dealData['success']) {

		dealTracker[dealId]['info'] = dealData['info'];
		dealTracker[dealId]['deal']['config'] = dealData['config'];
		dealTracker[dealId]['deal']['orders'] = dealData['orders'];
	}
}


async function processDealTracker(dealId, msgErr, updateKey, dataKey) {

	const maxCount = exchangeTimeoutSec * 5;

	let finished = false;
	let success = true;

	let count = 0;
	let msg = 'Success';

	if (dealTracker[dealId] != undefined && dealTracker[dealId] != null) {

		dealTracker[dealId]['update'][updateKey] = dataKey;

		while (!finished) {

			await Common.delay(1000);

			// Verify deal tracker key no longer exists
			if (dealTracker[dealId] == undefined || dealTracker[dealId] == null || !dealTracker[dealId]['update'][updateKey]) {

				finished = true;
			}
			else if (count >= maxCount) {

				// Timeout
				success = false;
				msg = msgErr;

				// Remove flag to continue follow
				try {
		
					delete dealTracker[dealId]['update'][updateKey];
				}
				catch(e) {
		
				}

				finished = true;
			}

			count++;
		}
	}
	else {

		success = false;
		msg = 'Deal ID not found';
	}

	return ( { 'success': success, 'data': msg } );
}


async function deleteDealTracker(dealId) {

	if (dealId != undefined && dealId != null && dealId != '') {

		dealTracker[dealId] = null;
		delete dealTracker[dealId];
	}
}


async function deleteStartDealTracker(id) {

	if (id != undefined && id != null && id != '') {

		startDealTracker[id] = null;
		delete startDealTracker[id];
	}
}


async function createResumeDealTracker(dealId, botId) {

	if (resumeDealTracker[dealId] == undefined || resumeDealTracker[dealId] == null) {

		let obj = {
					'date': new Date(),
					'bot_id': botId
				  };

		resumeDealTracker[dealId] = obj;
	}
}


async function deleteResumeDealTracker(dealId) {

	if (dealId != undefined && dealId != null && dealId != '') {

		resumeDealTracker[dealId] = null;
		delete resumeDealTracker[dealId];
	}
}


async function getDealTracker(dealId) {

	let dataObj;

	if (dealId != undefined && dealId != null && dealId != '') {

		try {

			dataObj = JSON.parse(JSON.stringify(dealTracker[dealId]));
		}
		catch(e) {}
	}
	else {

		try {

			dataObj = JSON.parse(JSON.stringify(dealTracker));
		}
		catch(e) {}
	}

	return dataObj;
}


async function getStartDealTracker(id) {

	let dataObj;

	if (id != undefined && id != null && id != '') {

		try {

			dataObj = JSON.parse(JSON.stringify(startDealTracker[id]));
		}
		catch(e) {}
	}
	else {

		try {

			dataObj = JSON.parse(JSON.stringify(startDealTracker));
		}
		catch(e) {}
	}

	return dataObj;
}


async function getResumeDealTracker(id) {

	let dataObj;

	if (id != undefined && id != null && id != '') {

		try {

			dataObj = JSON.parse(JSON.stringify(resumeDealTracker[id]));
		}
		catch(e) {}
	}
	else {

		try {

			dataObj = JSON.parse(JSON.stringify(resumeDealTracker));
		}
		catch(e) {}
	}

	return dataObj;
}


async function processResumeDealTracker(data) {

	// Confirm no deals are resuming before allowing additional checks and new deals to start

	if (data == undefined || data == null || typeof data != 'object') {

		data = {};
	}

	const maxSec = 60;
	const dateNow = new Date();

	const dealId = data['deal_id'];

	let success = false;
	let finished = false;
	let msgSent = false;
	let msgSentWarn = false;

	let msg = 'Waiting for resume deal tracker to finish before continuing to process new deals (' + dealId + ')';

	while (!finished) {

		let resumeDealsObj = await getResumeDealTracker();

		if (resumeDealsObj == undefined || resumeDealsObj == null || resumeDealsObj == '') {
		
			resumeDealsObj = {};
		}

		if (Object.keys(resumeDealsObj).length == 0) {

			success = true;
			finished = true;
		}
		else {

			if (!msgSent) {

				msgSent = true;

				if (shareData.appData.verboseLog) { Common.logger( colors.bgCyan.bold(msg) ); }
			}

			await Common.delay(500);
		}

		let diffSec = (new Date().getTime() - new Date(dateNow).getTime()) / 1000;

		if (diffSec > maxSec) {

			if (!msgSentWarn) {

				let msgWarn = 'WARNING: Resume deal tracker exceeds ' + maxSec + ' seconds. Timed out.';

				msgSentWarn = true;

				Common.logger( colors.bgCyan.bold(msgWarn) );

				Common.sendNotification({ 'message': msgWarn, 'type': 'warning', 'telegram_id': shareData.appData.telegram_id });
			}

			success = false;
			finished = true;
		}
	}

	return ({ 'success': success });
}


async function getBalanceTracker() {

	let getNew = false;

	let balances = {};

	let lastUpdated = balanceTracker['updated'];

	let diffSec = (new Date().getTime() - new Date(lastUpdated).getTime()) / 1000;

	if (diffSec > 5 || lastUpdated == undefined || lastUpdated == null) {

		getNew = true;
	}

	if (getNew) {

		const exchanges = shareData.appData.exchanges;

		for (let exchange in exchanges) {

			const exchangeObj = exchanges[exchange];

			const balance = await getBalance(exchangeObj);

			if (balance.success) {

				balances[exchange] = balance.balance;
			}
		}
	}
	else {

		try {

			balances = JSON.parse(JSON.stringify(balanceTracker));
		}
		catch(e) {}
	}

	const resObj = {
						'updated': new Date(),
						'balances': balances
				   };

	// Divide total by qty sum in orders to get percentage difference
	for (let exchange in balances) {

		const exchangeData = balances[exchange];

		for (let symbol in exchangeData) {

			const symbolData = exchangeData[symbol];
			const free = parseFloat(symbolData['free']);
			const total = parseFloat(symbolData['total']);

			if (!isNaN(free)) {

				//console.log(symbol, free);
			}
		}
	}

	balanceTracker = JSON.parse(JSON.stringify(resObj));

	return resObj;
}


async function getDealInfo(data) {

	const updated = data['updated'];
	const dealId = data['deal_id'];
	const active = data['active'];
	const price = data['price'];
	const error = data['error'];

	const config = JSON.parse(JSON.stringify(data['config']));
	const orders = JSON.parse(JSON.stringify(data['orders']));

	const filledOrders = orders.filter(item => item.filled == 1);
	const currentOrder = filledOrders.pop();

	if (currentOrder != undefined && currentOrder != null) {

		const profitData = await calculateProfit(price, config.sandBox, currentOrder.average, currentOrder.sum, config.dcaTakeProfitPercent, config.exchangeFee);

		const profitPerc = profitData['profit_percentage'];
		const takeProfit = profitData['take_profit'];
		const currentProfit = profitData['profit'];

		const dealInfo = {
							'updated': updated,
							'active': active,
							'error': error,
							'bot_id': config.botId,
							'bot_name': config.botName,
							'safety_orders_used': filledOrders.length,
							'safety_orders_max': orders.length - 1,
							'price_last': price,
							'price_average': currentOrder.average,
							'price_target': currentOrder.target,
							'profit': currentProfit,
							'profit_percentage': profitPerc,
							'take_profit': takeProfit,
							'deal_count': config.dealCount,
							'deal_max': config.dealMax
						 };

		return ({ 'success': true, 'info': dealInfo, 'config': config, 'orders': orders });
	}
	else {

		return ({ 'success': false });
	}
}


async function initBot(data) {

	let create = data['create'];
	let configObj = JSON.parse(JSON.stringify(data['config']));

	if (create) {

		configObj = await createBot(configObj);
	}
	else {

		configObj = await initConfigData(configObj);
	}

	return configObj;
}


async function initConfigData(config) {

	let configObj = JSON.parse(JSON.stringify(config));

	const botConfig = await shareData.Common.getConfig('bot.json');

	// Set exchange options
	configObj['exchangeOptions'] = botConfig.data['exchangeOptions'];

	// Set credentials
	for (let key in botConfig.data) {

		if (key.substring(0, 3).toLowerCase() == 'api') {

			configObj[key] = botConfig.data[key];
		}
	}

	// Set current exchange fee
	configObj['exchangeFee'] = botConfig.data['exchangeFee'];

	// Set bot id
	if (configObj['botId'] == undefined || configObj['botId'] == null || configObj['botId'] == '') {

		configObj['botId'] = Common.uuidv4();
	}

	// Set initial deal count
	if (configObj['dealCount'] == undefined || configObj['dealCount'] == null || configObj['dealCount'] == 0) {

		configObj['dealCount'] = 1;
	}

	return configObj;
}


async function removeConfigData(config) {

	let configObj = JSON.parse(JSON.stringify(config));

	for (let key in configObj) {

		if (key.substring(0, 3).toLowerCase() == 'api') {

			delete configObj[key];
		}
	}

	return configObj;
}


async function ordersToHtml(data) {

	let rows = data.split(/[\r\n]+/);

	let table = '<table id="ordersTable" cellspacing=0 cellpadding=0>';

	for (let i = 0; i < rows.length; i++) {

		let cols = rows[i].split(/[\s\t]+/);

		let tag = 'td';
		let row = '<tr>';
			
		if (i == 0) {

			tag = 'th';
		}

		for (let x = 0; x < cols.length; x++) {

			let col = cols[x];
			row += '<' + tag + '>' + col.trim() + '</' + tag + '>';
		}

		row += '</tr>';

		if (i != 1) {

			table += row;
		}
	}
	
	table += '</table>';
	
	return table;
}


async function ordersToData(data) {

	let rows = data.split(/[\r\n]+/);

	let count = 0;

	let headers = [];
	let steps = [];

	for (let i = 0; i < rows.length; i++) {

		let stepsTemp = [];

		let cols = rows[i].split(/[\s\t]+/);

		if (i == 0) {

			headers = cols.map(item => {

				return item.trim();
			});
		}

		if (i < 2) {

			continue;
		}

		for (let x = 0; x < cols.length; x++) {

			let col = cols[x].trim();

			stepsTemp.push(col);
		}

		stepsTemp = stepsTemp.filter((a) => a);

		if (stepsTemp.length > 0) {

			steps[count] = stepsTemp;

			count++;
		}
	}

	// Remove empty
	headers = headers.filter((a) => a);

	const orders = { 'headers': headers, 'steps': steps };

	return orders;
}


async function ordersCreateTable(data) {

	let config = data['config'];
	let orders = data['orders'];

	let ordersDeviation = [];
	let ordersMetadata = [];

	let t = new Table();

	for (let x = 0; x < orders.length; x++) {

		let order = orders[x];

		let deviationPerc = await getDeviationDca(config.dcaOrderStepPercent, config.dcaOrderStepPercentMultiplier, x);

		deviationPerc = Number(deviationPerc.toFixed(2));

		ordersDeviation.push(deviationPerc);
	}

	orders.forEach(function (order) {

		ordersMetadata.push(order.orderMetadata);

		t.cell('No', order.orderNo);
		t.cell('Deviation', ordersDeviation[order.orderNo - 1] + '%');
		t.cell('Price', '$' + order.price);
		t.cell('Average', '$' + order.average);
		t.cell('Target', '$' + order.target);
		t.cell('Qty', order.qty);
		t.cell('Amount($)', '$' + order.amount);
		t.cell('Sum(Qty)', order.qtySum);
		t.cell('Sum($)', '$' + order.sum);
		t.cell('Type', order.type);
		t.cell('Filled', order.filled == 0 ? 'Waiting' : 'Filled');

		t.newRow();
	});

	let maxDeviation = await getDeviationDca(config.dcaOrderStepPercent, config.dcaOrderStepPercentMultiplier, orders.length - 1);

	return ( { 'table': t, 'max_deviation': maxDeviation, 'metadata': ordersMetadata } );
}


async function ordersAddContent(wallet, lastDcaOrderSum, maxDeviation, balanceObj) {

	let balanceError;

	if (balanceObj != undefined && balanceObj != null && balanceObj != '') {

		balanceError = balanceObj.error;
	}

	let obj = {
				'balance': Number(wallet),
				'balance_error': balanceError,
				'max_funds': Number(lastDcaOrderSum),
				'max_deviation_percent': Number(maxDeviation.toFixed(2))
			  };

	return obj;
}


async function sendNotificationStart(botName, dealId, pair) {

	let msg = botName + ': Starting new deal. Pair: ' + pair.toUpperCase();

	Common.sendNotification({ 'message': msg, 'type': 'deal_open', 'telegram_id': shareData.appData.telegram_id });
}


async function sendNotificationFinish(botName, dealId, pair, sellData) {

	let orderCount = 0;

	let msg;
	let msgLoss;
	let msgProfit;

	const dealData = await getDeals({ 'dealId': dealId });
	const profitPerc = Number(sellData.profit);

	const deal = dealData[0];
	const orders = deal.orders;

	for (let x = 0; x < orders.length; x++) {

		const order = orders[x];

		if (order['filled']) {

			orderCount++;
		}
	}

	const profit = shareData.Common.roundAmount(Number((Number(orders[orderCount - 1]['sum']) * (profitPerc / 100))));
	const duration = shareData.Common.timeDiff(new Date(), new Date(deal['date']));

	try {

		let msgObj = JSON.parse(fs.readFileSync(pathRoot + '/libs/strategies/DCABot/telegram/dealComplete.json', { encoding: 'utf8', flag: 'r' }));

		msgLoss = msgObj['loss'];
		msgProfit = msgObj['profit'];
	}
	catch(e) {

	}

	if (profit <= 0) {

		msg = msgLoss;
	}
	else {

		msg = msgProfit;
	}

	msg = msg.replace(/\{BOT_NAME\}/g, botName);
	msg = msg.replace(/\{DEAL_ID\}/g, dealId);
	msg = msg.replace(/\{PAIR\}/g, pair.toUpperCase());
	msg = msg.replace(/\{PROFIT\}/g, profit);
	msg = msg.replace(/\{PROFIT_PERCENT\}/g, profitPerc);
	msg = msg.replace(/\{DURATION\}/g, duration);

	Common.sendNotification({ 'message': msg, 'type': 'deal_close', 'telegram_id': shareData.appData.telegram_id });
}


async function ordersValid(pair, orders) {

	let msg;
	let success = true;

	if (Array.isArray(orders) && orders.length > 1) {

		let priceAverage1 = orders[0]['average'];
		let priceAverage2 = orders[1]['average'];

		if (priceAverage1 == priceAverage2) {

			success = false;

			msg = pair + ' average price calculations are identical. Not allowing pair.';

			if (shareData.appData.verboseLog) { Common.logger( colors.bgRed.bold(msg) ); }
		}
	}

	return ( { 'success': success, 'data': msg } );
}


async function volumeValid(startBot, pair, symbol, config) {

	let success = true;

	const pairSafe = pair.replace(/\//g, '_');

	const volumeMin = Number(config.volumeMin);

	const volume24h = Number(((symbol.last * symbol.baseVolume) / 1000000).toFixed(2));

	const timerKey = config.botId + pairSafe;

	let msg = 'Delaying deal start. ' + pair + ' 24h volume: ' + volume24h + 'M. Minimum required: ' + volumeMin + 'M';

	if (startBot && volumeMin > 0 && volume24h < volumeMin) {

		const configObj = JSON.parse(JSON.stringify(config));

		// Clear previous timeout if exists so additional starts don't occur
		if (timerTracker[timerKey] != undefined && timerTracker[timerKey] != null) {

			clearTimeout(timerTracker[timerKey]['id']);
		}
		else {

			timerTracker[timerKey] = {};
			timerTracker[timerKey]['started'] = new Date();

			Common.sendNotification({ 'message': msg, 'type': 'warning', 'telegram_id': shareData.appData.telegram_id });
		}

		let diffSec = (new Date().getTime() - new Date(timerTracker[timerKey]['started']).getTime()) / 1000;

		if (diffSec > (60 * maxMinsVolume)) {

			timerTracker[timerKey] = null;
			delete timerTracker[timerKey];

			if (shareData.appData.verboseLog) { Common.logger( colors.bgCyan.bold('Timeout reached for volume delayed deal start: ' + pair) ); }
		}
		else {

			if (shareData.appData.verboseLog) { Common.logger( colors.bgCyan.bold(msg) ); }

			timerTracker[timerKey]['id'] = setTimeout(() => {
																startVerify(configObj);

															}, (60000 * 1));
		}

		success = false;
	}

	return success;
}


async function genDealId(botId, pair) {

	const pairSafe = pair.replace(/\//g, '_');

	let dateNow = Math.floor(Date.now() / 1000);

	let str = botId + '-' + pairSafe + '-' + dateNow;

	let code = Common.hashCode(str);

	code = Common.numToBase26(code);

	let dealId = pairSafe + '-' + code + '-' + dateNow;

	return dealId;
}


async function createBot(config) {

	let configObj;

	let botOk = false;

	let configPassed = JSON.parse(JSON.stringify(config));
	let configSave = await removeConfigData(JSON.parse(JSON.stringify(config)));

	while (!botOk) {

		let isErr;

		configObj = JSON.parse(JSON.stringify(configPassed));
		configObj = await initConfigData(configObj);

		let bot = await Bots.findOne({
		
				botId: configObj.botId,
		});

		if (!bot) {

			let active = true;
				
			if (typeof configObj.active == 'boolean') {

				active = configObj.active;
			}

			delete configSave['active'];

			let bot = new Bots({
									'botId': configObj.botId,
									'botName': configObj.botName,
									'config': configSave,
									'active': active,
									'date': Date.now(),
								});

			await bot.save()
					.catch(err => {
										isErr = err;

										if (err.code === 11000) {

											// Duplicate entry
										}
								  });

			if (isErr == undefined || isErr == null) {

				botOk = true;
			}
			else {

				await Common.delay(1000);
			}
		}
		else {

			botOk = true;
		}
	}

	return configObj;
}


async function createDeal(pair, pairMax, dealCount, dealMax, config, orders) {

	let deal;
	let dealId;

	let dealOk = false;

	const configSave = await removeConfigData(config);

	while (!dealOk) {

		let isErr;

		dealId = await genDealId(config.botId, pair);

		deal = new Deals({
							'botId': config.botId,
							'botName': config.botName,
							'dealId': dealId,
							'exchange': config.exchange,
							'pair': pair,
							'date': Date.now(),
							'status': 0,
							'config': configSave,
							'orders': orders,
							'isStart': 0,
							'active': true,
							'dealCount': dealCount,
							'dealMax': dealMax,
							'pairMax': pairMax
						});

		await deal.save()
					.catch(err => {
										isErr = err;

										if (err.code === 11000) {

											// Duplicate entry
										}
								  });

		if (isErr == undefined || isErr == null) {

			dealOk = true;
		}
		else {

			await Common.delay(1000);
		}
	}

	if (shareData.appData.verboseLog) {

		Common.logger(colors.green.bold(config.botName + ': Starting new deal. Pair: ' + pair.toUpperCase() + ' / Deal ID: ' + dealId));
	}

	sendNotificationStart(config.botName, dealId, pair);

	return ({ 'deal': deal, 'deal_id': dealId });
}


async function startVerify(config, startId) {

	// Verify bot is still enabled / active

	const pair = config.pair;
	const botId = config.botId;
	const dealCount = config.dealCount;

	if (botId != undefined && botId != null && botId != '') {

		// Reload bot config from db in case any changes were made
		const bot = await getBots({ 'botId': botId });

		if (bot && bot.length > 0) {

			if (bot[0].active) {

				// Get total active pairs currently running on bot
				let botDealsActive = await getDeals({ 'botId': botId, 'status': 0 });

				let pairCount = botDealsActive.length;

				let botConfigDb = bot[0].config;

				let pairMax = botConfigDb.pairMax;

				if (pairMax == undefined || pairMax == null || pairMax == '') {

					pairMax = 0;
				}

				if (pairMax == 0 || pairCount < pairMax) {

					botConfigDb['pair'] = pair;
					botConfigDb['botId'] = botId;
					botConfigDb['dealCount'] = dealCount;

					start({ 'create': true, 'config': botConfigDb }, startId);
				}
			}
		}
	}
}


async function startSignals() {

	// Start signals after everything else is finished loading

	const appConfig = await Common.getConfig('app.json');

	const enabled = appConfig['data']['signals']['3CQS']['enabled'];

	const socket = await shareData.Signals3CQS.start(enabled, appConfig['data']['signals']['3CQS']['api_key']);
}


async function startAsap(pairIgnore) {

	// Check for any resuming deals before continuing
	await processResumeDealTracker();

	// Start any active asap bots that have no deals running
	const botsActive = await getBots({ 'active': true, 'config.startConditions': { '$eq': 'asap' } });

	if (botsActive && botsActive.length > 0) {

		let count = 0;

		for (let i = 0; i < botsActive.length; i++) {

			let bot = botsActive[i];

			let config = bot['config'];

			let botId = bot.botId;
			let botName = bot.botName;

			let pairs = config.pair;
			let pairMax = config.pairMax;

			if (pairMax == undefined || pairMax == null || pairMax == '') {

				pairMax = 0;
			}

			// Get total active pairs currently running on bot
			let botDealsActive = await getDeals({ 'botId': botId, 'status': 0 });

			let pairCount = botDealsActive.length;

			for (let x = 0; x < pairs.length; x++) {

				let pair = pairs[x];

				if (pairIgnore != undefined && pairIgnore != null && pairIgnore != '') {

					if (pair.toUpperCase() == pairIgnore.toUpperCase()) {

						continue;
					}
				}

				let dealsActive = await getDeals({ 'botId': botId, 'pair': pair, 'status': 0 });

				config['pair'] = pair;
				config = await applyConfigData({ 'bot_id': botId, 'bot_name': botName, 'config': config });

				// Start bot if active, no deals are currently running and start condition is now asap
				if (dealsActive && dealsActive.length == 0) {

					if (pairMax == 0 || pairCount < pairMax) {

						startDelay({ 'config': config, 'delay': count + 1, 'notify': false });

						count++;
						pairCount++;
					}
					else {

						//Common.logger('Bot max pairs of ' + pairMax + ' reached');
					}
				}
			}
		}
	}
}


async function resumeBots() {

	// Check for active deals and resume bots
	const dealsActive = await getDeals({ 'status': 0 });

	if (dealsActive && dealsActive.length > 0) {

		Common.logger( colors.bgGreen.bold('Resuming ' + dealsActive.length + ' active DCA bot deals...') );

		for (let i = 0; i < dealsActive.length; i++) {

			let deal = dealsActive[i];

			const botId = deal.botId;
			const dealId = deal.dealId;

			// Create all initial resuming deals ahead of time
			await createResumeDealTracker(dealId, botId);
		}

		for (let i = 0; i < dealsActive.length; i++) {

			let deal = dealsActive[i];

			await resumeDeal(deal);
		}
	}

	await Common.delay(5000);

	startAsap();
}


async function resumeDeal(dealObj) {

	let deal = JSON.parse(JSON.stringify(dealObj));

	let config = deal.config;

	const botId = deal.botId;
	const botName = deal.botName;
	const dealId = deal.dealId;
	const pair = deal.pair;
	const dealCount = deal.dealCount;
	const dealMax = deal.dealMax;
	const signalId = config.signalId;

	// Track resuming deals
	await createResumeDealTracker(dealId, botId);

	// Apply previous config data

	config['dealCount'] = dealCount;
	config['dealMax'] = dealMax;
	config['dealResumeId'] = dealId;

	deal['config'] = await applyConfigData({ 'signal_id': signalId, 'bot_id': botId, 'bot_name': botName, 'config': config });

	await createDealTracker({ 'deal_id': dealId, 'deal': deal });

	Common.logger( colors.bgGreen.bold('Resuming Deal ID ' + dealId) );

	start({ 'create': true, 'config': config });

	await Common.delay(1000);
}


async function pauseDeal(dealId, pause) {

	let success = true;
	let msg = 'Success';
	let updateKey = 'deal_pause';

	if (dealTracker[dealId] != undefined && dealTracker[dealId] != null) {

		if (pause) {

			// Set deal_pause flag
			dealTracker[dealId]['update'][updateKey] = true;
		}
		else {

			// Remove deal_pause flag
			delete dealTracker[dealId]['update'][updateKey];
		}
	}
	else {

		success = false;
		msg = 'Deal ID not found';
	}

	return ( { 'success': success, 'data': msg } );
}


async function refreshUpdateDeal(data) {

	let dealId = data['deal_id'];
	let config = data['config'];

	let updateKey = 'config';
	let msgErr = 'Deal refresh timeout';

	const res = await processDealTracker(dealId, msgErr, updateKey, config);

	return res;
}


async function stopDeal(dealId) {

	let updateKey = 'deal_stop';
	let msgErr = 'Deal stop timeout';

	const res = await processDealTracker(dealId, msgErr, updateKey, true);

	return res;
}


async function cancelDeal(dealId) {

	let updateKey = 'deal_cancel';
	let msgErr = 'Deal cancel timeout';

	const res = await processDealTracker(dealId, msgErr, updateKey, true);

	return res;
}


async function panicSellDeal(dealId) {

	let updateKey = 'deal_panic_sell';
	let msgErr = 'Deal sell timeout';

	const res = await processDealTracker(dealId, msgErr, updateKey, true);

	return res;
}


async function addFundsDeal(dealId, volume) {

	let success = true;
	let isUpdated = false;
	let msg = 'Success';

	const deal = await Deals.findOne({
		dealId: dealId,
		status: 0,
	});

	if (deal) {

		const config = JSON.parse(JSON.stringify(deal.config));
		const orders = JSON.parse(JSON.stringify(deal.orders));

		Common.logger(
			colors.red.bold('Add Funds to deal ID ' + dealId + ' requested.')
		);

		let minMoveAmount;

		let oldOrders = orders;
		let exchange = await connectExchange(config).catch(console.log);

		const ex = await exchange.loadMarkets();

		volume = await filterPrice(exchange, config.pair, volume);

		for (let i = 0; i < oldOrders.length; i++) {

			if (!oldOrders[i].filled && !isUpdated) {

				const symbolData = await getSymbol(exchange, config.pair);
				const symbol = symbolData.data;

				const bidPrice = symbol.bid;
				const askPrice = symbol.ask;

				let newOrder = Object.assign({}, oldOrders[i]);
				let price = await filterPrice(exchange, config.pair, askPrice);
				let amount = await filterPrice(exchange, config.pair, volume);
				let qty = await filterAmount(exchange, config.pair, ((volume) / askPrice));

				// Get minimum movement amount from first order
				try {

					minMoveAmount = oldOrders[0]['orderMetadata']['minimum_movement_amount'];
				}
				catch (e) {}

				const adjustments = await calculateAdjustments({

					'exchange': exchange,
					'pair': config.pair,
					'amount': amount,
					'orderSize': qty,
					'exchangeFee': config.exchangeFee,
					'minMoveAmount': minMoveAmount
				});

				qty = adjustments['order_qty'];
				amount = adjustments['order_amount'];

				let qtySum = (parseFloat(qty) + parseFloat(oldOrders[i - 1].qtySum));
				qtySum = await filterAmount(exchange, config.pair, qtySum);

				let orderSum = (parseFloat(amount) + parseFloat(oldOrders[i - 1].sum));
				orderSum = await filterPrice(exchange, config.pair, orderSum);

				let sum = await filterPrice(exchange, config.pair, orderSum);

				const avgPrice = await filterPrice(exchange, config.pair, (parseFloat(orderSum) / parseFloat(qtySum)));

				let targetPrice = await calculateTargetPrice({

					'exchange': exchange,
					'pair': config.pair,
					'price': avgPrice,
					'takeProfit': config.dcaTakeProfitPercent,
					'exchangeFee': config.exchangeFee
				});

				if (targetPrice != undefined && targetPrice != null && targetPrice != false && targetPrice > 0) {

					let buyOrderId = '';

					isUpdated = true;

					if (!config.sandBox) {

						const buy = await buyOrder(exchange, dealId, config.pair, qty, targetPrice);

						if (!buy.success) {
	
							success = false;
							isUpdated = false;
							msg = buy;
						}
						else {

							buyOrderId = buy['data']['id'];
						}
					}

					newOrder.orderId = buyOrderId;
					newOrder.price = price;
					newOrder.average = avgPrice;
					newOrder.target = targetPrice;
					newOrder.qty = qty;
					newOrder.amount = amount;
					newOrder.qtySum = qtySum;
					newOrder.sum = orderSum;
					newOrder.manual = true;
					newOrder.filled = 1;
					newOrder.orderMetadata = adjustments;
					newOrder.dateFilled = new Date();

					oldOrders.splice(i, 0, newOrder);
				}

			} else if (isUpdated) {

				let price = Percentage.subPerc(
					(oldOrders[i - 1].price),
					(config.dcaOrderStartDistance)
				);

				price = await filterPrice(exchange, config.pair, price);

				let orderSize = (oldOrders[i].qty);

				orderSize = await filterAmount(exchange, config.pair, orderSize);

				let orderAmount = parseFloat(orderSize) * parseFloat(price);
				orderAmount = await filterPrice(exchange, config.pair, orderAmount);

				let orderSum = parseFloat(orderAmount) + parseFloat(oldOrders[i - 1].sum);
				orderSum = await filterPrice(exchange, config.pair, orderSum);

				let orderQtySum = parseFloat(orderSize) + parseFloat(oldOrders[i - 1].qtySum);
				orderQtySum = await filterAmount(exchange, config.pair, orderQtySum);

				const avgPrice = await filterPrice(exchange, config.pair, parseFloat(orderSum) / parseFloat(orderQtySum));

				let targetPrice = await calculateTargetPrice({

					'exchange': exchange,
					'pair': config.pair,
					'price': avgPrice,
					'takeProfit': config.dcaTakeProfitPercent,
					'exchangeFee': config.exchangeFee
				});

				oldOrders[i].orderNo = oldOrders[i].orderNo + 1;
				oldOrders[i].price = price;
				oldOrders[i].average = avgPrice;
				oldOrders[i].target = targetPrice;
				oldOrders[i].qty = orderSize;
				oldOrders[i].amount = orderAmount;
				oldOrders[i].qtySum = orderQtySum;
				oldOrders[i].sum = orderSum;
			}
		}

		//console.table(oldOrders);

		if (success) {

			const botId = deal.botId;
			const config = deal.config;

			let dataUpdate = await updateDeal(botId, dealId, {
				config: config,
				orders: oldOrders,
			});
		}
	}
	else {

		success = false;
		msg = 'Deal ID not found';
	}

	return ( { 'success': success, 'data': msg } );
}


async function applyConfigData(data) {

	let botId = data['bot_id'];
	let botName = data['bot_name'];
	let signalId = data['signal_id'];
	let config = data['config'];

	// Pass bot id in config so existing bot is used
	config['botId'] = botId;
	config['botName'] = botName;

	// Don't reset deal count
	if (config['dealCount'] == undefined || config['dealCount'] == null || config['dealCount'] == '') {

		config['dealCount'] = 0;
	}

	// Set signal id if present
	if (signalId != undefined && signalId != null && signalId != '') {

		config['signalId'] = signalId;
	}

	return config;
}


async function startDelay(dataObj) {

	const data = JSON.parse(JSON.stringify(dataObj));

	const config = data['config'];
	const notify = data['notify'];

	// Check for any resuming deals before continuing
	await processResumeDealTracker();

	const startId = await Common.uuidv4();

	startDealTracker[startId] = {};
	startDealTracker[startId]['date'] = new Date();

	// Start bot
	setTimeout(() => {
						if (notify) {

							let msg = config.botName + ' (' + config.pair.toUpperCase() + ') Start command received.';

							Common.sendNotification({ 'message': msg, 'type': 'bot_start', 'telegram_id': shareData.appData.telegram_id });
						}

						startVerify(config, startId);
						//start({ 'create': true, 'config': config });

					 }, (1000 * (data['delay'])));

	return startId;
}


async function initApp() {

	const loadMarketHours = 4;

	// Don't initialize if resetting database
	if (shareData.appData.reset) {

		return;
	}

	setInterval(() => {

		loadExchangeMarkets();

	}, (loadMarketHours * 60 * 60 * 1000));


	setInterval(() => {

		checkTrackers();

	}, (60000 * 1));


	setInterval(() => {

		checkResumeDealTracker();

	}, (60000 * 1));


	/*
	setInterval(() => {

		getBalanceTracker();

	}, (60000 * 1));
	*/

	setInterval(() => {

		checkStartDealTracker();

	}, 1500);

	await resumeBots();

	//getBalanceTracker();

	startSignals();
}


module.exports = {

	colors,
	start,
	updateBot,
	sendBotStatus,
	ordersValid,
	updateOrders,
	cancelDeal,
	pauseDeal,
	stopDeal,
	updateDeal,
	refreshUpdateDeal,
	addFundsDeal,
	panicSellDeal,
	connectExchange,
	removeConfigData,
	initBot,
	getBots,
	getDeals,
	getDealInfo,
	getDealTracker,
	getStartDealTracker,
	getResumeDealTracker,
	getSymbol,
	getSymbolsAll,
	applyConfigData,
	startDelay,
	resumeDeal,
	getBalance,
	getPairData,

	init: function(obj) {

		shareData = obj;

		initApp();
    }
}
