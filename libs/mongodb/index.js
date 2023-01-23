const mongoose = require('mongoose');


let shareData;



async function start(url) {

	mongoose.Promise = Promise;

	mongoose.connection.on('connected', () => {
		shareData.Common.logger('DB Connected');
	});

	mongoose.connection.on('reconnected', () => {
		shareData.Common.logger('DB Reconnected');
	});

	mongoose.connection.on('disconnected', () => {
		shareData.Common.logger('DB Disconnected');
	});

	mongoose.connection.on('close', () => {
		shareData.Common.logger('DB Closed');
	});

	mongoose.connection.on('error', error => {
		shareData.Common.logger('DB Error: ' + error);
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

	let started = await run().catch(error => shareData.Common.logger(error));
	
	return started;
}



module.exports = {

	start,

	init: function(obj) {

		shareData = obj;
    }
}
