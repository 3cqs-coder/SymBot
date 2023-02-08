const mongoose = require('mongoose');


let shareData;



async function start(url) {

	mongoose.Promise = Promise;

	mongoose.connection.on('connected', () => {

		shareData.Common.logger('Database Connected', true);
	});

	mongoose.connection.on('reconnected', () => {

		let msg = 'Database Reconnected';

		log(msg);
	});

	mongoose.connection.on('disconnected', () => {

		let msg = 'Database Disconnected';

		log(msg);
	});

	mongoose.connection.on('close', () => {

		let msg = 'Database Closed';

		log(msg);
	});

	mongoose.connection.on('error', error => {

		let msg = 'Database Error: ' + JSON.stringify(error);

		log(msg);
	});

	mongoose.set('strictQuery', false);

	const run = async () => {

		await mongoose.connect(
			url, {
				useNewUrlParser: true,
				useUnifiedTopology: true
			}
		);
		
		return true;
	};

	let started = await run().catch(error => log('Database Run Error: ' + JSON.stringify(error)));

	return started;
}


async function log(msg) {

	shareData.Common.logger(msg, true);

	shareData.Telegram.sendMessage(shareData.appData.telegram_id, msg);
}


module.exports = {

	start,
	mongoose,

	init: function(obj) {

		shareData = obj;
    }
}
