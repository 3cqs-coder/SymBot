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

const logNotifications = pathRoot + '/logs/services/notifications/notifications.log';

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


async function saveConfig(fileName, data) {

	let err;
	let success = false;

	try {
		data.updated = new Date().toISOString();

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
	const password = body.password;
	const passwordNew = body.passwordnew;
	const apiKey = body.apikey;
	const telegram = body.telegram;

	let pairButtons = body.pairbuttons;
	let pairBlacklist = body.pairblacklist;
	let telegramEnabled = false;

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

		let data = await getConfig('app.json');

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

		if (telegram != undefined && telegram != null && telegram != '') {

			telegramEnabled = true;
		}

		appConfig['bots']['pair_buttons'] = pairButtonsUC;
		shareData['appData']['bots']['pair_buttons'] = pairButtonsUC;

		appConfig['bots']['pair_blacklist'] = pairBlacklistUC;
		shareData['appData']['bots']['pair_blacklist'] = pairBlacklistUC;

		appConfig['telegram']['enabled'] = telegramEnabled;
		shareData['appData']['telegram_enabled'] = telegramEnabled;

		await saveConfig('app.json', appConfig);

		let obj = { 'success': true, 'data': 'Configuration Updated' };
		
		res.send(obj);
	}
	else {

		let obj = { 'success': false, 'data': 'Password Incorrect' };
		
		res.send(obj);
	}
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
	shareData.WebServer.sendSocketMsg(msg, 'notifications');

	// Save notifications
	saveData(fileName, JSON.stringify(historyArr));
}


async function getNotificationHistory(client, data) {

	let fileName = logNotifications;

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


async function showLogs(req, res) {

	const files = await getLogs();

	res.render( 'logsView', { 'appData': shareData.appData, 'files': files } );
}


async function getLogs() {

	let allFiles = [];
	let sortedFiles = [];

	let dir = pathRoot + '/logs';

	let files = fs.readdirSync(dir);

	for (let i in files) {

		let file = dir + '/' + files[i];

		let stats = fs.statSync(file);

		let created = stats.ctime;
		let modified = stats.mtime;
		let size = stats.size;

		if (!stats.isDirectory()) {

			let obj = { 'name': file, 'created': created, 'modified': modified, 'size': size, 'size_human': numFormatter(size) };

			allFiles.push(obj);
		}
	}

	if (allFiles.length > 0) {

		sortedFiles = sortByKey(allFiles, 'created');
	}

	return sortedFiles.reverse();
}


async function downloadLog(file, req, res) {

	res.download(pathRoot + '/logs/' + file, function (err) {

		if (err) {

			let obj = { 'error': err };

			let code = err['statusCode'];

			res.status(code).send(obj);
		}
    });
}


async function logger(data, consoleLog) {

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

	const fileName = pathRoot + '/logs/' + dateObj.date + '.log';

	const logDataOrig = logData;

	logData = logData.replace(
		/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
		''
	);

	logData = logData.replace(/[\t\r\n]+/g, ' ');

	fs.appendFileSync(fileName, logData + '\n', 'utf8');

	if (shareData && shareData.WebServer) {

		shareData.WebServer.sendSocketMsg(convertAnsi.toHtml(logDataOrig));
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
		delFiles(pathRoot + '/backups', 1, true);
		delFiles(pathRoot + '/uploads', 1, true);

	}, (hoursInterval * (60 * 60 * 1000)));
}


async function delay(msec) {

	return new Promise(resolve => {

		setTimeout(() => { resolve('') }, msec);
	});
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


async function verifyLogin(req, res) {

	let msg;

	const body = req.body;
	const password = body.password;
	const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';
	const userAgent = req.headers['user-agent'];

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

	logger(msg);
	sendNotification({ 'message': msg, 'telegram_id': shareData.appData.telegram_id });

	if (success) {

		renderView('homeView', req, res);
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


async function renderView(view, req, res) {

	res.render( view, { 'appData': shareData.appData } );
}


const stripNonNumeric = (inputString) => inputString.replace(/[^0-9.]/g, '');


async function getAppVersions() {

    try {
        let req = await fetch('https://raw.githubusercontent.com/3cqs-coder/SymBot/main/package.json');
        let { version } = await req.json();
        return { remote: stripNonNumeric(version), local: stripNonNumeric(packageJson.version) };
    } catch (err) {
        logger('Failed to retrieve remote application version', true);
        return { remote: '0.0.0', local: '0.0.0' };
    }
}


async function validateAppVersion() {

    const { local, remote } = await getAppVersions();
    const parseVersion = (version) => { return version.split(/[\.-]/); };

    const localParts = parseVersion(local);
    const remoteParts = parseVersion(remote);

    let update_available = false;

    for (let i = 0; i < Math.max(localParts.length, remoteParts.length); i++) {

        const local_segment = i < localParts.length ? localParts[i] : '';
        const remote_segment = i < remoteParts.length ? remoteParts[i] : '';

        if (local_segment === '' && remote_segment !== '') {
            // Local version has fewer segments than remote
            update_available = true;
            break;
        }

        if (local_segment < remote_segment) {
            update_available = true;
            break;
        }

        if (local_segment > remote_segment) {
            // Current version is newer than remote
            update_available = false;
            break;
        }
    }

    if (update_available) {

        logger('WARNING: Your app version is outdated. Please update to the latest version.', true);
        logger('Current version: ' + local + ' Latest version: ' + remote, true);

	} else {

		if (local !== remote) {

			logger('WARNING: Your app version is newer than the remote version. This should not happen.', true);
            logger('Current version: ' + local + ' Latest version: ' + remote, true);
        }
    }

    return { 'update_available': update_available };
}



module.exports = {

	delay,
	uuidv4,
	makeDir,
	convertBoolean,
	convertStringToNumeric,
	isNumeric,
	sortByKey,
	getConfig,
	getSignalConfigs,
	saveConfig,
	updateConfig,
	pairBlackListed,
	getData,
	saveData,
	getDateParts,
	getTimeZone,
	roundAmount,
	mergeObjects,
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
	showLogs,
	downloadLog,
	sendNotification,
	getNotificationHistory,
	showTradingView,
	fetchURL,
	getProcessInfo,
	getAppVersions,
	validateAppVersion,
	dealDurationMinutes,

	init: function(obj) {

		shareData = obj;
	},
};
