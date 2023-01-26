'use strict';

const fs = require('fs');
const path = require('path');
const pathRoot = path.dirname(fs.realpathSync(__dirname)).split(path.sep).join(path.posix.sep);


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


module.exports = {

	getConfig,
	logger,

	init: function(obj) {

		shareData = obj;
    }
}
