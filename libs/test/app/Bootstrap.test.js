'use strict';

// Shared startup guards (libs/app/Bootstrap.js). The version comparison is the part with real edge cases —
// numeric-not-lexical component compare, differing lengths, and non-numeric noise — so it is pinned here.
// (enforceNodeVersion/preferDnsOrder themselves are thin wrappers with process-global side effects —
// process.exit and dns.setDefaultResultOrder — verified by hand rather than unit-tested.)

const assert = require('assert');
const Bootstrap = require('../../app/Bootstrap.js');
const { isNodeOlder, formatUncaughtException, formatUnhandledRejection, installProcessGuards } = Bootstrap;

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

// Equal / newer → NOT older.
ok(isNodeOlder('22.0.0', '22.0.0') === false, 'equal version is not older');
ok(isNodeOlder('22.15.1', '22.15.1') === false, 'identical patch is not older');
ok(isNodeOlder('22.0.0', '24.1.0') === false, 'newer major is not older');
ok(isNodeOlder('22.9.0', '22.15.0') === false, 'newer minor is not older');
ok(isNodeOlder('22.15.0', '22.15.7') === false, 'newer patch is not older');

// Older → older.
ok(isNodeOlder('22.0.0', '20.19.0') === true, 'older major is older');
ok(isNodeOlder('22.15.0', '22.9.0') === true, 'older minor is older');
ok(isNodeOlder('22.15.5', '22.15.2') === true, 'older patch is older');

// The classic numeric-not-lexical trap: 22.9 vs 22.15 (a string compare would call "9" > "15").
ok(isNodeOlder('22.9.0', '22.15.0') === false, '22.15 is NOT older than 22.9 (numeric compare, not lexical)');
ok(isNodeOlder('22.15.0', '22.9.0') === true, '22.9 IS older than 22.15 (numeric compare, not lexical)');

// Differing lengths: a missing component reads as 0.
ok(isNodeOlder('22.1', '22.1.0') === false, '22.1.0 satisfies required 22.1');
ok(isNodeOlder('22.1.1', '22.1') === true, '22.1 (→22.1.0) is older than required 22.1.1');
ok(isNodeOlder('22', '24.5.1') === false, 'required bare major, newer runtime is fine');

// Non-numeric noise (a nightly/RC suffix on a component) is tolerated, not thrown on.
ok(isNodeOlder('22.0.0', '22.0.0-nightly20260101') === false, 'a -nightly patch suffix parses to its number, not older');
ok(isNodeOlder('22.5.0', '22.abc.0') === true, 'a non-numeric minor reads as 0 → older, never throws');

// ── fatal-error formatters (pure) ────────────────────────────────────────────
ok(/^Uncaught Exception: "boom" Stack: /.test(formatUncaughtException(new Error('boom'))), 'uncaught: message + stack');
ok(formatUncaughtException(null) === 'Uncaught Exception: null Stack: null', 'uncaught: null err does not throw (yields a "null" line, not a crash)');
ok(formatUnhandledRejection(new Error('nope')).indexOf('Unhandled Rejection: ') === 0 && /nope/.test(formatUnhandledRejection(new Error('nope'))), 'rejection: uses the Error (stack carries the message)');
ok(formatUnhandledRejection('a string reason') === 'Unhandled Rejection: a string reason', 'rejection: a non-Error reason is stringified, not dropped');
ok(formatUnhandledRejection(undefined) === 'Unhandled Rejection: undefined', 'rejection: undefined does not throw');

// ── installProcessGuards wiring (registers the handlers; routes to shutDown + logError) ──────────────
(function () {
	var logged = [], shutdowns = 0;
	var events = ['uncaughtException', 'unhandledRejection', 'SIGINT', 'SIGTERM', 'message'];
	var before = {};
	events.forEach(function (ev) { before[ev] = process.listeners(ev).slice(); });
	var added = function (ev) { return process.listeners(ev).filter(function (f) { return before[ev].indexOf(f) === -1; }); };

	installProcessGuards(function () { shutdowns++; }, function (m) { logged.push(m); });

	ok(added('uncaughtException').length === 1 && added('unhandledRejection').length === 1 && added('SIGINT').length === 1, 'registers exactly one uncaught/rejection/SIGINT handler');

	added('uncaughtException')[0](new Error('kaboom'));   // invoke directly — do NOT emit a real fatal event
	added('unhandledRejection')[0]('async fail');
	added('SIGINT')[0]();
	ok(logged.length === 2 && /kaboom/.test(logged[0]) && /async fail/.test(logged[1]), 'uncaught + rejection route to logError');
	ok(shutdowns === 1, 'SIGINT routes to shutDown');

	// A throwing logger must NOT propagate out of the handler (the guard keeps a fatal error non-fatal).
	var ueBeforeSecond = process.listeners('uncaughtException').slice();
	installProcessGuards(null, function () { throw new Error('logger down'); });
	var thrower = process.listeners('uncaughtException').filter(function (f) { return ueBeforeSecond.indexOf(f) === -1; })[0];
	assert.doesNotThrow(function () { thrower(new Error('x')); }, 'a logger failure inside the handler is swallowed'); passed++;

	// Remove ONLY the listeners this test added (precise per event), so nothing fires during the rest of the run.
	events.forEach(function (ev) { added(ev).forEach(function (f) { process.removeListener(ev, f); }); });
})();

// getCliArg — the shared CLI-argument parser used by BOTH entry points (instance + Hub), so they can't drift.
(function () {
	var saved = process.argv;
	process.argv = ['node', 'symbot.js', '--config=/tmp/app.json', '--serverid', 'S-42', '--flagonly'];
	ok(Bootstrap.getCliArg('config') === '/tmp/app.json', '--name=value form parses');
	ok(Bootstrap.getCliArg('serverid') === 'S-42', '--name value form parses');
	ok(Bootstrap.getCliArg('missing') === null, 'an absent argument returns null');
	ok(Bootstrap.getCliArg('flagonly') === null, 'a value-less trailing flag returns null (no following token)');
	process.argv = saved;
})();

console.log('Bootstrap: ' + passed + ' assertions passed');
process.exit(0);
