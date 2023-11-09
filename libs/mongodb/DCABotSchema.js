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
	panicSell: Boolean,
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
	dealMax: Number
}, {
	collection: 'deals',
	timestamps: true
});


module.exports = {

	'Bots': mongoose.model('Bots', BotSchema),
	'Deals': mongoose.model('Deals', DealSchema)
};

