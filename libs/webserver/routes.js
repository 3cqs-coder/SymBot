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


	router.get('/bots', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.DCABotManager.viewBots(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.get('/bots/create', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.DCABotManager.viewCreateBot(req, res);
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


	router.get([ '/api/deals', '/api/deals/:dealId' ], (req, res) => {

		res.set('Cache-Control', 'no-store');

		const dealId = req.params.dealId;

		if (req.session.loggedIn) {

			if (dealId == undefined || dealId == null || dealId == '' || dealsId == 'active') {

				shareData.DCABotManager.apiGetActiveDeals(req, res);
			}
		}
		else {

			res.redirect('/login');
		}
	});


	router.post('/api/bots/stop', (req, res) => {

		if (req.session.loggedIn) {

			shareData.DCABotManager.apiStopBot(req, res);
		}
		else {

			res.redirect('/login');
		}
	});
	

	router.post('/api/bots/create', (req, res) => {

		if (req.session.loggedIn) {

			shareData.DCABotManager.apiCreateBot(req, res);
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


function start(router) {

	initRoutes(router);
}


module.exports = {

	start,

	init: function(obj) {

		shareData = obj;
    }
}

