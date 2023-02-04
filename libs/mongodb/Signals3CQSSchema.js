const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const Signals3CQSSchema = new Schema({
	signal_id: { type: String, unique: true },
	signal_id_parent: String,
	signal_data: Object,
	created: Date,
	created_parent: Date
}, {
	collection: 'signals_3cqs',
	timestamps: true
});



module.exports = {

	'Signals3CQSSchema': mongoose.model('Signals3CQSSchema', Signals3CQSSchema)
};

