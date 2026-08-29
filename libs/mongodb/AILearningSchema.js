'use strict';

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// One learned "pattern" for the AI chat's self-improvement loop: the question a
// user asked and the route/tools that answered it — deliberately PATTERNS ONLY,
// never any values from the answer (no P&L, balances, deal IDs). That keeps the
// corpus agnostic and safe to pool or share.
//
// Not scoped by server_id on purpose: this is generic know-how, not instance
// state, so one corpus per database is correct — a Hub that shares a database
// aggregates its instances' learning for free. `source` records where a pattern
// came from: 'local' (this instance learned it), 'seed' (shipped with SymBot),
// 'community' (an imported pack), or 'hub' (relayed/aggregated).
const AILearningSchema = new Schema({
	id:         { type: String, required: true, unique: true },
	source:     { type: String, enum: ['local', 'seed', 'community', 'hub'], default: 'local', index: true },
	question:   { type: String, required: true },
	route:      { type: String, default: null },
	tools:      { type: [String], default: [] },
	confidence: { type: String, default: null },   // 'high' | 'medium' | 'low' | null
	grounded:   { type: Boolean, default: true },  // deterministic numeric check passed
	rating:     { type: Number, default: null },   // user 👍 (1) / 👎 (-1) / unrated (null)
	note:       { type: String, default: null },
	latency_ms: { type: Number, default: null },
	created_at: { type: Number, default: () => Date.now(), index: true },
}, {
	collection: 'ai_learning',
	timestamps: true
});

module.exports = {
	'AILearningSchema': mongoose.model('AILearningSchema', AILearningSchema)
};
