const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ServerSchema = new Schema({
	serverId: String,
	created: Date,
	data: Object,
}, {
	collection: 'server',
	timestamps: true
});



module.exports = {

	'ServerSchema': mongoose.model('ServerSchema', ServerSchema)
};

