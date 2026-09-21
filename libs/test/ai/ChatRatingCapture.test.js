'use strict';

// Regression guard for the AI-chat 👍/👎 rating on DETERMINISTIC answers.
//
// The rating only appears when the server records a learning outcome for the turn and emits its id over the
// socket ('learning' message). The tool-agent loop always did this — but the deterministic "render, don't
// generate" shortcuts (which answer the MOST common questions, e.g. "how are my deals?") returned without
// recording anything, so those answers silently showed no rating. This test pins both halves of the fix:
//   1) captureLearning, given a shortcut-shaped turn, records the outcome AND emits the 'learning' id.
//   2) every emitRender() shortcut passes a `tool`, so it actually reaches captureLearning.

const assert = require('assert');
const fs = require('fs');

const AIMemory = require('../../ai/AIMemory.js');
const AIClient = require('../../ai/AIClient.js');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

(async () => {

	// ── 1) Behavioral: captureLearning records + emits the rating id ─────────────────────────────────
	const socketMsgs = [];
	// AIClient.init re-wires AIMemory to the real store, so init the client FIRST, then override AIMemory
	// with an in-memory fake so the test never touches a database.
	AIClient.init({
		appData: { ai: { learning: { enabled: true } } },
		Common: { sendSocketMsg: (m) => socketMsgs.push(m), logger: () => {} }
	});

	let rows = [];
	AIMemory.init({
		store: {
			load: async (cap) => rows.slice(0, cap || 5000),
			insert: async (rec) => { rows.unshift(rec); },
			setRating: async () => {},
		},
		getConfig: () => ({ enabled: true }),
		logger: () => {}
	});

	// Drive it exactly as a deterministic deals shortcut now does (the real "how are my deals?" prod answer).
	AIClient.captureLearning({
		room: 'room-1',
		question: 'how are my deals',
		tools: [ 'get_open_deals_status' ],
		sources: [ JSON.stringify({ open_deals: 9, in_profit: 0, underwater: 9, total_unrealized: -739.51 }) ],
		answer: 'You have 9 open deals — 0 in profit, 9 underwater. Total unrealized P/L: -739.51.'
	});

	// captureLearning is fire-and-forget (recordOutcome().then(...)), so let the microtask/timer settle.
	await new Promise((r) => setTimeout(r, 30));

	ok(rows.length === 1, 'a learning outcome is recorded for a deterministic shortcut answer');
	ok(rows[0] && rows[0].tools && rows[0].tools.includes('get_open_deals_status'), 'the question→tool routing (get_open_deals_status) is captured');

	const learn = socketMsgs.find((m) => m && m.type === 'learning');
	ok(learn, "a 'learning' socket message is emitted (this is what makes the 👍/👎 appear)");
	ok(learn && learn.message && learn.message.id, 'the learning message carries the outcome id');
	ok(learn && learn.room === 'room-1', 'the rating id is sent to the answer\'s room');

	// Learning OFF → nothing recorded, nothing emitted (the rating correctly stays hidden).
	rows = []; socketMsgs.length = 0;
	AIMemory.init({ store: { load: async () => [], insert: async (r) => { rows.unshift(r); }, setRating: async () => {} }, getConfig: () => ({ enabled: false }), logger: () => {} });
	AIClient.captureLearning({ room: 'room-2', question: 'how are my deals', tools: [ 'get_open_deals_status' ], sources: [ '{}' ], answer: 'x' });
	await new Promise((r) => setTimeout(r, 30));
	ok(rows.length === 0 && !socketMsgs.find((m) => m && m.type === 'learning'), 'when learning is disabled, no outcome is recorded and no rating id is emitted');

	// A no-tool turn (a plain conversational reply) records nothing — the rating is deliberately scoped to
	// tool-backed answers, so this must NOT emit an id.
	rows = []; socketMsgs.length = 0;
	AIMemory.init({ store: { load: async () => [], insert: async (r) => { rows.unshift(r); }, setRating: async () => {} }, getConfig: () => ({ enabled: true }), logger: () => {} });
	AIClient.captureLearning({ room: 'room-3', question: 'hello there', tools: [], sources: [], answer: 'Hi!' });
	await new Promise((r) => setTimeout(r, 30));
	ok(rows.length === 0 && !socketMsgs.find((m) => m && m.type === 'learning'), 'a no-tool conversational answer records nothing and emits no rating id (by design)');

	// ── 2) Structural: every deterministic render funnels a `tool` into captureLearning ───────────────
	const src = fs.readFileSync(require.resolve('../../ai/AIClient.js'), 'utf8');
	// Each shortcut calls emitRender(body, res, { ... }). Capture each opts object up to its closing "});".
	const calls = src.match(/emitRender\(body, res,[\s\S]*?\}\);/g) || [];
	ok(calls.length >= 8, 'found the deterministic emitRender shortcuts (>= 8): got ' + calls.length);
	calls.forEach((c, i) => {
		ok(/\btool:\s*'/.test(c), 'emitRender shortcut #' + (i + 1) + " must pass a `tool` so it records learning + shows a rating — offending call: " + c.replace(/\s+/g, ' ').slice(0, 90));
	});

	console.log('ChatRatingCapture: ' + passed + ' assertions passed');
	process.exit(0);
})().catch((e) => { console.error('ChatRatingCapture FAIL: ' + (e && e.stack || e)); process.exit(1); });
