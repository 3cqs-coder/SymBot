'use strict';

// Integration test for AIMemory's DB-backed API, driven through an in-memory fake
// store (no Mongo). Exercises the real record → retrieve → import → rate → export
// wiring, cache invalidation, and the enabled-gate.

const assert = require('assert');
const M = require('../../ai/AIMemory.js');

function makeFakeStore() {
	let rows = [];
	return {
		load: async (cap) => rows.slice(0, cap || 5000),
		insert: async (rec) => { rows.unshift(rec); },
		setRating: async (id, rating) => { const r = rows.find(x => x.id === id); if (r) { r.rating = rating; } },
		_rows: () => rows,
	};
}

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

(async () => {

	let enabled = true;
	const store = makeFakeStore();
	M.init({ store, getConfig: () => ({ enabled }), logger: () => {} });

	// Capture a couple of patterns.
	await M.recordOutcome({ question: 'which deals are closest to profit', tools: ['get_open_deals_status'], confidence: 'high', grounded: true });
	await M.recordOutcome({ question: 'list my open deals', tools: ['list_open_deals'], confidence: 'high', grounded: true });

	let s = await M.stats();
	ok(s.total === 2 && s.by_source.local === 2, 'recordOutcome persists (2 local)');

	// Retrieve a similar question — should surface the closest capture, tools intact.
	let hits = await M.retrieveSimilar('show deals nearest to taking profit', { minScore: 0.01 });
	ok(hits.length > 0 && hits[0].outcome.tools.includes('get_open_deals_status'), 'retrieveSimilar returns the matching pattern with its tools');

	// Cache invalidation: a new capture is visible on the next retrieve.
	await M.recordOutcome({ question: 'what is my total unrealized pnl', tools: ['get_open_deals_status'], confidence: 'high', grounded: true });
	ok((await M.count()) === 3, 'new capture visible after invalidation (count 3)');

	// enabled-gate: capture and retrieve are off when disabled; import still works.
	enabled = false;
	await M.recordOutcome({ question: 'ignored while disabled', tools: ['x'], confidence: 'high', grounded: true });
	ok((await M.count()) === 3, 'recordOutcome is a no-op when learning is disabled');
	ok((await M.retrieveSimilar('anything')).length === 0, 'retrieveSimilar returns nothing when disabled');

	// Import works regardless of the enabled gate (explicit user action).
	const pack = M.buildPack([
		{ question: 'summarize my performance', tools: ['get_performance_summary'] },
		{ question: 'which pairs are most profitable', tools: ['get_pair_performance'] },
	], { source: 'community', created: 1 });
	const validTools = new Set(['get_performance_summary', 'get_pair_performance']);
	const imp = await M.verifyAndImportPack(pack, 'community', { validTools });
	ok(imp.imported === 2 && !imp.error, 'verifyAndImportPack imports a valid pack while disabled');
	ok((await M.count()) === 5, 'count reflects imported patterns');

	s = await M.stats();
	ok(s.by_source.community === 2, 'imported patterns tagged source=community');

	// Re-import is idempotent (dedup by question+tools).
	const imp2 = await M.verifyAndImportPack(pack, 'community', { validTools });
	ok(imp2.imported === 0, 're-importing the same pack adds nothing (idempotent)');

	// Rating: a 👎 removes a pattern from positive retrieval.
	enabled = true;
	const target = store._rows().find(r => r.question === 'summarize my performance');
	await M.rate(target.id, -1);
	const hits2 = await M.retrieveSimilar('summarize my performance', { minScore: 0.01 });
	ok(!hits2.some(h => h.outcome.question === 'summarize my performance'), '👎-rated pattern is excluded from retrieval');

	// Export round-trips: the exported pack verifies.
	const exported = await M.exportPack(1);
	ok(M.verifyPack(exported).ok, 'exportPack produces a valid, verifiable pack');

	console.log('AIMemory integration: ' + passed + ' assertions passed');
})().catch(e => { console.error('FAIL', e); process.exit(1); });