'use strict';

const fs = require('fs');
const path = require('path');

const pathRoot = path.resolve(__dirname, ...Array(3).fill('..'));

const crypto = require('crypto');
const colors = require('colors');
const ccxt = require('ccxt');
const Table = require('easy-table');
const Percentage = require('percentagejs');
const Common = require(pathRoot + '/libs/app/Common.js');
const AddFundsMath = require(pathRoot + '/libs/app/AddFundsMath.js');
const portfolioGuard = require(pathRoot + '/libs/strategies/DCABot/portfolioGuard.js');
const Schema = require(pathRoot + '/libs/mongodb/DCABotSchema');
const DbQueries = require(__dirname + '/DCABotDbQueries.js');
const PriceGuard = require(__dirname + '/priceGuard.js');
const StopLoss = require(__dirname + '/stopLoss.js');

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

// Minimum shortfall percentage of requested sell quantity that triggers a partial fill retry
// Shortfalls below this threshold are treated as dust and no retry is attempted
const partialSellFillThresholdPercent = 1;

// Maximum number of additional sell attempts when a partial fill is detected
const maxPartialSellRetries = 10;

// Delay in milliseconds between partial fill retry attempts
const partialSellRetryDelayMs = 3000;


// Shortfall of a fill versus the requested quantity, as a percent. Single source of truth for the
// "how complete is this fill?" question, shared by both the buy and sell partial-fill gates so the
// same threshold logic decides a genuine partial from an effectively-complete fill (e.g. an exchange
// that reports a 100%-executed IOC order with a "partially filled" status). A zero/undefined fill
// returns 0 — the caller treats "no reported fill" as its own case, never as a partial.
function partialFillShortfallPercent(filledQty, requestedQty) {

	const filled = Number(filledQty) || 0;
	const requested = Number(requestedQty) || 0;

	if (filled <= 0 || requested <= 0) { return 0; }

	return ((requested - filled) / requested) * 100;
}


// Shared partial-fill retry loop for BOTH buys and sells. After an order fills only part of the
// requested quantity, re-place the outstanding remainder until the fill is within threshold, the
// remainder falls below the exchange minimum, the retry cap is reached, or the deal is canceled /
// panic-sold. Everything that differs between a buy and a sell is injected, so the loop itself lives in
// ONE place: the price side (a buy lifts the ask, a sell hits the bid), the order placement (placeOrder),
// how each fill is booked (onFill), and an optional hook when an attempt fills nothing (onEmptyFill, e.g.
// an NSF settle-wait on the exchange-cancelled sell path). It is pure of ladder/credit/finalize logic —
// the caller does the pre-loop work (e.g. a settlement delay) and the post-loop work (credit or finalize)
// and books the exact quantity from the returned totals. Read-only of module state; never throws into the
// trading loop beyond what the injected callbacks/order calls already do.
async function retryPartialFill({
	side,                 // 'buy' | 'sell' — selects the retry price (ask for a buy, bid for a sell)
	exchange, pair, dealId,
	requestedQty,         // the full quantity the original order asked for
	initialFilledQty,     // what already filled before the retries (accumulated into the running total)
	fallbackPrice,        // price to use if the fresh ticker has no ask/bid
	placeOrder,           // async ({ qty, price }) => orderResult (buyOrder / sellOrder wrapper)
	onFill,               // async (filledQty, orderResult, priceFiltered) => void — side-specific bookkeeping
	onEmptyFill = null,   // async (orderResult) => void — optional, when an attempt fills nothing
	isAborted,            // () => boolean — cancel / panic requested (stops the loop)
	threshold = partialSellFillThresholdPercent,
	maxRetries = maxPartialSellRetries,
	delayMs = partialSellRetryDelayMs,
	logLabel = 'Partial fill',
	io = null             // test-only dependency injection; production always uses the real module I/O
}) {

	// Injected I/O for tests; defaults to the real module functions (no behavior change in production).
	const _io = io || { getSymbol, filterPrice, filterAmount, orderFilledQty, delay: Common.delay, log: (m) => Common.logger(m) };
	const _log = (m) => { try { _io.log(colors.bgYellow.bold(m)); } catch (e) { /* logging must never break the loop */ } };

	let totalFilled  = Number(initialFilledQty) || 0;
	let qtyRemaining = Number(requestedQty) - totalFilled;
	let retryCount   = 0;

	while (retryCount < maxRetries && qtyRemaining > 0) {

		if (typeof isAborted === 'function' && isAborted()) { break; }

		await _io.delay(delayMs);

		retryCount++;

		// Fresh price for this attempt — a BUY lifts the ask, a SELL hits the bid.
		const symbolDataRetry = await _io.getSymbol(exchange, pair);
		const symbolRetry     = symbolDataRetry.data;
		const priceRetry      = (side === 'buy' ? symbolRetry?.ask : symbolRetry?.bid) ?? fallbackPrice;
		const priceFiltered   = await _io.filterPrice(exchange, pair, priceRetry);

		// Remaining quantity must still meet the exchange minimum after the precision filter.
		const qtyRemainingFiltered = await _io.filterAmount(exchange, pair, qtyRemaining);

		if (!qtyRemainingFiltered || Number(qtyRemainingFiltered) <= 0) {

			_log(logLabel + ' retry halted for deal ID ' + dealId + ' — remaining ' + qtyRemaining + ' is below the exchange minimum. Accepting fill.');
			break;
		}

		_log(logLabel + ' retry ' + retryCount + '/' + maxRetries + ' for deal ID ' + dealId + ' — remaining ' + qtyRemainingFiltered);

		const orderResult    = await placeOrder({ qty: qtyRemainingFiltered, price: priceFiltered });
		const retryQtyFilled = _io.orderFilledQty(orderResult);

		if (retryQtyFilled > 0) {

			if (typeof onFill === 'function') { await onFill(retryQtyFilled, orderResult, priceFiltered); }

			totalFilled += retryQtyFilled;
			qtyRemaining = Number(requestedQty) - totalFilled;

			_log(logLabel + ' retry ' + retryCount + ' filled ' + retryQtyFilled + ' for deal ID ' + dealId + ' — total ' + totalFilled + ' / remaining ' + Math.max(qtyRemaining, 0));

			if ((Math.max(qtyRemaining, 0) / Number(requestedQty)) * 100 <= threshold) { break; }
		}
		else {

			_log(logLabel + ' retry ' + retryCount + ' filled nothing for deal ID ' + dealId + ': ' + (orderResult.message || 'no fill'));

			if (typeof onEmptyFill === 'function') { await onEmptyFill(orderResult); }
		}
	}

	return { totalFilled, qtyRemaining: Math.max(qtyRemaining, 0), retryCount };
}

// Tolerance (percent) by which an exchange-reported order cost may sit below
// price * quantity before it is treated as fee-inclusive rather than display
// rounding. Real taker fees are typically 0.1-1%, while rounding differences
// observed on live fills are under 0.2%, so 0.25% separates the two without
// discarding good data.
const costFeeTolerancePercent = 0.25;

// Throttle window for repeated "Connect exchange error" alerts, keyed by exchange. A persistent
// outage (or several bots hitting the same down exchange) would otherwise fire an identical alert on
// every reconnect attempt. This only rate-limits the NOTIFICATION — every failure is still logged, and
// nothing about the connect/return behavior changes.
const connectErrorNotifyWindowMs = 5 * 60 * 1000;
const connectErrorNotified = {};

// Throttle window for the repeated BALANCE ERROR *log* line, keyed by exchange + error name. A persistent
// exchange outage makes the balance fetch fail on every poll AND every deal-start funds check (several times
// a minute), so the same error would otherwise flood the log. Rate-limits ONLY the log line — getBalance's
// {success:false, error} return is unchanged, so the funds check and the bot-preview alert behave exactly as
// before.
const balanceErrorLogWindowMs = 60 * 1000;
const balanceErrorLogged = {};

// Reduce a ccxt/network error to a concise, single-line, bounded message, with the underlying cause code
// (ECONNREFUSED / ETIMEDOUT / ENETUNREACH …) appended when present. A ccxt error can carry the entire fetched
// response body (a failed /currencies or /accounts call is many KB of JSON), which floods the log and any UI
// alert — this keeps them readable. Shared by the connect path and the balance path so both summarize identically.
function summarizeExchangeError(err) {

	let text = (err && err.message) ? String(err.message) : String(err);
	text = text.split('\n')[0];
	if (text.length > 300) { text = text.slice(0, 300) + '…'; }

	// undici nests the real socket code one or more levels down (ccxt error → TypeError "fetch failed" → the
	// socket error), so walk the .cause chain and take the first code/errno found.
	let causeCode = null;
	for (let cur = err, depth = 0; cur && depth < 6; cur = cur.cause, depth++) {

		const c = cur.code || cur.errno;
		if (c) { causeCode = c; break; }
	}

	if (causeCode) { text += ' [' + String(causeCode).split('\n')[0].slice(0, 80) + ']'; }

	return text;
}


// Quote-currency symbol for a pair, e.g. 'BTC/USD' -> '$'. Falls back to an
// empty string when the pair is unusable so callers can concatenate safely.
// Centralized here because several log lines and messages previously hardcoded
// '$', which is wrong for any non-USD quote (EUR, GBP, BTC-quoted pairs, etc).
function quoteSymbol(pair) {

	const q = Common.quoteCurrency(pair);
	const quote = (q && q !== 'UNKNOWN') ? q : '';

	try {

		return (Common.getCurrencySymbol(quote) || '');
	}
	catch (e) {

		return ('');
	}
}


// Format a price with its quote-currency symbol: formatPrice('BTC/USD', 1.5) -> '$1.5'
function formatPrice(pair, value) {

	return (quoteSymbol(pair) + value);
}


// Standard price/status log line shared by the sell, follow and safety-order
// paths, which previously each built the same tab-separated string by hand with
// a hardcoded '$'. Only the fields that differ are passed in; any field left
// undefined is omitted so one helper covers all three call sites.
function formatDealStatusLine({ pair, qty, lastPrice, dcaPrice, sellPrice, target, nextOrder, status, profit }) {

	const parts = ['Pair: ' + pair];

	if (qty        !== undefined) parts.push('Qty: ' + qty);
	if (lastPrice  !== undefined) parts.push('Last Price: ' + formatPrice(pair, lastPrice));
	if (dcaPrice   !== undefined) parts.push('DCA Price: ' + formatPrice(pair, dcaPrice));
	if (sellPrice  !== undefined) parts.push('Sell Price: ' + formatPrice(pair, sellPrice));
	if (target     !== undefined) parts.push('Target: ' + formatPrice(pair, target));
	if (nextOrder  !== undefined) parts.push('Next Order: ' + formatPrice(pair, nextOrder));
	if (status     !== undefined) parts.push('Status: ' + status);
	if (profit     !== undefined) parts.push('Profit: ' + profit);

	return (parts.join('\t'));
}


// Quantity actually executed on an order response, or 0 when the exchange
// reported nothing usable. Centralizes the `data_order.quantity` read that the
// sell retry loops and the fill tracker both depend on.
function orderFilledQty(orderResponse) {

	const qty = Number(orderResponse?.['data_order']?.['quantity'] ?? 0);

	return (isFinite(qty) && qty > 0 ? qty : 0);
}


// ── Loop-flow signals ─────────────────────────────────────────────────────────
// dcaFollow (and the extracted handlers) return one of these to tell runFollowLoop
// what to do next. The consumer reads two fields: `finished` (true = stop the loop)
// and `success` (false = wait 1s before the next tick). Naming them removes the
// ambiguity that caused the base-order stall bug (returning finished:true exited the
// loop when the deal should have stayed alive). Four reachable states:
//
//   LOOP_CONTINUE : healthy tick — loop again immediately
//   LOOP_RETRY    : transient issue (paused, verifying, guard) — loop again after 1s
//   LOOP_DONE     : deal completed cleanly (sold out) — stop the loop
//   LOOP_STOPPED  : deal stopped without a clean completion (user stop) — stop after 1s
//
// Frozen so a shared reference can never be mutated by a consumer.
const LOOP_CONTINUE = Object.freeze({ 'success': true,  'finished': false });
const LOOP_RETRY    = Object.freeze({ 'success': false, 'finished': false });
const LOOP_DONE     = Object.freeze({ 'success': true,  'finished': true  });
const LOOP_STOPPED  = Object.freeze({ 'success': false, 'finished': true  });

// CONTINUE while also handing runFollowLoop a refreshed config to adopt for later ticks.
const loopContinueWithConfig = (config) => ({ 'success': true, 'finished': false, 'config': config });

// Maps a runtime (success, finished) pair to the matching named signal. Used at the few
// return points where both values are computed at runtime rather than known statically.
const loopSignal = (success, finished) => (
	finished ? (success ? LOOP_DONE : LOOP_STOPPED)
	         : (success ? LOOP_CONTINUE : LOOP_RETRY)
);



let dealTracker = {};
let timerTracker = {};
let startDealTracker = {};
let resumeDealTracker = {};
let balanceTracker = {};
let exchangeMarkets = {};

// Serial queue for all new deal starts — single entry point, single path.
// Ensures no two deal-creation attempts run concurrently regardless of
// whether the trigger is an API call, a signal, or an internal ASAP/cooldown.
let dealStartQueue = null;


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
	let checkActivePairOverride = false;
	let isNewDeal = false;

	let pair = '';
	let pairConfig = config.pair;
	let botIdMain = config.botId;
	let dealCount = config.dealCount;
	let dealMax = config.dealMax;
	let pairMax = config.pairMax;
	let pairDealsMax = config.pairDealsMax;
	let pairBotsDealsMax = config.pairBotsDealsMax;

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

	if (pairBotsDealsMax == undefined || pairBotsDealsMax == null) {

		pairBotsDealsMax = 0;
	}

	let exchange = await connectExchange(config);

	if (exchange == undefined || exchange == null) {

		return ( { 'success': false, 'data': 'Invalid exchange: ' + config.exchange } );
	}

	
	try {

		//Load markets
		//const markets = await exchange.loadMarkets();

		let isDealResumeId = false;

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

		// Check if this bot exceeds global pair limit
		let globalPairLimitExceeded = await checkGlobalPairLimit(pairBotsDealsMax, pair);

		if (dealResumeId != undefined && dealResumeId != null && dealResumeId != '') {

			isDealResumeId = true;
		}

		// Verify number of same pairs running on bot before start to allow override
		if (!globalPairLimitExceeded && pairDealsMax > 1 && pairDealsActive.length < pairDealsMax) {

			// Only override if not resuming deal
			if (!isDealResumeId) {

				checkActivePairOverride = true;
			}
		}

		// Check for valid symbol data on start
		if (symbolData.invalid && !isDealResumeId) {

			if (Object.keys(dealTracker).length == 0) {

				//process.exit(0);
			}

			return ( { 'success': false, 'data': 'Invalid Pair' } );
		}
		else if (symbolData.error != undefined && symbolData.error != null) {

			let resumeBypass = false;

			// Try again if resuming existing bot deal
			if (isDealResumeId) {

				let configObj = JSON.parse(JSON.stringify(config));

				const resumeTrackerData = await getResumeDealTracker(dealResumeId);

				if (resumeTrackerData && typeof resumeTrackerData === 'object') {

					const maxMins = 2;

					let diffSec = (new Date().getTime() - new Date(resumeTrackerData['date']).getTime()) / 1000;

					if (diffSec > (60 * maxMins)) {

						resumeBypass = true;
					}
				}

				if (!resumeBypass) {

					const retryDelay = Number((1000 + (Math.random() * 5000)).toFixed(4));

					// Reset dealResume flag
					configObj['dealResumeId'] = dealResumeId;

					const msg = 'Unable to resume ' + configObj.botName + ' / Pair: ' + pair + ' / Error: ' + symbolData.error + ' Trying again in ' + (retryDelay / 1000).toFixed(1) + ' seconds';

					if (shareData.appData.verboseLog) { Common.logger( colors.bgYellow.bold(msg) ); }

					setTimeout(() => {

						// Detached retry — guard the rejection so a transient failure logs instead of
						// surfacing as a process-level unhandled rejection; the resume retries next tick.
						Promise.resolve(start({ 'create': startBot, 'config': configObj })).catch((e) => { Common.logger('Deal resume retry failed: ' + (e && e.message ? e.message : e)); });

					}, retryDelay);
				}
				else {

					// Something is wrong trying to resume deal and get symbol data. Give up and allow user to cancel
					const msg = 'Unable to resume ' + configObj.botName + ' / Pair: ' + pair + ' / Error: ' + symbolData.error + ' Giving up.';

					if (shareData.appData.verboseLog) { Common.logger( colors.bgYellow.bold(msg)); }
				}
			}

			if (!resumeBypass) {

				return ( { 'success': false, 'data': JSON.stringify(symbolData.error) } );
			}
		}

		// Remove from resumeDealTracker
		await deleteResumeDealTracker(dealResumeId);

		let askPrice = symbol?.ask ?? 0;
		
		// Override price if passed in
		if (firstOrderPrice != undefined && firstOrderPrice != null && firstOrderPrice != 0) {

			askPrice = firstOrderPrice;
		}

		const orders = [];

		if (startBot && isActive && !checkActivePairOverride) {

			dealIdMain = isActive.dealId;

			if (isDealResumeId) {

				dealIdMain = dealResumeId;
			}

			await runFollowLoop(config, exchange, dealIdMain);
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
					'price': askPrice,
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

					const price = await filterPrice(exchange, pair, askPrice);

					let amount = price * firstOrderSize;

					const adjustments = await calculateAdjustments({

						'exchange': exchange,
						'pair': pair,
						'price': price,
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
							'price': price,
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

						const adjustments = await getAdjustedOrder(
							exchange, 
							pair, 
							price, 
							amount, 
							dcaOrderSize, 
							config.exchangeFee, 
							minMoveAmount
						);

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
					
					Common.logger(colors.bgWhite('Your Balance: ' + formatPrice(pair, wallet)));
					Common.logger(colors.bgWhite('Max Funds: ' + formatPrice(pair, lastDcaOrderSum)));
				}

				if (wallet < lastDcaOrderSum) {

					if (shareData.appData.verboseLog) { Common.logger( colors.red.bold.italic(insufficientFundsMsg)); }
				}

				let sendOrders;

				if (startBot == undefined || startBot == null || startBot == false) {

					let contentAdd = await ordersAddContent(wallet, lastDcaOrderSum, maxDeviation, balanceObj);

					// Use structured data directly — no text parsing needed
					const ordersTable = await ordersToStructuredData(orderData['structured']);

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

					// Commit point — deal is now in the database. createDealTracker removes
					// the startDealTracker entry, which signals the queue that the next
					// requestDealStart task can safely run its canStartDeal check.
					await createDealTracker({ 'deal_id': dealId, 'deal': deal, 'start_id': startId });

					// Run the follow loop detached so start() returns after the commit
					// point rather than holding the call stack for the entire deal lifetime.
					// Set isNewDeal flag so the post-try section skips for this path —
					// the setImmediate block runs its own post-deal logic after the loop.
					isNewDeal = true;
					setImmediate(async () => {

						// This callback is detached (not awaited by start()), so any rejection from the follow
						// loop or the post-deal logic would otherwise surface only as a process-level unhandled
						// rejection. Contain it here: log it and move on — a DB hiccup in the post-deal chain
						// must never escape into the process, and the live follow loop is unaffected.
						try {

							await runFollowLoop(config, exchange, dealId);

							// Follow loop finished — run post-deal logic
							await onDealComplete({ dealId, botIdMain, pair, dealCount, config });
						}
						catch (e) {

							Common.logger('Post-deal handling error for deal ' + dealId + ': ' + ((e && (e.stack || e.message)) || e));
						}
					});
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


	// Post-deal logic — runs for the isActive path (existing deal followed to
	// completion). Skipped for new deals — their setImmediate block calls this.
	if (!isNewDeal) {

		await onDealComplete({ dealId: dealIdMain, botIdMain, pair, dealCount, config });
	}
}


// Drives the dcaFollow loop for a running deal until it finishes.
// Used by both the isActive resume path and the new deal setImmediate path.
async function runFollowLoop(config, exchange, dealId) {

	let followSuccess = false;
	let followFinished = false;
	let followConfig = config;
	let consecutiveErrors = 0;

	while (!followFinished) {

		let followRes;

		try {

			followRes = await dcaFollow(followConfig, exchange, dealId);
			consecutiveErrors = 0;
		}
		catch (e) {

			// Defense-in-depth: dcaFollow guards its own tick body, but a throw in its short preamble
			// (before that guard) would otherwise escape here and abandon THIS deal's follow loop, leaving
			// the deal open but unmonitored until a restart. Catch it so the deal keeps ticking — log, back
			// off, and retry. The delay widens (capped) if the error somehow persists, preventing log/CPU
			// spam, while never abandoning the deal.
			consecutiveErrors++;

			try { Common.logger('Deal ID ' + dealId + ' follow tick error (retrying): ' + ((e && e.message) ? e.message : e)); } catch (le) {}

			await Common.delay(Math.min(1000 * consecutiveErrors, 30000));

			continue;
		}

		const followConfigRes = followRes['config'];

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
}


// Runs after a deal's follow loop finishes — refreshes bot config from the
// database, handles deactivation/deal-stop/chain-restart decisions, and cleans
// up the deal tracker. Called from both the new-deal setImmediate path and the
// isActive inline path so the logic lives in exactly one place.
async function onDealComplete({ dealId, botIdMain, pair, dealCount, config }) {

	let botNameMain  = config.botName;
	let botFoundDb   = false;
	let pairFoundDb  = false;
	let botActive    = true;
	let botConfigDb  = null;
	let dealMax      = Number(config.dealMax)      || 0;
	let pairMax      = Number(config.pairMax)      || 0;
	let pairDealsMax = Number(config.pairDealsMax) || 0;
	let dealLast     = false;
	let dealStop     = false;
	let pairDealsLast = false;

	// Refresh bot config in case any settings changed
	try {

		const bot = await getBots({ 'botId': botIdMain });

		if (bot && bot.length > 0) {

			botFoundDb  = true;
			botNameMain = bot[0]['botName'];

			const botPairsDb = bot[0]['config']['pair'];

			for (const pairDb of botPairsDb) {

				if (pair.toUpperCase() == pairDb.toUpperCase()) {

					pairFoundDb = true;
				}
			}

			if (!bot[0]['active']) {

				botActive = false;
			}
			else {

				botConfigDb   = bot[0]['config'];
				dealMax       = botConfigDb['dealMax'];
				pairMax       = botConfigDb['pairMax'];
				pairDealsMax  = botConfigDb['pairDealsMax'];
			}
		}
	}
	catch(e) {}

	// Deactivate bot if max deals reached
	if (dealCount >= dealMax && dealMax > 0) {

		const deactivateData = await updateBot(botIdMain, { 'active': false });

		if (shareData.appData.verboseLog) {

			Common.logger(colors.bgYellow.bold(config.botName + ': Max deal count reached. Bot will not start another deal.'));
		}

		await sendBotStatus({ 'bot_id': botIdMain, 'bot_name': botNameMain, 'active': false, 'success': deactivateData.success });
	}

	// Check if deal stop was requested
	try {

		if (dealTracker[dealId]['update']['deal_stop']) {

			dealStop = true;
		}
	}
	catch(e) {}

	// Check for any resuming deals before continuing
	await processResumeDealTracker({ 'deal_id': dealId });

	// Get active deals for limit checks
	const pairDealsActive = await getDeals({ 'botId': botIdMain, 'pair': pair, 'status': 0 });
	const botDealsActive  = await getDeals({ 'botId': botIdMain, 'status': 0 });
	const pairCount       = botDealsActive.length;

	// pairDealsLast — too many deals on this pair already
	if (pairDealsMax > 1 && pairDealsActive.length >= pairDealsMax) {

		pairDealsLast = true;
	}

	// dealLast — this deal was flagged as the last one for the pair
	const botDealCurrent = await getDeals({ 'botId': botIdMain, 'dealId': dealId });

	if (botDealCurrent && botDealCurrent.length > 0) {

		for (const deal of botDealCurrent) {

			if (deal['config']['dealLast']) {

				dealLast = true;
			}
		}
	}

	// Centralized permission check — blacklist, globalPairLimit, pairMax
	// dealsActive is passed as [] because dcaFollow handles pairDealsLast separately above
	// and the pair's current deal is already closed (status:1) before this point
	// Guard: only call canStartDeal when bot is active and config is available
	const { allowed: canStart } = (botFoundDb && botActive && botConfigDb)
		? await canStartDeal({
			pair,
			config: botConfigDb,
			pairCount,
			dealsActive: []
		})
		: { allowed: false, reason: '' };

	// Manual / API bots ("api" start condition) do not auto-reopen a new deal
	// when one completes — entries come only from the next external signal. asap
	// and provider signal bots (e.g. 3CQS "signal|...") are unaffected.
	const blockReopen = (botActive && botConfigDb) ? shareData.SignalBot.isApiStart(botConfigDb['startConditions']) : false;

	// Start another bot deal if all conditions are met
	if (canStart && !pairDealsLast && !dealStop && botFoundDb && botActive && !dealLast && !blockReopen) {

		const configObj = JSON.parse(JSON.stringify(config));

		if (pairFoundDb && (dealCount < dealMax || dealMax == 0)) {

			botConfigDb['pair']      = pair;
			botConfigDb['dealCount'] = configObj['dealCount'];
			botConfigDb['dealCount']++;

			botConfigDb = await applyConfigData({ 'signal_id': configObj.signalId, 'bot_id': botIdMain, 'bot_name': botNameMain, 'config': botConfigDb });

			if (shareData.appData.verboseLog) {

				Common.logger(colors.bgGreen('Starting new bot deal for ' + pair.toUpperCase() + ' ' + botConfigDb['dealCount'] + ' / ' + botConfigDb['dealMax']));
			}

			const coolDown = botConfigDb['dealCoolDown'] || 0;

			if (coolDown > 0 && shareData.appData.verboseLog) {

				Common.logger(colors.bgYellow.bold('Waiting ' + coolDown + ' seconds for ' + pair.toUpperCase() + ' cooldown before starting new deal.'));
			}

			requestDealStart(botConfigDb, coolDown, 'deal complete');
		}
		else {

			// Check for another pair to start if deal max reached above on current pair
			// Deal max will be reset so current pair could still begin again at some point
			startAsap(pair);
		}
	}

	// Clean up deal tracker
	deleteDealTracker(dealId);
}


// Handles a deal's base order (isStart:0) for one dcaFollow tick. Extracted from
// dcaFollow verbatim (#60) — behavior is identical to the original inline block.
// Returns the loop signal { success, finished } that dcaFollow returns directly.
// Pause flags are passed in (read fresh from the deal each tick by the caller);
// the handler's own pause-flag mutations are local — they only feed this tick's
// tracker updates and returns, and are never read after the handler returns.
const handleBaseOrder = async ({ config, exchange, dealId, deal, orders, pair, price, dcaError, dealState }) => {

	// Per-tick control state, unpacked from the shared dealState snapshot into local
	// bindings. Kept local (rather than read through dealState) so the invalid_order
	// path's mutations of isDealPauseReason / isDealPauseBuy stay within this handler,
	// exactly as when these arrived as discrete by-value parameters.
	let { isDealPause, isDealPauseBuy, isDealPauseSell, isDealPauseReason, cancelOnly } = dealState;

	// Local tracker-update helper. The three base-order tracker refreshes below are
	// identical except for the error value, and all read the current pause flags —
	// which the invalid_order path mutates before its own refresh. Capturing the
	// pause vars by closure means each call sees their live values (exactly as the
	// former inline object literals did), so only the error is passed per call.
	const trackBaseDeal = async (error) => {

		await updateDealTracker({
			'exchange': exchange,
			'deal_id': dealId,
			'price': price,
			'config': config,
			'orders': orders,
			'pause': isDealPause,
			'pause_buy': isDealPauseBuy,
			'pause_sell': isDealPauseSell,
			'pause_reason': isDealPauseReason,
			'error': error
		});
	};

	// Defense in depth — circuit breaker should already have been caught
	// by canStartDeal before reaching here, but guard at the exchange call
	// level too in case start() is ever called from a path that bypasses
	// the serial queue (e.g. resume on startup).
	if (shareData.appData.circuit_breaker_active) {

		Common.logger(colors.yellow.bold('Circuit Breaker Active: ' + shareData.appData.circuit_breaker_active + ' - Blocking base order for deal ' + dealId));

		return ( LOOP_RETRY );
	}

	// If the base order is paused (mid-verify after a previous invalid_order),
	// do not place another buy. Refresh the tracker (so info.updated stays
	// current and the system-pause banner keeps showing), then return
	// finished:false so the follow loop stays alive and keeps ticking. This
	// mirrors the safety order path exactly: the pause is the re-entry guard
	// WITHIN a live loop — not a loop exit. When verifyInvalidOrder unpauses
	// the deal in the background, this same loop resumes and advances it to
	// isStart:1. Refreshing here (as the isStart==1 paused path also does)
	// prevents checkTrackers from firing false "deal stale" warnings during
	// the verification window, which can span up to ~200 minutes.
	if (isDealPause || isDealPauseBuy) {

		await trackBaseDeal(dcaError);

		return ( LOOP_RETRY );
	}

	let buyError;
	let buyOrderId = '';
	let buySuccess = true;
	let buyOrderInvalid = false;
	let buyResult = null;

	// Single loop-signal this function returns (one exit at the end). Defaults to
	// "filled — continue the loop", which is also the limit-order fall-through value.
	// Each buy outcome below overwrites it; the two guard clauses above return early.
	let result = LOOP_CONTINUE;

	const baseOrder = deal.orders[0];

	// Something went wrong, don't allow deal to start
	if (cancelOnly) {

		buySuccess = false;
	}

	if (baseOrder.type == 'MARKET') {
		//Send market order to exchange

		if (!config.sandBox && !cancelOnly) {

			const priceFiltered = await filterPrice(exchange, pair, price);

			const buy = await buyOrder({ exchange, dealId, pair, qty: baseOrder.qty, price: priceFiltered });

			if (!buy.success || (buy.success && !buy.success_verify)) {

				buySuccess = false;
				buyError = buy.message;
				buyOrderInvalid = buy.invalid_order || false;
				buyResult = buy;
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

		await trackBaseDeal(buyError);

		if (!buySuccess) {

			// Base order placed but the exchange could not confirm it (invalid_order).
			// The order is likely filled — do NOT delete the deal. Pause it, store the
			// order ID, and verify in the background. This mirrors the safety order path.
			if (buyOrderInvalid && buyResult && buyResult['data'] && buyResult['data']['id']) {

				const retryMins = 2;
				const unverifiedOrderId = buyResult['data']['id'];

				// Store the order ID on the base order so the startup resume path
				// can find it if SymBot restarts mid-verification.
				orders[0].orderId = unverifiedOrderId;
				await Deals.updateOne({ dealId: dealId }, { orders: orders });

				const msgErr = 'Invalid base order for deal ID ' + dealId + '. Pausing deal and verifying in ' + retryMins + ' minutes.';
				await sendDealMessage('deal_error', msgErr);

				isDealPauseReason = 'order_verify_buy';
				await pauseDeal(config.botId, dealId, null, true, null, isDealPauseReason);
				isDealPauseBuy = true;

				// Refresh the tracker now that the deal is paused so its info carries
				// pause_reason. getDealInfo returns a minimal paused info object for an
				// isStart:0 deal, which lets the UI render the system-pause banner.
				// (The earlier updateDealTracker call above ran before the pause was set,
				// so at that point getDealInfo returned no info for this unfilled deal.)
				await trackBaseDeal(buyError);

				// On successful verification, mark the base order filled and advance
				// the deal to isStart=1 — EXACTLY what the normal base-order success
				// path does. We keep SymBot's pre-calculated qty/amount/average/target
				// untouched so fee accounting, take-profit and profit% are identical to
				// a normally-filled base order. We do not overwrite with raw exchange
				// values and do not recalculate the ladder.
				const handleBaseOrderVerified = async (verifyData) => {

					orders[0].filled = 1;
					orders[0].orderId = unverifiedOrderId;
					orders[0].dateFilled = new Date();

					await Deals.updateOne({ dealId: dealId }, { isStart: 1, orders: orders });
				};

				const verifyPromise = verifyInvalidOrder({ count: 0, mins: retryMins, exchange, pair, botId: config.botId, dealId, orderId: unverifiedOrderId, onSuccessCallback: handleBaseOrderVerified, pauseBeforeCallback: false });

				verifyPromise.then(async (verifyResult) => {

					if (verifyResult.retriesExhausted) {

						// Retries exhausted and the order still could not be confirmed.
						// The asset may be sitting on the exchange untracked — warn the
						// user to verify manually, then disable the bot and remove the deal.
						const exhaustMsg = 'Base order verification retries exhausted for deal ID ' + dealId + ' (order ' + unverifiedOrderId + '). The asset may be on the exchange — verify manually before re-enabling bot ' + config.botName + '. Disabling bot and removing deal.';
						await sendDealMessage('deal_error', exhaustMsg);

						await processOrderError({ 'bot_id': config.botId, 'deal_id': dealId, 'bot_name': config.botName });
						await deleteDeal(dealId);

						// Remove the tracker entry immediately so no phantom row lingers in
						// the UI. The live follow loop also stops on its next tick when it finds
						// the deal gone (dcaFollow returns finished:true on not-found), and
						// onDealComplete would delete the tracker then too — deleteDealTracker
						// is idempotent, so the redundant call is safe.
						await deleteDealTracker(dealId);
					}
				}).catch((e) => { try { Common.logger('verifyInvalidOrder (base order) background error for deal ' + dealId + ': ' + ((e && e.message) ? e.message : e)); } catch (le) {} });

				// finished:false so the follow loop stays alive. The deal is now paused,
				// so the pause guard at the top of this function no-ops every subsequent
				// tick (no re-buy). When verifyInvalidOrder succeeds it advances the deal
				// to isStart:1 and unpauses; this same live loop then picks up and
				// continues into normal safety-order / sell monitoring. This mirrors the
				// safety order path, which also stays alive — NOT a loop exit.
				result = LOOP_RETRY;
			}
			else {

				// Order never placed. This covers BOTH a genuine exchange rejection (e.g. BadRequest /
				// limit-only) AND a transient hold condition (cancelOnly: getSymbol errored, or the price came
				// back zero / implausible, so the buy above was skipped). In every case no order was sent and
				// there is no asset on the exchange, so the deal is torn down: disable the bot and remove the
				// phantom deal (which otherwise occupies a Max Deals slot with no position behind it).
				//
				// KNOWN LIMITATION / FUTURE WORK — trading-critical, change only with research + testing:
				// A purely transient blip (a brief network / price-feed glitch) is currently torn down the same
				// as a permanent failure, deleting an otherwise-valid new deal — though the bot simply
				// re-opens it on its next signal / asap cycle, so nothing is lost. A smarter design would
				// briefly hold-and-retry a TRANSIENT failure and only tear down a PERSISTENT one. The blocker:
				// SymBot does not track exchange-specific error messages / codes, and telling "pair halted or
				// limit-only" apart from "momentary glitch" reliably ACROSS EXCHANGES is hard (CCXT normalizes
				// error TYPES like ExchangeError but not this transient-vs-permanent distinction). Two failure
				// modes must be avoided by any future attempt: (1) holding a deal that can never place its base
				// order leaves a phantom occupying a Max Deals slot until manually cleared; (2) any "keep going"
				// change on this path must never re-enter order placement in a way that sends repeated orders.
				// So this stays an immediate, proven teardown until a well-researched, exchange-agnostic,
				// bounded-retry-with-escalation design is built and thoroughly tested.
				const statusObj = await processOrderError({ 'bot_id': config.botId, 'deal_id': dealId, 'bot_name': config.botName });

				if (statusObj['success']) {

					await deleteDeal(dealId);

					// Deal removed — signal the loop to stop.
					result = LOOP_STOPPED;
				}
				else {

					// Could not disable/remove — stay alive and let a later tick retry.
					result = LOOP_RETRY;
				}
			}
		}
	}
	else {

		// Limit order logic — not yet implemented. Leaves the default loop-continue
		// signal in place, exactly as the original inline block did (it returned nothing
		// and let dcaFollow's default { success:true, finished:false } stand).
	}

	return ( result );
};


const handleSell = async ({ config, exchange, dealId, deal, orders, order, currentOrder, filledOrders, pair, price, priceSellOrder, profit, profitBase, profitQuote, profitPerc, dealState, isDealStopLoss }) => {

	// Per-tick control state, unpacked from the shared dealState snapshot into local
	// bindings so this handler's own mutations (isDealVerifying / isDealPauseReason /
	// isDealPauseSell when pausing for sell-order verification) stay local — identical
	// to when these arrived as discrete by-value parameters.
	let { isDealPause, isDealPauseBuy, isDealPauseSell, isDealPauseReason, isDealCancel, isDealPanicSell, isDealVerifying, cancelOnly } = dealState;

	// success/finished are the loop signal this handler returns. In dcaFollow these were
	// function-scope with defaults success=true, finished=false; kept identical here so the
	// (unreachable) deal-not-started fall-through returns the same {true,false} the original
	// did. Within the sell path success is re-affirmed true and finished is set true only when
	// the deal sells out (status:1); otherwise the deal keeps following.
	let success = true;
	let finished = false;

	if (deal.isStart == 1) {

		let qtySumSellOrder;

		let profitCurrency = config['profitCurrency'];

		let sellOrderIds = [];
		let sellError;
		let sellOrderPrice;
		let sellOrderInvalid = false;
		let sellOrderStatusInvalid = false;
		let sellNSF = false;
		let sellSuccess = true;

		// Actual execution tally for this sell. A sell can complete as several partial
		// fills at different prices (exchange cancels part way, remainder retried), so
		// recording each fill lets the closed deal report what really executed instead
		// of the pre-calculated ladder quantity valued at a single price.
		//
		// Observational only — it never feeds order sizing. The retry loops keep using
		// qtySumSellOrder as the read-only ceiling exactly as before, so nothing here
		// can change what gets sold. It is consumed only when building sellData, and
		// only when it passes the checks in resolveFillSummary.
		const fillTracker = {
			'fills': [],
			'qty': 0,
			'proceeds': 0
		};

		// Record one executed fill.
		//
		// Exchange support for fill data varies widely across the exchanges CCXT
		// covers, so the per-fill value is resolved through a precedence chain of
		// CCXT unified fields, most trustworthy first:
		//
		//   1. average * qty  — 'average' is CCXT's volume-weighted fill price, i.e.
		//                       unambiguously a PRICE, so it cannot silently include fees.
		//                       Safest source where the exchange reports it.
		//   2. cost           — CCXT's executed value. Preferred over 'price' because 'price'
		//                       is rounded for display (observed live: the two differing
		//                       by ~0.07% across a multi-fill sell) and on many exchanges
		//                       'price' is the REQUESTED price, empty for market orders.
		//                       CCXT maintainers note some exchanges fold fees into 'cost';
		//                       since calculateProfit subtracts the configured exchangeFee
		//                       itself, a fee-inclusive cost would be double-counted. It is
		//                       therefore cross-checked against price * qty below.
		//   3. price * qty    — CCXT's convention is cost = filled * price, so this
		//                       reconstructs the same figure when cost is absent or rejected.
		//   4. requested * qty— last resort. NOT evidence of execution, so it is tagged
		//                       'requested' and resolveFillSummary rejects the summary.
		//
		// Exchanges that report nothing usable (some return null/zero for all of
		// price, cost and average even after fetchOrder) fall through to 4 and the
		// deal reports exactly as it does today. Quantity is still counted so the
		// shortfall figure stays correct regardless.
		const recordFill = (qtyFilled, orderData, requestedPrice) => {

			const qty = Number(qtyFilled);

			if (!isFinite(qty) || qty <= 0) {

				return;
			}

			const num = (v) => {

				const n = Number(v);

				return (isFinite(n) && n > 0 ? n : 0);
			};

			const avg    = num(orderData?.['average']);
			const cost   = num(orderData?.['amount']);
			const px     = num(orderData?.['price']);
			const reqPx  = num(requestedPrice ?? price);

			let value = 0;
			let valueSource = 'none';

			if (avg > 0) {

				value = qty * avg;
				valueSource = 'average';
			}
			else if (cost > 0) {

				// Guard against exchanges reporting cost net of fees. calculateProfit
				// applies the configured exchangeFee itself, so a fee-inclusive cost
				// would deduct fees twice and understate every partial-fill deal. On a
				// sell, a cost materially BELOW price * qty is the signature of a
				// fee-inclusive figure, so fall through to price instead. Display
				// rounding is far smaller than any real fee, hence the tolerance.
				// Where no price is available to compare, cost is used as-is.
				const costImpliedPrice = cost / qty;

				if (px > 0 && costImpliedPrice < (px * (1 - (costFeeTolerancePercent / 100)))) {

					value = qty * px;
					valueSource = 'price';
				}
				else {

					value = cost;
					valueSource = 'cost';
				}
			}
			else if (px > 0) {

				value = qty * px;
				valueSource = 'price';
			}
			else if (reqPx > 0) {

				value = qty * reqPx;
				valueSource = 'requested';
			}

			fillTracker['fills'].push({
				'qty': qty,
				'price': value > 0 ? (value / qty) : 0,
				'value': value,
				'value_source': valueSource
			});

			fillTracker['qty'] += qty;
			fillTracker['proceeds'] += value;
		};

		// Shared onFill for BOTH sell partial-fill retry loops (the main take-profit path and the
		// exchange-cancelled settlement path): track each retry's order id and record its fill. Defined once
		// here so the two retryPartialFill call sites in this function stay identical by construction.
		// Records whatever actually filled this attempt regardless of the final order status — a retry can
		// partially fill then be canceled by the exchange (e.g. Coinbase price protection) yet still report a
		// real fill in data_order.quantity; missing it would leave the remainder too high so later retries
		// over-ask and hit InsufficientFunds. Adjusts only the in-memory tally — the pre-calculated
		// qtySumSellOrder is never mutated.
		const recordSellRetryFill = (filled, orderResult, priceUsed) => {

			if (orderResult?.['data']?.['id']) { sellOrderIds.push(orderResult['data']['id']); }
			recordFill(filled, orderResult['data_order'], priceUsed);
		};

		const sellDataObj = await processSellData(pair, price, dealId, exchange, config, currentOrder, filledOrders);

		const feeData = sellDataObj['fee_data'];

		const qtySumSell = feeData['dcaOrderQtySumNet'];
		const priceFiltered = feeData['priceFiltered'];
		const exchangeFeePercent = feeData['exchangeFeePercent'];
		const minMoveAmount = feeData['minMoveAmount'];

		const qtySumSellBase = await filterAmount(exchange, pair, (Number(qtySumSell) - Number(profitBase)));

		// Default profit currency to quote if not defined or profit is negative
		if (!profitCurrency || profitCurrency == 'quote' || Number(profitBase) <= 0) {

			qtySumSellOrder = qtySumSell;
		}
		else {

			qtySumSellOrder = qtySumSellBase;
		}

		// Calculate profit based on new exchange fee percent
		//const profitData = await calculateProfit(price, config.sandBox, currentOrder.average, currentOrder.sum, config.dcaTakeProfitPercent, exchangeFeePercent);
		//const profitPercFinal = profitData['profit_percentage'];
		const profitPercFinal = Number(Number(profitPerc - feeData['exchangeFeeSumDiffPercent']).toFixed(2));

		// Decide whether the recorded fills are trustworthy enough to report profit
		// from. Exchange fill data already drives order sizing (the retry loops depend
		// on data_order.quantity), but reporting has a higher bar: a wrong number here
		// yields a confidently wrong profit figure, which is worse than the
		// pre-calculated estimate. Actuals are therefore corroborating, not
		// authoritative — any check failing falls back to exactly today's behavior.
		//
		// Checks:
		//   1. At least one fill with positive quantity was recorded.
		//   2. Every fill's value came from the exchange (amount or executed price).
		//      A value derived from the requested price is not evidence of execution.
		//   3. Total filled does not exceed the planned quantity beyond a rounding
		//      tolerance — selling more than was held means the data is wrong.
		//   4. VWAP is finite and positive.
		//
		// Returns null when actuals should not be used.
		const resolveFillSummary = (plannedQty) => {

			const planned = Number(plannedQty);

			if (!fillTracker['fills'].length || fillTracker['qty'] <= 0) {

				return (null);
			}

			// Only values the exchange actually reported count as evidence of execution.
			const trustedSources = ['average', 'cost', 'price'];

			const anyUntrusted = fillTracker['fills'].some(f => trustedSources.indexOf(f['value_source']) === -1);

			if (anyUntrusted) {

				return (null);
			}

			if (isFinite(planned) && planned > 0 && fillTracker['qty'] > (planned * 1.001)) {

				return (null);
			}

			const vwap = fillTracker['proceeds'] / fillTracker['qty'];

			if (!isFinite(vwap) || vwap <= 0) {

				return (null);
			}

			// Sanity-check the VWAP against the market price this sell was placed at.
			// Some exchanges return values in the wrong unit or scale (cost in base
			// rather than quote, prices in satoshi-like integers). A VWAP wildly away
			// from the price the order was submitted at means the reported figures
			// cannot be interpreted safely, so fall back rather than report nonsense.
			const referencePrice = Number(price);

			if (isFinite(referencePrice) && referencePrice > 0) {

				const ratio = vwap / referencePrice;

				if (ratio < 0.5 || ratio > 2) {

					Common.logger(colors.bgRed.bold(
						'Fill data rejected for deal ID ' + dealId +
						' — VWAP ' + vwap + ' implausible vs market price ' + referencePrice +
						'. Reporting from pre-calculated values instead.'
					));

					return (null);
				}
			}

			const qtyUnsold = (isFinite(planned) && planned > 0) ? Math.max(planned - fillTracker['qty'], 0) : 0;

			return ({
				'qty_filled': fillTracker['qty'],
				'vwap': vwap,
				'proceeds': fillTracker['proceeds'],
				'fill_count': fillTracker['fills'].length,
				'qty_unsold': qtyUnsold,
				'partial': qtyUnsold > 0 || fillTracker['fills'].length > 1
			});
		};

		const handleSuccessfulSell = async (verifyData) => {

			// Sell price/profit default to the values computed when the sell was
			// first attempted (market price at that moment). If this callback is
			// running after a late invalid_order verification, the order actually
			// filled minutes earlier at a different price — use the exchange's
			// reported fill price so recorded profit matches the real execution
			// rather than the market price at verification time.
			//
			// Quantity is unaffected (qtySum comes from accumulated buys), so only
			// the sell price and the profit figures derived from it are recomputed.
			// The fee adjustment (exchangeFeeSumDiffPercent) is derived from the
			// buy-side sums and does not depend on the sell price, so it is reused.
			let sellPriceFinal   = price;
			let profitFinal      = profitPercFinal;
			let profitBaseFinal  = profitBase;
			let profitQuoteFinal = profitQuote;

			if (verifyData && verifyData.order_price && Number(verifyData.order_price) > 0) {

				sellPriceFinal = Number(verifyData.order_price);

				const profitDataVerified = await calculateProfit(exchange, pair, sellPriceFinal, currentOrder.average, currentOrder.sum, config.dcaTakeProfitPercent, config.exchangeFee, config.sandBox);

				profitBaseFinal  = profitDataVerified['profit_base'];
				profitQuoteFinal = profitDataVerified['profit'];
				profitFinal      = Number(Number(profitDataVerified['profit_percentage'] - feeData['exchangeFeeSumDiffPercent']).toFixed(2));
			}

			// Recompute from what actually executed when the sell completed as more than
			// one fill (or left a shortfall) and the recorded fills pass their checks. A
			// clean single-fill sell produces identical numbers either way — filled
			// quantity equals planned and VWAP equals the single fill price — so this
			// only moves deals whose reported figures were wrong.
			//
			// Only the INPUTS change: sell price becomes the volume-weighted average of
			// the fills, and the cost basis covers only the quantity that actually sold.
			// Fee handling is untouched — same configured exchangeFee, same
			// calculateProfit path, same exchangeFeeSumDiffPercent adjustment.
			const fillSummary = resolveFillSummary(qtySumSellOrder);

			let profitSource = 'planned';
			let qtySoldFinal = currentOrder.qtySum;

			if (fillSummary && fillSummary['partial']) {

				// Cost basis matched to the quantity that sold, so the deal is not charged
				// for coin it still holds. Scale currentOrder.sum by the fraction of the
				// ACCUMULATED BUY quantity (currentOrder.qtySum) that sold — qtySum is what
				// currentOrder.sum paid for. Scaling by qtySumSellOrder would mix
				// denominators: that figure is already net of the sell-side fee reduction,
				// so it is smaller than qtySum and would understate the basis.
				const basisQtyTotal = Number(currentOrder.qtySum);
				const basisSumTotal = Number(currentOrder.sum);

				let basisMatched;

				if (isFinite(basisQtyTotal) && basisQtyTotal > 0 && isFinite(basisSumTotal) && basisSumTotal > 0) {

					basisMatched = basisSumTotal * Math.min(fillSummary['qty_filled'] / basisQtyTotal, 1);
				}
				else {

					basisMatched = fillSummary['qty_filled'] * Number(currentOrder.average);
				}

				const profitDataActual = await calculateProfit(exchange, pair, fillSummary['vwap'], currentOrder.average, basisMatched, config.dcaTakeProfitPercent, config.exchangeFee, config.sandBox);

				sellPriceFinal   = Number(Number(fillSummary['vwap']).toFixed(10));
				profitBaseFinal  = profitDataActual['profit_base'];
				profitQuoteFinal = profitDataActual['profit'];
				profitFinal      = Number(Number(profitDataActual['profit_percentage'] - feeData['exchangeFeeSumDiffPercent']).toFixed(2));

				qtySoldFinal = fillSummary['qty_filled'];
				profitSource = 'actual';

				Common.logger(colors.bgYellow.bold(
					'Profit from actual fills for deal ID ' + dealId +
					' / Fills: ' + fillSummary['fill_count'] +
					' / Sold: ' + fillSummary['qty_filled'].toFixed(8) +
					' of ' + Number(qtySumSellOrder).toFixed(8) +
					' / VWAP: ' + formatPrice(pair, fillSummary['vwap']) +
					' / Proceeds: ' + formatPrice(pair, Number(fillSummary['proceeds']).toFixed(8)) +
					(fillSummary['qty_unsold'] > 0 ? ' / Unsold: ' + fillSummary['qty_unsold'].toFixed(8) : '')
				));

				if (fillSummary['qty_unsold'] > 0) {

					await sendDealMessage('deal_error',
						'Deal ID ' + dealId + ' closed with ' + fillSummary['qty_unsold'].toFixed(8) + ' ' + (pair.split('/')[0] || '') +
						' unsold (below retry threshold). This quantity is not tracked in the deal — reconcile manually.'
					);
				}
			}

			await updateDealTracker({
				'exchange': exchange,
				'deal_id': dealId,
				'price': sellPriceFinal,
				'config': config,
				'orders': orders,
				'pause': isDealPause,
				'pause_buy': isDealPauseBuy,
				'pause_sell': isDealPauseSell,
				'pause_reason': isDealPauseReason
			});

			if (shareData.appData.verboseLog) {

				Common.logger(
				colors.blue.bold.italic(
				formatDealStatusLine({
					'pair': pair,
					'qty': qtySoldFinal,
					'lastPrice': sellPriceFinal,
					'dcaPrice': currentOrder.average,
					'sellPrice': currentOrder.target,
					'status': colors.red('SELL'),
					'profit': profitFinal
				})
				));
			}

			// orderId is stored as an array for partial fill retry compatibility.
			// Single-order deals will have a one-element array.
			// Legacy deals with a string orderId are handled transparently by consumers.
			// Existing keys are unchanged in name, meaning and type — qtySum remains the
			// deal's accumulated buy quantity and price remains the figure profit was
			// derived from (the VWAP when fills were used). The fields after feeData are
			// additive: consumers unaware of them are unaffected, and they are absent on
			// deals closed before this change, so readers must treat them as optional.
			const sellData = {
				'date': new Date(),
				'orderId': sellOrderIds,
				'qtySum': currentOrder.qtySum,
				'qtySumSell': qtySumSell,
				'qtySumSellOrder': qtySumSellOrder,
				'price': sellPriceFinal,
				'average': currentOrder.average,
				'target': currentOrder.target,
				'profit': profitFinal,
				'profitBase': profitBaseFinal,
				'profitQuote': profitQuoteFinal,
				'feeData': feeData,
				'profitSource': profitSource,
				'qtySold': qtySoldFinal,
				'qtyUnsold': fillSummary ? fillSummary['qty_unsold'] : 0,
				'fillCount': fillSummary ? fillSummary['fill_count'] : (sellOrderIds.length || 1),
				'proceeds': fillSummary ? fillSummary['proceeds'] : null,
				'fills': fillTracker['fills']
				 };

			// Close only an OPEN deal (status:0). Gating the filter makes the close idempotent: if a
			// concurrent/stale path already closed this deal, this write finds no match and is a no-op,
			// so a late writer can never overwrite the good close/sellData with stale figures.
			await Deals.updateOne({ dealId, 'status': 0 }, {
				'sellData': sellData,
				'stopLoss': isDealStopLoss,
				'panicSell': isDealPanicSell,
				'canceled': isDealCancel,
				'status': 1
				  });

			finished = true;

			await deleteDealTracker(dealId);

			if (shareData.appData.verboseLog) {

				Common.logger(colors.bgRed('Deal ID ' + dealId + ' DCA Bot Finished.'));
			}

			sendNotificationFinish(config.botName, dealId, pair, sellData);
		};

		if (!config.sandBox && !isDealCancel && !cancelOnly) {

			const sell = await sellOrder({ exchange, dealId, pair, qty: qtySumSellOrder, price: priceFiltered });

			// Sell not successful / Sell successful but verification failed
			if (!sell.success || (sell.success && !sell.success_verify)) {

				// sellOrderInvalid - Order not found or unable to be looked up on exchange
				// sellOrderStatusInvalid - Order may have been canceled by exchange or some other issue

				sellSuccess = false;

				sellOrderInvalid = sell.invalid_order;
				sellOrderStatusInvalid = sell.invalid_status;
				sellError = sell.message;
				sellNSF = sell.nsf;

				let msgErr = null;
				let msgType = null;

				if (sellNSF) {

					// Let NSF reduce quantity sell error logic handle below
				}
				else if (sellOrderStatusInvalid) {

					// Check if exchange canceled after a partial fill (e.g. Coinbase price protection)
					const cancelPartialFilled = orderFilledQty(sell);
					const cancelShortfall = partialFillShortfallPercent(cancelPartialFilled, qtySumSellOrder);

					if (cancelPartialFilled > 0 && cancelShortfall > partialSellFillThresholdPercent) {

						// Exchange canceled after partial fill — record fill and
						// wait for settlement before retrying the remainder
						sellOrderIds.push(sell['data']['id']);

						recordFill(cancelPartialFilled, sell['data_order'], priceFiltered);

						Common.logger(colors.bgYellow.bold(
							'Exchange-cancelled partial fill for deal ID ' + dealId +
							' / Filled: ' + cancelPartialFilled.toFixed(8) +
							' / Shortfall: ' + cancelShortfall.toFixed(2) + '% — waiting for settlement'
						));

						Common.sendNotification({
							'message': `Partial sell fill for deal ID ${dealId}. Exchange canceled after ${(100 - cancelShortfall).toFixed(0)}% filled. Waiting for settlement then retrying remainder.`,
							'type': 'deal_error',
							'telegram_id': shareData.appData.telegram_id
						});

						// Settlement delay — give exchange time to release remaining balance
						const settlementDelayMs = 30000;
						await Common.delay(settlementDelayMs);

						// Retry the remainder through the SHARED partial-fill loop (same helper the buy and
						// main-sell paths use). Bookkeeping is identical to before — record each fill and track
						// its order id — and an NSF (still-settling) attempt extends the settlement wait via the
						// onEmptyFill hook, exactly as the previous inline loop did.
						await retryPartialFill({
							side: 'sell', exchange, pair, dealId,
							requestedQty: Number(qtySumSellOrder), initialFilledQty: cancelPartialFilled, fallbackPrice: price,
							placeOrder: ({ qty, price: retryPrice }) => sellOrder({ exchange, dealId, pair, qty, price: retryPrice }),
							onFill: recordSellRetryFill,
							onEmptyFill: async (orderResult) => { if (orderResult && orderResult.nsf) { await Common.delay(settlementDelayMs); } },
							isAborted: () => (isDealCancel || isDealPanicSell),
							logLabel: 'Settlement retry'
						});

						// Mark sell successful so deal closes with the partial fill
						sellSuccess = true;
						sellOrderStatusInvalid = false;

					} else {

						// Clean cancel with no partial fill — retry after short delay
						await Common.delay(5000);
					}
				}
				else if (sellOrderInvalid) {

					const retryMins = 1;

					msgType = 'deal_error';
					msgErr = `Invalid order for deal ID ${dealId}. Pausing sell orders for ${retryMins} minutes.`;

					isDealVerifying = true;
					isDealPauseReason = 'order_verify_sell';

					// KNOWN LIMITATION (restart during verification): the in-flight sell order ID is held only in
					// memory here — it is not persisted to the deal (sellData is written only on a clean close).
					// resumeDeal reads dealObj.sellData.orderId[0], which is therefore empty during this window,
					// so a restart falls back to clearing the pause and resuming take-profit monitoring. If the
					// sell had actually filled, the next in-target tick attempts a second sell (which fails safe
					// against oversell via InsufficientFunds, but leaves the deal orphaned in a sell_error retry
					// until manually reconciled). A correct fix persists the sell order ID and reconstructs the
					// handleSuccessfulSell finalize on resume — deferred as a dedicated effort.
					const verifyPromise = verifyInvalidOrder({ count: 0, mins: retryMins, exchange, pair, botId: config.botId, dealId, orderId: sell['data']['id'], onSuccessCallback: handleSuccessfulSell, pauseBeforeCallback: true });

					// Reset verifying flag if needed
					verifyPromise.then(async (verifyResult) => {

						if (verifyResult.retriesExhausted || verifyResult.notPaused) {
							clearSellErrorVerifying(dealId);
						}
					}).catch((e) => { try { Common.logger('verifyInvalidOrder (sell) background error for deal ' + dealId + ': ' + ((e && e.message) ? e.message : e)); } catch (le) {} });
				}
				else {

					msgType = 'deal_error';
					msgErr = `An error occurred during sell order for deal ID ${dealId}. Pausing any further sell orders for deal.`;

					// A generic sell error (not NSF, not invalid-order, not status-invalid) has no order to
					// verify. Use a distinct, auto-recoverable reason — NOT 'order_verify_sell' — so that:
					//   (a) a panic-sell / stop-loss is not wrongly deferred (nothing is in flight to oversell), and
					//   (b) the tick-level sell-error reset can lift this pause once the error has had time to
					//       clear, instead of stranding the deal paused until a manual resume or restart.
					isDealPauseReason = 'sell_error';
				}

				if (msgErr) {

					await sendDealMessage(msgType, msgErr);
					// The reason is set by the specific error branch above ('order_verify_sell' for an invalid
					// order being verified, 'sell_error' for a generic error). Default defensively if unset.
					if (!isDealPauseReason) { isDealPauseReason = 'order_verify_sell'; }
					await pauseDeal(config.botId, dealId, null, null, true, isDealPauseReason);
					isDealPauseSell = true;
				}
			}
			else {

				// Initial sell succeeded — record this order ID and check for partial fill
				sellOrderIds.push(sell['data']['id']);

				const initialQtyFilled = orderFilledQty(sell);

				recordFill(initialQtyFilled, sell['data_order'], priceFiltered);

				let totalQtyFilled = initialQtyFilled;
				let qtyRemaining = Number(qtySumSellOrder) - totalQtyFilled;

				// Only attempt partial fill retry if the exchange reported a positive
				// filled quantity. A zero or null quantity after a successful
				// verifyBuySellOrder means the exchange didn't report the fill amount —
				// not that nothing was filled. Retrying in that case would sell again
				// on a position that has already been fully closed. Shortfall via the shared helper
				// (returns 0 for a zero/undefined fill), the same gate the buy side uses.
				const shortfallPercent = partialFillShortfallPercent(initialQtyFilled, qtySumSellOrder);

				if (shortfallPercent > partialSellFillThresholdPercent) {

					// Partial fill detected — sell the remainder through the SHARED partial-fill loop
					// (the same helper the buy side uses).
					Common.logger(colors.bgYellow.bold(
						'Partial sell fill detected for deal ID ' + dealId +
						' / Requested: ' + qtySumSellOrder +
						' / Filled: ' + totalQtyFilled.toFixed(8) +
						' / Remaining: ' + qtyRemaining.toFixed(8) +
						' / Shortfall: ' + shortfallPercent.toFixed(2) + '%'
					));

					Common.sendNotification({
						'message': 'Partial sell fill detected for deal ID ' + dealId + '. Attempting to sell remaining quantity.',
						'type': 'deal_error',
						'telegram_id': shareData.appData.telegram_id
					});

					const retry = await retryPartialFill({
						side: 'sell', exchange, pair, dealId,
						requestedQty: Number(qtySumSellOrder), initialFilledQty: totalQtyFilled, fallbackPrice: price,
						placeOrder: ({ qty, price: retryPrice }) => sellOrder({ exchange, dealId, pair, qty, price: retryPrice }),
						onFill: recordSellRetryFill,
						isAborted: () => (isDealCancel || isDealPanicSell),
						logLabel: 'Partial sell'
					});

					totalQtyFilled = retry.totalFilled;
					qtyRemaining   = retry.qtyRemaining;
					const retryCount = retry.retryCount;

					if (retryCount >= maxPartialSellRetries) {

						const finalShortfall = ((Math.max(qtyRemaining, 0) / Number(qtySumSellOrder)) * 100).toFixed(2);

						Common.logger(colors.bgRed.bold(
							'Max partial sell retries reached for deal ID ' + dealId +
							'. Accepting fill. Final shortfall: ' + finalShortfall + '%'
						));

						Common.sendNotification({
							'message': 'Max partial sell retries reached for deal ID ' + dealId + '. Accepted fill with ' + finalShortfall + '% shortfall.',
							'type': 'deal_error',
							'telegram_id': shareData.appData.telegram_id
						});
					}
				}
			}
		}

		if (cancelOnly) {

			// Untrusted price (a getSymbol error, or an implausible price rejected by the
			// plausibility guard). NEVER record a close at a price we can't trust, and in
			// live mode NEVER mark a deal sold when no order was actually placed — the
			// real sellOrder above is skipped while cancelOnly is set (see the guard on
			// that call). This branch is only reached via panic_sell / cancel, since the
			// automatic take-profit sell is itself gated on !cancelOnly in dcaFollow.
			//
			// Hold the deal: the panic_sell / cancel request stays pending in the deal
			// tracker (deal_panic_sell / deal_cancel are not cleared until the deal
			// closes), so it completes on a later tick once a trustworthy price returns —
			// at the real market price, not this garbage one. The delay paces the retry so
			// this does not tight-loop fetchTicker (the sell branch returns to the follow
			// loop immediately, bypassing dcaFollow's own end-of-tick delay).
			Common.logger(colors.red.bold('Deal ID ' + dealId + ' close/sell HELD: price feed unreliable (cancelOnly). Will complete when a valid price returns.'));

			// A panic_sell / cancel is pending but cannot execute while the price is
			// untrusted. That is an emergency user action, so after a few consecutive held
			// ticks (and periodically after) push a notification so a deal that stays stuck
			// — e.g. a revoked API key or a prolonged auth outage — is not silently held
			// with log output only. Deliberately NOT gated on circuit_breaker.enabled: this
			// is a safety alert about a pending user action, not a circuit-breaker action.
			if (!shareData.appData.cb_close_held_tracker) { shareData.appData.cb_close_held_tracker = {}; }
			const cht = shareData.appData.cb_close_held_tracker;
			cht[dealId] = (cht[dealId] || 0) + 1;

			const cbCfgHold = shareData.appData.circuit_breaker || {};
			const heldAlertThreshold = (cbCfgHold && cbCfgHold.close_held_alert_count) || 15;

			if (cht[dealId] >= heldAlertThreshold) {

				Common.sendNotification({
					'message': `⚠️ Close/Panic Held\n\nPair: ${pair}\nDeal ID: ${dealId}\n\nA ${isDealPanicSell ? 'panic sell' : 'cancel/close'} is pending but cannot execute because the exchange price feed is unreliable. The deal is being HELD (not closed) and will complete automatically once a valid price returns. If this persists, check the exchange API key / connection.`,
					'type': 'warning',
					'telegram_id': shareData.appData.telegram_id
				});

				// Reset so it re-alerts periodically rather than every tick
				cht[dealId] = 0;
			}

			await Common.delay(2000);
		}
		else if (sellSuccess) {

			await handleSuccessfulSell();
		}
		else {

			// Sell failed. Defensively ensure the tracker path exists before recording the error: a
			// concurrent completion path can remove the tracker entry, in which case these sub-field writes
			// would throw a TypeError (contained by the outer catch, but the sell-error count/backoff for
			// this tick would be lost). Re-create deal_sell_error with its canonical shape if missing, and
			// skip cleanly if the deal's tracker entry is entirely gone.
			const sellErrTrk = dealTracker[dealId] && dealTracker[dealId]['update'];

			if (sellErrTrk) {

				if (sellErrTrk['deal_sell_error'] == undefined || sellErrTrk['deal_sell_error'] == null) {

					sellErrTrk['deal_sell_error'] = { 'history': {}, 'nsf': false, 'verifying': false, 'count': 0, 'count_dupes': 0, 'date': new Date() };
				}

				sellErrTrk['deal_sell_error']['nsf'] = sellNSF;
				sellErrTrk['deal_sell_error']['verifying'] = isDealVerifying;
				sellErrTrk['deal_sell_error']['count']++;
				sellErrTrk['deal_sell_error']['date'] = new Date();
			}

			await Common.delay(1000);
		}

		success = true;
	}

	// Single exit. Within the sell path success stays true; finished becomes true only when
	// the deal sells out (status:1). So the signal is DONE when sold out, else CONTINUE. If the
	// deal is not started (unreachable — caller is already in the isStart:1 branch) the defaults
	// keep success:true/finished:false, i.e. CONTINUE, matching dcaFollow's original fall-through.
	return ( finished ? LOOP_DONE : LOOP_CONTINUE );
};


const handleSafetyOrder = async ({ config, exchange, dealId, deal, orders, order, currentOrder, pair, price, priceBuyOrder, profit, i, dealState }) => {

	// Per-tick control state, unpacked from the shared dealState snapshot into local
	// bindings so this handler's own mutations (isDealVerifying / isDealPauseReason /
	// isDealPauseBuy when pausing for buy-order verification) stay local — identical to
	// when these arrived as discrete by-value parameters.
	let { isDealPause, isDealPauseBuy, isDealPauseSell, isDealPauseReason, isDealCancel, isDealPanicSell, isDealVerifying, cancelOnly } = dealState;

	// Working state, local to this handler (was per-iteration / preamble state in dcaFollow).
	let buyError;
	let buySuccess = true;
	let buyOrderId = '';
	let buyOrderPrice;
	let buyOrderInvalid = false;
	let buyOrderStatusInvalid = false;
	let buyNSF = false;
	// Set true once an exchange-cancelled PARTIAL fill has been RETRIED and its actual fill CREDITED
	// into the ladder (see the buyOrderStatusInvalid branch). When set, the deal continues normally
	// (no pause) and handleSuccessfulBuy is skipped — the ladder was already updated by the credit,
	// which recorded the REAL filled quantity rather than the requested one.
	let partialFillCredited = false;
	// isBuy is propagated back to dcaFollow (read after the loop for the 'max safety orders
	// used' log). Returned alongside the loop signal.
	let isBuy = false;

	//Buy DCA

	// Circuit breaker blocks safety order buys
	if (shareData.appData.circuit_breaker_active) {

		Common.logger(colors.yellow.bold('Circuit Breaker Active: ' + shareData.appData.circuit_breaker_active + ' - Blocking safety order for deal ' + dealId));

		return ( { 'result': LOOP_RETRY, 'isBuy': isBuy } );
	}

	isBuy = true;

	const handleSuccessfulBuy = async ({ dealId, orderIndex, buyOrderId, buyOrderPrice, orders, price, currentOrder, exchange, pair, profit }) => {

		let recalcPrice = price;

		if (buyOrderPrice !== undefined && buyOrderPrice !== null && buyOrderPrice !== '' && buyOrderPrice !== 0) {

			recalcPrice = buyOrderPrice;
		}

		const orderUpdated = await updateOrderDeal(dealId, orderIndex, buyOrderId, orders);

		if (shareData.appData.verboseLog) {

			Common.logger(
				colors.blue.bold.italic(
				formatDealStatusLine({
					'pair': pair,
					'qty': currentOrder.qtySum,
					'lastPrice': price,
					'dcaPrice': currentOrder.average,
					'sellPrice': currentOrder.target,
					'status': colors.green('BUY'),
					'profit': profit
				})
			));
		}

		await recalculateOrders({
			'exchange': exchange,
			'dealId': dealId,
			'orderIndex': undefined,
			'orderNo': orderUpdated.orderNo,
			'orderId': undefined,
			'price': recalcPrice,
			'dryRun': false
		});
	};

	if (!config.sandBox) {

		const priceFiltered = await filterPrice(exchange, pair, price);

		// Record safety order trigger for circuit breaker evaluation
		recordSafetyOrderTrigger(dealId, pair, price);

		const buy = await buyOrder({ exchange, dealId, pair, qty: order.qty, price: priceFiltered });

		const handleSuccessfulBuyPostVerify = async () => {

			await handleSuccessfulBuy({
				'dealId': dealId,
				'orderIndex': i,
				'buyOrderId': buy['data']['id'],
				'buyOrderPrice': buy['data_order']['price'],
				'orders': Common.deepCopy(orders),
				'price': price,
				'currentOrder': currentOrder,
				'exchange': exchange,
				'pair': pair,
				'profit': profit
			});

			// Wait before unpausing deal in callback to ensure existing data settles
			await Common.delay(5000);
		};

		// Buy not successful / Buy successful but verification failed 
		if (!buy.success || (buy.success && !buy.success_verify)) {

			buySuccess = false;

			buyOrderInvalid = buy.invalid_order;
			buyOrderStatusInvalid = buy.invalid_status;
			buyError = buy.message;
			buyNSF = buy.nsf;

			let msgErr;
			let msgType;

			// Insufficient funds to buy
			if (buyNSF) {

				msgType = 'deal_error';
				msgErr = 'Insufficient funds to buy order for deal ID ' + dealId + '. Pausing any further buy orders for deal.';
			}
			else if (buyOrderInvalid) {

				const retryMins = 2;

				msgType = 'deal_error';
				msgErr = 'Invalid order for deal ID ' + dealId + '. Pausing buy orders for ' + retryMins + ' minutes.';

				isDealVerifying = true;

				// KNOWN LIMITATION (restart during verification): unlike the base-order verify path — which
				// persists the unverified order ID onto the deal before pausing so the startup resume path can
				// recover it — the in-flight safety-order ID is held only in memory here. If SymBot restarts
				// inside this verification window, resumeDeal cannot find the ID and falls back to clearing the
				// pause and resuming; the fill is not re-verified, so if the order had actually filled, this rung
				// can be bought again (untracked coin). A correct fix must persist the ID AND reconstruct the
				// ladder-recalc credit on resume exactly as handleSuccessfulBuy does (updateOrderDeal +
				// recalculateOrders from the real fill price) — deferred as a dedicated effort. Rare in practice:
				// it needs an unverifiable order AND a restart within the ~retry window.
				const verifyPromise = verifyInvalidOrder({ count: 0, mins: retryMins, exchange, pair, botId: config.botId, dealId, orderId: buy['data']['id'], onSuccessCallback: handleSuccessfulBuyPostVerify, pauseBeforeCallback: false });

				// Reset verifying flag if needed
				verifyPromise.then(async (verifyResult) => {

					if (verifyResult.retriesExhausted || verifyResult.notPaused) {
						clearSellErrorVerifying(dealId);
					}
				}).catch((e) => { try { Common.logger('verifyInvalidOrder (safety buy) background error for deal ' + dealId + ': ' + ((e && e.message) ? e.message : e)); } catch (le) {} });
			}
			else if (buyOrderStatusInvalid) {

				// Exchange returned a terminal-but-not-clean status (e.g. Coinbase CANCELED via "price
				// protection point was breached", or any IOC market order that filled part of the book and
				// canceled the rest). Unlike an unverifiable order (buyOrderInvalid, which we retry), a
				// status-invalid order is final. BUT the exchange may have PARTIALLY FILLED before canceling
				// (buyOrder surfaces that fill in data_order.quantity). When it did, we now:
				//   1. RETRY the unfilled remainder to try to complete the fill (mirrors the sell-side partial
				//      retry), then
				//   2. CREDIT whatever actually filled into the deal ladder — recomputing average / quantity /
				//      take-profit through the shared recalculateOrders — so the coin is booked and the deal
				//      continues instead of stranding it and pausing.
				// If the exchange does not report a usable fill price, or the recompute fails, we fall back to
				// the original SAFE behavior: alert with the exact fill and pause buys for manual reconcile.
				const buyPartialFilled = orderFilledQty(buy);

				msgType = 'deal_error';

				if (buyPartialFilled > 0) {

					const requestedQty = Number(order.qty);
					const buyShortfall = partialFillShortfallPercent(buyPartialFilled, requestedQty);

					if (buyShortfall <= partialSellFillThresholdPercent) {

						// EFFECTIVELY COMPLETE despite the terminal-but-not-clean status. Some exchanges report a
						// fully executed IOC market order with a "partially filled" / canceled status — e.g. Coinbase,
						// where a quote-denominated market buy executes 100% but the requested and executed base
						// amounts differ by a rounding fraction. The fill matched the requested quantity within
						// threshold, so treat it as a NORMAL successful buy: fall through to the clean-fill path
						// (handleSuccessfulBuy below) at the ladder quantity — no retry, no manual/system credit rung,
						// and no "partial" alert. Mirrors the sell side, which accepts a within-threshold fill as
						// complete. Clearing buyOrderStatusInvalid ensures the pause branch is not taken.
						buySuccess = true;
						buyOrderStatusInvalid = false;
						buyOrderId = buy['data']?.['id'];
						buyOrderPrice = Number(buy['data_order']?.['average'] ?? buy['data_order']?.['price'] ?? price);

						Common.logger(colors.green.bold(
							'BUY for deal ID ' + dealId + ' executed ' + buyPartialFilled + ' of ' + requestedQty +
							' (' + (100 - buyShortfall).toFixed(2) + '%) — within threshold; booking as a completed fill despite the exchange status'
						));
					}
					else {

						// Accumulate the NET filled quantity + executed VALUE across the initial partial and any
						// retries, using the shared cross-exchange value precedence (resolveBuyFillValue).
						const initVal = resolveBuyFillValue(buy['data_order'], buyPartialFilled);
						let totalFilledQty   = buyPartialFilled;
						let totalFilledValue = initVal.value;
						let qtyRemaining     = requestedQty - totalFilledQty;

						Common.logger(colors.bgYellow.bold(
							'Partial BUY fill for deal ID ' + dealId +
							' / Requested: ' + requestedQty +
							' / Filled: ' + totalFilledQty +
							' / Remaining: ' + qtyRemaining + ' — retrying the remainder before crediting'
						));

						// #2 — retry the unfilled remainder to complete the fill, through the SHARED partial-fill
						// loop (the same helper the sell side uses). Each attempt buys the outstanding quantity at
						// the current ask; whatever fills is accumulated (value via resolveBuyFillValue) and it
						// stops when within threshold, below the exchange minimum, at the retry cap, or on
						// cancel/panic. Behavior is identical to the previous inline loop — the loop just lives in
						// one place now.
						const retry = await retryPartialFill({
							side: 'buy', exchange, pair, dealId,
							requestedQty, initialFilledQty: buyPartialFilled, fallbackPrice: price,
							placeOrder: ({ qty, price: retryPrice }) => buyOrder({ exchange, dealId, pair, qty, price: retryPrice }),
							onFill: (filled, orderResult) => { totalFilledValue += resolveBuyFillValue(orderResult['data_order'], filled).value; },
							isAborted: () => (isDealCancel || isDealPanicSell),
							logLabel: 'Partial buy'
						});

						totalFilledQty = retry.totalFilled;

						// #1 — credit the ACTUAL total filled quantity into the ladder (recomputes averages + every
						// take-profit target through the shared recalculateOrders). Effective price = value / qty
						// (volume-weighted across all fills), falling back to the reported average/price.
						const creditFillPrice = (totalFilledValue > 0 && totalFilledQty > 0)
							? (totalFilledValue / totalFilledQty)
							: Number(buy['data_order']?.['average'] ?? buy['data_order']?.['price'] ?? 0);

						const credit = await creditPartialBuyFill({ exchange, pair, config, dealId, orderIndex: i, orders, filledQtyNet: totalFilledQty, fillPrice: creditFillPrice, fillValue: totalFilledValue, orderId: buy['data']?.['id'] });

						if (credit.success) {

							// The fill is now booked into the deal — continue normally: no pause, no manual reconcile.
							// handleSuccessfulBuy is skipped (partialFillCredited) because the ladder was already
							// updated here with the REAL filled quantity rather than the requested one.
							buySuccess = true;
							partialFillCredited = true;

							Common.logger(colors.green.bold(
								'Credited exchange-cancelled partial BUY fill for deal ID ' + dealId +
								' / Total filled: ' + totalFilledQty + ' @ ~$' + creditFillPrice +
								' — ladder + take-profit recomputed'
							));

							await Common.sendNotification({
								'message': 'Partial buy fill for deal ID ' + dealId + ' (' + totalFilledQty + ' ' + pair.split('/')[0] + ') was booked into the deal automatically and the take-profit recalculated. No action needed.',
								'type': 'info',
								'telegram_id': shareData.appData.telegram_id
							});
						}
						else {

							// Could not auto-credit (the exchange omitted the fill price, or the recompute failed) —
							// keep the existing SAFE behavior: alert with the exact fill and pause further buys for
							// manual reconciliation. Coin is never left silently stranded.
							const buyPartialPrice = buy['data_order']?.['price'];

							msgErr = 'Exchange-cancelled PARTIAL buy fill for deal ID ' + dealId +
								'. Filled ' + totalFilledQty + ' ' + pair.split('/')[0] +
								(buyPartialPrice != undefined ? ' @ $' + buyPartialPrice : '') +
								' but it could NOT be auto-credited (' + credit.msg + ') — reconcile manually. Pausing further buy orders.';

							Common.logger(colors.bgRed.bold(
								'Exchange-cancelled partial BUY fill for deal ID ' + dealId +
								' / Filled: ' + totalFilledQty +
								' — auto-credit failed (' + credit.msg + '), manual reconciliation required'
							));

							Common.sendNotification({
								'message': `Partial BUY fill for deal ID ${dealId}. Exchange filled ${totalFilledQty} ${pair.split('/')[0]}${buyPartialPrice != undefined ? ' @ $' + buyPartialPrice : ''} then canceled the rest, and it could not be auto-credited — reconcile manually.`,
								'type': 'deal_error',
								'telegram_id': shareData.appData.telegram_id
							});
						}
					}
				}
				else {

					msgErr = 'Buy order for deal ID ' + dealId + ' was canceled by the exchange with no fill. Pausing any further buy orders for deal.';
				}
			}
			else {

				msgType = 'deal_error';
				msgErr = 'An error occurred during buy order for deal ID ' + dealId + '. Pausing any further buy orders for deal.';
			}

			// Pause deal buy orders
			if (msgErr != undefined && msgErr != null && msgErr != '') {

				await sendDealMessage(msgType, msgErr);

				// Only buyOrderInvalid is a genuine in-flight, likely-filled-but-unverified order (it armed
				// verifyInvalidOrder above, which auto-clears the pause on success). It keeps the
				// 'order_verify_buy' reason — the one the sell/stop-loss guard keys on to avoid selling
				// uncredited coin. Insufficient-funds, exchange-cancelled and generic buy failures have NO
				// order in flight and nothing to auto-clear them, so they use a distinct 'buy_error' reason:
				// the deal's BUYS stay paused, but take-profit / stop-loss / panic / cancel can still exit it
				// (there is no pending coin to strand). This mirrors the base-order path, which likewise
				// reserves 'order_verify_buy' for an unverified in-flight order only.
				isDealPauseReason = buyOrderInvalid ? 'order_verify_buy' : 'buy_error';
				const pauseData = await pauseDeal(config.botId, dealId, null, true, null, isDealPauseReason);
				isDealPauseBuy = true;
			}
		}
		else {

			buyOrderId = buy['data']['id'];
			buyOrderPrice = buy['data_order']['price'];
		}
	}

	// Skip when a partial fill was already CREDITED above: creditPartialBuyFill already updated the ladder
	// with the REAL filled quantity (marking the rung filled+manual) and recomputed the take-profit, so
	// running handleSuccessfulBuy would re-mark the rung at the REQUESTED quantity and undo the credit.
	if (buySuccess && !partialFillCredited) {

		await handleSuccessfulBuy({
			'dealId': dealId,
			'orderIndex': i,
			'buyOrderId': buyOrderId,
			'buyOrderPrice': buyOrderPrice,
			'orders': orders,
			'price': price,
			'currentOrder': currentOrder,
			'exchange': exchange,
			'pair': pair,
			'profit': profit
		});
	}

	await updateDealTracker({
				'exchange': exchange,
				'deal_id': dealId,
				'price': price,
				'config': config,
				'orders': orders,
				'pause': isDealPause,
				'pause_buy': isDealPauseBuy,
				'pause_sell': isDealPauseSell,
				'pause_reason': isDealPauseReason,
				'error': buyError
			});

	// Single exit. On buy failure signal RETRY (loop keeps ticking, deal paused); on success
	// result:null tells dcaFollow to fall through to its post-loop logic (incl. the isBuy log).
	// isBuy is propagated either way (it was set true once a buy was attempted).
	const result = buySuccess ? null : LOOP_RETRY;

	return ( { 'result': result, 'isBuy': isBuy } );
};


const dcaFollow = async (configDataObj, exchange, dealId) => {

	let success = true;
	let finished = false;
	let isDealCancel = false;
	let isDealPanicSell = false;
	let isDealPause = false;
	let isDealPauseBuy = false;
	let isDealPauseSell = false;
	let isDealPauseReason = '';
	let isDealVerifying = false;
	let cancelOnly = false;

	let dcaError;

	let { priceSlippageBuyPercent, priceSlippageSellPercent } = await getSlippage(true);

	if (shareData.appData.database_error != undefined && shareData.appData.database_error != null && shareData.appData.database_error != '') {

		Common.logger(colors.red.bold(shareData.appData.database_error + ' - Not processing'));

		return ( LOOP_RETRY );
	}

	if (shareData.appData.system_pause != undefined && shareData.appData.system_pause != null && shareData.appData.system_pause != '') {

		Common.logger(colors.red.bold('System Paused: ' + shareData.appData.system_pause + ' - Not processing deal ' + dealId));

		return ( LOOP_RETRY );
	}

	if (shareData.appData.sig_int) {

		Common.logger(colors.red.bold(shareData.appData.name + ' is terminating. Not processing deal ' + dealId));

		return ( LOOP_RETRY );
	}

	if (dealTracker[dealId] != undefined && dealTracker[dealId] != null && dealTracker[dealId]['update'] != undefined && dealTracker[dealId]['update'] != null) {

		if (dealTracker[dealId]['update']['deal_cancel']) {

			isDealCancel = true;
		}
		
		if (dealTracker[dealId]['update']['deal_panic_sell']) {

			isDealPanicSell = true;
		}

		// Deal stop
		if (dealTracker[dealId]['update']['deal_stop']) {

			Common.logger(colors.red.bold('Deal ID ' + dealId + ' stop requested. Not processing'));
	
			return ( LOOP_STOPPED );
		}

		// Refresh config without restarting deal
		if (dealTracker[dealId]['update']['config']) {

			const configRefresh = JSON.parse(JSON.stringify(dealTracker[dealId]['update']['config']));

			delete dealTracker[dealId]['update']['config'];

			return ( loopContinueWithConfig(configRefresh) );
		}

		// Deal sell error
		if (dealTracker[dealId]['update']['deal_sell_error']) {

			let isMaxError = false;

			let diffSec = (new Date().getTime() - new Date(dealTracker[dealId]['update']['deal_sell_error']['date']).getTime()) / 1000;

			if (dealTracker[dealId]['update']['deal_sell_error']['verifying']) {

				isDealVerifying = true;
			}

			if (dealTracker[dealId]['update']['deal_sell_error']['count'] > maxSellErrorCount) {

				isMaxError = true;

				let msg = 'WARNING: Unable to sell deal ID ' + dealId + '. Check the logs for details.';

				Common.logger(colors.red.bold(msg));

				Common.sendNotification({ 'message': msg, 'type': 'warning', 'telegram_id': shareData.appData.telegram_id });
			}

			const timeReset = diffSec > maxSellErrorResetSec;

			if (!isDealVerifying && (isMaxError || timeReset)) {

				delete dealTracker[dealId]['update']['deal_sell_error'];

				// On the time-based reset (a generic sell error has had time to clear) also lift the sell
				// pause that the error set, so take-profit / stop-loss can fire again and the deal is not
				// stranded waiting for a manual resume. Scoped to the 'sell_error' reason only (the generic,
				// non-verifying error) and NOT done on the max-error give-up path, which deliberately keeps
				// the deal paused for attention (a panic sell still works there). Best-effort and read-guarded.
				if (timeReset && !isMaxError) {

					try {

						const dealSellErr = await Deals.findOne({ dealId, status: 0 });

						if (dealSellErr && Common.convertBoolean(dealSellErr.pausedSell, false) && dealSellErr.pauseReason === 'sell_error') {

							await pauseDeal(configDataObj.botId, dealId, null, null, false, '');

							await sendDealMessage('info', 'Deal ID ' + dealId + ' sell pause (transient sell error) auto-cleared; resuming sell monitoring.');
						}
					}
					catch (e) {}
				}
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

				// Problem getting symbol data. Only allow cancel
				cancelOnly = true;

				dcaError = symbolData.error;

				//success = false;

				//return ( { 'success': success, 'finished': finished } );
			}

			const bidPrice = symbol?.bid ?? 0;
			const askPrice = symbol?.ask ?? 0;

			const price = parseFloat(bidPrice);

			// Invalid price
			if (price == undefined || price == null || price == '' || price === 0) {

				cancelOnly = true;

				let msg = 'Invalid Price: ' + price + ' / Pair: ' + pair + ' / Deal ID: ' + dealId;

				if (shareData.appData.verboseLog) {
					
					Common.logger(colors.red.bold(msg));
				}

				// Track consecutive zero-price events per deal
				if (!shareData.appData.cb_price_zero_tracker) shareData.appData.cb_price_zero_tracker = {};
				const pzt = shareData.appData.cb_price_zero_tracker;
				pzt[dealId] = (pzt[dealId] || 0) + 1;

				const cbCfg = shareData.appData.circuit_breaker;
				const zeroAlertThreshold = (cbCfg && cbCfg.price_zero_alert_count) || 4;

				if (pzt[dealId] >= zeroAlertThreshold) {

					if (cbCfg && cbCfg.enabled) {

						Common.sendNotification({
							'message': `⚠️ Invalid Price: 0\n\nPair: ${pair}\nDeal ID: ${dealId}\n\nPrice feed has returned 0 ${pzt[dealId]} consecutive times. The exchange may have an issue with this pair.`,
							'type': 'warning',
							'telegram_id': shareData.appData.telegram_id
						});
					}

					// Reset counter after alert (or threshold reached) so it doesn't accumulate
					pzt[dealId] = 0;
				}
			}
			else {

				// Valid price — reset zero counter for this deal
				if (shareData.appData.cb_price_zero_tracker) {
					shareData.appData.cb_price_zero_tracker[dealId] = 0;
				}
			}

			// Plausibility guard (IN ADDITION to the zero check above). During an
			// exchange auth/connectivity disruption fetchTicker can RETURN a nonzero
			// but wildly wrong price (seen 2026-08-12: WAL $0.0238 → $65.11). That
			// price would cross the take-profit target and close the deal at an
			// impossible profit. Reject any nonzero price that deviates beyond the
			// configured band from the deal's own DCA average (its known-good anchor)
			// and hold the deal exactly like an invalid price — never compute profit
			// against it, buy, or sell on it. Covers the resume/recovery path too:
			// resumed deals follow through this same tick loop (runFollowLoop →
			// dcaFollow), so a deal cannot finalize on the first post-recovery fetch.
			if (price > 0) {

				const filledForRef = (deal.orders || []).filter(item => item.filled == 1);
				const refOrder = filledForRef[filledForRef.length - 1];
				const referencePrice = refOrder ? refOrder.average : null;

				const cbCfgPrice = shareData.appData.circuit_breaker || {};

				const sanity = PriceGuard.evaluatePriceSanity({
					'price': price,
					'reference': referencePrice,
					'maxHighRatio': cbCfgPrice.price_deviation_high_ratio,
					'maxLowRatio': cbCfgPrice.price_deviation_low_ratio
				});

				if (!sanity.plausible) {

					// Treat exactly like an invalid price: only allow cancel, surface
					// the error on the deal, and fall through to the hold path below.
					cancelOnly = true;
					dcaError = 'Implausible Price: ' + sanity.message + ' / Pair: ' + pair + ' / Deal ID: ' + dealId;

					Common.logger(colors.red.bold(dcaError));

					// Track consecutive implausible-price events per deal and alert like
					// the zero-price case, so a persistently bad feed is surfaced rather
					// than a deal silently sitting on hold forever.
					if (!shareData.appData.cb_price_implausible_tracker) { shareData.appData.cb_price_implausible_tracker = {}; }
					const pit = shareData.appData.cb_price_implausible_tracker;
					pit[dealId] = (pit[dealId] || 0) + 1;

					const implausibleAlertThreshold = (cbCfgPrice && cbCfgPrice.price_implausible_alert_count) || 4;

					if (pit[dealId] >= implausibleAlertThreshold) {

						if (cbCfgPrice && cbCfgPrice.enabled) {

							Common.sendNotification({
								'message': `⚠️ Implausible Price\n\nPair: ${pair}\nDeal ID: ${dealId}\n\n${sanity.message}\n\nThe deal is being HELD (not closed) until the price feed is sane again.`,
								'type': 'warning',
								'telegram_id': shareData.appData.telegram_id
							});
						}

						// Reset counter after alert so it doesn't accumulate
						pit[dealId] = 0;
					}
				}
				else {

					// Plausible price — reset implausible counter for this deal
					if (shareData.appData.cb_price_implausible_tracker) {
						shareData.appData.cb_price_implausible_tracker[dealId] = 0;
					}
				}
			}

			let targetPrice = 0;

			let orders = deal.orders;

			isDealPause = Common.convertBoolean(deal.paused, false);
			isDealPauseBuy = Common.convertBoolean(deal.pausedBuy, false);
			isDealPauseSell = Common.convertBoolean(deal.pausedSell, false);
			// Re-read the pause REASON from the deal each tick too (it's a string, not a
			// boolean). The extracted handlers (handleSafetyOrder / handleSell) set the
			// reason on their own local copy when they pause a deal for order verification;
			// that local mutation does not propagate back here. Without refreshing it from
			// the deal, the idle-arm updateDealTracker below would send pause_reason:'' on
			// every subsequent paused tick, so the UI never renders the "system paused"
			// (order_verify_buy) banner even though the deal is correctly paused.
			isDealPauseReason = deal.pauseReason || '';

			// Bundle the deal's per-tick control state (pause / cancel / panic-sell /
			// verifying / cancelOnly) into a single snapshot shared by all three order
			// handlers, so each receives it through one `dealState` parameter instead of
			// eight discrete flags. Built here, after every flag above has settled for this
			// tick. Each handler destructures these into its OWN local bindings, so a
			// handler flipping a flag (e.g. isDealVerifying while pausing for order
			// verification) stays local to that handler exactly as before — dealState is a
			// read-only snapshot and is never mutated in place.
			const dealState = {
				'isDealPause': isDealPause,
				'isDealPauseBuy': isDealPauseBuy,
				'isDealPauseSell': isDealPauseSell,
				'isDealPauseReason': isDealPauseReason,
				'isDealCancel': isDealCancel,
				'isDealPanicSell': isDealPanicSell,
				'isDealVerifying': isDealVerifying,
				'cancelOnly': cancelOnly
			};

			if (deal.isStart == 0) {

				const baseResult = await handleBaseOrder({
					config, exchange, dealId, deal, orders, pair, price,
					dcaError, dealState
				});

				return ( baseResult );
			}
			else {

				const filledOrders = orders.filter(item => item.filled == 1);
				const unfilledOrders = orders.filter(item => item.filled != 1);
				const currentOrder = filledOrders.pop();

				const profitData = await calculateProfit(exchange, pair, price, currentOrder.average, currentOrder.sum, config.dcaTakeProfitPercent, config.exchangeFee, config.sandBox);

				let profit = profitData['profit_percentage'];
				let profitBase = profitData['profit_base'];
				let profitQuote = profitData['profit'];

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

				// Stop-loss (#104a). A deal-level threshold, so evaluated ONCE here — before
				// the per-order safety/sell loop — using the DCA average already in
				// currentOrder. When it fires the deal is closed at market through the SAME
				// path panic_sell uses (handleSell), recorded with a distinct stopLoss reason.
				// Gated so it can NEVER fire on an implausible price (cancelOnly, from the
				// plausibility guard) and never overrides an explicit user close or a
				// paused/verifying sell. Precedence stop-loss > safety-buy is enforced by the
				// !isDealStopLoss term on the safety-order condition below, so a stopping deal
				// never buys another safety order on the same tick. Default-off: with
				// dcaStopLossEnabled false, isDealStopLoss stays false and every loop condition
				// is unchanged. Both the hard loss-cut and the move-to-breakeven ratchet run here;
				// the ratchet persists onto the deal so it survives restarts (Stage 4).
				let isDealStopLoss = false;
				let suppressTakeProfit = false;

				// Read stop-loss settings from the freshly-read deal.config (not the frozen
				// follow config) so a live per-deal edit takes effect on the next tick with no
				// stop/resume. deal is re-read from the DB every tick (Deals.findOne above).
				const dealCfg = deal.config || {};

				if (dealCfg.dcaStopLossEnabled || dealCfg.dcaTrailingStopEnabled) {

					// Deepest safety-order price — only needed for reference='lastSafetyOrder'.
					let lastSafetyOrderPrice = null;

					if (String(dealCfg.dcaStopLossReference).toLowerCase() === 'lastsafetyorder') {

						for (let s = 0; s < orders.length; s++) {

							const op = Number(orders[s].price);

							if (Number.isFinite(op) && op > 0 && (lastSafetyOrderPrice === null || op < lastSafetyOrderPrice)) {

								lastSafetyOrderPrice = op;
							}
						}
					}

					// Trailing stop (#104b): maintain the per-deal high-water-mark once trailing has
					// activated (profit >= activation); the pure guard then trails the stop a configured
					// distance below that peak. Read from the live deal.config like the stop-loss above.
					const trailEnabled = StopLoss.toBool(dealCfg.dcaTrailingStopEnabled);
					const trailDist = StopLoss.toNum(dealCfg.dcaTrailingStopDistance);
					const trailActivate = StopLoss.toNum(dealCfg.dcaTrailingActivateProfit);

					const trailActiveNow = trailEnabled && trailDist !== null && trailDist > 0
						&& trailActivate !== null && profitPerc >= trailActivate;

					let trailHigh = StopLoss.toNum(deal.trailHighPrice);

					if (trailActiveNow && price > 0) {

						trailHigh = (trailHigh === null || trailHigh <= 0) ? price : Math.max(trailHigh, price);
					}

					const slDecision = StopLoss.evaluate({
						'enabled': dealCfg.dcaStopLossEnabled,
						'price': price,
						'average': currentOrder.average,
						'stopLossPercent': dealCfg.dcaStopLossPercent,
						'reference': dealCfg.dcaStopLossReference,
						'lastSafetyOrderPrice': lastSafetyOrderPrice,
						'feeRate': config.exchangeFee,
						'moveBreakeven': dealCfg.dcaStopLossMoveBreakeven,
						'breakevenTrigger': dealCfg.dcaStopLossBreakevenTrigger,
						'profitPercentage': profitPerc,
						'breakevenArmed': deal.stopLossBreakevenArmed,
						'activeStopLossPrice': deal.activeStopLossPrice,
						'trailingEnabled': dealCfg.dcaTrailingStopEnabled,
						'trailingDistance': dealCfg.dcaTrailingStopDistance,
						'trailingActivateProfit': dealCfg.dcaTrailingActivateProfit,
						'trailHighPrice': trailHigh
					});

					// Ratchet persistence: write once when break-even arms, the trailing high-water
					// advances, or the effective LOCKED stop rises. The deal is re-read from the DB each
					// tick, so these restore automatically on later ticks and across a restart. The base
					// (loss) stop is NOT persisted — only the up-only lock levels (break-even / trailing).
					const slPersist = {};

					if (slDecision['breakevenArmed'] && !deal.stopLossBreakevenArmed) {

						slPersist['stopLossBreakevenArmed'] = true;
					}

					if (trailHigh !== null && trailHigh > 0 && trailHigh !== StopLoss.toNum(deal.trailHighPrice)) {

						slPersist['trailHighPrice'] = trailHigh;
					}

					const slLockEngaged = slDecision['breakevenArmed'] || slDecision['trailingActive'];
					const slPersistedLevel = StopLoss.toNum(deal.activeStopLossPrice) || 0;

					if (slLockEngaged && slDecision['level'] != undefined && slDecision['level'] > slPersistedLevel) {

						slPersist['activeStopLossPrice'] = slDecision['level'];
					}

					if (Object.keys(slPersist).length > 0) {

						await updateDeal(deal.botId, dealId, slPersist);

						if (slPersist['stopLossBreakevenArmed']) {

							Common.logger(colors.yellow.bold('Deal ID ' + dealId + ' stop-loss moved to break-even at ' + slDecision['level'] + ' / Pair: ' + pair));
						}
						else if (slPersist['activeStopLossPrice'] != undefined) {

							Common.logger(colors.cyan.bold('Deal ID ' + dealId + ' trailing stop raised to ' + slDecision['level'] + ' (peak ' + trailHigh + ') / Pair: ' + pair));
						}
					}

					if (slDecision['triggered']
						&& !cancelOnly
						&& !isDealPanicSell && !isDealCancel
						&& !isDealPauseSell && !isDealVerifying
						&& isDealPauseReason !== 'order_verify_buy') {

						// order_verify_buy = a safety-order buy is placed and in background verification
						// (likely filled but not yet credited). Do not arm the stop-loss until it resolves,
						// or we would sell only the credited qty and strand the pending buy's coin. Mirrors
						// how order_verify_sell blocks this gate via isDealPauseSell.
						isDealStopLoss = true;

						Common.logger(colors.red.bold('Deal ID ' + dealId + ' STOP-LOSS triggered: ' + slDecision['message'] + ' / Pair: ' + pair));
					}

					// Mode B: while trailing is active, suppress the fixed take-profit so the deal rides
					// the run-up (protected by the trailing stop). Per-deal toggle dcaTrailingReplacesTakeProfit
					// (default on). The trailing stop is the exit; the fixed TP is only paused, only while active.
					if (slDecision['trailingActive'] && StopLoss.toBool(dealCfg.dcaTrailingReplacesTakeProfit)) {

						suppressTakeProfit = true;
					}
				}

				for (let i = 0; i < orders.length; i++) {

					let buyOrderId = '';
					let buyOrderPrice;
					let buyOrderInvalid = false;
					let buyOrderStatusInvalid = false;
					let buyNSF = false;

					const order = orders[i];

					// Check if max safety orders used, otherwise sell order condition will not be checked
					if (order.filled == 0 || maxSafetyOrdersUsed) {

						const priceBuyOrder = parseFloat(Number(order.price) - (Number(order.price) * priceSlippageBuyPercent));
						const priceSellOrder = parseFloat(Number(currentOrder.target) + (Number(currentOrder.target) * priceSlippageSellPercent));

						if ((price <= priceBuyOrder && order.filled == 0) && !cancelOnly && !isDealStopLoss && !isDealPause && !isDealPauseBuy && !isDealCancel && !isDealPanicSell) {

							const safetyResult = await handleSafetyOrder({
								config, exchange, dealId, deal, orders, order, currentOrder, pair, price,
								priceBuyOrder, profit, i, dealState
							});

							// Propagate isBuy (read after the loop for the 'max safety orders used' log).
							isBuy = safetyResult['isBuy'];

							// A non-null result is a loop-exit/retry signal; null means the buy succeeded
							// and the deal keeps following (fall through to the post-loop logic).
							if (safetyResult['result'] != null) {

								return ( safetyResult['result'] );
							}
						}
						// A panic-sell / cancel / stop-loss must NOT fire while a prior sell order is still
						// unresolved, or it would place a SECOND live sell for coin that is already committed
						// (real-account oversell → subsequent insufficient-funds). The price-based take-profit
						// term is already blocked by !isDealPauseSell, but the OR'd panic/cancel/stop terms
						// bypass that guard — so gate the whole branch on there being no sell order in flight.
						// 'order_verify_sell' = a sell was placed and is being verified; 'sell_finalize_error' =
						// a sell verified as filled but the close failed to finalize (coin already gone). Both
						// clear once the verification resolves (or the user manually resumes), after which a
						// panic proceeds normally and places exactly one order.
						// 'order_verify_buy' = a safety-order BUY is placed and in background verification
						// (likely filled but not yet credited). Selling now — take-profit, stop-loss, panic or
						// cancel — would sell only the credited qty and strand the pending buy's coin, and the
						// post-close reconcile (status:0 filter) would never pick it up. Block the whole branch
						// until the buy resolves, exactly as for a sell in flight.
						else if (isDealPauseReason !== 'order_verify_sell' && isDealPauseReason !== 'sell_finalize_error' && isDealPauseReason !== 'order_verify_buy' && ((price >= priceSellOrder && !cancelOnly && !suppressTakeProfit && !isDealVerifying && !isDealPause && !isDealPauseSell) || isDealCancel || isDealPanicSell || isDealStopLoss)) {

							const sellResult = await handleSell({
								config, exchange, dealId, deal, orders, order, currentOrder, filledOrders,
								pair, price, priceSellOrder, profit, profitBase, profitQuote, profitPerc,
								dealState, isDealStopLoss
							});

							return ( sellResult );
						}
						else {

							await updateDealTracker({
										'exchange': exchange,
										'deal_id': dealId,
										'price': price,
										'config': config,
										'orders': orders,
										'pause': isDealPause,
										'pause_buy': isDealPauseBuy,
										'pause_sell': isDealPauseSell,
										'pause_reason': isDealPauseReason,
										'error': dcaError,
										'stop_loss_breakeven_armed': deal.stopLossBreakevenArmed,
										'active_stop_loss_price': deal.activeStopLossPrice,
										'trail_high_price': deal.trailHighPrice
									});

							//let nextOrder = currentOrder.price;
							let nextOrder = unfilledOrders.find(order => Number(order.orderNo) == Number(currentOrder.orderNo) + 1) || null;

							if (nextOrder == undefined || nextOrder == null) {
							
								nextOrder = 'N/A';
							}
							else {

								nextOrder = nextOrder.price;
								nextOrder = parseFloat(Number(nextOrder) - (Number(nextOrder) * priceSlippageBuyPercent));

								nextOrder = Common.adjustDecimals(nextOrder, price, currentOrder.average, currentOrder.target);
							}

							if (shareData.appData.verboseLog) {
							
								Common.logger(
								formatDealStatusLine({
									'pair': pair,
									'lastPrice': price,
									'dcaPrice': currentOrder.average,
									'target': currentOrder.target,
									'nextOrder': nextOrder,
									'profit': profit
								})
								);
							}
						}

						count++;

						break;
					}
				}

				if (maxSafetyOrdersUsed && isBuy) {

					if (shareData.appData.verboseLog) { Common.logger( colors.bgYellow.bold(pair + ' Max safety orders used.') + '\tLast Price: ' + formatPrice(pair, price) + '\tTarget: ' + formatPrice(pair, currentOrder.target) + '\tProfit: ' + profit); }
					
					//await Common.delay(2000);
				}

			}

			// Delay before following again
			await Common.delay(2000);

			return ( loopSignal(success, finished) );
		}
		else {

			// Deal no longer exists in the database (e.g. deleted after verification
			// retries were exhausted, or canceled/closed elsewhere). There is nothing
			// left to follow, so signal the loop to stop rather than spin on a missing
			// deal. finished stays authoritative for runFollowLoop's exit condition.
			finished = true;

			if (shareData.appData.verboseLog) { Common.logger('No deal ID found for ' + config.pair); }
		}
	}
	catch (e) {

		success = false;

		Common.logger((e && (e.stack || e.message)) || JSON.stringify(e));
	}

	return ( loopSignal(success, finished) );
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

				// Build a concise, single-line error string for logging and display. A ccxt network error can
				// carry the entire fetched response body in .message (a failed /currencies call is ~10KB of
				// JSON), which would otherwise flood the log and every resume-retry line. Keep the error name,
				// a bounded message, and the underlying network cause code (ECONNREFUSED / ETIMEDOUT /
				// ENETUNREACH …) so the failure is self-diagnosing. Control flow above keys off `e instanceof`,
				// never this string, so reformatting it is display-only and safe.
				const errName = symbolError.name ? String(symbolError.name) : 'Error';

				let detail = (symbolError.message != undefined && symbolError.message != null) ? String(symbolError.message) : '';
				detail = detail.split('\n')[0];
				if (detail.length > 300) { detail = detail.slice(0, 300) + '…'; }

				const causeCode = symbolError.cause && (symbolError.cause.code || symbolError.cause.errno || symbolError.cause.message);
				const causeStr = causeCode ? ' [' + String(causeCode).split('\n')[0].slice(0, 80) + ']' : '';

				symbolError = errName + (detail ? ': ' + detail : '') + causeStr;
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
			else if (e instanceof ccxt.AuthenticationError) {

				// v6.0 builds exchange clients with ccxt.pro (WebSocket) AND API
				// credentials (see connectExchange), so even a "public" ticker read
				// rides an authenticated socket. A key / clock / nonce disruption at the
				// exchange therefore surfaces here as an AuthenticationError on a ticker
				// call. AuthenticationError extends ExchangeError, so without this branch
				// it would fall into the retry branch below and be retried up to maxTries
				// per tick — futile (a broken auth session will not fix itself within a
				// few hundred ms) and wasteful during an auth storm. Finish immediately
				// with the error set; the caller sees symbolData.error and holds the deal
				// (cancelOnly). Never act on a price from a broken auth session.
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

		// Robust decimal-place count — amountFinal below ~1e-6 stringifies in exponential form
		// ("2e-7"), where the old `.split('.')[1].length` threw and stalled order sizing on
		// high-precision coins. countDecimals handles both forms and matches the old value otherwise.
        let decimalPrecision = Common.countDecimals(amountFinal);

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
		if (!(e instanceof ccxt.InvalidOrder)) {

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
		if (!(e instanceof ccxt.InvalidOrder)) {

			let errMsg = 'FILTER PRICE ERROR: ' + e.name + ' ' + e.message;

			if (typeof errMsg != 'string') {

				errMsg = JSON.stringify(errMsg);
			}

			Common.logger(errMsg);
		}

		return false;
	}
};



// Centralized start-permission check.
// Runs only the checks specified in the `checks` object and returns
// { allowed: bool, reason: string } so every callsite has one place
// to consult for limit logic.
//
// Normalization (pairMax / pairDealsMax → 0 when blank/null/undefined)
// is always applied regardless of which checks are requested.
//
// checks:
//   blacklist        – pair must not be on the blacklist
//   pairMax          – active pairs on this bot must be below pairMax
//   pairDealsMax     – active deals for this pair must be below pairDealsMax
//   globalPairLimit  – same pair across all bots must be below pairBotsDealsMax
//   dealsActiveZero  – no active deals for this pair (asap / enable / update paths)
//
const canStartDeal = async ({ pair, config, pairCount = 0, dealsActive = [] }) => {

	const pairMax          = Number(config.pairMax)          || 0;
	const pairDealsMax     = Number(config.pairDealsMax)     || 0;
	const pairBotsDealsMax = Number(config.pairBotsDealsMax) || 0;

	let allowed = true;
	let reason  = '';

	// Circuit breaker is the first gate — checked before any DB queries.
	// Enforced here rather than in individual signal clients so that ALL
	// deal-start paths (3CQS signals, manual API, webhooks, future clients)
	// are blocked consistently and receive a clear reason in the response.
	if (shareData.appData.circuit_breaker_active) {

		return {
			allowed: false,
			reason:  'Circuit Breaker Active: ' + shareData.appData.circuit_breaker_active
		};
	}

	const isPairBlackListed        = await Common.pairBlackListed(pair);
	const globalPairLimitExceeded  = await checkGlobalPairLimit(pairBotsDealsMax, pair);

	if (isPairBlackListed) {

		allowed = false;
		reason  = 'Pair is blacklisted';
	}
	else if (globalPairLimitExceeded) {

		allowed = false;
		reason  = `${pair} global max of ${pairBotsDealsMax} deals already running across all bots`;
	}
	else if (pairMax > 0 && pairCount >= pairMax) {

		allowed = false;
		reason  = 'Bot max ' + pairMax + ' pairs reached';
	}
	else if (dealsActive.length > 0) {

		// Per-pair deals max check:
		// - If pairDealsMax > 1: block when that limit is reached
		// - If pairDealsMax <= 1 (default): block if any active deal exists for this pair
		//   (only enforced when dealsActive is explicitly passed — dcaFollow passes [] to skip this)
		if (pairDealsMax > 1 && dealsActive.length >= pairDealsMax) {

			allowed = false;
			reason  = pair + ' pair max ' + pairDealsMax + ' deals already running';
		}
		else if (pairDealsMax <= 1) {

			allowed = false;
			reason  = pair + ' already has an active deal';
		}
	}

	return { allowed, reason };
};


const checkGlobalPairLimit = async (pairBotsDealsMax, pair) => {

	let globalPairLimitExceeded = false;

	if (pairBotsDealsMax == undefined || pairBotsDealsMax == null || pairBotsDealsMax == '') {

		pairBotsDealsMax = 0;
	}

	if (pairBotsDealsMax > 0) {

		let allDealsForPair = await getDeals({ 'pair': pair, 'status': 0 });

		if (allDealsForPair.length >= pairBotsDealsMax) {

			globalPairLimitExceeded = true;
		}
	}

	return globalPairLimitExceeded;
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

		Common.logger((e && (e.stack || e.message)) || JSON.stringify(e));
	}
};


const getDealsMaxUsedFunds = async (maxDealsPerBot = 1, useConfig = false) => {

	const bots = await getBots();

	let botIds = bots?.map(bot => bot.botId) || [];

	const results = botIds.length ?
		await getDeals(
			null,
			null,
			null,
			DbQueries.dealsMaxUsedFundsPipeline({
					status: [null, 0, 1]
				},
				botIds,
				null,
				maxDealsPerBot
			)
		) : [];

	if (useConfig) {

		try {

			for (let i in results) {

				let totalSum = 0;
				let lastSumArr = [];

				let botObj = results[i];

				const pairMax = Math.max(parseInt(botObj['botConfig']['pairMax']), 1);
				const pairDealsMax = Math.max(parseInt(botObj['botConfig']['pairDealsMax']), 1);

				const botMaxDeals = Math.round(pairMax * pairDealsMax);

				const resultsBot = await getDeals(
					null,
					null,
					null,
					DbQueries.dealsMaxUsedFundsPipeline({
						status: [null, 0, 1]
					},
						botObj['botId'],
						null,
						botMaxDeals
					)
				);

				const config = results[i]['botConfig'];
				const maxFundsObj = await calculateMaxFunds(config);

				const mergedBot = resultsBot[0];

				results[i] = {
					...mergedBot,
					...maxFundsObj
				};

				for (let d in results[i]['deals']) {

					const deal = results[i]['deals'][d];

					const lastSum = deal['lastSum'];

					lastSumArr.push(lastSum);
					totalSum += Number(lastSum)
				}

				results[i]['bot_max_funds_exposure'] = Math.round(totalSum * 100) / 100;
			}
		}
		catch(e) {}
	}

	return {
		success: bots && bots.length > 0,
		data: results
	};
};


const getDeals = async (query, options, projection, aggregatePipeline = null) => {

	query = query || {};
	options = options || {};
	projection = projection || {};

	try {

		if (aggregatePipeline && Array.isArray(aggregatePipeline)) {

			return await Deals.aggregate(aggregatePipeline);
		}
		else {

			return await Deals.find(query, projection, options);
		}
	}
	catch (e) {

		Common.logger((e && (e.stack || e.message)) || JSON.stringify(e));
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

		Common.logger((e && (e.stack || e.message)) || JSON.stringify(e));
	}
};


const deleteBot = async (query) => {

	try {

		const result = await Bots.deleteOne(query);
		return result.deletedCount > 0;
	}
	catch (e) {

		Common.logger('deleteBot error: ' + JSON.stringify(e));
		return false;
	}
};


const deleteDeals = async (query) => {

	try {

		const result = await Deals.deleteMany(query);
		return result.deletedCount;
	}
	catch (e) {

		Common.logger('deleteDeals error: ' + JSON.stringify(e));
		return 0;
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
		let pageCount = 0;

		while (true) {

			// Hard cap on pagination pages. The loop normally breaks when the exchange stops advancing
			// next_starting_after, but a cursor that ALTERNATES between two values would never satisfy that
			// equality check and loop forever (500ms apart). 200 pages × 100 = far more balances than any
			// real account, so this only ever trips on a misbehaving exchange response.
			if (++pageCount > 200) {

				Common.logger('getBalance: pagination page cap (200) reached — stopping to avoid a non-terminating loop.');
				break;
			}

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

		// Concise, single-line error (a ccxt error can carry a many-KB JSON body). This string is BOTH logged
		// and returned — it surfaces in the bot-preview alert — so keeping it short helps everywhere.
		errMsg = 'BALANCE ERROR: ' + ((e && e.name) ? e.name + ' ' : '') + summarizeExchangeError(e);

		// Throttle the LOG only: during an outage this fires several times a minute with the identical error.
		// Log the first per exchange+error within the window and suppress the repeats; the returned value is
		// unchanged, so callers behave exactly as before.
		const logKey = ((exchange && exchange.id) || 'exchange') + ':' + ((e && e.name) ? e.name : 'error');
		const nowMs = Date.now();

		if (nowMs - (balanceErrorLogged[logKey] || 0) > balanceErrorLogWindowMs) {

			balanceErrorLogged[logKey] = nowMs;
			Common.logger(errMsg + ' — repeats within ' + Math.round(balanceErrorLogWindowMs / 1000) + 's suppressed');
		}
	}

	return { 'success': success, 'balance': balance, 'error': errMsg };
};


const getOHLCV = async (exchange, pair, timeframe, since, limit) => {

	let data;
	let success = false;

	pair = (pair ?? '').replace(/[_-]/g, '/');

	// Only try if exchange supports fetchOHLCV
	if (exchange != undefined && exchange != null && exchange.has['fetchOHLCV']) {

		try {

			success = true;

			data = await exchange.fetchOHLCV(pair, timeframe, since, limit);
		}
		catch(e) {

			success = false;

			data = 'ERROR: ' + e.name + ' ' + e.message;
		}
	}
	else {
		
		data = 'fetchOHLCV not supported by exchange';
	}

	const dataObj = { 
						'success': success,
						'pair': pair,
						'data': data
					};

	if (shareData.appData.verboseLog) {
		
		Common.logger(dataObj);
	}

	return dataObj;
}


const getOrder = async (exchange, orderId, pair, dealId) => {

	const days = 1;
	const limit = 500;
	const maxTries = 15;

	let success = false;
	let finished = false;
	let orderInvalid = false;
	let timeOut = false;
	let count = 0;

	let order;
	let errMsg;
	let orderStatus;

	// Only try if exchange supports fetchOrders
	if (exchange != undefined && exchange != null && exchange.has['fetchOrders']) {

		while (!finished) {

			try {

				let since = exchange.milliseconds() - (86400000 * days);

				let ordersAll = await exchange.fetchOrders(pair, since, limit);

				if (ordersAll != undefined && ordersAll != null && Array.isArray(ordersAll) && ordersAll.length > 0) {

					for (let orderObj of ordersAll) {
			
						let id = orderObj['id'];
			
						// Found matching order id
						if (id == orderId) {
			
							order = orderObj;
			
							orderStatus = order.status;
							orderStatus = orderStatus?.toLowerCase();
			
							success = true;
			
							break;
						}
					}
				}

				if (!success) {

					orderInvalid = true;
				}

				errMsg = null;
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

					// Delay and try again
					await Common.delay(500 + (Math.random() * 100));
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

		// Mimic closed order response since fetchOrders is not supported
		order = {};
		order['status'] = 'closed'; 
		order['_message'] = 'fetchOrders not supported by exchange';

		success = true;
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


const verifyExchangeOrder = async (exchange, orderId, pair, dealId) => {

	const maxSec = 75;
	const maxTries = 15;

	let success = true;
	let finished = false;
	let timeOutOrder = false;
	let timeOutVerify = false;
	let orderInvalid = false;
	let statusInvalid = false;

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

				if (invalidCount >= maxTries) {

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

				statusInvalid = true;

				success = false;
				finished = true;
			}
		}
	}

	msg = 'Verify Order Complete. Order ID: ' + orderId + ' / Pair: ' + pair + ' / Deal ID: ' + dealId + ' / Success: ' + success;

	if (orderInvalid) {

		let msgWarn = 'WARNING: Unable to verify order on exchange. Manual verification is strongly recommended.';

		msg += ' / ' + msgWarn;

		Common.sendNotification({ 'message': msg, 'type': 'deal_error', 'telegram_id': shareData.appData.telegram_id });
	}

	const dataObj = { 
						'success': success,
						'message': msg,
						'data': order,
						'status': orderStatus,
						'attempts': orderCount,
						'invalid_order': orderInvalid,
						'invalid_status': statusInvalid,
						'timeout_order': timeOutOrder,
						'timeout_verify': timeOutVerify,
						'error': errMsg
					}; 

	Common.logger(dataObj);

	return dataObj;
}


const verifyBuySellOrder = async (exchange, orderId, pair, dealId) => {

	let success = false;
	let finished = false;
	let orderInvalid = false;
	let statusInvalid = false;

	let orderAmount = null;
	let orderQty = null;
	let orderPrice = null;
	let orderAverage = null;

	if (orderId) {

		while (!finished) {

			let orderVerify = await verifyExchangeOrder(exchange, orderId, pair, dealId);

			if (orderVerify.success) {

				// Verification successful
				const orderVerifyData = orderVerify.data;

				orderAmount = orderVerifyData.cost;
				orderQty = orderVerifyData.filled ?? orderVerifyData.amount;
				orderPrice = orderVerifyData.price;

				// CCXT unified 'average' is the volume-weighted fill price. Where an
				// exchange populates it, it is more accurate than 'price' (which is the
				// requested price on many exchanges) and needs no derivation from cost.
				// Not all exchanges provide it, so it is captured opportunistically.
				orderAverage = orderVerifyData.average ?? null;

				success = true;
				finished = true;
			}
			else {

				// Verification failed
				if (orderVerify.timeout_order || orderVerify.timeout_verify) {

					// Handle timeouts and retry
					await Common.delay(1000);
				}
				else {

					if (orderVerify.invalid_order) {

						orderInvalid = true;
					}

					if (orderVerify.invalid_status) {

						statusInvalid = true;

						// Capture partial fill qty even when exchange cancels the order
						// (e.g. Coinbase price protection cancels after partial fill)
						if (orderVerify.data) {

							const partialFilled = orderVerify.data.filled ?? null;
							if (partialFilled !== null && Number(partialFilled) > 0) {

								orderQty    = Number(partialFilled);
								orderAmount = orderVerify.data.cost ?? null;
								orderPrice  = orderVerify.data.price ?? null;
								orderAverage = orderVerify.data.average ?? null;
							}
						}
					}

					success = false;
					finished = true;
				}
			}
		}
	}
	else {

		Common.logger(`Unable to verify order. No order ID received from exchange. Deal ID: ${dealId}`);
	}

	return {
		'success': success,
		'order_amount': orderAmount,
		'order_qty': orderQty,
		'order_price': orderPrice,
		'order_average': orderAverage,
		'order_invalid': orderInvalid,
		'status_invalid': statusInvalid
	};
}


// Shared post-verification cleanup for the safety-order-buy and sell invalid_order
// paths. When verification is exhausted or the deal is no longer paused, clear the
// UI "verifying" flag on the deal's sell-error tracker so the row stops showing the
// in-progress state. Both paths behaved identically here; this is the single source.
// (The base-order path deliberately does NOT use this — on exhaustion it tears the
// deal down entirely, which is different behavior and stays in its own handler.)
function clearSellErrorVerifying(dealId) {

	try {

		if (dealTracker[dealId]?.update?.deal_sell_error) {

			dealTracker[dealId].update.deal_sell_error.verifying = false;
		}
	}
	catch (e) {}
}


const verifyInvalidOrder = async ({ count = 0, mins = 2, exchange, pair, botId, dealId, orderId, onSuccessCallback = null, pauseBeforeCallback = false }) => {

	const maxTries = 100;

	const retryMins = mins ?? 2;
	count++;


		if (count > maxTries) {

			await sendDealMessage(
				'info',
				`Max tries (${maxTries}) reached for verifying order ID ${orderId} for deal ID ${dealId}. Will not try again.`
			);

			return ({
				success: false,
				retriesExhausted: true
			});
		}

		await Common.delay(retryMins * 60000);

		let resume = false;

		let msg = `Attempt #${count} to verify order ID ${orderId} for deal ID ${dealId}.`;

		await sendDealMessage('info', msg);

		let verifiedData = null;

		if (orderId) {

			const verifyData = await verifyBuySellOrder(exchange, orderId, pair, dealId);

			if (verifyData.success) {

				resume = true;
				verifiedData = verifyData;

				msg = `Attempt #${count} to verify order ID ${orderId} for deal ID ${dealId} successful.`;

				await sendDealMessage('info', msg);
			}
			else {

				const deal = await Deals.findOne({
					dealId,
					status: 0
				});

				const isDealPause = Common.convertBoolean(deal?.paused, false);
				const isDealPauseBuy = Common.convertBoolean(deal?.pausedBuy, false);
				const isDealPauseSell = Common.convertBoolean(deal?.pausedSell, false);

				msg = `Attempt #${count} to verify order ID ${orderId} for deal ID ${dealId} unsuccessful.`;

				if (deal && (isDealPause || isDealPauseBuy || isDealPauseSell)) {

					msg += ` Trying again in ${retryMins} minutes.`;

					await sendDealMessage('info', msg);

					// Recursive retry
					const retryResult = await verifyInvalidOrder({
						count,
						mins: retryMins,
						exchange,
						pair,
						botId,
						dealId,
						orderId,
						onSuccessCallback,
						pauseBeforeCallback
					});

					return (retryResult);
				}
				else {

					msg += ' Will not try again.';

					await sendDealMessage('info', msg);

					// Deal is no longer paused, exit
					return ({
						success: false,
						notPaused: true
					});
				}
			}
		}
		else {

			// No orderId => resume immediately
			resume = true;
		}

		if (resume) {

			await sendDealMessage('info', `Resuming order placement for deal ID ${dealId}`);

			if (pauseBeforeCallback) {
				
				await pauseDeal(botId, dealId, false, null, null, '');
			}

			if (typeof onSuccessCallback === 'function') {

				try {

					await onSuccessCallback(verifiedData);
				}
				catch (cbErr) {

					// The order verified as FILLED, but finalizing the deal (recording the close/profit) threw.
					// Leaving it unpaused + open would let the follow loop retry the sell on coin that is already
					// gone (NSF) and strand the deal. Re-pause with a distinct reason and alert so it stops safely
					// and is visible for attention, instead of silently stranding (this is the whole point of the
					// async-function refactor: a throw here can no longer swallow the resolve and hang the deal).
					Common.logger('verifyInvalidOrder: post-verify finalize failed for deal ' + dealId + ': ' + ((cbErr && (cbErr.stack || cbErr.message)) || cbErr), true);

					try { await pauseDeal(botId, dealId, true, true, true, 'sell_finalize_error'); } catch (e) {}
					try { await sendDealMessage('deal_error', 'Deal ID ' + dealId + ' order verified as filled but finalizing the close failed — the deal has been paused for attention (not re-sold). Error: ' + ((cbErr && cbErr.message) || cbErr)); } catch (e) {}

					return ({ success: false, callbackFailed: true, error: (cbErr && cbErr.message) || String(cbErr) });
				}
			}

			if (!pauseBeforeCallback) {

				await pauseDeal(botId, dealId, false, null, null, '');
			}

			return ({
				success: true
			});
		}

		return ({
			success: false
		});
};


const buyOrder = async ({ exchange, dealId, pair, qty, price, type = 'market' }) => {

	const maxTries = 5;

	let msg;
	let order;
	let orderId;
	let isErr;
	let success;

	let nsf = false;
	let finished = false;

	let count = 0;
	let verifyData = {};

	while (!finished) {

		try {

			isErr = null;
			success = true;

			msg = 'BUY SUCCESS';

			let orderParamsObj = {
				'symbol': pair,
				'type': type,
				'side': 'buy',
				'quantity': qty,
				'price': price
			};

			let template = getOrderTemplate();
			let templateParams = template.createOrder.buy.params;
			let orderParamsArr = replacePlaceholders(templateParams, orderParamsObj);

			// Pass params in the same structure as referenced in template
			order = await exchange.createOrder(...orderParamsArr);

			finished = true;
		}
		catch (e) {

			isErr = e;
			success = false;

			msg = 'BUY ERROR: ' + e.name + ' ' + e.message;

			if (e instanceof ccxt.InsufficientFunds || ((e instanceof ccxt.ExchangeError || e instanceof ccxt.BadRequest) && msg.toLowerCase().includes('insufficient'))) {

				nsf = true;

				finished = true;
			}
			else if (e instanceof ccxt.ExchangeError && count < maxTries) {

				await Common.delay(500 + (Math.random() * 100));
			}
			else {

				finished = true;
			}

			count++;
		}
	}

	if (success) {

		orderId = order['id'];

		verifyData = await verifyBuySellOrder(exchange, orderId, pair, dealId);

		if (verifyData.order_price) {

			const priceFiltered = await filterPrice(exchange, pair, verifyData.order_price);

			if (priceFiltered) {

				verifyData.order_price = priceFiltered;
			}
		}
	}

	const dataObj = {
						'date': new Date(),
						'success': success,
						'success_verify': verifyData.success || false,
						'data': order,
						'error': isErr,
						'invalid_order': verifyData.order_invalid || false,
						'invalid_status': verifyData.status_invalid || false,
						'nsf': nsf,
						'message': msg,
						'deal_id': dealId,
						'pair': pair,
						'quantity': qty,
						'price': price,
						'data_order': {
										'id': orderId,
										'price': verifyData.order_price,
										'average': verifyData.order_average,
										'amount': verifyData.order_amount,
										'quantity': verifyData.order_qty
									  }
	};

	Common.logger(dataObj);

	return dataObj;
};


const sellOrder = async ({ exchange, dealId, pair, qty, price, type = 'market' }) => {

	const maxTries = 5;

	let msg;
	let order;
	let orderId;
	let isErr;
	let success;

	let finished = false;
	let nsf = false;

	let count = 0;
	let verifyData = {};

	while (!finished) {

		try {

			isErr = null;
			success = true;

			msg = 'SELL SUCCESS';

			let orderParamsObj = {
				'symbol': pair,
				'type': type,
				'side': 'sell',
				'quantity': qty,
				'price': price
			};

			// Remove price from params so quantity is not altered
			if (exchange.id == 'bybit') {

				delete orderParamsObj.price;
			}

			let template = getOrderTemplate();
			let templateParams = template.createOrder.sell.params;
			let orderParamsArr = replacePlaceholders(templateParams, orderParamsObj);

			// Pass params in the same structure as referenced in template
			order = await exchange.createOrder(...orderParamsArr);

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

	if (success) {

		orderId = order['id'];

		verifyData = await verifyBuySellOrder(exchange, orderId, pair, dealId);

		if (verifyData.order_price) {

			const priceFiltered = await filterPrice(exchange, pair, verifyData.order_price);

			if (priceFiltered) {

				verifyData.order_price = priceFiltered;
			}
		}
	}

	const dataObj = {
						'date': new Date(),
						'success': success,
						'success_verify': verifyData.success || false,
						'data': order,
						'error': isErr,
						'invalid_order': verifyData.order_invalid || false,
						'invalid_status': verifyData.status_invalid || false,
						'nsf': nsf,
						'message': msg,
						'deal_id': dealId,
						'pair': pair,
						'quantity': qty,
						'price': price,
						'data_order': {
										'id': orderId,
										'price': verifyData.order_price,
										'average': verifyData.order_average,
										'amount': verifyData.order_amount,
										'quantity': verifyData.order_qty
									  }
					};

	Common.logger(dataObj);

	return dataObj;
};


const getOrderTemplate = () => {

	const template = {
		"createOrder": {
			"buy": {
				"params": [
					"{symbol}",
					"{type}",
					"{side}",
					"{quantity}",
					"{price}"
				]
			},
			"sell": {
				"params": [
					"{symbol}",
					"{type}",
					"{side}",
					"{quantity}",
					"{price}"
				]
			}
		}
	};

	return template;
}


const replacePlaceholders = (params, data) => {

	return params.flatMap(param => {

			if (typeof param === "string" && param.startsWith("{") && param.endsWith("}")) {

				const key = param.slice(1, -1);
				return key in data ? [data[key]] : [];
			}

			return [param];
	});
};




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

	// Guard shareData.appData.bots itself, not just its 'exchange' member: getSlippage runs early in the
	// per-tick follow (before that tick's try/catch), so a bare deref of an undefined bots would throw out
	// of dcaFollow and abandon the deal's follow loop (open but unmonitored until a restart). A missing
	// bots simply means no configured slippage — fall through to the 0/0 default.
	if (shareData.appData.bots != undefined && shareData.appData.bots != null && shareData.appData.bots['exchange'] != undefined && shareData.appData.bots['exchange'] != null && typeof shareData.appData.bots['exchange'] == 'object') {

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


async function calculateMaxFunds(config) {

	const {
		dcaMaxOrder,
		dcaOrderAmount,
		dcaOrderSizeMultiplier,
		dcaOrderStepPercent,
		dcaOrderStepPercentMultiplier,
		firstOrderAmount,
		exchangeFee,
		pairMax,
		pairDealsMax,
		pair = [],
	} = { ...config };

	const safetyOrdersMax = Number(dcaMaxOrder);
	const safetyOrderVolume = Number(dcaOrderAmount);
	const safetyOrderVolumeScale = Number(dcaOrderSizeMultiplier);
	const safetyOrderStepPerc = Number(dcaOrderStepPercent);
	const safetyOrderStepScale = Number(dcaOrderStepPercentMultiplier);
	const baseOrderVolume = Number(firstOrderAmount);
	// ONE fee, not two. "Max funds" is the capital you must DEPLOY to fill the ladder — that is the BUY
	// side, which only pays the buy fee. The sell fee comes out of proceeds when the deal later closes; it
	// does not increase the cash you need on hand to open the orders. Using a round-trip (2x) fee here
	// over-stated the estimate by ~fee% and made it disagree with the dashboard's actual "Max deal
	// exposure" figure (which carries no fee). This value is DISPLAY-ONLY — it never sizes an order nor
	// gates a deal start (canStartDeal / order sizing never read it), so trading is unaffected.
	const feeMultiplier = 1 + Number(exchangeFee) / 100;

	const totalPairs = Array.isArray(pair) && pair.length > 0 ? pair.length : 1;

	const effectivePairMax = Math.max(1, Number(pairMax) || 1);
	const effectivePairDealsMax = Math.max(1, Number(pairDealsMax) || 1);   // || 1: Math.max(1, NaN) is NaN, which would poison the whole max-funds estimate when pairDealsMax is absent/blank (matches effectivePairMax above)

	const maxDeviation =
		safetyOrderStepScale === 1 ?
		safetyOrdersMax * safetyOrderStepPerc :
		(safetyOrderStepPerc * (1 - Math.pow(safetyOrderStepScale, safetyOrdersMax))) /
		(1 - safetyOrderStepScale);

	let maxFunds = baseOrderVolume * feeMultiplier;

	for (let i = 0; i < safetyOrdersMax; i++) {

		maxFunds += safetyOrderVolume * Math.pow(safetyOrderVolumeScale, i) * feeMultiplier;
	}

	const botMaxFunds = Math.round(
		maxFunds * Math.min(effectivePairMax, totalPairs) * effectivePairDealsMax * 100
	) / 100;

	return {
		'max_deviation': Math.round(maxDeviation * 100) / 100,
		'max_funds': Math.round(maxFunds * 100) / 100,
		'bot_max_funds': botMaxFunds,
	};
}


const calculateProfit = async (exchange, pair, price, orderAverage, orderSum, takeProfitPercent, exchangeFeePercent, sandBox) => {

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

	//const profitQuoteProjected = Common.roundAmount(Number(Number(orderSum) * ((Number(takeProfitPercent) - Number(exchangeFeePercent) - priceSlippageSellPercent) / 100)));
	//const profitQuoteProjected = Common.roundAmount(Number(Number(orderSum) * ((Number(takeProfitPercent) - (Number(exchangeFeePercent) / 2)) / 100)));
	const profitQuoteProjected = Common.roundAmount(Number(Number(orderSum) * ((Number(takeProfitPercent)) / 100)));
	const currentProfit = Common.roundAmount(Number((Number(orderSum) * (Number(profitPerc) / 100))));

	let baseProfit = Number(currentProfit) / Number(price);

	if (exchange && pair) {

		try {

			baseProfit = await filterAmount(exchange, pair, Number(baseProfit));
		}
		catch(e) {

			// Does not meet exchange requirements or some filter error
			baseProfit = 0;
		}

		if (!baseProfit) {

			baseProfit = 0;
		}
	}

	const data = {
					'profit': currentProfit,
					'profit_base': baseProfit,
					'profit_quote_projected': profitQuoteProjected,
					'profit_percentage': profitPerc
				 };

	return data;
}


const calculateTargetPrice = async ({ exchange, pair, price, takeProfit, exchangeFee }) => {

	const exactTarget = Percentage.addPerc(
		price,
		(Number(takeProfit) + Number(exchangeFee))
	);

	let targetPrice = await filterPrice(exchange, pair, exactTarget);

	// Round the take-profit target UP to the exchange tick when precision rounded it BELOW the exact
	// target. On a coarse-tick / low-priced pair (e.g. a coin around $0.68) one tick is a meaningful
	// fraction of a percent, so priceToPrecision can land the target under average×(1+TP+fee) and the
	// deal would sell short of the configured take-profit unless slippage covered the gap. Stepping up
	// one tick makes the target always >= the exact target, so the deal reaches at least the configured
	// TP without relying on slippage. Contained to the sell target (buys, averages and order sizing are
	// untouched); high-precision pairs move by at most one tiny tick; fully fail-safe — any problem
	// determining the tick leaves today's filtered target unchanged.
	try {

		if (targetPrice !== false && Number(targetPrice) < Number(exactTarget)) {

			const pricePrecision = exchange.market(pair)?.precision?.price;

			// precisionMode 4 = TICK_SIZE (precision IS the tick); otherwise decimal places → 1 / 10^n.
			const tick = (exchange['precisionMode'] == 4)
				? Number(pricePrecision)
				: (Number.isFinite(Number(pricePrecision)) ? 1 / Math.pow(10, Number(pricePrecision)) : null);

			if (tick && tick > 0) {

				const stepped = await filterPrice(exchange, pair, Number(targetPrice) + tick);

				if (stepped !== false && Number(stepped) >= Number(exactTarget)) {

					targetPrice = stepped;
				}
			}
		}
	}
	catch (e) { /* fail-safe: keep the original filtered target */ }

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

						let msg = 'Applying additional exchange fee factor of ' + addFee + ' to reduce sell quantity for deal ' + dealId + '. Attempt: ' + sellErrorCount + '/' + maxSellErrorCount;

						Common.logger(colors.red.bold(msg));
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


const getAdjustedOrder = async (exchange, pair, price, amount, orderSize, exchangeFee, minMoveAmount) => {

	const finalAdjustments = {};

	// Get adjustments without exchange fee since already previously included
	const baseAdjustments = await calculateAdjustments({
		exchange,
		pair,
		price,
		amount,
		orderSize,
		exchangeFee: 0,
		minMoveAmount: null
	});

	// Call again to get fees
	const feeAdjustments = await calculateAdjustments({
		exchange,
		pair,
		price,
		amount,
		orderSize,
		exchangeFee,
		minMoveAmount
	});

	// Set fees in original adjustments
	for (const key of Object.keys(feeAdjustments)) {

		const base = baseAdjustments[key];
		const fee = feeAdjustments[key];

		finalAdjustments[key] = (base === undefined || base === null || base === 0) ? fee : base;
	}

	return finalAdjustments;
}


const calculateAdjustments = async ({ exchange, pair, price, amount, orderSize, exchangeFee, minMoveAmount }) => {

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

		orderSizeNew = await filterAmount(exchange, pair, orderSizeNew);

		let	amountNew = price * orderSizeNew;

		// Filtering may reduce amounts and remove decimals for some pairs
		amountNew = await filterPrice(exchange, pair, amountNew);

		// Round the cost basis to the quote currency's precision (2 dp for USD/stable/fiat as
		// before; finer for a crypto-quoted pair). See Common.roundCost.
		amountNew = Common.roundCost(amountNew, pair);

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

	let minMoveAmount;
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

		try {

			minMoveAmount = orderMetadata['minimum_movement_amount'];
		}
		catch (e) {}
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
						'priceFiltered': priceFiltered,
						'minMoveAmount': minMoveAmount
				   };

	return resObj;
}


async function getPairPrecision(exchange, exchangeName, pair, isPairData) {

	let minMoveAmount;

	exchangeName = await getExchangeAlias(exchangeName);

	try {

		minMoveAmount = exchangeMarkets[exchangeName][pair]['precision']['amount'];

		// DECIMAL_PLACES = 2
		// SIGNIFICANT_DIGITS = 3
		// TICK_SIZE = 4

		// If not TICK_SIZE then convert amount
		if (exchange['precisionMode'] != 4) {

			// Require a REAL finite precision. `null >= 0` coerces to true (and Math.pow(10, null) === 1),
			// so without the type/finite check a market whose precision.amount is null would collapse to a
			// whole-unit minimum movement (1) and then SKIP the recompute fallback below (which only fires
			// on undefined/null) — grossly oversizing a sub-1 order. Treat null/NaN exactly like undefined:
			// leave minMoveAmount unset so the getPairData recompute path runs.
			if (typeof minMoveAmount === 'number' && Number.isFinite(minMoveAmount) && minMoveAmount >= 0) {

				minMoveAmount = 1 / Math.pow(10, minMoveAmount);
			}
		}
	}
	catch(e) {

	}

	// No precision found, so calculate initial movement
	if (!isPairData && (minMoveAmount == undefined || minMoveAmount == null)) {

		const pairData = await getPairData(pair);

		if (pairData.success) {

			minMoveAmount = pairData['pair_data']['minimum_movement_amount'];
		}
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

	const botConfigFile = shareData.appData.bot_config;
	const botConfig = await Common.getConfig(botConfigFile);

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

		// Use structured data if available, fall back to legacy positional array
		const orderDataSteps = orderData.structured || orderData.steps;

		for (let i = 0; i < orderDataSteps.length; i++) {

			const step = orderDataSteps[i];
			const isObj = step !== null && typeof step === 'object' && !Array.isArray(step);
			qtyArr.push(isObj ? step.qty : step[5]);
		}

		const precisionAmount = Common.getPrecision(qtyArr);

		pairData = { 'minimum_movement_amount': precisionAmount };
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

	const maxTries = 6;

	let isErr;
	let success;
	let exchanges;

	// If no specific exchange object is provided, load markets for all exchanges
	if (!exchangeObj) {

		exchanges = shareData.appData.exchanges;

	}else {

		// Only load markets for the provided exchange
		exchanges = exchangeObj;
	}

	for (let hash in exchanges) {

		let count = 0;
		let finished = false;

		let exchange = exchanges[hash]['exchange'];
		let exchangeName = exchanges[hash]['name'];

		while (!finished) {

			try {

				success = true;

				// Load markets for the current exchange
				const markets = await exchange.loadMarkets();

				// Use the hash as the identifier when processing the markets
				await processExchangeMarkets(exchangeName, markets);

				finished = true;
			}
			catch (e) {

				isErr = null;

				if (count < maxTries) {

					// Exponential backoff with jitter (1s, 2s, 4s, 8s… capped at 8s) so a cold-start blip or a
					// brief Coinbase rate-limit on /v2/currencies is absorbed silently instead of surfacing as a
					// connect error after a too-short flat window. A transient failure recovers in 1-3s; a real
					// outage still gives up after ~30s so startup is never blocked indefinitely.
					await Common.delay(Math.min(1000 * Math.pow(2, count), 8000) + Math.floor(Math.random() * 250));
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

	return { success, error: isErr };
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
	let exchangeHash;
	let exchangeNewObj = {};
	let isErr;
	let isNew = false;
	let options = { 'defaultType': 'spot' };

	try {

		success = true;

		let exchangeName = config.exchange;
		exchangeName = await getExchangeAlias(exchangeName);

		if (config.exchangeOptions) {

			options = config.exchangeOptions;
		}

		// Decrypt the stored exchange credentials before they touch the exchange. readSecret is a
		// no-op for legacy plaintext values (so existing installs keep working unchanged) and
		// decrypts the encrypted-at-rest format. All downstream use — the connection cache hash AND
		// the ccxt client — uses these decrypted locals, so this is the single point where the raw
		// stored value is turned back into a usable credential.
		const apiKey        = await Common.readSecret(config.apiKey        || '');
		const apiSecret     = await Common.readSecret(config.apiSecret     || '');
		const apiPassphrase = await Common.readSecret(config.apiPassphrase || '');
		const apiPassword   = await Common.readSecret(config.apiPassword   || '');

		// Hard safety guard: if a credential is STILL in the encrypted-at-rest format after
		// readSecret, its decryption failed (e.g. the login password was changed since the key was
		// saved, leaving it encrypted under the old key). REFUSE to connect rather than send an
		// unusable/encrypted value to the exchange — sending a bad key would halt trading anyway, so
		// fail loudly with a clear message and let the user re-enter the key. Real exchange keys
		// never match this pattern, so a legitimate plaintext key can't trip it.
		const stillEncrypted = Common.isEncrypted;   // shared single-source-of-truth predicate

		if (stillEncrypted(apiKey) || stillEncrypted(apiSecret) || stillEncrypted(apiPassphrase) || stillEncrypted(apiPassword)) {

			throw new Error('exchange credentials could not be decrypted — re-enter the API key/secret for this exchange (was the login password changed?)');
		}

		const hash = crypto.createHash('sha256')
			.update(
				exchangeName +
				apiKey +
				apiSecret +
				apiPassphrase +
				apiPassword
			)
			.digest('hex');

		exchangeHash = hash;

		if (shareData.appData.exchanges[hash]) {

			exchange = shareData.appData.exchanges[hash]['exchange'];
		}
		else {

			isNew = true;

			exchange = new ccxt.pro[exchangeName]({
				'timeout': (exchangeTimeoutSec * 1000),
				'enableRateLimit': true,
				'apiKey': apiKey,
				'secret': apiSecret,
				'passphrase': apiPassphrase,
				'password': apiPassword,
				'options': options
			});

			const exchangeObj = {
									'name': exchangeName,
									'exchange': exchange
								};

			exchangeNewObj[hash] = exchangeObj;
			shareData.appData.exchanges[hash] = exchangeObj;
		}
	}
	catch (e) {

		isErr = e;
		exchange = null;
		success = false;
	}

	// Load markets if newly connected
	if (success && isNew) {

		let loadData = await loadExchangeMarkets(exchangeNewObj);

		success = loadData['success'];
		isErr = loadData['error'];
	}

	if (isErr) {

		success = false;

		// Keep the alert concise and self-contained: a ccxt connect/network error can carry the entire fetched
		// response body (a failed /currencies call is ~10KB of JSON), which floods the log and the notification.
		// The shared summarizer reduces it to a bounded single line and appends the underlying network cause
		// code (ECONNREFUSED / ETIMEDOUT / ENETUNREACH / EAI_AGAIN / UND_ERR_CONNECT_TIMEOUT …) so a bare
		// "fetch failed" is self-diagnosing rather than blank.
		let msg = 'Connect exchange error: ' + summarizeExchangeError(isErr);

		Common.logger(msg);

		// Rate-limit the ALERT (not the log): skip pushing an identical connect-error notification for the
		// same exchange within the throttle window, so a persistent outage or several bots reconnecting at
		// once don't produce a stream of duplicate alerts. The timestamp is set before the async send so
		// near-simultaneous callers collapse to one.
		const nowMsConnErr = Date.now();

		if (nowMsConnErr - (connectErrorNotified[exchangeHash] || 0) > connectErrorNotifyWindowMs) {

			connectErrorNotified[exchangeHash] = nowMsConnErr;

			Common.sendNotification({
				'message': msg,
				'type': 'error',
				'telegram_id': shareData.appData.telegram_id
			});
		}

		delete shareData.appData.exchanges[exchangeHash];
	}

	return exchange;
}


async function getExchangeAlias(exchangeName) {

	// CCXT name changes — delegate to the single shared alias map (Common) so the trading side and the
	// public market-data service can never resolve the same configured name differently.
	return Common.exchangeAlias(exchangeName);
}


async function sendDealMessage(msgType, msg) {

	Common.logger(colors.bgRed(msg));

	await Common.sendNotification({ 'message': msg, 'type': msgType, 'telegram_id': shareData.appData.telegram_id });
}


async function processOrderError(data) {

	let active = false;
	let success = true;

	let botId = data['bot_id'];
	let dealId = data['deal_id'];
	let botName = data['bot_name'];

	const dataBot = await updateBot(botId, { 'active': active });

	if (!dataBot.success) {

		// An error occurred updating bot so treat as unsuccessful
		success = false;
	}

	if (success) {

		let msg = 'An error occurred starting deal ID ' + dealId + '. Disabling bot ' + botName + '. Check the logs for details.';

		await sendDealMessage('deal_error', msg);
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

		Common.logger((e && (e.stack || e.message)) || JSON.stringify(e));
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

		Common.logger((e && (e.stack || e.message)) || JSON.stringify(e));
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

		Common.logger((e && (e.stack || e.message)) || JSON.stringify(e));
	}

	if (dealData == undefined || dealData == null || dealData['deletedCount'] < 1) {

		success = false;
	}

	return( { 'success': success } );
}


const updateOrderDeal = async (dealId, orderIndex, orderId, orders) => {

	orders[orderIndex].filled = 1;
	orders[orderIndex].orderId = orderId;
	orders[orderIndex].dateFilled = new Date();

	// Field-scoped update: persist ONLY this order's fill fields via a positional $set, instead of
	// rewriting the ENTIRE `orders` array. The whole-array write let a late background verify callback
	// (working from a stale snapshot of `orders`) clobber concurrent changes to OTHER orders in the
	// array. Touching just these three sub-fields is race-safe and produces an identical result for the
	// normal single-writer tick (the caller re-reads via recalculateOrders immediately after).
	await Deals.updateOne(
		{ 'dealId': dealId },
		{ '$set': {
			[`orders.${orderIndex}.filled`]:     orders[orderIndex].filled,
			[`orders.${orderIndex}.orderId`]:    orders[orderIndex].orderId,
			[`orders.${orderIndex}.dateFilled`]: orders[orderIndex].dateFilled
		} }
	);

	const orderUpdated = orders[orderIndex];

	return orderUpdated;
}


async function updateOrders(data) {

	let orderData = JSON.parse(JSON.stringify(data));

	let ordersOrig = orderData['orig'];
	let orderSteps = orderData['new'];
	let orderMetadata = orderData['metadata'];

	let ordersNew = [];

	for (let i = 0; i < orderSteps.length; i++) {

		let orderNew;
		const step = orderSteps[i];

		// Support both structured objects (new path) and legacy positional arrays (old path)
		const isObj = step !== null && typeof step === 'object' && !Array.isArray(step);

		const priceTargetNew = String(isObj ? step.target : step[4]).replace(/[^0-9.]/g, '');

		// Use existing order data if available
		if (ordersOrig[i] != undefined && ordersOrig[i] != null) {

			orderNew = ordersOrig[i];
			orderNew['target'] = priceTargetNew;
		}
		else {

			let orderObj = {
								orderNo:  isObj ? step.no                                          : step[0],
								orderId:  '',
								price:    String(isObj ? step.price   : step[2]).replace(/[^0-9.]/g, ''),
								average:  String(isObj ? step.average : step[3]).replace(/[^0-9.]/g, ''),
								target:   priceTargetNew,
								qty:      String(isObj ? step.qty     : step[5]).replace(/[^0-9.]/g, ''),
								amount:   String(isObj ? step.amount  : step[6]).replace(/[^0-9.]/g, ''),
								qtySum:   String(isObj ? step.qtySum  : step[7]).replace(/[^0-9.]/g, ''),
								sum:      String(isObj ? step.sum     : step[8]).replace(/[^0-9.]/g, ''),
								type:     isObj ? step.type : step[9],
								filled:   0,
								orderMetadata: orderMetadata[i]
							};

			orderNew = orderObj;
		}

		ordersNew.push(orderNew);
	}

	return ordersNew;
}


async function removeDbKeys(obj) {

	for (let key in obj) {

		if (key.substr(0, 1) == '$' || key.substr(0, 1) == '_') {

			delete obj[key];
		}
	}

	return obj;
}


async function convertDataToSandBox() {

	let botData;
	let dealData;
	let success = true;

	try {

		// Preserve timestamps: this is a system-level flag flip (marking restored data as
		// sandbox), not a genuine per-document edit. Without { timestamps: false } Mongoose's
		// timestamps plugin would re-stamp updatedAt=now on EVERY bot and deal, which — because
		// this runs as the convert-to-sandbox step of a backup restore — silently rewrites the
		// whole fleet's updatedAt to the restore moment. Anything that reads updatedAt as a
		// "last active / last closed" signal would then be wrong until the data ages out.
		botData = await Bots.updateMany({}, { '$set': { 'config.sandBox': true } }, { 'timestamps': false });
		dealData = await Deals.updateMany({}, { '$set': { 'config.sandBox': true } }, { 'timestamps': false });
	}
	catch (e) {

		success = false;

		Common.logger((e && (e.stack || e.message)) || JSON.stringify(e));
	}

	if (botData == undefined || botData == null || botData['matchedCount'] < 1) {

		success = false;
	}

	if (dealData == undefined || dealData == null || dealData['matchedCount'] < 1) {

		success = false;
	}

	return( { 'success': success } );
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

			dealTracker[dealId]['update']['deal_sell_error'] = {
				'history': {},
				'nsf': false,
				'verifying': false,
				'count': 0,
				'count_dupes': 0,
				'date': new Date()
			};
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
	dealTracker[dealId]['meta'] = {};
	dealTracker[dealId]['update'] = {};

	dealTracker[dealId]['meta']['start_id'] = startId;

	dealTracker[dealId]['deal'] = JSON.parse(JSON.stringify(data['deal']));

	// Confirm deal started by deleting start deal tracker
	deleteStartDealTracker(startId);
}


async function updateDealTracker(data) {

	const { exchange, ...dataInObj } = data;

	let dataObj = JSON.parse(JSON.stringify(dataInObj));

	dataObj['active'] = true;
	dataObj['updated'] = new Date();
	dataObj['exchange'] = exchange;

	const dealId = data['deal_id'];

	const dealData = await getDealInfo(dataObj);

	if (dealData['success'] && dealTracker[dealId] != undefined && dealTracker[dealId] != null) {

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


async function createStartDealTracker(startId, botId) {

	startDealTracker[startId] = { 'date': new Date(), 'botId': botId };
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


// Build a minimal, NON-LIVE deal info snapshot from a deal's PERSISTED record, for a deal that has just
// been resumed into the tracker but whose live info has not been filled yet (the first live price tick
// waits on the exchange connection, which can be slow — or briefly failing — on a cold restart). This lets
// the active-deals view (instance AND Hub — they consume the same getActiveDeals payload) show the deal
// immediately with everything that is known WITHOUT a live price (pair, deal count, safety orders used,
// average entry, take-profit target), rather than hiding the row for ~30s. Fields that genuinely need a
// live price — current price and every profit figure — are left null and the snapshot is flagged
// `awaiting_live` so the view renders "updating…" for them instead of a stale or fabricated number.
//
// Pure and read-only: it derives from the persisted deal alone (no exchange call, no trading state), mirrors
// getDealInfo's own filled-orders/current-order logic and field names, and is never used on the trading path.
function buildResumeInfo(deal) {

	const config = (deal && deal.config) || {};
	const orders = Array.isArray(deal && deal.orders) ? deal.orders : [];

	const filled = orders.filter(o => o && o.filled == 1);
	const currentOrder = filled.length ? filled[filled.length - 1] : null;

	// deal_count must be a real number or the view treats the row as a "deal data issue" and hides it;
	// fall back to the filled safety-order count if the persisted config somehow lacks it.
	const dealCount = (config.dealCount != null) ? config.dealCount : Math.max(0, filled.length - 1);

	return {
		'updated': (deal && deal.updated) || new Date(),
		'active': true,
		// Reflect a persisted pause reason so a paused deal shows its banner immediately; the first live
		// tick refines the exact pause flags. Not a live value, so it is safe to show now.
		'pause': !!(deal && deal.pauseReason),
		'pause_buy': false,
		'pause_sell': false,
		'pause_reason': (deal && deal.pauseReason) || '',
		'error': '',
		'bot_id': config.botId,
		'bot_name': config.botName,
		'safety_orders_used': Math.max(0, filled.length - 1),
		'safety_orders_max': Math.max(0, orders.length - 1),
		// Known from the persisted orders — no live price needed.
		'price_average': currentOrder ? currentOrder.average : null,
		'price_target': currentOrder ? currentOrder.target : null,
		// LIVE-only — unknown until the first tick. Left null; the view shows "updating…" via awaiting_live.
		'price_last': null,
		'profit': null,
		'profit_base': null,
		'profit_percentage': null,
		'profit_quote_projected': null,
		'estimates': {},
		'deal_count': dealCount,
		'deal_max': config.dealMax,
		'max_funds': null,
		'awaiting_live': true
	};
}


async function getActiveDeals(active) {

	let dealsArr = [];
	let dealsSort = [];

	let botsActiveObj = {};

	if (active == undefined || active == null || active == '') {

		active = true;
	}

	const bots = await getBots({ 'active': active });

	const dealTracker = await getDealTracker();

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

		// A just-resumed deal sits in the tracker with empty info until the first live price tick fills it
		// (that tick waits on the exchange connection, slow/failing on a cold restart). Seed a non-live
		// snapshot from the persisted deal so the row displays right away instead of being hidden for ~30s.
		// Display-only: getActiveDeals feeds the view; it never touches the trading loop.
		if (!info || Object.keys(info).length === 0) {

			info = buildResumeInfo(deal['deal']);
		}

		let dealRoot = deal['deal'];

		dealRoot = await removeDbKeys(dealRoot);
		dealRoot['config'] = await removeConfigData(config);

		if (botsActiveObj[botId] == undefined || botsActiveObj[botId] == null) {

			botActive = false;
		}

		obj = Object.assign({}, obj, dealRoot);

		obj['info'] = info;
		obj['info']['bot_active'] = botActive;

		obj = Common.convertStringToNumeric(obj);

		dealsArr.push(obj);
	}

	dealsSort = Common.sortByKey(dealsArr, 'date');
	dealsSort = dealsSort.reverse();

	// Keep circuit breaker informed of active deal count
	shareData.appData.cb_active_deal_count = dealsSort.length;

	return dealsSort;
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

	const dealId = data['deal_id'] ?? 'ALL DEALS';

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


// Returns the cached balance directly — no exchange call, no timestamp update.
// Use this everywhere except the background refresh interval.
function getBalanceCache() {

	return balanceTracker ? JSON.parse(JSON.stringify(balanceTracker)) : {};
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

		let attempted = false;   // at least one credentialed exchange was queried this cycle
		let anySuccess = false;  // at least one returned a balance

		for (let hash in exchanges) {

			const exchangeObj = exchanges[hash];

			const exchangeName = exchangeObj['name'];
			const exchange = exchangeObj['exchange'];

			// Skip exchanges without API credentials — they were connected
			// for public data only (e.g. BTC price ticker, market data)
			// or are sandbox instances without real credentials.
			if (!exchange.apiKey) continue;

			attempted = true;

			const balance = await getBalance(exchange);

			if (balance.success) {

				anySuccess = true;

				let uniqueName = exchangeName;
				let counter = 1;

				// Ensure unique name
				while (uniqueName in balances) {

					uniqueName = `${exchangeName}_${counter++}`;
				}

				balances[uniqueName] = balance.balance;
			}
		}

		if (anySuccess || !attempted) {

			// A successful refresh (or nothing to fetch — all public/sandbox). Store the fresh snapshot and
			// stamp the time.
			const resObj = {
				'updated': new Date(),
				'balances': balances,
				'stale': false
			};

			balanceTracker = JSON.parse(JSON.stringify(resObj));
		}
		else {

			// Every credentialed exchange failed this cycle (a transient exchange/network outage — the same
			// class of failure that makes /currencies "fetch failed" on a cold restart). Do NOT overwrite the
			// last-known balances with an empty set and stamp them fresh — that is exactly what made the
			// portfolio read "$0.00" during an outage. Keep the last good snapshot, flag it stale, and record
			// the attempt so the UI can show the balance as "updating…" against its real last-updated time.
			// This cache is DISPLAY/REPORT-only (the trading funds check reads the exchange directly via
			// getBalance, never this cache), so preserving stale data here can never affect a trade.
			balanceTracker = Object.assign({}, balanceTracker, { 'stale': true, 'last_attempt': new Date().toISOString() });
		}
	}
	else {

		try {

			balances = JSON.parse(JSON.stringify(balanceTracker.balances));
		}
		catch (e) {}
	}

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

	return balanceTracker;
}


async function getDealInfo(data) {

	const updated = data['updated'];
	const exchange = data['exchange'];
	const dealId = data['deal_id'];
	const active = data['active'];
	const price = data['price'];
	const error = data['error'];
	const pause = data['pause'];
	const pauseBuy = data['pause_buy'];
	const pauseSell = data['pause_sell'];
	const pauseReason = data['pauseReason'] || data['pause_reason'] || '';

	const config = JSON.parse(JSON.stringify(data['config']));
	const orders = JSON.parse(JSON.stringify(data['orders']));

	const filledOrders = orders.filter(item => item.filled == 1);
	const currentOrder = filledOrders.pop();

	const isPaused = (pause || pauseBuy || pauseSell);

	// No filled order yet: normally there's nothing to show. But if the deal is
	// paused for verification (e.g. a base order mid-invalid_order-verify, isStart:0),
	// return a minimal-but-valid info object so the UI can render the system-pause
	// banner instead of dropping the row. Profit/estimate fields default to 0 since
	// there is no filled order to compute them from.
	if ((currentOrder == undefined || currentOrder == null) && !isPaused) {

		return ({ 'success': false });
	}

	let profitPerc = 0;
	let profitQuoteProjected = 0;
	let currentProfit = 0;
	let currentProfitBase = 0;

	let safetyOrdersUsed = 0;
	let priceAverage = 0;
	let priceTarget = 0;
	let maxDeviation = 0;
	let maxFunds = 0;

	let estimates = {};

	if (currentOrder != undefined && currentOrder != null) {

		const profitData = await calculateProfit(exchange, config.pair, price, currentOrder.average, currentOrder.sum, config.dcaTakeProfitPercent, config.exchangeFee, config.sandBox);

		profitPerc = profitData['profit_percentage'];
		profitQuoteProjected = profitData['profit_quote_projected'];
		currentProfit = profitData['profit'];
		currentProfitBase = profitData['profit_base'];

		const maxFundsObj = await calculateMaxFunds(config);

		const estimateObj = await estimateFunds({
				'dealId': undefined,
				'sum': currentOrder.sum,
				'qtySum': currentOrder.qtySum,
				'targetProfitPercent': config.dcaTakeProfitPercent,
				'targetPrice': currentOrder.target,
				'price': price,
				'exchangeFee': config.exchangeFee
		});

		const estAmountNet = Common.adjustDecimals(estimateObj['amount_net'], price, currentOrder.average, currentOrder.target);
		const estAmountGross = Common.adjustDecimals(estimateObj['amount_gross'], price, currentOrder.average, currentOrder.target);
		const estAvgNet = Common.adjustDecimals(estimateObj['average_price_net'], price, currentOrder.average, currentOrder.target);
		const estAvgGross = Common.adjustDecimals(estimateObj['average_price_gross'], price, currentOrder.average, currentOrder.target);
		const estTargetNet = Common.adjustDecimals(estimateObj['target_price_net'], price, currentOrder.average, currentOrder.target);
		const estTargetGross = Common.adjustDecimals(estimateObj['target_price_gross'], price, currentOrder.average, currentOrder.target);
		const estAvgChangePerc = estimateObj['average_price_change_percent'];
		const estTargetChangePerc = estimateObj['target_price_change_percent'];
		const estFeeTotal = estimateObj['exchange_fee_total'];

		safetyOrdersUsed = filledOrders.length;
		priceAverage = currentOrder.average;
		priceTarget = currentOrder.target;
		maxDeviation = maxFundsObj.max_deviation;
		maxFunds = maxFundsObj.max_funds;

		estimates = {
			'amount_net': estAmountNet,
			'amount_gross': estAmountGross,
			'price_average_net': estAvgNet,
			'price_average_gross': estAvgGross,
			'price_target_net': estTargetNet,
			'price_target_gross': estTargetGross,
			'price_average_change_percent': estAvgChangePerc,
			'price_target_change_percent': estTargetChangePerc,
			'exchange_fee_total': estFeeTotal
		};
	}
	else {

		// Paused deal with no filled order (base order mid-verify). Show the base
		// order's stored price as the average/target placeholder if available.
		const baseOrder = orders[0] || {};

		priceAverage = baseOrder.average || baseOrder.price || 0;
		priceTarget = baseOrder.target || 0;
		safetyOrdersUsed = 0;
	}

	// Stop-loss display fields (#104a): reuse the pure guard to surface the effective
	// stop level + break-even-armed state for the active-deal row. Read-only. The armed
	// state is supplied by the follow loop's idle tick (deal top-level fields); callers
	// that omit it simply show the base stop level.
	let stopLossEnabled = false;
	let stopLossReference = 'average';
	let stopLossPrice = 0;
	let stopLossArmed = false;
	let stopLossTrailing = false;

	if ((config.dcaStopLossEnabled || config.dcaTrailingStopEnabled) && currentOrder != undefined && currentOrder != null) {

		let lastSafetyOrderPrice = null;

		if (String(config.dcaStopLossReference).toLowerCase() === 'lastsafetyorder') {

			for (let s = 0; s < orders.length; s++) {

				const op = Number(orders[s].price);

				if (Number.isFinite(op) && op > 0 && (lastSafetyOrderPrice === null || op < lastSafetyOrderPrice)) {

					lastSafetyOrderPrice = op;
				}
			}
		}

		const slInfo = StopLoss.evaluate({
			'enabled': config.dcaStopLossEnabled,
			'price': price,
			'average': currentOrder.average,
			'stopLossPercent': config.dcaStopLossPercent,
			'reference': config.dcaStopLossReference,
			'lastSafetyOrderPrice': lastSafetyOrderPrice,
			'feeRate': config.exchangeFee,
			'moveBreakeven': config.dcaStopLossMoveBreakeven,
			'breakevenTrigger': config.dcaStopLossBreakevenTrigger,
			'profitPercentage': profitPerc,
			'breakevenArmed': data['stop_loss_breakeven_armed'],
			'activeStopLossPrice': data['active_stop_loss_price'],
			'trailingEnabled': config.dcaTrailingStopEnabled,
			'trailingDistance': config.dcaTrailingStopDistance,
			'trailingActivateProfit': config.dcaTrailingActivateProfit,
			'trailHighPrice': data['trail_high_price']
		});

		stopLossEnabled = true;
		stopLossReference = (String(config.dcaStopLossReference).toLowerCase() === 'lastsafetyorder') ? 'lastSafetyOrder' : 'average';

		// Round the computed stop level to the pair's price precision (like price_target)
		// so the UI never shows float artifacts (e.g. 75.53272000000001). filterPrice is
		// the exchange-accurate rounding; fall back to trimming float noise if it can't run.
		if (slInfo['level'] != undefined && slInfo['level'] != null) {

			let slLevel = slInfo['level'];

			try {

				const slFiltered = await filterPrice(exchange, config.pair, slLevel);

				slLevel = (slFiltered != undefined && slFiltered != null && slFiltered !== '') ? Number(slFiltered) : Number(slLevel.toFixed(8));
			}
			catch (e) {

				slLevel = Number(slLevel.toFixed(8));
			}

			stopLossPrice = Number.isFinite(slLevel) ? slLevel : 0;
		}

		stopLossArmed = slInfo['breakevenArmed'] === true;
		stopLossTrailing = slInfo['trailingActive'] === true;
	}

	const dealInfo = {
						'updated': updated,
						'active': active,
						'pause': pause,
						'pause_buy': pauseBuy,
						'pause_sell': pauseSell,
						'pause_reason': pauseReason,
						'error': error,
						'bot_id': config.botId,
						'bot_name': config.botName,
						'safety_orders_used': safetyOrdersUsed,
						'safety_orders_max': orders.length - 1,
						'price_last': price,
						'price_average': priceAverage,
						'price_target': priceTarget,
						'profit': currentProfit,
						'profit_base': currentProfitBase,
						'profit_percentage': profitPerc,
						'profit_quote_projected': profitQuoteProjected,
						'estimates': estimates,
						'deal_count': config.dealCount,
						'deal_max': config.dealMax,
						'max_deviation': maxDeviation,
						'max_funds': maxFunds,
						'stop_loss_enabled': stopLossEnabled,
						'stop_loss_reference': stopLossReference,
						'stop_loss_price': stopLossPrice,
						'stop_loss_armed': stopLossArmed,
						'stop_loss_trailing': stopLossTrailing,
					 };

	return ({ 'success': true, 'info': dealInfo, 'config': config, 'orders': orders });
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

	const botConfigFile = shareData.appData.bot_config;

	const botConfig = await Common.getConfig(botConfigFile);

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


async function ordersToStructuredData(structured) {

	if (!Array.isArray(structured) || structured.length === 0) {
		return { 'headers': [], 'steps': [], 'structured': [] };
	}

	const headers = ['No', 'Deviation', 'Price', 'Average', 'Target', 'Qty', 'Amount', 'Sum(Qty)', 'Sum', 'Type', 'Filled'];

	const steps = structured.map(order => [
		order.no,
		order.deviation + '%',
		order.price,
		order.average,
		order.target,
		order.qty,
		order.amount,
		order.qtySum,
		order.sum,
		order.type,
		order.filled == 0 ? 'Waiting' : 'Filled'
	]);

	return { 'headers': headers, 'steps': steps, 'structured': structured };
}


async function ordersCreateTable(data) {

	let config = data['config'];
	let orders = data['orders'];

	let ordersDeviation = [];
	let ordersMetadata = [];
	let ordersStructured = [];

	let t = new Table();

	for (let x = 0; x < orders.length; x++) {

		let order = orders[x];

		let deviationPerc = await getDeviationDca(config.dcaOrderStepPercent, config.dcaOrderStepPercentMultiplier, x);

		deviationPerc = Number(deviationPerc.toFixed(2));

		ordersDeviation.push(deviationPerc);
	}

	const pair = typeof config.pair === 'string' ? config.pair : (config.pair || [])[0] || '';
	const quoteCur = Common.quoteCurrency(pair);
	const sym = Common.getCurrencySymbol((quoteCur && quoteCur !== 'UNKNOWN') ? quoteCur : '');
	const amountHeader = 'Amount' + (sym ? '(' + sym + ')' : '');
	const sumHeader = 'Sum' + (sym ? '(' + sym + ')' : '');

	orders.forEach(function (order) {

		ordersMetadata.push(order.orderMetadata);

		ordersStructured.push({
			no:        order.orderNo,
			deviation: ordersDeviation[order.orderNo - 1],
			price:     order.price,
			average:   order.average,
			target:    order.target,
			qty:       order.qty,
			amount:    order.amount,
			qtySum:    order.qtySum,
			sum:       order.sum,
			type:      order.type,
			filled:    order.filled
		});

		t.cell('No', order.orderNo);
		t.cell('Deviation', ordersDeviation[order.orderNo - 1] + '%');
		t.cell('Price', sym + order.price);
		t.cell('Average', sym + order.average);
		t.cell('Target', sym + order.target);
		t.cell('Qty', order.qty);
		t.cell(amountHeader, sym + order.amount);
		t.cell('Sum(Qty)', order.qtySum);
		t.cell(sumHeader, sym + order.sum);
		t.cell('Type', order.type);
		t.cell('Filled', order.filled == 0 ? 'Waiting' : 'Filled');

		t.newRow();
	});

	let maxDeviation = await getDeviationDca(config.dcaOrderStepPercent, config.dcaOrderStepPercentMultiplier, orders.length - 1);

	return ( { 'table': t, 'structured': ordersStructured, 'max_deviation': maxDeviation, 'metadata': ordersMetadata } );
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

	let msg;
	let msgLoss;
	let msgProfit;
	let profit;

	pair = pair.toUpperCase();

	const pairArr = pair.split('/');

	const pairBase = pairArr[0];
	const pairQuote = pairArr[1];

	const dealData = await getDeals({ 'dealId': dealId });

	const deal = dealData[0];
	const config = deal.config;

	const profitQuote = Number(sellData.profitQuote);
	const profitBase = Number(sellData.profitBase);
	const profitPerc = Number(sellData.profit);

	const profitCurrency = config['profitCurrency'];

	const duration = Common.timeDiff(new Date(), new Date(deal['date']));

	if (!profitCurrency || profitCurrency == 'quote' || Number(profitBase) <= 0) {

		const quoteSym = Common.getCurrencySymbol(pairQuote);
		profit = quoteSym + profitQuote + ' ' + pairQuote;
	}
	else {

		profit = profitBase + ' ' + pairBase;
	}

	try {

		let msgObj = JSON.parse(fs.readFileSync(pathRoot + '/libs/strategies/DCABot/telegram/dealComplete.json', { encoding: 'utf8', flag: 'r' }));

		msgLoss = msgObj['loss'];
		msgProfit = msgObj['profit'];
	}
	catch(e) {

	}

	if (profitQuote <= 0) {

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
																requestDealStart(configObj, 0, 'volume delay');

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


// ── Single entry point for all new deal starts ───────────────────────────────
//
// Every path that wants to create a new deal — API, webhook, signal, ASAP,
// Single entry point for all new deal starts — API, webhook, signal, ASAP,
// cooldown restart, internal loop — calls requestDealStart(). It enqueues
// the work onto a serial queue so only one deal-start attempt runs at a time,
// eliminating all race conditions regardless of call origin.
//
// delaySec: optional cooldown/stagger delay before the attempt runs.
// Returns { success, data, startId } where:
//   success  — true if successfully enqueued, false if queue not initialized
//   data     — error message if success is false, otherwise null
//   startId  — ID callers (e.g. apiStartDealProcess) can poll to confirm commit
async function requestDealStart(config, delaySec = 0, source = '') {

	let success = false;
	let data    = null;
	let startId = null;

	if (!dealStartQueue) {

		data = 'requestDealStart called before queue initialized';
		Common.logger(data);
	}
	else {

		success = true;
		startId = Common.uuidv4();

		// Snapshot the per-request values NOW, at enqueue time. The queued task runs LATER (after the
		// stagger delay), and some callers reuse or mutate a single config object across a loop (bot
		// enable/update, startAsap). Reading these fields inside the task could otherwise see the last
		// pair the caller wrote instead of this request's. Capturing them here makes the deal-start
		// path correct by construction, independent of how any caller manages its config object.
		const pairSnapshot      = config.pair;
		const botIdSnapshot     = config.botId;
		const dealCountSnapshot = config.dealCount;

		await createStartDealTracker(startId, botIdSnapshot);

		// Fast pre-enqueue check — count pending starts already queued for this botId.
		// If pending starts alone already meet or exceed pairMax there is no point
		// enqueueing another task that is guaranteed to be blocked when it runs.
		// This uses only in-memory state so it never touches the database.
		// The authoritative canStartDeal check inside the queue task still runs —
		// this is purely an optimization to avoid wasteful queue drain.
		const pairMaxFast = Number(config.pairMax) || 0;

		if (pairMaxFast > 0) {

			const pendingForBot = Object.values(startDealTracker)
				.filter(entry => entry && entry.botId === botIdSnapshot)
				.length;

			// pendingForBot includes the current startId (added above),
			// so block only when count exceeds pairMax — meaning there are
			// already pairMax other pending starts ahead of this one.
			if (pendingForBot > pairMaxFast) {

				deleteStartDealTracker(startId);
				return { success: false, data: 'pairMax pre-check: too many pending starts', startId: null };
			}
		}

		dealStartQueue.enqueue(async () => {

			let taskSuccess = false;
			let taskData    = null;

			try {

				// Apply optional stagger/cooldown delay
				if (delaySec > 0) {

					await Common.delay(delaySec * 1000);
				}

				// Wait for any resuming deals before proceeding
				await processResumeDealTracker();

				// Use the values snapshotted at enqueue time — never re-read the shared config object here.
				const pair      = pairSnapshot;
				const botId     = botIdSnapshot;
				const dealCount = dealCountSnapshot;

				if (!botId || !pair) {

					taskData = 'Missing botId or pair';
				}
				else {

					const bot = await getBots({ 'botId': botId });

					if (!bot || bot.length === 0 || !bot[0].active) {

						taskData = 'Bot not found or inactive';
					}
					else {

						const botConfigDb    = bot[0].config;
						const botDealsActive  = await getDeals({ 'botId': botId, 'status': 0 });
						const pairDealsActive = await getDeals({ 'botId': botId, 'pair': pair, 'status': 0 });
						const pairCount       = botDealsActive.length;

						const { allowed, reason } = await canStartDeal({
							pair,
							config: botConfigDb,
							pairCount,
							dealsActive: pairDealsActive
						});

						if (!allowed) {

							taskData = reason;

							if (shareData.appData.verboseLog) {

								const sourceLabel = source ? ' (' + source + ')' : '';
								Common.logger(colors.bgYellow('requestDealStart blocked for ' + pair + sourceLabel + ': ' + reason));
							}
						}
						else {

							botConfigDb['pair']      = pair;
							botConfigDb['botId']     = botId;
							botConfigDb['dealCount'] = dealCount;

							await start({ 'create': true, 'config': botConfigDb }, startId);
							taskSuccess = true;
						}
					}
				}
			}
			catch (err) {

				taskData = err?.message || String(err);
				Common.logger('requestDealStart error: ' + taskData);
			}

			if (!taskSuccess) {

				deleteStartDealTracker(startId);
			}

			return { 'success': taskSuccess, 'data': taskData };
		});
	}

	return { success, data, startId };
}


async function startAsap(pairIgnore) {

	// Check for any resuming deals before continuing
	await processResumeDealTracker();

	// Start any active asap bots that have no deals running
	const botsActive = await getBots({ 'active': true, 'config.startConditions': { '$eq': 'asap' } });

	if (!botsActive || botsActive.length === 0) return;

	let count = 0;

	for (let i = 0; i < botsActive.length; i++) {

		const bot     = botsActive[i];
		const botId   = bot.botId;
		const botName = bot.botName;

		const botConfig = bot['config'];
		const pairs = botConfig.pair;

		// Get total active pairs on this bot once per bot (incremented locally as starts are queued)
		const botDealsActive = await getDeals({ 'botId': botId, 'status': 0 });
		let pairCount = botDealsActive.length;

		const pairMax = Number(botConfig.pairMax) || 0;

		for (let x = 0; x < pairs.length; x++) {

			// Early exit — no point iterating further once the pair limit is reached
			if (pairMax > 0 && pairCount >= pairMax) break;

			const pair = pairs[x];

			if (pairIgnore && pair.toUpperCase() === pairIgnore.toUpperCase()) continue;

			const dealsActive = await getDeals({ 'botId': botId, 'pair': pair, 'status': 0 });

			// Clone the config per iteration so applyConfigData's in-place enrichment can't leak across
			// pairs. requestDealStart additionally snapshots its pair at enqueue time, so the deal-start
			// path is race-proof regardless.
			let config = JSON.parse(JSON.stringify(botConfig));
			config['pair'] = pair;
			config = await applyConfigData({ 'bot_id': botId, 'bot_name': botName, 'config': config });

			const { allowed } = await canStartDeal({
				pair,
				config,
				pairCount,
				dealsActive
			});

			if (allowed) {

				// Stagger multiple simultaneous starts by 1 second per pair.
				// notify is not passed — startAsap is an internal background restart,
				// not a user-triggered action. Deal start notifications are sent
				// by sendNotificationStart inside start() when the deal is created.
				requestDealStart(config, count + 1, 'asap');

				count++;
				pairCount++;
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

	// If the deal was mid-verification when SymBot was terminated, restart
	// verifyInvalidOrder so it continues polling rather than sitting paused forever.
	const resumePauseReason = dealObj.pauseReason || '';

	if (resumePauseReason === 'order_verify_buy' || resumePauseReason === 'order_verify_sell') {

		const isSell = resumePauseReason === 'order_verify_sell';
		const retryMins = 2;

		// Find the pending order ID from the most recent unfilled order
		const orders = dealObj.orders || [];
		let pendingOrderId = null;

		if (isSell) {

			// Sell: look for a sell order ID stored on the deal
			pendingOrderId = dealObj.sellData?.orderId?.[0] || null;
		}
		else {

			// Buy: find the last unfilled order with an order ID
			for (let i = orders.length - 1; i >= 0; i--) {

				if (!orders[i].filled && orders[i].orderId) {

					pendingOrderId = orders[i].orderId;
					break;
				}
			}
		}

		// If there is no pending order ID to verify, do NOT arm verification. This happens
		// when the deal was paused with an order_verify_* reason but the order that caused
		// the pause left no stored ID — most commonly an exchange-cancelled partial buy
		// (price-protection): that path pauses with pauseReason 'order_verify_buy' but never
		// persists a pending order ID. Arming verifyInvalidOrder with orderId=null logged a
		// misleading "verify order ID null / Attempt #1" and immediately resumed anyway.
		// Instead, clear the stale pause reason and resume cleanly — there is nothing to poll.
		//
		// KNOWN LIMITATION: today ONLY the base order persists its unverified ID (as orders[0].orderId),
		// so only a base-order verification is actually recoverable here. A SAFETY-order or SELL that was
		// mid-verification at shutdown reaches this branch with no recoverable ID (the safety ID is never
		// written to orders[i].orderId, and sellData is written only on a clean close), so they always
		// clear-and-resume rather than re-verify. See the KNOWN LIMITATION notes at the two verify branches
		// (safety buy / sell) — persisting those IDs and reconstructing their credit/finalize on resume is
		// deferred as a dedicated effort.
		if (!pendingOrderId) {

			Common.logger( colors.bgYellow.bold(`Deal ID ${dealId} was paused (${resumePauseReason}) at shutdown but has no pending order ID to verify (e.g. an exchange-cancelled order). Clearing pause and resuming.`) );

			await pauseDeal(botId, dealId, false, false, false, '');
		}
		else {

			Common.logger( colors.bgYellow.bold(`Deal ID ${dealId} was mid-${isSell ? 'sell' : 'buy'} verification at shutdown. Restarting verification loop.`) );

			const exchange = await connectExchange(dealObj.config || config);

			if (exchange) {

				let verifyCallback = null;

				// Base order interrupted mid-verify (isStart:0). On success, mark the base
				// order filled and advance to isStart=1 — identical to the normal base-order
				// success path. Pre-calculated qty/amount/average/target are preserved.
				if (!isSell && dealObj.isStart === 0) {

					const baseOrders = dealObj.orders || [];

					verifyCallback = async (verifyData) => {

						if (baseOrders[0]) {

							baseOrders[0].filled = 1;
							baseOrders[0].dateFilled = new Date();

							await Deals.updateOne({ dealId: dealId }, { isStart: 1, orders: baseOrders });
						}
					};
				}

				verifyInvalidOrder({ count: 0, mins: retryMins, exchange, pair, botId, dealId, orderId: pendingOrderId, onSuccessCallback: verifyCallback, pauseBeforeCallback: !isSell })
					.catch((e) => { try { Common.logger('verifyInvalidOrder (resume) background error for deal ' + dealId + ': ' + ((e && e.message) ? e.message : e)); } catch (le) {} });
			}
		}
	}
	else if (resumePauseReason === 'sell_error') {

		// A generic sell error paused this deal's sells (there is no order to verify). The in-memory
		// retry/reset tracker that would normally lift that pause does not survive a restart, so clear
		// the stale sell pause and resume cleanly — otherwise the deal would come back paused for sell
		// with nothing to lift it. (Mirrors the no-pending-order clean-resume path above.)
		Common.logger( colors.bgYellow.bold('Deal ID ' + dealId + ' was paused (sell_error) at shutdown; clearing pause and resuming.') );

		await pauseDeal(botId, dealId, false, false, false, '');
	}
	else if (resumePauseReason === 'buy_error') {

		// A non-in-flight buy failure (insufficient funds / exchange-cancelled / generic) paused this
		// deal's buys. There is no order to verify, and the in-memory state that would let it lift the
		// pause does not survive a restart, so clear the stale buy pause and resume cleanly — the same
		// outcome these failures had before they were split off from 'order_verify_buy' (which, with no
		// pending order ID, is cleared and resumed by the branch above).
		Common.logger( colors.bgYellow.bold('Deal ID ' + dealId + ' was paused (buy_error) at shutdown; clearing pause and resuming.') );

		await pauseDeal(botId, dealId, false, false, false, '');
	}

	// Resuming an existing deal — bypass requestDealStart/queue intentionally.
	// The deal already exists in the database (dealResumeId is set) so
	// canStartDeal checks do not apply. start() handles resume logic directly.
	// Detached (fire-and-forget) — guard the rejection so a transient error during resume/completion
	// chaining logs instead of becoming a process-level unhandled rejection; the live loop is unaffected.
	Promise.resolve(start({ 'create': true, 'config': config })).catch((e) => { Common.logger('resumeDeal start() failed: ' + (e && e.message ? e.message : e)); });

	await Common.delay(1000);
}


// Denominator for the circuit-breaker deal-ratio trigger: the number of active deals to divide the count
// of deals that fired a safety order by. Prefer the LIVE tracked count (authoritative inside the trading
// process, always populated); fall back to the last browser-refreshed cache, then 1. Pure — exported for
// testing. The whole point is that the live count works with no dashboard open (the cache would be 1).
function cbActiveDealDenominator(liveActive, cachedActive) {
	return liveActive > 0 ? liveActive : (cachedActive || 1);
}


// The $match stage selecting REALIZED closed deals for the portfolio-loss window. sellData.date is written
// only on a closed deal; canceled deals are excluded because a cancel keeps the coins and sells nothing —
// its sellData.profitQuote is an unrealized, marked-to-market figure that must not count as a realized
// loss/gain. Pure — exported for testing.
function portfolioLossMatchStage(windowStart) {
	return { 'sellData.date': { '$gte': windowStart }, 'canceled': { '$ne': true } };
}


function recordSafetyOrderTrigger(dealId, pair, price) {

	const cb = shareData.appData.circuit_breaker;
	if (!cb || !cb.enabled) return;

	const now = Date.now();
	const windowMs = (cb.deal_ratio_window_secs || 30) * 1000;

	// Initialize rolling window arrays
	if (!shareData.appData.cb_trigger_window) shareData.appData.cb_trigger_window = [];
	if (!shareData.appData.cb_price_tracker)  shareData.appData.cb_price_tracker  = {};

	// Add this trigger to rolling window
	shareData.appData.cb_trigger_window.push({ dealId, pair, price, time: now });

	// Prune entries outside the deal-ratio window
	shareData.appData.cb_trigger_window = shareData.appData.cb_trigger_window
		.filter(t => (now - t.time) <= windowMs);

	// Track price history per pair for drop detection
	const tracker = shareData.appData.cb_price_tracker;
	const dropWindowMs = (cb.price_drop_window_secs || 60) * 1000;
	if (!tracker[pair]) tracker[pair] = [];
	tracker[pair].push({ price: parseFloat(price), time: now });
	tracker[pair] = tracker[pair].filter(p => (now - p.time) <= dropWindowMs);

	// Skip if circuit breaker already active
	if (shareData.appData.circuit_breaker_active) return;

	// ── Deal ratio trigger ───────────────────────────────────────────────
	const uniqueDeals = new Set(shareData.appData.cb_trigger_window.map(t => t.dealId)).size;
	// Use the LIVE count of active deals the trading loop is tracking as the denominator. This runs inside
	// the trading process where dealTracker is authoritative and always populated (the deal that just fired
	// this safety order is in it), so the ratio is correct even on a headless / API-only deployment. The
	// cached cb_active_deal_count is only refreshed when a browser polls the active-deals endpoint, so it
	// was undefined → 1 with no dashboard open, which made a normal broad dip trip the breaker every window.
	// cbActiveDealDenominator falls back to the cached count, then 1, only if the live tracker is somehow
	// empty. Pure read — never throws.
	const totalActive = cbActiveDealDenominator(Object.keys(dealTracker).length, shareData.appData.cb_active_deal_count);
	const ratio = uniqueDeals / totalActive;
	const ratioThreshold = cb.deal_ratio_threshold || 0.5;

	if (ratio >= ratioThreshold && uniqueDeals >= 2) {

		activateCircuitBreaker(
			`Deal ratio: ${uniqueDeals}/${totalActive} deals triggered safety orders within ${cb.deal_ratio_window_secs}s`
		);
		return;
	}

	// ── Price drop trigger ───────────────────────────────────────────────
	// Each sample is the price at which a safety order fired for this pair, and a safety order fires
	// precisely when the market reaches that level — so the samples ARE the market price at each trigger
	// moment, not abstract ladder targets. Comparing the oldest to the newest sample still inside the
	// drop window therefore measures how far the market actually fell over that span. Because samples are
	// only taken when a safety order triggers, it detects a FAST multi-trigger cascade on one pair (the
	// market falling far enough, fast enough, to fire several safety orders within the window) — exactly
	// the crash the breaker exists to catch. A slow decline spaces the triggers out, so old samples prune
	// away and it does not fire. It is an approximate, trigger-sampled signal by design, not a continuous
	// ticker feed.
	const pairPrices = tracker[pair];
	if (pairPrices && pairPrices.length >= 2 && cb.price_drop_enabled !== false) {

		const oldest  = pairPrices[0].price;
		const newest  = pairPrices[pairPrices.length - 1].price;
		const dropPct = oldest > 0 ? ((oldest - newest) / oldest) * 100 : 0;
		const dropThreshold = cb.price_drop_percent || 5.0;

		if (dropPct >= dropThreshold) {

			activateCircuitBreaker(
				`Price drop: ${pair} fell ${dropPct.toFixed(2)}% within ${cb.price_drop_window_secs}s`
			);
		}
	}
}


function activateCircuitBreaker(reason) {

	const cb = shareData.appData.circuit_breaker;
	const pauseSecs = (cb && cb.pause_duration_secs) || 60;

	shareData.appData.circuit_breaker_active       = reason;
	shareData.appData.circuit_breaker_activated_at = Date.now();
	shareData.appData.circuit_breaker_clears_at    = Date.now() + (pauseSecs * 1000);

	Common.logger(colors.yellow.bold(`CIRCUIT BREAKER ACTIVATED (${pauseSecs}s): ${reason}`));

	// Build top affected pairs list from the trigger window
	const triggerWindow = shareData.appData.cb_trigger_window || [];
	const pairCounts = {};
	triggerWindow.forEach(t => { pairCounts[t.pair] = (pairCounts[t.pair] || 0) + 1; });
	const topPairs = Object.entries(pairCounts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([pair, count]) => `${pair} (${count})`)
		.join(', ');
	const pairsLine = topPairs ? `\nTop pairs: ${topPairs}` : '';

	// Check if CB has activated recently — elevated alert if so
	const now = Date.now();
	const cbRepeatWindowMs = ((cb && cb.repeat_alert_window_secs) || 3600) * 1000;
	const lastActivation = shareData.appData.circuit_breaker_last_activation || 0;
	const isRepeat = (now - lastActivation) <= cbRepeatWindowMs && lastActivation > 0;
	shareData.appData.circuit_breaker_last_activation = now;

	const prefix = isRepeat ? '🚨 Circuit Breaker Activated Again' : '⚡ Circuit Breaker Activated';
	const repeatLine = isRepeat
		? `\n⚠️ This is a repeat activation within ${Math.round((now - lastActivation) / 60000)}m — market conditions may be deteriorating.`
		: '';

	Common.sendNotification({
		'message': `${prefix}\n\n${reason}${pairsLine}${repeatLine}\n\nNew buys paused for ${pauseSecs}s. Sells and panic sells are unaffected.`,
		'type': 'warning',
		'event': 'circuit_breaker',
		'severity': 'critical',
		'telegram_id': shareData.appData.telegram_id
	});

	// Capture activation timestamp to guard against re-trigger clearing a newer activation
	const activatedAt = shareData.appData.circuit_breaker_activated_at;

	setTimeout(() => {

		if (shareData.appData.circuit_breaker_activated_at === activatedAt) {

			delete shareData.appData.circuit_breaker_active;
			delete shareData.appData.circuit_breaker_activated_at;
			delete shareData.appData.circuit_breaker_clears_at;
			shareData.appData.cb_trigger_window = [];
			Common.logger(colors.yellow.bold('CIRCUIT BREAKER CLEARED — resuming normal deal processing'));

			Common.sendNotification({
				'message': '✅ Circuit Breaker Cleared\n\nNormal deal processing has resumed.',
				'type': 'warning',
				'event': 'circuit_breaker',
				'severity': 'critical',
				'telegram_id': shareData.appData.telegram_id
			});
		}

	}, pauseSecs * 1000);
}


// Portfolio-loss circuit-breaker trigger. Runs periodically (opt-in, default off): sums realized money
// profit over the rolling window from CLOSED deals and, if the loss reaches the configured limit, trips
// the same circuit breaker the market-anomaly triggers use — so canStartDeal blocks NEW base orders
// until it clears. It NEVER force-closes an open deal. The check re-evaluates each interval, so once the
// breaker auto-clears it re-trips while the loss condition still holds (repeat alerts are rate-limited by
// repeat_alert_window_secs). Reads realized loss from the database, so a restart cannot reset the halt.
// Never throws — a query failure just skips this cycle.
async function checkPortfolioLoss() {

	try {

		const cb = shareData.appData.circuit_breaker;
		if (!cb || !cb.enabled || !cb.portfolio_loss_enabled) { return; }
		if (shareData.appData.circuit_breaker_active) { return; }   // already tripped (any trigger)

		const limit = Number(cb.loss_limit) || 0;
		if (limit <= 0) { return; }

		const windowHours = Number(cb.loss_window_hours) || 24;
		const windowStart = new Date(Date.now() - (windowHours * 3600 * 1000));

		// Realized money profit per pair over the window (sellData.date exists only on a closed deal, so
		// this matches completed deals). Group by pair, then fold into per-quote-currency net totals.
		// Exclude CANCELED deals: a cancel keeps the coins and sells nothing, yet handleSuccessfulSell still
		// writes a sellData.profitQuote marked-to-market for the record — that is an UNREALIZED figure, so
		// counting it here would let a cancel inject a fictitious loss (tripping the halt on money that was
		// never lost) or a fictitious gain (masking a real loss). Only genuinely-sold deals are realized.
		const agg = await getDeals(null, null, null, [
			{ '$match': portfolioLossMatchStage(windowStart) },
			// Coerce to double defensively (matching getBotPerformance): a stray string-typed profit would
			// otherwise be silently ignored by $sum, understating the realized loss and letting this safety
			// halt under-trip. $toDouble on a number is a no-op; $ifNull guards a missing field.
			{ '$group': { '_id': '$pair', 'profitSum': { '$sum': { '$toDouble': { '$ifNull': [ '$sellData.profitQuote', 0 ] } } } } }
		]);

		const byCur = {};
		for (const row of (Array.isArray(agg) ? agg : [])) {
			const ps = Number(row && row.profitSum);
			if (isNaN(ps)) { continue; }
			const pair = String((row && row._id) || '');
			// Bucket by the SAME canonical quote-currency helper the dashboard/journal use, so a mixed-case
			// or underscore-form pair can never split one currency's loss across two buckets and understate
			// the worst single-currency net (which would let the breaker under-halt). An unparseable pair
			// still counts under its own 'UNKNOWN' bucket — a loss is never silently dropped from the halt.
			const cur = shareData.Common.quoteCurrency(pair);
			byCur[cur] = (byCur[cur] || 0) + ps;
		}

		// Use the WORST single-currency net (most negative) as the realized loss, so a large loss in one
		// quote currency is never masked by profit in another — the conservative choice for a safety halt.
		let worstNet = 0;
		for (const c of Object.keys(byCur)) { if (byCur[c] < worstNet) { worstNet = byCur[c]; } }

		const decision = portfolioGuard.evaluatePortfolioLoss(worstNet, { 'enabled': true, 'lossLimit': limit, 'windowHours': windowHours });

		if (decision.halt) {

			Common.logger(colors.bgRed.bold('PORTFOLIO LOSS CIRCUIT BREAKER — ' + decision.reason));
			activateCircuitBreaker(decision.reason);
		}
	}
	catch (e) { Common.logger('Portfolio-loss check skipped: ' + (e && e.message ? e.message : e)); }
}


async function pauseDeal(botId, dealId, pause, pauseBuy, pauseSell, pauseReason = null) {

	let status;
	let success;
	let dataUpdated = {};

	pause = pause ?? false;

	if (pauseBuy && pauseSell) {

		// Both pauseBuy and pauseSell are true
		pause = true;
		pauseBuy = false;
		pauseSell = false;
	}
	else if (pause === false && (pauseBuy == undefined || pauseBuy == null) && (pauseSell == undefined || pauseSell == null)) {

		// Only pause passed as false
		pause = false;
		pauseBuy = false;
		pauseSell = false;
	}
	else if (pauseBuy === false && pauseSell === false) {

		// Both pauseBuy and pauseSell are false
		// Preserve pause as it is (initially false or not)
	}
	else if (pauseBuy || pauseSell) {

		// Either pauseBuy or pauseSell are true (but not both)
		pause = false;
	}

	const dbParams = {
		'paused': pause,
		'pausedBuy': pauseBuy,
		'pausedSell': pauseSell,
		'pauseReason': pauseReason
	};

	// Update only if values are defined
	for (const [dbKey, val] of Object.entries(dbParams)) {

		if (val != null) {

			// pauseReason is a string — write it as-is, do not convert to boolean
			const convertedVal = dbKey === 'pauseReason' ? val : Common.convertBoolean(val, false);

			const dataUpdate = await updateDeal(botId, dealId, {
				[dbKey]: convertedVal
			});

			dataUpdated[dbKey] = convertedVal;

			if (dataUpdate.success) {

				success = true;
				status = 'Pause status updated';
			}
			else {

				success = false;
				status = 'Pause update failed';
				break;
			}
		}
	}

	const dataObj = {
						'success': success,
						'data': 'Deal ID ' + dealId + ' ' + status,
						'data_updated': dataUpdated
					};

	if (shareData.appData.verboseLog) {

		Common.logger(colors.red.bold(dataObj));
	}

	return dataObj;
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


/**
 * Graceful close for the Signal Bot. A profit-GATED wrapper around the
 * existing panic_sell close path.
 *
 * It NEVER implements its own close routine. It reads the live deal metrics the
 * engine already maintains per tick (dealTracker[dealId]['info']), asks the pure
 * guard whether the take-profit target is met, and ONLY THEN delegates to
 * panicSellDeal — the same proven market-close used by the emergency button.
 * When the target is not met (or cannot be confirmed) the deal is left open.
 *
 * There is deliberately no flag that can force a close here; unconditional
 * closing is what panic_sell is for.
 *
 * Returns { success, closed, data, metrics }:
 *   - closed:false, success:true  → target not met, deal intentionally left open
 *   - closed:true,  success:true  → target met, close delegated to panicSellDeal
 *   - success:false               → the underlying close path reported an error
 */
async function gracefulCloseDeal(dealId) {

	let info = {};
	let takeProfitPercent = null;

	// Live metrics + configured take-profit, straight from the deal tracker the
	// engine updates each price tick. Guarded so a missing/partial tracker simply
	// yields "not determinable" (fail-safe) rather than throwing.
	try {

		if (dealTracker[dealId] != undefined && dealTracker[dealId] != null && dealTracker[dealId]['info'] != undefined && dealTracker[dealId]['info'] != null) {

			info = dealTracker[dealId]['info'];
		}
	}
	catch (e) {}

	try {

		takeProfitPercent = dealTracker[dealId]['deal']['config']['dcaTakeProfitPercent'];
	}
	catch (e) {}

	// dealTracker.info.price_last is refreshed each tick from fetchTicker, so during
	// an exchange auth storm it can hold a nonzero-but-garbage value (the same bad
	// input the tick-loop guard rejects). A garbage-high price_last would clear the
	// take-profit target and let this graceful close finalize the deal. Apply the
	// same plausibility guard here (reference = the deal's DCA average, also in info)
	// and treat an implausible price as "not determinable" — fail-safe, leave open —
	// exactly like evaluateGracefulClose does when there is no live price.
	const cbCfgPrice = shareData.appData.circuit_breaker || {};

	const priceSanity = PriceGuard.evaluatePriceSanity({
		'price': info['price_last'],
		'reference': info['price_average'],
		'maxHighRatio': cbCfgPrice.price_deviation_high_ratio,
		'maxLowRatio': cbCfgPrice.price_deviation_low_ratio
	});

	if (!priceSanity.plausible) {

		return {
			'success': true,
			'closed': false,
			'data': 'Live price appears implausible (' + priceSanity.message + '); deal left open',
			'metrics': priceSanity
		};
	}

	const decision = shareData.SignalBot.evaluateGracefulClose({
		'price_last': info['price_last'],
		'price_target': info['price_target'],
		'profit_percentage': info['profit_percentage'],
		'take_profit_percent': takeProfitPercent
	});

	if (!decision['ready']) {

		// Target not met / not determinable — do NOT close.
		return {
			'success': true,
			'closed': false,
			'data': decision['message'],
			'metrics': decision
		};
	}

	// Target met — reuse the EXISTING close path. This is panicSellDeal gated by
	// the profit check above; it is not a second close implementation.
	const closeData = await panicSellDeal(dealId);

	return {
		'success': closeData['success'],
		'closed': closeData['success'] ? true : false,
		'data': closeData['success'] ? 'Profit target met; deal closed at market' : closeData['data'],
		'metrics': decision
	};
}


async function estimateFunds({ dealId, sum, qtySum, targetPrice, price, exchangeFee, targetProfitPercent, maxFunds = Infinity, feeMultiplier = 1 }) {

	const target = parseFloat(targetPrice);
	const qtySumFloat = parseFloat(qtySum);
	const sumFloat = parseFloat(sum);
	const currentPrice = parseFloat(price);

	// Fee applied to the funds-needed gross-up, as a multiple of the configured exchange fee. Defaults to 1
	// (single, buy-side fee) so the estimate matches the live take-profit target, price × (1 + (takeProfit +
	// fee)/100); a caller that wants the round-trip cost can pass feeMultiplier: 2. Clamp the resulting rate so
	// a misconfigured fee (or a large multiplier) can never drive the (1 - feeRate) denominator to zero or
	// negative.
	const feeMult = (Number(feeMultiplier) > 0) ? Number(feeMultiplier) : 1;
	const feeRateRaw = (parseFloat(exchangeFee) / 100) * feeMult;
	const feeRate = (isFinite(feeRateRaw) && feeRateRaw > 0) ? Math.min(feeRateRaw, 0.99) : 0;
	const profitMultiplier = 1 + (parseFloat(targetProfitPercent) / 100);
	const requiredValue = (sumFloat * profitMultiplier) / (1 - feeRate);
	const additionalValueNeeded = requiredValue - (currentPrice * qtySumFloat);

	let amountWithFees = 0;
	let avgPrice_funds = 0;
	let avgChangePercent = 0;
	let targetChangePercent = 0;
	let success = true;
	let message = '';


	if (target > currentPrice && additionalValueNeeded > 0) {

		const additionalQty = additionalValueNeeded / (target - currentPrice);
		amountWithFees = additionalQty * currentPrice;
		amountWithFees = amountWithFees / (1 - feeRate);
	
		if (amountWithFees > maxFunds) {

			success = false;
			message = 'Insufficient funds to reach target profit';
			amountWithFees = maxFunds;
		}
	}
	else {

		// No funds needed or not possible to calculate
		success = false;
		amountWithFees = 0;
	}

	// Forward math (amount -> new average / target) is shared with the Add Funds
	// Estimator via AddFundsMath so the calculator and the engine can never drift.
	// estimateFunds solves for the amount above; this computes the resulting
	// averages/targets from it, at the current market price.
	const fwd = AddFundsMath.computeAddFundsForward({
		'sum': sumFloat,
		'qtySum': qtySumFloat,
		'addAmount': amountWithFees,
		'addPrice': currentPrice,
		'price': currentPrice,
		'exchangeFee': exchangeFee,
		'targetProfitPercent': targetProfitPercent
	});

	let totalFee = fwd.exchange_fee_total;
	amountWithFees = fwd.add_amount_gross;
	const amountWithoutFees = fwd.add_amount_net;

	const avgPrice_net = fwd.average_price_net;
	const avgPrice_gross = fwd.average_price_gross;
	const newTargetPrice_net = fwd.target_price_net;
	const newTargetPrice_gross = fwd.target_price_gross;

	// Process new estimated funds for average price accuracy
	if (dealId != undefined && dealId != null && dealId != '') {

		const addFundsObj = await addFundsDeal(dealId, avgPrice_net, true);

		if (addFundsObj.success) {

			const addFundsOrders = addFundsObj.orders;
			const filledOrders = addFundsOrders.filter(item => item.filled == 1);
			const currentOrder = filledOrders.pop();

			// Guard the empty-ladder edge: if a (dry-run) add produced no filled order, pop() is undefined —
			// leave avgPrice_funds at its default rather than throwing on currentOrder.average.
			if (currentOrder) { avgPrice_funds = parseFloat(currentOrder.average); }
		}
	}

	if (qtySumFloat > 0 && avgPrice_net < (sumFloat / qtySumFloat)) {

		const prevAvg = sumFloat / qtySumFloat;
		avgChangePercent = ((prevAvg - avgPrice_net) / prevAvg) * 100;
	}

	if (newTargetPrice_net < target) {
		
		targetChangePercent = ((target - newTargetPrice_net) / target) * 100;
	}

	return {
		success,
		message,
		amount_net: amountWithoutFees,
		amount_gross: amountWithFees,
		exchange_fee_total: totalFee,
		average_price_net: Number(avgPrice_net.toFixed(8)),
		average_price_gross: Number(avgPrice_gross.toFixed(8)),
		average_price_add_funds: Number(avgPrice_funds.toFixed(8)),
		target_price_net: Number(newTargetPrice_net.toFixed(8)),
		target_price_gross: Number(newTargetPrice_gross.toFixed(8)),
		average_price_change_percent: Number(avgChangePercent.toFixed(2)),
		target_price_change_percent: Number(targetChangePercent.toFixed(2))
	};
}


// Whether an add-funds should place a REAL exchange order: only for a LIVE deal (not sandbox/paper) that is
// NOT a dry-run estimate. A dry-run must never touch the exchange, even on a live deal. Extracted as a pure
// helper so this money-safety invariant is explicit and unit-testable; identical to the prior inline gate.
function shouldPlaceRealOrder(config, dryRun) {

	return !config.sandBox && !dryRun;
}


// Resolve the executed VALUE (quote-currency cost) and effective PRICE of a buy fill from a data_order,
// using the SAME cross-exchange precedence the sell side uses (see recordFill): CCXT `average` (a pure
// volume-weighted fill price, so it can never silently fold in fees — safest) → `amount`/cost →
// `price` × qty. An exchange that reports none of these usable returns value 0, and the caller then
// DECLINES to auto-credit (falling back to the safe pause + reconcile alert) rather than guess — which
// is exactly how the buy path already behaves for exchanges that omit fill data.
function resolveBuyFillValue(dataOrder, qtyFilled) {

	const q = Number(qtyFilled) || 0;
	if (!(q > 0) || !dataOrder) { return { 'value': 0, 'price': 0 }; }

	const avg = Number(dataOrder['average']);
	if (isFinite(avg) && avg > 0) { return { 'value': avg * q, 'price': avg }; }

	const cost = Number(dataOrder['amount']);
	if (isFinite(cost) && cost > 0) { return { 'value': cost, 'price': cost / q }; }

	const px = Number(dataOrder['price']);
	if (isFinite(px) && px > 0) { return { 'value': px * q, 'price': px }; }

	return { 'value': 0, 'price': 0 };
}


// Credit an actual (partial) BUY fill onto an existing ladder rung, so coin the exchange executed is
// booked into the deal instead of being stranded and the deal paused. It reuses the same construction
// addFundsDeal uses for a manual order: run the NET filled quantity through calculateAdjustments to get
// the SAME gross quantity + fee metadata every other rung carries (so the sell's net = gross − fee
// reconciles back to what is actually held), mark the rung filled+manual (so recalculateOrders keeps the
// real fill fixed instead of re-deriving it from min-movement), then recompute the whole ladder and
// every take-profit target through the shared recalculateOrders. No exchange order is placed here — the
// fill already happened. Fully guarded: any problem returns { success:false } and the caller keeps the
// existing safe behavior (pause + reconcile alert), so this can never make a fill worse.
async function creditPartialBuyFill({ exchange, pair, config, dealId, orderIndex, orders, filledQtyNet, fillPrice, fillValue, orderId }) {

	try {

		if (!(Number(filledQtyNet) > 0) || !(Number(fillPrice) > 0)) { return { 'success': false, 'msg': 'no usable fill quantity/price' }; }

		const rung = orders[orderIndex];
		if (!rung) { return { 'success': false, 'msg': 'rung not found' }; }

		// Running totals continue from the nearest PRIOR filled rung (null for the base order).
		let prev = null;
		for (let j = orderIndex - 1; j >= 0; j--) {

			if (orders[j] && (orders[j].filled === 1 || orders[j].filled === true)) { prev = orders[j]; break; }
		}

		const price  = await filterPrice(exchange, pair, fillPrice);
		let   amount = await filterPrice(exchange, pair, (Number(fillValue) > 0 ? fillValue : (Number(filledQtyNet) * Number(fillPrice))));
		let   qty    = await filterAmount(exchange, pair, filledQtyNet);

		const minMoveAmount = orders[0]?.orderMetadata?.minimum_movement_amount ?? rung?.orderMetadata?.minimum_movement_amount;

		// Same gross-up + fee metadata the ladder builds for every rung (calculateAdjustments adds the
		// round-trip fee quantity so the sell's net-of-fee figure lands on the quantity actually held).
		const adjustments = await calculateAdjustments({ exchange, pair, price, amount, orderSize: qty, exchangeFee: config.exchangeFee, minMoveAmount });
		if (adjustments && adjustments.order_qty) { qty = adjustments.order_qty; amount = adjustments.order_amount; }

		let qtySum = await filterAmount(exchange, pair, parseFloat(qty) + parseFloat(prev?.qtySum || 0));
		let sum    = await filterPrice(exchange, pair, parseFloat(amount) + parseFloat(prev?.sum || 0));
		sum = Common.roundCost(sum, pair);

		const average = await filterPrice(exchange, pair, (parseFloat(sum) / parseFloat(qtySum)));
		const target  = await calculateTargetPrice({ exchange, pair, price: average, takeProfit: config.dcaTakeProfitPercent, exchangeFee: config.exchangeFee });

		if (!(Number(target) > 0)) { return { 'success': false, 'msg': 'unable to compute a valid target price' }; }

		orders[orderIndex] = {
			...rung,
			price,
			average,
			target,
			qty,
			amount,
			qtySum,
			sum,
			filled: 1,
			manual: true,
			// Persisted flag that records this manual rung as a SYSTEM action, exactly the way pauseReason
			// records a system pause: a system-applied change carries a reason string, a user action has none
			// (a user Add-Funds rung sets no manualReason). Lets the UI show "system" vs "user done" without
			// guessing. Purely descriptive — never read by any trading/recalculation logic; recalculateOrders
			// mutates rungs in place, so it survives the recompute below.
			manualReason: 'partial_fill_credit',
			orderId: orderId || rung.orderId || '',
			dateFilled: new Date(),
			orderMetadata: (adjustments && adjustments.order_qty) ? adjustments : rung.orderMetadata
		};

		// Recompute the ladder (downstream averages + EVERY take-profit target) and persist — the same
		// shared recompute handleSuccessfulBuy and add-funds use. The manual flag keeps THIS rung's real
		// fill fixed while every other rung's average/target is recomputed from the corrected running sum.
		const recalc = await recalculateOrders({ exchange, dealId, orders, orderNo: orders[orderIndex].orderNo, orderIndex: undefined, orderId: undefined, price: undefined, dryRun: false });

		return { 'success': !!(recalc && recalc.success), 'msg': (recalc && recalc.msg) || 'recalc failed' };
	}
	catch (e) {

		return { 'success': false, 'msg': (e && e.message) ? e.message : String(e) };
	}
}


async function addFundsDeal(dealId, volume, dryRun) {

	let success = false;
	let isUpdated = false;
	let ordersReturn = [];
	let msg = 'Success';

	const deal = await Deals.findOne({
		dealId: dealId,
		status: 0,
	});

	if (deal) {

		let orderNo;

		const configDeal = JSON.parse(JSON.stringify(deal.config));
		const orders = JSON.parse(JSON.stringify(deal.orders));
		const config = await initConfigData(configDeal);

		Common.logger(colors.red.bold('Add Funds to deal ID ' + dealId + ' requested.'));

		let oldOrders = orders;
		let exchange = await connectExchange(config);

		if (exchange) {

			volume = await filterPrice(exchange, config.pair, volume);

			const allOrdersFilled = oldOrders.every(order => order.filled);

			async function handleOrder(order, previousOrder = null) {

				const symbolData = await getSymbol(exchange, config.pair);
				const symbol = symbolData.data;

				// Honor the getSymbol success/error contract: it returns success:false (data undefined) on any
				// network / exchange / auth / bad-symbol failure precisely so a caller never sizes or places an
				// order on a missing or bad price. The automated follow loop holds the deal on this; addFundsDeal
				// has no outer try/catch, so without this guard the `symbol.ask` deref below would throw straight
				// out to the API caller. Bail the same way the other failure paths here do (set msg, return early
				// — no order is placed).
				if (!symbolData.success || symbol == undefined || symbol == null || symbol.ask == undefined || symbol.ask == null) {

					msg = 'Unable to add funds to deal ID ' + dealId + ': could not fetch a current price for ' + config.pair + (symbolData.error ? ' (' + symbolData.error + ')' : '') + '. Please try again.';

					return;
				}

				const askPrice = symbol.ask;

				let price = await filterPrice(exchange, config.pair, askPrice);
				let amount = await filterPrice(exchange, config.pair, volume);
				let qty = await filterAmount(exchange, config.pair, (parseFloat(volume) / parseFloat(askPrice)));

				let minMoveAmount = oldOrders[0]?.orderMetadata?.minimum_movement_amount;

				const adjustments = await calculateAdjustments({
					exchange,
					pair: config.pair,
					price,
					amount,
					orderSize: qty,
					exchangeFee: config.exchangeFee,
					minMoveAmount,
				});

				qty = adjustments.order_qty;
				amount = adjustments.order_amount;

				let qtySum = parseFloat(qty) + parseFloat(previousOrder?.qtySum || 0);
				qtySum = await filterAmount(exchange, config.pair, qtySum);

				let orderSum = parseFloat(amount) + parseFloat(previousOrder?.sum || 0);
				orderSum = await filterPrice(exchange, config.pair, orderSum);

				// Round the cost basis to the quote currency's precision (see Common.roundCost).
				orderSum = Common.roundCost(orderSum, config.pair);

				const avgPrice = await filterPrice(exchange, config.pair, (orderSum / qtySum));

				const targetObj = {
					exchange,
					pair: config.pair,
					price: avgPrice,
					takeProfit: config.dcaTakeProfitPercent,
					exchangeFee: config.exchangeFee,
				};

				const targetPrice = await calculateTargetPrice(targetObj);

				if (targetPrice > 0) {

					let newOrder = {
						...order,
						price,
						average: avgPrice,
						target: targetPrice,
						qty,
						amount,
						qtySum,
						sum: orderSum,
						filled: 1,
						manual: true,
						orderMetadata: adjustments,
						dateFilled: new Date()
					};

					// Place a REAL exchange buy only for a live, non-dry-run add. dryRun is an estimate/preview
					// and must NEVER touch the exchange — previously the buy was gated on sandBox alone, so a
					// dry-run add on a LIVE deal would have placed an unintended market order. (Not reachable
					// today — the only dry-run caller estimates without a real deal id — but this closes the
					// footgun so any future dry-run add on a live deal stays side-effect-free.)
					if (shouldPlaceRealOrder(config, dryRun)) {

						const buy = await buyOrder({ exchange, dealId, pair: config.pair, qty, price });

						if (!buy.success) {

							msg = buy;

							return;
						}

						newOrder.orderId = buy.data.id;
					}
					else if (dryRun) {

						// Synthesize a placeholder id so the estimated order object is complete; it is never
						// persisted (the updateDeal below is skipped when dryRun).
						newOrder.orderId = 'dryrun';
					}

					let insertionIndex;

					// Insert the newOrder into oldOrders first
					if (previousOrder) {

						const previousIndex = oldOrders.indexOf(previousOrder);

						insertionIndex = previousIndex + 1;
						oldOrders.splice(insertionIndex, 0, newOrder);
					}
					else {

						oldOrders.push(newOrder);
						insertionIndex = oldOrders.length - 1;
					}

					// Set orderNo based on insertion index
					newOrder.orderNo = insertionIndex + 1;

					// Increment orderNo for all subsequent orders
					for (let j = insertionIndex + 1; j < oldOrders.length; j++) {

						let orderNoOrig = oldOrders[j].orderNo;

						oldOrders[j].orderNo = Number(orderNoOrig) + 1;
					}

					orderNo = newOrder.orderNo;

					isUpdated = true;
					success = true;
				}
				else {

					msg = 'Unable to calculate target price: ' + JSON.stringify(targetObj);
				}
			}

			if (allOrdersFilled) {

				await handleOrder(null, oldOrders[oldOrders.length - 1]);
			}
			else {

				for (let i = 0; i < oldOrders.length; i++) {

					if (!oldOrders[i].filled && !isUpdated) {

						await handleOrder(oldOrders[i], i > 0 ? oldOrders[i - 1] : null);
					}
				}
			}

			if (success) {

				let dryRunOrders;

				ordersReturn = oldOrders;

				if (!dryRun) {

					const botId = deal.botId;

					await updateDeal(botId, dealId, {
						config: deal.config,
						orders: oldOrders
					});
				}
				else {

					// Pass orders to recalculate without updating db when using dryRun
					dryRunOrders = oldOrders;
				}

				let recalcObj = await recalculateOrders({
					'exchange': exchange,
					'dealId': dealId,
					'orders': dryRunOrders,
					'orderIndex': undefined,
					'orderNo': orderNo,
					'orderId': undefined,
					'price': undefined,
					'dryRun': dryRun
				});

				if (recalcObj.success) {

					ordersReturn = null;

					ordersReturn = recalcObj.orders;
				}
			}
		}
		else {

			msg = 'Unable to connect to exchange';
		}
	}
	else {

		msg = 'Deal ID not found';
	}

	return { 'success': success, 'data': msg, 'orders': ordersReturn };
}


async function recalculateOrders(params) {

	let deal;
	let config;
	let success = false;
	let orderFound = false;
	let oldOrders = [];
	let ordersReturn = [];
	let orderIndex = -1;
	let msg = 'Success';

	// Defensive outer guard: the recompute below calls exchange / filter / target helpers that can throw.
	// Any throw becomes this function's normal { success:false } result — the same contract it already
	// returns for not-found / out-of-bounds — so a recompute failure never rejects into the caller. The deal
	// keeps its pre-recompute ladder values (correct for ladder-price fills) and is corrected on the next
	// recalculation trigger.
	try {

	deal = await Deals.findOne({
		dealId: params.dealId,
		status: 0
	});

	if (!deal) {

		msg = 'Deal ID not found';
	}
	else {

		config = await initConfigData(JSON.parse(JSON.stringify(deal.config)));
		oldOrders = params.orders || JSON.parse(JSON.stringify(deal.orders));

		Common.logger(colors.red.bold(`Recalculating orders for deal ID ${params.dealId}`));

		try {

			if (!params.exchange) {

				params.exchange = await connectExchange(config);
				await params.exchange.loadMarkets();
			}
		}
		catch (error) {

			Common.logger('Error connecting to exchange: ' + error.message);
			msg = 'Error connecting to exchange';
		}

		['orderNo'].forEach(key => {
			
			if (params[key] !== undefined && params[key] !== null && params[key] !== '') {

				params[key] = Number(params[key]);
			}
		});

		if (params.exchange) {

			if (params.orderIndex !== undefined && params.orderIndex !== null && params.orderIndex !== '') {

				const parsedIndex = parseInt(params.orderIndex, 10);

				if (isNaN(parsedIndex)) {

					msg = 'Order index must be a valid number';
				}
				else if (parsedIndex < 0 || parsedIndex >= oldOrders.length) {

					msg = 'Order index out of bounds';
				}
				else {

					orderFound = true;
					orderIndex = parsedIndex;
				}
			}
			else {

				if (params.orderId) {

					for (let i = 0; i < oldOrders.length; i++) {

						if (oldOrders[i].orderId === params.orderId) {

							orderIndex = i;
							orderFound = true;

							break;
						}
					}
				}
				else if (typeof params.orderNo === 'number') {

					for (let i = 0; i < oldOrders.length; i++) {

						if (Number(oldOrders[i].orderNo) === params.orderNo) {

							orderIndex = i;
							orderFound = true;

							break;
						}
					}
				}
			}

			if (!orderFound) {

				msg = 'Order ID or orderNo not found';
			}
			else {

				// Update specified order with adjusted values
				const updatedPrice = params.price !== undefined ? params.price : oldOrders[orderIndex].price;

				const adjustedOrder = await getAdjustedOrder(
					params.exchange,
					config.pair,
					updatedPrice,
					oldOrders[orderIndex].amount,
					oldOrders[orderIndex].qty,
					config.exchangeFee,
					config.minMoveAmount
				);

				oldOrders[orderIndex].price = updatedPrice;
				oldOrders[orderIndex].amount = adjustedOrder.order_amount;
				oldOrders[orderIndex].qty = adjustedOrder.order_qty;

				// Recalculate all orders
				let runningQtySum = 0;
				let runningSum = 0;
				let allTargetsValid = true;

				for (let i = 0; i < oldOrders.length; i++) {

					let currentOrder = oldOrders[i];

					if (currentOrder.filled && currentOrder.manual) {

						runningQtySum = parseFloat(currentOrder.qtySum);
						runningSum = parseFloat(currentOrder.sum);
					}
					else {

						// Adjust order again (skip if already done above)
						if (i !== orderIndex) {

							const adjusted = await getAdjustedOrder(
								params.exchange,
								config.pair,
								currentOrder.price,
								currentOrder.amount,
								currentOrder.qty,
								config.exchangeFee,
								config.minMoveAmount
							);

							currentOrder.amount = adjusted.order_amount;
							currentOrder.qty = adjusted.order_qty;
						}

						currentOrder.qtySum = parseFloat(runningQtySum) + parseFloat(currentOrder.qty);
						currentOrder.sum = parseFloat(runningSum) + parseFloat(currentOrder.amount);

						currentOrder.qtySum = await filterAmount(params.exchange, config.pair, currentOrder.qtySum);
						currentOrder.sum = await filterPrice(params.exchange, config.pair, currentOrder.sum);

						// Round the cost basis to the quote currency's precision (see Common.roundCost).
						currentOrder.sum = Common.roundCost(currentOrder.sum, config.pair);

						runningQtySum = parseFloat(currentOrder.qtySum);
						runningSum = parseFloat(currentOrder.sum);

						currentOrder.average = await filterPrice(
							params.exchange,
							config.pair,
							(parseFloat(currentOrder.sum) / parseFloat(currentOrder.qtySum))
						);

						const targetPrice = await calculateTargetPrice({
							'exchange': params.exchange,
							'pair': config.pair,
							'price': currentOrder.average,
							'takeProfit': config.dcaTakeProfitPercent,
							'exchangeFee': config.exchangeFee
						});

						if (targetPrice && targetPrice > 0) {

							currentOrder.target = targetPrice;
						}
						else {

							allTargetsValid = false;

							msg = 'Unable to calculate target price: ' + JSON.stringify({
								'price': currentOrder.average,
								'takeProfit': config.dcaTakeProfitPercent,
								'exchangeFee': config.exchangeFee
							});
						}
					}
				}

				if (allTargetsValid) {

					if (!params.dryRun) {

						await updateDeal(deal.botId, params.dealId, {
							config: deal.config,
							orders: oldOrders
						});
					}

					success = true;
					ordersReturn = oldOrders;
				}
			}
		}
	}
	}
	catch (error) {

		success = false;
		msg = 'Error recalculating orders for deal ' + params.dealId + ': ' + ((error && error.message) ? error.message : error);
		Common.logger(msg);
	}

	return { 'success': success, 'data': msg, 'orders': ordersReturn };
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


// startDelay is a compatibility shim — all work delegated to requestDealStart.
// External callers (DCABotManager, signals) pass { config, delay, notify }.
// Returns the startId string directly so apiStartDealProcess polling still works.
async function startDelay(dataObj) {

	const data   = JSON.parse(JSON.stringify(dataObj));
	const config = data['config'];
	const notify = data['notify'];
	const delay  = data['delay'] || 0;

	if (notify) {

		const msg = config.botName + ' (' + (config.pair || '').toUpperCase() + ') Start command received.';
		Common.sendNotification({ 'message': msg, 'type': 'bot_start', 'telegram_id': shareData.appData.telegram_id });
	}

	const result = await requestDealStart(config, delay, 'api/signal');

	return result.startId;
}


async function initApp() {

	// Initialize the serial deal-start queue — single path for all new deals
	dealStartQueue = await shareData.Queue.create();


	shareData.appData.starting_dca = true;

	const loadMarketHours = 4;

	// Don't initialize if resetting database
	if (shareData.appData.reset) {

		return;
	}

	setInterval(() => {

		// .catch for the same reason as the trackers below — a timer callback has no awaiter, so a
		// rejection would otherwise be an unhandled process-level rejection. Log and keep the timer.
		Promise.resolve(loadExchangeMarkets()).catch((e) => Common.logger('loadExchangeMarkets error: ' + ((e && (e.stack || e.message)) || e)));

	}, (loadMarketHours * 60 * 60 * 1000));


	setInterval(() => {

		// .catch: these run on a timer with no awaiter, so a rejection would otherwise be an unhandled
		// process-level rejection. Log and continue — the timer keeps firing on its next tick.
		checkTrackers().catch((e) => Common.logger('checkTrackers error: ' + ((e && (e.stack || e.message)) || e)));

	}, (60000 * 1));


	setInterval(() => {

		checkResumeDealTracker().catch((e) => Common.logger('checkResumeDealTracker error: ' + ((e && (e.stack || e.message)) || e)));

	}, (60000 * 1));


	setInterval(() => {

		Promise.resolve(getBalanceTracker()).catch((e) => Common.logger('getBalanceTracker error: ' + ((e && (e.stack || e.message)) || e)));

	}, (60000 * 1));


	setInterval(() => {

		checkStartDealTracker().catch((e) => Common.logger('checkStartDealTracker error: ' + ((e && (e.stack || e.message)) || e)));

	}, 1500);


	// Portfolio-loss circuit breaker — re-evaluate realized losses every minute (no-op unless enabled).
	setInterval(() => {

		Promise.resolve(checkPortfolioLoss()).catch((e) => Common.logger('checkPortfolioLoss error: ' + ((e && (e.stack || e.message)) || e)));

	}, (60000 * 1));

	// Encrypt any plaintext exchange credentials at rest before deals resume (idempotent; never
	// blocks startup). connectExchange decrypts them again at connect time.
	await Common.migrateBotCredentials();

	// NOTE: the per-instance data-layout migration (legacy logs/backups → data/instances/<server_id>/)
	// runs in symbot.js the moment server_id is resolved — NOT here. App init runs before the database
	// connects and server_id is known, so running it here would find no server_id and no-op.

	await resumeBots();

	// Prime the balance cache immediately so the portfolio bar
	// shows correct data on first load rather than waiting 60s
	getBalanceTracker();

	// Best-effort: contain a possible throw from its early config/secret reads so it can never
	// surface as an unhandled rejection during trading-engine startup.
	Promise.resolve(Common.startSignals()).catch(() => {});

	delete shareData.appData.starting_dca;
}


module.exports = {

	colors,
	start,
	updateBot,
	sendBotStatus,
	ordersValid,
	ordersToStructuredData,
	updateOrders,
	cancelDeal,
	pauseDeal,
	stopDeal,
	createStartDealTracker,
	deleteStartDealTracker,
	updateDeal,
	refreshUpdateDeal,
	addFundsDeal,
	creditPartialBuyFill,
	resolveBuyFillValue,
	partialFillShortfallPercent,
	retryPartialFill,
	recalculateOrders,
	panicSellDeal,
	gracefulCloseDeal,
	connectExchange,
	removeConfigData,
	initBot,
	getBots,
	deleteBot,
	deleteDeals,
	getDeals,
	getDealsMaxUsedFunds,
	getDealInfo,
	getDealTracker,
	getStartDealTracker,
	getResumeDealTracker,
	getActiveDeals,
	buildResumeInfo,          // exported for testing: the non-live resumed-deal snapshot for the active-deals view
	summarizeExchangeError,   // exported for testing: the shared concise ccxt/network error summarizer
	cbActiveDealDenominator,  // exported for testing: circuit-breaker deal-ratio denominator (live vs cached active count)
	portfolioLossMatchStage,  // exported for testing: the realized-deal $match for the portfolio-loss window
	getSymbol,
	getSymbolsAll,
	getBalanceTracker,
	getBalanceCache,
	checkGlobalPairLimit,
	canStartDeal,
	applyConfigData,
	startDelay,
	requestDealStart,
	resumeDeal,
	getOHLCV,
	getBalance,
	getPairData,
	calculateMaxFunds,
	calculateTargetPrice,
	getDeviationDca,
	shouldPlaceRealOrder,
	removeDbKeys,
	convertDataToSandBox,
	getExchangeAlias,
	verifyInvalidOrder,
	updateOrderDeal,

	init: function(obj) {

		shareData = obj;

		initApp();
    }
}