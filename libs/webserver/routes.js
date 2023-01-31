'use strict';


let shareData;


function initRoutes(router) {

	router.get('/', (req, res) => {

		res.set('Cache-Control', 'no-store');

		res.render( 'homeView', { 'appData': shareData.appData } );
	});
	

	router.get('/deals/new', (req, res) => {

		res.set('Cache-Control', 'no-store');

		shareData.DCABotManager.viewCreateDeal(req, res);
	});


	router.get('/deals/active', (req, res) => {

		res.set('Cache-Control', 'no-store');

		shareData.DCABotManager.viewActiveDeals(req, res);
	});


	router.get('/deals/history', (req, res) => {

		res.set('Cache-Control', 'no-store');

		shareData.DCABotManager.viewHistoryDeals(req, res);
	});


	router.get('/api/deals', (req, res) => {

		res.set('Cache-Control', 'no-store');

		shareData.DCABotManager.apiGetDeals(req, res);
	});


	router.post('/api/deals/create', (req, res) => {

		shareData.DCABotManager.apiCreateDeal(req, res);
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

