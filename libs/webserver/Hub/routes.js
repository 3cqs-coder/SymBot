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


	router.post('/remove_instance', async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			await shareData.Hub.routeRemoveInstance(req, res);
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


	// ── TradingView chart — served directly by Hub (no instance proxy needed) ──
	router.get('/api/tradingview', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.Common.showTradingView(req, res);
		}
		else {

			res.status(401).send('Unauthorized');
		}
	});


	// ── Hub unified deals view ──────────────────────────────────────────────
	router.get('/deals', async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			res.render('Hub/dealsView', { 'isHub': true, 'appData': shareData.appData, 'convertBoolean': shareData.Common.convertBoolean.toString() });
		}
		else {

			res.redirect('/login');
		}
	});


	// ── Hub unified bots view ────────────────────────────────────────────────
	router.get('/bots', async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			res.render('Hub/botsView', { 'isHub': true, 'appData': shareData.appData, 'convertBoolean': shareData.Common.convertBoolean.toString() });
		}
		else {

			res.redirect('/login');
		}
	});


	// ── Hub JSON API — deals (aggregated across all instances) ───────────────
	router.get('/api/hub/deals', async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (!req.session.loggedIn) {

			return res.status(401).json({ 'success': false, 'data': 'Unauthorized' });
		}

		try {

			const instancesData = await shareData.Hub.getActiveDeals();

			const deals = [];

			for (const instance of instancesData) {

				const instanceName = instance.name;
				const instanceId   = instance.instanceId;
				const instanceDeals = instance.deals || [];

				for (const deal of instanceDeals) {

					deals.push({ ...deal, instanceName, instanceId });
				}
			}

			res.json({ 'date': new Date(), 'success': true, 'data': deals });
		}
		catch (err) {

			res.json({ 'success': false, 'data': err.message });
		}
	});


	// ── Hub JSON API — bots (aggregated across all instances) ────────────────
	router.get('/api/hub/bots', async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (!req.session.loggedIn) {

			return res.status(401).json({ 'success': false, 'data': 'Unauthorized' });
		}

		try {

			const instancesData = await shareData.Hub.getActiveBots();

			const bots = [];

			for (const instance of instancesData) {

				const instanceName = instance.name;
				const instanceId   = instance.instanceId;
				const instanceBots = instance.bots || [];

				for (const bot of instanceBots) {

					bots.push({ ...bot, instanceName, instanceId });
				}
			}

			res.json({ 'date': new Date(), 'success': true, 'data': bots });
		}
		catch (err) {

			res.json({ 'success': false, 'data': err.message });
		}
	});


	// ── Hub JSON API — deal actions (routed to correct instance) ─────────────
	router.post('/api/hub/deals/:dealId/action', async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (!req.session.loggedIn) {

			return res.status(401).json({ 'success': false, 'data': 'Unauthorized' });
		}

		const { dealId } = req.params;
		const { instanceId, action, botId, data } = req.body;

		if (!instanceId || !action) {

			return res.json({ 'success': false, 'data': 'instanceId and action are required' });
		}

		try {

			const result = await shareData.Hub.performDealAction(instanceId, action, dealId, botId, data);

			res.json(result);
		}
		catch (err) {

			res.json({ 'success': false, 'data': err.message });
		}
	});


	// ── Hub JSON API — bot actions ───────────────────────────────────────────
	router.post('/api/hub/bots/:botId/action', async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (!req.session.loggedIn) {

			return res.status(401).json({ 'success': false, 'data': 'Unauthorized' });
		}

		const { botId } = req.params;
		const { instanceId, action, data } = req.body;

		if (!instanceId || !action) {

			return res.json({ 'success': false, 'data': 'instanceId and action are required' });
		}

		try {

			const result = await shareData.Hub.performDealAction(instanceId, action, null, botId, data);

			res.json(result);
		}
		catch (err) {

			res.json({ 'success': false, 'data': err.message });
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

