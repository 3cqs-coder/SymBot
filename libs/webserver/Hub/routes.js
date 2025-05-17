'use strict';



let shareData;


function initRoutes(router) {

	router.get('/', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.Common.renderView('Hub/homeView', req, res, true);
		}
		else {

			res.redirect('/login');
		}
	});


	router.get('/login', (req, res) => {

		res.set('Cache-Control', 'no-store');

		res.render( 'loginView', { 'isHub': true, 'appData': shareData.appData } );
	});


	router.post('/login', (req, res) => {

		res.set('Cache-Control', 'no-store');

		shareData.Common.verifyLogin(req, res, true);
	});


	router.get('/logout', (req, res) => {

		res.set('Cache-Control', 'no-store');

		req.session.destroy((err) => {});

		res.redirect('/login');
	});


	router.get('/manage', async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			let configs;

			const hubData = await shareData.Common.getConfig(shareData.appData.hub_config);

			if (hubData.success) {

				configs = hubData.data.instances;

				const processData = await shareData.Hub.processConfig(configs);

				if (processData.success) {

					configs = processData.configs;
				}
			}

			const exchanges = await shareData.Hub.getExchanges();

			res.render('Hub/manageView', {
				'isHub': true, 'configs': configs, 'appData': shareData.appData, 'exchanges': exchanges, 'numFormatter': shareData.Common.numFormatter
			});
		}
		else {

			res.redirect('/login');
		}
	});


	router.post('/update_instances', async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.Hub.routeUpdateInstances(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.post('/add_instance', async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.Hub.routeAddInstance(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.post('/start_instance', async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.Hub.routeStartWorker(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.get('/news', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.Hub.routeShowNews(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.get('/config', (req, res) => {

		res.set('Cache-Control', 'no-store');

		res.render( 'Hub/configView', { 'isHub': true, 'appData': shareData.appData } );
	});


	router.post('/config', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.Hub.routeUpdateConfig(req, res);
		}
		else {

			res.redirect('/login');
		}
	});


	router.get([ '/logs', '/backups' ], (req, res) => {

		res.set('Cache-Control', 'no-store');
	
		const type = req.path.replace('/', '');
	
		if (req.session.loggedIn) {

			shareData.Common.showFiles(type, req, res, true);
		}
		else {

			res.redirect('/login');
		}
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


	router.all('*wildcard', (req, res) => {

		redirectNotFound(res);
	});
}


function redirectNotFound(res) {

	let obj = {

		'error': 'Not Found'
	};

	res.status(404).send(obj);
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

