'use strict';

// Tests the PURE preflight diagnosis (AIClient.diagnosePreflight): given the gathered facts (models
// list, configured model, provider, tools capability) it must produce the right readiness verdict and
// actionable messages. No network — the IO half (preflight) just feeds this.

const assert = require('assert');
const AIClient = require('../../ai/AIClient.js');
const diagnose = AIClient.diagnosePreflight;

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }
function eq(a, b, m) { assert.strictEqual(a, b, m); passed++; }
function hasMsg(res, level, re) { return res.messages.some(x => x.level === level && re.test(x.text)); }

// ── Unreachable / empty model list ────────────────────────────────────────────
let r = diagnose({ provider: 'ollama', model: 'llama3.1:8b', models: [], host: 'http://127.0.0.1:11434' });
eq(r.reachable, false, 'empty model list → not reachable');
eq(r.ok, false, 'unreachable is not ok');
ok(hasMsg(r, 'error', /ollama pull llama3\.1:8b/), 'ollama unreachable message names the exact pull command');
ok(hasMsg(r, 'error', /127\.0\.0\.1:11434/), 'ollama unreachable message includes the host');

r = diagnose({ provider: 'openai', model: 'gpt-x', models: [] });
ok(hasMsg(r, 'error', /API key/), 'openai unreachable message points at endpoint/key');

// ── Reachable, model present ──────────────────────────────────────────────────
r = diagnose({ provider: 'ollama', model: 'llama3.1:8b', models: [ 'llama3.1:8b', 'qwen2.5:7b' ] });
eq(r.reachable, true, 'non-empty list → reachable');
eq(r.model_present, true, 'exact model match → present');
eq(r.ok, true, 'reachable + present → ok');
ok(hasMsg(r, 'ok', /available/), 'reports the model is available');

// base-name tolerance (a :latest drift still matches)
r = diagnose({ provider: 'ollama', model: 'llama3.1', models: [ 'llama3.1:latest' ] });
eq(r.model_present, true, 'base-name match tolerates a tag difference');

// ── Reachable, model MISSING (ollama) ─────────────────────────────────────────
r = diagnose({ provider: 'ollama', model: 'mistral-large', models: [ 'llama3.1:8b' ] });
eq(r.model_present, false, 'ollama: configured model not in list → not present');
eq(r.ok, false, 'a missing ollama model is not ok');
ok(hasMsg(r, 'warn', /ollama pull mistral-large/), 'missing-model message names the exact pull command');

// ── OpenAI: a miss is UNVERIFIED, not a hard failure ──────────────────────────
r = diagnose({ provider: 'openai', model: 'gpt-5.4-nano', models: [ 'gpt-4o', 'gpt-4o-mini' ] });
eq(r.model_present, null, 'openai: a model not in the list is treated as unverified (null), not absent');
eq(r.ok, true, 'openai stays ok when reachable and presence is merely unverified');

// ── No model configured ───────────────────────────────────────────────────────
r = diagnose({ provider: 'ollama', model: '', models: [ 'llama3.1:8b' ] });
ok(hasMsg(r, 'warn', /No model is configured/), 'no configured model → warn');

// ── Tools capability messaging ────────────────────────────────────────────────
r = diagnose({ provider: 'ollama', model: 'llama3.1:8b', models: [ 'llama3.1:8b' ], wantTools: true, toolsSupported: true });
eq(r.tools_supported, true, 'tools supported carried through');
ok(!hasMsg(r, 'warn', /tool-calling/), 'no tools warning when supported');

r = diagnose({ provider: 'ollama', model: 'gemma2:2b', models: [ 'gemma2:2b' ], wantTools: true, toolsSupported: false });
eq(r.tools_supported, false, 'tools unsupported carried through');
ok(hasMsg(r, 'warn', /does not support tool-calling/), 'warns when the model cannot do tools');
eq(r.ok, true, 'a no-tools model is still "ok" for plain chat (tools just fall back)');

r = diagnose({ provider: 'ollama', model: 'x', models: [ 'x' ], wantTools: false, toolsSupported: false });
eq(r.tools_supported, null, 'tools capability is ignored when AI Tools is off');

// tools irrelevant when the model isn't even present
r = diagnose({ provider: 'ollama', model: 'missing', models: [ 'other' ], wantTools: true, toolsSupported: false });
ok(!hasMsg(r, 'warn', /tool-calling/), 'no tools warning when the model is absent (the absence is the real problem)');

// ── Robustness ────────────────────────────────────────────────────────────────
r = diagnose(null);
ok(Array.isArray(r.messages), 'null input never throws and returns a shaped result');
eq(r.ok, false, 'null input is not ok');

console.log('Preflight: ' + passed + ' assertions passed');

// AIClient keeps background handles open (client, room-cleanup timer), so exit explicitly once the
// synchronous assertions are done — otherwise the process would hang after printing.
process.exit(0);
