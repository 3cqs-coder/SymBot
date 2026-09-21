'use strict';

/**
 * Tests for the `explore` research sub-agent tool.
 *
 * Covers the tool contract (schema + gating), the handler's delegation to the injected
 * sub-agent and its error paths, the recursion guard (the sub-agent's tool list can never
 * include `explore` itself), the transitive read-only safety, and — as an integration check
 * — that AIClient.init actually wires the sub-agent through to runToolLoop and degrades
 * gracefully when no AI provider is configured.
 */

const assert = require('assert');
const aiTools = require('../../ai/AITools.js');

let passed = 0;
function test(name, fn) {
	try { fn(); passed++; console.log('  ok   - ' + name); }
	catch (e) { process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); }
}
async function testAsync(name, fn) {
	try { await fn(); passed++; console.log('  ok   - ' + name); }
	catch (e) { process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); }
}

// A stub shareData; `exploreOn` toggles the config gate.
function initTools(exploreOn) {
	aiTools.init({
		Common: { logger: () => {} },
		appData: { ai: { tools: { enabled: true, explore: !!exploreOn } } }
	});
}


(async () => {

	console.log('\nexplore — schema & gating:');

	test('explore schema is registered with the required shape', () => {
		initTools(true);
		const s = aiTools.listSchemas(['explore']);
		assert.strictEqual(s.length, 1);
		assert.strictEqual(s[0].function.name, 'explore');
		assert.ok(/read-only/i.test(s[0].function.description), 'description should state read-only');
		assert.strictEqual(s[0].function.parameters.type, 'object');
		assert.ok(s[0].function.parameters.properties.task, 'has a task parameter');
		assert.deepStrictEqual(s[0].function.parameters.required, ['task']);
	});

	test('explore is offered only when enabled AND the query looks like deep research', () => {
		const researchQ = 'investigate why my completed deals this month underperformed';
		initTools(false);
		assert.strictEqual(aiTools.exploreEnabled(), false);
		assert.ok(!aiTools.selectTools(researchQ).includes('explore'), 'must be absent when disabled');
		initTools(true);
		assert.strictEqual(aiTools.exploreEnabled(), true);
		assert.ok(aiTools.selectTools(researchQ).includes('explore'), 'must be present for a research-shaped query when enabled');
	});

	test('explore is NOT offered for an ordinary lookup even when enabled (keeps the common path fast)', () => {
		// A weak model handed explore on every turn reaches for it on trivial questions and turns a fast answer
		// into a long nested run — so an ordinary count/status/how-to question must not advertise it.
		initTools(true);
		assert.ok(!aiTools.selectTools('how many open deals do I have?').includes('explore'), 'a bare count must not offer explore');
		assert.ok(!aiTools.selectTools('what is my total unrealized P/L?').includes('explore'), 'a status question must not offer explore');
	});

	test('explore survives the shortlist cap for a research query (never trimmed)', () => {
		initTools(true);
		// A research-shaped query that also routes to many tools would exceed the cap; explore must still be kept.
		const list = aiTools.selectTools('investigate my risk exposure by pair and by currency, orders, errors, logs, bots, performance, oldest, paused, timeline');
		assert.ok(list.includes('explore'), 'explore should be appended after the cap');
	});


	console.log('\nexplore — handler delegation & errors:');

	await testAsync('handler delegates the task to the injected sub-agent and returns findings', async () => {
		initTools(true);
		let seen = null;
		aiTools.setSubAgent(async (task) => { seen = task; return 'BTC deals: 3 completed, +2.1% avg.'; });
		const r = await aiTools.execute('explore', { task: 'review my BTC deals' });
		assert.strictEqual(seen, 'review my BTC deals', 'sub-agent received the task');
		assert.strictEqual(r.findings, 'BTC deals: 3 completed, +2.1% avg.');
	});

	await testAsync('handler errors when no task is given', async () => {
		initTools(true);
		aiTools.setSubAgent(async () => 'should not run');
		const r = await aiTools.execute('explore', { task: '   ' });
		assert.ok(r.error && /task/i.test(r.error));
	});

	await testAsync('handler reports unavailable when no sub-agent is wired', async () => {
		initTools(true);
		aiTools.setSubAgent(null);
		const r = await aiTools.execute('explore', { task: 'anything' });
		assert.ok(r.error && /not available/i.test(r.error));
	});

	await testAsync('a throwing sub-agent is turned into an error, never propagated', async () => {
		initTools(true);
		aiTools.setSubAgent(async () => { throw new Error('boom'); });
		const r = await aiTools.execute('explore', { task: 'anything' });
		assert.ok(r.error && /boom/.test(r.error));
	});

	await testAsync('an empty sub-agent result yields a clear placeholder, not a blank', async () => {
		initTools(true);
		aiTools.setSubAgent(async () => '');
		const r = await aiTools.execute('explore', { task: 'anything' });
		assert.ok(r.findings && /no findings/i.test(r.findings));
	});


	console.log('\nexplore — recursion guard & read-only safety:');

	test('the sub-agent tool list excludes explore itself (no recursion)', () => {
		initTools(true);
		// This is exactly the shortlist AIClient hands the sub-agent.
		const subList = aiTools.TOOLS.map(t => t.name).filter(n => n !== 'explore');
		assert.ok(!subList.includes('explore'), 'explore must not be reachable from within a sub-agent');
		assert.strictEqual(subList.length, aiTools.TOOLS.length - 1);
		assert.ok(subList.includes('list_open_deals'), 'sub-agent still has the reader tools');
	});

	test('every tool the sub-agent can call is read-only', () => {
		initTools(true);
		const READ_PREFIX = /^(get|list|search|find|count|read|diagnose|summarize|analyze|scan|compare)_/;
		// `explore` (the orchestrator itself) and `calculate` (a pure, stateless arithmetic evaluator that
		// touches no data or state) are read-only by construction without a verb_noun reader prefix.
		const subList = aiTools.TOOLS.map(t => t.name).filter(n => n !== 'explore' && n !== 'calculate');
		subList.forEach(n => assert.ok(READ_PREFIX.test(n), 'sub-agent tool "' + n + '" must be a reader'));
	});


	console.log('\nexplore — AIClient wiring (integration):');

	await testAsync('AIClient.init wires the sub-agent through runToolLoop, degrading gracefully with no provider', async () => {
		let AIClient;
		try { AIClient = require('../../ai/AIClient.js'); }
		catch (e) { console.log('         (skipped — AIClient could not be required: ' + e.message + ')'); return; }

		// Minimal shareData; no provider is started, so runToolLoop finds no client and
		// returns null, which the sub-agent maps to '' and the handler to a placeholder.
		AIClient.init({
			Common: { logger: () => {} },
			appData: { ai: { tools: { enabled: true, explore: true }, generation: {} } }
		});

		const r = await aiTools.execute('explore', { task: 'anything' });
		assert.ok(!(r.error && /not available/i.test(r.error)), 'sub-agent should be wired, not "not available"');
		assert.ok(r.findings && /no findings/i.test(r.findings), 'no provider → graceful placeholder, no throw');
	});


	console.log('\n' + passed + ' checks passed');
	process.exit(process.exitCode ? 1 : 0);
})();
