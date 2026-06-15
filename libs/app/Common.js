'use strict';

const fs   = require('fs');
const fsp  = require('fs').promises;
const path = require('path');
const os   = require('os');
const multer = require('multer');

const pathRoot = path.resolve(__dirname, ...Array(2).fill('..'));

const crypto = require('crypto');
const Convert = require('ansi-to-html');
const fetch = require('node-fetch-commonjs');
const packageJson = require(pathRoot + '/package.json');

const convertAnsi = new Convert();

const logNotifications = pathRoot + '/logs/services/notifications/notifications{INSTANCE_NAME}.log';

let shareData;


async function getConfig(fileName) {

	let data;
	let success = false;

	try {
		data = JSON.parse(
			fs.readFileSync(pathRoot + '/config/' + fileName, {
				encoding: 'utf8',
				flag: 'r',
			})
		);

		success = true;
	} catch (e) {
		data = e;
	}

	return {
		success,
		data
	};
}


async function saveConfig(fileName, data, updated) {

	let err;
	let success = false;

	if ((updated == undefined || updated == null || updated == '') && updated !== false) {

		updated = true;
	}

	try {

		if (updated) {

			data.updated = new Date().toISOString();
		}

		fs.writeFileSync(
			pathRoot + '/config/' + fileName,
			JSON.stringify(data, null, 4)
		);

		success = true;
	} catch (e) {
		err = e;
	}

	return {
		success,
		data: err
	};
}


async function updateConfig(req, res) {

	const body = req.body;
	const sessionId = req.session.id;
	const mongodburl = body.mongodburl;
	const password = body.password;
	const passwordNew = body.passwordnew;
	const apiKey = body.apikey;

	const telegram = body.telegram_enabled;
	const telegramTokenId = body.telegram_token_id;
	const telegramUserId = body.telegram_user_id;

	const signals3CQS = body.signals_3cqs_enabled;
	const signals3CQSApiKey = body.signals_3cqs_api_key;

	const ollamaHost = body.ollama_host;
	const ollamaApiKey = body.ollama_api_key;
	const ollamaModel = body.ollama_model;

	const openaiApiKey = body.openai_api_key;
	const openaiModel = body.openai_model;
	const openaiBaseUrl = body.openai_base_url;

	const aiProviderSelected = body.ai_provider;

	const cronBackup = body.cron_backup_enabled;
	const cronBackupSchedule = body.cron_backup_schedule;
	const cronBackupPassword = body.cron_backup_password;
	const cronBackupMax = Number(body.cron_backup_max ?? 1) || 1;
	const cronBackupIncludeChats = convertBoolean(body.cron_backup_include_chats, true);

	const ctxCompEnabled    = convertBoolean(body.ctx_compression_enabled, true);
	const ctxCompThreshold  = parseInt(body.ctx_compression_threshold) || 80000;
	const ctxCompProtectN   = parseInt(body.ctx_compression_protect_n)  || 10;

	const cbEnabled        = convertBoolean(body.cb_enabled, true);


	const cbDealRatio      = Math.min(Math.max(parseFloat(body.cb_deal_ratio_threshold)   || 0.5,  0.1), 1.0);
	const cbDealWindow     = Math.min(Math.max(parseInt(body.cb_deal_ratio_window_secs)   || 30,   5),   300);
	const cbPriceDrop      = Math.min(Math.max(parseFloat(body.cb_price_drop_percent)     || 5.0,  0.5), 50.0);
	const cbPriceWindow    = Math.min(Math.max(parseInt(body.cb_price_drop_window_secs)   || 60,   10),  600);
	const cbPriceDropEnabled = convertBoolean(body.cb_price_drop_enabled, true);
	const cbPauseDuration  = Math.min(Math.max(parseInt(body.cb_pause_duration_secs)      || 60,   10),  600);
	const cbRepeatWindow   = Math.min(Math.max(parseInt(body.cb_repeat_alert_window_secs) || 3600, 60),  86400);
	const cbPriceZeroAlert = Math.min(Math.max(parseInt(body.cb_price_zero_alert_count)   || 4,    2),   20);

	const sftp = body.sftp_enabled;
 	const sftpHost = body.sftp_host;
	const sftpPort = Number(body.sftp_port ?? 22) || 22;
	const sftpUsername = body.sftp_username;
	const sftpPassword = body.sftp_password;
	const sftpPrivateKeyInput = body.sftp_private_key;
	const sftpPrivateKeyClear = body.sftp_private_key_clear;
	const sftpPassphrase = body.sftp_passphrase;
	const sftpRemoteDirectory = body.sftp_remote_directory;

	let pairButtons = body.pairbuttons;
	let pairBlacklist = body.pairblacklist;

	let sftpEnabled = convertBoolean(sftp, false);
	let telegramEnabled = convertBoolean(telegram, false);
	let signals3CQSEnabled = convertBoolean(signals3CQS, false);
	let cronBackupEnabled = convertBoolean(cronBackup, false);

	// Provider dropdown is the single source of truth for which AI provider is active
	const aiProvider = (aiProviderSelected === 'openai' || aiProviderSelected === 'ollama') ? aiProviderSelected : 'none';
	const ollamaEnabled = aiProvider === 'ollama';
	const openaiEnabled = aiProvider === 'openai';

	let dbErr;
	let sftpPasswordFinal;
	let sftpPassphraseFinal;
	let sftpPrivateKeyFinal;
	let cronBackupPasswordFinal;
	let hubInstance = false;
	let dataMessage = 'Configuration Updated';

	const instanceName = await getInstanceName();

	if (instanceName && instanceName.trim() !== '') {

		hubInstance = true;
	}

	const appConfigFile = shareData.appData.app_config;

	if (pairButtons == undefined || pairButtons == null || pairButtons == '') {

		pairButtons = [];
	}
	else if (typeof pairButtons === 'string') {

		pairButtons = [pairButtons];
	}

	if (pairBlacklist == undefined || pairBlacklist == null || pairBlacklist == '') {

		pairBlacklist = [];
	}
	else if (typeof pairBlacklist === 'string') {

		pairBlacklist = [pairBlacklist];
	}

	const pairButtonsUC = pairButtons.map(data => data.toUpperCase());
	const pairBlacklistUC = pairBlacklist.map(data => data.toUpperCase());

	const dataPass = shareData.appData.password.split(':');

	let success = await verifyPasswordHash( { 'salt': dataPass[0], 'hash': dataPass[1], 'data': password } );

	if (success) {

		let disconnectClients = false;

		let data = await getConfig(appConfigFile);

		let appConfig = data.data;

		if (passwordNew != undefined && passwordNew != null && passwordNew != '') {

			disconnectClients = true;

			const dataPassNew = await genPasswordHash({ 'data': passwordNew });

			const passwordHashed = dataPassNew['salt'] + ':' + dataPassNew['hash'];

			// Re-encrypt all existing SFTP secrets under the new password before
			// updating shareData.appData.password. The old password hash is still
			// in shareData.appData.password at this point — that is the same key
			// material used when the secrets were originally stored. The new hash
			// (passwordHashed) is what decrypt/encrypt will use going forward.
			const secretsToReEncrypt = [
				{ key: ['cron_backup', 'password'] },
				{ key: ['cron_backup', 'sftp', 'password'] },
				{ key: ['cron_backup', 'sftp', 'passphrase'] },
				{ key: ['cron_backup', 'sftp', 'private_key'] },
			];

			const oldPasswordKey = shareData.appData.password;

			for (const secret of secretsToReEncrypt) {

				const encryptedValue = secret.key.reduce((obj, k) => obj?.[k], appConfig);

				if (encryptedValue) {

					// Decrypt with the current (old) password hash
					const decObj = await shareData.System.decrypt(encryptedValue, oldPasswordKey);

					if (decObj.success) {

						// Re-encrypt with the new password hash
						const reEncObj = await shareData.System.encrypt(decObj.data, passwordHashed);

						if (reEncObj.success) {

							// Write re-encrypted value back into appConfig
							const keys = secret.key;
							const target = keys.slice(0, -1).reduce((obj, k) => obj[k], appConfig);
							target[keys[keys.length - 1]] = reEncObj.data;
						}
					}
				}
			}

			appConfig['password'] = passwordHashed;
			shareData['appData']['password'] = passwordHashed;

			// Remove all other existing sessions to require login again
			const collection = await shareData.DB.mongoose.connection.db.collection('sessions');
			const query = { '_id': { '$ne': sessionId } };

			const sessionData = await collection.deleteMany(query).catch(e => {});
		}

		if (apiKey != undefined && apiKey != null && apiKey != '') {

			disconnectClients = true;

			const apiKeyHashed = await genApiKey(apiKey);

			appConfig['api']['key'] = apiKeyHashed;
			shareData['appData']['api_key'] = apiKeyHashed;

			// Set API token
			await setToken();
		}

		if (disconnectClients) {

			await shareData.WebServer.disconnectAllClients();
		}

		if (sftpPassword) {

			const sftpPasswordEncObj = await shareData.System.encrypt(sftpPassword, shareData.appData.password);

			if (sftpPasswordEncObj.success) {

				sftpPasswordFinal = sftpPasswordEncObj.data;
			}
		}
		else {

			sftpPasswordFinal = '';
		}

		if (sftpPassphrase) {

			const sftpPassphraseEncObj = await shareData.System.encrypt(sftpPassphrase, shareData.appData.password);

			if (sftpPassphraseEncObj.success) {

				sftpPassphraseFinal = sftpPassphraseEncObj.data;
			}
		}
		else {

			sftpPassphraseFinal = '';
		}

		if (sftpPrivateKeyInput) {

			// Encrypt the pasted private key content and store the encrypted blob.
			// If the field was submitted empty the existing encrypted value in
			// appConfig is preserved below — the key is never cleared by accident.
			const sftpPrivateKeyEncObj = await shareData.System.encrypt(sftpPrivateKeyInput, shareData.appData.password);

			if (sftpPrivateKeyEncObj.success) {

				sftpPrivateKeyFinal = sftpPrivateKeyEncObj.data;
			}
		}
		// If sftpPrivateKeyInput is empty, sftpPrivateKeyFinal stays undefined
		// and the appConfig write below preserves the existing encrypted value.

		const cronBackupPasswordEncObj = await shareData.System.encrypt(cronBackupPassword, shareData.appData.password);

		if (cronBackupPasswordEncObj.success) {

			cronBackupPasswordFinal = cronBackupPasswordEncObj.data;
		}

		const telegramEnabledOrig = shareData['appData']['telegram_enabled'];
		const signals3CQSEnabledOrig = shareData['appData']['signals_3cqs_enabled'];

		appConfig['bots']['pair_buttons'] = pairButtonsUC;
		shareData['appData']['bots']['pair_buttons'] = pairButtonsUC;

		appConfig['bots']['pair_blacklist'] = pairBlacklistUC;
		shareData['appData']['bots']['pair_blacklist'] = pairBlacklistUC;

		appConfig['signals']['3CQS']['api_key'] = signals3CQSApiKey;
		appConfig['signals']['3CQS']['enabled'] = signals3CQSEnabled;
		shareData['appData']['signals_3cqs_enabled'] = signals3CQSEnabled;

		appConfig['telegram']['enabled'] = telegramEnabled;
		appConfig['telegram']['token_id'] = telegramTokenId;
		appConfig['telegram']['notify_user_id'] = telegramUserId;

		appConfig['cron_backup']['enabled'] = cronBackupEnabled;
		appConfig['cron_backup']['schedule'] = cronBackupSchedule;
		appConfig['cron_backup']['password'] = cronBackupPasswordFinal;
		appConfig['cron_backup']['max'] = cronBackupMax;
		appConfig['cron_backup']['include_chats'] = cronBackupIncludeChats;

		if (!appConfig['circuit_breaker']) appConfig['circuit_breaker'] = {};
		appConfig['circuit_breaker']['enabled']               = cbEnabled;
		appConfig['circuit_breaker']['deal_ratio_threshold']  = cbDealRatio;
		appConfig['circuit_breaker']['deal_ratio_window_secs']= cbDealWindow;
		appConfig['circuit_breaker']['price_drop_percent']    = cbPriceDrop;
		appConfig['circuit_breaker']['price_drop_window_secs']= cbPriceWindow;
		appConfig['circuit_breaker']['price_drop_enabled']    = cbPriceDropEnabled;
		appConfig['circuit_breaker']['pause_duration_secs']   = cbPauseDuration;
		appConfig['circuit_breaker']['repeat_alert_window_secs'] = cbRepeatWindow;
		appConfig['circuit_breaker']['price_zero_alert_count']   = cbPriceZeroAlert;

		// Context compression settings
		if (!appConfig['ai'])                      appConfig['ai'] = {};
		if (!appConfig['ai']['context_compression']) appConfig['ai']['context_compression'] = {};
		appConfig['ai']['context_compression']['enabled']         = ctxCompEnabled;
		appConfig['ai']['context_compression']['threshold_chars'] = ctxCompThreshold;
		appConfig['ai']['context_compression']['protect_last_n']  = ctxCompProtectN;
		if (!shareData.appData.ai)                 shareData.appData.ai = {};
		shareData.appData.ai.context_compression = appConfig['ai']['context_compression'];

		// Update live appData so circuit breaker takes effect immediately without restart
		shareData.appData.circuit_breaker = appConfig['circuit_breaker'];


		appConfig['cron_backup']['sftp']['enabled'] = sftpEnabled;
		appConfig['cron_backup']['sftp']['host'] = sftpHost;
		appConfig['cron_backup']['sftp']['port'] = sftpPort;
		appConfig['cron_backup']['sftp']['username'] = sftpUsername;
		appConfig['cron_backup']['sftp']['password'] = sftpPasswordFinal;
		// Private key write logic:
		// - Clear flag set → explicitly erase the stored key
		// - New key submitted → store the newly encrypted value
		// - Neither → leave the existing stored value untouched
		if (sftpPrivateKeyClear === '1') {

			appConfig['cron_backup']['sftp']['private_key'] = '';
		}
		else if (sftpPrivateKeyFinal !== undefined) {

			appConfig['cron_backup']['sftp']['private_key'] = sftpPrivateKeyFinal;
		}
		appConfig['cron_backup']['sftp']['passphrase'] = sftpPassphraseFinal;
		appConfig['cron_backup']['sftp']['remote_directory'] = sftpRemoteDirectory;

		// Ensure ai sub-objects exist before writing — app.json files on the old
		// schema may be missing 'provider' or the 'openai' sub-object entirely,
		// which would throw a TypeError when trying to set properties on undefined.
		if (!appConfig['ai']) {
			appConfig['ai'] = {};
		}

		if (!appConfig['ai']['ollama']) {
			appConfig['ai']['ollama'] = {};
		}

		if (!appConfig['ai']['openai']) {
			appConfig['ai']['openai'] = {};
		}

		appConfig['ai']['provider'] = aiProvider;

		appConfig['ai']['ollama']['enabled'] = ollamaEnabled;
		appConfig['ai']['ollama']['host'] = ollamaHost;
		appConfig['ai']['ollama']['api_key'] = ollamaApiKey;
		appConfig['ai']['ollama']['model'] = ollamaModel;

		appConfig['ai']['openai']['enabled'] = openaiEnabled;
		appConfig['ai']['openai']['api_key'] = openaiApiKey;
		appConfig['ai']['openai']['model'] = openaiModel;
		appConfig['ai']['openai']['base_url'] = openaiBaseUrl;

		shareData['appData']['telegram_id'] = telegramUserId;
		shareData['appData']['telegram_enabled'] = telegramEnabled;
		shareData['appData']['telegram_enabled_config'] = telegramEnabled;

		shareData['appData']['cron_backup'] = appConfig['cron_backup'];

		if (shareData.appData.config_mode) {

			try {

				const db = await shareData.System.connectDb(mongodburl);

				await db.close();

				if (db == undefined || db == null || db == '') {

					dbErr = 'Unabled to connect to database';
				}
			}
			catch(e) {

				dbErr = e.message;
			}

			if (dbErr != undefined && dbErr != null && dbErr != '') {

				success = false;
				dataMessage = 'Database Error: ' + dbErr;
			}
			else {

				let msg = 'Database URL modified. Shutting down. Please restart for changes to take effect.';

				dataMessage = msg;

				// Successful configuration. Shutdown to start fresh config.
				appConfig['mongo_db_url'] = mongodburl;

				logger(msg, true);

				setTimeout(() => { shareData.System.shutDown(); }, 1500);
			}
		}

		if (success) {

			await saveConfig(appConfigFile, appConfig);

			// Stop / Restart AI client
			shareData.AIClient.stop();

			if (openaiEnabled) {

				shareData.AIClient.start('openai', {
					api_key: openaiApiKey,
					model: openaiModel,
					base_url: openaiBaseUrl,
				});
			}
			else if (ollamaEnabled) {

				shareData.AIClient.start('ollama', {
					host: ollamaHost,
					api_key: ollamaApiKey,
					model: ollamaModel,
				});
			}

			// Restart Signals
			startSignals();

			// Restart Telegram based on if Hub in use as it may be overriding instance settings
			if (!hubInstance || (hubInstance && telegramEnabledOrig)) {

				shareData.Telegram.stop();

				if (telegramEnabled) {

					await delay(1000);
					shareData.Telegram.start(telegramTokenId, telegramEnabled);
				}
			}

			if (!cronBackupEnabled) {

				await shareData.System.cronBackupStart('', false);
			}

			if (cronBackupEnabled && (cronBackupSchedule != undefined && cronBackupSchedule != null && cronBackupSchedule != '')) {

				await shareData.System.cronBackupStart(cronBackupSchedule, true);
			}

			if (sftpEnabled && sftpHost && sftpPort) {

				const tempDir = path.join(pathRoot, 'temp');

				if (!fs.existsSync(tempDir)) {

					fs.mkdirSync(tempDir, {
						recursive: true
					});
				}

				const tempFileName = `sftp-test-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.bin`;
				const localFilePath = path.join(tempDir, tempFileName);

				try {

					const kBytes = 1;

					const randomData = crypto.randomBytes(kBytes * 1024);

					fs.writeFileSync(localFilePath, randomData);

					const res = await shareData.System.sftpUploadFile(localFilePath, true);

					if (!res.success) {
						
						dataMessage = 'WARNING (SFTP): ' + res.error;
					}
				}
				catch (err) {

					dataMessage = 'WARNING (SFTP): ' + err;
				}
				finally {

					if (fs.existsSync(localFilePath)) {
		
						fs.unlinkSync(localFilePath);
					}
				}
			}
		}

		let obj = { 'success': success, 'data': dataMessage };
		
		res.send(obj);
	}
	else {

		let obj = { 'success': false, 'data': 'Password Incorrect' };
		
		res.send(obj);
	}
}


async function startSignals() {

	// Start signals after everything else is finished loading

	const appConfigFile = shareData.appData.app_config;

	const appConfig = await getConfig(appConfigFile);

	let enabled = shareData.appData['signals_3cqs_enabled'];

	const socket = await shareData.Signals3CQS.start(enabled, appConfig['data']['signals']['3CQS']['api_key']);
}


async function pairBlackListed(pair) {

    let pairInvalid = false;

	const pairBlackList = shareData.appData.bots['pair_blacklist'];

    function wildCardToRegExp(str) {

		return new RegExp('^' + str.split(/\*+/).map(regExpEscape).join('.*') + '$');
    }

    function regExpEscape(str) {

		return str.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
    }

    for (let x = 0; x < pairBlackList.length; x++) {

		let pairRegExp = wildCardToRegExp(pairBlackList[x]);

        if (new RegExp(pairRegExp, 'i').test(pair)) {

			pairInvalid = true;

			break;
        }
    }

    return pairInvalid;
}


async function getData(fileName) {

	let data;
	let err = '';
	let success = true;

	if (fs.existsSync(fileName)) {

		try {
				data = fs.readFileSync(fileName, {
							encoding: 'utf8',
							flag: 'r'
						}
					);
			}
			catch (e) {

				err = e;
				success = false;
			}
	}
	else {

		success = false;
		err = fileName + ' does not exist';
	}

	return ({ 'success': success, 'data': data, 'error': err });
}


async function saveData(fileName, data) {

	let err = '';

	try {

		fs.writeFileSync(fileName, data);
	}
	catch (e) {

		err = e;
	}

	return err;
}


async function fetchURL(data) {

	let url = data['url'];
	let method = data['method'];
	let headers = data['headers'];
	let body = data['body'];

	let res;
	let errMsg;

	let success = true;
	let isJSON = false;

	if (method == undefined || method == null || method == '') {

		method = 'get';
	}

	const response = await fetch(url, {
		method: method,
		headers: headers,
		body: JSON.stringify(body),
	})
	.then(response => {

		return response;
	})
	.catch(err => {

		success = false;
		errMsg = err;

		return err;
	});

	if (success) {

		res = await response.text();

		try {

			res = JSON.parse(res);

			isJSON = true;
		}
		catch(e) {

			isJSON = false;
		}
	}

	let resObj = {
					'success': success,
					'json': isJSON,
					'data': res,
					'error': errMsg
				 };

	return resObj;
}


async function makeDir(dirName) {

	let dir = pathRoot + '/' + dirName;

	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir);
	}
}


async function showTradingView(req, res) {

	let jquery = convertBoolean(req.query.jquery, true);
	let script = convertBoolean(req.query.script, true);
	let containerId = req.query.containerId;
	let width = req.query.width;
	let height = req.query.height;
	let theme = req.query.theme;
	let exchange = req.query.exchange;
	let pair = req.query.pair;

	if (containerId == undefined || containerId == null || containerId == '') {

		containerId = 'tvChart' + Math.floor(1000 + Math.random() * 90000);
	}

	if (theme == undefined || theme == null || theme == '') {

		theme = 'dark';
	}

	if (exchange == undefined || exchange == null || exchange == '') {

		exchange = 'BINANCE';
	}

	if (pair == undefined || pair == null || pair == '') {

		pair = 'BTC_USDT';
	}

	let tvData = await getData(pathRoot + '/libs/webserver/public/data/tradingViewData.json');

	let dataObj = {
					'container_id': containerId,
					'jquery': jquery,
					'script': script,
					'width': width,
					'height': height,
					'theme': theme,
					'exchange': exchange.toUpperCase(),
					'pair': pair.replace(/[^a-z0-9]/gi, '').toUpperCase(),
					'tv_data': tvData.data
				  };

	res.render( 'tradingView', { 'appData': shareData.appData, 'data': dataObj } );
}


async function sendNotification(data) {

	let maxNotifications = 500;
	let fileName = logNotifications;

	const instanceName = await getInstanceName();

	if (instanceName && instanceName.trim() !== '') {

		fileName = fileName.replace('{INSTANCE_NAME}', `-${instanceName}`);
	}
	else {

		fileName = fileName.replace('{INSTANCE_NAME}', '');
	}

	let msg = data['message'];
	let msgType = data['type'];
	let telegramId = data['telegram_id'];

	if (msgType == undefined || msgType == null || msgType == '') {

		msgType = 'info';
	}

	let obj = { 'date': new Date(), 'type': msgType, 'message': msg };

	// Get notifications
	let historyArr = await getNotificationHistory();

	historyArr.push(obj);

	historyArr = historyArr.slice(-maxNotifications);

	if (telegramId != undefined && telegramId != null && telegramId != '') {

		shareData.Telegram.sendMessage(telegramId, msg);
	}

	// Relay message to WebSocket notifications room
	sendSocketMsg({

		'room': 'notifications',
		'type': 'notification',
		'message': msg
	});

	// Save notifications
	saveData(fileName, JSON.stringify(historyArr));
}


async function getNotificationHistory(client, data) {

	let fileName = logNotifications;

	const instanceName = await getInstanceName();

	if (instanceName && instanceName.trim() !== '') {

		fileName = fileName.replace('{INSTANCE_NAME}', `-${instanceName}`);
	}
	else {

		fileName = fileName.replace('{INSTANCE_NAME}', '');
	}

	let historyArr = [];

	try {
		
		let data = await getData(fileName);

		if (data.success) {

			historyArr = JSON.parse(data.data);
		}
	}
	catch (e) {

	}

	if (client) {

		client.emit('history', historyArr);
	}
	else {

		return historyArr;
	}
}


async function listFiles(type = 'logs') {

	let allFiles = [];

	const dir = `${pathRoot}/${type}`;
	const files = fs.readdirSync(dir);

	for (let fileName of files) {

		const filePath = `${dir}/${fileName}`;
		const stats = fs.statSync(filePath);

		if (!stats.isDirectory()) {

			allFiles.push({
				'name': fileName,
				'created': stats.ctime,
				'modified': stats.mtime,
				'size': stats.size,
				'size_human': numFormatter(stats.size)
			});
		}
	}

	return allFiles.length > 0 ? sortByKey(allFiles, 'created').reverse() : [];
}


async function showFiles(type = 'logs', req, res, isHub) {

	let filesFiltered;

	const instanceName = await getInstanceName();
	const files = await listFiles(type);

	if (instanceName && !isHub) {

		const ext = type === 'logs' ? '.log' : '.enc';
		const regex = new RegExp(`${instanceName}.*\\${ext}$`);

		filesFiltered = files.filter(file => regex.test(file.name));
	}
	else {

		filesFiltered = files;
	}

	res.render(`${type}View`, {
		'appData': shareData.appData,
		'files': filesFiltered,
		isHub
	});
}


async function downloadFile(fileName, type = 'logs', req, res) {

	const filePath = path.join(pathRoot, type, fileName);

	fs.access(filePath, fs.constants.F_OK, (err) => {

		if (err) {

			// File doesn't exist
			if (!res.headersSent) {

				return res.status(404).send({

					error: 'File not found'
				});
			}

			return;
		}

		res.download(filePath, (err) => {

			if (err && !res.headersSent) {

				res.status(err.statusCode || 500).send({
					error: err.message
				});
			}
			else if (err) {

				// Headers already sent
				//console.warn('Download error (after headers sent):', err.message);
			}
		});
	});
}


async function logger(data, consoleLog) {

	const instanceName = await getInstanceName();

	if (typeof data !== 'string') {
		data = JSON.stringify(data);
	}

	let dateNow = new Date().toISOString();

	let logData = `${dateNow} ${data}`;

	if(process.argv[2] && process.argv[2].toLowerCase() == 'clglite') {
		console.log(logData);
		return;
	}

	if (consoleLog || shareData.appData.console_log) {

		console.log(logData);
	}

	const dateObj = getDateParts(dateNow);

	const fileName = pathRoot + '/logs/' + dateObj.date + (instanceName ? '-' + instanceName : '') + '.log';

	const logDataOrig = logData;

	logData = logData.replace(
		/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
		''
	);

	logData = logData.replace(/[\t\r\n]+/g, ' ');

	fs.appendFileSync(fileName, logData + '\n', 'utf8');

	if (shareData && shareData.WebServer) {

		sendSocketMsg({

			'room': 'logs',
			'type': 'log',
			'message': convertAnsi.toHtml(logDataOrig)
		});
	}
}


function logMonitor() {

	const hoursInterval = 4;

	let maxDays = shareData['appData']['max_log_days'];

	if (maxDays == undefined || maxDays == null || maxDays < 1) {

		maxDays = 10;
	}

	// Monitor and remove old logs and backups
	setInterval(() => {

		delFiles(pathRoot + '/logs', maxDays);
		delFiles(pathRoot + '/temp', 1, true);
		delFiles(pathRoot + '/uploads', 1, true);
		delFiles(pathRoot + '/downloads', 1, true);

	}, (hoursInterval * (60 * 60 * 1000)));
}


async function delay(msec) {

	return new Promise(resolve => {

		setTimeout(() => { resolve('') }, msec);
	});
}


async function getInstanceName() {

	let instanceName = '';

	try {

		if (shareData['appData']['worker_data'] && typeof shareData['appData']['worker_data'] === 'object') {

			instanceName = shareData['appData']['worker_data']['name'];
		}
	}
	catch(e) {}

	return instanceName;
}


async function getSignalConfigs() {

	let isError;
	let count = 1;
	let success = true;
	let configs = {};

	let dir = pathRoot + '/libs/signals';

	let files = fs.readdirSync(dir);

	for (let i in files) {

		let file = dir + '/' + files[i];

		let stats = fs.statSync(file);

		let created = stats.ctime;
		let modified = stats.mtime;

		if (stats.isDirectory()) {

			let signalFile = file + '/signals.json';

			if (fs.existsSync(signalFile)) {

				try {
					let data = JSON.parse(
						fs.readFileSync(signalFile, {
							encoding: 'utf8',
							flag: 'r'
						})
					);

					data.file = file;

					let dataRoot = {};
					dataRoot['PROVIDER' + count] = data;

					configs = Object.assign({}, configs, dataRoot);

					count++;
				}
				catch (e) {
							isError = 'File: ' + signalFile + ' ' + e;
							success = false;
						  }
			}
		}
	}

	return { 'success': success, 'data': configs, 'error': isError };
}


function delFiles(directory, days, deleteSubdirs) {

    const dateNow = new Date();
    const secondsPerDay = 86400;

    function isDirectoryEmpty(dir) {

        return fs.readdirSync(dir).length === 0;
    }

    function getDirectoryModificationTime(dir) {

        try {
            const stats = fs.statSync(dir);
            return stats.mtime;
        }
		catch (err) {

			//console.error(`Error getting modification time for directory ${dir}:`, err);
            return null;
        }
    }

    function deleteFilesInDir(dir, days) {

        let isDirEmpty = true;
        let dirModifiedTime = getDirectoryModificationTime(dir);

        fs.readdirSync(dir).forEach(file => {

            const filePath = path.join(dir, file);
            const stats = fs.statSync(filePath);
            const diffSec = (dateNow.getTime() - stats.mtime.getTime()) / 1000;

            if (stats.isDirectory()) {
                // Recursively process subdirectories
                if (deleteSubdirs) {
                    deleteFilesInDir(filePath, days);

                    // Get the updated modification time after processing subdirectory
                    dirModifiedTime = getDirectoryModificationTime(dir);

                    // Remove empty subdirectory if it's not the main directory
                    if (dir !== directory && isDirectoryEmpty(filePath)) {
                        fs.rmdirSync(filePath);
                    }
                }
                isDirEmpty = false; // A directory is not empty if it has files or subdirectories
            } else if (diffSec >= secondsPerDay * days) {
                fs.unlinkSync(filePath);
                isDirEmpty = false;
            }
        });

        // Remove directory if it's empty, deleteSubdirs is true, and it's not the main directory
        if (deleteSubdirs && dir !== directory && isDirEmpty && isDirectoryEmpty(dir)) {
            // Check if the directory modification time is old enough to be deleted
            const dirAgeSec = (dateNow.getTime() - dirModifiedTime.getTime()) / 1000;
            if (dirAgeSec >= secondsPerDay * days) {
                fs.rmdirSync(dir);
            }
        }
    }

    deleteFilesInDir(directory, days);
}


async function getProcessInfo() {

	let memoryUsage = process.memoryUsage();

	Object.keys(memoryUsage).forEach((key) => {

		memoryUsage[key] = ((memoryUsage[key] / (1024 * 1024)).toFixed(2)) + 'MB';
	});

	const obj = {
					'pid': process.pid,
					'memory_usage': memoryUsage,
					'file_name': path.basename(shareData.appData.app_filename),
				};

	return obj;
}


function getTimeZone(date) {

	let timeZoneOffset;

	if (date == undefined || date == null) {

		date = new Date();
	}

	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

	try {

		timeZoneOffset = Intl.DateTimeFormat('ia', {

								timeZone: tz,
								timeZoneName: 'longOffset'
							})
							.formatToParts(date)
							.find((i) => i.type === 'timeZoneName').value
							.slice(3);
	}
	catch(e) {

	}

	if (timeZoneOffset == undefined || timeZoneOffset == null) {

		timeZoneOffset = date.getTimezoneOffset();

		let sign = (timeZoneOffset < 0) ? '+' : '-';
		let mins = Math.abs(timeZoneOffset);
		let hours = Math.floor(mins / 60);
		mins = mins - 60 * hours;

		timeZoneOffset = sign + ('0' + hours).slice(-2) + ':' + ('0' + mins).slice(-2);
	}
 
	return ({ 'timezone': tz, 'offset': timeZoneOffset });
}


function getDateParts(date, utc) {

	let year;
	let month;
	let day;
	let hour;
	let min;
	let sec;

	let dateObj = new Date(date);

	if (!utc) {
		year = dateObj.getFullYear();
		month = dateObj.getMonth() + 1;
		day = dateObj.getDate();

		hour = dateObj.getHours();
		min = dateObj.getMinutes();
		sec = dateObj.getSeconds();
	} else {
		year = dateObj.getUTCFullYear();
		month = dateObj.getUTCMonth() + 1;
		day = dateObj.getUTCDate();

		hour = dateObj.getUTCHours();
		min = dateObj.getUTCMinutes();
		sec = dateObj.getUTCSeconds();
	}

	if (day < 10) {
		day = '0' + day;
	}

	if (month < 10) {
		month = '0' + month;
	}

	if (hour < 10) {
		hour = '0' + hour;
	}

	if (min < 10) {
		min = '0' + min;
	}

	if (sec < 10) {
		sec = '0' + sec;
	}

	let datePart = year + '-' + month + '-' + day;
	let timePart = hour + ':' + min + ':' + sec;

	let hourTemp = parseInt(timePart.split(':')[0]) % 12;

	if (hourTemp < 10) {
		hourTemp = '0' + hourTemp;
	}

	let timePartAmPm =
		(hourTemp == 0 ? '12' : hourTemp) +
		':' +
		timePart.split(':')[1] +
		' ' +
		(parseInt(parseInt(timePart.split(':')[0]) / 12) < 1 ? 'AM' : 'PM');

	let dateParts = {
		year: year,
		month: month,
		day: day,
		hour: hour,
		minute: min,
		second: sec,
		date: datePart,
		time: timePart,
		timeAmPm: timePartAmPm,
	};

	return dateParts;
}


function timeDiff(dateStart, dateEnd) {

	let diff = Math.abs(dateEnd - dateStart) / 1000;

	let diffString = '';

	let days = Math.floor(diff / 86400);
	diff -= days * 86400;

	let hours = Math.floor(diff / 3600) % 24;
	diff -= hours * 3600;

	let minutes = Math.floor(diff / 60) % 60;
	diff -= minutes * 60;

	let seconds = Math.floor(diff / 1) % 60;
	diff -= seconds * 60;

	if (days > 0) {
		diffString += days === 1 ? `${days}d` : `${days}d`;
	}

	if (hours > 0) {
		diffString += hours === 1 ? ` ${hours}h` : ` ${hours}h`;
	}

	if (minutes > 0) {
		diffString += minutes === 1 ? ` ${minutes}m` : ` ${minutes}m`;
	}

	if (seconds > 0) {
		diffString += seconds === 1 ? ` ${seconds}s` : ` ${seconds}s`;
	}

	diffString = diffString.trim();

	return diffString;
}

function dealDurationMinutes(dateStart, dateEnd) {

	let diff = Math.abs(dateEnd - dateStart) / 1000;

	let minutes = Math.floor(diff / 60);

	return minutes;

}


function freezeProperty(obj, keys) {

	const list = Array.isArray(keys) ? keys : [keys];

	for (const key of list) {

		const value = obj[key];

		Object.defineProperty(obj, key, {
			value,
			writable: false,
			configurable: false,
			enumerable: true
		});
	}

	return obj;
}


function convertBoolean(param, defaultVal) {

	let paramBool;

	if (param) {

		if (typeof param == 'boolean') {

        	paramBool = param;
		}
		else {

			paramBool = param.toLowerCase() === 'false' ? false : true;
		}
	}
	else {

		if (typeof defaultVal == 'boolean') {

			paramBool = defaultVal;
		}
	}

	return paramBool;
}


function convertToCamelCase(obj) {

	return Object.fromEntries(
		Object.entries(obj).map(([key, value]) => [
			key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()),
			value
		])
	);
}


function convertStringToNumeric(obj) {

    if (typeof obj !== 'object' || obj === null) {

        return obj;
    }

    if (Array.isArray(obj)) {

        for (let i = 0; i < obj.length; i++) {

			obj[i] = convertStringToNumeric(obj[i]);
        }
    }
	else {

        for (const key in obj) {

			if (obj.hasOwnProperty(key)) {

				if (typeof obj[key] === 'string' && isNumeric(obj[key])) {

					obj[key] = parseFloat(obj[key]);

                } else if (typeof obj[key] === 'object') {

                    obj[key] = convertStringToNumeric(obj[key]);
                }
            }
        }
    }

    return obj;
}


function isNumeric(str) {

    return /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(str);
}


function hashCode(str) {

	let h;

	for (let i = 0; i < str.length; i++) {

		h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
	}

	return Math.abs(h);
}


function numToBase26(num) {

	num = parseInt(num, 10);

	let str = num.toString(26).toUpperCase();

	return str;
}


function roundAmount(amount) {

	amount = Number(amount);

	if (Math.abs(amount) >= 0.01) {

		amount = Number(amount.toFixed(2));
	}
	else {

		amount = Number(amount.toFixed(8));
	}

	return amount;
}


function adjustDecimals(value, ...arr) {

	const numValue = Number(value);

	if (isNaN(numValue)) {
		return 0;
	}

	const flattenedArr = arr.flat();

	const decimalPlaces = flattenedArr
		.map(v => (isNaN(Number(v)) ? 0 : (String(v).split('.').length > 1 ? String(v).split('.')[1].length : 0)))
		.filter(v => v > 0);

	const maxDecimals = decimalPlaces.length > 0 ? Math.max(...decimalPlaces) : 0;

	return numValue.toFixed(maxDecimals);
}


function getPrecision(arr) {

	return 10 ** -Math.max(...arr.map(n => (n.toString().split('.')[1] || '').length));
}


function uuidv4() {

	if (crypto.randomUUID) return crypto.randomUUID();

	const bytes = crypto.randomBytes(16);

	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;

	const hex = bytes.toString('hex');

	return (
		hex.substr(0, 8) + '-' +
		hex.substr(8, 4) + '-' +
		hex.substr(12, 4) + '-' +
		hex.substr(16, 4) + '-' +
		hex.substr(20, 12)
	);
}


function numFormatter(num) {

	num = Number(num);

	if (num > 999 && num < 1000000) {

		return (num / 1000).toFixed(2) + 'k';

	}
	else if (num > 1000000000000) {

		return (num / 1000000000000).toFixed(2) + 'T';
	}
	else if (num > 1000000000) {

		return (num / 1000000000).toFixed(2) + 'B';
	}
	else if (num > 1000000) {

		return (num / 1000000).toFixed(2) + 'M'; 
	}
	else if (num < 900) {

		return num;
	}
}


function sortByKey(array, key) {

	return array.sort(function(a, b) {
		let x = a[key];
		var y = b[key];
		return x < y ? -1 : x > y ? 1 : 0;
	});
}


function mergeObjects(origObj, newObj) {

	let mergeObj = { ...newObj, ...origObj };

	return mergeObj;
}


function deepCopy(obj, seen = new WeakMap()) {

	if (obj === null || typeof obj !== 'object') return obj;
	if (seen.has(obj)) return seen.get(obj);

	if (obj instanceof Date) return new Date(obj);
	if (obj instanceof RegExp) return new RegExp(obj);
	if (obj instanceof Map) return new Map([...obj].map(([k, v]) => [deepCopy(k, seen), deepCopy(v, seen)]));
	if (obj instanceof Set) return new Set([...obj].map(v => deepCopy(v, seen)));

	// Preserve prototype chain
	const copy = Array.isArray(obj) ? [] : Object.create(Object.getPrototypeOf(obj));
	seen.set(obj, copy);

	// Get all own property keys (string and symbol), including non-enumerable
	const keys = [
		...Object.getOwnPropertyNames(obj),
		...Object.getOwnPropertySymbols(obj)
	];

	for (const key of keys) {

		const desc = Object.getOwnPropertyDescriptor(obj, key);

		if (desc.get || desc.set) {

			// If there are getters/setters, just copy them directly (not invoking)
			Object.defineProperty(copy, key, desc);
		}
		else {

			// Otherwise, copy the value deeply
			desc.value = deepCopy(desc.value, seen);
			Object.defineProperty(copy, key, desc);
		}
	}

	return copy;
}


async function genApiKey(key) {

	const data = await genPasswordHash({'data': key });

	const apiKeyHashed = data['salt'] + ':' + data['hash'];

	return apiKeyHashed;
}


async function genToken() {

	const salt = shareData.appData.server_id;
	const data = shareData.appData.api_key.split(':');

	const hash = data[1];

	const token = await genPasswordHash({'data': hash, 'salt': salt });

	return token;
}


async function setToken() {

	const token = await genToken();
	shareData.appData['api_token'] = token['hash'];
}


async function genPasswordHash(dataObj) {

	let salt = dataObj['salt'];
	let data = dataObj['data'];

	if (salt == undefined || salt == null || salt == '') {

		salt = crypto.randomBytes(16).toString('hex');
	}

	const hash = crypto.pbkdf2Sync(data, salt, 1000, 64, 'sha256').toString('hex');

	let obj = { 'salt': salt, 'hash': hash };

	return obj;
}


async function verifyPasswordHash(dataObj) {

	let hashData;
	let success = false;

	let salt = dataObj['salt'];
	let hash = dataObj['hash'];
	let data = dataObj['data'];

	try {

		hashData = crypto.pbkdf2Sync(data, salt, 1000, 64, 'sha256').toString('hex');
	}
	catch(e) {}

	if (hash === hashData) {

		success = true;
	}

	return success;
}


async function verifyLogin(req, res, isHub) {

	let msg;

	const body = req.body;
	const password = body.password;
	const userAgent = req.headers['user-agent'];

	const ip = getClientIp(req);

	const dataPass = shareData.appData.password.split(':');

	let success = await verifyPasswordHash( { 'salt': dataPass[0], 'hash': dataPass[1], 'data': password } );

	if (success) {

		req.session.loggedIn = true;

		msg = 'SUCCESS';
	}
	else {

		msg = 'FAILED';
	}

	msg = 'Login ' + msg + ' from: ' + ip + ' / Browser: ' + userAgent;

	if (!isHub) {

		logger(msg);
		sendNotification({ 'message': msg, 'telegram_id': shareData.appData.telegram_id });
	}

	if (success) {

		if (isHub) {

			renderView('Hub/homeView', req, res, isHub);
		}
		else {

			// Redirect to config view if in config mode
			if (shareData.appData.config_mode) {

				res.redirect('/config');
			}
			else {

				renderView('homeView', req, res);
			}
		}
	}
	else {

		res.redirect('/login');
	}
}


function validateApiKey(key) {

	let data;
	let hashData;
	let success = false;

	try {
		data = shareData.appData.api_key.split(':');
	}
	catch(e) {

		return success;
	}

	const salt = data[0];
	const hash = data[1];

	try {

		hashData = crypto.pbkdf2Sync(key, salt, 1000, 64, 'sha256').toString('hex');
	}
	catch(e) {}

	if (hash === hashData) {

		success = true;
	}

	return success;
}


function getClientIp(ctx) {

	const headers = ctx?.handshake?.headers || ctx?.headers || {};

	const socket =
		ctx?.request?.socket ||
		ctx?.socket ||
		ctx?.connection;

	const rawIp = (
			headers['cf-connecting-ip'] ||
			headers['x-forwarded-for'] ||
			socket?.remoteAddress ||
			ctx?.handshake?.address ||
			''
		)
		.split(',')[0]
		.trim();

	return rawIp.startsWith('::ffff:') ?
		rawIp.substring(7) :
		rawIp;
}


async function sendSocketMsg(data) {

	const roomAuth = 'logs';

	let room = data['room'];
	let msg = data['message'];
	let msgType = data['type'];

	const socket = await shareData.WebServer.getSocket();

	let sendRoom = roomAuth;

	if (room != undefined && room != null && room != '') {

		sendRoom = room;
	}

	if (msgType == undefined || msgType == null || msgType == '') {

		msgType = sendRoom;
	}

	if (socket) {

		socket.to(sendRoom).emit('data', { 'type': msgType, 'message': msg });
	}
}


async function sendParentMsg(data) {

	const parentPort = shareData.appData.parent_port;

	let msg = data['data'];
	let msgType = data['type'];

	let success = false;

	if (parentPort) {

		success = true;

		parentPort.postMessage({

			'type': msgType,
			'data': msg
		});
	}

	return { 'success': success };
}


async function renderView(view, req, res, isHub) {

	res.render( view, { 'isHub': isHub, 'appData': shareData.appData } );
}


const stripNonNumeric = (inputString) => inputString.replace(/[^0-9.]/g, '');


async function validateAppVersion() {

	const owner = '3cqs-coder';
	const repo = 'SymBot';
	const url = `https://api.github.com/repos/${owner}/${repo}/tags`;

	let remoteVersion = '0.0.0';
	let localVersion = '0.0.0';
	let success = true;
	let error = null;
	let update_available = false;

	try {

		const response = await fetch(url);

		if (!response.ok) {

			success = false;
			error = `Failed to fetch tags: ${response.statusText}`;
		}
		else {

			const tags = await response.json();

			if (tags.length === 0) {

				success = false;
				error = 'No tags found for this repository.';
			}
			else {

				const latestTag = tags[0].name;

				localVersion = stripNonNumeric(packageJson.version);
				remoteVersion = stripNonNumeric(latestTag);

				const parseVersion = (version) => version.split(/[\.-]/);

				const localParts = parseVersion(localVersion);
				const remoteParts = parseVersion(remoteVersion);

				for (let i = 0; i < Math.max(localParts.length, remoteParts.length); i++) {

					const localSegment = i < localParts.length ? localParts[i] : '';
					const remoteSegment = i < remoteParts.length ? remoteParts[i] : '';

					if (localSegment === '' && remoteSegment !== '') {

						update_available = true;
						break;
					}

					if (localSegment < remoteSegment) {

						update_available = true;
						break;
					}

					if (localSegment > remoteSegment) {

						update_available = false;
						break;
					}
				}

				if (!update_available && remoteVersion <= localVersion) {

					success = false;
					error = 'You already have the latest version';
				}
			}
		}
	}
	catch (err) {

		success = false;
		error = 'Failed to retrieve remote application version';
	}

	if (update_available) {

		logger('WARNING: Your app version is outdated. Please update to the latest version.', true);
		logger(`Current version: ${localVersion} Latest version: ${remoteVersion}`, true);
	}
	else if (localVersion !== remoteVersion) {

		logger('WARNING: Your app version is newer than the remote version. This should not happen.', true);
		logger(`Current version: ${localVersion} Latest version: ${remoteVersion}`, true);
	}

	return {
		owner,
		repo,
		remote: remoteVersion,
		local: localVersion,
		success,
		error,
		update_available
	};
}



async function getBotConfig(req, res) {

	let success = false;
	let data;

	const botConfigFile = shareData.appData.bot_config;
	const botConfig = await getConfig(botConfigFile);

	if (!botConfig.success) {

		data = 'Unable to read bot configuration file: ' + botConfigFile;
	}
	else {

		const cfg = botConfig.data;

		// Translate stored exchange name through the canonical alias map in DCABot
		// so the UI always sees the current name (e.g. coinbasepro -> coinbaseexchange).
		// Never send actual credential values to the browser — send boolean flags instead.
		const exchangeCanonical = await shareData.DCABot.getExchangeAlias(cfg.exchange || '');

		data = {
			exchange:      exchangeCanonical,
			apiKey:        !!cfg.apiKey,
			apiSecret:     !!cfg.apiSecret,
			apiPassphrase: !!cfg.apiPassphrase,
			apiPassword:   !!cfg.apiPassword,
			sandBox:       cfg.sandBox === true,
			sandBoxWallet: cfg.sandBoxWallet || 0,
			exchangeFee:   cfg.exchangeFee   || 0,
		};

		success = true;
	}

	res.send({ success, data });
}


async function updateBotConfig(req, res) {

	let success = false;
	let dataMessage;

	const body = req.body;
	const password = body.password;

	const dataPass = shareData.appData.password.split(':');
	const passwordOk = await verifyPasswordHash({ salt: dataPass[0], hash: dataPass[1], data: password });

	if (!passwordOk) {

		dataMessage = 'Password incorrect';
	}
	else {

		const botConfigFile = shareData.appData.bot_config;
		const botConfig = await getConfig(botConfigFile);

		if (!botConfig.success) {

			dataMessage = 'Unable to read bot configuration file: ' + botConfigFile;
		}
		else {

			const cfg = botConfig.data;

			// Exchange name
			if (body.exchange && body.exchange.trim() !== '') {

				cfg.exchange = body.exchange.trim().toLowerCase();
			}

			// Credentials — three possible states per field:
			//   clear flag = '1' → explicitly erase the stored value
			//   new value entered → update with the new value
			//   blank with no clear flag → leave existing value untouched
			const credFields = ['apiKey', 'apiSecret', 'apiPassphrase', 'apiPassword'];

			for (const field of credFields) {

				if (body[field + '_clear'] === '1') {

					cfg[field] = '';
				}
				else if (body[field] && body[field].trim() !== '') {

					cfg[field] = body[field].trim();
				}
			}

			const sandBoxWallet = parseFloat(body.sandBoxWallet);
			if (!isNaN(sandBoxWallet) && sandBoxWallet >= 0) {

				cfg.sandBoxWallet = sandBoxWallet;

				// Keep Hub per-instance override in sync if it exists
				if (shareData.appData.sandbox_wallet_override !== undefined) {

					shareData.appData.sandbox_wallet_override = sandBoxWallet;
				}
			}

			const exchangeFee = parseFloat(body.exchangeFee);
			if (!isNaN(exchangeFee) && exchangeFee >= 0) cfg.exchangeFee = exchangeFee;

			// Save sandBoxWallet and exchangeFee immediately — these fields
			// do not require exchange connectivity and must not be blocked
			// by a timeout during the exchange validation step below.
			await saveConfig(botConfigFile, cfg);

			const buySlippage  = parseFloat(body.exchange_buy_slippage);
			const sellSlippage = parseFloat(body.exchange_sell_slippage);
			let balanceCurrencies = body.exchange_balance_currencies;
			if (!Array.isArray(balanceCurrencies)) {
				balanceCurrencies = balanceCurrencies ? [balanceCurrencies] : [];
			}
			balanceCurrencies = balanceCurrencies.map(s => s.trim().toUpperCase()).filter(s => s.length > 0);

			// sandBox toggle is handled separately via /api/bot-config/sandbox
			// to enforce the confirmation step — do not allow it via this route.

			// Validate the exchange name and credentials.
			// If credentials are present, attempt fetchBalance to confirm they are accepted.
			// If no credentials are set, just verify the exchange name is recognised.
			try {

				const testCfg = {
					exchange:      cfg.exchange,
					apiKey:        cfg.apiKey        || '',
					apiSecret:     cfg.apiSecret     || '',
					apiPassphrase: cfg.apiPassphrase || '',
					apiPassword:   cfg.apiPassword   || '',
				};

				const exchange = await shareData.DCABot.connectExchange(testCfg);

				if (!exchange) {

					dataMessage = 'Could not connect to exchange. Please verify the exchange name.';
				}
				else {

					const hasCredentials = cfg.apiKey || cfg.apiSecret;

					if (hasCredentials) {

						// Credentials provided — validate them with a balance fetch
						await exchange.fetchBalance();
					}

					// Flush the exchange connection cache so the new credentials take effect
					if (shareData.appData.exchanges) shareData.appData.exchanges = {};

					const saveResult = await saveConfig(botConfigFile, cfg);

					if (!saveResult.success) {

						dataMessage = 'Failed to save bot configuration: ' + saveResult.data;
					}
					else {

						dataMessage = 'Exchange configuration updated successfully';
						success = true;

						// Save order settings (slippage, balance currencies) to app.json
						const appConfigFile = shareData.appData.app_config;
						const appCfgResult = await getConfig(appConfigFile);
						if (appCfgResult.success) {
							const appCfg = appCfgResult.data;
							const excDef = appCfg?.bots?.exchange?.default;
							if (excDef) {
								if (!isNaN(buySlippage)  && buySlippage  >= 0) excDef.orders.buy.slippage_percent  = buySlippage;
								if (!isNaN(sellSlippage) && sellSlippage >= 0) excDef.orders.sell.slippage_percent = sellSlippage;
								if (balanceCurrencies.length > 0) excDef.account_balance_currencies = balanceCurrencies;
								await saveConfig(appConfigFile, appCfg);
								shareData.appData.bots.exchange = appCfg.bots.exchange;
							}
						}
					}
				}
			}
			catch (e) {

				dataMessage = 'Exchange validation failed: ' + e.message;
			}
		}
	}

	res.send({ success, data: dataMessage });
}


async function updateBotConfigSandbox(req, res) {

	let success = false;
	let dataMessage;

	const body = req.body;
	const password = body.password;
	const sandBox = body.sandBox === 'true' || body.sandBox === true;

	const dataPass = shareData.appData.password.split(':');
	const passwordOk = await verifyPasswordHash({ salt: dataPass[0], hash: dataPass[1], data: password });

	if (!passwordOk) {

		dataMessage = 'Password incorrect';
	}
	else {

		const botConfigFile = shareData.appData.bot_config;
		const botConfig = await getConfig(botConfigFile);

		if (!botConfig.success) {

			dataMessage = 'Unable to read bot configuration file: ' + botConfigFile;
		}
		else {

			const cfg = botConfig.data;
			cfg.sandBox = sandBox;

			const saveResult = await saveConfig(botConfigFile, cfg);

			if (!saveResult.success) {

				dataMessage = 'Failed to save bot configuration: ' + saveResult.data;
			}
			else {

				// Flush exchange connection cache
				if (shareData.appData.exchanges) shareData.appData.exchanges = {};

				const modeLabel = sandBox ? 'Sandbox (paper trading)' : 'Live trading';
				dataMessage = 'Trading mode changed to: ' + modeLabel;
				success = true;
			}
		}
	}

	res.send({ success, data: dataMessage });
}


function getCurrencySymbol(code) {

	if (!code) return '';

	// Check known crypto symbols first — Intl won't handle these correctly
	const crypto = {
		'BTC':  '₿',
		'ETH':  'Ξ',
		'USDT': '$',
		'USDC': '$',
		'BUSD': '$',
		'DAI':  '$'
	};

	if (crypto[code.toUpperCase()]) return crypto[code.toUpperCase()];

	try {

		// Intl handles all ISO 4217 fiat codes automatically
		const sym = (0).toLocaleString('en', {
			style: 'currency',
			currency: code,
			minimumFractionDigits: 0,
			maximumFractionDigits: 0
		}).replace(/\d/g, '').trim();

		// Intl returns the code itself for unknown currencies — treat that as no symbol
		if (sym.toUpperCase() === code.toUpperCase()) return '';

		return sym;
	}
	catch (e) {

		return '';
	}
}


async function uploadAiChatFile(req, res) {

	const chatUpload = multer({
		storage: multer.diskStorage({
			destination: (_req, _file, cb) => cb(null, os.tmpdir()),
			filename:    (_req, file, cb) => cb(null, 'symbot-chat-' + Date.now() + path.extname(file.originalname).toLowerCase())
		}),
		limits: { fileSize: 25 * 1024 * 1024 }
	});

	chatUpload.single('file')(req, res, async (err) => {

		if (err) {
			const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 25 MB)' : err.message;
			logger('AI chat upload multer error: ' + msg);
			if (!res.headersSent) return res.status(400).json({ success: false, error: msg });
			return;
		}

		if (!req.file) return res.status(400).json({ success: false, error: 'No file received' });

		const file    = req.file;
		const ext     = path.extname(file.originalname).toLowerCase();
		const allowed = ['.pdf', '.docx', '.txt', '.md', '.csv'];

		if (!allowed.includes(ext)) {
			fs.unlink(file.path, () => {});
			return res.status(400).json({ success: false, error: `Unsupported file type: ${ext}. Allowed: ${allowed.join(', ')}` });
		}

		try {

			let text = '';

			if (ext === '.pdf') {
				// Run pdf-parse in a worker thread — keeps the event loop free
				// during CPU-heavy parsing (large PDFs can take several seconds)
				const { Worker } = require('worker_threads');
				const buffer = await fsp.readFile(file.path);

				const workerCode = `
					const { parentPort, workerData } = require('worker_threads');
					const { PDFParse } = require('pdf-parse');
					(async () => {
						try {
							const buf = Buffer.from(workerData.buffer);
							const parser = new PDFParse({ data: buf });
							const data = await parser.getText();
							await parser.destroy();
							parentPort.postMessage({ success: true, text: data.text || '' });
						} catch(e) {
							parentPort.postMessage({ success: false, error: e.message });
						}
					})();
				`;

				text = await new Promise((resolve, reject) => {
					const ab = buffer.buffer.slice(
						buffer.byteOffset,
						buffer.byteOffset + buffer.byteLength
					);
					const worker = new Worker(workerCode, {
						eval: true,
						workerData: { buffer: ab },
						transferList: [ab]
					});
					worker.once('message', msg => {
						if (msg.success) resolve(msg.text);
						else reject(new Error(msg.error));
					});
					worker.once('error', reject);
				});
			}
			else if (ext === '.docx') {
				const mammoth = require('mammoth');
				const result  = await mammoth.extractRawText({ path: file.path });
				text = result.value || '';
			}
			else {
				text = await fsp.readFile(file.path, 'utf-8');
			}

			// Delete temp file immediately — only extracted text is retained
			fs.unlink(file.path, () => {});

			text = text.trim();

			if (!text) return res.status(400).json({ success: false, error: 'Could not extract text from file' });

			// Store text server-side — never sent to client
			if (!shareData.attachmentCache) shareData.attachmentCache = new Map();

			const attachmentId = uuidv4();

			shareData.attachmentCache.set(attachmentId, { name: file.originalname, text });

			// Auto-expire after 1 hour
			setTimeout(() => shareData.attachmentCache.delete(attachmentId), 60 * 60 * 1000);

			res.status(200).json({
				success:      true,
				attachmentId: attachmentId,
				name:         file.originalname,
				type:         ext.slice(1),
				size:         file.size,
				charCount:    text.length,
			});

		}
		catch (e) {

			fs.unlink(file.path, () => {});
			logger('AI chat upload error: ' + e.message);
			if (!res.headersSent) {
				res.status(500).json({ success: false, error: 'Extraction failed: ' + e.message });
			}
		}
	});
}


module.exports = {

	getCurrencySymbol,
	delay,
	uuidv4,
	uploadAiChatFile,
	makeDir,
	convertBoolean,
	convertToCamelCase,
	convertStringToNumeric,
	freezeProperty,
	isNumeric,
	sortByKey,
	getConfig,
	getSignalConfigs,
	saveConfig,
	updateConfig,
	pairBlackListed,
	getInstanceName,
	getData,
	saveData,
	getDateParts,
	getTimeZone,
	roundAmount,
	adjustDecimals,
	getPrecision,
	mergeObjects,
	deepCopy,
	numToBase26,
	numFormatter,
	hashCode,
	genApiKey,
	genToken,
	setToken,
	genPasswordHash,
	verifyPasswordHash,
	verifyLogin,
	validateApiKey,
	renderView,
	timeDiff,
	logger,
	logMonitor,
	showFiles,
	downloadFile,
	sendNotification,
	getNotificationHistory,
	showTradingView,
	fetchURL,
	getClientIp,
	getProcessInfo,
	validateAppVersion,
	dealDurationMinutes,
	startSignals,
	sendSocketMsg,
	sendParentMsg,
	getBotConfig,
	updateBotConfig,
	updateBotConfigSandbox,

	init: function(obj) {

		shareData = obj;
	},
};
