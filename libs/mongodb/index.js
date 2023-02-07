const mongoose = require('mongoose');


let shareData;



async function start(url) {

	mongoose.Promise = Promise;

	mongoose.connection.on('connected', () => {

		shareData.Common.logger('DB Connected', true);
	});

	mongoose.connection.on('reconnected', () => {

		let msg = 'DB Reconnected';

		log(msg);
	});

	mongoose.connection.on('disconnected', () => {

		let msg = 'DB Disconnected';

		log(msg);
	});

	mongoose.connection.on('close', () => {

		let msg = 'DB Closed';

		log(msg);
	});

	mongoose.connection.on('error', error => {

		let msg = 'DB Error: ' + JSON.stringify(error);

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

	let started = await run().catch(error => log('DB Run Error: ' + JSON.stringify(error)));

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
