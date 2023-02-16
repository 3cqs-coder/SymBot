'use strict';

const fs = require('fs');
const path = require('path');

let pathRoot = path.dirname(fs.realpathSync(__dirname)).split(path.sep).join(path.posix.sep);
pathRoot = pathRoot.substring(0, pathRoot.lastIndexOf('/'));


const colors = require('colors');
const ccxt = require('ccxt');
const Table = require('easy-table');
const Percentage = require('percentagejs');
const Common = require(pathRoot + '/Common.js');
const Schema = require(pathRoot + '/mongodb/DCABotSchema');

const Bots = Schema.Bots;
const Deals = Schema.Deals;

const prompt = require('prompt-sync')({
	sigint: true
});


const insufficientFundsMsg = 'Your wallet does not have enough funds for all DCA orders!';


let dealTracker = {};
let timerTracker = {};

let shareData;



async function start(data, startBot, reload) {

	data = await initBot(startBot, JSON.parse(JSON.stringify(data)));

	const dealResume = data['dealResume'];

	delete data['dealResume'];

	const config = Object.freeze(JSON.parse(JSON.stringify(data)));

	let dealIdMain;
	let botConfigDb;

	let botActive = true;
	let botFoundDb = false;
	let pairFoundDb = false;

	let totalOrderSize = 0;
	let totalAmount = 0;

	let pair = '';
	let pairConfig = config.pair;
	let botIdMain = config.botId;
	let dealCount = config.dealCount;
	let dealMax = config.dealMax;

	if (dealCount == undefined || dealCount == null) {

		dealCount = 0;
	}

	if (dealMax == undefined || dealMax == null) {

		dealMax = 0;
	}

	let exchange = await connectExchange(config);

	if (exchange == undefined || exchange == null) {

		return ( { 'success': false, 'data': 'Invalid exchange: ' + config.exchange } );
	}

	try {

		//Load markets
		//const markets = await exchange.loadMarkets();

		if (pairConfig == undefined || pairConfig == null || pairConfig == '') {

			//pair = prompt(colors.bgGreen('Please enter pair (BASE/QUOTE): '));
			return;
		}
		else {

			pair = pairConfig;
		}

		pair = pair.toUpperCase();

		const pairSafe = pair.replace(/\//g, '_');

		if (!reload) {

			if (shareData.appData.verboseLog) { Common.logger(colors.green('Getting pair information for ' + pair + '...')); }
		}

		const isActive = await checkActiveDeal(botIdMain, pair);
		const symbolData = await getSymbol(exchange, pair);
		const symbol = symbolData.info;

		// Check for valid symbol data on start
		if (symbolData.invalid) {

			if (Object.keys(dealTracker).length == 0) {

				//process.exit(0);
			}

			return ( { 'success': false, 'data': 'Invalid Pair' } );
		}
		else if (symbolData.error != undefined && symbolData.error != null) {

			return ( { 'success': false, 'data': JSON.stringify(symbolData.error) } );
		}

		let askPrice = symbol.askPrice;

		if (symbol.askPrice == undefined || symbol.askPrice == null) {

			askPrice = symbol.ask;
		}

		var t = new Table();
		const orders = [];

		if (startBot && isActive) {

			dealIdMain = isActive.dealId;

			if (!reload) {

				// Active deal found so get original config from db and restart bot

				if (dealTracker[isActive.dealId] != undefined && dealTracker[isActive.dealId] != null) {

					let msg = 'Deal ID ' + isActive.dealId + ' already running for ' + pair + '...';

					if (shareData.appData.verboseLog) { Common.logger( colors.bgCyan.bold(msg) ); }

					return ( { 'success': false, 'data': msg } );
				}

				if (shareData.appData.verboseLog) { Common.logger( colors.bgCyan.bold('Found active DCA deal for ' + pair + '...') ); }

				let configObj = JSON.parse(JSON.stringify(isActive.config));

				start(configObj, true, true);

				return;
			}
			else {

				// Config reloaded from db so bot and continue
				//await Common.delay(1000);

				let followSuccess = false;
				let followFinished = false;

				while (!followSuccess && !followFinished) {

					let followRes = await dcaFollow(config, exchange, isActive.dealId);

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
		}
		else {

			let lastDcaOrderAmount = 0;
			let lastDcaOrderSize = 0;
			let lastDcaOrderSum = 0;
			let lastDcaOrderQtySum = 0;
			let lastDcaOrderPrice = 0;

			if (!await volumeValid(startBot, pair, symbol, config)) {

				return;
			}

			if (config.firstOrderType.toUpperCase() == 'MARKET') {

				//first order market
				if (shareData.appData.verboseLog) { Common.logger(colors.bgGreen('Calculating orders for ' + pair + '...')); }

				await Common.delay(1000);

				let firstOrderSize = config.firstOrderAmount / askPrice;
				firstOrderSize = await filterAmount(exchange, pair, firstOrderSize);

				if (!firstOrderSize) {

					if (shareData.appData.verboseLog) { Common.logger(colors.bgRed('First order amount not valid.')); }

					return false;
				}
				else {

					totalOrderSize = firstOrderSize;
					totalAmount = config.firstOrderAmount;

					const price = await filterPrice(exchange, pair, askPrice);

					let amount = price * firstOrderSize;
					let exchangeFee = (amount / 100) * Number(config.exchangeFee);

					amount = await filterPrice(exchange, pair, (amount + exchangeFee));

					let targetPrice = Percentage.addPerc(
						price,
						config.dcaTakeProfitPercent
					);

					targetPrice = await filterPrice(exchange, pair, targetPrice);

					orders.push({
						orderNo: 1,
						price: price,
						average: price,
						target: targetPrice,
						qty: firstOrderSize,
						amount: amount,
						qtySum: firstOrderSize,
						sum: amount,
						type: 'MARKET',
						filled: 0
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
						dcaOrderSize = await filterAmount(exchange, pair, dcaOrderSize);

						let dcaOrderAmount = dcaOrderSize * price;
						let exchangeFee = (dcaOrderAmount / 100) * Number(config.exchangeFee);

						dcaOrderAmount = await filterPrice(exchange, pair, (dcaOrderAmount + exchangeFee));

						let dcaOrderSum = parseFloat(dcaOrderAmount) + parseFloat(lastDcaOrderAmount);
						dcaOrderSum = await filterPrice(exchange, pair, dcaOrderSum);

						const dcaOrderQtySum = parseFloat(dcaOrderSize) + parseFloat(firstOrderSize);

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

						let targetPrice = Percentage.addPerc(
							average,
							config.dcaTakeProfitPercent
						);

						targetPrice = await filterPrice(exchange, pair, targetPrice);

						orders.push({
							orderNo: i + 2,
							price: price,
							average: average,
							target: targetPrice,
							qty: dcaOrderSize,
							amount: dcaOrderAmount,
							qtySum: dcaOrderQtySum,
							sum: dcaOrderSum,
							type: 'MARKET',
							filled: 0
						});
					}
					else {

						let price = Percentage.subPerc(
							lastDcaOrderPrice,
							(config.dcaOrderStepPercent * config.dcaOrderStepPercentMultiplier)
						);

						price = await filterPrice(exchange, pair, price);

						//let dcaOrderSize = lastDcaOrderSize * config.dcaOrderSizeMultiplier;
						let dcaOrderSize = (lastDcaOrderSize * (config.dcaOrderStepPercent / 100)) + lastDcaOrderSize * config.dcaOrderSizeMultiplier;
						dcaOrderSize = await filterAmount(exchange, pair, dcaOrderSize);

						let amount = price * dcaOrderSize;
						let exchangeFee = (amount / 100) * Number(config.exchangeFee);

						amount = await filterPrice(exchange, pair, (amount + exchangeFee));

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

						let targetPrice = Percentage.addPerc(
							average,
							config.dcaTakeProfitPercent
						);

						targetPrice = await filterPrice(exchange, pair, targetPrice);

						orders.push({
							orderNo: i + 2,
							price: price,
							average: average,
							target: targetPrice,
							qty: dcaOrderSize,
							amount: amount,
							qtySum: dcaOrderQtySum,
							sum: dcaOrderSum,
							type: 'MARKET',
							filled: 0
						});
					}
				}

				orders.forEach(function (order) {
					t.cell('No', order.orderNo);
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

				const maxDeviation = await getDeviation(Number(orders[0].price), Number(orders[orders.length - 1].price));

				//console.log(t.toString());
				//Common.logger(t.toString());

				let wallet = 0;

				if (config.sandBox) {

					wallet = config.sandBoxWallet;
				}
				else {

					const balance = await getBalance(exchange, 'USDT');
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

					let contentAdd = await ordersAddContent(wallet, lastDcaOrderSum, maxDeviation);

					let ordersTable = await ordersToData(t.toString());

					return ({
								'success': true,
								'data': {
											'pair': pair,
											'orders': ordersTable,
											'content': contentAdd
										}
							});

/*
					sendOrders = prompt(
						colors.bgYellow('Do you want to start ' + shareData.appData.name + ' (y/n) : ')
					);

					if (sendOrders.toUpperCase() == 'Y') {

						let configStart = JSON.parse(JSON.stringify(config));

						// Set pair
						configStart.pair = pair;

						start(configStart, true);
						return;
					}
*/
				}


				if (startBot) {

					const configSave = await removeConfigData(config);

					const dealId = pairSafe + '-' + Math.floor(Date.now() / 1000);

					dealIdMain = dealId;

					if (shareData.appData.verboseLog) { Common.logger(colors.green.bold('Please wait, ' + dealId + ' is starting... ')); }

					const deal = new Deals({
						botId: config.botId,
						botName: config.botName,
						dealId: dealId,
						exchange: config.exchange,
						pair: pair,
						date: Date.now(),
						status: 0,
						config: configSave,
						orders: orders,
						isStart: 0,
						active: true,
						dealCount: dealCount,
						dealMax: dealMax
					});

					await deal.save();

					dealTracker[dealId] = {};
					dealTracker[dealId]['deal'] = {};
					dealTracker[dealId]['info'] = {};

					dealTracker[dealId]['deal'] = JSON.parse(JSON.stringify(deal));

					sendTelegramStart(config.botName, dealId, pair);

					let followSuccess = false;
					let followFinished = false;

					while (!followSuccess && !followFinished) {

						let followRes = await dcaFollow(config, exchange, dealId);

						followSuccess = followRes['success'];
						followFinished = followRes['finished'];

						if (!followSuccess) {

							await Common.delay(1000);
						}
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

				//first order limit

				if (shareData.appData.verboseLog) { Common.logger(colors.bgGreen('Calculating orders...')); }

				//await Common.delay(1000);

				//askPrice = config.firstOrderLimitPrice;

				let firstOrderSize = config.firstOrderAmount / askPrice;
				firstOrderSize = await filterAmount(exchange, pair, firstOrderSize);

				if (!firstOrderSize) {

					if (shareData.appData.verboseLog) { Common.logger(colors.bgRed('First order amount not valid.')); }

					return false;
				}
				else {

					totalOrderSize = firstOrderSize;
					totalAmount = config.firstOrderAmount;

					const price = await filterPrice(exchange, pair, askPrice);

					let amount = price * firstOrderSize;
					let exchangeFee = (amount / 100) * Number(config.exchangeFee);

					amount = await filterPrice(exchange, pair, (amount + exchangeFee));

					let targetPrice = Percentage.addPerc(
						price,
						config.dcaTakeProfitPercent
					);

					targetPrice = await filterPrice(exchange, pair, targetPrice);

					orders.push({
						orderNo: 1,
						price: price,
						average: price,
						target: targetPrice,
						qty: firstOrderSize,
						amount: amount,
						qtySum: firstOrderSize,
						sum: amount,
						type: 'LIMIT',
						filled: 0
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
						dcaOrderSize = await filterAmount(exchange, pair, dcaOrderSize);

						let dcaOrderAmount = dcaOrderSize * price;
						let exchangeFee = (dcaOrderAmount  / 100) * Number(config.exchangeFee);

						dcaOrderAmount = await filterPrice(exchange, pair, (dcaOrderAmount + exchangeFee));

						let dcaOrderSum = parseFloat(dcaOrderAmount) + parseFloat(lastDcaOrderAmount);
						dcaOrderSum = await filterPrice(exchange, pair, dcaOrderSum);

						const dcaOrderQtySum = parseFloat(dcaOrderSize) + parseFloat(firstOrderSize);

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

						let targetPrice = Percentage.addPerc(
							average,
							config.dcaTakeProfitPercent
						);

						targetPrice = await filterPrice(exchange, pair, targetPrice);

						orders.push({
							orderNo: i + 2,
							price: price,
							average: average,
							target: targetPrice,
							qty: dcaOrderSize,
							amount: dcaOrderAmount,
							qtySum: dcaOrderQtySum,
							sum: dcaOrderSum,
							type: 'MARKET',
							filled: 0
						});
					}
					else {

						let price = Percentage.subPerc(
							lastDcaOrderPrice,
							(config.dcaOrderStepPercent * config.dcaOrderStepPercentMultiplier));

						price = await filterPrice(exchange, pair, price);

						let dcaOrderSize = lastDcaOrderSize * config.dcaOrderSizeMultiplier;
						dcaOrderSize = await filterAmount(exchange, pair, dcaOrderSize);

						let amount = price * dcaOrderSize;
						let exchangeFee = (amount / 100) * Number(config.exchangeFee);

						amount = await filterPrice(exchange, pair, (amount + exchangeFee));

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

						let targetPrice = Percentage.addPerc(
							average,
							config.dcaTakeProfitPercent
						);

						targetPrice = await filterPrice(exchange, pair, targetPrice);

						orders.push({
							orderNo: i + 2,
							price: price,
							average: average,
							target: targetPrice,
							qty: dcaOrderSize,
							amount: amount,
							qtySum: dcaOrderQtySum,
							sum: dcaOrderSum,
							type: 'MARKET',
							filled: 0
						});
					}
				}

				orders.forEach(function (order) {
					t.cell('No', order.orderNo);
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

				const maxDeviation = await getDeviation(Number(orders[0].price), Number(orders[orders.length - 1].price));

				//console.log(t.toString());
				//Common.logger(t.toString());

				let wallet = 0;

				if (config.sandBox) {

					wallet = config.sandBoxWallet;
				}
				else {

					const balance = await getBalance(exchange, 'USDT');
					wallet = balance;
				}

				if (config.sandBox) {

					if (shareData.appData.verboseLog) { Common.logger( colors.bgRed.bold('WARNING: Your bot work on SANDBOX MODE !') ); }
				}
				else {

					if (shareData.appData.verboseLog) { Common.logger( colors.bgGreen.bold('WARNING: Your bot work on LIVE MODE !') ); }
				}

				if (shareData.appData.verboseLog) {
				
					Common.logger(colors.bgWhite('Your Balance: $' + wallet));
					Common.logger(colors.bgWhite('Max Funds: $' + lastDcaOrderSum));
				}

				if (wallet < lastDcaOrderSum) {

					if (shareData.appData.verboseLog) { Common.logger( colors.red.bold.italic(insufficientFundsMsg) ); }
				}

				let sendOrders;

				if (startBot == undefined || startBot == null || startBot == false) {

					let contentAdd = await ordersAddContent(wallet, lastDcaOrderSum, maxDeviation);

					let ordersTable = await ordersToData(t.toString());

					return ({
								'success': true,
								'data': {
											'pair': pair,
											'orders': ordersTable,
											'content': contentAdd
										}
							});

/*
					sendOrders = prompt(
						colors.bgYellow('Do you want to start ' + shareData.appData.name + ' (y/n) : ')
					);

					if (sendOrders.toUpperCase() == 'Y') {

						let configStart = JSON.parse(JSON.stringify(config));

						// Set pair
						configStart.pair = pair;

						start(configStart, true);
						return;
					}
*/
				}


				if (startBot) {

					const configSave = await removeConfigData(config);

					const dealId = pairSafe + '-' + Math.floor(Date.now() / 1000);

					dealIdMain = dealId;

					if (shareData.appData.verboseLog) { Common.logger(colors.green.bold('Please wait, ' + dealId + ' is starting... ')); }

					const deal = new Deals({
						botId: config.botId,
						botName: config.botName,
						dealId: dealId,
						exchange: config.exchange,
						pair: pair,
						date: Date.now(),
						status: 0,
						config: configSave,
						orders: orders,
						isStart: 0,
						active: true,
						dealCount: dealCount,
						dealMax: dealMax
					});

					await deal.save();

					dealTracker[dealId] = {};
					dealTracker[dealId]['deal'] = {};
					dealTracker[dealId]['info'] = {};

					dealTracker[dealId]['deal'] = JSON.parse(JSON.stringify(deal));

					let followSuccess = false;
					let followFinished = false;

					while (!followSuccess && !followFinished) {

						let followRes = await dcaFollow(config, exchange, dealId);

						followSuccess = followRes['success'];
						followFinished = followRes['finished'];

						if (!followSuccess) {

							await Common.delay(1000);
						}
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
		}
	}
	catch (e) {

		Common.logger(e);
		//console.log(e);
	}


	// Refresh bot config in case any settings changed

	try {

		const bot = await Bots.findOne({
			botId: botIdMain
		});

		if (bot) {

			botFoundDb = true;

			let botPairsDb = bot['config']['pair'];

			// Make sure pair was not removed from bot configuration
			for (let pairDb of botPairsDb) {

				if (pair.toUpperCase() == pairDb.toUpperCase()) {

					pairFoundDb = true;
				}
 			}
 
			if (!bot['active'] || !pairFoundDb) {

				botActive = false;
			}
			else {

				botConfigDb = bot['config'];
				dealMax = botConfigDb['dealMax'];
			}
		}
	}
	catch(e) {

	}

	if (dealCount >= dealMax && dealMax > 0) {

		// Deactivate bot
		const data = await shareData.DCABot.update(botIdMain, { 'active': false });

		if (shareData.appData.verboseLog) {
			
			Common.logger( colors.bgYellow.bold(config.botName + ': Max deal count reached. Bot will not start another deal.') );
		}
	}

	// Start another bot deal if max deals have not been reached
	if (botFoundDb && botActive && (dealCount < dealMax || dealMax == 0)) {

		let configObj = JSON.parse(JSON.stringify(config));

		// Be sure bot id is set on config reload and increment deal count
		configObj['dealCount']++;

		botConfigDb['botId'] = botIdMain;
		botConfigDb['pair'] = pair; // Set single pair
		botConfigDb['dealCount'] = configObj['dealCount'];

		if (shareData.appData.verboseLog) {

			Common.logger(colors.bgGreen('Starting new bot deal for ' + pair.toUpperCase() + ' ' + botConfigDb['dealCount'] + ' / ' + botConfigDb['dealMax']));
		}

		start(botConfigDb, true, true);
	}
}


const dcaFollow = async (configData, exchange, dealId) => {

	if (shareData.appData.sig_int) {

		Common.logger(colors.red.bold(shareData.appData.name + ' is terminating. Not processing deal ' + dealId));

		return ( { 'success': false, 'finished': false } );
	}

	const config = Object.freeze(JSON.parse(JSON.stringify(configData)));

	let success = true;
	let finished = false;

	try {

		const deal = await Deals.findOne({
			dealId: dealId,
			status: 0
		});

		if (deal) {

			const pair = deal.pair;
			const symbolData = await getSymbol(exchange, pair);
			const symbol = symbolData.info;

			// Error getting symbol data
			if (symbolData.error != undefined && symbolData.error != null) {

				success = false;

				if (Object.keys(dealTracker).length == 0) {

					//process.exit(0);
				}

				return false;
			}

			let bidPrice = symbol.bidPrice;

			if (symbol.bidPrice == undefined || symbol.bidPrice == null) {

				bidPrice = symbol.bid;
			}

			//const price = parseFloat(symbol.bidPrice);
			const price = parseFloat(bidPrice);

			const t = new Table();
			let targetPrice = 0;

			let orders = deal.orders;

			if (deal.isStart == 0) {

				const baseOrder = deal.orders[0];
				targetPrice = baseOrder.target;

				if (baseOrder.type == 'MARKET') {
					//Send market order to exchange

					if (!config.sandBox) {

						const buy = await buyOrder(exchange, pair, baseOrder.qty);

						if (!buy) {

							Commong.logger(buy);
						}
					}

					orders[0].filled = 1;

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

					orders.forEach(function (order) {
						t.cell('No', order.orderNo);
						t.cell('Price', '$' + order.price);
						t.cell('Average', '$' + order.average);
						t.cell('Target', '$' + order.target);
						t.cell('Qty', order.qty);
						t.cell('Amount($)', '$' + order.amount);
						t.cell('Sum(Qty)', order.qtySum);
						t.cell('Sum($)', '$' + order.sum);
						t.cell('Type', order.type);
						t.cell(
							'Filled',
							order.filled == 0 ? 'Waiting' : colors.bgGreen('Filled')
						);
						t.newRow();
					});

					//console.log(t.toString());
					//Common.logger(t.toString());

					await Deals.updateOne({
						dealId: dealId
					}, {
						isStart: 1,
						orders: orders
					});
				}
				else {
					//send limit order

					if (price <= baseOrder.price) {

						if (!config.sandBox) {

							const buy = await buyOrder(exchange, pair, baseOrder.qty);

							if (!buy) {

								Common.logger(buy);
							}
						}

						orders[0].filled = 1;

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

						orders.forEach(function (order) {
							t.cell('No', order.orderNo);
							t.cell('Price', '$' + order.price);
							t.cell('Average', '$' + order.average);
							t.cell('Target', '$' + order.target);
							t.cell('Qty', order.qty);
							t.cell('Amount($)', '$' + order.amount);
							t.cell('Sum(Qty)', order.qtySum);
							t.cell('Sum($)', '$' + order.sum);
							t.cell('Type', order.type);
							t.cell(
								'Filled',
								order.filled == 0 ? 'Waiting' : colors.bgGreen('Filled')
							);
							t.newRow();
						});

						//console.log(t.toString());
						//Common.logger(t.toString());

						await Deals.updateOne({
							dealId: dealId
						}, {
							isStart: 1,
							orders: orders
						});
					}
					else {

						if (shareData.appData.verboseLog) {
						
							Common.logger(
								'DCA BOT will start when price react ' +
								baseOrder.price +
								', now price is ' +
								price +
								''
							);
						}

						await Common.delay(1000);
						
						let followSuccess = false;
						let followFinished = false;

						while (!followSuccess && !followFinished) {

							let followRes = await dcaFollow(config, exchange, dealId);

							followSuccess = followRes['success'];
							followFinished = followRes['finished'];

							if (!followSuccess) {

								await Common.delay(1000);
							}
						}
					}
				}
			}
			else {

				const filledOrders = deal.orders.filter(item => item.filled == 1);
				const currentOrder = filledOrders.pop();

				let profit = await Percentage.subNumsAsPerc(
					price,
					currentOrder.average
				);

				profit = Number(profit).toFixed(2);
				let profitPerc = profit;

				profit =
					profit > 0 ?
					colors.green.bold(profit + '%') :
					colors.red.bold(profit + '%');

				let count = 0;
				let maxSafetyOrdersUsed = false;
				let ordersFilledTotal = filledOrders.length;

				if (ordersFilledTotal >= (orders.length - 1)) {

					maxSafetyOrdersUsed = true;
				}

				for (let i = 0; i < orders.length; i++) {

					const order = orders[i];

					// Check if max safety orders used, othersie sell order condition will not be checked
					if (order.filled == 0 || maxSafetyOrdersUsed) {
					//if (order.filled == 0) {

						if (price <= parseFloat(order.price) && order.filled == 0) {
							//Buy DCA

							if (!config.sandBox) {

								const buy = await buyOrder(exchange, pair, order.qty);

								if (!buy) {

									Common.logger(buy);
								}
							}

							updateTracker(config.botName, config.botId, dealId, currentOrder.sum, price, currentOrder.average, currentOrder.target, profitPerc, ordersFilledTotal, orders.length, config.dealCount, config.dealMax);

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

							orders[i].filled = 1;

							await Deals.updateOne({
								dealId: dealId
							}, {
								orders: orders
							});
						}
						else if (price >= parseFloat(currentOrder.target)) {

							//Sell order

							if (deal.isStart == 1) {

								let sellSuccess = true;

								if (!config.sandBox) {

									const sell = await sellOrder(exchange, pair, order.qtySum);

									if (!sell) {

										sellSuccess = false;

										Common.logger(sell);
									}
								}

								if (sellSuccess) {

									updateTracker(config.botName, config.botId, dealId, currentOrder.sum, price, currentOrder.average, currentOrder.target, profitPerc, ordersFilledTotal, orders.length, config.dealCount, config.dealMax);

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
														'qtySum': currentOrder.qtySum,
														'price': price,
														'average': currentOrder.average,
														'target': currentOrder.target,
														'profit': profitPerc
													 };

									await Deals.updateOne({
										dealId: dealId
									}, {
										sellData: sellData,
										status: 1
									});

									finished = true;
									delete dealTracker[dealId];

									if (shareData.appData.verboseLog) { Common.logger(colors.bgRed('Deal ID ' + dealId + ' DCA Bot Finished.')); }

									sendTelegramFinish(config.botName, dealId, pair, sellData);
								}

								success = true;

								return ( { 'success': success, 'finished': finished } );
							}
						}
						else {

							updateTracker(config.botName, config.botId, dealId, currentOrder.sum, price, currentOrder.average, currentOrder.target, profitPerc, ordersFilledTotal, orders.length, config.dealCount, config.dealMax);

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

						await Common.delay(2000);
						count++;

						break;
					}
				}

				//if (ordersFilledTotal >= config.dcaMaxOrder) {
				if (maxSafetyOrdersUsed) {

					if (shareData.appData.verboseLog) { Common.logger( colors.bgYellow.bold(pair + ' Max safety orders used.') + '\tLast Price: $' + price + '\tTarget: $' + currentOrder.target + '\tProfit: ' + profit); }
					
					//await Common.delay(2000);
				}

			}

			let followSuccess = false;
			let followFinished = false;

			while (!followSuccess && !followFinished) {

				let followRes = await dcaFollow(config, exchange, dealId);

				followSuccess = followRes['success'];
				followFinished = followRes['finished'];

				if (!followSuccess) {

					await Common.delay(1000);
				}
			}
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
		errMsg = 'Unable to get symbols: ' + JSON.stringify(e);

		Common.logger(colors.bgRed.bold.italic(errMsg));
	}

	return ( { 'date': new Date(), 'success': success, 'symbols': symbols, 'msg': errMsg } );
}


const getSymbol = async (exchange, pair) => {

	let symbolInfo;
	let symbolError;

	let symbolInvalid = false;

	try {

		const symbol = await exchange.fetchTicker(pair);
		symbolInfo = symbol.info;
	}
	catch (e) {

		symbolError = e;

		if (e instanceof ccxt.BadSymbol) {

			symbolInvalid = true;
		}

		Common.logger(colors.bgRed.bold.italic('Get symbol ' + pair + ' error: ' + JSON.stringify(e)));
	}

	return ( { 'info': symbolInfo, 'invalid': symbolInvalid, 'error': symbolError } );
};


const filterAmount = async (exchange, pair, amount) => {

	try {

		return exchange.amountToPrecision(pair, amount);
	}
	catch (e) {

		Common.logger(JSON.stringify(e));

		return false;
	}
};


const filterPrice = async (exchange, pair, price) => {

	try {

		return exchange.priceToPrecision(pair, price);
	}
	catch (e) {

		Common.logger(JSON.stringify(e));

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


const getDeals = async (query) => {

	if (query == undefined || query == null) {

		query = {};
	}


	try {

		const deals = await Deals.find(query);

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

	try {

		let balance = await exchange.fetchBalance();
		balance = balance[symbol].free;

		return parseFloat(balance);
	}
	catch (e) {

		Common.logger(JSON.stringify(e));

		return false;
	}
};


const buyOrder = async (exchange, pair, qty) => {

	try {

		const order = await exchange.createMarketBuyOrder(pair, qty, null);
		return true;
	}
	catch (e) {

		Common.logger(JSON.stringify(e));

		return 'Error : ' + e.message;
	}
};


const sellOrder = async (exchange, pair, qty) => {

	try {

		const order = await exchange.createMarketSellOrder(pair, qty, null);
		return true;
	}
	catch (e) {

		Common.logger(JSON.stringify(e));

		return 'Error : ' + e.message;
	}
};


const getDeviation = async (a, b) => {

	return (Math.abs( (a - b) / ( (a + b) / 2 ) ) * 100);
}


async function connectExchange(configObj) {

	const config = JSON.parse(JSON.stringify(configObj));

	let exchange;

	try {

		exchange = new ccxt.pro[config.exchange]({

			'apiKey': config.apiKey,
			'secret': config.apiSecret,
			'passphrase': config.apiPassphrase,
			'password': config.apiPassword,			
		});
	}
	catch(e) {

		let msg = 'Connect exchange error: ' + e;

		Common.logger(msg);

		shareData.Telegram.sendMessage(shareData.appData.telegram_id, msg);
	}

	return exchange;
}


async function update(botId, data) {

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


async function checkTracker() {

	// Monitor existing deals if they weren't updated after n minutes to take potential action
	const maxMins = 3;

	for (let dealId in dealTracker) {

		let deal = dealTracker[dealId]['info'];

		let diffSec = (new Date().getTime() - new Date(deal['updated']).getTime()) / 1000;

		if (diffSec > (60 * maxMins)) {

			diffSec = (diffSec / 60).toFixed(2);

			let msg = 'WARNING: ' + dealId + ' exceeds last updated time by ' + diffSec + ' minutes';

			Common.logger(msg);

			shareData.Telegram.sendMessage(shareData.appData.telegram_id, msg);
		}
	}
}


async function updateTracker(botName, botId, dealId, orderSum, priceLast, priceAverage, priceTarget, takeProfitPerc, ordersUsed, ordersMax, dealCount, dealMax) {

	const dealObj = {
						'updated': new Date(),
						'bot_id': botId,
						'bot_name': botName,
						'safety_orders_used': ordersUsed,
						'safety_orders_max': ordersMax - 1,
						'price_last': priceLast,
						'price_average': priceAverage,
						'price_target': priceTarget,
						'take_profit': Number((Number(orderSum) * (Number(takeProfitPerc) / 100)).toFixed(2)),
						'take_profit_percentage': takeProfitPerc,
						'deal_count': dealCount,
						'deal_max': dealMax
					};

	dealTracker[dealId]['info'] = dealObj;
}


async function initBot(startBot, config) {

	let configObj = JSON.parse(JSON.stringify(config));
	let configSave = await removeConfigData(JSON.parse(JSON.stringify(config)));

	configObj = await setConfigData(configObj);

	if (startBot) {

		try {

			const bot = await Bots.findOne({
		
				botId: configObj.botId,
			});

			if (!bot) {

				let active = true;
				
				if (typeof configObj.active == 'boolean') {

					active = configObj.active;
				}

				delete configSave['active'];

				const bot = new Bots({
										'botId': configObj.botId,
										'botName': configObj.botName,
										'config': configSave,
										'active': active,
										'date': Date.now(),
									});

				await bot.save();
			}
		}
		catch (e) {

			//console.log(e);
		}
	}

	return configObj;
}


async function setConfigData(config) {

	let configObj = JSON.parse(JSON.stringify(config));

	const botConfig = await shareData.Common.getConfig('bot.json');

	for (let key in botConfig.data) {

		if (key.substring(0, 3).toLowerCase() == 'api') {

			configObj[key] = botConfig.data[key];
		}
	}

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


async function getDealsHistory() {

	let dealsArr = [];

	const dealsHistory = await getDeals({ 'sellData': { $exists: true }, 'status': 1 });

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

	dealsArr = Common.sortByKey(dealsArr, 'date_end');

	return dealsArr.reverse();
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


async function ordersAddContent(wallet, lastDcaOrderSum, maxDeviation) {

	let obj = {
				'balance': Number(wallet),
				'max_funds': Number(lastDcaOrderSum),
				'max_deviation_percent': Number(maxDeviation.toFixed(2))
			  };

	return obj;
}


async function sendTelegramStart(botName, dealId, pair) {

	let msg = botName + ': Starting new deal. Pair: ' + pair.toUpperCase();

	shareData.Telegram.sendMessage(shareData.appData.telegram_id, msg);
}


async function sendTelegramFinish(botName, dealId, pair, sellData) {

	let orderCount = 0;

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

	const profit = Number((Number(orders[orderCount - 1]['sum']) * (profitPerc / 100)).toFixed(2));
	const duration = shareData.Common.timeDiff(new Date(), new Date(deal['date']));

	let msg = botName + ' (' + pair.toUpperCase() + '): ' + dealId + ': Deal completed.';
	msg += ' Profit: $' + profit + ' (' + profitPerc + '% from total volume)';
	msg += ' #profit ' + duration;

	shareData.Telegram.sendMessage(shareData.appData.telegram_id, msg);
}


async function volumeValid(startBot, pair, symbol, config) {

	let success = true;

	const volumeMin = Number(config.volumeMin);

	const volume24h = Number(((symbol.price * symbol.volume) / 1000000).toFixed(2));

	const timerKey = config.botId + pair;

	if (startBot && volumeMin > 0 && volume24h < volumeMin) {

		if (shareData.appData.verboseLog) { Common.logger( colors.bgCyan.bold('Delaying deal start. ' + pair + ' 24h volume: ' + volume24h + 'M. Minimum required: ' + volumeMin + 'M') ); }

		const configObj = JSON.parse(JSON.stringify(config));

		// Clear previous timeout if exists so additional starts don't occur
		if (timerTracker[timerKey] != undefined && timerTracker[timerKey] != null) {

			clearTimeout(timerTracker[timerKey]);
		}

		timerTracker[timerKey] = setTimeout(() => {
														startVerify(configObj, true, true);

												  }, (60000 * 3));

		success = false;
	}

	return success;
}


async function startVerify(config) {

	// Verify bot is still enabled / active

	const pair = config.pair;		
	const botId = config.botId;

	if (botId != undefined && botId != null && botId != '') {

		const bot = await shareData.DCABot.getBots({ 'botId': botId });

		if (bot && bot.length > 0) {

			if (bot[0].active) {

				// Reload bot config from db in case any changes were made

				let botConfigDb = bot[0].config;

				botConfigDb['botId'] = botId;
				botConfigDb['pair'] = pair;
				botConfigDb['dealCount'] = config['dealCount'];

				start(botConfigDb, true, true);
			}
		}
	}
}


async function resumeBots() {

	// Check for active deals and resume bots
	// New logic needed to find bots that have not reached max deals and are currently not running an active deal

	const dealsActive = await getDeals({ 'status': 0 });

	if (dealsActive.length > 0) {

		Common.logger( colors.bgGreen.bold('Resuming ' + dealsActive.length + ' active DCA bot deals...') );

		for (let i = 0; i < dealsActive.length; i++) {

			let deal = dealsActive[i];

			const botId = deal.botId;
			const botName = deal.botName;
			const dealId = deal.dealId;
			const pair = deal.pair;
			const dealCount = deal.dealCount;
			const dealMax = deal.dealMax;

			// Set previous deal counts
			let config = deal.config;

			config['botId'] = botId;
			config['botName'] = botName;
			config['dealCount'] = dealCount;
			config['dealMax'] = dealMax;
			config['dealResume'] = true;

			deal['config'] = config;

			dealTracker[dealId] = {};
			dealTracker[dealId]['info'] = {};

			dealTracker[dealId]['deal'] = JSON.parse(JSON.stringify(deal));

			start(config, true, true);

			await Common.delay(1000);
		}
	}
}


async function initApp() {

	setInterval(() => {

		checkTracker();

	}, (60000 * 1));

	resumeBots();
}


module.exports = {

	colors,
	start,
	update,
	connectExchange,
	removeConfigData,
	initBot,
	getBots,
	getDeals,
	getDealsHistory,
	getSymbolsAll,

	init: function(obj) {

		shareData = obj;

		shareData['dealTracker'] = dealTracker;

		initApp();
    }
}
