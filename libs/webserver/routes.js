'use strict';


let shareData;


function initRoutes(router) {

	router.post([ '/webhook/api/*' ], (req, res, next) => {

		processWebHook(req, res, next);
	});


	router.get('/', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.Common.goHome(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.get('/config', (req, res) => {

		res.set('Cache-Control', 'no-store');

		processConfig(req, res);
	});


	router.post('/config', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.Common.updateConfig(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.get('/login', (req, res) => {

		res.set('Cache-Control', 'no-store');

		res.render( 'loginView', { 'appData': shareData.appData } );
	});

	router.get('/dashboard', async (req, res) => {
		if (!isLoggedIn(req, res)) return;

		const { duration } = req.query;

		const { kpi, charts, currencies, isLoading, period } = await shareData.DCABotManager.getDashboardData({ duration: Number(duration ?? '7')});

		res.set('Cache-Control', 'no-store');
		res.render( 'dashboardView', { 'appData': shareData.appData, kpi, charts, currencies, isLoading, period });
	})

	router.get('/logs', (req, res) => {

		if (req.session.loggedIn) {

			shareData.Common.showLogs(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.get('/logs/live', (req, res) => {
		res.set('Cache-Control', 'no-store');
		const isLiteLog = process.argv[2] ? process.argv[2].toLowerCase() === 'clglite' : false;

		res.render( 'logsLiveView', { 'appData': shareData.appData, isLiteLog } );
	});


	router.get('/logs/download/:file', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			let fileName = req.params.file;

			shareData.Common.downloadLog(fileName, req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.post('/login', (req, res) => {

		res.set('Cache-Control', 'no-store');

		shareData.Common.verifyLogin(req, res);
	});


	router.get('/logout', (req, res) => {

		res.set('Cache-Control', 'no-store');

		req.session.destroy((err) => {});

		res.redirect('/login');
	});


	router.get('/bots/create', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.DCABotManager.viewCreateUpdateBot(req, res);
		}
		else {

			res.redirect('/login');
		}
	});
	

	router.get([ '/bots', '/bots/:botId' ], (req, res) => {

		res.set('Cache-Control', 'no-store');

		const botId = req.params.botId;

		if (req.session.loggedIn) {

			if (botId == undefined || botId == null || botId == '') {

				shareData.DCABotManager.viewBots(req, res);
			}
			else {

				shareData.DCABotManager.viewCreateUpdateBot(req, res, botId);
			}
		}
		else {

			res.redirect('/login');
		}
	});


	router.get('/deals/active', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.DCABotManager.viewActiveDeals(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.get('/deals/history', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.DCABotManager.viewHistoryDeals(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.get('/api/markets', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn || validApiKey(req)) {

			shareData.DCABotManager.apiGetMarkets(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.get('/api/tradingview', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn || validApiKey(req)) {

			shareData.Common.showTradingView(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.get('/api/bots', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn || validApiKey(req)) {

			shareData.DCABotManager.apiGetBots(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.get([ '/api/deals', '/api/deals/completed', '/api/deals/:dealId/show' ], (req, res) => {

		res.set('Cache-Control', 'no-store');

		const reqPath = req.path;
		const dealId = req.params.dealId;

		if (req.session.loggedIn || validApiKey(req)) {

			if (reqPath.indexOf('completed') > -1) {

				shareData.DCABotManager.apiGetDealsHistory(req, res, true);
			}
			else if (reqPath.indexOf('show') > -1 && dealId) {

				shareData.DCABotManager.apiShowDeal(req, res, dealId);
			}
			else if (dealId == undefined || dealId == null || dealId == '' || dealId == 'active') {

				shareData.DCABotManager.apiGetActiveDeals(req, res);
			}
			else {

				redirectNotFound(res);
			}
		}
		else {

			res.redirect('/login');
		}
	});

	router.get('/app-version', async (req, res) => {
		res.set('Cache-Control', 'no-store');
		const { update_available } = await shareData.Common.validateAppVersion();
		
		if(update_available && !shareData.appData.update_available) {
			shareData.appData.update_available = true;
		}

		res.json({
			update_available
		})
	});

	router.post([ '/api/deals/:dealId/update_deal' ], (req, res) => {

		if (req.session.loggedIn || validApiKey(req)) {

			shareData.DCABotManager.apiUpdateDeal(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.post([ '/api/deals/:dealId/add_funds' ], (req, res) => {

		if (req.session.loggedIn || validApiKey(req)) {

			shareData.DCABotManager.apiAddFundsDeal(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.post([ '/api/deals/:dealId/cancel' ], (req, res) => {

		if (req.session.loggedIn || validApiKey(req)) {

			shareData.DCABotManager.apiCancelDeal(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.post([ '/api/deals/:dealId/panic_sell' ], (req, res) => {

		if (req.session.loggedIn || validApiKey(req)) {

			shareData.DCABotManager.apiPanicSellDeal(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.post([ '/api/bots/create', '/api/bots/update' ], (req, res) => {

		if (req.session.loggedIn || validApiKey(req)) {

			shareData.DCABotManager.apiCreateUpdateBot(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.post([ '/api/bots/:botId/enable', '/api/bots/:botId/disable' ], (req, res) => {

		if (req.session.loggedIn || validApiKey(req)) {

			shareData.DCABotManager.apiEnableDisableBot(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.post([ '/api/bots/:botId/start_deal' ], (req, res) => {

		if (req.session.loggedIn || validApiKey(req)) {

			shareData.DCABotManager.apiStartDeal(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.all('*', (req, res) => {

		redirectNotFound(res);
	});
}


async function processConfig(req, res) {

	let tokenBase64;

	if (req.session.loggedIn) {

		const token = shareData.appData.api_token;

		if (token != undefined && token != null && token != '') {

			tokenBase64 = Buffer.from(token, 'utf8').toString('base64');
		}

		res.render( 'configView', { 'appData': shareData.appData, 'token': tokenBase64 } );
	}
	else {

		res.redirect('/login');
	}
}


async function processWebHook(req, res, next) {

	let reqPath = req.path;

	let errorObj = {};

	reqPath = reqPath.replace(/\/webhook/g, '');

	if (!shareData.appData.webhook_enabled) {

		errorObj['error'] = 'Webhooks are disabled';

		res.status(403).send(errorObj);

		return;
	}

	try {

		const tokenKey = 'apiToken';

		const apiToken = req.body[tokenKey];

		if (apiToken === shareData.appData.api_token) {

			req.headers['api-token'] = apiToken;
		}

		delete req.body[tokenKey];
	}
	catch(e) {}

	if (req.session.loggedIn || validApiKey(req)) {

		req.url = reqPath;
		next();
	}
	else {

		errorObj['error'] = 'Invalid Token';

		res.status(401).send(errorObj);
	}
}

function isLoggedIn(req, res) {
	if (!req.session.loggedIn) {
		res.redirect('/login');
		return false;
	}
	return true;
}


function redirectNotFound(res) {

	let obj = {

		'error': 'Not Found'
	};

	res.status(404).send(obj);
}


function validApiKey(req) {

	let success = false;

	const headers = req.headers;

	const apiKey = headers['api-key'];
	const apiToken = headers['api-token'];

	if (apiKey != undefined && apiKey != null && apiKey != '') {

		if (shareData.appData.api_enabled) {

			const isValid = shareData.Common.validateApiKey(apiKey);

			if (isValid) {
	
				success = true;
			}
		}
	}
	else if (apiToken != undefined && apiToken != null && apiToken != '') {

		if (shareData.appData.webhook_enabled) {

			if (apiToken === shareData.appData.api_token) {

				success = true;
			}
		}
	}

	return success;
}


function start(router) {

	initRoutes(router);
}


module.exports = {

	start,

	init: function(obj) {

		shareData = obj;
    }
}

