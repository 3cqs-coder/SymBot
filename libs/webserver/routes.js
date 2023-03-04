'use strict';


let shareData;


function initRoutes(router) {

	router.get('/', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			res.render( 'homeView', { 'appData': shareData.appData } );
		}
		else {

			res.redirect('/login');
		}
	});


	router.get('/login', (req, res) => {

		res.set('Cache-Control', 'no-store');

		res.render( 'loginView', { 'appData': shareData.appData } );
	});


	router.post('/login', (req, res) => {

		res.set('Cache-Control', 'no-store');

		const body = req.body;
		const password = body.password;

		if (password == shareData.appData.password) {

			req.session.loggedIn = true;
			
			res.redirect('/');
		}
		else {

			res.redirect('/login');
		}
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


	router.get('/api/bots', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn || validApiKey(req)) {

			shareData.DCABotManager.apiGetBots(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.get([ '/api/deals', '/api/deals/completed', '/api/deals/:dealId' ], (req, res) => {

		res.set('Cache-Control', 'no-store');

		const reqPath = req.path;
		const dealId = req.params.dealId;

		if (req.session.loggedIn || validApiKey(req)) {

			if (reqPath.indexOf('completed') > -1) {

				shareData.DCABotManager.apiGetDealsHistory(req, res, true);
			}
			else if (dealId == undefined || dealId == null || dealId == '' || dealId == 'active') {

				shareData.DCABotManager.apiGetActiveDeals(req, res);
			}
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

		let obj = {

			'error': 'Not Found'
		};

		res.status(404).send(obj);
	});
}


function validApiKey(req) {

	let success = false;

	const headers = req.headers;

	const apiKey = headers['api-key'];

	if (apiKey != undefined && apiKey != null && apiKey != '' && apiKey == shareData.appData.api_key) {

		success = true;
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

