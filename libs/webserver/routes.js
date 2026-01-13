'use strict';

const routesWebSocket = require(__dirname + '/routesWebSocket.js');

let shareData;



function initRoutes(router, upload) {

	routesWebSocket.init(shareData);

	router.post([ '/webhook/api/*wildcard' ], (req, res, next) => {

		processWebHook(req, res, next);
	});


	router.get('/', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.Common.renderView('homeView', req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.get('/system', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.Common.renderView('systemView', req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.post(['/system/backup', '/api/system/backup'], (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.path.startsWith('/api') ? validApiKey(req) : req.session.loggedIn) {

			shareData.System.routeBackupDb(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.post('/system/restore', upload.single('backupFile'), (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.System.routeRestoreDb(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.post('/system/update', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.System.routeUpdateSystem(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.post('/system/shutdown', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.Common.logger('System shutdown requested.');

			shareData.System.shutDown();

			res.redirect('/logout');
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

		const { duration, timeZoneOffset } = req.query;

		const { kpi, charts, botIdNameMap, currencies, isLoading, period } = await shareData.DCABotManager.getDashboardData({ duration: Number(duration ?? '7'), timeZoneOffset });

		res.set('Cache-Control', 'no-store');

		res.render( 'dashboardView', { 'appData': shareData.appData, kpi, charts, botIdNameMap, currencies, isLoading, period });
	})


	router.get([ '/logs', '/backups' ], (req, res) => {

		res.set('Cache-Control', 'no-store');
	
		const type = req.path.replace('/', '');
	
		if (req.session.loggedIn) {

			shareData.Common.showFiles(type, req, res);
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


	router.get([ '/logs/download/:file', '/backups/download/:file' ], (req, res) => {

		res.set('Cache-Control', 'no-store');
	
		if (req.session.loggedIn) {

			const fileName = req.params.file;
			const type = req.path.includes('/logs/') ? 'logs' : 'backups';

			shareData.Common.downloadFile(fileName, type, req, res);
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


	router.get([ '/api/markets', '/api/markets/:path' ], (req, res) => {

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


	router.post([ '/api/ai/analyze_deal' ], (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn || validApiKey(req)) {

			shareData.DCABotManager.apiAiAnalyzeDeal(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.get([ '/api/ai/analyze_deal_prompt' ], (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn || validApiKey(req)) {

			shareData.DCABotManager.apiAiAnalyzeDealPrompt(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.post('/api/ai/chat/view', (req, res) => {

		res.set('Cache-Control', 'no-store');

		const body = req.body;

		if (req.session.loggedIn || validApiKey(req)) {

			res.render( 'aiChatView', { 'appData': shareData.appData, 'bodyData': body } );
		}
		else {

			res.redirect('/login');
		}
	});


	router.post('/api/ai/chat/prompt', (req, res) => {

		res.set('Cache-Control', 'no-store');

		const body = req.body;

		if (req.session.loggedIn || validApiKey(req)) {

			shareData.Ollama.streamChat(JSON.stringify(body));

			let obj = { 'success': true };

			res.status(200).send(obj);
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


	router.post([ '/api/deals/:dealId/pause' ], (req, res) => {

		if (req.session.loggedIn || validApiKey(req)) {

			shareData.DCABotManager.apiPauseDeal(req, res);
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


	router.post([ '/api/accounts/:exchangeId/balances', '/api/accounts/balances' ], (req, res) => {

		if (req.session.loggedIn || validApiKey(req)) {

			shareData.DCABotManager.apiGetBalances(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.all('*wildcard', (req, res) => {

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

		const appConfigFile = shareData.appData.app_config;

		const appConfig = await shareData.Common.getConfig(appConfigFile);

		let services = Object.assign({

			'ai': JSON.parse(JSON.stringify(appConfig.data.ai)),
			'cron_backup': JSON.parse(JSON.stringify(appConfig.data.cron_backup)),
			'telegram': JSON.parse(JSON.stringify(appConfig.data.telegram)),
			'signals': JSON.parse(JSON.stringify(appConfig.data.signals))
		});

		const cronBackupPasswordEnc = services['cron_backup']['password'];
		services['cron_backup']['password'] = '';

		const sftpPasswordEnc = services['cron_backup']['sftp']['password'];
		services['cron_backup']['sftp']['password'] = '';

		const sftpPassphraseEnc = services['cron_backup']['sftp']['passphrase'];
		services['cron_backup']['sftp']['passphrase'] = '';

		if (cronBackupPasswordEnc) {

			const cronBackupPasswordDecObj = await shareData.System.decrypt(cronBackupPasswordEnc, shareData.appData.password);

			if (cronBackupPasswordDecObj.success) {

				services['cron_backup']['password'] = Buffer.from(cronBackupPasswordDecObj.data, 'utf8').toString('base64');
			}
		}

		if (sftpPasswordEnc) {

			const sftpPasswordDecObj = await shareData.System.decrypt(sftpPasswordEnc, shareData.appData.password);

			if (sftpPasswordDecObj.success) {

				services['cron_backup']['sftp']['password'] = Buffer.from(sftpPasswordDecObj.data, 'utf8').toString('base64');
			}
		}

		if (sftpPassphraseEnc) {

			const sftpPassphraseDecObj = await shareData.System.decrypt(sftpPassphraseEnc, shareData.appData.password);

			if (sftpPassphraseDecObj.success) {

				services['cron_backup']['sftp']['passphrase'] = Buffer.from(sftpPassphraseDecObj.data, 'utf8').toString('base64');
			}
		}

		res.render( 'configView', { 'appData': shareData.appData, 'token': tokenBase64, 'services': services } );
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


async function processWebSocketApi(client, data) {

	routesWebSocket.api(client, data);
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
	let apiKeyInvalid = false;
	let apiTokenInvalid = false;

	const headers = req.headers;

	const apiKey = headers['api-key'];
	const apiToken = headers['api-token'];

	if (apiKey != undefined && apiKey != null && apiKey != '') {

		if (shareData.appData.api_enabled) {

			const isValid = shareData.Common.validateApiKey(apiKey);

			if (isValid) {
	
				success = true;
			}
			else {

				apiKeyInvalid = true;
			}
		}
	}
	else if (apiToken != undefined && apiToken != null && apiToken != '') {

		if (shareData.appData.webhook_enabled) {

			if (apiToken === shareData.appData.api_token) {

				success = true;
			}
			else {

				apiTokenInvalid = true;
			}
		}
	}

	if (apiKeyInvalid || apiTokenInvalid) {

		const ip = shareData.Common.getClientIp(req);

		const authType = apiKeyInvalid ? 'API KEY' : 'API TOKEN';

		const msg = `Invalid ${authType} used by ${ip}`;

		shareData.Common.sendNotification({ 'message': msg, 'type': 'info', 'telegram_id': shareData.appData.telegram_id });
	}

	return success;
}


function start(router, upload) {

	initRoutes(router, upload);
}


module.exports = {

	start,
	processWebSocketApi,

	init: function(obj) {

		shareData = obj;
    }
}

