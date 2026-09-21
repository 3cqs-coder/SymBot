'use strict';

// Routing regression gate over the curated base corpus (libs/ai/data/seed-learning.json).
//
// The seed doubles as a golden set: each pattern is a canonical question → the tool that
// should answer it. This deterministically asserts that the keyword router (selectTools)
// shortlists the expected tool for every canonical question — no model, no network, runs in
// milliseconds. It catches the class of failure that plagued "which deals close soon" (the
// router not surfacing the right tool) BEFORE it ships, and it's the gate an imported
// community pack should also pass. If a case fails, either add/adjust a keyword route in
// AITools or fix the pattern.

const assert = require('assert');
const aiTools = require('../../ai/AITools.js');
const seed = require('../../ai/data/seed-learning.json');

let passed = 0;
const failures = [];

for (const rec of seed.records) {

	const expected = Array.isArray(rec.tools) ? rec.tools : [];
	if (expected.length === 0) { continue; }

	const shortlist = aiTools.selectTools(rec.question);
	const hit = expected.some(t => shortlist.includes(t));

	if (hit) { passed++; }
	else { failures.push({ q: rec.question, expected, shortlist }); }
}

console.log('AIRouting eval: ' + passed + '/' + (passed + failures.length) + ' canonical questions route to the expected tool');

if (failures.length) {

	console.log('\nRouting misses (expected tool not in the shortlist):');
	for (const f of failures) {
		console.log('  ✗ "' + f.q + '"  expected one of [' + f.expected.join(', ') + ']  got [' + f.shortlist.join(', ') + ']');
	}
	process.exit(1);
}

// Sanity: the corpus itself must be valid against the current registry (proves the seed and
// the tool set haven't drifted apart).
const M = require('../../ai/AIMemory.js');
const v = M.verifyPack(seed, { validTools: new Set(aiTools.TOOLS.map(t => t.name)), aliases: aiTools.TOOL_ALIASES });
assert.ok(v.ok, 'seed corpus verifies against the current tool registry');
assert.strictEqual(v.rejected, 0, 'no seed pattern references an unknown tool');

console.log('Seed corpus verifies against the current registry (' + v.count + ' patterns, 0 rejected).');
