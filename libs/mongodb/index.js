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

		// An Error's `message` is non-enumerable, so JSON.stringify(error) renders "{}" — a useless log and
		// Telegram alert. Surface the real message (and code when present) instead, matching the SFTP path.
		const detail = error && error.message ? error.message : String(error);
		let msg = 'Database Error: ' + detail + (error && error.code ? ' (code ' + error.code + ')' : '');

		log(msg);
	});

	mongoose.set('strictQuery', false);

	const run = async () => {

		// Explicit, conservative timeouts so a Mongo host that goes unresponsive (network black-hole, stuck
		// primary, frozen VM) can never make a trading-tick query hang indefinitely. Without these the driver
		// defaults leave socketTimeoutMS at 0 (no socket timeout), so an in-flight read/write on the tick would
		// wait on server-selection/heartbeat for tens of seconds before the loop's database_error short-circuit
		// engages. Bounding both timeouts keeps the "never stall trading" invariant explicit rather than implicit.
		// Values are generous enough not to abort legitimate queries, and the trading loop retries on error.
		await mongoose.connect(
			url,
			{
				serverSelectionTimeoutMS: 10000,
				socketTimeoutMS: 45000,
				connectTimeoutMS: 10000
			}
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
