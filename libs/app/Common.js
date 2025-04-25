'use strict';

const fs = require('fs');
const path = require('path');

let pathRoot = path.dirname(fs.realpathSync(__dirname)).split(path.sep).join(path.posix.sep);
pathRoot = pathRoot.substring(0, pathRoot.lastIndexOf('/'));

const crypto = require('crypto');
const Convert = require('ansi-to-html');
const fetch = require('node-fetch-commonjs');
const { v4: uuidv4 } = require('uuid');
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
	const ollamaModel = body.ollama_model;
	const cronBackup = body.cron_backup_enabled;
	const cronBackupSchedule = body.cron_backup_schedule;
	const cronBackupPassword = body.cron_backup_password;
	const cronBackupMax = Number(body.cron_backup_max ?? 1) || 1;

	let pairButtons = body.pairbuttons;
	let pairBlacklist = body.pairblacklist;

	let telegramEnabled = convertBoolean(telegram, false);
	let signals3CQSEnabled = convertBoolean(signals3CQS, false);
	let cronBackupEnabled = convertBoolean(cronBackup, false);

	let dbErr;
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

		let data = await getConfig(appConfigFile);

		let appConfig = data.data;

		if (passwordNew != undefined && passwordNew != null && passwordNew != '') {

			const dataPassNew = await genPasswordHash({ 'data': passwordNew });

			const passwordHashed = dataPassNew['salt'] + ':' + dataPassNew['hash'];

			appConfig['password'] = passwordHashed;
			shareData['appData']['password'] = passwordHashed;

			// Remove all other existing sessions to require login again
			const collection = await shareData.DB.mongoose.connection.db.collection('sessions');
			const query = { '_id': { '$ne': sessionId } };

			const sessionData = await collection.deleteMany(query).catch(e => {});
		}

		if (apiKey != undefined && apiKey != null && apiKey != '') {

			const apiKeyHashed = await genApiKey(apiKey);

			appConfig['api']['key'] = apiKeyHashed;
			shareData['appData']['api_key'] = apiKeyHashed;

			// Set API token
			await setToken();
		}

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

		appConfig['ai']['ollama']['host'] = ollamaHost;
		appConfig['ai']['ollama']['model'] = ollamaModel;

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

			// Restart Ollama
			shareData.Ollama.stop();
			shareData.Ollama.start(ollamaHost, ollamaModel);

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

	if (instanceName) {

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

	const filePath = `${pathRoot}/${type}/${fileName}`;

	res.download(filePath, err => {

		if (err) {

			res.status(err.statusCode || 500).send({
				'error': err
			});
		}
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

	const copy = Array.isArray(obj) ? [] : {};

	seen.set(obj, copy);

	for (const key in obj) {

		if (obj.hasOwnProperty(key)) {

			copy[key] = deepCopy(obj[key], seen);
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
	const rawIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
	.split(',')[0]
	.trim();

	const ip = rawIp.startsWith('::ffff:') ? rawIp.substring(7) : rawIp;

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



module.exports = {

	delay,
	uuidv4,
	makeDir,
	convertBoolean,
	convertToCamelCase,
	convertStringToNumeric,
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
	getProcessInfo,
	validateAppVersion,
	dealDurationMinutes,
	startSignals,
	sendSocketMsg,
	sendParentMsg,

	init: function(obj) {

		shareData = obj;
	},
};
