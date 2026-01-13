'use strict';

let shareData;

const API_ROOM = 'api';


const apiHandlers = {
	'deals': apiDeals,
	'markets': apiMarkets,
	'markets/ohlcv': apiMarketsOhlcv
};


async function apiDeals() {

	const req = {
		params: { path: '' },
		query: { active: true }
	};

	return shareData.DCABotManager.apiGetActiveDeals(req, undefined, false);
}


async function apiMarkets(data) {

	const req = {
		params: { path: '' },
		query: {
			exchange: data.exchange,
			pair: data.pair
		}
	};

	return shareData.DCABotManager.apiGetMarkets(req, undefined, false);
}


async function apiMarketsOhlcv(data) {

	const req = {
		params: { path: 'ohlcv' },
		query: {
			exchange: data.exchange,
			pair: data.pair,
			timeframe: data.timeframe,
			since: data.since,
			limit: data.limit
		}
	};

	return shareData.DCABotManager.apiGetMarkets(req, undefined, false);
}


async function api(client, data) {

	const metaData = data.meta || {};
	const apiName = metaData.api;
	const appId = metaData.appId;
	const messageId = metaData.id;

	try {

		// Ensure client is in api room
		if (!client.rooms.has(API_ROOM)) {

			return;
		}

		const handler = apiHandlers[apiName];

		if (!handler) {

			return;
		}

		const message = await handler(data);

		client.emit('data', {
			'type': 'api',
			'api': apiName,
			'app_id': appId,
			'message_id': shareData.Common.uuidv4(),
			'message_id_client': messageId,
			'message': message
		});
	}
	catch(e) {
	}
}



module.exports = {

	api,

	init(obj) {

		shareData = obj;
	}
};
