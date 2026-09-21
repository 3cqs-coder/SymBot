'use strict';

// Integration test for the Hub AI-learning relay — the full chain with no worker threads:
//
//   instance captures a pattern  --LEARNING-->  real Main.js worker-message handler
//        -->  HubStore.addLearningPattern (pooled, deduped)
//   Hub  --LEARNING_PACK-->  (broadcast)  -->  worker.postMessage
//
// A real in-memory HubStore backs the pool; the real Main handler receives the relayed
// pattern; the aggregated pack is built with the real AIMemory pack helpers and verified.
// Proves the wiring end to end without spawning processes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Main = require('../../app/Hub/Main.js');
const HubStore = require('../../app/store/HubStore.js');
const M = require('../../ai/AIMemory.js');

let passed = 0, failed = 0;
async function t(name, fn) {
	try { await fn(); console.log('  ✓ ' + name); passed++; }
	catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); failed++; }
}

(async () => {

	console.log('\nHub learning relay — instance → Hub → broadcast:');

	const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hublearn-'));
	const store = HubStore.init({ path: path.join(TMP, 'hub.db') });

	if (!store.available) { console.log('  (skipped — node:sqlite unavailable)'); process.exit(0); }

	await t('a relayed pattern is pooled, deduped, and rebroadcast as a valid pack', async () => {

		const posts = [];
		const hubShare = {
			HubStore,
			Hub: { logger: () => {} },
			workerMap: new Map([[1, { worker: { postMessage: (m) => posts.push(m) } }]]),
		};

		Main.init(null, hubShare, () => {});
		const handler = Main.processWorkerMessage(1, 'instance-A');

		// Instance relays two DISTINCT patterns plus a duplicate of the first.
		handler({ type: 'learning', payload: { question: 'which deals are closest to profit', tools: ['get_open_deals_status'], confidence: 'high' } });
		handler({ type: 'learning', payload: { question: 'list my open deals', tools: ['list_open_deals'], confidence: 'high' } });
		handler({ type: 'learning', payload: { question: 'Which Deals Are Closest To Profit', tools: ['get_open_deals_status'], confidence: 'high' } }); // dup (case/normalize)

		assert.strictEqual(HubStore.learningCount(), 2, 'the Hub pools 2 unique patterns (duplicate deduped)');

		// Build the pooled pack and confirm it verifies (format + checksum).
		const pack = Main.buildHubLearningPack();
		assert.ok(pack && pack.manifest.format === M.PACK_FORMAT, 'pooled pack has the correct format');
		assert.strictEqual(pack.manifest.count, 2, 'pack contains both unique patterns');
		assert.ok(M.verifyPack(pack).ok, 'pooled pack passes verification');

		// Broadcast pushes the pack to every worker.
		Main.broadcastLearningPack();
		const packMsgs = posts.filter(m => m.type === 'learning_pack');
		assert.strictEqual(packMsgs.length, 1, 'broadcast posts one learning_pack to the worker');
		assert.strictEqual(packMsgs[0].payload.manifest.count, 2, 'broadcast pack carries both patterns');
	});

	await t('a malformed relay payload never throws into the message loop', async () => {

		const hubShare = { HubStore, Hub: { logger: () => {} }, workerMap: new Map() };
		Main.init(null, hubShare, () => {});
		const handler = Main.processWorkerMessage(2, 'instance-B');

		assert.doesNotThrow(() => handler({ type: 'learning', payload: null }));
		assert.doesNotThrow(() => handler({ type: 'learning', payload: { tools: ['x'] } })); // no question
	});

	HubStore.close();
	try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

	console.log('\n' + passed + ' passed, ' + failed + ' failed');
	process.exit(failed ? 1 : 0);
})();
