'use strict';

const path = require('path');
const { sendErr, redirectNotFound, denyUnauthorized, capGuard } = require(__dirname + '/routeUtils.js');
const aiMemory = require(__dirname + '/../ai/AIMemory.js');
const aiToolsRegistry = require(__dirname + '/../ai/AITools.js');
const learningAgg = require(__dirname + '/learningAggregation.js');   // shared with the Hub webserver


// Constant-time token comparison is shared: use shareData.Common.safeEqual (canonical,
// length-independent hash-first compare) so the webhook-token check can't drift from the
// identical check in AuthMiddleware.


// ── Webhook idempotency (opt-in) ─────────────────────────────────────────────
// A caller may supply an `Idempotency-Key` header, or an `idempotency_key` / `signal_id` body
// field, so a repeated signal (e.g. TradingView's known duplicate/retry alert fires) is ignored
// rather than opening or funding a deal twice. Keyed by (rewritten path + key), so the SAME id
// sent to two different bots is not cross-deduped. In-memory, short TTL; callers that send no key
// are unaffected (the built-in 3CQS client sends `signalId` in camelCase and is deliberately NOT
// matched, keeping its own dedupe untouched). Single exit.
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const idempotencySeen = new Map();   // (path|key) -> expiry ms

function webhookIdempotency(reqPath, body, headers) {

	const raw = (headers && headers['idempotency-key']) || (body && (body.idempotency_key || body.signal_id)) || '';
	const key = String(raw).trim();

	let result = { key: null, duplicate: false };

	if (key !== '') {

		const now = Date.now();

		if (idempotencySeen.size > 5000) { for (const [ k, exp ] of idempotencySeen) { if (exp <= now) { idempotencySeen.delete(k); } } }

		const composite = String(reqPath) + '|' + key;
		const exp = idempotencySeen.get(composite);

		if (exp && exp > now) { result = { key: composite, duplicate: true }; }
		else { idempotencySeen.set(composite, now + IDEMPOTENCY_TTL_MS); result = { key: composite, duplicate: false }; }
	}

	return result;
}

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

			denyUnauthorized(req, res);
		}
	});


	router.get('/system', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.Common.renderView('systemView', req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post(['/system/backup', '/api/system/backup'], (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.path.startsWith('/api') ? validApiKey(req) : req.session.loggedIn) {

			shareData.System.routeBackupDb(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	// Authenticate BEFORE multer buffers the upload (up to the configured size limit) to disk — otherwise
	// an UNAUTHENTICATED POST would write a large temp file before the session check below rejects it. A
	// key principal without settings.write is already denied by the app-level middleware before reaching
	// here; this pre-gate closes the unauthenticated (null-principal) case.
	router.post('/system/restore', (req, res, next) => {

		if (!req.session.loggedIn && !req.principal) { res.set('Cache-Control', 'no-store'); return denyUnauthorized(req, res); }
		next();

	}, upload.single('backupFile'), (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.System.routeRestoreDb(req, res);
		}
		else {

			// An API-key principal can clear the pre-gate, so multer may have already buffered the upload,
			// but restore is a session-only operation. Remove the orphaned temp file before redirecting so
			// rejected uploads can't accumulate in uploads/ (best-effort — never blocks the response).
			if (req.file && req.file.path) { try { require('fs').unlink(req.file.path, () => {}); } catch (e) {} }

			denyUnauthorized(req, res);
		}
	});


	router.post('/system/update', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.System.routeUpdateSystem(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get('/system/rollbacks', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.System.routeListRollbacks(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post('/system/rollback', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.System.routeRollbackSystem(req, res);
		}
		else {

			denyUnauthorized(req, res);
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

			denyUnauthorized(req, res);
		}
	});


	router.get('/config', (req, res) => {

		res.set('Cache-Control', 'no-store');

		// Defensive: processConfig is async and reads many config sections; if one ever throws (e.g. an
		// old-shaped app.json), surface an error instead of leaving the page hanging on an unhandled reject.
		Promise.resolve(processConfig(req, res)).catch((e) => {
			shareData.Common.logger('Config page error: ' + e.message);
			if (!res.headersSent) { res.status(500).send('Unable to load configuration: ' + e.message); }
		});
	});


	router.get('/schedules', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {
			shareData.Common.renderView('schedulesView', req, res);
		}
		else {
			denyUnauthorized(req, res);
		}
	});


	// Access Control page — API keys, users/roles, and the audit log. The page is a shell;
	// each section loads from its capability-guarded API, so a viewer sees only what their
	// role allows (a section that returns 403 simply shows nothing).
	router.get('/access', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {
			shareData.Common.renderView('accessView', req, res);
		}
		else {
			denyUnauthorized(req, res);
		}
	});


	router.post('/config', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			// Await + catch so an unexpected error inside the config save can never become an unhandled
			// rejection that leaves the request hanging (the browser spinner never clears). updateConfig
			// sends its own success/validation responses; this only backstops a truly unexpected throw.
			Promise.resolve(shareData.Common.updateConfig(req, res)).catch((e) => {

				shareData.Common.logger('POST /config failed: ' + (e && e.message ? e.message : e));

				if (!res.headersSent) {

					res.send({ 'success': false, 'data': 'Configuration could not be saved due to an unexpected error. No changes were committed.' });
				}
			});
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get('/login', (req, res) => {

		res.set('Cache-Control', 'no-store');

		res.render( 'loginView', { 'appData': shareData.appData } );
	});


	router.get('/dashboard', async (req, res) => {

		if (!isLoggedIn(req, res)) return;

		res.set('Cache-Control', 'no-store');

		// Defensive: getDashboardData is async and reads deal/balance data; if it ever rejects, surface a
		// clean, logged error instead of leaking an unhandled rejection / raw 500. Mirrors the /config route.
		// This only affects how a DISPLAY-data failure is handled — it never touches trading behavior.
		try {

			const { duration, timeZoneOffset } = req.query;

			const { kpi, charts, botIdNameMap, currencies, kpiSymbol, isLoading, period } = await shareData.DCABotManager.getDashboardData({ duration: Number(duration ?? '7'), timeZoneOffset });

			res.render( 'dashboardView', { 'appData': shareData.appData, kpi, charts, botIdNameMap, currencies, kpiSymbol, getCurrencySymbol: shareData.Common.getCurrencySymbol.toString(), isLoading, period });
		}
		catch (e) {

			shareData.Common.logger('Dashboard page error: ' + ((e && e.message) ? e.message : e));
			if (!res.headersSent) { res.status(500).send('Unable to load the dashboard: ' + ((e && e.message) ? e.message : e)); }
		}
	})


	router.get([ '/logs', '/backups' ], (req, res) => {

		res.set('Cache-Control', 'no-store');
	
		const type = req.path.replace('/', '');
	
		if (req.session.loggedIn) {

			shareData.Common.showFiles(type, req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get('/logs/live', (req, res) => {

		res.set('Cache-Control', 'no-store');

		// Gate the live-log view like every other view route — redirect anonymous visitors to /login.
		// The log lines stream over the authenticated Socket.IO channel, but the page shell should not
		// be served (nor appData passed to the template) to an unauthenticated request.
		if (!req.session.loggedIn) { return denyUnauthorized(req, res); }

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

			denyUnauthorized(req, res);
		}
	});


	router.post('/login', (req, res) => {

		res.set('Cache-Control', 'no-store');

		shareData.Common.verifyLogin(req, res);
	});


	router.get('/logout', (req, res) => {

		res.set('Cache-Control', 'no-store');

		// Audit the logout before the session is torn down, so the actor still resolves.
		shareData.Common.auditEvent(req, 'auth.logout', '', '');

		req.session.destroy((err) => {});

		res.redirect('/login');
	});


	router.get('/bots/create', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.DCABotManager.viewCreateUpdateBot(req, res);
		}
		else {

			denyUnauthorized(req, res);
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

			denyUnauthorized(req, res);
		}
	});


	router.get('/deals/active', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.DCABotManager.viewActiveDeals(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get('/deals/export', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.DCABotManager.viewTransactionExport(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get('/journal', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.DCABotManager.viewJournal(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get('/deals/history', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.DCABotManager.viewHistoryDeals(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get('/signals/activity', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.SignalActivity.viewActivity(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get('/api/signals/activity', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			shareData.SignalActivity.apiActivity(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get([ '/api/markets', '/api/markets/:path' ], (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiGetMarkets(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get('/api/tradingview', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			shareData.Common.showTradingView(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});




	router.get('/api/system/health', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			shareData.Common.getSystemHealth().then((data) => {

				res.json({ 'date': new Date(), 'data': data });
			})
			.catch((e) => {

				res.status(500).json({ 'error': 'Error getting system health' });
			});
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get('/api/bots', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiGetBots(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post([ '/api/ai/analyze_deal' ], (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiAiAnalyzeDeal(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get([ '/api/ai/analyze_deal_prompt' ], (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiAiAnalyzeDealPrompt(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	// Lists the models a provider offers, so the config screen can present real
	// choices for every model field instead of a free-text guess. POST (not GET) so
	// an API key travels in the body, never the URL. The body may carry
	// { provider, host, api_key, base_url } to list a specific provider using the
	// details currently entered in the form; with none, the active provider is used.
	router.post([ '/api/ai/models' ], async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			const body = req.body || {};

			// The key field is write-only (submits blank when unchanged), so fall back to the stored
			// decrypted key for that provider — otherwise "list models" would fail without re-typing it.
			let apiKey = body.api_key;
			if (!apiKey && body.provider) {
				try {
					const cfg = await shareData.Common.getConfig(shareData.appData.app_config);
					apiKey = await shareData.Common.readSecret(cfg?.data?.ai?.[body.provider]?.api_key);
				}
				catch (e) { apiKey = body.api_key; }
			}

			const opts = {
				'provider': body.provider,
				'host':     body.host,
				'api_key':  apiKey,
				'base_url': body.base_url,
				'force':    body.force === true,
			};

			let models = [];

			try { models = await shareData.AIClient.listModels(opts); }
			catch (e) { models = []; }

			res.send({ 'date': new Date(), 'success': true, 'data': models });
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	// Whether a given model can do tool-calling, so the config screen can warn before
	// AI Tools is enabled with a model that would silently fall back. supported is
	// true / false / null (unknown — e.g. OpenAI-compatible providers that do not
	// expose the capability).
	router.post([ '/api/ai/model-tools-support' ], async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			const body = req.body || {};

			const opts = {
				'provider': body.provider,
				'host':     body.host,
				'api_key':  body.api_key,
				'model':    body.model,
				'force':    body.force === true,
			};

			let supported = null;

			try { supported = (await shareData.AIClient.modelSupportsTools(opts)).supported; }
			catch (e) { supported = null; }

			res.send({ 'date': new Date(), 'success': true, 'supported': supported });
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	// AI readiness preflight: is the configured (or being-configured) provider reachable and does it
	// have the chosen model — so the user learns up front whether AI will work on their machine,
	// instead of a cryptic failure on the first question. Read-only, best-effort; mirrors the models
	// route's write-only key fallback so a check works without re-typing a saved key.
	router.post([ '/api/ai/preflight' ], async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			const body = req.body || {};

			let apiKey = body.api_key;
			if (!apiKey && body.provider) {
				try {
					const cfg = await shareData.Common.getConfig(shareData.appData.app_config);
					apiKey = await shareData.Common.readSecret(cfg?.data?.ai?.[body.provider]?.api_key);
				}
				catch (e) { apiKey = body.api_key; }
			}

			const opts = {
				'provider': body.provider,
				'host':     body.host,
				'api_key':  apiKey,
				'base_url': body.base_url,
				'model':    body.model,
				'tools':    body.tools === true,
				'force':    body.force === true,
			};

			let data;
			try { data = await shareData.AIClient.preflight(opts); }
			catch (e) { data = { ok: false, reachable: false, messages: [ { level: 'error', text: 'Preflight could not run.' } ] }; }

			res.send({ 'date': new Date(), 'success': true, 'data': data });
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post('/api/ai/chat/view', (req, res) => {

		res.set('Cache-Control', 'no-store');

		const body = req.body;

		if (isAuthenticated(req)) {

			res.render( 'aiChatView', { 'appData': shareData.appData, 'bodyData': body } );
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post('/api/ai/chat/prompt', async (req, res) => {

		res.set('Cache-Control', 'no-store');

		// A NON-streaming request (curl / API) can legitimately run a long, wall-clock-bounded
		// deep-analysis on a slow local model. The default server socket timeout (serverTimeoutMins)
		// would sever it mid-flight ("socket hang up") before the answer is composed. Extend the
		// per-request socket timeout so the synchronous reply can complete — this affects ONLY this
		// request's socket, never the global server. Streaming requests return immediately and don't
		// need it, but setting it is harmless. The deep flow is itself time-boxed, so this can't hang.
		try {
			req.setTimeout(6 * 60 * 1000);
			if (res && typeof res.setTimeout === 'function') { res.setTimeout(6 * 60 * 1000); }
		}
		catch (e) {}

		const body = req.body;

		if (isAuthenticated(req)) {

			try {

				// A non-streaming request (typically curl / the API, which has no socket
				// to receive a streamed reply) is awaited so the composed answer — tool
				// results and all — comes back in the HTTP response body. A streaming
				// request stays fire-and-forget: its reply is delivered over the
				// Socket.IO room, and the endpoint returns immediately.
				const wantStream = !(body && body.message && body.message.stream === false);

				if (wantStream) {

					shareData.AIClient.streamChat(JSON.stringify(body));

					res.status(200).send({ 'success': true });
				}
				else {

					const out = await shareData.AIClient.streamChat(JSON.stringify(body));

					res.status(200).send(out || { 'success': true });
				}
			}
			catch (e) {

				let obj = { 'success': false, 'data': e.message };

				res.status(200).send(obj);
			}
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post('/api/circuit-breaker/clear', (req, res) => {

		if (!isLoggedIn(req, res)) return;

		delete shareData.appData.circuit_breaker_active;
		delete shareData.appData.circuit_breaker_activated_at;
		delete shareData.appData.circuit_breaker_clears_at;
		shareData.appData.cb_trigger_window = [];

		shareData.Common.logger('Circuit breaker manually cleared by user');

		shareData.Common.sendNotification({
			'message': '✅ Circuit Breaker Manually Cleared\n\nNormal deal processing has resumed.',
			'type': 'warning',
			'telegram_id': shareData.appData.telegram_id
		});

		res.status(200).json({ success: true });
	});


	// ── AI chat file upload ─────────────────────────────────────────────────
	router.post('/api/ai/chat/upload', (req, res) => {

		// Session OR a valid key principal — the RoutePermissions middleware already enforced the
		// required stats.read capability for the API-key path, so this is only the redundant handler
		// gate; accept a key here too so the feature works over curl (JSON 401, not a browser redirect).
		if (!isAuthenticated(req)) { return denyUnauthorized(req, res); }

		shareData.Common.uploadAiChatFile(req, res);
	});


	router.get([ '/api/deals/export/transactions' ], (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiExportTransactionsCsv(req, res);
		}
		else {

			redirectNotFound(res);
		}
	});


	router.get([ '/api/deals/export/deals' ], (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiExportDealsCsv(req, res);
		}
		else {

			redirectNotFound(res);
		}
	});


	router.get('/api/journal', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiGetJournal(req, res);
		}
		else {

			redirectNotFound(res);
		}
	});


	router.post('/api/journal/note', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiSaveJournalNote(req, res);
		}
		else {

			redirectNotFound(res);
		}
	});


	router.post('/api/journal/mood', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiSaveJournalMood(req, res);
		}
		else {

			redirectNotFound(res);
		}
	});


	router.get('/api/journal/stats', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiGetJournalStats(req, res);
		}
		else {

			redirectNotFound(res);
		}
	});


	router.post('/api/journal/narrative', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiGenerateJournalNarrative(req, res);
		}
		else {

			redirectNotFound(res);
		}
	});


	router.post('/api/journal/delete', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiDeleteJournalEntry(req, res);
		}
		else {

			redirectNotFound(res);
		}
	});


	router.get([ '/api/deals', '/api/deals/completed', '/api/deals/:dealId/show' ], (req, res) => {

		res.set('Cache-Control', 'no-store');

		const reqPath = req.path;
		const dealId = req.params.dealId;

		if (isAuthenticated(req)) {

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

			denyUnauthorized(req, res);
		}
	});


	router.get('/app-version', async (req, res) => {

		res.set('Cache-Control', 'no-store');

		// Gate this like every other data route: the only caller is the (post-login) config page.
		// Left open, it lets an unauthenticated client drive repeated outbound update-check fetches
		// (exhausting the upstream unauthenticated rate limit) and mutate shared update state.
		if (!isAuthenticated(req)) {

			return denyUnauthorized(req, res);
		}

		const { update_available } = await shareData.Common.validateAppVersion();

		if(update_available && !shareData.appData.update_available) {
			shareData.appData.update_available = true;
		}

		res.json({
			update_available
		})
	});


	router.post([ '/api/deals/:dealId/update_deal' ], (req, res) => {

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiUpdateDeal(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	// Two ways to target: by dealId, or by botId (+ optional "pair" in the body)
	// which resolves to the bot's single active deal — lets static signal sources
	// add funds without knowing the dealId generated when the deal opened.
	router.post([ '/api/deals/:dealId/add_funds', '/api/bots/:botId/add_funds' ], (req, res) => {

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiAddFundsDeal(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post([ '/api/deals/:dealId/pause' ], (req, res) => {

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiPauseDeal(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post([ '/api/deals/:dealId/cancel' ], (req, res) => {

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiCancelDeal(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	// Target by dealId, or by botId (+ optional "pair" in the body) to resolve the
	// bot's single active deal — emergency close without needing the dealId.
	router.post([ '/api/deals/:dealId/panic_sell', '/api/bots/:botId/panic_sell' ], (req, res) => {

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiPanicSellDeal(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	// Graceful close for the Signal Bot. Same targeting as panic_sell — by
	// dealId, or by botId (+ optional "pair") to resolve the bot's single active
	// deal — but this ALWAYS respects the profit target: it closes only if the
	// take-profit target is met, otherwise it leaves the deal open. The emergency,
	// profit-ignoring close is the separate panic_sell command. The /webhook form
	// is handled automatically by the webhook passthrough.
	router.post([ '/api/deals/:dealId/close', '/api/bots/:botId/close' ], (req, res) => {

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiCloseDeal(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	// Single Signal Bot dispatcher: one webhook URL for every command. Reads an
	// `action` field (entry / add_funds / close / panic_sell) and forwards to the
	// same per-action handlers above. Convenience only — no new order logic. The
	// /webhook form is handled automatically by the webhook passthrough.
	router.post('/api/signal/:botId', (req, res) => {

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiSignalDispatch(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post('/api/bots/update-exchange', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiUpdateBotsExchange(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post([ '/api/bots/create', '/api/bots/update' ], (req, res) => {

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiCreateUpdateBot(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post([ '/api/bots/:botId/enable', '/api/bots/:botId/disable' ], (req, res) => {

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiEnableDisableBot(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.delete('/api/bots/:botId', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiDeleteBot(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post([ '/api/bots/:botId/start_deal' ], (req, res) => {

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiStartDeal(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post([ '/api/accounts/:exchangeId/balances', '/api/accounts/balances' ], (req, res) => {

		if (isAuthenticated(req)) {

			shareData.DCABotManager.apiGetBalances(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get('/api/exchanges', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			try {

				const ccxt = require('ccxt');
				const exchanges = ccxt.exchanges;
				res.send({ success: true, data: exchanges });
			}
			catch (e) {

				res.send({ success: false, data: e.message });
			}
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	// req.principal is accepted alongside the session because the capability middleware in front of these
	// routes (RoutePermissions: GET bot-config = bot.read, POST = bot.write) has already denied any principal
	// lacking the capability — so a scoped API key that reaches the handler is authorized. Without this the
	// handler's session-only check threw the key away, and the same key worked on some routes but not these.
	router.get('/api/bot-config', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn || req.principal || validApiKey(req)) {

			shareData.Common.getBotConfig(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post('/api/bot-config', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn || req.principal) {

			shareData.Common.updateBotConfig(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post('/api/bot-config/sandbox', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn || req.principal) {

			shareData.Common.updateBotConfigSandbox(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get('/api/ai/chat/history', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			const room = req.query.room;

			if (!room) {

				return sendErr(res, 'room required', 400);
			}

			const messages = shareData.AIClient.getChatHistory(room);

			res.status(200).json({ success: true, messages });
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get('/api/ai/chat/conversations', async (req, res) => {

		if (!isLoggedIn(req, res)) return;

		try {
			const conversations = await shareData.AIClient.listConversations();
			res.status(200).json({ success: true, data: conversations });
		} catch(e) { sendErr(res, e); }
	});


	// ── AI Learning corpus: stats / export / import / rate ───────────────────────
	// The self-improvement corpus is patterns-only (question → tools), never values.
	//
	// These require a resolved PRINCIPAL (a login session or a scoped API key), not the generic
	// validApiKey() check. The legacy webhook `api-token` now resolves to a deal-only principal, which the
	// app-level capability middleware denies on these AI-learning routes (it holds neither stats.read nor
	// settings.write) — but gating on the principal here is belt-and-suspenders so nothing that isn't a
	// real session/key can reach import/rate/export. The app-level middleware still enforces the per-route
	// scope (stats/export = stats.read, import/rate = settings.write).
	const learningPrincipal = (req) => !!(req.session.loggedIn || req.principal);

	router.get('/api/ai/learning/stats', async (req, res) => {

		res.set('Cache-Control', 'no-store');
		if (!learningPrincipal(req)) { return sendErr(res, 'unauthorized', 401); }

		try {
			const s = await aiMemory.stats();
			res.status(200).json({ success: true, total: s.total, by_source: s.by_source });
		} catch (e) { sendErr(res, e); }
	});

	// Download the whole corpus as a validated, patterns-only pack (manifest + checksum).
	router.get('/api/ai/learning/export', async (req, res) => {

		res.set('Cache-Control', 'no-store');
		if (!learningPrincipal(req)) { return sendErr(res, 'unauthorized', 401); }

		try {
			const pack = await aiMemory.exportPack({
				created: Date.now(),
				symbotVersion: (shareData.appData && shareData.appData.version) || null,
				toolsVersion: (typeof aiToolsRegistry.toolSignature === 'function') ? aiToolsRegistry.toolSignature() : null,
				description: 'SymBot AI learning patterns'
			});
			res.setHeader('Content-Type', 'application/json');
			res.setHeader('Content-Disposition', 'attachment; filename="symbot-ai-learning.json"');
			res.status(200).send(JSON.stringify(pack, null, 2));
		} catch (e) { sendErr(res, e, 500); }
	});

	// Import a pack. It is verified (format + integrity checksum + every referenced tool
	// must exist in this install's registry) before anything is added; an invalid or
	// tampered file is rejected with a clear message.
	router.post('/api/ai/learning/import', async (req, res) => {

		if (!learningPrincipal(req)) { return sendErr(res, 'unauthorized', 401); }

		try {
			const pack = (req.body && req.body.pack) ? req.body.pack : req.body;
			const validTools = new Set((aiToolsRegistry.TOOLS || []).map(t => t.name));
			const result = await aiMemory.verifyAndImportPack(pack, 'community', { validTools, aliases: aiToolsRegistry.TOOL_ALIASES });

			if (result.error) { return sendErr(res, result.error, 200); }
			res.status(200).json({ success: true, imported: result.imported, rejected: result.rejected });
		} catch (e) { sendErr(res, e); }
	});

	// Apply a 👍 (1) / 👎 (-1) / clear (0) rating to a recorded outcome.
	router.post('/api/ai/learning/rate', async (req, res) => {

		if (!learningPrincipal(req)) { return sendErr(res, 'unauthorized', 401); }

		try {
			const id = req.body && req.body.id;
			const rating = req.body && req.body.rating;
			const ok = await aiMemory.rate(id, rating);
			res.status(200).json({ success: ok });
		} catch (e) { sendErr(res, e); }
	});

	// Aggregate contributed patterns-only packs into a candidate merge and (dry-run) measure how it changes
	// routing accuracy on a HELD-OUT eval set — so a maintainer reviews the conflicts and the before/after
	// accuracy BEFORE adopting. Body: { packs: [...], min_contributors?, commit? }. Frequency-weighted majority
	// vote, ties surfaced not guessed, low-support one-offs gated out. Nothing is written unless commit:true,
	// which imports only the genuinely NEW winners. Read-only and off the trading path either way.
	router.post('/api/ai/learning/aggregate', async (req, res) => {

		if (!learningPrincipal(req)) { return sendErr(res, 'unauthorized', 401); }

		try {
			// current defaults to AIMemory's own store; adopt writes the winners into it.
			const out = await learningAgg.aggregateResponse(aiMemory, aiToolsRegistry, req.body, { adopt: (recs) => aiMemory.importPack(recs, 'community') });
			if (out.error) { return sendErr(res, out.error, 200); }
			res.status(200).json(out);
		} catch (e) { sendErr(res, e); }
	});

	// Measure the CURRENT corpus against the held-out eval set (no packs) — "how accurate is my corpus now",
	// global + per-tool, with the missed questions, so a maintainer has a baseline to improve against.
	router.get('/api/ai/learning/evaluate', async (req, res) => {

		res.set('Cache-Control', 'no-store');
		if (!learningPrincipal(req)) { return sendErr(res, 'unauthorized', 401); }

		try {
			res.status(200).json(await learningAgg.evaluateResponse(aiMemory, aiToolsRegistry, {}));
		} catch (e) { sendErr(res, e); }
	});


	router.post('/api/ai/chat/conversations/save', async (req, res) => {

		if (!isAuthenticated(req)) { return denyUnauthorized(req, res); }

		const { conversation_id, name, room } = req.body;
		const startIndex = req.body.start_index !== undefined ? Number(req.body.start_index) : undefined;
		const convType   = req.body.type    || 'chat';
		const dealId     = req.body.deal_id || '';
		if (!conversation_id || !room) return sendErr(res, 'conversation_id and room required', 400);

		try {
			await shareData.AIClient.saveConversation(conversation_id, name || 'New Conversation', room, startIndex, convType, dealId);
			res.status(200).json({ success: true });
		} catch(e) { sendErr(res, e); }
	});


	router.post('/api/ai/chat/conversations/load', async (req, res) => {

		if (!isAuthenticated(req)) { return denyUnauthorized(req, res); }

		const { conversation_id, room } = req.body;
		if (!conversation_id || !room) return sendErr(res, 'conversation_id and room required', 400);

		try {
			const result = await shareData.AIClient.loadConversation(conversation_id, room);
			if (!result) return sendErr(res, 'Conversation not found', 200);
			res.status(200).json({ success: true, data: result });
		} catch(e) { sendErr(res, e); }
	});


	router.delete('/api/ai/chat/conversations/:conversation_id', async (req, res) => {

		if (!isAuthenticated(req)) { return denyUnauthorized(req, res); }

		try {
			await shareData.AIClient.deleteConversation(req.params.conversation_id);
			res.status(200).json({ success: true });
		} catch(e) { sendErr(res, e); }
	});


	// ── Scheduled jobs (read-only AI reports / alerts) ──────────────────────
	router.get('/api/schedules', async (req, res) => {

		if (!isLoggedIn(req, res)) return;
		try { res.status(200).json(await shareData.Scheduler.list()); }
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/schedules', async (req, res) => {

		if (!isLoggedIn(req, res)) return;
		try { res.status(200).json(await shareData.Scheduler.add(req.body || {})); }
		catch (e) { sendErr(res, e); }
	});

	// Verify SMTP settings and send a test message, without saving them. A blank password
	// on the form falls back to the stored (encrypted) SMTP password so already-saved
	// settings can be tested without retyping it. Never returns the password.
	router.post('/api/mailer/test', async (req, res) => {

		if (!isLoggedIn(req, res)) return;

		try { res.status(200).json(await shareData.Mailer.testFromRequest(req.body)); }
		catch (e) { sendErr(res, e); }
	});

	// ── Authorization: API-key management ───────────────────────────────────
	router.get('/api/keys', cap('apikey.read'), async (req, res) => {
		try { res.status(200).json({ success: true, keys: await shareData.ApiKeys.list() }); }
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/keys', cap('apikey.create'), async (req, res) => {
		try {
			const body = req.body || {};
			const r = await shareData.ApiKeys.create({
				name: body.name,
				capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
				signing: body.signing,
				expiresAt: body.expires_at ? new Date(body.expires_at) : null,
				rateLimit: body.rate_limit,
				ipAllowlist: Array.isArray(body.ip_allowlist) ? body.ip_allowlist : [],
				ipBlocklist: Array.isArray(body.ip_blocklist) ? body.ip_blocklist : [],
				ownerUserId: req.principal && req.principal.id,
				ownerCapabilities: (req.principal && req.principal.capabilities) || []   // key scopes ⊆ owner
			});
			if (r.success) { shareData.Common.auditEvent(req, 'apikey.create', r.key.prefix, r.key.name); }
			res.status(200).json(r);   // r.clearKey shown once by the UI
		}
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/keys/:id/rotate', cap('apikey.create'), async (req, res) => {
		try {
			const body = req.body || {};
			const r = await shareData.ApiKeys.rotate(req.params.id, { graceHours: body.grace_hours });
			if (r.success) { shareData.Common.auditEvent(req, 'apikey.rotate', (r.key && r.key.prefix) || req.params.id, 'rotated; predecessor expires in ' + r.grace_hours + 'h'); }
			res.status(200).json(r);   // r.clearKey shown once by the UI
		}
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/keys/:id/status', cap('apikey.revoke'), async (req, res) => {
		try {
			const status = (req.body && req.body.status) || 'revoked';
			const r = await shareData.ApiKeys.setStatus(req.params.id, status);
			if (r.success) { shareData.Common.auditEvent(req, status === 'revoked' ? 'apikey.revoke' : 'apikey.status', req.params.id, status); }
			res.status(200).json(r);
		}
		catch (e) { sendErr(res, e); }
	});

	// Edit a key's IP allow/block lists (exact / CIDR / wildcard). Invalid entries are dropped
	// server-side. Managing keys is an apikey.create-level action.
	router.post('/api/keys/:id/ip', cap('apikey.create'), async (req, res) => {
		try {
			const body = req.body || {};
			const r = await shareData.ApiKeys.setIpLists(
				req.params.id,
				Array.isArray(body.ip_allowlist) ? body.ip_allowlist : [],
				Array.isArray(body.ip_blocklist) ? body.ip_blocklist : []
			);
			if (r.success) { shareData.Common.auditEvent(req, 'apikey.ip', req.params.id, 'allow ' + (r.ip_allowlist || []).length + ' / block ' + (r.ip_blocklist || []).length); }
			res.status(200).json(r);
		}
		catch (e) { sendErr(res, e); }
	});

	// Set or clear a key's expiry after creation (expiry was previously fixed at creation time).
	// An expired key is rejected at auth. Managing keys is an apikey.create-level action.
	router.post('/api/keys/:id/expiry', cap('apikey.create'), async (req, res) => {
		try {
			const body = req.body || {};
			const r = await shareData.ApiKeys.setExpiry(req.params.id, (body.expires_at != null ? body.expires_at : null));
			if (r.success) { shareData.Common.auditEvent(req, 'apikey.expiry', req.params.id, r.expires_at ? new Date(r.expires_at).toISOString() : 'cleared'); }
			res.status(200).json(r);
		}
		catch (e) { sendErr(res, e); }
	});

	// The caller's own source IP as SymBot sees it (proxy-aware). Used by the IP-filter UI to show
	// "your current IP is X" so a user never accidentally locks themselves out. Any logged-in
	// principal may read their own IP.
	router.get('/api/client-ip', (req, res) => {
		if (!isLoggedIn(req, res)) return;
		const ip = (shareData.AuthMiddleware && typeof shareData.AuthMiddleware.clientIp === 'function')
			? shareData.AuthMiddleware.clientIp(req)
			: (req.ip || '');
		res.status(200).json({ success: true, ip: ip });
	});

	// ── Authorization: user management ──────────────────────────────────────
	router.get('/api/users', cap('user.read'), async (req, res) => {
		try { res.status(200).json({ success: true, users: await shareData.Users.list() }); }
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/users', cap('user.invite'), async (req, res) => {
		try {
			const body = req.body || {};
			// Bound the new user's role/grants to the creator's own authority so a non-owner cannot mint an
			// owner (or grant capabilities they lack). The owner ('*') is unaffected. Legacy owner session
			// (loggedIn, no userId) has no scoped principal but is the implicit owner, so treat it as '*'.
			const creatorCaps = (req.principal && Array.isArray(req.principal.capabilities))
				? req.principal.capabilities
				: ((req.session && req.session.loggedIn && !req.session.userId) ? [ '*' ] : []);
			const scoped = shareData.Authz.scopeNewUser(creatorCaps, { role: body.role, grants: body.grants });
			if (scoped.exceeded) { return res.status(403).json({ success: false, error: 'You cannot create a user more privileged than your own account.' }); }
			const r = await shareData.Users.create({ username: body.username, password: body.password, role: scoped.role, grants: scoped.grants });
			if (r.success) { shareData.Common.auditEvent(req, 'user.create', r.user.username, r.user.role); }
			res.status(200).json(r);
		}
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/users/:id/role', cap('user.manage'), async (req, res) => {
		try {
			const r = await shareData.Users.setRole(req.params.id, (req.body && req.body.role));
			if (r.success) { shareData.Common.auditEvent(req, 'user.role', req.params.id, (req.body && req.body.role)); }
			res.status(200).json(r);
		}
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/users/:id/status', cap('user.manage'), async (req, res) => {
		try {
			const status = (req.body && req.body.status) || 'active';
			const r = await shareData.Users.setStatus(req.params.id, status);
			if (r.success) { shareData.Common.auditEvent(req, 'user.status', req.params.id, status); }
			res.status(200).json(r);
		}
		catch (e) { sendErr(res, e); }
	});

	// ── Authorization: audit log + capability catalog (for the UIs) ──────────
	router.get('/api/audit', cap('audit.read'), async (req, res) => {
		try { res.status(200).json({ success: true, entries: await shareData.Audit.list({ action: req.query.action, actor: req.query.actor, limit: req.query.limit }) }); }
		catch (e) { sendErr(res, e); }
	});

	router.get('/api/authz/capabilities', cap('apikey.read'), (req, res) => {
		res.status(200).json({ success: true, capabilities: shareData.Authz.CAPABILITIES, roles: shareData.Authz.ROLE_NAMES });
	});

	// Clear-language "what it means / how to fix" for diagnostic codes (watchdog findings, version
	// notices). Static help text with no sensitive data — the Audit Log view fetches it to explain a
	// finding on hover. Gated the same as the audit log, which is where it is consumed.
	router.get('/api/diagnostics', cap('audit.read'), (req, res) => {
		try { res.status(200).json({ success: true, catalog: shareData.Diagnostics.catalog() }); }
		catch (e) { sendErr(res, e); }
	});


	// Fire a schedule immediately (Run now) — does not consume or disable a one-off.
	router.post('/api/schedules/:id/run', async (req, res) => {

		if (!isLoggedIn(req, res)) return;
		try { res.status(200).json(await shareData.Scheduler.runNow(req.params.id)); }
		catch (e) { sendErr(res, e); }
	});

	// Run history for a schedule.
	router.get('/api/schedules/:id/runs', async (req, res) => {

		if (!isLoggedIn(req, res)) return;
		try { res.status(200).json(await shareData.Scheduler.listRuns(req.params.id, req.query.limit)); }
		catch (e) { sendErr(res, e); }
	});

	// Download all run history across schedules as a JSON file. (Registered before the
	// per-schedule export so the literal path isn't captured by the :id parameter.)
	router.get('/api/schedule-runs/export', async (req, res) => {

		if (!isLoggedIn(req, res)) return;
		try {
			const out = await shareData.Scheduler.listAllRuns();
			res.setHeader('Content-Disposition', 'attachment; filename="symbot-schedule-runs-all.json"');
			res.setHeader('Content-Type', 'application/json');
			res.status(200).send(JSON.stringify(out.runs || [], null, 2));
		}
		catch (e) { sendErr(res, e); }
	});

	// Download one schedule's run history as a JSON file.
	router.get('/api/schedules/:id/runs/export', async (req, res) => {

		if (!isLoggedIn(req, res)) return;
		try {
			const out = await shareData.Scheduler.listRuns(req.params.id, 5000);
			res.setHeader('Content-Disposition', 'attachment; filename="symbot-schedule-runs-' + String(req.params.id).slice(0, 8) + '.json"');
			res.setHeader('Content-Type', 'application/json');
			res.status(200).send(JSON.stringify(out.runs || [], null, 2));
		}
		catch (e) { sendErr(res, e); }
	});

	router.delete('/api/schedules/:id/runs/:runId', async (req, res) => {

		if (!isLoggedIn(req, res)) return;
		try { res.status(200).json(await shareData.Scheduler.deleteRun(req.params.id, req.params.runId)); }
		catch (e) { sendErr(res, e); }
	});

	router.delete('/api/schedules/:id/runs', async (req, res) => {

		if (!isLoggedIn(req, res)) return;
		try { res.status(200).json(await shareData.Scheduler.clearRuns(req.params.id)); }
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/schedules/:id', async (req, res) => {

		if (!isLoggedIn(req, res)) return;
		try {
			const body = req.body || {};
			if (Object.prototype.hasOwnProperty.call(body, 'enabled') && Object.keys(body).length === 1) {
				res.status(200).json(await shareData.Scheduler.setEnabled(req.params.id, body.enabled));
			}
			else {
				res.status(200).json(await shareData.Scheduler.update(req.params.id, body));
			}
		}
		catch (e) { sendErr(res, e); }
	});

	router.delete('/api/schedules/:id', async (req, res) => {

		if (!isLoggedIn(req, res)) return;
		try {
			// If this schedule was imported from a pre-defined recipe, remember the removal (a tombstone)
			// so the import-on-start seeder does not re-create it on the next boot — the delete sticks.
			let recipeId = null;
			try { const list = await shareData.Scheduler.list(); const row = ((list && list.schedules) || []).find(s => s.schedule_id === req.params.id); recipeId = row && row.settings && row.settings.recipe_id; }
			catch (e) { /* best-effort lookup */ }

			const result = await shareData.Scheduler.remove(req.params.id);
			if (result && result.success && recipeId && shareData.ScheduleRecipes) { await shareData.ScheduleRecipes.markRemoved(recipeId); }
			res.status(200).json(result);
		}
		catch (e) { sendErr(res, e); }
	});

	// Pre-defined recipe library: browse the shipped catalog (annotated with what is already added
	// or removed for this instance), and add one as a fresh disabled schedule the user then manages.
	router.get('/api/recipes', async (req, res) => {

		if (!isLoggedIn(req, res)) return;
		try { res.status(200).json({ success: true, recipes: await shareData.ScheduleRecipes.catalog() }); }
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/recipes/:id/add', async (req, res) => {

		if (!isLoggedIn(req, res)) return;
		try { res.status(200).json(await shareData.ScheduleRecipes.addFromLibrary(req.params.id)); }
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/recipes/:id/reset', async (req, res) => {

		if (!isLoggedIn(req, res)) return;
		try { res.status(200).json(await shareData.ScheduleRecipes.resetToDefaults(req.params.id)); }
		catch (e) { sendErr(res, e); }
	});

	// What a "Reset to defaults" would change for an installed recipe: the field-level diff between
	// the user's current row and the shipped definition, so an update is never applied blind.
	router.get('/api/recipes/:id/update-diff', async (req, res) => {

		if (!isLoggedIn(req, res)) return;
		try { res.status(200).json(await shareData.ScheduleRecipes.updateDiff(req.params.id)); }
		catch (e) { sendErr(res, e); }
	});


	router.get('/api/ai/chat/popout', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (isAuthenticated(req)) {

			// Redirect mobile browsers to main app — popout requires desktop
			const ua = req.headers['user-agent'] || '';
			const isMobile = /Mobile|Android|iPhone|iPad/i.test(ua);

			if (isMobile) {

				res.redirect('/');
				return;
			}

			res.render('aiChatPopoutView', { 'appData': shareData.appData, 'query': req.query });
		}
		else {

			denyUnauthorized(req, res);
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

		// `|| {}` so an OLD app.json that predates the ai block (a manual/Docker upgrade that doesn't
		// backfill new keys) doesn't throw here — JSON.parse(JSON.stringify(undefined)) is a SyntaxError,
		// which would leave the Configuration page hanging (this route calls processConfig un-awaited).
		const aiRaw = JSON.parse(JSON.stringify(appConfig.data.ai || {}));

		// Normalize the ai config so the template always receives a complete
		// structure regardless of which schema version is on disk.
		// Old app.json files may be missing 'provider' or the 'openai' sub-object.
		const aiNormalized = {
			provider: aiRaw.provider || (aiRaw.ollama?.enabled ? 'ollama' : 'none'),
			ollama: {
				enabled: aiRaw.ollama?.enabled || false,
				host:    aiRaw.ollama?.host    || '',
				model:   aiRaw.ollama?.model   || '',
				// Provider secrets are write-only: never send the stored key to the page. `has_key`
				// lets the UI show a "leave blank to keep" placeholder instead.
				api_key: '',
				has_key: !!(aiRaw.ollama?.api_key),
			},
			openai: {
				enabled:  aiRaw.openai?.enabled  || false,
				api_key:  '',
				has_key:  !!(aiRaw.openai?.api_key),
				model:    aiRaw.openai?.model    || '',
				base_url: aiRaw.openai?.base_url || '',
			},
			context_compression: aiRaw.context_compression || {},
			deal_context: aiRaw.deal_context || {},
			generation: aiRaw.generation || {},
			tools: aiRaw.tools || {},
			learning: aiRaw.learning || {},
		};

		const cbDefaults = {
			enabled: true,
			deal_ratio_threshold: 0.5,
			deal_ratio_window_secs: 30,
			price_drop_percent: 5.0,
			price_drop_window_secs: 60,
			price_drop_enabled: true,
			pause_duration_secs: 60,
			repeat_alert_window_secs: 3600,
			price_zero_alert_count: 4
		};

		// The backup config now lives on its schedule row, mirrored into appData.cron_backup.
		// Build a guaranteed-complete shape so the secret-blanking below can't hit undefined.
		const backupLive = shareData.appData.cron_backup || {};
		const cronBackupSafe = {
			'enabled': !!backupLive.enabled,
			'schedule': backupLive.schedule || '',
			// Carry the schedule's IANA timezone through to the config page. Without it the
			// backup view always renders the DST box unchecked and a DST-anchored cron is
			// re-interpreted as UTC on the next save, silently moving the backup's fire time.
			'timezone': backupLive.timezone || '',
			'max': backupLive.max,
			'password': backupLive.password || '',
			'include_chats': backupLive.include_chats !== false,
			'include_schedules': backupLive.include_schedules !== false,
			'include_config': backupLive.include_config === true,
			'sftp': Object.assign({ 'enabled': false, 'host': '', 'port': '', 'username': '', 'password': '', 'passphrase': '', 'private_key': '', 'remote_directory': '' }, backupLive.sftp || {})
		};

		let services = Object.assign({

			'ai': aiNormalized,
			'cron_backup': JSON.parse(JSON.stringify(cronBackupSafe)),
			'telegram': JSON.parse(JSON.stringify(appConfig.data.telegram || {})),
			'signals': JSON.parse(JSON.stringify(appConfig.data.signals || {})),
			'circuit_breaker': Object.assign({}, cbDefaults, appConfig.data.circuit_breaker || {})
		});

		// Outbound mailer (SMTP): surface the saved settings so the Configuration page shows the
		// current values. Without this the fields render blank and the next save overwrites the
		// stored host/user/from/enabled with empty values. Never send the encrypted password to
		// the browser — replace it with a truthy flag so the UI can show 'Password is set'
		// without exposing the blob (mirrors the cron_backup secret handling below).
		const mailerCfg = JSON.parse(JSON.stringify(appConfig.data.mailer || {}));
		mailerCfg['password'] = mailerCfg['password'] ? '1' : '';
		services['mailer'] = mailerCfg;

		// Granular notification preferences: the saved block (or null = "deliver everywhere as before"),
		// plus the event catalog and curated defaults so the config page can render the event × channel
		// matrix and seed a fresh form.
		services['notifications'] = appConfig.data.notifications || null;
		services['notifications_catalog'] = shareData.Common.notificationsCatalog();
		services['notifications_defaults'] = shareData.Common.notificationsDefaults();

		// The 3CQS signals key is encrypted at rest and write-only — never send it to the page.
		// Blank it and expose a has_key flag (mirrors the mailer / SFTP / AI secret handling).
		if (services['signals'] && services['signals']['3CQS']) {
			services['signals']['3CQS']['has_key'] = !!services['signals']['3CQS']['api_key'];
			services['signals']['3CQS']['api_key'] = '';
		}

		// The Telegram bot token is a live credential, encrypted at rest and write-only — never send it to
		// the page (it would otherwise render into the DOM on every config load). Blank it and expose a
		// has_token flag; a blank field on save preserves the stored token.
		if (services['telegram']) {
			services['telegram']['has_token'] = !!services['telegram']['token_id'];
			services['telegram']['token_id'] = '';
		}

		// These backup secrets are encrypted at rest and write-only. Never send them to the browser —
		// not the encrypted blob and not a decrypted/base64 copy. Blank each and expose only a *_set flag
		// so the UI can show 'is set' without exposing the value. A blank field on save preserves the
		// stored value (the save path falls back to the existing encrypted value), exactly as the SFTP
		// private key and the SMTP/AI/3CQS secrets are handled — so these plaintext secrets never leave
		// the server, where any XSS on this authenticated page could otherwise read them from the DOM.
		const cronBackupPasswordSet = !!services['cron_backup']['password'];
		services['cron_backup']['password'] = '';
		services['cron_backup']['password_set'] = cronBackupPasswordSet;

		const sftpPasswordSet = !!services['cron_backup']['sftp']['password'];
		services['cron_backup']['sftp']['password'] = '';
		services['cron_backup']['sftp']['password_set'] = sftpPasswordSet;

		const sftpPassphraseSet = !!services['cron_backup']['sftp']['passphrase'];
		services['cron_backup']['sftp']['passphrase'] = '';
		services['cron_backup']['sftp']['passphrase_set'] = sftpPassphraseSet;

		const sftpPrivateKeySet = !!services['cron_backup']['sftp']['private_key'];
		services['cron_backup']['sftp']['private_key'] = '';
		services['cron_backup']['sftp']['private_key_set'] = sftpPrivateKeySet;

		res.render( 'configView', { 'appData': shareData.appData, 'token': tokenBase64, 'services': services } );
	}
	else {

		denyUnauthorized(req, res);
	}
}


async function processWebHook(req, res, next) {

	let reqPath = req.path;

	let errorObj = {};

	// Strip ONLY the leading /webhook prefix — a global replace would corrupt a path parameter
	// (bot/deal id) that happened to contain the substring "webhook".
	reqPath = reqPath.replace(/^\/webhook/, '');

	if (!shareData.appData.webhook_enabled) {

		errorObj['error'] = 'Webhooks are disabled';

		res.status(403).send(errorObj);

		return;
	}

	// The webhook credential may be presented in a header (preferred — a header-capable sender
	// such as the Signal Bot tool never exposes it in a loggable body) OR in the JSON body as
	// `apiToken` (required for TradingView and similar senders, which cannot set custom headers).
	// Header is checked first, body second. The value may be EITHER the legacy per-instance
	// webhook token (derived from the instance API key — unchanged, so existing signal setups
	// keep working on upgrade) OR a scoped API key (symb_live_…). Accepting a scoped key lets
	// webhook credentials be added, scoped and revoked exactly like API keys. A scoped key is
	// held to the same capability the target action requires (a signal maps to deal.create),
	// enforced here because the webhook re-dispatches internally and so bypasses the app-level
	// route guard.
	let authed = false;

	try {

		const presented = req.headers['api-token'] || req.headers['api-key'] || (req.body && req.body['apiToken']) || '';

		if (req.body && req.body['apiToken'] != undefined) { delete req.body['apiToken']; }

		if (presented !== '' && shareData.Common.safeEqual(presented, shareData.appData.api_token)) {

			// Legacy single webhook token: resolve it to the deal-scoped webhook principal (the SAME
			// principal the direct-API header path mints via attachPrincipal), so the capability check below
			// enforces WEBHOOK_CAPS (deal actions only) on the webhook passthrough too. Previously this branch
			// granted full unchecked access, so a leaked token could reach bot-management / config routes
			// through the internal re-dispatch — the exact gap the scoped WEBHOOK_CAPS is meant to close.
			req.headers['api-token'] = presented;

			if (!req.principal && shareData.Authz && typeof shareData.Authz.webhookPrincipal === 'function') {

				req.principal = shareData.Authz.webhookPrincipal();
			}

			// Degraded-state fallback: if the authz layer is somehow unavailable to mint/scope the token
			// (a fundamentally broken boot — in which case trading isn't running either), keep the valid
			// legacy token working rather than 401 every webhook. Signals must not break; the capability
			// scoping below is the normal path.
			if (!req.principal) { authed = true; }
		}
		else if (!req.principal && presented !== '' && shareData.ApiKeys && typeof shareData.ApiKeys.resolve === 'function') {

			// A scoped API key may arrive in the body (`presented`), in a header, or as an
			// Authorization: Bearer that the app-level attachPrincipal already resolved into req.principal.
			// Resolve the body/header value if no principal is attached yet.
			const principal = await shareData.ApiKeys.resolve(presented, { 'ip': shareData.Common.getClientIp(req) });

			if (principal) { req.principal = principal; }
		}

		// Deny-by-default: ANY resolved principal — the legacy webhook token (now deal-scoped) OR a scoped
		// key, from any channel — must satisfy the capability the target action requires. Enforced HERE
		// because the webhook re-dispatches internally (req.url rewrite + next()) and so never re-enters the
		// app-level route guard. Fail CLOSED on an unmapped path, mirroring the app-level default-deny for
		// mutating routes: a principal is admitted only when the target action maps to a capability it
		// actually holds — never merely because no capability was found for the path. Legitimate webhook
		// signals (deal start / add-funds / pause / close) all map to deal.* caps the webhook token holds.
		if (req.principal) {

			const capability = (shareData.RoutePermissions && typeof shareData.RoutePermissions.required === 'function')
				? shareData.RoutePermissions.required(req.method, reqPath)
				: null;

			if (capability && shareData.Authz && shareData.Authz.can(req.principal, capability)) {

				authed = true;
			}
			else {

				if (shareData.Audit && typeof shareData.Audit.audit === 'function') {

					shareData.Common.auditEvent(req, 'authz.deny', reqPath, capability || '(unmapped)');
				}

				errorObj['error'] = capability ? 'Insufficient scope for webhook action' : 'Webhook action not permitted';

				res.status(403).send(errorObj);

				return;
			}
		}
	}
	catch(e) {}

	// Accept only a browser session (owner) or a credential that passed the checks above. The
	// terminal check deliberately does NOT call validApiKey(), which would admit any resolved
	// principal without the capability gate applied just above.
	if (req.session.loggedIn || authed) {

		// Best-effort Signal Activity recording (read-only, fully isolated). metaFromRequest returns null
		// for any path that is not a recognized Signal Bot command, so only genuine signals are logged, and
		// only after this request has authenticated. Everything here is guarded so a recording failure can
		// never delay, alter, or break the signal's response or the trade it triggers.
		let signalMeta = null;

		try {

			if (shareData.SignalActivity && typeof shareData.SignalActivity.metaFromRequest === 'function') {

				signalMeta = shareData.SignalActivity.metaFromRequest(req, reqPath);
			}
		}
		catch (e) {}

		// Opt-in idempotency: a repeated Idempotency-Key / idempotency_key / signal_id within the
		// TTL is a duplicate signal — acknowledge it WITHOUT re-processing, so a retried alert
		// cannot open or fund a deal twice.
		const idem = webhookIdempotency(reqPath, req.body, req.headers);

		if (idem.duplicate) {

			const dupBody = { 'date': new Date(), 'success': true, 'duplicate': true, 'data': 'Duplicate signal ignored (idempotency).' };

			if (signalMeta) { try { shareData.SignalActivity.recordFromResponse(signalMeta, dupBody, 200); } catch (e) {} }

			res.status(200).send(dupBody);
			return;
		}

		// Capture the downstream outcome for the activity log without altering it: wrap res.send once so
		// the recorded row reflects exactly what the action handler returned. One-shot and guarded.
		if (signalMeta) {

			try {

				const origSend = res.send.bind(res);

				res.send = function (body) {

					res.send = origSend;   // restore immediately (one-shot; defensive against double calls)

					try { shareData.SignalActivity.recordFromResponse(signalMeta, body, res.statusCode); } catch (e) {}

					return origSend(body);
				};
			}
			catch (e) {}
		}

		req.url = reqPath;
		next();
	}
	else {

		errorObj['error'] = 'Invalid Token';

		res.status(401).send(errorObj);
	}
}


async function processWebSocketApi(client, data, inflightMap) {

	routesWebSocket.api(client, data, inflightMap);
}


function isLoggedIn(req, res) {

	if (!req.session.loggedIn) {

		denyUnauthorized(req, res);
		return false;
	}

	return true;
}


// Is this request authenticated as EITHER a logged-in browser session OR a resolved API key / accepted
// webhook token (validApiKey also fires the invalid-credential intrusion notice, so the check keeps that
// side effect). The one place the instance's data/API routes decide "may this caller in at all" —
// authentication only; per-capability authorization is enforced separately by the cap() guards.
function isAuthenticated(req) {

	return req.session.loggedIn || validApiKey(req);
}


// Capability guard for the authorization system: require that req.principal holds a
// capability (deny-by-default; JSON 401/403 for the API path, redirect for a browser).
// Resolved at request time so it's safe regardless of module init order; before the auth
// subsystem is wired it falls back to the legacy logged-in check. Single exit.
function cap(capability, resourceIdFn) {

	// Shared factory (routeUtils.capGuard); the instance's pre-wiring fallback uses isLoggedIn,
	// which redirects a browser to /login when not authenticated.
	return capGuard(shareData, capability, {
		resourceIdFn: resourceIdFn,
		fallback: (req, res, next) => { if (isLoggedIn(req, res)) { next(); } }
	});
}


function validApiKey(req) {

	// The auth middleware (attachPrincipal) already resolved a session or API key — the legacy
	// single key AND new scoped keys — into req.principal before the route runs. Any resolved
	// principal is API-authenticated. The webhook api-token stays a separate accepted
	// credential (it is not resolved into a principal). An api-key that produced no principal
	// was invalid, so the intrusion notification below still fires.
	if (req.principal) { return true; }

	let success = false;
	let apiKeyInvalid = false;
	let apiTokenInvalid = false;

	const headers = req.headers;

	const apiKey = headers['api-key'];
	const apiToken = headers['api-token'];

	if (apiKey != undefined && apiKey != null && apiKey != '') {

		if (shareData.appData.api_enabled) {

			apiKeyInvalid = true;   // present but did not resolve to a principal → invalid
		}
	}
	else if (apiToken != undefined && apiToken != null && apiToken != '') {

		if (shareData.appData.webhook_enabled) {

			if (shareData.Common.safeEqual(apiToken, shareData.appData.api_token)) {

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
	webhookIdempotency,

	init: function(obj) {

		shareData = obj;
    }
}