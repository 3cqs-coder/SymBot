'use strict';

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// A user-defined, database-backed scheduled job managed by the central Scheduler.
// Each row carries a `type` that maps to a registered handler; the built-in type is
// 'ai_analysis', which runs the `prompt` through the AI chat (tool-augmented, strictly
// read-only) and delivers the answer via notification. Nothing a schedule can do places
// or changes a trade — schedules only produce reports and alerts.
//
// Rows are scoped by `server_id` so that, under the Hub, an instance runs only its own
// schedules. System jobs defined in app.json (e.g. the database backup) are NOT stored
// here — they are registered with the Scheduler directly from config.
const ScheduleSchema = new Schema({
	schedule_id: { type: String, required: true, unique: true },
	server_id:   { type: String, default: '', index: true },
	type:        { type: String, default: 'ai_analysis', index: true },   // maps to a Scheduler handler
	label:       { type: String, default: '' },        // human name, e.g. "Morning deal summary"
	kind:        { type: String, enum: [ 'once', 'cron' ], required: true },
	run_at:      { type: Date, default: null },         // for kind 'once' (UTC)
	cron:        { type: String, default: '' },         // for kind 'cron' (5-field, UTC)
	prompt:      { type: String, default: '' },         // ai_analysis: the read-only question to run
	settings:    { type: Schema.Types.Mixed, default: {} },  // type-specific config (e.g. backup: retention, sftp, encrypted password)
	enabled:     { type: Boolean, default: true },
	timezone:    { type: String, default: '' },         // IANA tz for DST-correct cron eval; '' = evaluate cron as UTC (legacy)
	catchup:     { type: String, enum: [ 'skip', 'once', 'all' ], default: 'skip' },  // missed-run policy after downtime
	concurrency: { type: String, enum: [ 'forbid', 'allow' ], default: 'forbid' },    // what to do if a run is already active
	retries:     { type: Number, default: 0 },          // extra attempts on failure (0 = no retry)
	retry_backoff: { type: String, enum: [ 'fixed', 'exponential' ], default: 'fixed' },  // delay growth between attempts
	retry_delay_ms: { type: Number, default: 0 },       // base delay between attempts (0 = use the default)
	last_run:    { type: Date, default: null },
	last_status: { type: String, default: '' },         // 'ok' | 'error' | 'timed_out' | 'missed' | ''
	run_count:   { type: Number, default: 0 },
	consecutive_failures: { type: Number, default: 0 }, // resets on success; drives failure escalation
	// Off-site (SFTP) upload tracking for the backup singleton only. The upload is intentionally fire-and-forget
	// — it must never fail the local backup — so its outcome is tracked here, separately from the run status
	// above, and surfaced by the offsite_backup_last_upload_failed Watchdog. Left at defaults for other types.
	last_offsite_status: { type: String, default: '' },          // 'ok' | 'error' | ''
	last_offsite_at: { type: Date, default: null },
	offsite_consecutive_failures: { type: Number, default: 0 },  // resets on a successful upload
	schema_version: { type: Number, default: 5 }        // document shape version, for lazy forward-migration
}, {
	collection: 'schedules',
	timestamps: true
});

// Singleton job types (e.g. the database backup) may exist at most once per instance.
// This guards against a race where several Hub worker threads sharing one database all
// try to create the backup row on their first boot.
ScheduleSchema.index({ server_id: 1, type: 1 }, { unique: true, partialFilterExpression: { type: 'backup' } });

module.exports = {
	'ScheduleSchema': mongoose.model('ScheduleSchema', ScheduleSchema)
};
