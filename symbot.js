'use strict';


/*

	SymBot
	Copyright © 2023 - 2026 3CQS.com All Rights Reserved
	Licensed under Creative Commons Attribution-NonCommerical-ShareAlike 4.0 International (CC BY-NC-SA 4.0)

*/


// ── Early startup guards (shared with symbot-hub.js so they can't drift) ─────────────────────────
// Enforce package.json's minimum Node.js version, then prefer IPv4 for outbound DNS (resilient to flaky VPS
// IPv6). Both MUST run before any network-using require below so mongoose/ccxt/undici inherit the DNS order
// and an unsupported runtime is caught first. Full rationale lives in libs/app/Bootstrap.js.
const Bootstrap = require(__dirname + '/libs/app/Bootstrap.js');
Bootstrap.enforceNodeVersion(__dirname, 'SymBot');
Bootstrap.preferDnsOrder();


const DB = require(__dirname + '/libs/mongodb');
const ServerDB  = require(__dirname + '/libs/mongodb/ServerSchema');
const AIChatDB  = require(__dirname + '/libs/mongodb/AIChatSchema');
const DCABot = require(__dirname + '/libs/strategies/DCABot/DCABot.js');
const DCABotManager = require(__dirname + '/libs/strategies/DCABot/DCABotManager.js');
const SignalBot = require(__dirname + '/libs/strategies/DCABot/signalBot.js');
const TradingSignals = require(__dirname + '/libs/signals/TradingSignals.js');
const Signals3CQS = require(__dirname + '/libs/signals/3CQS/3cqs-signals-client.js');
const Common = require(__dirname + '/libs/app/Common.js');
const Queue = require(__dirname + '/libs/app/Queue.js');
const System = require(__dirname + '/libs/app/System.js');
const MarketData = require(__dirname + '/libs/app/MarketData.js');
const Telegram = require(__dirname + '/libs/telegram');
const WebServer = require(__dirname + '/libs/webserver');
const AIClient = require(__dirname + '/libs/ai/AIClient.js');
const AIScheduleHandler = require(__dirname + '/libs/scheduledtasks/AIScheduleHandler.js');
const ErrorWatchdogHandler = require(__dirname + '/libs/scheduledtasks/ErrorWatchdogHandler.js');
const DrawdownSentinelHandler = require(__dirname + '/libs/scheduledtasks/DrawdownSentinelHandler.js');
const ResourceSentinelHandler = require(__dirname + '/libs/scheduledtasks/ResourceSentinelHandler.js');
const ScheduleRecipes = require(__dirname + '/libs/app/ScheduleRecipes.js');
const AIContext = require(__dirname + '/libs/ai/AIContext.js');
const Scheduler = require(__dirname + '/libs/app/Scheduler.js');
const ScheduleNotifier = require(__dirname + '/libs/app/ScheduleNotifier.js');
const Mailer = require(__dirname + '/libs/app/Mailer.js');
const Authz = require(__dirname + '/libs/app/Authz.js');
const ApiKeys = require(__dirname + '/libs/app/ApiKeys.js');
const Users = require(__dirname + '/libs/app/Users.js');
const Audit = require(__dirname + '/libs/app/Audit.js');
const AuthMiddleware = require(__dirname + '/libs/app/AuthMiddleware.js');
const RoutePermissions = require(__dirname + '/libs/app/RoutePermissions.js');
const Watchdog = require(__dirname + '/libs/app/Watchdog.js');
const Diagnostics = require(__dirname + '/libs/app/Diagnostics.js');
const SignalActivity = require(__dirname + '/libs/app/SignalActivity.js');
const packageJson = require(__dirname + '/package.json');
const Dependencies = require('check-dependencies').sync({ verbose: false });



let workerData;
let parentPortReference;
let appDataConfig;
let gotSigInt = false;
let shutdownTimeout = 2000;


// Read a `--name value` or `--name=value` command-line argument, or null if absent. SymBot is
// parameterized via command-line arguments (never environment variables).
function getCliArg(name) {

	const argv = process.argv;

	for (let i = 2; i < argv.length; i++) {

		if (argv[i] === '--' + name && argv[i + 1] != undefined) { return argv[i + 1]; }
		if (argv[i].indexOf('--' + name + '=') === 0) { return argv[i].slice(('--' + name + '=').length); }
	}

	return null;
}


// Graceful shutdown + the trading-inviolable uncaughtException/unhandledRejection handlers (log and keep
// running), shared with symbot-hub.js via Bootstrap so the two can't drift. See libs/app/Bootstrap.js.
Bootstrap.installProcessGuards(shutDown, function (m) { Common.logger(m, true); });



async function init() {

	let apiKey;
	let apiKeySet;
	let apiKeyClear;
	let instanceName = '';

	let workerDataObj = {};
	let botConfigData = {};

	let isConfig = false;
	let isReset = false;
	let resetServerId = false;
	let resetSessions = false;
	let resetAiChats  = false;
	let resetUsers    = false;
	let resetApiKeys  = false;
	let resetPassword = false;
	let resetIpFilter = false;
	let isRollback = false;
	let rollbackSnapshot = null;
	let consoleLog = false;
	let serverIdError = false;

	let appConfigFile = 'app.json';
	let botConfigFile = 'bot.json';
	let serverConfigFile = 'server.json';

	// Standalone config-file overrides. When SymBot is launched directly (not spawned by the Hub,
	// which passes these via workerData below), these command-line flags select alternate config
	// files under /config — allowing more than one standalone instance to run from the same
	// install, each with its own app/bot/server config and database. For example:
	//   node symbot.js --app-config app2.json --bot-config bot2.json --server-config server2.json
	if (!workerData || typeof workerData !== 'object') {

		const appConfigArg    = getCliArg('app-config');
		const botConfigArg    = getCliArg('bot-config');
		const serverConfigArg = getCliArg('server-config');

		if (appConfigArg)    { appConfigFile = appConfigArg; }
		if (botConfigArg)    { botConfigFile = botConfigArg; }
		if (serverConfigArg) { serverConfigFile = serverConfigArg; }
	}

	if (process.argv[2] && process.argv[2].toLowerCase() == 'consolelog') {

		consoleLog = true;
	}

	if (process.argv[2] && process.argv[2].toLowerCase() == 'config') {

		isConfig = true;
	}

	if(process.argv[2] && process.argv[2].toLowerCase() == 'clglite') {

		Common.logger('Lite mode enabled. All logs for this session will be written to console only.');
	}

	if (process.argv[2] && process.argv[2].toLowerCase() == 'reset') {

		isReset = true;

		if (process.argv[3] && process.argv[3].toLowerCase() == 'serverid') {

			resetServerId = true;
		}

		if (process.argv[3] && process.argv[3].toLowerCase() == 'sessions') {

			resetSessions = true;
		}

		if (process.argv[3] && process.argv[3].toLowerCase() == 'aichats') {

			resetAiChats = true;
		}

		if (process.argv[3] && process.argv[3].toLowerCase() == 'users') {

			resetUsers = true;
		}

		if (process.argv[3] && process.argv[3].toLowerCase() == 'apikeys') {

			resetApiKeys = true;
		}

		if (process.argv[3] && process.argv[3].toLowerCase() == 'password') {

			resetPassword = true;
		}

		if (process.argv[3] && process.argv[3].toLowerCase() == 'ipfilter') {

			resetIpFilter = true;
		}
	}

	if (process.argv[2] && process.argv[2].toLowerCase() == 'rollback') {

		isRollback = true;
		rollbackSnapshot = process.argv[3] || null;
	}

	if (workerData && typeof workerData === 'object') {

		workerDataObj = workerData;

		if (workerDataObj['name'] && workerDataObj['name'] != '') {

			instanceName = workerDataObj['name'];
		}

		if (workerDataObj['app_config'] && workerDataObj['app_config'] != '') {

			appConfigFile = workerDataObj['app_config'];
		}

		if (workerDataObj['bot_config'] && workerDataObj['bot_config'] != '') {

			botConfigFile = workerDataObj['bot_config'];
		}

		if (workerDataObj['server_config'] && workerDataObj['server_config'] != '') {

			serverConfigFile = workerDataObj['server_config'];
		}
	}

	Common.logger('Starting ' + packageJson.description + ' v' + packageJson.version, true);

	// Default the update flag and DON'T block boot on the remote version check — it is a network call
	// to the update source, and nothing on the startup or trading path should wait on the network. The
	// real check runs in the background once the server is up (see refreshUpdateFlag below) and simply
	// flips this flag when it resolves.
	const update_available = false;
	await checkDependencies();

	let appConfig = await Common.getConfig(appConfigFile);
	let signalConfigs = await Common.getSignalConfigs();

	let signalConfigsData = signalConfigs.data;

	const botConfig = await Common.getConfig(botConfigFile);
	const serverConfig = await Common.getConfig(serverConfigFile);

	// Refuse to start on a BROKEN (malformed / unreadable) configuration file. getConfig returns
	// { success:false, data:<Error> } on failure. A JSON parse error (SyntaxError) — or any read
	// error other than a plain "file missing" (ENOENT) — means the file is corrupt and must be
	// fixed by hand, so we stop here with a precise message rather than crashing deeper in init()
	// (e.g. dereferencing app config below) or, far worse, starting the trading engine with a
	// half-loaded configuration. A merely MISSING bot or server config is left to the existing
	// config-mode / default handling further down, so a genuine fresh install is unaffected; a MISSING
	// app.json is handled by the explicit guard just after this loop (it is required — it ships with
	// SymBot and carries the mongo/web/API settings the engine needs).
	const requiredConfigs = [
		{ label: 'App',    file: appConfigFile,    result: appConfig },
		{ label: 'Bot',    file: botConfigFile,    result: botConfig },
		{ label: 'Server', file: serverConfigFile, result: serverConfig }
	];

	for (const cfg of requiredConfigs) {

		const err = (cfg.result && cfg.result.success === false) ? cfg.result.data : null;
		const malformed = err && (err instanceof SyntaxError || (err.code && err.code !== 'ENOENT'));

		if (malformed) {

			Common.logger('FATAL: ' + cfg.label + ' configuration file "' + cfg.file + '" is broken and cannot be parsed (' + (err.message || err) + '). Fix or restore it from a backup, then restart. Refusing to start to avoid running with an incomplete configuration.', true);

			// success:false (NOT nostart) so start() routes to shutDown() and the process exits with a
			// non-zero code — the same clean failure signal as a bad DB URL or a port already in use,
			// so a process manager / Docker surfaces the broken config instead of a silently hung app.
			return ({ 'success': false, 'app_config': null, 'bot_config': botConfig });
		}
	}

	if (botConfig.success) {

		botConfigData = botConfig.data;
	}

	// A MISSING or structurally-incomplete app.json (ENOENT, or no `api` section) is not recoverable
	// here: the code just below dereferences appConfig.data.api to seed the API key and password, and
	// the shipped default app.json carries the mongo/web/API settings the engine needs. Rather than
	// crash with an opaque TypeError deep in init, stop with a precise, actionable message and fail
	// closed (success:false → shutDown, non-zero exit). Malformed files were already caught above.
	// Name the specific missing piece so the operator gets an actionable message instead of an opaque
	// TypeError deep in init. Each section checked here is dereferenced unconditionally below (api → key/
	// password seeding; web_server.port → the web_server_port in appData), so a config lacking one cannot
	// start regardless — this only turns the eventual failure into a precise, fail-closed message.
	const cfgData = appConfig && appConfig['data'];
	const missingCfg = (!appConfig || appConfig.success === false || !cfgData) ? 'the configuration could not be read'
		: !cfgData['api'] ? 'the "api" section is missing'
		: (!cfgData['web_server'] || cfgData['web_server']['port'] == null) ? 'the "web_server" section (web_server.port) is missing'
		: null;
	if (missingCfg) {

		Common.logger('FATAL: App configuration file "' + appConfigFile + '" is missing or incomplete — ' + missingCfg + '. Restore the default app.json that ships with SymBot and restart. Refusing to start without a valid app configuration.', true);

		return ({ 'success': false, 'app_config': null, 'bot_config': botConfig });
	}

	if (appConfig['data']['api']['key'] == undefined || appConfig['data']['api']['key'] == null || appConfig['data']['api']['key'] == '' || appConfig['data']['api']['key'].indexOf(':') == -1) {

		apiKeySet = false;

		apiKeyClear = Common.genDefaultApiKey();

		apiKey = await Common.genApiKey(apiKeyClear);

		appConfig['data']['api']['key'] = apiKey;

		let appConfigObj = JSON.parse(JSON.stringify(appConfig));

		await Common.saveConfig(appConfigFile, appConfigObj.data);
	}
	else {

		apiKeySet = true;
		apiKey = appConfig['data']['api']['key'];
	}

	if (appConfig['data']['password'] == undefined || appConfig['data']['password'] == null || appConfig['data']['password'] == '' || appConfig['data']['password'].indexOf(':') == -1) {

		const dataPass = await Common.genPasswordHash({'data': 'admin'});

		appConfig['data']['password'] = dataPass['salt'] + ':' + dataPass['hash'];

		let appConfigObj = JSON.parse(JSON.stringify(appConfig));

		await Common.saveConfig(appConfigFile, appConfigObj.data);
	}

	if (signalConfigs.success && Object.keys(signalConfigsData).length > 0) {

		let providerId;
		let providerName;

		let startSubsObj = {};
		let providerIdsObj = {};

		appConfig['data']['bots']['start_conditions_metadata'] = {};

		for (let key in signalConfigsData) {

			let signalObj = {};

			let startConditions = signalConfigsData[key]['start_conditions'];
			let startConditionsSub = signalConfigsData[key]['start_conditions_sub'];
			let startConditionsMeta = signalConfigsData[key]['metadata'];

			providerId = startConditionsMeta['provider_id'];
			providerName = startConditionsMeta['provider_name'];

			if (providerId == undefined || providerId == null || providerId == '') {

				signalConfigs.success = false;
				signalConfigs.error = 'Missing signal provider id: ' + signalConfigsData[key]['file'];

				break;
			}

			if (providerName == undefined || providerName == null || providerName == '') {

				signalConfigs.success = false;
				signalConfigs.error = 'Missing signal provider name: ' + signalConfigsData[key]['file'];

				break;
			}

			if (providerIdsObj[providerId] != undefined && providerIdsObj[providerId] != null) {

				signalConfigs.success = false;
				signalConfigs.error = 'Duplicate signal provider id: ' + providerId + ' in ' + signalConfigsData[key]['file'];

				break;
			}

			providerIdsObj[providerId] = 1;

			for (let num in startConditions) {

				let id = startConditions[num]['id'];
				let description = startConditions[num]['description'];

				let signalId = 'signal|' + providerId + '|' + id;

				description = 'Signal ' + providerName + ': ' + description;

				signalObj[signalId] = {};
				signalObj[signalId]['description'] = description;
			}

			if (startSubsObj[providerId] == undefined || startSubsObj[providerId] == null) {

				startSubsObj[providerId] = {};

				for (let num in startConditionsSub) {

					let id = startConditionsSub[num]['id'];
					let description = startConditionsSub[num]['description'];

					let signalId = 'signalsub|' + providerId + '|' + id;

					startSubsObj[providerId][signalId] = {};
					startSubsObj[providerId][signalId]['description'] = description;
				}

				appConfig['data']['bots']['start_conditions_sub'] = Object.assign({}, appConfig['data']['bots']['start_conditions_sub'], startSubsObj[providerId]);
			}

			appConfig['data']['bots']['start_conditions'] = Object.assign({}, appConfig['data']['bots']['start_conditions'], signalObj);
			appConfig['data']['bots']['start_conditions_metadata'][providerId] = startConditionsMeta;
		}
	}

	let telegramEnabled = appConfig?.data?.telegram?.enabled;

	// A friendly, user-facing label the operator set in the Hub. It may contain spaces and normal
	// characters and is used for DISPLAY ONLY — the dashed `instanceName` stays the stable identifier
	// for config filenames, log/backup filenames, /instance/<name> routing and worker_data.name.
	// Falls back to the identifier when no display name was set (existing instances, or a standalone).
	const instanceLabel = (workerData && workerData['name_display'] && String(workerData['name_display']).trim() !== '')
		? String(workerData['name_display'])
		: instanceName;

	let shareData = {
						'appData': {
										'name': packageJson.description + (instanceName ? '-' + instanceName : ''),
										// Display variant of `name`: same product prefix, but the friendly label. The views
										// render this; `name` remains the identifier (backup prefix, user-agent, Server header).
										'name_display': packageJson.description + (instanceLabel ? '-' + instanceLabel : ''),
										'name_main': packageJson.description,
										'instance_name': instanceName,
										'instance_label': instanceLabel,
										'version': packageJson.version,
										'update_available': update_available,
										'app_config': appConfigFile,
										'bot_config': botConfigFile,
										'server_config': serverConfigFile,
										'server_id': '',
										'path_root': __dirname,
										'app_filename': __filename,
										'console_log': consoleLog,
										'max_log_days': appConfig['data']['max_log_days'],
										'mongo_db_url': appConfig['data']['mongo_db_url'],
										'web_server_port': appConfig['data']['web_server']['port'],
										'web_socket_path': 'ws',
										'exchanges': {},
										'api_key': apiKey,
										// Defensive reads: an app.json predating these fields must not crash startup on upgrade.
										// Default api_enabled true (preserves the prior single-key path); webhook_enabled false (safe/off).
										'api_enabled': appConfig?.data?.api?.enabled ?? true,
										'webhook_enabled': appConfig?.data?.webhook?.enabled ?? false,
										'password': appConfig['data']['password'],
										'bots': appConfig['data']['bots'],
										'telegram_id': appConfig?.data?.telegram?.notify_user_id,
										'telegram_enabled': telegramEnabled,
										'telegram_enabled_config': telegramEnabled,
										'signals_3cqs_enabled': appConfig?.data?.signals?.['3CQS']?.enabled,
										'cron_backup': appConfig['data']['cron_backup'],
										'ai': appConfig['data']['ai'] || {},
										'circuit_breaker': appConfig['data']['circuit_breaker'] || {},
										'ip_filter': appConfig['data']['ip_filter'] || {},
										// security.trust_proxy (client-IP source) and security.login_throttle
										// are read from here — they were previously omitted so those options
										// never took effect.
										'security': appConfig['data']['security'] || {},
										// Outbound SMTP for this instance. Without this, appData.mailer is undefined and
										// Mailer.configure() always sees {}, so a standalone instance's OWN SMTP never resolves
										// to 'own' mode (it would only ever relay via a Hub). `|| {}` keeps an old config safe.
										'mailer': appConfig['data']['mailer'] || {},
										// Granular notification preferences (event × channel × min-severity + quiet hours).
										// Null/absent means "deliver everywhere as before" — the router preserves legacy behavior.
										'notifications': appConfig['data']['notifications'] || null,
										// Optional per-source retention overrides for the Signal Activity log. Absent means
										// use the built-in defaults (see SignalActivity.retentionFor) — fully functional
										// without it; this just lets an operator tune each source's row budget.
										'signal_activity': appConfig['data']['signal_activity'] || {},
										'verboseLog': appConfig.data.verbose_log,
										'sig_int': false,
										'reset': isReset,
										'config_mode': false,
										'worker_data': workerData,
										'parent_port': parentPortReference,
										'started': new Date()
								   },
						'DB': DB,
						'TradingSignals': TradingSignals,
						'Signals3CQS': Signals3CQS,
						'DCABot': DCABot,
						'DCABotManager': DCABotManager,
						'SignalBot': SignalBot,
						'Common': Common,
						'Queue': Queue,
						'System': System,
						'MarketData': MarketData,
						'Telegram': Telegram,
						'WebServer': WebServer,
						'AIClient':  AIClient,
						'Scheduler': Scheduler,
						'ScheduleNotifier': ScheduleNotifier,
						'ScheduleRecipes': ScheduleRecipes,
						'Mailer': Mailer,
						'Authz': Authz,
						'ApiKeys': ApiKeys,
						'Users': Users,
						'Audit': Audit,
						'AuthMiddleware': AuthMiddleware,
						'RoutePermissions': RoutePermissions,
						'Watchdog': Watchdog,
						'Diagnostics': Diagnostics,
						'SignalActivity': SignalActivity,
						'AIContext': AIContext,
						'AIChatDB':  AIChatDB,
					};

	Common.freezeProperty(shareData['appData'], [ 'path_root', 'app_filename' ]);

	// Flag whether the owner password is still the shipped default ("admin"). This drives a
	// non-blocking "change your default password" nudge in the UI only — it never gates login,
	// startup, or trading. It is recomputed on a password change (Common config save) so the
	// nudge clears the instant the operator sets their own password. Best-effort: any failure
	// leaves the flag false, so a glitch can never invent a warning.
	try {

		const ownerPass = shareData['appData']['password'];

		if (typeof ownerPass === 'string' && ownerPass.indexOf(':') !== -1) {

			const passParts = ownerPass.split(':');

			shareData['appData']['default_password'] = await Common.verifyPasswordHash({ 'salt': passParts[0], 'hash': passParts[1], 'data': 'admin' });
		}
		else {

			shareData['appData']['default_password'] = false;
		}
	}
	catch (e) {

		shareData['appData']['default_password'] = false;
	}

	// Apply config overrides from hub
	if (Object.keys(workerDataObj).length > 0 && typeof workerDataObj['overrides'] === 'object') {

		const workerDataOverrides = workerDataObj['overrides'];

		if (workerDataOverrides['server_id'] != undefined && workerDataOverrides['server_id'] != null && workerDataOverrides['server_id'] != '') {

			const serverIdOverride = workerDataOverrides['server_id'];

			serverConfig['data']['server_id'] = serverIdOverride;
			serverConfig['data']['server_id_override'] = serverIdOverride;
		}

		if (workerDataOverrides['web_server_port'] != undefined && workerDataOverrides['web_server_port'] != null && workerDataOverrides['web_server_port'] != '') {

			shareData.appData['web_server_port'] = workerDataOverrides['web_server_port'];
		}

		if (workerDataOverrides['mongo_db_url'] != undefined && workerDataOverrides['mongo_db_url'] != null && workerDataOverrides['mongo_db_url'] != '') {

			shareData.appData['mongo_db_url'] = workerDataOverrides['mongo_db_url'];
		}

		if (workerDataOverrides['telegram_enabled'] !== undefined && workerDataOverrides['telegram_enabled'] !== null && workerDataOverrides['telegram_enabled'] !== '') {

			shareData.appData['telegram_enabled'] = Common.convertBoolean(workerDataOverrides['telegram_enabled'], false);
		}

		if (workerDataOverrides['signals_3cqs_enabled'] !== undefined && workerDataOverrides['signals_3cqs_enabled'] !== null && workerDataOverrides['signals_3cqs_enabled'] !== '') {

			shareData.appData['signals_3cqs_enabled'] = Common.convertBoolean(workerDataOverrides['signals_3cqs_enabled'], false);
		}

		// Per-instance sandbox wallet override — stored in Hub instance overrides
		// so each instance maintains its own wallet balance independently of the
		// shared bot.json file that all instances use.
		if (workerDataOverrides['sandbox_wallet'] !== undefined && workerDataOverrides['sandbox_wallet'] !== null && workerDataOverrides['sandbox_wallet'] !== '') {

			const sandboxWalletOverride = parseFloat(workerDataOverrides['sandbox_wallet']);

			if (!isNaN(sandboxWalletOverride) && sandboxWalletOverride >= 0) {

				shareData.appData['sandbox_wallet_override'] = sandboxWalletOverride;
			}
		}
	}

	appDataConfig = shareData.appData;

	Common.init(shareData);
	Queue.init(shareData);
	DB.init(shareData);
	System.init(shareData, shutDown);
	TradingSignals.init(shareData);
	Signals3CQS.init(shareData);
	DCABot.init(shareData);
	DCABotManager.init(shareData);
	Telegram.init(shareData);
	WebServer.init(shareData);
	AIClient.init(shareData);
	AIContext.init(shareData);
	MarketData.init(shareData);

	let success = true;

	if (!appConfig.success) {

		Common.logger('App configuration file error: ' + appConfig.data, true);

		success = false;
	}

	if (success) {

		if (!signalConfigs.success) {

			Common.logger('Signals configuration file error: ' + signalConfigs.error, true);

			success = false;
		}
	}

	if (success) {

		const dbUrl = appDataConfig.mongo_db_url;

		if (isConfig || (dbUrl == undefined || dbUrl == null || dbUrl == '')) {

			let setDbUrl;

			appDataConfig.config_mode = true;

			if (!process.env.DOCKER_RUNNING) {

				if (dbUrl) {

					setDbUrl = dbUrl;
				}
				else {

					setDbUrl = 'mongodb://127.0.0.1:27017/SymBot';
				}
			}
			else {

				if (dbUrl) {

					setDbUrl = dbUrl;
				}
				else {

					setDbUrl = 'mongodb://symbot:symbot123@database/symbot';
				}
			}

			appDataConfig.mongo_db_url = setDbUrl;

			Common.logger('WARNING: ' + appDataConfig.name + ' is running in configuration mode', true);
		}
		else {

			let dbStarted =	await DB.start(dbUrl);

			if (!dbStarted) {

				success = false;
			}
			else {

				await System.start(dbUrl);

				let res = await verifyServerId(serverConfigFile, serverConfig);

				serverIdError = res['server_id_error'];

				if (!res.success) {

					success = false;
				}
				else {

					shareData.appData.server_id = res.server_id;

					// Self-heal the per-instance data FOLDER the moment server_id is known and BEFORE
					// any further log/backup write: if the id changed (reset/restore/override), rename
					// the old folder to the new id so logs and backups carry across intact. (The folder
					// tree is shared across a Hub, so this step keys on this instance's own marker.)
					Common.healDataLayout();

					// Follow the identity into the DATABASE. A SymBot database holds exactly one live server_id, so any
					// scoped row under a foreign id is this instance's own, stranded by a previous id — sweep them all
					// to the current id. One path for standalone and Hub; runs every boot (a no-op when clean), so it
					// also retries a change a prior boot did not finish. Best-effort, off the trading path; never throws.
					try { await System.rehomeScopedIdentity(shareData.appData.server_id); }
					catch (e) { try { Common.logger('Identity re-home failed: ' + ((e && e.message) ? e.message : e)); } catch (le) {} }

					// One-time move of this instance's legacy flat logs and backups into its
					// per-server_id data folder, plus relocation of any early-boot bootstrap logs. This
					// MUST run here — the moment server_id is resolved — not later in app init, which
					// runs before the database connects and server_id is known (the migration guards on
					// server_id and would otherwise no-op). Idempotent; own files only; never throws.
					await Common.migrateDataLayout();

					// Populate the backup manifest from the backups folder at boot, so listing and retention
					// key on a current index from the first request — not only after the next scheduled backup.
					// Best-effort: the directory stays the source of truth, so a failure just self-heals later.
					try { System.reconcileBackupsIndex(); } catch (e) {}

					// Finish (or safely discard) a password re-key that a crash interrupted, BEFORE the
					// trading engine connects to the exchange. Only completes when it can prove the exchange
					// credentials are already under the new key; anything ambiguous is left for the
					// decryptability watchdog, so it can never make trading worse. Almost always a no-op.
					await Common.recoverRekeyJournal();
				}
			}
		}
	}

	if (isReset && (success || serverIdError)) {

		if (resetSessions) {

			const resetData = await System.resetSessions();

			console.log('Sessions reset: ' + resetData['success']);

			process.exit(1);
		}
		else if (resetAiChats) {

			const resetData = await System.resetAiChatsConsole();

			console.log('AI chats reset: ' + resetData['success']);

			process.exit(1);
		}
		else if (resetUsers) {

			await System.resetAuthConsole('users', appConfigFile);

			process.exit(1);
		}
		else if (resetApiKeys) {

			await System.resetAuthConsole('apikeys', appConfigFile);

			process.exit(1);
		}
		else if (resetPassword) {

			await System.resetAuthConsole('password', appConfigFile);

			process.exit(1);
		}
		else if (resetIpFilter) {

			await System.resetIpFilterConsole(appConfigFile);

			process.exit(1);
		}
		else {

			await System.resetConsole(serverIdError, resetServerId);
		}

		return({ 'nostart': true });
	}

	if (isRollback) {

		await System.rollbackConsole(rollbackSnapshot);

		return({ 'nostart': true });
	}

	if (success) {

		// Set token
		await Common.setToken();

		if (!apiKeySet) {

			// Show the one-time auto-generated key on the interactive console. It carries a
			// `symb_auto_` prefix so the log redactor WOULD mask it — which is exactly why it can't
			// go through Common.logger() here: that would mask it in the console too, and the
			// operator needs to read it once to save it. So print it directly to the console and let
			// Common.logger() record only a value-free note (belt and suspenders: even if the key
			// reaches a log by some other path, the redactor now catches it).
			console.log(new Date().toISOString() + ' WARNING: ' + appDataConfig.name + ' API key was not set and has been auto generated as: ' + apiKeyClear + '. This will not be displayed again — save it now, or generate a scoped key in the web interface (Access Control → API Keys).');

			Common.logger('WARNING: ' + appDataConfig.name + ' API key was not set and has been auto generated (shown once on the console at startup, kept out of the log). Generate a scoped key in the web interface (Access Control → API Keys).', false);
		}

		const processInfo = await Common.getProcessInfo();

		// The Telegram token is encrypted at rest; decrypt it before use (readSecret passes a legacy
		// plaintext token through unchanged, so older installs keep working until their next config save).
		Telegram.start(await Common.readSecret(appConfig?.data?.telegram?.token_id), appDataConfig['telegram_enabled']);
		WebServer.start(appDataConfig['web_server_port']);

		// Start AI client — supports Ollama and OpenAI providers
		const aiConfig = appConfig['data']['ai'] || {};
		const aiProvider = aiConfig['provider'];
		const ollamaEnabled = aiConfig['ollama']?.['enabled'];
		const openaiEnabled = aiConfig['openai']?.['enabled'];

		if (aiProvider === 'openai' || openaiEnabled) {

			const oc = aiConfig['openai'] || {};
			AIClient.start('openai', Object.assign({}, oc, { 'api_key': await Common.readSecret(oc['api_key']) }));
		}
		else if (aiProvider === 'ollama' || ollamaEnabled) {

			const oc = aiConfig['ollama'] || {};
			AIClient.start('ollama', Object.assign({}, oc, { 'api_key': await Common.readSecret(oc['api_key']) }));
		}

		// Central scheduler: register job-type handlers, arm saved schedules, then run the
		// one-time database-backup migration (app.json → schedules collection). Starting
		// the scheduler first gives it its context (server_id) before the migration writes.
		try {

			ScheduleNotifier.init(shareData);
			Mailer.init(shareData);
			await Mailer.configure();

			// Authorization subsystem: capability engine, scoped API keys, users/roles,
			// audit trail, and the request-enforcement seam. Wiring only — no behavior
			// change until routes adopt the guards; a legacy session stays the implicit owner.
			Authz.init(shareData);
			ApiKeys.init(shareData);
			Users.init(shareData);
			Audit.init(shareData);
			AuthMiddleware.init(shareData);
			RoutePermissions.init(shareData);
			SignalActivity.init(shareData);

			// Seed the initial owner from the instance's existing password (a fresh install
			// sets that password in config mode first), so the account model always has an
			// owner. Idempotent, and the current password-only login keeps working.
			if (shareData.appData.password && !shareData.appData.config_mode) {

				try { await Users.seedOwner({ username: 'owner', passwordHash: shareData.appData.password }); }
				catch (e) { Common.logger('Owner seed skipped: ' + e.message); }

				// Provision the protected internal signals key so the built-in 3CQS client
				// authenticates natively through the scoped API-key system. Its secret is held
				// in memory only. If provisioning is ever unavailable the client falls back to
				// the legacy webhook token, so signals never break.
				try {

					const prov = await ApiKeys.provisionInternal({ 'capabilities': [ 'deal.create' ] });

					if (prov && prov.success) { shareData.appData.internal_signals_key = prov.clearKey; }
				}
				catch (e) { Common.logger('Internal signals key provisioning skipped: ' + e.message); }
			}
			AIScheduleHandler.register(Scheduler, shareData);
			ErrorWatchdogHandler.register(Scheduler, shareData);
			DrawdownSentinelHandler.register(Scheduler, shareData);
			ResourceSentinelHandler.register(Scheduler, shareData);
			System.registerBackupHandler(Scheduler);
			await Scheduler.start(shareData);
			await System.migrateBackupToScheduler();

			// Import any shipped, pre-defined recipe tasks (e.g. the watchdog error scanner) that this
			// instance has neither imported nor removed yet — as disabled, user-owned schedule rows.
			try { ScheduleRecipes.init(shareData); const seeded = await ScheduleRecipes.seed(); if (seeded && seeded.seeded) { Common.logger('ScheduleRecipes: imported ' + seeded.seeded + ' pre-defined task(s) as disabled schedules'); } }
			catch (e) { Common.logger('ScheduleRecipes: seeding skipped: ' + e.message); }

			// Now that the audit trail is wired, run the central self-policing watchdog so its
			// boot-time integrity findings can be recorded to the audit log (not just the console).
			try { WebServer.runWatchdog('instance'); }
			catch (e) { Common.logger('Watchdog run skipped: ' + e.message); }
		}
		catch (e) { Common.logger('Scheduler failed to start: ' + e.message); }

		const TWELVE_HOURS = 12 * 60 * 60 * 1000;

		// Refresh the update-available flag from the remote version source. Runs ONCE now — in the
		// background, so it never delayed startup or trading — and every 12 hours after. validateAppVersion
		// bounds its own network call with a timeout and is best-effort: any failure is a quiet no-op.
		const refreshUpdateFlag = async () => {
			try {
				const { update_available } = await Common.validateAppVersion();
				if (update_available && !shareData.appData.update_available) { shareData.appData.update_available = true; }
			}
			catch (e) {}
		};

		refreshUpdateFlag();
		setInterval(refreshUpdateFlag, TWELVE_HOURS);

		setTimeout(() => {

			let msg = appDataConfig.name + ' v' + appDataConfig.version + ' started at ' + new Date(appDataConfig.started).toISOString();

			Common.sendNotification({ 'message': msg, 'telegram_id': appDataConfig.telegram_id });

		}, 1000);
	}

	return({ 'success': success, 'app_config': appDataConfig, 'bot_config': botConfig });
}


async function verifyServerId(serverConfigFile, serverConfig) {

	let serverId;
	let success = true;
	let serverIdError = false;

	const serverData = await ServerDB.ServerSchema.findOne({ 'serverId': { $exists: true } });

	if (!serverData) {

		// Server ID not found in database
		let isOverride = false;

		const serverIdOverride = serverConfig.data.server_id_override;

		// Use override from Hub instead of generating new one
		if (serverIdOverride != undefined && serverIdOverride != null && serverIdOverride != '') {

			isOverride = true;
			serverId = serverIdOverride;
		}
		else {

			serverId = Common.uuidv4();
		}

		try {

				const data = new ServerDB.ServerSchema({

										'serverId': serverId,
										'created': Date.now(),
									});

				await data.save();

				// Only save if not override
				if (!isOverride) {

					await Common.saveConfig(serverConfigFile, { 'server_id': serverId });
				}
			}
			catch(e) {

				success = false;

				Common.logger('Failed to create server database', true);
			}
	}
	else {

		if (!process.env.DOCKER_RUNNING && serverConfig.data.server_id != serverData.serverId) {

			success = false;
			serverIdError = true;

			Common.logger('Server ID mismatch', true);
			Common.logger('Server ID database: ' + serverData.serverId, true);
			Common.logger('Server ID configuration: ' + serverConfig.data.server_id, true);
		}
		else {

			serverId = serverData.serverId;
		}
	}

	return ({ 'success': success, 'server_id': serverId, 'server_id_error': serverIdError });
}


async function checkDependencies() {

	if (Dependencies.error.length > 0) {

		const pref = 'WARNING: ';

		for (let i in Dependencies.error) {

			let dep = Dependencies.error[i];
	
			Common.logger(pref + dep, true);
		}

		Common.logger(pref + 'Packages installed do not match package list. You may want to update using npm install or another method', true);
	}
}


async function setInstanceConfig(config) {

	if (config && config.shutdownTimeout) {

		workerData = config;

		shutdownTimeout = config.shutdownTimeout;
	}
}


async function setInstanceParentPort(port) {

	parentPortReference = port;
}


async function start(args) {

	let initData;

	// Standalone maintenance command: verify or regenerate the AI learning seed corpus, then exit
	// WITHOUT booting the trading engine. Editing the shipped corpus (libs/ai/data/seed-learning.json)
	// invalidates its integrity checksum; `corpus regen` recomputes the checksum/count/tools_version so
	// the file passes verification again, and `corpus check` reports integrity plus which registered
	// tools still have no learning pattern. Touches nothing but that one file.
	if (process.argv[2] && process.argv[2].toLowerCase() === 'corpus') {

		const CorpusTool = require('./libs/ai/CorpusTool.js');
		const sub = (process.argv[3] || 'check').toLowerCase();

		if (sub === 'regen' || sub === 'regenerate') {

			const r = CorpusTool.regen();
			console.log('Corpus regenerate (' + CorpusTool.SEED_PATH + '):');
			console.log('  records:  ' + r.records_in + (r.dropped ? ' (' + r.dropped + ' invalid dropped → ' + r.records_out + ')' : ''));
			console.log('  checksum: ' + (r.changed ? (String(r.before).slice(0, 16) + '… → ' + String(r.after).slice(0, 16) + '…  (updated)') : (String(r.after).slice(0, 16) + '…  (unchanged)')));

			const v = CorpusTool.check();
			console.log('  verify:   ' + (v.ok ? 'OK' : 'FAILED — ' + v.error));
			if (v.uncovered && v.uncovered.length) { console.log('  tools without patterns: ' + v.uncovered.join(', ')); }
			process.exit(v.ok ? 0 : 1);
		}
		else {

			const v = CorpusTool.check();
			console.log('Corpus check (' + CorpusTool.SEED_PATH + '):');
			if (v.error && !v.ok) { console.log('  error: ' + v.error); }
			console.log('  integrity:     ' + (v.ok ? 'OK' : 'FAILED'));
			console.log('  records:       ' + v.records + (v.rejected ? ' (' + v.rejected + ' rejected)' : ''));
			console.log('  checksum:      ' + (v.manifest_checksum === v.expected_checksum ? 'match' : 'MISMATCH — run: node symbot.js corpus regen'));
			console.log('  tools_version: file=' + v.tools_version_file + ' now=' + v.tools_version_now + (v.tools_version_file === v.tools_version_now ? ' (match)' : ' (drifted — run: node symbot.js corpus regen)'));
			console.log('  tool coverage: ' + ((v.uncovered && v.uncovered.length) ? (v.uncovered.length + ' without patterns: ' + v.uncovered.join(', ')) : 'all tools have patterns'));
			process.exit(v.ok ? 0 : 1);
		}
	}

	await Common.makeDir('backups');
	await Common.makeDir('uploads');
	await Common.makeDir('downloads');
	await Common.makeDir('temp');
	await Common.makeDir('logs');
	await Common.makeDir('logs/services');
	await Common.makeDir('logs/services/notifications');

	if (args && args.length > 0) {

		for (let i = 0; i < args.length; i++) {

			process.argv[i + 2] = args[i];
		}
	}

	try {

		initData = await init();
	}
	catch(e) {

		Common.logger('Initialization error: ' + e, true);
		Common.logger('Please verify your configuration files have all required parameters', true);

		shutDown();
		return;
	}

	if (initData.nostart) {

		return;
	}

	if (initData.success) {

		const appConfig = initData.app_config;
		const botConfig = initData.bot_config;

		if (!botConfig.success) {

			Common.logger('Bot configuration file error: ' + botConfig.data, true);

			shutDown();
			return;
		}

		Common.logMonitor();
	}
	else {

		shutDown();
	}
}


function shutDown() {

	// Perform any post shutdown processes here

	if (!gotSigInt) {

		gotSigInt = true;

		Common.logger('Received kill signal. Shutting down gracefully.', true);

		if (appDataConfig != undefined && appDataConfig != null && appDataConfig != '') {

			appDataConfig['sig_int'] = true;

			let msg = appDataConfig.name + ' v' + appDataConfig.version + ' shutting down at ' + new Date().toISOString();

			Common.sendNotification({ 'message': msg, 'telegram_id': appDataConfig.telegram_id });
		}

		setTimeout(() => {
							process.exit(1);

						 }, shutdownTimeout);
	}
}


if (require.main === module) {

	start();
}


module.exports = {

	start,
	shutDown,
	setInstanceConfig,
	setInstanceParentPort,
	get DCABot() {
        return DCABot;
    },
	get System() {
        return System;
    },
	get DCABotManager() {
        return DCABotManager;
    },
	get AIClient() {
        return AIClient;
    }
}