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
	journal: Object,
	// Persisted per-deal STATE blobs that the engine sets and reads back across restarts. They MUST be
	// declared here: the schema is strict (Mongoose default), so an undeclared field is silently dropped from
	// a Deals.updateOne({...}, { field }) write — the flag would appear to work in-memory but never reach the
	// database, so it would vanish on restart (and a tick that re-reads the deal from the DB would not see it).
	//   partialSell — the slippage-safe graceful-close hold state (the held remainder + resume info).
	// (Stopping new safety orders — "pause averaging" — is NOT a separate field: it uses the declared pausedBuy
	//  flag, the single source of truth the tick guard reads. The persistent-vs-transient classification of a
	//  buy/sell error likewise lives in the one pauseReason taxonomy, e.g. 'buy_error_persistent'.)
	partialSell: Object
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
//   { status, pair, sellData.date }
//                            — pair-filtered completed-deal reports (per-pair performance, a pair-scoped
//                              performance summary, and getDealsByPair for a completed pair) match on
//                              status + pair and window/sort on the close date; the only other pair index
//                              is botId-prefixed, so without this those reads scan more than they need.
DealSchema.index({ status: 1 });
DealSchema.index({ botId: 1, status: 1 });
DealSchema.index({ botId: 1, pair: 1, status: 1 });
DealSchema.index({ 'sellData.date': 1, status: 1 });
DealSchema.index({ status: 1, pair: 1, 'sellData.date': -1 });


module.exports = {

	'Bots': mongoose.model('Bots', BotSchema),
	'Deals': mongoose.model('Deals', DealSchema)
};

