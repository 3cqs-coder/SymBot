const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const BotSchema = new Schema({
	active: Boolean,
	botId: { type: String, unique: true },
	botName: String,
	config: Object,
	date: Date,
}, {
	collection: 'bots',
	timestamps: true
});


const DealSchema = new Schema({
	active: Boolean,
	canceled: Boolean,
	paused: Boolean,
	pausedBuy: Boolean,
	pausedSell: Boolean,
	pauseReason: String,
	panicSell: Boolean,
	stopLoss: Boolean,
	stopLossBreakevenArmed: Boolean,
	activeStopLossPrice: Number,
	trailHighPrice: Number,
	botId: String,
	botName: String,
	dealId: { type: String, unique: true },
	exchange: String,
	pair: String,
	market: String,
	date: Date,
	status: Number,
	config: Object,
	sellData: Object,
	orders: Object,
	isStart: Number,
	dealCount: Number,
	dealMax: Number,
	journal: Object
}, {
	collection: 'deals',
	timestamps: true
});


// Secondary indexes for the deals collection. Without these every query that filters on anything
// other than dealId is a full collection scan, which grows without bound as deal history accumulates —
// and some of those queries sit directly on the trading path (the active-deal counts run on every
// deal-start decision) and on the circuit breaker's periodic realized-loss aggregation. These indexes
// never change query results, only their speed. MongoDB builds them in the background, so an existing
// large collection keeps serving reads/writes while they build on first startup after upgrade.
//   { botId, status }        — getDeals({ botId, status: 0 }) active-deal count per bot (deal-start path)
//   { botId, pair, status }  — getDeals({ botId, pair, status: 0 }) active-deal count per pair (deal-start path)
//   { status }               — status-only scans (e.g. all active / all completed)
//   { sellData.date, status }— the circuit-breaker close-date range sum and the close-date range reports
DealSchema.index({ status: 1 });
DealSchema.index({ botId: 1, status: 1 });
DealSchema.index({ botId: 1, pair: 1, status: 1 });
DealSchema.index({ 'sellData.date': 1, status: 1 });


module.exports = {

	'Bots': mongoose.model('Bots', BotSchema),
	'Deals': mongoose.model('Deals', DealSchema)
};

