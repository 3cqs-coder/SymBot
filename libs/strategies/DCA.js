'use strict';

const fs = require('fs');
const path = require('path');
const pathRoot = path.dirname(fs.realpathSync(__dirname));

const colors = require('colors');
const delay = require('delay');
const ccxt = require('ccxt');
const Table = require('easy-table');
const Percentage = require('percentagejs');
const Common = require(pathRoot + '/Common.js');
const Deals = require(pathRoot + '/mongodb/deals');

const prompt = require('prompt-sync')({
	sigint: true
});


let shareData;



async function startBot(data, start, reload) {

	const config = Object.freeze(JSON.parse(JSON.stringify(data)));

	const exchange = new ccxt.pro[config.exchange]({

		apiKey: config.apiKey,
		secret: config.apiSecret
	});

	let totalOrderSize = 0;
	let totalAmount = 0;

	let pair = '';
	let pairConfig = config.pair;

	try {

		//Load markets
		//const markets = await exchange.loadMarkets();

		if (pairConfig == undefined || pairConfig == null || pairConfig == '') {

			pair = prompt(colors.bgGreen('Please enter pair (BASE/QUOTE): '));
		}
		else {

			pair = pairConfig;
		}

		pair = pair.toUpperCase();

		if (!reload) {

			Common.logger(colors.green('Getting pair information for ' + pair + '...'));
		}

		const isActive = await checkActiveDeal(pair);
		const symbol = await getSymbol(exchange, pair);

		let askPrice = symbol.askPrice;

		if (symbol.askPrice == undefined || symbol.askPrice == null) {

			askPrice = symbol.ask;
		}

		//await delay(1000);

		var t = new Table();
		const orders = [];

		if (isActive) {

			if (!reload) {

				// Active deal found so get original config from db and restart bot

				Common.logger(
					colors.bgCyan.bold('Found active DCA deal for ' + pair + '...')
				);

				startBot(isActive.config, true, true);
				return;
			}
			else {

				// Config reloaded from db so bot and continue
				//await delay(1000);

				await dcaFollow(config, exchange, isActive.dealId);
			}
		}
		else {

			let lastDcaOrderAmount = 0;
			let lastDcaOrderSize = 0;
			let lastDcaOrderSum = 0;
			let lastDcaOrderQtySum = 0;
			let lastDcaOrderPrice = 0;

			if (config.firstOrderType.toUpperCase() == 'MARKET') {

				//first order market
				Common.logger(colors.bgGreen('Calculating orders for ' + pair + '...'));
				await delay(1000);

				let firstOrderSize = config.firstOrderAmount / askPrice;
				firstOrderSize = await filterAmount(exchange, pair, firstOrderSize);

				if (!firstOrderSize) {

					Common.logger(colors.bgRed('First order amount not valid.'));
					return false;
				}
				else {

					totalOrderSize = firstOrderSize;
					totalAmount = config.firstOrderAmount;

					const price = await filterPrice(exchange, pair, askPrice);

					let amount = price * firstOrderSize;
					amount = await filterPrice(exchange, pair, amount);

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
						dcaOrderAmount = await filterPrice(exchange, pair, dcaOrderAmount);

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

						let dcaOrderSize = lastDcaOrderSize * config.dcaOrderSizeMultiplier;
						dcaOrderSize = await filterAmount(exchange, pair, dcaOrderSize);

						let amount = price * dcaOrderSize;
						amount = await filterPrice(exchange, pair, amount);

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

				console.log(t.toString());
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

					Common.logger(
						colors.bgYellow.bold('WARNING: Your bot will run in SANDBOX MODE!')
					);
				}
				else {

					Common.logger(
						colors.bgRed.bold('WARNING: Your bot will run in LIVE MODE!')
					);
				}

				Common.logger(colors.bgWhite('Your Balance: $' + wallet));

				Common.logger(colors.bgWhite('Max Funds: $' + lastDcaOrderSum));
				//console.log('\n');

				if (wallet < lastDcaOrderSum) {

					Common.logger(
						colors.red.bold.italic(
							'Your wallet does not have enough for all DCA orders !'
						)
					);
				}

				//console.log('\n');
				let sendOrders;

				if (start == undefined || start == null || start == false) {

					sendOrders = prompt(
						colors.bgYellow('Do you want to start ' + shareData.appData.name + ' (y/n) : ')
					);

					if (sendOrders.toUpperCase() == 'Y') {

						let configStart = JSON.parse(JSON.stringify(config));

						// Set pair
						configStart.pair = pair;

						startBot(configStart, true);
						return;
					}
				}


				if (start) {

					Common.logger(colors.green.bold('Please wait, ' + shareData.appData.name + ' is starting... '));

					const dealId = pair + '-' + Math.floor(Date.now() / 1000);

					const deal = new Deals({
						dealId: dealId,
						exchange: config.exchange,
						pair: pair,
						date: Date.now(),
						status: 0,
						config: config,
						orders: orders,
						isStart: 0
					});

					await deal.save();

					Common.logger(colors.bgGreen.bold(shareData.appData.name + ' is running... '));

					await dcaFollow(config, exchange, dealId);
				}
				else {

					Common.logger(colors.bgRed.bold(shareData.appData.name + ' is stopping... '));
					process.exit(0);
				}
			}
			else {

				//first order limit

				Common.logger(colors.bgGreen('Calculating orders...'));
				await delay(1000);

				askPrice = config.firstOrderLimitPrice;

				let firstOrderSize = config.firstOrderAmount / askPrice;
				firstOrderSize = await filterAmount(exchange, pair, firstOrderSize);

				if (!firstOrderSize) {

					Common.logger(colors.bgRed('First order amount not valid.'));
					return false;
				}
				else {

					totalOrderSize = firstOrderSize;
					totalAmount = config.firstOrderAmount;

					const price = await filterPrice(exchange, pair, askPrice);

					let amount = price * firstOrderSize;
					amount = await filterPrice(exchange, pair, amount);

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
						dcaOrderAmount = await filterPrice(exchange, pair, dcaOrderAmount);

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
						amount = await filterPrice(exchange, pair, amount);

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

				console.log(t.toString());
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

					Common.logger(
						colors.bgRed.bold('WARNING: Your bot work on SANDBOX MODE !')
					);
				}
				else {

					Common.logger(
						colors.bgGreen.bold('WARNING: Your bot work on LIVE MODE !')
					);
				}

				Common.logger(colors.bgWhite('Your Balance: $' + wallet));

				Common.logger(colors.bgWhite('Max Funds: $' + lastDcaOrderSum));
				//console.log('\n');

				if (wallet < lastDcaOrderSum) {

					Common.logger(
						colors.red.bold.italic(
							'Your wallet does not have enough for all DCA orders !'
						)
					);
				}

				//console.log('\n');

				const sendOrders = prompt(
					colors.bgYellow('Do you want to start ' + shareData.appData.name + ' (y/n) : ')
				);

				if (sendOrders == 'y') {

					Common.logger(colors.green.bold('Please wait, ' + shareData.appData.name + ' is starting... '));

					const dealId = pair + '-' + Math.floor(Date.now() / 1000);

					const deal = new Deals({
						dealId: dealId,
						exchange: config.exchange,
						pair: pair,
						date: Date.now(),
						status: 0,
						config: config,
						orders: orders,
						isStart: 0
					});

					await deal.save();

					Common.logger(colors.bgGreen.bold(shareData.appData.name + ' is running... '));

					await dcaFollow(config, exchange, dealId);
				}
				else {

					Common.logger(colors.bgRed.bold(shareData.appData.name + ' is stopping... '));

					process.exit(0);
				}
			}
		}
	}
	catch (e) {

		Common.logger(e);
		//console.log(e);
	}
}


const dcaFollow = async (configData, exchange, dealId) => {

	const config = Object.freeze(JSON.parse(JSON.stringify(configData)));

	try {

		const deal = await Deals.findOne({
			dealId: dealId,
			status: 0
		});

		if (deal) {

			const pair = deal.pair;
			const symbol = await getSymbol(exchange, pair);

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
							console.error(buy);
						}
					}

					orders[0].filled = 1;

					Common.logger(
						colors.green.bold.italic(
							'Pair:' +
							pair +
							'\tQty:' +
							baseOrder.qty +
							'\tPrice:' +
							baseOrder.price +
							'\tAmount:' +
							baseOrder.amount +
							'\tStatus:Filled'
						)
					);

					//console.log('\n');

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

					console.log(t.toString());
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
								console.error(buy);
							}
						}

						orders[0].filled = 1;

						Common.logger(
							colors.green.bold.italic(
								'Pair:' +
								pair +
								'\tQty:' +
								baseOrder.qty +
								'\tPrice:' +
								baseOrder.price +
								'\tAmount:' +
								baseOrder.amount +
								'\tStatus:Filled'
							)
						);

						//console.log('\n');

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

						console.log(t.toString());
						//Common.logger(t.toString());

						await Deals.updateOne({
							dealId: dealId
						}, {
							isStart: 1,
							orders: orders
						});
					}
					else {

						Common.logger(
							'DCA BOT will start when price react ' +
							baseOrder.price +
							', now price is ' +
							price +
							''
						);

						await delay(1000);
						await dcaFollow(config, exchange, dealId);
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
									console.error(buy);
								}
							}

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
									'\tStatus:' +
									colors.green('BUY') +
									'' +
									'\tProfit: ' +
									profit +
									''
								)
							);

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

								if (!config.sandBox) {

									const sell = await sellOrder(exchange, pair, order.qtySum);

									if (!sell) {
										console.error(sell);
									}
								}

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

								await Deals.updateOne({
									dealId: dealId
								}, {
									status: 1
								});

								Common.logger(colors.bgRed('DCA Bot Finished.'));
								process.exit(0);
							}
						}
						else {

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

						await delay(2000);
						count++;

						break;
					}
				}

				//if (ordersFilledTotal >= config.dcaMaxOrder) {
				if (maxSafetyOrdersUsed) {

					Common.logger(
						colors.bgYellow.bold(pair + ' Max safety orders used.') + '\tLast Price: $' + price + '\tTarget: $' + currentOrder.target + '\tProfit: ' + profit
					);
					
					//await delay(2000);
				}

			}

			await dcaFollow(config, exchange, dealId);
		}
		else {

			Common.logger('No Deal ID Found');
		}
	}
	catch (e) {

		Common.logger(JSON.stringify(e));
	}
};


const getSymbol = async (exchange, pair) => {

	try {

		const symbol = await exchange.fetchTicker(pair);
		return symbol.info;
	}
	catch (e) {

		//console.log(e)
		Common.logger(colors.bgRed.bold.italic(pair + ' is not a valid pair.'));
		process.exit(0);
	}
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


const checkActiveDeal = async (pair) => {

	try {

		const deal = await Deals.findOne({
			pair: pair,
			status: 0
		});

		return deal;
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



module.exports = {

	colors,
	delay,
	startBot,

	init: function(obj) {

		shareData = obj;
    }
}
