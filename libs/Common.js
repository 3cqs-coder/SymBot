'use strict';

const fs = require('fs');
const path = require('path');
const pathRoot = path
	.dirname(fs.realpathSync(__dirname))
	.split(path.sep)
	.join(path.posix.sep);

const Convert = require('ansi-to-html');
const delay = require('delay');
const fetch = require('node-fetch-commonjs');
const { v4: uuidv4 } = require('uuid');

const convertAnsi = new Convert();

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
	const telegram = body.telegram;

	let telegramEnabled = false;

	if (password == shareData.appData.password) {

		let data = await getConfig('app.json');

		let appConfig = data.data;

		if (passwordNew != undefined && passwordNew != null && passwordNew != '') {

			appConfig['password'] = passwordNew;
			shareData['appData']['password'] = passwordNew;

			// Remove all other existing sessions to require login again
			const collection = await shareData.DB.mongoose.connection.db.collection('sessions');
			const query = { '_id': { '$ne': sessionId } };

			const sessionData = await collection.deleteMany(query).catch(e => {});
		}

		if (telegram != undefined && telegram != null && telegram != '') {

			telegramEnabled = true;
		}

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


async function fetchURL(url, method, headers, body) {

	const response = await fetch(url, {
		method: method,
		headers: headers,
		body: JSON.stringify(body),
	});

	const data = await response.json();

	return data;
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

	let dataObj = {
					'container_id': containerId,
					'jquery': jquery,
					'script': script,
					'width': width,
					'height': height,
					'theme': theme,
					'exchange': exchange.toUpperCase(),
					'pair': pair.replace(/[^a-z0-9]/gi, '').toUpperCase()
				  };

	res.render( 'tradingView', { 'appData': shareData.appData, 'data': dataObj } );
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

	const maxDays = 10;

	// Monitor and remove old logs
	setInterval(() => {
		delFiles(pathRoot + '/logs', maxDays);
	}, 43200);
}


async function getSignalConfigs() {

	let isError;
	let success = true;
	let configs = {};

	let dir = fs.realpathSync(__dirname).split(path.sep).join(path.posix.sep) + '/signals';

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

					configs = Object.assign({}, configs, data);
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


function delFiles(path, days) {

	let dateNow = new Date();

	let files = fs.readdirSync(path);

	for (let i in files) {
		let file = path + '/' + files[i];

		let stats = fs.statSync(file);

		let created = stats.ctime;
		let modified = stats.mtime;

		let diffSec =
			(new Date(dateNow).getTime() - new Date(modified).getTime()) / 1000;

		if (diffSec >= 86400 * days) {
			let diffDays = Math.round(diffSec / 86400);

			fs.unlinkSync(file);
		}
	}
}


async function getProcessInfo() {

	const obj = {
		pid: process.pid,
		file_name: path.basename(shareData.appData.app_filename),
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

		num = Number(roundNumber(num, 5));
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


module.exports = {

	delay,
	uuidv4,
	makeDir,
	convertBoolean,
	sortByKey,
	getConfig,
	getSignalConfigs,
	saveConfig,
	updateConfig,
	getDateParts,
	getTimeZone,
	numToBase26,
	numFormatter,
	hashCode,
	timeDiff,
	logger,
	logMonitor,
	showLogs,
	downloadLog,
	showTradingView,
	fetchURL,
	getProcessInfo,

	init: function(obj) {

		shareData = obj;
	},
};
