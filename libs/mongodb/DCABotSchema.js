const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const BotSchema = new Schema({
	active: Boolean,
	botId: String,
	botName: String,
	config: Object,
	date: Date,
}, {
	collection: 'bots',
	timestamps: true
});


const DealSchema = new Schema({
	active: Boolean,
	botId: String,
	botName: String,
	dealId: String,
	exchange: String,
	pair: String,
	market: String,
	date: Date,
	status: Number,
	config: Object,
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

