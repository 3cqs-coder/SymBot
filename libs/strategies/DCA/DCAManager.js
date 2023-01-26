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


async function apiCreateDeal(req, res) {

	let success = true;

	const body = req.body;

	res.send( { 'date': new Date(), 'success': success, 'data': {} } );
}




module.exports = {

	apiGetDeals,
	apiCreateDeal,

	init: function(obj) {

		shareData = obj;
    }
}
