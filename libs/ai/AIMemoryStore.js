'use strict';


// Database-backed store for AIMemory — the `load / insert / setRating` interface
// AIMemory.init() expects, implemented over the ai_learning Mongoose model.
// Kept separate from AIMemory so the learning logic stays pure and unit-testable
// while this thin adapter owns the persistence. Every method is best-effort at the
// call site (AIMemory swallows errors), but we keep them defensive here too so a
// learning-store hiccup can never disturb the chat.


const AILearning = require(__dirname + '/../mongodb/AILearningSchema.js').AILearningSchema;
const AIMeta = require(__dirname + '/../mongodb/AIMetaSchema.js').AIMetaSchema;


// Load the corpus, newest first, capped so a runaway corpus can't blow up memory.
// Returns plain objects (lean) — AIMemory only reads fields, never mutates docs.
async function load(cap) {

	const limit = (typeof cap === 'number' && cap > 0) ? cap : 5000;

	return await AILearning.find({}, {
		id: 1, source: 1, question: 1, route: 1, tools: 1,
		confidence: 1, grounded: 1, rating: 1, created_at: 1, _id: 0
	})
	.sort({ created_at: -1 })
	.limit(limit)
	.lean();
}


// Insert one record, then prune anything beyond maxRecords (oldest first) so the
// corpus stays bounded. Pruning is a cheap capped scan; at our scale (thousands of
// rows) it is negligible and only runs on the write path.
async function insert(record, opts) {

	const maxRecords = (opts && typeof opts.maxRecords === 'number' && opts.maxRecords > 0) ? opts.maxRecords : 5000;

	await AILearning.create(record);

	const total = await AILearning.estimatedDocumentCount();

	if (total > maxRecords) {

		// Find the created_at cutoff: keep the newest maxRecords, delete older.
		const cutoff = await AILearning.find({}, { created_at: 1, _id: 0 })
			.sort({ created_at: -1 })
			.skip(maxRecords)
			.limit(1)
			.lean();

		if (cutoff && cutoff.length > 0) {

			await AILearning.deleteMany({ created_at: { $lte: cutoff[0].created_at } });
		}
	}
}


async function setRating(id, rating) {

	await AILearning.updateOne({ id: id }, { $set: { rating: rating } });
}


// Small key/value bookkeeping (e.g. which shipped-default version has been merged). Best-effort:
// returns null on any read error so callers degrade gracefully.
async function getMeta(key) {

	try {
		const row = await AIMeta.findOne({ key: key }, { value: 1, _id: 0 }).lean();
		return row ? row.value : null;
	}
	catch (e) { return null; }
}

async function setMeta(key, value) {

	await AIMeta.updateOne({ key: key }, { $set: { value: value, updated_at: Date.now() } }, { upsert: true });
}


module.exports = { load, insert, setRating, getMeta, setMeta };
