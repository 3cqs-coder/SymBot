'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const pathRoot = path.resolve(__dirname, ...Array(3).fill('..'));

let shareData;
// Deal starts are serialised by DCABot.requestDealStart via dealStartQueue
let symbolList = {};

/*
 * Journal stats cache.
 *
 * apiGetJournalStats fetches every closed deal matching the filter and runs
 * getProcessedDeals over all of them — for an "all bots" history with many
 * closed deals this is the slow part users feel each time they open the journal
 * or switch filters. We cache the computed stats payload keyed on the filter
 * dimensions (botId + date range + timezone).
 *
 * Memory is bounded deliberately: at most JOURNAL_STATS_CACHE_MAX entries, each
 * a small summary object (a handful of numbers + a short mood array — NOT the
 * deals themselves), evicted oldest-first (LRU-ish via Map insertion order). A
 * short TTL means a newly closed deal is reflected within JOURNAL_STATS_CACHE_TTL
 * without having to hook the trading hot path, and user-driven changes (mood
 * saves) invalidate explicitly for immediacy.
 */
const JOURNAL_STATS_CACHE_MAX = 32;          // hard cap on entries (memory bound)
const JOURNAL_STATS_CACHE_TTL = 30 * 1000;   // ms; auto-refresh window
const journalStatsCache = new Map();          // key -> { at, payload }

function journalStatsCacheGet(key) {

	const hit = journalStatsCache.get(key);

	if (!hit) { return null; }

	if ((Date.now() - hit.at) > JOURNAL_STATS_CACHE_TTL) {

		journalStatsCache.delete(key);
		return null;
	}

	// Refresh recency (move to newest) so eviction is LRU-ish.
	journalStatsCache.delete(key);
	journalStatsCache.set(key, hit);

	return hit.payload;
}

function journalStatsCacheSet(key, payload) {

	if (journalStatsCache.has(key)) { journalStatsCache.delete(key); }

	journalStatsCache.set(key, { at: Date.now(), payload: payload });

	// Evict oldest entries beyond the cap.
	while (journalStatsCache.size > JOURNAL_STATS_CACHE_MAX) {

		const oldestKey = journalStatsCache.keys().next().value;
		journalStatsCache.delete(oldestKey);
	}
}

// Clears the whole stats cache. Called when saved data that feeds the stats
// (currently mood tags) changes, so the next read recomputes.
function journalStatsCacheClear() {

	journalStatsCache.clear();
}


async function viewCreateUpdateBot(req, res, botId) {

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

	const symbols = await getSymbolList();

	if (!botUpdate) {

		const botConfigFile = shareData.appData.bot_config;
		const botConfig     = await shareData.Common.getConfig(botConfigFile);

		botData = botConfig.data;
	}

	const { startConditionString, startConditionSubString } = buildStartConditionStrings(shareData.appData.bots, botData);
	const symbolString  = buildSymbolString(symbols, botData);
	const activeChecked = buildActiveChecked(botData);

	res.render( 'strategies/DCABot/DCABotCreateUpdateView', { 'formAction': formAction, 'appData': shareData.appData, 'botUpdate': botUpdate, 'botData': botData, 'errorData': errMsg, 'startConditionString': startConditionString, 'startConditionSubString': startConditionSubString, 'symbolString': symbolString, 'activeChecked': activeChecked } );
}


async function viewActiveDeals(req, res) {

	res.render( 'strategies/DCABot/DCABotDealsActiveView', { 'appData': shareData.appData, 'convertBoolean': shareData.Common.convertBoolean.toString(), 'getCurrencySymbol': shareData.Common.getCurrencySymbol.toString(), 'computeAddFundsForward': require(shareData.appData.path_root + '/libs/app/AddFundsMath.js').computeAddFundsForward.toString() } );
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

	res.render( 'strategies/DCABot/DCABotsView', { 'appData': shareData.appData, 'getDateParts': shareData.Common.getDateParts, 'timeDiff': shareData.Common.timeDiff, 'getCurrencySymbol': shareData.Common.getCurrencySymbol, 'bots': botsSort } );
}


async function viewHistoryDeals(req, res) {

	res.render( 'strategies/DCABot/DCABotDealsHistoryView', { 'appData': shareData.appData, 'getCurrencySymbol': shareData.Common.getCurrencySymbol.toString() } );
}


async function viewTransactionExport(req, res) {

	res.render( 'strategies/DCABot/DCABotTransactionExportView', { 'appData': shareData.appData } );
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


// Streams a per-transaction CSV of closed deals formatted for crypto-tax tools
// (Koinly Universal). Transactions only — never computes gains/cost basis/tax.
// Mirrors apiGetDealsHistory's auth/query pattern.
async function apiExportTransactionsCsv(req, res) {

	const TransactionExport = require('../../app/TransactionExport.js');

	let fromDate = req.query.from;
	let toDate = req.query.to || fromDate;
	const timeZoneOffset = req.query.timeZoneOffset || 'Z';
	const botId = req.query.botId;
	const includeSandbox = String(req.query.includeSandbox) === 'true';

	let query = { 'sellData.date': { '$exists': true } };
	let queryOptions = { sort: { 'sellData.date': 1 } };

	if (fromDate) {

		const dateFrom = new Date(`${fromDate}T00:00:00${timeZoneOffset}`);
		const dateTo = new Date(new Date(`${toDate}T00:00:00${timeZoneOffset}`).getTime() + 86400000);

		query['sellData.date'] = { '$gte': dateFrom, '$lt': dateTo };
	}

	if (botId && botId !== 'Default') {

		query['botId'] = botId;
	}

	let deals = [];

	try {

		deals = await shareData.DCABot.getDeals(query, queryOptions) || [];
	}
	catch (e) {

		shareData.Common.logger('Transaction export query error: ' + JSON.stringify(e));

		res.status(500).send('Error generating transaction export');

		return;
	}

	// Deals come back as Mongoose docs — normalize to plain objects.
	const dealsPlain = JSON.parse(JSON.stringify(deals));

	// Build the rows once, then serialize (avoids transforming twice).
	const rows = TransactionExport.buildRows(dealsPlain, { includeSandbox: includeSandbox });
	const csvBody = TransactionExport.rowsToCsv(rows);

	// Diagnostic: helps explain an empty export (no matching deals vs. deals that
	// produced no rows, e.g. all sandbox or none with filled orders).
	shareData.Common.logger('Transaction export: ' + dealsPlain.length + ' deal(s) matched, ' + rows.length + ' transaction row(s) generated (includeSandbox=' + includeSandbox + ')');

	// Prefix with the instance name so multiple instances' exports are distinct.
	const rawName = (shareData.appData && shareData.appData.name) ? String(shareData.appData.name) : 'SymBot';
	const safeName = rawName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'SymBot';
	const fileName = safeName + '-transactions-' + (fromDate || 'all') + (fromDate ? '-to-' + toDate : '') + '.csv';

	// UTF-8 BOM for spreadsheet apps, then the CSV.
	const BOM = '\uFEFF';

	res.set('Content-Type', 'text/csv; charset=utf-8');
	res.set('Content-Disposition', 'attachment; filename="' + fileName + '"');
	res.set('Cache-Control', 'no-store');

	res.send(BOM + csvBody);
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

	const cbActive = shareData.appData.circuit_breaker_active || null;
	const cbClearsAt = shareData.appData.circuit_breaker_clears_at || null;

	// Portfolio summary — balance from cache (no blocking exchange call) and
	// total max funds computed across all active deals from their configs.
	let portfolioSummary = null;

	try {

		// Get account_balance_currencies from config (e.g. ['USD','USDT','USDC'])
		const exchangeConfig = shareData.appData.bots?.exchange?.default || {};
		const balanceCurrencies = Array.isArray(exchangeConfig.account_balance_currencies)
			? exchangeConfig.account_balance_currencies
			: [];

		// Detect sandbox mode from active deals.
		// Always read sandBoxWallet from the live bot config so changes in the
		// UI take effect immediately without needing to restart deals.
		// When running under Hub, prefer the per-instance sandbox_wallet_override
		// stored in shareData.appData (set from hub.json overrides) so each
		// instance maintains its own wallet value independently of the shared bot.json.
		let isSandbox     = false;
		let sandboxWallet = 0;

		if (Array.isArray(deals) && deals.length > 0) {

			const sandboxDeal = deals.find(d => d?.config?.sandBox);

			if (sandboxDeal) {

				isSandbox = true;

				// Hub per-instance override takes priority
				if (shareData.appData.sandbox_wallet_override !== undefined && shareData.appData.sandbox_wallet_override !== null) {

					sandboxWallet = parseFloat(shareData.appData.sandbox_wallet_override) || 0;
				}
				else {

					// Read from live bot config — updated immediately when user saves in UI
					const botConfigFile = shareData.appData.bot_config;
					const botConfig     = await shareData.Common.getConfig(botConfigFile);
					sandboxWallet       = parseFloat(botConfig?.data?.sandBoxWallet) || 0;
				}
			}
		}

		// Build per-exchange balances filtered to configured currencies only
		const filteredBalances = {};
		let portfolioTotal = 0;

		if (isSandbox) {

			// Sandbox mode — use configured wallet amount as portfolio total
			// Show it under the first configured currency
			const quoteCcy = balanceCurrencies[0] || 'USD';
			filteredBalances['Sandbox'] = { [quoteCcy]: { free: sandboxWallet, total: sandboxWallet } };
			portfolioTotal = sandboxWallet;
		}
		else {

			// Live mode — read from balance cache populated by background refresh in DCABot.js.
			// Fall back to getBalanceTracker() on first load before the interval has fired.
			let balanceTracker = shareData.DCABot.getBalanceCache();

			if (!balanceTracker?.updated) {

				balanceTracker = await shareData.DCABot.getBalanceTracker();
			}

			const balances = balanceTracker?.balances || {};

			for (const exchangeName in balances) {

				const exchangeData = balances[exchangeName];

				filteredBalances[exchangeName] = {};

				for (const currency of balanceCurrencies) {

					const entry = exchangeData[currency];

					if (entry != null) {

						const free  = parseFloat(entry?.free  ?? entry ?? 0) || 0;
						const total = parseFloat(entry?.total ?? entry ?? 0) || 0;

						filteredBalances[exchangeName][currency] = { free, total };
						portfolioTotal += free;
					}
				}
			}

			portfolioSummary = portfolioSummary || {};
			portfolioSummary['balance_updated'] = balanceTracker?.updated || null;
		}

		// Total max funds across all active deals
		let totalMaxFunds = 0;

		if (Array.isArray(deals)) {

			for (const deal of deals) {

				const mf = parseFloat(deal?.info?.max_funds ?? 0);

				if (!isNaN(mf)) totalMaxFunds += mf;
			}
		}

		totalMaxFunds = Math.round(totalMaxFunds * 100) / 100;

		// Risk % = total max funds / portfolio total * 100
		const riskPercent = portfolioTotal > 0
			? Math.round((totalMaxFunds / portfolioTotal) * 100)
			: null;

		// In deals = sum of filled order amounts (USD cost) across all active deals.
		// Each order.amount = price × qty = quote currency cost (e.g. USD).
		// order.sum is the cumulative cost up to that order — use the last filled
		// order's sum per deal for the total capital deployed in that deal.
		let inDeals = 0;

		if (Array.isArray(deals)) {

			for (const deal of deals) {

				const orders = deal?.orders;

				if (!Array.isArray(orders)) continue;

				const filledOrders = orders.filter(o => o.filled == 1 || o.filled === true);

				if (filledOrders.length > 0) {

					// sum on the last filled order is the cumulative USD cost
					const lastFilled = filledOrders[filledOrders.length - 1];
					const dealCost   = parseFloat(lastFilled?.sum ?? 0);

					if (!isNaN(dealCost) && dealCost > 0) {

						inDeals += dealCost;
					}
					else {

						// Fallback: sum individual order amounts
						inDeals += filledOrders.reduce((acc, o) => acc + (parseFloat(o.amount) || 0), 0);
					}
				}
			}
		}

		const availFunds = Math.round((portfolioTotal - inDeals) * 100) / 100;

		portfolioSummary = {
			'balances':           filteredBalances,
			'balance_currencies': balanceCurrencies,
			'portfolio_total':    Math.round(portfolioTotal * 100) / 100,
			'total_max_funds':    totalMaxFunds,
			'in_deals':           Math.round(inDeals * 100) / 100,
			'avail_funds':        availFunds,
			'risk_percent':       riskPercent,
			'is_sandbox':         isSandbox,
			'balance_updated':    isSandbox ? null : (portfolioSummary?.balance_updated || null),
		};
	}
	catch (e) {

		shareData.Common.logger('Portfolio summary error: ' + e.message);
	}

	const obj = {
		'date': new Date(),
		'data': deals,
		'circuit_breaker': cbActive ? {
			'active': true,
			'reason': cbActive,
			'clears_at': cbClearsAt
		} : null,
		'portfolio': portfolioSummary,
	};

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

					let orderContent = data['orders']['data']['content'];
					let ordersMetadata = data['orders']['data']['metadata'];

					// Use structured data directly — no text parsing needed
					let orderSteps = data['orders']['data']['orders']['structured'] || data['orders']['data']['orders']['steps'];

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


/**
 * Resolve the active deal id for a bot (and optionally a specific pair) so deal
 * actions can be targeted with only static identifiers (botId + pair) instead of
 * a per-deal dealId — useful for external signal sources that cannot capture the
 * dealId returned when the deal opened.
 *
 * Returns { success, dealId, error }:
 *   - success true + dealId  → exactly one active deal matched
 *   - success false + error  → bot not found, no active deal, or (for multi-deal
 *                              pairs) the match was ambiguous and needs a dealId
 *
 * Uses the same { botId, pair, status: 0 } lookup used throughout the bot engine.
 */
async function resolveActiveDealId(botId, pair) {

	if (botId == undefined || botId == null || botId == '') {

		return { 'success': false, 'error': 'Bot ID is required' };
	}

	const bots = await shareData.DCABot.getBots({ 'botId': botId });

	if (!bots || bots.length == 0) {

		return { 'success': false, 'error': 'Bot ID ' + botId + ' not found' };
	}

	const query = { 'botId': botId, 'status': 0 };

	if (pair != undefined && pair != null && pair != '') {

		// Match the bot's stored pair casing (pairs are stored upper-cased)
		query['pair'] = pair.toUpperCase();
	}

	const deals = await shareData.DCABot.getDeals(query);

	if (!deals || deals.length == 0) {

		let msg = 'No active deal found for bot ' + botId;

		if (query['pair'] != undefined) {

			msg += ' and pair ' + query['pair'];
		}

		return { 'success': false, 'error': msg };
	}

	if (deals.length > 1) {

		// More than one active deal (e.g. multi-pair bot with no pair given, or a
		// pair configured for concurrent deals) — caller must specify a dealId.
		return { 'success': false, 'error': 'Multiple active deals matched; specify a pair or use the deal id endpoint' };
	}

	return { 'success': true, 'dealId': deals[0]['dealId'] };
}


async function apiPanicSellDeal(req, res, sendResponse = true) {

	let success = true;

	let content = 'Success';

	let dealId = req.params.dealId;

	// If no dealId was given in the URL, resolve the bot's active deal from
	// botId (+ optional pair) supplied by params or body. Leaves the dealId path
	// completely unchanged when a dealId IS provided.
	if (dealId == undefined || dealId == null || dealId == '') {

		const botId = req.params.botId || req.body.botId;
		const pair = req.body.pair;

		const resolved = await resolveActiveDealId(botId, pair);

		if (!resolved['success']) {

			const resObj = { 'date': new Date(), 'success': false, 'data': resolved['error'] };
			shareData.Common.logger('API Panic Sell Deal: ' + JSON.stringify(resObj));
			if (sendResponse) { res.send(resObj); }
			return resObj;
		}

		dealId = resolved['dealId'];
	}

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
	
	let dealId = req.params.dealId;
	const volume = parseFloat(req.body.volume);

	// If no dealId was given in the URL, resolve the bot's active deal from
	// botId (+ optional pair) supplied by params or body. Leaves the dealId path
	// completely unchanged when a dealId IS provided.
	if (dealId == undefined || dealId == null || dealId == '') {

		const botId = req.params.botId || req.body.botId;
		const pair = req.body.pair;

		const resolved = await resolveActiveDealId(botId, pair);

		if (!resolved['success']) {

			const resObj = { 'date': new Date(), 'success': false, 'data': resolved['error'] };
			shareData.Common.logger('API Add Funds: ' + JSON.stringify(resObj));
			if (sendResponse) { res.send(resObj); }
			return resObj;
		}

		dealId = resolved['dealId'];
	}

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

	const balances = await shareData.DCABot.getBalanceCache();

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

		// Add currency symbol derived from quote of first selected pair
		const previewPair = Array.isArray(pairs) ? (pairs[0] || '') : (pairs || '');
		const previewQuote = previewPair.split('/')[1] || '';
		orders['data']['content']['currency_symbol'] = shareData.Common.getCurrencySymbol(previewQuote);
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

	const resObj = { 'date': new Date(), 'success': success, 'data': msg, 'botName': (bots[0] ? bots[0].botName : '') };

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

	// Default to UTC when no offset is supplied. The dashboard can be reached from
	// navigation links that don't carry the browser's timezone offset (e.g. the
	// persistent sidebar); without this guard a missing offset threw
	// "Cannot read properties of undefined (reading 'replace')".
	if (timeZoneOffset == undefined || timeZoneOffset == null || timeZoneOffset === '') {

		timeZoneOffset = '+00:00';
	}

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

        // Use the background balance cache instead of calling the exchange directly
        // Cache is refreshed every 60s by the interval in DCABot.js initApp()
        const balanceTracker = await shareData.DCABot.getBalanceCache();
        const allBalances = balanceTracker?.balances || {};

        // Merge all exchanges and filter to configured currencies
        const merged = {};
        for (const exName in allBalances) {
            for (const currency of currencies) {
                const entry = allBalances[exName]?.[currency];
                if (entry != null) {
                    const free = parseFloat(entry?.free ?? entry ?? 0) || 0;
                    merged[currency] = (merged[currency] || 0) + free;
                }
            }
        }
        return merged;
    })();

    // Bot map helpers
    const allBots = await shareData.DCABot.getBots();
    const botIdNameMap = {};
    allBots.forEach(bot => botIdNameMap[bot.botId] = bot.botName || `Bot (${bot.botId})`);

    const getBotKey = (botIdOrName) => botIdNameMap[botIdOrName] || botIdOrName;

    // Process completed deals
    // Deals grouped by bot, so per-bot win rate / duration / SO can be computed
    // via the shared Common.computeDealSetStats primitive (same definitions the
    // Trading Journal uses) instead of duplicating the formulas here.
    const deals_by_bot = {};

    complete_deals.forEach(deal => {
        const botKey = getBotKey(deal.botId || deal.bot_name);

        // Profit by bot
        if (!profit_by_bot_map[botKey]) profit_by_bot_map[botKey] = 0;
        if (typeof deal.profit === 'number') {
            profit_by_bot_map[botKey] += deal.profit;
            total_profit += deal.profit;
        }

        // Profit by day
        const localDealEnd = new Date(deal.date_end.getTime() + totalOffsetMinutes * 60000);
        const dayKey = localDealEnd.toDateString();
        profit_by_day_map[dayKey] = (profit_by_day_map[dayKey] || 0) + (deal.profit || 0);

        // Profit by pair
        const pairKey = deal.pair || 'Unknown';
        pair_profit_map[pairKey] = (pair_profit_map[pairKey] || 0) + (deal.profit || 0);

        // Collect per-bot for the shared stats pass below.
        if (!deals_by_bot[botKey]) deals_by_bot[botKey] = [];
        deals_by_bot[botKey].push(deal);
    });

    // Per-bot win rate, average duration and average SO utilisation — one shared
    // definition (Common.computeDealSetStats) rather than three hand-rolled
    // reductions. Populates the same maps the rest of the function/consumers use.
    for (const botKey in deals_by_bot) {
        const stats = shareData.Common.computeDealSetStats(deals_by_bot[botKey]);
        win_rate_map[botKey] = stats.win_rate;
        bot_deal_duration_map[botKey] = stats.avg_duration_mins;
        so_utilisation_map[botKey] = stats.avg_safety_orders;
    }

    // (Per-bot duration, SO utilisation and win rate are computed above via
    // Common.computeDealSetStats.)

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

    // Derive KPI display symbol from most common quote currency in completed deals
    const quoteCounts = {};
    complete_deals.forEach(deal => {
        const quote = deal.profit_currency === 'base'
            ? (deal.pair || '').split('/')[0]
            : (deal.pair || '').split('/')[1];
        if (quote) quoteCounts[quote] = (quoteCounts[quote] || 0) + 1;
    });
    const kpiCurrency = Object.keys(quoteCounts).sort((a, b) => quoteCounts[b] - quoteCounts[a])[0] || currencies[0] || 'USD';
    const kpiSymbol = shareData.Common.getCurrencySymbol(kpiCurrency);

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
        kpiSymbol,
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


function getBotsConfig() {

	// Returns the signal-derived start_conditions data from this instance's
	// shareData — used by the Hub Worker to send to the Hub UI.
	const bots = shareData?.appData?.bots || {};

	return {
		'start_conditions':          bots['start_conditions']          || {},
		'start_conditions_sub':      bots['start_conditions_sub']      || {},
		'start_conditions_metadata': bots['start_conditions_metadata'] || {},
		'pair_buttons':              bots['pair_buttons']              || []
	};
}


async function getDefaultBotConfig() {

	// Returns bot.json defaults — used by Hub create bot page.
	// Accesses shareData via DCABotManager's own module-level reference
	// since SymBot.shareData is not exported from symbot.js.
	const botConfigFile = shareData?.appData?.bot_config;

	if (!botConfigFile) return {};

	const botConfig = await shareData.Common.getConfig(botConfigFile);

	return botConfig?.data || {};
}


async function getSymbolList() {

	const maxMins = 60;

	const botConfigFile = shareData.appData.bot_config;
	const botConfig     = await shareData.Common.getConfig(botConfigFile);
	const botConfigData = botConfig?.data;
	const exchangeName  = botConfigData?.exchange;

	if (!exchangeName) return [];

	if (symbolList[exchangeName] == undefined || symbolList[exchangeName] == null) {

		symbolList[exchangeName] = {};
		symbolList[exchangeName]['symbols'] = [];
		symbolList[exchangeName]['updated'] = 0;
	}

	const diffSec = (new Date().getTime() - new Date(symbolList[exchangeName]['updated']).getTime()) / 1000;

	if (diffSec > (60 * maxMins)) {

		const exchange = await shareData.DCABot.connectExchange(botConfigData);

		if (exchange) {

			const symbolData = await shareData.DCABot.getSymbolsAll(exchange);

			if (symbolData.success) {

				symbolList[exchangeName]['updated'] = new Date();
				symbolList[exchangeName]['symbols'] = symbolData.symbols;
			}
		}
	}

	return symbolList[exchangeName]['symbols'] || [];
}


function buildStartConditionStrings(bots, botData) {

	const conds = (bots && bots['start_conditions'])          || {};
	const subs  = (bots && bots['start_conditions_sub'])      || {};
	const ops   = [
		{ operator: '==', display: '=' },
		{ operator: '!=', display: '!=' },
		{ operator: '>=', display: '>=' },
		{ operator: '<=', display: '<=' }
	];

	// Parse existing bot start conditions for pre-selection
	const scSubObj = {};

	if (botData && botData.startConditions && botData.startConditions.length > 1) {

		for (let i = 1; i < botData.startConditions.length; i++) {

			const parts = botData.startConditions[i].split('|');
			const key   = parts[1]; const id = parts[2]; const op = parts[3]; const ct = parts[4];

			if (!scSubObj[key]) scSubObj[key] = {};

			scSubObj[key][id] = { operator: op, content: ct };
		}
	}

	// Build main select options string
	let startConditionString = '<option value="">';

	for (const key in conds) {

		const desc = conds[key]['description'] || key;
		const sel  = (botData && botData.startConditions && botData.startConditions[0] === key) ? ' selected' : '';

		startConditionString += '<option value="' + key + '"' + sel + '>' + desc;
	}

	// Build sub-condition rows string
	let startConditionSubString = '';
	let countSub = 1;

	for (const keySub in subs) {

		const parts = keySub.split('|');
		const key   = parts[1]; const id = parts[2];
		const desc  = subs[keySub]['description'] || id;

		let content = ''; let operator = '';

		if (scSubObj[key] && scSubObj[key][id]) {

			content  = scSubObj[key][id]['content']  || '';
			operator = scSubObj[key][id]['operator'] || '';
		}

		let str = '<tr id="startConditionSub-' + key + '-' + countSub + '" data-id="' + id + '" style="display: none;"><td style="padding-left: 15px;">' + desc + ':</td><td>';

		str += '<select id="startConditionOp-' + key + '-' + countSub + '" name="startConditionOp" class="form-field"><option value="">';

		for (const o of ops) {

			str += '<option value="' + o.operator + '"' + (operator === o.operator ? ' selected' : '') + '>' + o.display;
		}

		str += '</select>';
		str += ' <input id="startConditionVal-' + key + '-' + countSub + '" name="startCondition' + countSub + '" class="form-field" style="cursor: auto;" value="' + content + '">';
		str += '</td></tr>';

		startConditionSubString += str;
		countSub++;
	}

	return { startConditionString, startConditionSubString };
}


function buildSymbolString(symbols, botData) {

	const botPairs = Array.isArray(botData.pair)
		? botData.pair.map(p => p.toUpperCase())
		: (botData.pair ? [botData.pair.toUpperCase()] : []);

	let symbolString = '';

	for (const sym of (symbols || [])) {

		const upper    = sym.toUpperCase();
		const selected = botPairs.includes(upper) ? 'selected' : '';

		symbolString += '<option value="' + upper + '" ' + selected + '>' + upper;
	}

	return symbolString;
}


function buildActiveChecked(botData) {

	return botData && botData.active ? 'checked' : '';
}


// ─── Trading Journal ────────────────────────────────────────────────────────
// Entries auto-generate from closed deals (no blank-notebook to fill). Each
// closed deal is already an entry with its facts (pair, dates, profit, safety
// orders); the user optionally adds a note, and — if AI is enabled — can
// generate a narrative. Only the note + narrative are persisted (onto the deal
// as a `journal` field); everything else is derived live from deal data.

function isAiEnabled() {

	const ai = shareData?.appData?.ai;

	if (ai == undefined || ai == null) { return false; }

	// Enabled if a provider is configured on (openai or ollama).
	return !!(ai.openai?.enabled || ai.ollama?.enabled || (ai.provider && ai.provider !== 'none'));
}

// Builds the Mongo query for journal/stats from the shared filter params
// (bot + date range). Used by both the paginated list and the stats summary so
// the two always describe the same set of deals.
function buildJournalQuery(reqQuery) {

	const fromDate = reqQuery.from;
	const toDate = reqQuery.to || fromDate;
	const timeZoneOffset = reqQuery.timeZoneOffset || 'Z';
	const botId = reqQuery.botId;

	let query = { 'sellData.date': { '$exists': true } };

	if (fromDate) {

		const dateFrom = new Date(`${fromDate}T00:00:00${timeZoneOffset}`);
		const dateTo = new Date(new Date(`${toDate}T00:00:00${timeZoneOffset}`).getTime() + 86400000);

		query['sellData.date'] = { '$gte': dateFrom, '$lt': dateTo };
	}

	if (botId && botId !== 'Default' && botId !== 'all') {

		query['botId'] = botId;
	}

	return query;
}


// Builds journal entries: processed closed deals + any saved note/narrative.
async function apiGetJournal(req, res, sendResponse = true) {

	// Pagination: newest first, a page at a time, so production histories with
	// thousands of closed deals don't all load at once.
	let limit = parseInt(req.query.limit, 10);
	if (!(limit > 0) || limit > 100) { limit = 25; }

	let skip = parseInt(req.query.skip, 10);
	if (!(skip >= 0)) { skip = 0; }

	const query = buildJournalQuery(req.query);
	// Fetch one extra to know whether another page exists.
	const queryOptions = { sort: { 'sellData.date': -1 }, skip: skip, limit: limit + 1 };

	let dealsRaw = await shareData.DCABot.getDeals(query, queryOptions) || [];

	// Did we get the extra row? Then there's another page.
	const hasMore = dealsRaw.length > limit;

	if (hasMore) { dealsRaw = dealsRaw.slice(0, limit); }

	// Map dealId -> saved journal (note/narrative) from the raw deal docs.
	const savedByDeal = {};

	for (const d of dealsRaw) {

		if (d.journal != undefined && d.journal != null) {

			savedByDeal[d.dealId] = d.journal;
		}
	}

	const processed = await getProcessedDeals(dealsRaw);

	const entries = processed.map(d => {

		const saved = savedByDeal[d.deal_id] || {};

		return {
			...d,
			note: typeof saved.note === 'string' ? saved.note : '',
			narrative: typeof saved.narrative === 'string' ? saved.narrative : '',
			narrative_at: saved.narrative_at || null,
			mood: typeof saved.mood === 'string' ? saved.mood : ''
		};
	});

	const obj = {
		'date': new Date(),
		'ai_enabled': isAiEnabled(),
		'skip': skip,
		'limit': limit,
		'has_more': hasMore,
		'data': entries
	};

	if (sendResponse) { res.send(obj); }
	else { return obj; }
}

// Saves (or clears) the user's note on a deal's journal entry.
async function apiSaveJournalNote(req, res) {

	const body = req.body || {};
	const dealId = body.dealId;
	const note = typeof body.note === 'string' ? body.note : '';

	let success = false;
	let message = '';

	if (dealId == undefined || dealId === '') {

		res.send({ 'date': new Date(), 'success': false, 'data': 'Missing dealId' });
		return;
	}

	const deals = await shareData.DCABot.getDeals({ 'dealId': dealId });

	if (deals && deals.length > 0) {

		const deal = deals[0];
		const journal = (deal.journal && typeof deal.journal === 'object') ? deal.journal : {};

		journal.note = note;
		journal.note_at = new Date();

		const upd = await shareData.DCABot.updateDeal(deal.botId, dealId, { 'journal': journal });

		success = upd?.success !== false;
	}
	else {

		message = 'Deal ID ' + dealId + ' not found';
	}

	res.send({ 'date': new Date(), 'success': success, 'data': success ? 'Saved' : message });
}


// The fixed mood vocabulary. Keeping it a small closed set (rather than free
// text) is what makes the mood→outcome correlation meaningful — every deal maps
// to one of these buckets. Order here is the order shown in the UI.
const JOURNAL_MOODS = [
	{ id: 'planned',     label: 'Planned',     emoji: '\uD83C\uDFAF' },
	{ id: 'confident',   label: 'Confident',   emoji: '\uD83D\uDE0C' },
	{ id: 'neutral',     label: 'Neutral',     emoji: '\uD83D\uDE10' },
	{ id: 'anxious',     label: 'Anxious',     emoji: '\uD83D\uDE30' },
	{ id: 'gambled',     label: 'Gambled',     emoji: '\uD83C\uDFB2' }
];

function isValidMood(m) {

	return m === '' || JOURNAL_MOODS.some(x => x.id === m);
}

// Saves (or clears, with '') the mood tag on a deal's journal entry.
async function apiSaveJournalMood(req, res) {

	const body = req.body || {};
	const dealId = body.dealId;
	const mood = typeof body.mood === 'string' ? body.mood : '';

	if (dealId == undefined || dealId === '') {

		res.send({ 'date': new Date(), 'success': false, 'data': 'Missing dealId' });
		return;
	}

	if (!isValidMood(mood)) {

		res.send({ 'date': new Date(), 'success': false, 'data': 'Invalid mood' });
		return;
	}

	const deals = await shareData.DCABot.getDeals({ 'dealId': dealId });

	if (!deals || deals.length === 0) {

		res.send({ 'date': new Date(), 'success': false, 'data': 'Deal ID ' + dealId + ' not found' });
		return;
	}

	const deal = deals[0];
	const journal = (deal.journal && typeof deal.journal === 'object') ? deal.journal : {};

	if (mood === '') { delete journal.mood; }
	else { journal.mood = mood; }

	const upd = await shareData.DCABot.updateDeal(deal.botId, dealId, { 'journal': journal });
	const success = upd?.success !== false;

	// Mood tags feed the mood→outcome correlation, so a change invalidates the
	// cached stats across all filters (a mood change can affect any bucket).
	if (success) { journalStatsCacheClear(); }

	res.send({ 'date': new Date(), 'success': success, 'data': success ? 'Saved' : 'Failed to save mood' });
}


// Summary stats + mood→outcome correlation over ALL deals matching the current
// filter (not just the visible page). Reuses the app's own definitions: a "win"
// is profit > 0 (same as getDashboardData), duration via dealDurationMinutes.
// Deliberately observational — it reports what happened, draws no conclusions.
async function apiGetJournalStats(req, res) {

	// Cache key from the same dimensions buildJournalQuery uses. A cache hit skips
	// the full closed-deal fetch + getProcessedDeals aggregation.
	const cacheKey = [
		(req.query.botId || 'all'),
		(req.query.from || ''),
		(req.query.to || ''),
		(req.query.timeZoneOffset || 'Z')
	].join('|');

	const cached = journalStatsCacheGet(cacheKey);

	if (cached) {

		res.send(cached);
		return;
	}

	const query = buildJournalQuery(req.query);

	// No projection: getProcessedDeals needs the full deal shape (orders, config,
	// sellData, etc.). This mirrors how the dashboard loads deals for its stats.
	const dealsRaw = await shareData.DCABot.getDeals(query, { sort: { 'sellData.date': -1 } }) || [];
	const deals = await getProcessedDeals(dealsRaw);

	// Map saved mood back onto each processed deal.
	const moodByDeal = {};
	for (const d of dealsRaw) { if (d.journal && typeof d.journal.mood === 'string') { moodByDeal[d.dealId] = d.journal.mood; } }

	// Base aggregates (win rate, total profit, avg duration) come from the shared
	// primitive so the journal and dashboard can't drift on these definitions.
	const base = shareData.Common.computeDealSetStats(deals);

	let best = null;
	let worst = null;

	// Streaks are computed over deals in chronological order (oldest first).
	const chrono = deals.slice().sort((a, b) => new Date(a.date_end) - new Date(b.date_end));
	let curStreak = 0;
	let curStreakType = null;   // 'win' | 'loss'

	// Mood buckets: id -> { count, wins, profit }.
	const moodStats = {};
	for (const m of JOURNAL_MOODS) { moodStats[m.id] = { count: 0, wins: 0, profit: 0 }; }
	let taggedCount = 0;

	// Journal-only pass: best/worst by percent and mood bucketing. (The base
	// win/profit/duration totals are already done by computeDealSetStats above.)
	deals.forEach(d => {

		const isWin = (typeof d.profit === 'number' ? d.profit : 0) > 0;

		if (best === null || d.profit_percent > best.profit_percent) { best = d; }
		if (worst === null || d.profit_percent < worst.profit_percent) { worst = d; }

		const mood = moodByDeal[d.deal_id];
		if (mood && moodStats[mood]) {

			taggedCount++;
			moodStats[mood].count++;
			if (isWin) { moodStats[mood].wins++; }
			moodStats[mood].profit += (typeof d.profit === 'number' ? d.profit : 0);
		}
	});

	// Current streak from the most recent backwards.
	for (let i = chrono.length - 1; i >= 0; i--) {

		const isWin = (typeof chrono[i].profit === 'number' ? chrono[i].profit : 0) > 0;
		const type = isWin ? 'win' : 'loss';

		if (curStreakType === null) { curStreakType = type; curStreak = 1; }
		else if (type === curStreakType) { curStreak++; }
		else { break; }
	}

	// Shape the mood correlation for the client (only buckets that have deals).
	const moodCorrelation = JOURNAL_MOODS
		.filter(m => moodStats[m.id].count > 0)
		.map(m => {

			const s = moodStats[m.id];

			return {
				id: m.id,
				label: m.label,
				emoji: m.emoji,
				count: s.count,
				win_rate: s.count > 0 ? Math.round((s.wins / s.count) * 100) : 0,
				avg_profit: s.count > 0 ? s.profit / s.count : 0
			};
		});

	const summary = {
		total_deals: base.total,
		win_rate: base.win_rate,
		wins: base.wins,
		losses: base.losses,
		total_profit: base.total_profit,
		avg_duration_mins: base.avg_duration_mins,
		current_streak: curStreak,
		current_streak_type: curStreakType,
		best: best ? { pair: best.pair, profit_percent: best.profit_percent } : null,
		worst: worst ? { pair: worst.pair, profit_percent: worst.profit_percent } : null,
		tagged_count: taggedCount,
		untagged_count: base.total - taggedCount
	};

	const payload = { 'date': new Date(), 'moods': JOURNAL_MOODS, 'summary': summary, 'mood_correlation': moodCorrelation };

	journalStatsCacheSet(cacheKey, payload);

	res.send(payload);
}


// Generates an AI narrative for a closed deal and persists it. Gated on AI.
async function apiGenerateJournalNarrative(req, res) {

	const body = req.body || {};
	const dealId = body.dealId;

	if (!isAiEnabled()) {

		res.send({ 'date': new Date(), 'success': false, 'data': 'AI is not enabled' });
		return;
	}

	if (dealId == undefined || dealId === '') {

		res.send({ 'date': new Date(), 'success': false, 'data': 'Missing dealId' });
		return;
	}

	const deals = await shareData.DCABot.getDeals({ 'dealId': dealId });

	if (!deals || deals.length === 0) {

		res.send({ 'date': new Date(), 'success': false, 'data': 'Deal ID ' + dealId + ' not found' });
		return;
	}

	const deal = deals[0];
	const processed = await getProcessedDeals([deal]);

	if (processed.length === 0) {

		res.send({ 'date': new Date(), 'success': false, 'data': 'Deal is not closed or has no fills' });
		return;
	}

	const p = processed[0];

	// A compact, factual prompt built from the deal's own data. Kept concise so
	// the narrative is a short reflective summary, not an essay.
	const durationMs = new Date(p.date_end).getTime() - new Date(p.date_start).getTime();
	const durationMins = Math.max(0, Math.round(durationMs / 60000));

	let durationStr;
	if (durationMins < 60) { durationStr = durationMins + ' minute(s)'; }
	else if (durationMins < 1440) { durationStr = (Math.round(durationMins / 6) / 10) + ' hour(s)'; }
	else { durationStr = (Math.round(durationMins / 144) / 10) + ' day(s)'; }

	const prompt = 'Write a brief (2 sentence) factual trading-journal note for this completed DCA deal, '
		+ 'using ONLY the numbers given. State what happened. Do NOT give advice, do NOT generalize '
		+ 'about trading or markets, do NOT make claims about what is "possible" or about risk management, '
		+ 'and do NOT predict the future. No disclaimers. '
		+ 'Deal: pair ' + p.pair + ', result ' + (p.profit_percent >= 0 ? '+' : '') + p.profit_percent + '%, '
		+ p.safety_orders + ' safety order(s) used, duration about ' + durationStr + '. '
		+ 'First sentence: state the outcome (pair, profit/loss %, safety orders, duration). '
		+ 'Second sentence: one neutral factual observation drawn only from those numbers.';

	const aiBody = {
		'message': {
			'content': prompt,
			'room': 'journal' + Math.floor(1000 + Math.random() * 90000),
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

	if (!aiOut || !aiOut.success) {

		res.send({ 'date': new Date(), 'success': false, 'data': (aiOut && aiOut.data) || 'AI request failed' });
		return;
	}

	const narrative = String(aiOut.data || '').trim();

	// Persist the narrative onto the deal's journal.
	const journal = (deal.journal && typeof deal.journal === 'object') ? deal.journal : {};
	journal.narrative = narrative;
	journal.narrative_at = new Date();

	await shareData.DCABot.updateDeal(deal.botId, dealId, { 'journal': journal });

	res.send({ 'date': new Date(), 'success': true, 'data': narrative });
}

// Clears the user's journal annotations for a deal. `part` selects what to
// remove: 'note', 'narrative', or 'all' (default). Removes annotations only —
// the underlying closed deal is untouched, so the auto-generated entry still
// appears (just without the removed piece).
async function apiDeleteJournalEntry(req, res) {

	const body = req.body || {};
	const dealId = body.dealId;
	const part = (body.part === 'note' || body.part === 'narrative') ? body.part : 'all';

	if (dealId == undefined || dealId === '') {

		res.send({ 'date': new Date(), 'success': false, 'data': 'Missing dealId' });
		return;
	}

	const deals = await shareData.DCABot.getDeals({ 'dealId': dealId });

	if (!deals || deals.length === 0) {

		res.send({ 'date': new Date(), 'success': false, 'data': 'Deal ID ' + dealId + ' not found' });
		return;
	}

	const deal = deals[0];
	const journal = (deal.journal && typeof deal.journal === 'object') ? { ...deal.journal } : {};

	if (part === 'note') {

		delete journal.note;
		delete journal.note_at;
	}
	else if (part === 'narrative') {

		delete journal.narrative;
		delete journal.narrative_at;
	}
	else {

		// 'all' — clear everything.
		for (const k in journal) { delete journal[k]; }
	}

	const upd = await shareData.DCABot.updateDeal(deal.botId, dealId, { 'journal': journal });

	const success = upd?.success !== false;

	res.send({ 'date': new Date(), 'success': success, 'data': success ? 'Deleted' : 'Failed to delete' });
}


function viewJournal(req, res) {

	res.render('strategies/DCABot/DCABotJournalView', {
		'appData': shareData.appData,
		'getCurrencySymbol': shareData.Common.getCurrencySymbol.toString(),
		'aiEnabled': isAiEnabled(),
		'moods': JSON.stringify(JOURNAL_MOODS)
	});
}


module.exports = {

	apiStartDeal,
	apiUpdateBotsExchange,
	apiGetMarkets,
	apiGetBots,
	apiGetActiveDeals,
	apiGetDealsHistory,
	apiExportTransactionsCsv,
	viewTransactionExport,
	apiGetJournal,
	apiSaveJournalNote,
	apiSaveJournalMood,
	apiGetJournalStats,
	apiGenerateJournalNarrative,
	apiDeleteJournalEntry,
	viewJournal,
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
	getProcessedDeals,
	viewBots,
	viewCreateUpdateBot,
	viewActiveDeals,
	viewHistoryDeals,
	getDashboardData,
	getSymbolList,
	getBotsConfig,
	getDefaultBotConfig,
	buildStartConditionStrings,
	buildSymbolString,
	buildActiveChecked,

	init: function(obj) {

		shareData = obj;

		initApp();
    }
}
