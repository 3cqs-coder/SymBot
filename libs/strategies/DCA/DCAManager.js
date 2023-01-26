'use strict';


let shareData;


async function apiGetDeals(req, res) {

	let dealsObj = JSON.parse(JSON.stringify(shareData.dealTracker));

	// Remove sensitive data
	for (let dealId in dealsObj) {

		let deal = dealsObj[dealId];
		let config = deal['deal']['config'];

		for (let key in config) {

			if (key.substring(0, 3).toLowerCase() == 'api') {

				delete config[key];
			}
		}
	}

	res.send( { 'date': new Date(), 'data': dealsObj } );
}


async function viewCreateDeal(req, res) {

	const botConfig = await shareData.Common.getConfig('bot.json');

	res.render( 'dealsNewView', { 'appData': shareData.appData, 'botData': botConfig.data } );
}


async function viewActiveDeals(req, res) {

	res.render( 'dealsActiveView', { 'appData': shareData.appData, 'deals': shareData.dealTracker } );
}


async function apiCreateDeal(req, res) {

	let success = true;

	const body = req.body;

	const botConfig = await shareData.Common.getConfig('bot.json');

	let botData = botConfig.data;

	botData.sandBox = true;

	botData.pair = body.pair;
	botData.firstOrderAmount = body.firstOrderAmount;
	botData.dcaOrderAmount = body.dcaOrderAmount;
	botData.dcaMaxOrder = body.dcaMaxOrder;
	botData.dcaOrderSizeMultiplier = body.dcaOrderSizeMultiplier;
	botData.dcaOrderStartDistance = body.dcaOrderStartDistance;
	botData.dcaOrderStepPercent = body.dcaOrderStepPercent;
	botData.dcaOrderStepPercentMultiplier = body.dcaOrderStepPercentMultiplier;
	botData.dcaTakeProfitPercent = body.dcaTakeProfitPercent;

	shareData.DCA.startBot(botData, true, true);

	res.send( { 'date': new Date(), 'success': success, 'data': {} } );
}




module.exports = {

	apiGetDeals,
	apiCreateDeal,
	viewCreateDeal,
	viewActiveDeals,

	init: function(obj) {

		shareData = obj;
    }
}
