'use strict';

// Static wiring guard for Hub deal actions (regression pin).
//
// Bug it pins (fixed 2026-11-08): the Hub deal-action message does NOT reliably carry a botId — the one-click
// "Pause averaging" pill posts only { instanceId, action, data } — so a Hub Worker handler that calls a
// botId-keyed money-path function (pauseDeal(botId, …)) with that missing botId writes against
// { botId: undefined, dealId } and matches NOTHING ("Pause update failed"). The single-deal actions that come
// from a one-click pill MUST therefore be addressed by dealId alone, resolving botId from the deal internally,
// exactly like gracefulCloseDeal(dealId) / panicSellDeal(dealId).
//
// This is a source-text scan (no DB, no live model) — it asserts the wiring can't silently regress.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

const root = path.join(__dirname, '..', '..');
const worker = fs.readFileSync(path.join(root, 'app', 'Hub', 'Worker.js'), 'utf8');
const dcabot = fs.readFileSync(path.join(root, 'strategies', 'DCABot', 'DCABot.js'), 'utf8');
const manager = fs.readFileSync(path.join(root, 'strategies', 'DCABot', 'DCABotManager.js'), 'utf8');

// Isolate each Worker action branch body: from `action === 'X'` to the next `else if` / `}` boundary.
function workerBranch(action) {
	const re = new RegExp("action === '" + action + "'[\\s\\S]*?(?=else if \\(action ===|\\n\\t\\t\\t\\}\\n)");
	const m = worker.match(re);
	return m ? m[0] : '';
}

// (1) The dealId-only, one-click deal actions must call SymBot.DCABot.<fn>(dealId) and must NOT pass botId.
[
	['pause_averaging',  'pauseAveragingDeal'],
	['resume_averaging', 'resumeAveragingDeal']
].forEach(function (pair) {
	const action = pair[0], fn = pair[1];
	const body = workerBranch(action);
	ok(body !== '', 'Hub Worker has a branch for action "' + action + '"');
	ok(new RegExp('SymBot\\.DCABot\\.' + fn + '\\(\\s*dealId\\s*\\)').test(body),
		'Hub Worker "' + action + '" calls SymBot.DCABot.' + fn + '(dealId) — addressed by dealId alone');
	ok(!/pauseDeal\s*\(\s*botId/.test(body),
		'Hub Worker "' + action + '" does NOT call pauseDeal(botId, …) — the Hub message has no reliable botId');
});

// (2) Those single entry points exist in DCABot and are exported (so every surface shares the one function).
['pauseAveragingDeal', 'resumeAveragingDeal'].forEach(function (fn) {
	ok(new RegExp('async function ' + fn + '\\s*\\(\\s*dealId\\s*\\)').test(dcabot),
		'DCABot defines ' + fn + '(dealId) — dealId-addressed, botId resolved internally');
	ok(new RegExp('\\n\\t' + fn + ',').test(dcabot),
		'DCABot exports ' + fn);
});

// (3) The shared core resolves botId FROM the deal (not from a caller-supplied botId) before pauseDeal.
const coreMatch = dcabot.match(/async function setPauseAveraging[\s\S]*?\n\}/);
const core = coreMatch ? coreMatch[0] : '';
ok(core !== '', 'DCABot defines the shared setPauseAveraging core');
ok(/getDeals\(\s*\{\s*'dealId'\s*:\s*dealId\s*\}\s*\)/.test(core), 'setPauseAveraging resolves the deal by dealId');
ok(/const botId = deals\[0\]\['botId'\]/.test(core), 'setPauseAveraging reads botId FROM the resolved deal');
ok(/pauseDeal\(\s*botId\s*,\s*dealId\s*,\s*false\s*,\s*!!pauseBuy\s*,\s*null\s*,\s*''\s*\)/.test(core),
	'setPauseAveraging wraps pauseDeal with the resolved botId, pauseSell=null (sell side untouched), empty reason');

// (4) The instance HTTP endpoint delegates to the SAME single entry points (no duplicated resolve/validate).
ok(/shareData\.DCABot\.pauseAveragingDeal\(\s*dealId\s*\)/.test(manager),
	'instance apiSetPauseAveraging delegates to DCABot.pauseAveragingDeal(dealId)');
ok(/shareData\.DCABot\.resumeAveragingDeal\(\s*dealId\s*\)/.test(manager),
	'instance apiSetPauseAveraging delegates to DCABot.resumeAveragingDeal(dealId)');

console.log('HubDealActionWiring: ' + passed + ' assertions passed');
