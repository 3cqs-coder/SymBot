'use strict';


/*

	SymBot Hub
	Copyright © 2023 - 2026 3CQS.com All Rights Reserved
	Licensed under Creative Commons Attribution-NonCommerical-ShareAlike 4.0 International (CC BY-NC-SA 4.0)

*/


// ── Early startup guards (shared with symbot.js so they can't drift) ─────────────────────────────
// Enforce package.json's minimum Node.js version, then prefer IPv4 for outbound DNS (resilient to flaky VPS
// IPv6). The Hub especially relies on Node's built-in `node:sqlite`, which only exists on modern Node, so an
// old runtime must be caught before that require runs. Both guards run before any network-using require
// below. Full rationale lives in libs/app/Bootstrap.js.
const Bootstrap = require(__dirname + '/libs/app/Bootstrap.js');
Bootstrap.enforceNodeVersion(__dirname, 'SymBot Hub');
Bootstrap.preferDnsOrder();


// The Hub store uses Node's built-in `node:sqlite`, which emits a noisy "SQLite is an
// experimental feature" ExperimentalWarning at load time. Suppress ONLY that specific
// message (matched by text) so the console stays clean; every other warning — including
// any other ExperimentalWarning — is passed through untouched. Must run before the store
// module is required below, since the warning fires when `node:sqlite` is loaded.
const _origEmitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {

	const msg = (typeof warning === 'string') ? warning : ((warning && warning.message) || '');

	if (/SQLite is an experimental feature/i.test(msg)) { return; }

	return _origEmitWarning(warning, ...rest);
};


const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Common = require(__dirname + '/libs/app/Common.js');
const System = require(__dirname + '/libs/app/System.js');
const MarketData = require(__dirname + '/libs/app/MarketData.js');
const Mailer = require(__dirname + '/libs/app/Mailer.js');
const Authz = require(__dirname + '/libs/app/Authz.js');
const AuthMiddleware = require(__dirname + '/libs/app/AuthMiddleware.js');
const RoutePermissions = require(__dirname + '/libs/app/RoutePermissions.js');
const Watchdog = require(__dirname + '/libs/app/Watchdog.js');
const HubStore = require(__dirname + '/libs/app/store/HubStore.js');
const Hub = require(__dirname + '/libs/app/Hub/Hub.js');
const HubMain = require(__dirname + '/libs/app/Hub/Main.js');
const HubWorker = require(__dirname + '/libs/app/Hub/Worker.js');
const WebServer = require(__dirname + '/libs/webserver/Hub');
const packageJson = require(__dirname + '/package.json');
const { HUB_TO_WORKER, WORKER_TO_HUB } = require(__dirname + '/libs/app/Hub/MessageTypes.js');


let gotSigInt = false;

const shutdownTimeout = 2000;
// Read a `--name value` or `--name=value` command-line argument, or null if absent. The Hub is
// parameterized via command-line arguments (never environment variables).
function getCliArg(name) {

	const argv = process.argv;

	for (let i = 2; i < argv.length; i++) {

		if (argv[i] === '--' + name && argv[i + 1] != undefined) { return argv[i + 1]; }
		if (argv[i].indexOf('--' + name + '=') === 0) { return argv[i].slice(('--' + name + '=').length); }
	}

	return null;
}

// Standalone overrides via command-line flags: `--hub-config <file>` selects an alternate Hub
// config file under /config and `--hub-data-dir <dir>` relocates the Hub's SQLite database +
// backups. These let a second (e.g. test) Hub run from the same install without touching the
// primary Hub's config or database. For example:
//   node symbot-hub.js --hub-config hub2.json --hub-data-dir data/hub2
const hubConfigFile = getCliArg('hub-config') || 'hub.json';
const hubDataDir = getCliArg('hub-data-dir') || require('path').join(__dirname, 'data', 'hub');
const workerMap = new Map();

let shareData;



// Graceful shutdown + the uncaughtException/unhandledRejection handlers (log and keep the Hub — and with it
// every instance worker it supervises — running), shared with symbot.js via Bootstrap so the two can't drift.
function initSignalHandlers() {

	Bootstrap.installProcessGuards(shutDown, function (m) { Hub.logger('error', m); });
}


async function startHub() {

	let port;
	let configs;
	let maxLogDays;
	let memoryPollIntervalMs;

	let success = true;

	initSignalHandlers();

	let hubData = await Common.getConfig(hubConfigFile);

	if (hubData.success) {

		port = hubData.data.port;
		configs = hubData.data.instances;
		maxLogDays = hubData.data.max_log_days;
		memoryPollIntervalMs = hubData.data.memory_poll_interval_ms;

		const password = hubData['data']['password'];

		if (password == undefined || password == null || password == '') {

			// Set default password
			const dataPass = await Common.genPasswordHash({ 'data': 'admin' });

			hubData['data']['password'] = dataPass['salt'] + ':' + dataPass['hash'];

			await Common.saveConfig(hubConfigFile, hubData.data);
		}

		// Mint and persist a stable Hub server_id (its own data identity) if absent. This is reserved
		// for a future multi-Hub layout (data/hubs/<hub_server_id>/) and to distinguish "which Hub"
		// in any shared store; the default data path stays data/hub/, so existing single-Hub installs
		// are unaffected — this only guarantees the identity exists.
		if (!hubData['data']['server_id']) {

			hubData['data']['server_id'] = Common.uuidv4();

			await Common.saveConfig(hubConfigFile, hubData.data);
		}

		// Create initial Hub instance
		if (configs.length < 1) {

			const instanceObj = {
				"name": "Instance-1",
				"app_config": "app.json",
				"bot_config": "bot.json",
				"server_config": "server.json",
				"server_id": "",
				"mongo_db_url": "",
				"web_server_port": null,
				"enabled": true,
				"start_boot": true,
				"overrides": { },
				"updated": new Date().toISOString()
			}

			configs.push(instanceObj);
		}
	}
	else {

		success = false;

		Hub.logger('error', 'Hub Configuration Error: ' + hubData.data);
	}

	if (success) {

		shareData = {
						'appData': {
						
							'name': packageJson.description + ' Hub',
							'version': packageJson.version,
							'password': hubData['data']['password'],
							// The Hub's shared SMTP settings (from hub.json). The Hub's Mailer
							// reads this to send email relayed by instances that have no SMTP
							// of their own. The password is encrypted with the Hub password.
							'mailer': (hubData['data'] && hubData['data']['mailer']) || {},
							// Server-wide IP allow/deny for the Hub (from hub.json). Loopback is always
							// exempt and the middleware fails open, so this can't lock the operator out.
							'ip_filter': (hubData['data'] && hubData['data']['ip_filter']) || {},
							// security.trust_proxy controls the client-IP source (see AuthMiddleware.clientIp).
							'security': (hubData['data'] && hubData['data']['security']) || {},
							'path_root': __dirname,
							'hub_filename': __filename,
							'web_server_ports': undefined,
							'web_socket_path': 'ws',
							'hub_config': hubConfigFile,
							'shutdown_timeout': shutdownTimeout,
							'sig_int': false,
							'started': new Date(),
							// worker_data.name drives the Hub log filename in Hub.logger.
							// 'hub' produces YYYY-MM-DD-hub.log, kept in the same /logs
							// directory as instance logs and cleaned up automatically by
							// Common.logMonitor() on the same schedule.
							'worker_data': { 'name': 'hub' },
							'console_log': true,
							'api_enabled': true,   // the Hub API accepts scoped keys (resolved via HubStore)
							'max_log_days': (maxLogDays != undefined && maxLogDays != null && maxLogDays > 0) ? maxLogDays : 10
						},
					'Common': Common,
					'System': System,
					'MarketData': MarketData,
					'Mailer': Mailer,
					'Authz': Authz,
					'AuthMiddleware': AuthMiddleware,
					'RoutePermissions': RoutePermissions,
					'Watchdog': Watchdog,
					'HubStore': HubStore,
					// Present HubStore under the interfaces AuthMiddleware / route guards expect,
					// so the same principal-resolution + enforcement seam works on the Hub
					// (SQLite-backed) exactly as on instances (Mongo-backed).
					'ApiKeys': { resolve: (key, ctx) => HubStore.resolveKey(key, ctx) },
					'Users':   { getById: (id) => HubStore.getUserById(id), toPrincipal: (u) => HubStore.userToPrincipal(u) },
					'Audit':   { audit: (a, ac, t, d, ip) => HubStore.audit(a, ac, t, d, ip), list: (o) => HubStore.listAudit(o) },
					'WebServer': WebServer,
					'Hub': Hub,
					'HubMain': HubMain,
					'workerMap': workerMap
		};

		Common.freezeProperty(shareData['appData'], [ 'path_root', 'hub_filename' ]);

		// Flag whether the Hub login is still on the shipped default password ("admin"). Drives the
		// non-blocking "change your default password" nudge in the UI only — never gates login. It is
		// recomputed on a password change (Common config save) so it clears when a real password is set.
		// Best-effort: any failure leaves it false, so a glitch can never invent a warning.
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

		HubMain.init(Worker, shareData, shutDown);

		Common.init(shareData);
		MarketData.init(shareData);
		WebServer.init(shareData);
		Hub.init(shareData);

		// The Hub's shared mailer: builds its transport from hub.json's SMTP block (password
		// decrypted with the Hub password). This is what actually sends email that instances
		// relay to the Hub. System.decrypt is a self-contained helper and needs no init.
		Mailer.init(shareData);
		await Mailer.configure();

		// Hub control-plane storage: users, API keys, and the audit log in a hardened embedded
		// SQLite database (libs/app/store). Crash-proof (WAL, integrity check + auto-recovery)
		// with live VACUUM INTO snapshots — a trading platform cannot lose or corrupt this.
		// Seeds the initial owner from the existing Hub password so the current login keeps
		// working, backs up immediately, then daily.
		Authz.init(shareData);

		const pathMod = require('path');
		const storeState = HubStore.init({
			path: pathMod.join(hubDataDir, 'hub.db'),
			backupDir: pathMod.join(hubDataDir, 'backups'),
			logger: (m) => Hub.logger('info', m)
		});

		if (storeState.available) {

			HubStore.seedOwner({ username: 'owner', passwordHash: shareData.appData.password });

			// Best-effort: a backup failure must never halt Hub boot or crash the daily timer.
			try { HubStore.backup(); } catch (e) {}

			const hubBackupTimer = setInterval(() => { try { HubStore.backup(); } catch (e) {} }, 24 * 60 * 60 * 1000);
			if (hubBackupTimer.unref) { hubBackupTimer.unref(); }
		}
		else {

			Hub.logger('error', 'Hub storage unavailable — Node 22.13+ is required for built-in SQLite. Hub users/API keys/audit are disabled until Node is upgraded.');
		}

		AuthMiddleware.init(shareData);
		RoutePermissions.init(shareData);

		// Start Hub log rotation on the same schedule as SymBot instances.
		// Cleans YYYY-MM-DD-hub.log files from /logs alongside instance logs.
		Common.logMonitor();

		let processData = await Hub.processConfig(configs);

		// Surface non-fatal configuration warnings (e.g. an empty server_id that will be
		// regenerated on start, or a duplicate bot_config) without aborting. These were
		// previously computed but never shown.
		if (Array.isArray(processData.warnings) && processData.warnings.length > 0) {

			for (const warning of processData.warnings) {

				Hub.logger('warn', warning);
			}
		}

		if (!processData.success) {

			success = false;

			Hub.logger('error', JSON.stringify(processData.error));
		}
		else {

			await Hub.setProxyPorts(processData['web_server_ports']);

			let foundMissing = false;

			for (let i = 0; i < configs.length; i++) {

				const config = configs[i];

				let id = config['id'];

				if (id == undefined || id == null || id == '') {

					foundMissing = true;

					config['id'] = Common.uuidv4();
				}
			}

			// Update data if found missing id's
			if (foundMissing) {

				processData = null;

				processData = await Hub.processConfig(configs);

				configs = processData.configs;
				hubData['data']['instances'] = configs;

				await Common.saveConfig(hubConfigFile, hubData.data);
			}

			configs = processData.configs;			
		}
	}

	if (!success) {

		Hub.logger('error', 'Aborting due to configuration errors.');

		process.exit(1);
	}

	await WebServer.start(port);

	// Run the central self-policing watchdog now that routes and the audit trail are wired, so its
	// boot-time integrity findings are recorded to the Hub audit log.
	try { WebServer.runWatchdog('hub'); }
	catch (e) { Hub.logger('error', 'Watchdog run skipped: ' + e.message); }

	HubMain.start(configs);

	// Poll worker memory usage on a configurable interval.
	// Set memory_poll_interval_ms in hub.json to override the default.
	// Shorter intervals increase WebSocket traffic; longer intervals reduce it.
	const memoryPollMs = (memoryPollIntervalMs != undefined && memoryPollIntervalMs != null && memoryPollIntervalMs >= 1000)
		? memoryPollIntervalMs
		: 30000;

	// Store in appData so the Hub manage view can read it at render time and set
	// its staleness threshold to match the actual polling rate
	shareData.appData['memory_poll_ms'] = memoryPollMs;

	// Fire an initial poll shortly after startup so instances appear online as
	// soon as the page loads. The delay gives workers time to come online before
	// the first request is sent — without it the workerMap may still be empty.
	// The interval then handles all subsequent refreshes.
	setTimeout(() => Hub.logMemoryUsage(), 3000);
	setInterval(() => Hub.logMemoryUsage(), memoryPollMs);
}


async function startWorker() {

	HubWorker.init(parentPort, shutdownTimeout);
	HubWorker.start(workerData);
}


async function shutDown() {

	// Perform any post-shutdown processes here

	if (!gotSigInt) {

		gotSigInt = true;

		Hub.logger('info', 'Received kill signal. Shutting down gracefully.');
		Hub.logger('info', 'Cleaning up instances...');

		// Cleanly close the Hub's SQLite store on graceful shutdown: this checkpoints the WAL
		// (TRUNCATE) so the main database file is fully up to date, rather than relying on the
		// periodic timer or WAL replay on next open.
		try { HubStore.close(); } catch (e) {}

		// Signal Main to suppress crash-restart logic during intentional shutdown
		HubMain.setShuttingDown();

		const terminationPromises = [];

		// Set timer to force shutdown if cleanup takes too long
		let timeOutShutdown = setTimeout(() => {

			Hub.logger('info', `Cleanup timed out. Forcing shutdown.`);

			process.exit(1);
		
		}, (shutdownTimeout + 20000));

		for (const [workerId, { worker, instance }] of workerMap.entries()) {

			const dateStart = instance.dateStart;
			const upTime = Common.timeDiff(new Date(dateStart), new Date());

			// Create a promise to track the worker shutdown process.
			// worker.once ensures the listener is removed after the first fire.
			// The per-worker timeout resolves (not rejects) so one unresponsive
			// worker does not prevent the others from being cleaned up.
			const workerTimeoutMs = shutdownTimeout + 10000;

			const shutdownPromise = new Promise((resolve) => {

				let workerShutdownTimeout;

				const onShutdownReceived = async (message) => {

					if (message.type !== WORKER_TO_HUB.SHUTDOWN_RECEIVED) return;

					// Acknowledged — cancel the safety timeout
					clearTimeout(workerShutdownTimeout);

					// Wait additional short delay to ensure worker shutdown gracefully
					await Common.delay(shutdownTimeout + 3000);

					// Once shutdown is complete, terminate the worker
					try {

						await worker.terminate();

						Hub.logger('info', `Worker ${workerId} terminated after ${upTime}.`);
					}
					catch (err) {

						Hub.logger('error', `Error terminating instance: ${err}`);
					}

					resolve();
				};

				// Use once — listener removed automatically after first matching message
				worker.once('message', onShutdownReceived);

				// Safety timeout — force-terminate and resolve if worker never responds
				workerShutdownTimeout = setTimeout(async () => {

					worker.off('message', onShutdownReceived);

					Hub.logger('info', `Worker ${workerId} did not acknowledge shutdown within ${workerTimeoutMs}ms. Forcing termination.`);

					try {

						await worker.terminate();
					}
					catch (e) {}

					resolve();

				}, workerTimeoutMs);

				// Send a "shutdown" message to the worker
				worker.postMessage({

					type: HUB_TO_WORKER.SHUTDOWN
				});
			});

			terminationPromises.push(shutdownPromise);
		}

		// Wait for all workers to finish before starting the shutdown timeout
		try {

			await Promise.all(terminationPromises);

			clearTimeout(timeOutShutdown);

			Hub.logger('info', 'All workers have been terminated. Proceeding with shutdown.');

			// Start shutdown timeout after all workers are processed
			setTimeout(() => {

				process.exit(1);

			}, (shutdownTimeout + 3000));

		}
		catch (err) {

			Hub.logger('error', `Error during shutdown: ${err}`);
		}
	}
}


// Console recovery for the Hub's SQLite auth stores, mirroring the instance `reset` commands.
//   reset users    — clear Hub users/roles; the owner re-seeds from the Hub password on next start
//   reset apikeys  — clear all Hub API keys
//   reset audit    — clear the Hub audit log
//   reset password — reset the Hub login password to 'admin' AND clear users so the owner re-seeds
// A snapshot is taken before any wipe (see HubStore.resetTable), so even a reset is recoverable.
async function handleHubReset() {

	const sub = process.argv[3] ? process.argv[3].toLowerCase() : '';
	const pathMod = require('path');

	const hubData = await Common.getConfig(hubConfigFile);
	const dbPath = pathMod.join(hubDataDir, 'hub.db');

	const storeState = HubStore.init({
		path: dbPath,
		backupDir: pathMod.join(hubDataDir, 'backups')
	});

	if (!storeState.available) {

		console.log('\nHub storage unavailable — Node 22.13+ is required for built-in SQLite. Nothing to reset.');
		process.exit(1);
	}

	let tables = [];
	let label;

	if (sub == 'users') {

		tables = ['users'];
		label = 'ALL Hub users and roles (the initial owner re-seeds from the Hub password on next start)';
	}
	else if (sub == 'apikeys') {

		tables = ['api_keys'];
		label = 'ALL Hub API keys';
	}
	else if (sub == 'audit') {

		tables = ['audit_log'];
		label = 'the Hub audit log';
	}
	else if (sub == 'password') {

		tables = ['users'];
		label = 'the Hub login password back to the default "admin" and clear ALL users (the owner re-seeds from the new password on next start)';
	}
	else {

		console.log('\nUsage: node symbot-hub.js reset [users|apikeys|audit|password]');
		process.exit(1);
	}

	const warnMsg = '\n*** CAUTION *** You are about to reset ' + label + ' for the SymBot Hub!\n\n' +
					'Database: ' + dbPath + '\n';

	if (!System.confirmResetPrompt(warnMsg)) {

		process.exit(1);
	}

	if (sub == 'password') {

		const dataPass = await Common.genPasswordHash({ 'data': 'admin' });

		hubData['data']['password'] = dataPass['salt'] + ':' + dataPass['hash'];

		await Common.saveConfig(hubConfigFile, hubData.data);

		console.log('\nHub login password reset to default: admin');
	}

	for (const name of tables) {

		const res = HubStore.resetTable(name);

		console.log(name + ' reset: ' + res.success + (res.error ? ' (' + res.error + ')' : ''));
	}

	HubStore.close();

	console.log('\nReset finished.');

	process.exit(1);
}


async function start() {

	if (isMainThread) {

		if (process.argv[2] && process.argv[2].toLowerCase() == 'reset') {

			await handleHubReset();
			return;
		}

		startHub();
	}
	else {

		startWorker();
	}
}


start();
