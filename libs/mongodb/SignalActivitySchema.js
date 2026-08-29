const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Read-only record of inbound Signal Bot activity: every authenticated webhook/API signal (entry,
// add_funds, close, panic_sell) and what SymBot did with it. Purely observational — it is written
// best-effort AFTER the action's outcome is known and is never on the trading path. Lets an operator
// confirm what an external source (a TradingView alert, the 3CQS client, a custom script, …) actually
// did to a Signal Bot.
//
// Privacy: only the parsed essentials are stored — never the raw request body, which carries the
// credential. The token is already stripped from the body before an action runs; nothing here re-adds it.
const SignalActivitySchema = new Schema({
	server_id:  { type: String, default: '' },       // owning instance — scopes every read/prune/backup to
	                                                 // this instance (Hub app.json sharing puts many
	                                                 // instances in one DB), exactly like the audit log.
	source:     { type: String, default: 'other' },  // logical channel the signal came from: 3cqs |
	                                                 // signal_bot | api | other | <future>. Drives per-source
	                                                 // retention so a chatty source can't evict a quiet one.
	date:       { type: Date, required: true },     // when the signal was received/recorded
	action:     { type: String, required: true },   // entry | add_funds | close | panic_sell | close_all
	bot_id:     String,
	pair:       String,
	source_ip:  String,
	success:    Boolean,
	duplicate:  { type: Boolean, default: false },
	outcome:    String,        // normalized: started | processed | rejected | duplicate (for clean filtering)
	reason:     String,        // human-readable detail (deal opened, rejection reason, held below target, …)
	deal_id:    String,
	http_status: Number,       // the response status code the signal received (200 / 403 / 500 / …)
	latency_ms:  Number,       // server processing time: received → response, in milliseconds
	signal_key:  String,       // correlation/idempotency key (Idempotency-Key / idempotency_key / signal_id)
	signal_ts:   Date          // the signal's own timestamp if the sender included one (enables signal-lag analysis)
}, {
	collection: 'signal_activity',
	timestamps: true
});

// All hot queries are scoped to one instance (server_id), so every index leads with it. The per-source
// index also serves the source-aware overflow prune (newest-N per {server_id, source}); the bot index
// serves the UI's per-bot filter; the plain {server_id, date} serves the unfiltered/other-filter listing.
SignalActivitySchema.index({ server_id: 1, source: 1, date: -1 });
SignalActivitySchema.index({ server_id: 1, bot_id: 1, date: -1 });
SignalActivitySchema.index({ server_id: 1, date: -1 });

// Auto-prune: entries expire 30 days after their timestamp so the collection is self-maintaining and can
// never grow unbounded (MongoDB's background TTL monitor handles the deletion). This is the TIME ceiling —
// nothing survives past it regardless of source. The source-aware count prune (in SignalActivity.js) runs
// UNDER this ceiling to keep any single source from crowding out the others before their time is up.
SignalActivitySchema.index({ date: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });


module.exports = {

	'SignalActivitySchema': mongoose.model('SignalActivitySchema', SignalActivitySchema)
};
