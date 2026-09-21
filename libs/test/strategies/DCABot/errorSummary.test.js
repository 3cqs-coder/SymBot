'use strict';

// summarizeExchangeError — the shared concise summarizer for ccxt/network errors, used by BOTH the connect
// path and the balance path so a many-KB JSON response body never floods the log or a UI alert. It must take
// only the first line, cap the length, and append the underlying socket cause code (which undici nests one or
// more levels down) so a bare "fetch failed" is self-diagnosing.

const assert = require('assert');
const DCABot = require('../../../strategies/DCABot/DCABot.js');
const f = DCABot.summarizeExchangeError;

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

ok(f({ message: 'line one\nstack two\nstack three' }) === 'line one', 'takes only the first line');

const capped = f({ message: 'x'.repeat(500) });
ok(capped.length === 301 && capped.endsWith('…'), 'caps a long message at 300 chars + ellipsis');

ok(f({ message: 'fetch failed', cause: { cause: { code: 'ETIMEDOUT' } } }) === 'fetch failed [ETIMEDOUT]', 'appends the nested undici cause code');
ok(f({ message: 'boom', code: 'ECONNREFUSED' }) === 'boom [ECONNREFUSED]', 'appends a direct error code');
ok(f({ message: 'plain', errno: -111 }) === 'plain [-111]', 'falls back to errno when no code');
ok(f('a plain string') === 'a plain string', 'handles a non-Error input');
ok(typeof f(null) === 'string', 'never throws on null');

console.log('errorSummary: ' + passed + ' assertions passed');