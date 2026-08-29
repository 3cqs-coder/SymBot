'use strict';

// Startup wiring shared by every SymBot entry point (symbot.js, symbot-hub.js), kept here so it stays in one
// place instead of drifting as near-duplicate copies. Two phases:
//   • PRE-REQUIRE guards (enforceNodeVersion, preferDnsOrder) MUST run before an entry point pulls in any
//     network- or feature-using module (mongoose / ccxt / undici / node:sqlite).
//   • installProcessGuards wires the SIGINT/SIGTERM/uncaughtException/unhandledRejection handlers after the
//     entry's own shutDown + logger exist.
// The module is written in plain ES5 (var / function, no template literals) and does NO network or heavy
// require at load time, so it can load and run on a very old or minimal runtime before anything else does.
// `require('dns')` is deferred to call time; package.json is read by path so this file can live anywhere.


// Pure: is `current` older than `required` (both dotted "x.y.z" version strings)? Compares component-wise and
// NUMERICALLY (so 22.9 < 22.15, not the reverse a string compare would give), tolerant of differing lengths
// and non-numeric noise (a "-nightly" suffix, etc.). Exposed for testing.
function isNodeOlder(required, current) {

	var toNums = function (v) { return String(v).split('.').map(function (n) { return parseInt(n, 10) || 0; }); };
	var r = toNums(required), c = toNums(current);

	for (var i = 0; i < r.length; i++) {
		if ((c[i] || 0) < r[i]) { return true; }
		if ((c[i] || 0) > r[i]) { return false; }
	}
	return false;
}

// Fail early and clearly if the runtime is older than package.json's engines.node, rather than crashing deep
// inside a dependency built for a newer Node with a cryptic stack. `rootDir` is the entry point's __dirname
// (the project root, where package.json lives); `appLabel` names the process in the message (e.g. "SymBot",
// "SymBot Hub"). A failure in the check itself never blocks startup — a missing/oddly-shaped engines field
// must not stop a valid runtime from starting.
function enforceNodeVersion(rootDir, appLabel) {

	var label = appLabel || 'SymBot';

	try {
		var required = require(rootDir + '/package.json').engines.node.replace(/[^0-9.]/g, '');
		if (isNodeOlder(required, process.versions.node)) {
			console.error('\n' + label + ' requires Node.js >= ' + required + ', but this process is running Node ' + process.versions.node + '.\nPlease upgrade Node.js and start ' + label + ' again.\n');
			process.exit(1);
		}
	}
	catch (e) { /* if the version check itself fails, don't block startup */ }
}


// Prefer IPv4 for outbound DNS resolution. Node resolves DNS "verbatim" by default (Node 17+), so it often
// tries a host's IPv6 address first. On a server whose IPv6 routing is broken or intermittently flapping —
// common on VPS hosts — that connection fails (ETIMEDOUT / ECONNREFUSED) and surfaces as a "fetch failed"
// network error, taking outbound connectivity (exchange calls and therefore trading, the database, the
// mailer, version checks, instance links) down even though IPv4 works perfectly. Preferring IPv4 makes SymBot
// resilient to flaky IPv6 WITHOUT disabling it — it still falls back to IPv6 on an IPv6-only host. Must run
// before any network-using require so ccxt / undici / mongoose all inherit it. Override with
// `--dns-order verbatim` (or `--dns-order ipv6first`) if you specifically need a different order.
function preferDnsOrder() {

	try {
		var order = 'ipv4first';
		var argv = process.argv;
		for (var i = 0; i < argv.length; i++) {
			if (argv[i] === '--dns-order' && argv[i + 1]) { order = String(argv[i + 1]).toLowerCase(); }
			else if (String(argv[i]).indexOf('--dns-order=') === 0) { order = String(argv[i]).split('=')[1].toLowerCase(); }
		}
		if (order === 'ipv4first' || order === 'ipv6first' || order === 'verbatim') {
			require('dns').setDefaultResultOrder(order);
		}
	}
	catch (e) { /* older Node without setDefaultResultOrder, or a bad value: keep Node's default order */ }
}


// Pure formatters for the two fatal-error handlers (exposed for tests). Null-tolerant so a thrown non-Error
// (a string, undefined) still produces a line instead of throwing inside the handler.
function formatUncaughtException(err) {
	return 'Uncaught Exception: ' + JSON.stringify(err && err.message) + ' Stack: ' + JSON.stringify(err && err.stack);
}
function formatUnhandledRejection(reason) {
	var msg = (reason && reason.stack) ? reason.stack : (reason && reason.message) ? reason.message : String(reason);
	return 'Unhandled Rejection: ' + msg;
}


// Install the process-level handlers every SymBot entry point needs, in one place so the two entry points
// (symbot.js, symbot-hub.js) can't drift: graceful shutdown on SIGINT / SIGTERM (and PM2's Windows 'shutdown'
// message), and — critically — uncaughtException / unhandledRejection handlers that LOG and KEEP RUNNING. A
// stray async error in any subsystem (notifications, AI, relays, a background job) must NEVER take the process
// down — and for a trading instance, that means the trading loop is never killed by an unrelated error. Pass
// the entry's own `shutDown`, and a `logError(message)` that adapts to the entry's logger. The log call is
// wrapped so a failure inside the logger can't itself turn an uncaught error into a crash.
function installProcessGuards(shutDown, logError) {

	var safeLog = function (m) { try { if (typeof logError === 'function') { logError(m); } } catch (e) {} };

	if (typeof shutDown === 'function') {
		process.on('SIGINT', shutDown);
		process.on('SIGTERM', shutDown);
		process.on('message', function (msg) { if (msg === 'shutdown') { shutDown(); } });   // PM2 (Windows)
	}

	process.on('uncaughtException', function (err) { safeLog(formatUncaughtException(err)); });
	process.on('unhandledRejection', function (reason) { safeLog(formatUnhandledRejection(reason)); });
}


module.exports = {
	enforceNodeVersion: enforceNodeVersion,
	preferDnsOrder: preferDnsOrder,
	installProcessGuards: installProcessGuards,
	isNodeOlder: isNodeOlder,                          // exposed for tests
	formatUncaughtException: formatUncaughtException,  // exposed for tests
	formatUnhandledRejection: formatUnhandledRejection // exposed for tests
};
