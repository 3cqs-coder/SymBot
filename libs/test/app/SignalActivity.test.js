'use strict';

// Pins the pure logic of the Signal Activity recorder (libs/app/SignalActivity.js): the path recognizer
// (metaFromRequest) that decides WHICH inbound webhook requests are logged, and the outcome classifier
// (parseOutcome) that turns an action handler's response into a normalized result. The recorder hook in
// processWebHook depends on both, and the boot-time Watchdog check keys off the recognizer — so a
// refactor that breaks either would silently stop signals being logged. These are pure and DB-free.

const assert = require('assert');
const SignalActivity = require('../../app/SignalActivity.js');

// Minimal init so getClientIp lookups have a shareData (recognition must not depend on it).
SignalActivity.init({ Common: { getClientIp: function () { return '203.0.113.7'; } } });

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

function req(body, headers) { return { 'body': body || {}, 'headers': headers || {} }; }

// ── Recognizer: the four per-command bot endpoints map to their action ───────
ok(SignalActivity.metaFromRequest(req(), '/api/bots/B1/start_deal').action === 'entry', 'start_deal => entry');
ok(SignalActivity.metaFromRequest(req(), '/api/bots/B1/add_funds').action === 'add_funds', 'add_funds => add_funds');
ok(SignalActivity.metaFromRequest(req(), '/api/bots/B1/close').action === 'close', 'close => close');
ok(SignalActivity.metaFromRequest(req(), '/api/bots/B1/panic_sell').action === 'panic_sell', 'panic_sell => panic_sell');

// bot id is captured
ok(SignalActivity.metaFromRequest(req(), '/api/bots/ABC123/start_deal').bot_id === 'ABC123', 'bot id captured from path');

// ── Recognizer: the single dispatcher endpoint reads the action from the body ─
ok(SignalActivity.metaFromRequest(req({ action: 'close' }), '/api/signal/B1').action === 'close', 'dispatcher reads body.action');
ok(SignalActivity.metaFromRequest(req({ action: 'ENTRY' }), '/api/signal/B1').action === 'entry', 'dispatcher action is lower-cased');
ok(SignalActivity.metaFromRequest(req({ action: 'nonsense' }), '/api/signal/B1') === null, 'dispatcher with an unknown action is not recorded');
ok(SignalActivity.metaFromRequest(req({}), '/api/signal/B1') === null, 'dispatcher with no action is not recorded');

// ── Recognizer: deal-scoped variants (concurrent-deal pairs) keyed by deal id ─
const dc = SignalActivity.metaFromRequest(req(), '/api/deals/DEAL9/close');
ok(dc && dc.action === 'close', 'deal-scoped close => close');
ok(dc.deal_id === 'DEAL9' && (dc.bot_id === '' || dc.bot_id == null), 'deal-scoped close keyed by deal id, no bot id');
ok(SignalActivity.metaFromRequest(req(), '/api/deals/DEAL9/add_funds').action === 'add_funds', 'deal-scoped add_funds => add_funds');
ok(SignalActivity.metaFromRequest(req(), '/api/deals/DEAL9/panic_sell').action === 'panic_sell', 'deal-scoped panic_sell => panic_sell');
ok(SignalActivity.metaFromRequest(req(), '/api/deals/DEAL9/start_deal') === null, 'there is no deal-scoped entry (start is bot-scoped only)');

// ── Recognizer: everything else returns null (only genuine signals are logged) ─
ok(SignalActivity.metaFromRequest(req(), '/api/bots/B1/enable') === null, 'a non-signal bot route is not recorded');
ok(SignalActivity.metaFromRequest(req(), '/api/deals/D1/show') === null, 'a read route is not recorded');
ok(SignalActivity.metaFromRequest(req(), '/api/config') === null, 'a config route is not recorded');
ok(SignalActivity.metaFromRequest(req(), '') === null, 'an empty path is not recorded');

// ── Recognizer: pulls pair, correlation key, source ip; coerces a non-string pair ─
const meta = SignalActivity.metaFromRequest(req({ pair: 'BTC/USD', signal_id: 'sig-9' }), '/api/bots/B1/start_deal');
ok(meta.pair === 'BTC/USD', 'pair captured');
ok(meta.signal_key === 'sig-9', 'signal_id captured as the correlation key');
ok(meta.source_ip === '203.0.113.7', 'source ip resolved');
ok(typeof meta.received === 'number', 'received timestamp captured for latency');

const metaObjPair = SignalActivity.metaFromRequest(req({ pair: { $ne: null } }), '/api/bots/B1/start_deal');
ok(typeof metaObjPair.pair === 'string', 'a non-string pair is coerced to a string (never an operator object)');

// Idempotency-Key header is honored as the correlation key.
ok(SignalActivity.metaFromRequest(req({}, { 'idempotency-key': 'idem-1' }), '/api/bots/B1/close').signal_key === 'idem-1', 'Idempotency-Key header used as correlation key');

// ── Outcome classifier ───────────────────────────────────────────────────────
let o = SignalActivity.parseOutcome({ success: true, data: { deal_id: 'd1' } });
ok(o.outcome === 'started' && o.deal_id === 'd1' && o.reason === 'Deal d1 opened', 'entry that opens a deal => started');

o = SignalActivity.parseOutcome({ success: true, data: 'Safety order placed' });
ok(o.outcome === 'processed' && o.reason === 'Safety order placed', 'success without a deal id => processed');

o = SignalActivity.parseOutcome({ success: false, data: 'Circuit Breaker Active: loss limit' });
ok(o.outcome === 'rejected' && o.reason === 'Circuit Breaker Active: loss limit', 'failure => rejected with the reason');

o = SignalActivity.parseOutcome({ success: true, duplicate: true, data: 'Duplicate signal ignored (idempotency).' });
ok(o.outcome === 'duplicate', 'duplicate => duplicate (wins over success)');

o = SignalActivity.parseOutcome({ success: false, error: 'Invalid Token' });
ok(o.outcome === 'rejected' && o.reason === 'Invalid Token', 'auth-layer error field is used as the reason');

o = SignalActivity.parseOutcome('{"success":false,"data":"blacklisted"}');
ok(o.outcome === 'rejected' && o.reason === 'blacklisted', 'a JSON string body is parsed');

o = SignalActivity.parseOutcome('not json at all');
ok(o.reason === 'not json at all', 'a non-JSON string body is kept as the reason');

// ── sanitizeSource: stable, bounded slug ─────────────────────────────────────
ok(SignalActivity.sanitizeSource('3CQS') === '3cqs', 'source is lower-cased');
ok(SignalActivity.sanitizeSource('  Signal-Bot!! ') === 'signalbot', 'non [a-z0-9_] stripped, trimmed');
ok(SignalActivity.sanitizeSource('') === 'other', 'empty source => other');
ok(SignalActivity.sanitizeSource(null) === 'other', 'null source => other');
ok(SignalActivity.sanitizeSource('a'.repeat(100)).length === 24, 'source slug is length-capped');

// ── classifySource: loopback (raw socket) trusts a declared channel; external is credential-based ─
// A req with a specific raw TCP peer address (req.socket.remoteAddress) — the UNSPOOFABLE trust boundary.
function reqS(body, headers, socketIp) { return { 'body': body || {}, 'headers': headers || {}, 'socket': { 'remoteAddress': socketIp || '' } }; }

// An EXTERNAL socket declaring a source is NOT trusted — classified by credential instead.
ok(SignalActivity.classifySource(reqS({}, { 'x-signal-source': '3cqs' }, '203.0.113.7')) === 'api',
	'a declared source from an EXTERNAL socket is not trusted (=> api)');
// SPOOF ATTEMPT: an external caller forging X-Forwarded-For: 127.0.0.1 must STILL not be trusted, because
// classification reads the raw socket peer, not the proxy-aware IP. This proves the F1 fix.
ok(SignalActivity.classifySource(reqS({}, { 'x-signal-source': 'evil', 'x-forwarded-for': '127.0.0.1' }, '203.0.113.7')) === 'api',
	'a spoofed X-Forwarded-For loopback from an external socket is NOT trusted (=> api)');
ok(SignalActivity.classifySource(reqS({}, { 'api-token': 'abc' }, '203.0.113.7')) === 'signal_bot',
	'the shared webhook api-token => signal_bot');
ok(SignalActivity.classifySource(reqS({}, {}, '203.0.113.7')) === 'api', 'a plain credentialed call => api');

// A genuine LOOPBACK socket IS trusted to name its channel.
ok(SignalActivity.classifySource(reqS({}, { 'x-signal-source': '3cqs' }, '127.0.0.1')) === '3cqs',
	'a loopback socket declaring X-Signal-Source is trusted (=> 3cqs)');
ok(SignalActivity.classifySource(reqS({}, { 'x-signal-source': '3cqs' }, '::ffff:127.0.0.1')) === '3cqs',
	'IPv4-mapped IPv6 loopback is trusted');
ok(SignalActivity.classifySource(reqS({}, { 'x-signal-source': 'Future_Source' }, '127.0.0.1')) === 'future_source',
	'a NEW loopback-declared source is accepted verbatim (sanitized) — future-proof, no code change');

// ── retentionFor: per-source budget with a default fallback for unknown sources ─
ok(SignalActivity.retentionFor('3cqs') === 200000, '3cqs gets the large firehose budget');
ok(SignalActivity.retentionFor('signal_bot') === 50000, 'signal_bot gets the generous budget');
ok(SignalActivity.retentionFor('a_brand_new_source') === SignalActivity.retentionFor('default_unknown_xyz'),
	'any unknown/new/renamed source falls back to the same default budget');
ok(SignalActivity.retentionFor('a_brand_new_source') > 0, 'the default budget is a positive number');

// ── latencyStats: diagnosis stats over latency_ms values ─────────────────────
let ls = SignalActivity.latencyStats([]);
ok(ls.n === 0 && ls.avg === null && ls.max === null && ls.slow === 0, 'empty latency set => zeros/nulls');

ls = SignalActivity.latencyStats([1000, 2000, 3000, 30085]);
ok(ls.n === 4 && ls.max === 30085, 'max is the largest value');
ok(ls.avg === Math.round((1000 + 2000 + 3000 + 30085) / 4), 'avg is the mean');
ok(ls.slow === 1, 'slow counts only replies over the 10s threshold (just the 30085)');

ls = SignalActivity.latencyStats([5, 4, 3, 2, 1]);
ok(ls.max === 5 && ls.avg === 3, 'unsorted input is handled (max=5, avg=3)');

ls = SignalActivity.latencyStats(Array.from({ length: 20 }, (_, i) => i + 1));
ok(ls.p95 === 20, 'p95 nearest-rank picks the top of a 1..20 set');

console.log('SignalActivity.test.js: ' + passed + ' assertions passed');
