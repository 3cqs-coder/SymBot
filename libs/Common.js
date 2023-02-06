'use strict';

const fs = require('fs');
const path = require('path');
const pathRoot = path.dirname(fs.realpathSync(__dirname)).split(path.sep).join(path.posix.sep);

const delay = require('delay');

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


async function logger(data) {

	let fileName = pathRoot + '/logs/symbot-log.txt';

	let dateNow = new Date().toISOString();

	let logData = dateNow + ' ' + data;

	console.log(logData);

	//fs.appendFileSync(fileName, logData + '\n', 'utf8');
}


function sortByKey(array, key) {

	return array.sort(function(a, b) {

		let x = a[key]; var y = b[key];
		return ((x < y) ? -1 : ((x > y) ? 1 : 0));
	});
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


module.exports = {

	delay,
	sortByKey,
	getConfig,
	timeDiff,
	logger,

	init: function(obj) {

		shareData = obj;
    }
}
