'use strict';

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// One recorded execution of a schedule. The full output is kept here (rather than only in
// the fired notification) so a schedule can show its run history over time; notifications
// themselves are truncated. Rows are pruned per schedule to a maximum count, oldest first.
const ScheduleRunSchema = new Schema({
	run_id:      { type: String, required: true, unique: true },
	schedule_id: { type: String, required: true, index: true },   // globally-unique schedule UUID
	server_id:   { type: String, default: '' },
	type:        { type: String, default: 'ai_analysis' },
	label:       { type: String, default: '' },
	ran_at:      { type: Date, default: Date.now, index: true },
	status:      { type: String, default: '' },        // 'ok' | 'error' | 'timed_out' | 'skipped'
	manual:      { type: Boolean, default: false },     // true for a "Run now"
	duration_ms: { type: Number, default: 0 },
	attempts:    { type: Number, default: 1 },          // how many tries this run took (>1 = it was retried)
	output:      { type: String, default: '' },         // full result text
	schema_version: { type: Number, default: 1 }        // document shape version, for lazy forward-migration
}, {
	collection: 'schedule_runs',
	timestamps: true
});

// Compound index for the hot query: recent runs are listed with find({server_id}).sort({ran_at:-1}).
// Without a {server_id, ran_at} index this scans and sorts in memory on a large (Hub-shared) history —
// the sibling ScheduleSchema already indexes server_id, so match it here.
ScheduleRunSchema.index({ server_id: 1, ran_at: -1 });

module.exports = {
	'ScheduleRunSchema': mongoose.model('ScheduleRunSchema', ScheduleRunSchema)
};
