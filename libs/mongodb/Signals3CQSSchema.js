const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const Signals3CQSSchema = new Schema({
	bot_id: { type: String, required: true },
	signal_id: { type: String, required: true },
	signal_id_parent: String,
	signal_data: Object,
	created: Date,
	created_parent: Date
}, {
	collection: 'signals_3cqs',
	timestamps: true
});


Signals3CQSSchema.index({ bot_id: 1, signal_id: 1 }, { unique: true });


module.exports = {

	'Signals3CQSSchema': mongoose.model('Signals3CQSSchema', Signals3CQSSchema)
};

