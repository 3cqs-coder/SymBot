'use strict';

const fs = require('fs');
const path = require('path');
const pathRoot = path.dirname(fs.realpathSync(__dirname)).split(path.sep).join(path.posix.sep);

const delay = require('delay');
const fetch = require('node-fetch-commonjs');
const { v4: uuidv4 } = require('uuid');


let shareData;


async function getConfig(fileName) {

	let data;
	let success = false;

	try {

		data = JSON.parse(await fs.readFileSync(pathRoot + '/config/' + fileName, { encoding: 'utf8', flag: 'r' }));

		success = true;
	}
	catch(e) {

		data = e;
	}

	return ({ 'success': success, 'data': data });
}


async function saveConfig(fileName, data) {

	let err;
	let success = false;

	try {

		data.updated = new Date().toISOString();

		fs.writeFileSync(pathRoot + '/config/' + fileName, JSON.stringify(data, null, 4));

		success = true;
	}
	catch(e) {

		err = e;
	}

	return ({ 'success': success, 'data': err });
}


async function fetchURL(url, method, headers, body) {

	const response = await fetch(url, {

		'method': method,
		'headers': headers,
		'body': JSON.stringify(body)
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


async function logger(data, consoleLog) {

	if (typeof data !== 'string') {

		data = JSON.stringify(data);
	}

	let dateNow = new Date().toISOString();

	let logData = dateNow + ' ' + data;

	if (consoleLog || shareData.appData.console_log) {

		console.log(logData);
	}

	const dateObj = getDateParts(dateNow);

	const fileName = pathRoot + '/logs/' + dateObj.date + '.log';

	logData = logData.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

	logData = logData.replace(/[\t\r\n]+/g, ' ');

	fs.appendFileSync(fileName, logData + '\n', 'utf8');
}


function logMonitor() {

	const maxDays = 10;

	// Monitor and remove old logs
	setInterval(() => {

		delFiles(pathRoot + '/logs', maxDays);

	}, 43200);
}


async function getSignalConfigs() {

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

					let data = JSON.parse(await fs.readFileSync(signalFile, { encoding: 'utf8', flag: 'r' }));

					configs = Object.assign({}, configs, data);
				}
				catch(e) {

				}
			}
		}
	}

	return configs;
}


function delFiles(path, days) {

	let dateNow = new Date();

	let files = fs.readdirSync(path);

	for (let i in files) {

		let file = path + '/' + files[i];

		let stats = fs.statSync(file);

		let created = stats.ctime;
		let modified = stats.mtime;

		let diffSec = (new Date(dateNow).getTime() - new Date(modified).getTime()) / 1000;

		if (diffSec >= (86400 * days)) {

			let diffDays = Math.round(diffSec / 86400);

			fs.unlinkSync(file);
		}
	}
}


async function getProcessInfo() {

	const obj = {
					'pid': process.pid,
					'file_name': path.basename(shareData.appData.app_filename)
				};

	return obj;
}


function getDateParts(date, utc) {

	let year;
	let month;
	let day;
	let hour;
	let min;
	let sec;

	let dateObj = new Date(date);

	if (utc == undefined || utc == null || utc == '' || utc == 0) {

		year = dateObj.getFullYear();
		month = dateObj.getMonth() + 1;
		day = dateObj.getDate();

		hour = dateObj.getHours();
		min = dateObj.getMinutes();
		sec = dateObj.getSeconds();
	}
	else {

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

	let timePartAmPm = (hourTemp == 0 ? '12' : hourTemp) + ':' + timePart.split(':')[1] + ' ' + (parseInt(parseInt(timePart.split(':')[0]) / 12) < 1 ? 'AM' : 'PM');

	let dateParts = {
						'year': year,
						'month': month,
						'day': day,
						'hour': hour,
						'minute': min,
						'second': sec,
						'date': datePart,
						'time': timePart,
						'timeAmPm': timePartAmPm
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

		diffString += (days === 1) ? `${days}d` : `${days}d`;
	}

	if (hours > 0) {

		diffString += (hours === 1) ? ` ${hours}h` : ` ${hours}h`;
	}

	if (minutes > 0) {

		diffString += (minutes === 1) ? ` ${minutes}m` : ` ${minutes}m`;
	}

	if (seconds > 0) {

		diffString += (seconds === 1) ? ` ${seconds}s` : ` ${seconds}s`;
	}

	diffString = diffString.trim();

	return diffString;
}


function convertBoolean(param) {

	let paramBool;

	if (param != undefined && param != null && param != '') {

		paramBool = (param.toLowerCase() === 'false' ? false : true);
	}

	return paramBool;
}


function hashCode(str) {

	let h;

	for (let i = 0; i < str.length; i++) {

		h = Math.imul(31, h) + str.charCodeAt(i) | 0;
	}

	return Math.abs(h);
}


function numToBase26(num) {

	num = parseInt(num, 10);

	let str = num.toString(26).toUpperCase();

	return str;
}


function sortByKey(array, key) {

	return array.sort(function(a, b) {

		let x = a[key]; var y = b[key];
		return ((x < y) ? -1 : ((x > y) ? 1 : 0));
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
	getDateParts,
	numToBase26,
	hashCode,
	timeDiff,
	logger,
	logMonitor,
	fetchURL,
	getProcessInfo,

	init: function(obj) {

		shareData = obj;
    }
}
