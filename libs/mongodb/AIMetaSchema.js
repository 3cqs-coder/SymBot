'use strict';

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Tiny key/value store for AI-learning bookkeeping that isn't itself a pattern — e.g. which
// version of the shipped default corpus has already been merged into the writable corpus.
// Lives in the same (agnostic, one-per-database) space as ai_learning, so a Hub sharing a
// database shares this too.
const AIMetaSchema = new Schema({
	key:        { type: String, required: true, unique: true },
	value:      { type: String, default: null },
	updated_at: { type: Number, default: () => Date.now() },
}, {
	collection: 'ai_meta',
	timestamps: true
});

module.exports = {
	'AIMetaSchema': mongoose.model('AIMetaSchema', AIMetaSchema)
};
