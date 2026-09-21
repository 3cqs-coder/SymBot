'use strict';

// Tests two warn-only Watchdog checks registered by System.js that previously shipped with no coverage:
//
//   1. logSecretScanCheck — the defense-in-depth secret-leak DETECTOR. It scans recent log files for a
//      credential that reached disk by some route OTHER than the central logger. It is the safety net for
//      Common.redactSecrets, so it MUST be at least as broad as the redactor: every secret shape the redactor
//      knows must also be detectable here, or the net has a blind spot. The cross-check below drove a real fix
//      (the scanner had no Telegram-token pattern and a narrower credential-field list than the redactor). It
//      must also NOT fire on the redactor's own [REDACTED] output (no false positives that train operators to
//      ignore the warning).
//
//   2. ipFilterSpoofableCheck — warns when an IP allow/deny filter is enabled while SymBot trusts client-
//      supplied forwarded-IP headers (the filter is then bypassable by header spoofing on a directly-reachable
//      instance). Pure function of appData with a clear truth table.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const System = require('../../app/System.js');
const Common = require('../../app/Common.js');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function eq(a, b, m) { assert.strictEqual(a, b, m + ' (got ' + JSON.stringify(a) + ')'); passed++; }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'symbot-logscan-'));

// ── logSecretScanCheck ────────────────────────────────────────────────────────────
System.init({ Common: { logDir: () => TMP, logger: function () {} } });

// Write one log file and scan it. Returns the finding (or null).
function scanOne(content) {
	fs.writeFileSync(path.join(TMP, 'scan.log'), content + '\n', 'utf8');
	return System.logSecretScanCheck();
}

console.log('\nlogSecretScanCheck — cross-check with the central redactor:');

// A representative secret for every shape Common.redactSecrets scrubs. For each: the redactor must know it
// (redacting changes the string), the scanner must DETECT the raw form (no blind spot), and the scanner must
// NOT fire on the redactor's own output (no false positive).
const CASES = [
	[ 'scoped api key',   'auth key=symb_live_abc123_0123456789abcdef0 ok' ],
	[ 'default api key',  'auth key=symb_auto_0123456789abcdef00 ok' ],
	[ 'url credentials',  'connect mongodb://user:s3cretPassw0rd@db:27017/x' ],
	[ 'url secret param', 'GET /webhook?token=s3cretValue123&x=1' ],
	[ 'bearer token',     'header Authorization: Bearer abcDEF123456ghiJKLmno' ],
	[ 'telegram token',   'GET https://api.telegram.org/bot123456789:ABCdefGHI_jklMNOpqrs-tuv012345/sendMessage' ],
	[ 'apiToken field',   'cfg apiToken="s3cretValue12345"' ],
	[ 'api_token field',  'cfg api_token: s3cretValue12345' ],
	[ 'apiKey field',     'cfg apiKey="s3cretValue12345"' ],
	[ 'apiPassphrase',    'cfg apiPassphrase: s3cretValue12345' ],
	[ 'apiPassword',      'cfg apiPassword=s3cretValue12345' ],
	[ 'passphrase',       'cfg passphrase: s3cretValue12345' ],
	[ 'password',         'cfg password="s3cretValue12345"' ],
	[ 'smtp_pass',        'cfg smtp_pass: s3cretValue12345' ],
	[ 'bot_token',        'cfg bot_token="s3cretValue12345"' ],
	[ 'private_key',      'cfg private_key: s3cretValue12345' ],
	[ 'token_id',         'cfg token_id="s3cretValue12345"' ]
];

for (const [ name, raw ] of CASES) {

	const redacted = Common.redactSecrets(raw);

	ok(redacted !== raw, name + ': the central redactor knows this shape (it changes the line)');
	ok(scanOne(raw) !== null, name + ': the scanner DETECTS the raw secret (safety net has no blind spot)');
	eq(scanOne(redacted), null, name + ": the scanner does NOT fire on the redactor's own [REDACTED] output");
}

console.log('\nlogSecretScanCheck — basics:');
eq(scanOne('a normal log line with no secrets at all, just words and 12345'), null, 'a clean log line yields no finding');
const multi = scanOne('apiToken="s3cretValue12345"\nAuthorization: Bearer abcDEF123456ghiJKLmno');
ok(multi && multi.action === 'watchdog.log_secret_detected', 'a file with real secrets yields a log_secret_detected finding');
ok(multi && !/s3cretValue12345/.test(multi.detail), 'the finding NEVER echoes the secret value it warns about');

// ── ipFilterSpoofableCheck ──────────────────────────────────────────────────────────
console.log('\nipFilterSpoofableCheck:');

function checkIp(appData) { System.init({ appData: appData }); return System.ipFilterSpoofableCheck(); }

eq(checkIp({ security: { trust_proxy: false }, ip_filter: { server: { enabled: true } } }), null,
	'trust_proxy=false → headers are ignored, so a filter is not spoofable (no finding)');
eq(checkIp({ ip_filter: {} }), null, 'no IP filter configured → nothing to warn about');
eq(checkIp({}), null, 'no ip_filter block at all → no finding');

let r = checkIp({ ip_filter: { server: { enabled: true } } });
ok(r && r.action === 'watchdog.ip_filter_spoofable' && r.target === 'server-wide', 'server-wide filter under default trust_proxy is flagged');

r = checkIp({ ip_filter: { login: { enabled: true } } });
ok(r && r.target === 'login', 'login filter under default trust_proxy is flagged');

r = checkIp({ ip_filter: { server: { enabled: true }, login: { enabled: true } } });
ok(r && r.target === 'server-wide and login', 'both filters flagged together');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

console.log('\nWatchdogSystemChecks: ' + passed + ' assertions passed');
process.exit(0);
