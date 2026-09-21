'use strict';

// Tests the pure context-window guard (AIClient.clampConversation): on a small-context model the
// accumulated tool conversation must be shortened so it fits, WITHOUT ever dropping/shortening the
// system message (the grounding rules) or any user turn (the questions). This is what prevents the
// degenerate one-word answers that happen when a provider evicts the oldest tokens.

const assert = require('assert');
const AIClient = require('../../ai/AIClient.js');
const clamp = AIClient.clampConversation;

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function eq(a, b, m) { assert.strictEqual(a, b, m); passed++; }

const big = n => 'x'.repeat(n);
const totalChars = msgs => msgs.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);

// ── Within budget → returned unchanged (same reference, no allocation) ────────
let convo = [
	{ role: 'system', content: 'RULES' },
	{ role: 'user', content: 'hi' },
	{ role: 'tool', content: 'small result' }
];
eq(clamp(convo, 10000), convo, 'a conversation within budget is returned by reference (untouched)');

// ── Over budget → system message is preserved verbatim ────────────────────────
const SYSTEM = 'SYSTEM GROUNDING RULES — answer only from the data.';
convo = [
	{ role: 'system', content: SYSTEM },
	{ role: 'user', content: 'question one' },
	{ role: 'assistant', content: '', tool_calls: [ { id: 'a' } ] },
	{ role: 'tool', content: big(5000) },
	{ role: 'assistant', content: '', tool_calls: [ { id: 'b' } ] },
	{ role: 'tool', content: big(5000) },
	{ role: 'user', content: 'question two' }
];
let out = clamp(convo, 3000);
ok(out !== convo, 'over-budget input is cloned, not mutated');
eq(out[0].content, SYSTEM, 'the SYSTEM message content is never shortened');
eq(convo[3].content.length, 5000, 'the ORIGINAL conversation is left intact (only the sent copy changes)');
ok(totalChars(out) <= 3000 + 200 + 40, 'the clamped copy fits the budget (allowing the min-stub + marker)');

// ── User turns (the questions) are never shortened ────────────────────────────
convo = [
	{ role: 'system', content: 'S' },
	{ role: 'user', content: big(1000) },      // a long question
	{ role: 'tool', content: big(4000) },
	{ role: 'user', content: 'final question' }
];
out = clamp(convo, 1500);
ok(out.find(m => m.role === 'user' && m.content.length === 1000), 'a long user question is preserved in full');
eq(out[out.length - 1].content, 'final question', 'the final user question is preserved');

// ── The tool-call structure survives (no turn is removed) ─────────────────────
convo = [
	{ role: 'system', content: 'S' },
	{ role: 'assistant', content: '', tool_calls: [ { id: 'x' } ] },
	{ role: 'tool', content: big(9000) },
	{ role: 'user', content: 'q' }
];
out = clamp(convo, 1000);
eq(out.length, convo.length, 'no turn is dropped — only content is shortened (keeps tool_call/result pairing valid)');
ok(out[1].tool_calls && out[1].tool_calls[0].id === 'x', 'an assistant tool_call turn keeps its tool_calls field');
ok(/truncated/.test(out[2].content), 'the bulky tool result is marked as truncated');
ok(out[2].content.length < 9000, 'the bulky tool result is actually shortened');

// ── Oldest-first: an earlier bulky result is cut before a later one ───────────
convo = [
	{ role: 'system', content: 'S' },
	{ role: 'user', content: 'q' },
	{ role: 'tool', content: 'OLD' + big(4000) },
	{ role: 'tool', content: 'NEW' + big(4000) }
];
out = clamp(convo, 4500);
ok(out[2].content.length < out[3].content.length, 'the OLDER result is shortened more than the newer one');

// ── Robustness ────────────────────────────────────────────────────────────────
eq(clamp([], 100).length, 0, 'empty conversation is handled');
eq(clamp(null, 100), null, 'null input is returned as-is (never throws)');
ok(Array.isArray(clamp([ { role: 'system', content: 'only' } ], 1)), 'a single-message conversation never throws');

console.log('ContextGuard: ' + passed + ' assertions passed');

// AIClient keeps background handles open; exit explicitly once the synchronous assertions finish.
process.exit(0);
