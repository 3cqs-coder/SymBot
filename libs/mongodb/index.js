const mongoose = require('mongoose');


let shareData;



async function start(url) {

	mongoose.Promise = Promise;

	mongoose.connection.on('connected', () => {

		delete shareData.appData.database_error;

		shareData.Common.logger('Database Connected', true);
	});

	mongoose.connection.on('reconnected', () => {

		delete shareData.appData.database_error;

		let msg = 'Database Reconnected';

		log(msg);
	});

	mongoose.connection.on('disconnected', () => {

		let msg = 'Database Disconnected';

		shareData.appData.database_error = msg;

		log(msg);
	});

	mongoose.connection.on('close', () => {

		let msg = 'Database Closed';

		shareData.appData.database_error = msg;

		log(msg);
	});

	mongoose.connection.on('error', error => {

		let msg = 'Database Error: ' + JSON.stringify(error);

		log(msg);
	});

	mongoose.set('strictQuery', false);

	const run = async () => {

		await mongoose.connect(
			url, { }
		);
		
		return true;
	};

	let started = await run().catch(error => log('Database Run Error: ' + JSON.stringify(error)));

	return started;
}


async function log(msg) {

	shareData.Common.logger(msg, true);

	shareData.Common.sendNotification({ 'message': msg, 'type': 'database', 'telegram_id': shareData.appData.telegram_id });
}


module.exports = {

	start,
	mongoose,

	init: function(obj) {

		shareData = obj;
    }
}
