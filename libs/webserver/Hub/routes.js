'use strict';

const { sendErr, redirectNotFound, denyUnauthorized, capGuard } = require(__dirname + '/../routeUtils.js');

// Shared Signal Bot alert generator — the SAME pure module the single-instance editor uses, so the
// Hub's native bot editor produces identical copy-paste webhook cards (one source of truth). It needs
// only a botId; URLs stay relative paths and the browser prepends the live origin (see botEditView).
const SignalBot = require(__dirname + '/../../strategies/DCABot/signalBot.js');

const path = require('path');
const fs = require('fs');

// The learning corpus's PURE aggregation + accuracy-verification engine, reused verbatim from the instance
// side (no store/init on the Hub — the Hub passes its own pooled patterns as opts.current). AITools is a pure
// module (query-builders + shipped JSON, no DB at load), required only for the tool whitelist that validates a
// contributed pack's tool names, exactly as the instance route does.
const aiMemory = require(__dirname + '/../../ai/AIMemory.js');
const aiTools  = require(__dirname + '/../../ai/AITools.js');
const learningAgg = require(__dirname + '/../learningAggregation.js');   // SAME orchestrator the instance uses

// The Hub's effective corpus for accuracy/aggregation = the shipped STARTER SET (which every instance already
// has, seeded locally on first use, but which is never relayed into the Hub pool) PLUS the Hub's pooled learned
// patterns. Measuring against the pool alone would read 0% on an empty pool and would over-credit a contributed
// pack for questions the starter set already covers. previewAggregate de-dupes the union by pattern key.
const HUB_SEED_RECORDS = (() => { try { return require(__dirname + '/../../ai/data/seed-learning.json').records || []; } catch (e) { return []; } })();
function hubCorpus() { return HUB_SEED_RECORDS.concat(shareData.HubStore.listLearningPatterns()); }

// The Hub itself does not run trading and only knows the tool registry of its OWN process; the instances it
// oversees are what actually route AI questions. Each instance reports its AI-tool names on startup (relayed to
// the Hub's workerMap), so the Hub validates contributed learning packs against the UNION of tools the live fleet
// really has — a pack referencing a tool no instance supports is caught here rather than adopted into the pool.
//   • fleetTools()     → { valid:Set<name>, coverage:{ name → instanceCount }, instances:number, reported:number }
//   • The Hub's own registry is the fallback when no instance has reported yet (fresh Hub, nothing connected).
function fleetTools() {

	const coverage = Object.create(null);
	let instances = 0, reported = 0;

	try {
		for (const entry of (shareData.workerMap ? shareData.workerMap.values() : [])) {
			instances++;
			if (!entry || !Array.isArray(entry.tools)) { continue; }
			reported++;
			for (const name of entry.tools) { coverage[name] = (coverage[name] || 0) + 1; }
		}
	}
	catch (e) { /* best-effort — fall back to the Hub's own registry below */ }

	const valid = reported ? new Set(Object.keys(coverage)) : new Set((aiTools.TOOLS || []).map(t => t.name));
	return { valid, coverage, instances, reported };
}

let shareData;


// Capability guard (deny-by-default via the shared AuthMiddleware; falls back to the session
// check before the auth subsystem is wired). Declared at module scope (hoisted) so every route
// in initRoutes can use it, including those defined before the Access Control block.
function cap(capability) {
	// Shared factory (routeUtils.capGuard); before AuthMiddleware is attached, the pre-wiring fallback
	// denies via the shared denyUnauthorized — 401 JSON for an API/XHR caller, a login redirect for a
	// plain browser navigation — matching the instance side.
	return capGuard(shareData, capability, {
		fallback: (req, res, next) => { if (req.session.loggedIn) { next(); } else { denyUnauthorized(req, res); } }
	});
}


// Capability required per sub-action for the Hub's multiplexed action routes. The Hub's
// /bots/action and /deals/action endpoints each dispatch many distinct operations to an
// instance's Worker; gating the whole endpoint on one coarse capability let a narrowly-scoped
// key perform operations the instance itself gates far more tightly (e.g. a `bot.write` key
// deleting bots or opening deals across every instance). These maps are derived from the single
// canonical ACTION_CAPS table in RoutePermissions (the same module that gates the instance's HTTP
// routes) rather than hand-copied, so the Hub and instance can never diverge — and its
// auditActionCaps() cross-checks each write action against the instance's own route rule.
const RoutePermissions = require(__dirname + '/../../app/RoutePermissions.js');
const HUB_BOT_ACTION_CAPS  = RoutePermissions.ACTION_CAPS.bot;
const HUB_DEAL_ACTION_CAPS = RoutePermissions.ACTION_CAPS.deal;

// Like cap(), but the required capability is chosen from the request's `action` field. Unknown
// actions fall back to `defaultCap` (the strict coarse capability), so a new sub-action can never
// be reachable by an under-scoped key by accident. Delegates to the same requireCap() as cap(),
// so the owner/principal semantics are identical.
function capAction(actionCaps, defaultCap) {
	// Same shared factory, but the required capability is chosen per-request from req.body.action;
	// unknown actions fall back to the strict defaultCap. defaultCap is the audit-coverage tag.
	return capGuard(shareData, (req) => {
		const action = req.body && req.body.action;
		return (action && Object.prototype.hasOwnProperty.call(actionCaps, action)) ? actionCaps[action] : defaultCap;
	}, {
		tag: defaultCap,
		fallback: (req, res, next) => { if (req.session.loggedIn) { next(); } else { denyUnauthorized(req, res); } }
	});
}


// True when the caller is authenticated as EITHER a logged-in browser session OR a resolved API-key
// principal. Hub data/action handlers historically checked only `req.session.loggedIn`, which rejected a
// scoped API key that the cap()/capAction() gate in front had already admitted — so the same capability
// worked on an instance's API but not the Hub's. Using this restores that parity. Only use it on routes
// that ALSO carry a cap()/capAction() guard (or an inline capability check); the guard enforces the actual
// capability, and this just stops the inner check from throwing the key away. Page routes that render the
// browser UI intentionally stay session-only.
function authed(req) { return !!(req.session && req.session.loggedIn) || !!req.principal; }


function initRoutes(router) {

	router.get('/', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			res.render('Hub/homeView', { 'isHub': true, 'appData': shareData.appData, 'getCurrencySymbol': shareData.Common.getCurrencySymbol.toString() });
		}
		else {

			denyUnauthorized(req, res);
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

		// Audit the logout before the session is torn down, so the actor still resolves.
		shareData.Common.auditEvent(req, 'auth.logout', '', '');

		req.session.destroy((err) => {});

		res.redirect('/login');
	});


	router.get('/manage', cap('settings.write'), async (req, res) => {

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

			denyUnauthorized(req, res);
		}
	});


	router.post('/update_instances', cap('instance.manage'), async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (authed(req)) {

			shareData.Common.auditEvent(req, 'instance.update', '', 'update instances');
			Promise.resolve(shareData.Hub.routeUpdateInstances(req, res)).catch((e) => {
				shareData.Common.logger('routeUpdateInstances failed: ' + (e && e.message));
				try { if (!res.headersSent) { res.status(500).json({ success: false, error: 'Failed to update instances.' }); } } catch (_) {}
			});
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post('/add_instance', cap('instance.manage'), async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (authed(req)) {

			shareData.Common.auditEvent(req, 'instance.add', (req.body && (req.body.name || req.body.instance_name)) || '', 'add instance');
			Promise.resolve(shareData.Hub.routeAddInstance(req, res)).catch((e) => {
				shareData.Common.logger('routeAddInstance failed: ' + (e && e.message));
				try { if (!res.headersSent) { res.status(500).json({ success: false, error: 'Failed to add instance.' }); } } catch (_) {}
			});
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post('/start_instance', cap('instance.manage'), async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (authed(req)) {

			shareData.Common.auditEvent(req, 'instance.start', (req.body && (req.body.name || req.body.id || req.body.appId || req.body.port)) || '', 'start/stop instance');
			shareData.Hub.routeStartWorker(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.post('/remove_instance', cap('instance.manage'), async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (authed(req)) {

			shareData.Common.auditEvent(req, 'instance.remove', (req.body && (req.body.name || req.body.id || req.body.appId || req.body.port)) || '', 'remove instance');
			await shareData.Hub.routeRemoveInstance(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get('/news', (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			shareData.Hub.routeShowNews(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get('/config', (req, res) => {

		res.set('Cache-Control', 'no-store');

		// Only expose the Hub's SMTP settings to a logged-in session (never the password —
		// just a flag that one is set). The password value is never rendered into the form.
		const m = (req.session.loggedIn && shareData.appData && shareData.appData.mailer) || {};

		const mailer = {
			'enabled': m.enabled === true,
			'host': m.host || '',
			'port': m.port || 587,
			'secure': m.secure === true,
			'user': m.user || '',
			'from': m.from || '',
			'password_set': !!m.password
		};

		res.render( 'Hub/configView', { 'isHub': true, 'appData': shareData.appData, 'mailer': mailer } );
	});


	// ── Hub Access Control: users, API keys, audit (SQLite-backed via HubStore) ──────

	router.get('/access', (req, res) => {
		res.set('Cache-Control', 'no-store');
		if (req.session.loggedIn) { res.render('accessView', { 'isHub': true, 'appData': shareData.appData }); }
		else { denyUnauthorized(req, res); }
	});

	router.get('/api/keys', cap('apikey.read'), (req, res) => {
		try { res.status(200).json({ 'success': true, 'keys': shareData.HubStore.listKeys() }); }
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/keys', cap('apikey.create'), (req, res) => {
		try {
			const b = req.body || {};
			const r = shareData.HubStore.createKey({ name: b.name, capabilities: Array.isArray(b.capabilities) ? b.capabilities : [], signing: b.signing, expiresAt: b.expires_at, ownerUserId: req.principal && req.principal.id, ownerCapabilities: (req.principal && req.principal.capabilities) || [] });
			if (r.success) { shareData.Common.auditEvent(req, 'apikey.create', r.key.prefix, r.key.name); }
			res.status(200).json(r);
		}
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/keys/:id/status', cap('apikey.revoke'), (req, res) => {
		try {
			const st = (req.body && req.body.status) || 'revoked';
			const r = shareData.HubStore.setKeyStatus(req.params.id, st);
			if (r.success) { shareData.Common.auditEvent(req, st === 'revoked' ? 'apikey.revoke' : 'apikey.status', req.params.id, st); }
			res.status(200).json(r);
		}
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/keys/:id/rotate', cap('apikey.create'), (req, res) => {
		try {
			const r = shareData.HubStore.rotateKey(req.params.id, { graceHours: req.body && req.body.grace_hours });
			if (r.success) { shareData.Common.auditEvent(req, 'apikey.rotate', req.params.id, 'grace ' + r.grace_hours + 'h → ' + (r.key && r.key.prefix)); }
			res.status(200).json(r);
		}
		catch (e) { sendErr(res, e); }
	});

	router.get('/api/users', cap('user.read'), (req, res) => {
		try { res.status(200).json({ 'success': true, 'users': shareData.HubStore.listUsers() }); }
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/users', cap('user.invite'), (req, res) => {
		try {
			const b = req.body || {};
			// Bound role/grants to the creator's authority (see the instance route) so a non-owner Hub user
			// cannot mint an owner or grant capabilities they lack. Owner ('*') is unaffected.
			const creatorCaps = (req.principal && Array.isArray(req.principal.capabilities))
				? req.principal.capabilities
				: ((req.session && req.session.loggedIn && !req.session.userId) ? [ '*' ] : []);
			const scoped = shareData.Authz.scopeNewUser(creatorCaps, { role: b.role, grants: b.grants });
			if (scoped.exceeded) { return res.status(403).json({ success: false, error: 'You cannot create a user more privileged than your own account.' }); }
			const r = shareData.HubStore.createUser({ username: b.username, password: b.password, role: scoped.role, grants: scoped.grants });
			if (r.success) { shareData.Common.auditEvent(req, 'user.create', r.user.username, r.user.role); }
			res.status(200).json(r);
		}
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/users/:id/role', cap('user.manage'), (req, res) => {
		try {
			const r = shareData.HubStore.setUserRole(req.params.id, (req.body && req.body.role));
			if (r.success) { shareData.Common.auditEvent(req, 'user.role', req.params.id, (req.body && req.body.role)); }
			res.status(200).json(r);
		}
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/users/:id/status', cap('user.manage'), (req, res) => {
		try {
			const st = (req.body && req.body.status) || 'active';
			const r = shareData.HubStore.setUserStatus(req.params.id, st);
			if (r.success) { shareData.Common.auditEvent(req, 'user.status', req.params.id, st); }
			res.status(200).json(r);
		}
		catch (e) { sendErr(res, e); }
	});

	router.get('/api/audit', cap('audit.read'), (req, res) => {
		try { res.status(200).json({ 'success': true, 'entries': shareData.HubStore.listAudit({ action: req.query.action, actor: req.query.actor, limit: req.query.limit }) }); }
		catch (e) { sendErr(res, e); }
	});

	router.get('/api/authz/capabilities', cap('apikey.read'), (req, res) => {
		res.status(200).json({ 'success': true, 'capabilities': shareData.Authz.CAPABILITIES, 'roles': shareData.Authz.ROLE_NAMES });
	});


	router.post('/config', cap('settings.write'), (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (authed(req)) {

			shareData.Hub.routeUpdateConfig(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	// Verify the Hub's SMTP settings (and send a test message) without saving. A blank
	// password falls back to the stored one, so saved settings can be tested. Never returns
	// the password. Mirrors the instance-side /api/mailer/test.
	router.post('/api/mailer/test', cap('settings.write'), async (req, res) => {

		if (!authed(req)) { return denyUnauthorized(req, res); }

		try { res.status(200).json(await shareData.Mailer.testFromRequest(req.body)); }
		catch (e) { sendErr(res, e); }
	});


	router.get([ '/logs', '/backups' ], cap('logs.read'), (req, res) => {

		res.set('Cache-Control', 'no-store');
	
		const type = req.path.replace('/', '');
	
		if (req.session.loggedIn) {

			shareData.Common.showFiles(type, req, res, true);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	router.get([ '/logs/download/:file', '/backups/download/:file' ], cap('logs.read'), (req, res) => {

		res.set('Cache-Control', 'no-store');
	
		if (req.session.loggedIn) {

			const fileName = req.params.file;
			const type = req.path.includes('/logs/') ? 'logs' : 'backups';

			// Hub is the aggregator — it may download any instance's file. The optional ?sid=<server_id>
			// resolves to the EXACT instance folder (so same-named files across instances stay distinct);
			// downloadFile still rejects traversal in both the filename and the server_id.
			shareData.Common.downloadFile(fileName, type, req, res, true, req.query.sid);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	// ── Hub control-plane database (SQLite) backup / restore ──────────────────────
	// These act on the Hub's OWN users/keys/audit database (data/hub/hub.db), which is separate
	// from the instance database backups listed on the same page. Gated behind settings.write
	// because a Hub backup contains password/key hashes.
	router.post('/api/hub/backup', cap('settings.write'), (req, res) => {
		try {
			const file = shareData.HubStore.backup();
			if (file) { shareData.Common.auditEvent(req, 'hub.backup', path.basename(file), ''); }
			res.status(200).json({ 'success': !!file, 'file': file ? path.basename(file) : null });
		}
		catch (e) { sendErr(res, e); }
	});

	router.post('/api/hub/restore', cap('settings.write'), (req, res) => {
		try {
			const fileName = (req.body && req.body.file) || '';
			const r = shareData.HubStore.restore(fileName);
			if (r.success) { shareData.Common.auditEvent(req, 'hub.restore', path.basename(String(fileName)), ''); }
			res.status(200).json(r);
		}
		catch (e) { sendErr(res, e); }
	});

	router.get('/backups/hub/download/:file', cap('settings.write'), (req, res) => {
		res.set('Cache-Control', 'no-store');
		try {
			const base = path.basename(String(req.params.file || ''));
			if (!/^hub-\d+\.db$/.test(base)) { return res.status(400).send('Invalid file'); }
			const dir = shareData.HubStore.backupDir();
			const file = dir ? path.join(dir, base) : null;
			if (!file || !fs.existsSync(file)) { return res.status(404).send('Not found'); }
			res.download(file, base);
		}
		catch (e) { res.status(500).send('Error'); }
	});


	// ── TradingView chart — served directly by Hub (no instance proxy needed) ──
	router.get('/api/tradingview', cap('stats.read'), (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (authed(req)) {

			shareData.Common.showTradingView(req, res);
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	// Read-only OHLC candles for the per-deal chart (public market data via MarketData's own keyless
	// ccxt clients — never the trading path). Same endpoint the instance serves, so the shared chart
	// component works identically here. Best-effort: failures return a structured payload.
	router.get('/api/markets/ohlcv', cap('stats.read'), async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (!authed(req)) {

			return denyUnauthorized(req, res);
		}

		try {

			const out = await shareData.MarketData.getOhlc({
				'exchange':    req.query.exchange,
				'pair':        req.query.pair,
				'timeframe':   req.query.timeframe,
				'defaultType': req.query.type,
				'since':       req.query.since,
				'limit':       req.query.limit
			});

			res.status(200).json(out);
		}
		catch (e) {

			res.status(200).json({ 'success': false, 'available': false, 'candles': [], 'timeframes': [], 'error': (e && e.message) ? e.message : 'market data unavailable' });
		}
	});


	// ── Hub unified deals view ──────────────────────────────────────────────
	router.get('/deals', async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			res.render('Hub/dealsView', { 'isHub': true, 'appData': shareData.appData, 'convertBoolean': shareData.Common.convertBoolean.toString(), 'getCurrencySymbol': shareData.Common.getCurrencySymbol.toString() });
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	// ── Hub unified bots view ────────────────────────────────────────────────
	router.get('/bots', async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (req.session.loggedIn) {

			res.render('Hub/botsView', { 'isHub': true, 'appData': shareData.appData, 'convertBoolean': shareData.Common.convertBoolean.toString(), 'getCurrencySymbol': shareData.Common.getCurrencySymbol.toString() });
		}
		else {

			denyUnauthorized(req, res);
		}
	});


	// ── Hub bot create/edit page ──────────────────────────────────────────────
	router.get('/bots/:instanceId/create', async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (!req.session.loggedIn) return denyUnauthorized(req, res);

		// Defensive: getCreateBotData is async (reaches the instance for its bot template/symbols). If it
		// ever rejects, fall back to the bots list — the same graceful path a non-success result already
		// takes — instead of leaking an unhandled rejection. This only affects the FORM page's error
		// handling; it never touches trading behavior.
		try {

			const result = await shareData.Hub.getCreateBotData(req.params.instanceId);

			if (!result || !result.success) return res.redirect('/hub/bots');

			res.render('Hub/botEditView', {
				'isHub':                    true,
				'appData':                  shareData.appData,
				'instanceId':               req.params.instanceId,
				'instanceName':             result.instanceName,
				'botData':                  result.botData,
				'botUpdate':                false,
				'symbols':                  result.symbols,
				'scData':                   result.scData,
				'startConditionString':     result.startConditionString,
				'startConditionSubString':  result.startConditionSubString,
				'symbolString':             result.symbolString,
				'activeChecked':            result.activeChecked,
				// Signal Bot panel (shared partial). No botId yet on create, so no alerts —
				// the panel invites the user to save the bot and reopen it, at which point the
				// update route builds the copy-paste cards (same as a single instance).
				'signalAlerts':             null,
				'isSignalBot':              result.isSignalBot,
				'apiToken':                 '',
				'webhookEnabled':           true,
				'getCurrencySymbol': shareData.Common.getCurrencySymbol.toString()
			});
		}
		catch (e) {

			shareData.Common.logger('Hub create-bot page error: ' + ((e && e.message) ? e.message : e));
			if (!res.headersSent) { return res.redirect('/hub/bots'); }
		}
	});


	router.get('/bots/:instanceId/:botId', async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (!req.session.loggedIn) return denyUnauthorized(req, res);

		const { instanceId, botId } = req.params;

		// Defensive: getBotEditData is async (reaches the instance) and the alert-card build below can throw
		// on unexpected data. If anything rejects, fall back to the bots list — the same graceful path a
		// non-success result already takes — instead of leaking an unhandled rejection. FORM-page error
		// handling only; never touches trading behavior.
		try {

			const result = await shareData.Hub.getBotEditData(instanceId, botId);

			if (!result || !result.success) return res.redirect('/hub/bots');

			// Signal Bot panel (shared partial). Build the copy-paste alerts with the same generator the
			// single-instance editor uses so the Hub shows identical cards. The webhook must reach the
			// instance, so URLs route through the Hub's /instance/<port> reverse proxy: the server injects
			// that path prefix and the browser prepends whatever origin the operator reached the Hub on
			// (custom domain / HTTPS / reverse proxy all handled client-side). The token stays a placeholder
			// — the Hub never holds the instance's API token.
			const editBotId    = (result.botData && result.botData.botId) || botId;
			const signalAlerts = editBotId
				? SignalBot.buildSignalAlerts({
					'botId':          editBotId,
					'addFundsVolume': Number(result.botData && result.botData.dcaOrderAmount) || undefined
				})
				: null;
			const webhookUrlPrefix = result.webPort ? '/instance/' + result.webPort : '';

			res.render('Hub/botEditView', {
				'isHub':                    true,
				'appData':                  shareData.appData,
				'instanceId':               instanceId,
				'instanceName':             result.instanceName,
				'botData':                  result.botData,
				'botUpdate':                true,
				'symbols':                  result.symbols,
				'scData':                   result.scData,
				'startConditionString':     result.startConditionString,
				'startConditionSubString':  result.startConditionSubString,
				'symbolString':             result.symbolString,
				'activeChecked':            result.activeChecked,
				'signalAlerts':             signalAlerts,
				'webhookUrlPrefix':         webhookUrlPrefix,
				'isSignalBot':              result.isSignalBot,
				'apiToken':                 '',
				'webhookEnabled':           true,
				'getCurrencySymbol': shareData.Common.getCurrencySymbol.toString()
			});
		}
		catch (e) {

			shareData.Common.logger('Hub edit-bot page error: ' + ((e && e.message) ? e.message : e));
			if (!res.headersSent) { return res.redirect('/hub/bots'); }
		}
	});


	// ── Hub JSON API — deals (aggregated across all instances) ───────────────
	router.get('/api/hub/deals', cap('deal.read'), async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (!authed(req)) {

			return denyUnauthorized(req, res);
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
	router.get('/api/hub/bots', cap('bot.read'), async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (!authed(req)) {

			return denyUnauthorized(req, res);
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



	// ── Hub JSON API — dashboard (aggregated stats across all instances) ──────
	router.get('/api/hub/dashboard', cap('stats.read'), async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (!authed(req)) {

			return denyUnauthorized(req, res);
		}

		try {

			const { instances, totals } = await shareData.Hub.getDashboardData();

			res.json({ 'success': true, 'instances': instances, 'totals': totals });
		}
		catch (err) {

			res.json({ 'success': false, 'data': err.message });
		}
	});


	// ── Hub JSON API — bot actions (routed to correct instance) ──────────────
	router.post('/api/hub/bots/action', capAction(HUB_BOT_ACTION_CAPS, 'bot.write'), async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (!authed(req)) {

			return denyUnauthorized(req, res);
		}

		try {

			const { instanceId, action, botId, data } = req.body;

			if (!instanceId || !action) {

				return res.json({ 'success': false, 'data': 'instanceId and action are required' });
			}

			const result = await shareData.Hub.performBotAction(instanceId, action, botId, data || {});

			res.json(result);
		}
		catch (err) {

			res.json({ 'success': false, 'data': err.message });
		}
	});


	// ── Hub JSON API — deal actions (routed to correct instance) ─────────────
	router.post('/api/hub/deals/:dealId/action', capAction(HUB_DEAL_ACTION_CAPS, 'deal.close'), async (req, res) => {

		res.set('Cache-Control', 'no-store');

		if (!authed(req)) {

			return denyUnauthorized(req, res);
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



	// ── AI Learning corpus: aggregate contributed packs + verify accuracy (Hub maintainer tooling) ──────
	// Mirrors the instance endpoints (libs/webserver/routes.js) but retargets the corpus from the AIMemory
	// store to the Hub's pooled patterns (HubStore). Same pure engine (aiMemory.previewAggregate), so the
	// aggregation logic, conflict handling, and held-out accuracy measurement are identical on both surfaces.
	router.post('/api/hub/learning/aggregate', cap('settings.write'), async (req, res) => {

		if (!authed(req)) { return denyUnauthorized(req, res); }

		try {
			// The Hub corpus is HubStore, not the AIMemory store: aggregate against the pooled patterns, and on
			// commit write winners there directly (importPack is a no-op on the Hub) then broadcast immediately.
			// Validate against the tools the live fleet actually reports, not just the Hub process's own registry.
			const fleet = fleetTools();
			const out = await learningAgg.aggregateResponse(aiMemory, aiTools, req.body, {
				current: hubCorpus(),
				validTools: fleet.valid,
				adopt: (recs) => {
					let n = 0;
					for (const r of recs) { if (shareData.HubStore.addLearningPattern(r, aiMemory.packKey(r))) { n++; } }
					if (n && shareData.HubMain && typeof shareData.HubMain.broadcastLearningPack === 'function') { shareData.HubMain.broadcastLearningPack(); }
					return n;
				}
			});
			if (out.error) { return sendErr(res, out.error, 200); }
			// Surface fleet tool coverage so a maintainer sees the aggregation was validated against real instances
			// (and how many support each referenced tool), instead of trusting the Hub's own registry silently.
			out.fleet = { instances: fleet.instances, reported: fleet.reported, tool_coverage: fleet.coverage };
			if (out.imported) { shareData.Common.auditEvent(req, 'hub.learning_aggregate', String(out.imported), out.report.contributors + ' contributors'); }
			res.status(200).json(out);
		}
		catch (e) { sendErr(res, e); }
	});

	// Measure the current Hub corpus against the held-out eval set — "how accurate is the pooled corpus now".
	router.get('/api/hub/learning/evaluate', cap('stats.read'), async (req, res) => {

		res.set('Cache-Control', 'no-store');
		if (!authed(req)) { return denyUnauthorized(req, res); }

		try {
			const fleet = fleetTools();
			const out = await learningAgg.evaluateResponse(aiMemory, aiTools, { current: hubCorpus(), validTools: fleet.valid });
			out.fleet = { instances: fleet.instances, reported: fleet.reported, tool_coverage: fleet.coverage };
			res.status(200).json(out);
		}
		catch (e) { sendErr(res, e); }
	});


	router.all('*wildcard', (req, res) => {

		redirectNotFound(res);
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

