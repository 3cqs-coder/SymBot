'use strict';

// Tests for the central log-secret redactor in libs/app/Common.js (redactSecrets). It scrubs
// every log line before it reaches the dated file, the console, or the browser live-stream, so a
// credential can never persist in a log an operator later shares to diagnose an issue. These
// assert BOTH that real secrets are masked AND that ordinary log lines — price ticks and the bare
// deal/bot/instance UUIDs that appear everywhere — are left untouched (no over-redaction).

const assert = require('assert');
const Common = require('../../app/Common.js');
const redact = Common.redactSecrets;

let passed = 0, failed = 0;
function test(name, fn) {
	try { fn(); passed++; console.log('  ok   - ' + name); }
	catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); }
}

const HEX64 = 'a1b2c3d4'.repeat(8); // 64 hex chars

console.log('\nredactSecrets — secrets are masked:');

const leaks = [
	['scoped API key keeps prefix, drops secret', 'used symb_live_ab12cd34ef56_' + HEX64 + ' now', /symb_live_ab12cd34ef56_\[REDACTED\]/, HEX64],
	['default symb_auto_ key fully redacted', 'auto generated as: symb_auto_' + HEX64, /symb_auto_\[REDACTED\]/, HEX64],
	['apiToken in JSON',        '{"apiToken":"abcdef123456","pair":"BTC/USD"}', null, 'abcdef123456'],
	['api_secret in JSON',      '{"api_secret":"deadbeefcafe"}', null, 'deadbeefcafe'],
	['password key=value',      'login password=hunter2 done', null, 'hunter2'],
	['passphrase key=value',    'passphrase=correcthorse', null, 'correcthorse'],
	['mongodb userinfo',        'mongodb://admin:s3cr3t@host:27017/SymBot', null, 's3cr3t'],
	['webhook token query',     'POST https://discord.com/api/webhooks/1/x?token=SUPERSECRET failed', null, 'SUPERSECRET'],
	['bearer token',            'Authorization: Bearer eyJhbGciOiJI.abcDEF123', null, 'eyJhbGciOiJI.abcDEF123'],
	['telegram token_id',       'telegram token_id: 998877:AAF-xyzTOKEN', null, 'AAF-xyzTOKEN'],
	['telegram bot-token URL',  'Telegram Error: request to https://api.telegram.org/bot998877665:AAF-xyzABCdefGHIjklMNOpqrSTUvwx123/sendMessage failed', /bot998877665:\[REDACTED\]/, 'AAF-xyzABCdefGHIjklMNOpqrSTUvwx123']
];

for (const [name, input, mustMatch, mustNotContain] of leaks) {
	test(name, () => {
		const out = redact(input);
		assert.ok(!out.includes(mustNotContain), 'secret value still present: ' + out);
		assert.ok(out.includes('[REDACTED]'), 'no [REDACTED] marker: ' + out);
		if (mustMatch) { assert.ok(mustMatch.test(out), 'expected shape not found: ' + out); }
	});
}

console.log('\nredactSecrets — ordinary lines are untouched:');

const safe = [
	['price tick', 'Pair: ABT/USD Last Price: $0.1727 DCA Price: $0.1719 Target: $0.1747 Profit: -0.18%'],
	['bare deal UUID', 'Deal 550e8400-e29b-41d4-a716-446655440000 closed with profit 1.2%'],
	['key prefix only (no secret)', 'created key symb_live_ab12cd34ef56 (read-only) by 127.0.0.1'],
	['invalid-token audit line (no value)', 'Invalid api key used by 203.0.113.7'],
	['plain sentence with the word token', 'The next signal token will open a deal soon'],
	['the word bot with digits but no token', 'Instance bot 12345 started and is running']
];

for (const [name, input] of safe) {
	test(name, () => {
		assert.strictEqual(redact(input), input, 'line was altered: ' + redact(input));
	});
}

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
