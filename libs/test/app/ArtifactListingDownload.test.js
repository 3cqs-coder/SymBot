'use strict';

// End-to-end for the friendly-artifact feature across the two topologies, driving the REAL
// Common.showFiles() and Common.downloadFile() (not the resolver in isolation). It seeds a throwaway
// per-instance data tree under data/instances/, stubs only req/res and shareData, and asserts:
//   • Hub      — the aggregated listing carries an instances legend (server_id ↔ name ↔ count), and two
//                instances sharing a same-dated bare "<date>.log" each download DISTINCTLY via ?sid=.
//   • Standalone — a download is prefixed with THIS instance's own display name (the no-index fallback).
// The tree lives under the real pathRoot (that is how instanceDataDir resolves), namespaced with a
// "zz-arttest-" server_id and removed in a finally, so it never collides with real instance data.

const fs = require('fs');
const path = require('path');

const Common = require('../../app/Common.js');
const ArtifactIndex = require('../../app/ArtifactIndex.js');

const pathRoot = path.resolve(__dirname, '..', '..', '..');
const instancesBase = path.join(pathRoot, 'data', 'instances');
const SID_A = 'zz-arttest-A';
const SID_B = 'zz-arttest-B';
const SID_C = 'zz-arttest-C';
const DATED = '2026-08-27.log';

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ok   - ' + msg); } else { failed++; process.exitCode = 1; console.log('  FAIL - ' + msg); } }

// downloadFile serves inside an async fs.lstat callback it does not itself await, so give that callback a
// tick to fire before asserting on the captured res.download / res.status.
const tick = () => new Promise(r => setTimeout(r, 20));

function seedInstance(sid, instanceName) {
	const dir = path.join(instancesBase, sid, 'logs');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, DATED), 'log for ' + sid + '\n');
	if (instanceName != null) {
		ArtifactIndex.record(dir, 'logs', { server_id: sid, instance_name: instanceName },
			{ file: DATED, size: 10, created_utc: '2026-08-27T00:00:00.000Z' });
	}
	return dir;
}

function mockRes() {
	const cap = { rendered: null, download: null, status: null };
	return {
		cap,
		render(view, locals) { cap.rendered = { view, locals }; },
		download(p, name, cb) { cap.download = { path: p, name }; if (typeof cb === 'function') { cb(); } },
		status(code) { cap.status = code; return this; },
		send() { return this; },
		get headersSent() { return false; }
	};
}

(async () => {
	// A per-instance tree that is NOT the Hub process (no hub_config) resolves via server_id.
	Common.init({ appData: { server_id: SID_A, name: 'Alpha Box', name_display: 'Alpha Box' } });

	try {
		seedInstance(SID_A, 'Binance-Paper');
		seedInstance(SID_B, 'Coinbase-Live');
		seedInstance(SID_C, null);   // no index → exercises the standalone own-name fallback

		// ── Hub: aggregated listing builds the instances legend ───────────────────────────────────────
		{
			const res = mockRes();
			await Common.showFiles('logs', {}, res, true);
			const locals = res.cap.rendered && res.cap.rendered.locals;
			ok(!!locals, 'Hub showFiles rendered logsView with locals');
			ok(locals && locals.isHub === true, 'isHub passed through to the view');
			const map = (locals && locals.instancesMap) || [];
			const a = map.find(m => m.server_id === SID_A);
			const b = map.find(m => m.server_id === SID_B);
			ok(a && a.name === 'Binance-Paper' && a.count >= 1, 'legend lists instance A by name with a file count');
			ok(b && b.name === 'Coinbase-Live' && b.count >= 1, 'legend lists instance B by name with a file count');
			// Sorted by display name — "Binance-Paper" precedes "Coinbase-Live".
			const idxA = map.findIndex(m => m.server_id === SID_A);
			const idxB = map.findIndex(m => m.server_id === SID_B);
			ok(idxA > -1 && idxB > -1 && idxA < idxB, 'legend is sorted by instance display name');
		}

		// ── Hub: two instances share the SAME bare "<date>.log"; ?sid= downloads each DISTINCTLY ───────
		{
			const resA = mockRes();
			await Common.downloadFile(DATED, 'logs', {}, resA, true, SID_A);
			await tick();
			ok(resA.cap.download && resA.cap.download.name === 'Binance-Paper-' + DATED,
				'Hub download for sid A → "Binance-Paper-' + DATED + '"');
			ok(resA.cap.download.path === path.join(instancesBase, SID_A, 'logs', DATED),
				'…and serves A\'s OWN on-disk file (bare name untouched)');

			const resB = mockRes();
			await Common.downloadFile(DATED, 'logs', {}, resB, true, SID_B);
			await tick();
			ok(resB.cap.download && resB.cap.download.name === 'Coinbase-Live-' + DATED,
				'Hub download for sid B → "Coinbase-Live-' + DATED + '" (same bare file, distinct saved name)');
		}

		// ── Standalone: no index name → prefixed with THIS instance's own identity ─────────────────────
		{
			// Faithful to production shape: appData.name/name_display carry the product prefix ("SymBot-…​"),
			// while the CLEAN label lives on worker_data. The fallback must reuse instanceIndexMeta() — the same
			// identity the manifest records — so it yields the clean "My Box", NOT the product-prefixed variant.
			Common.init({ appData: { server_id: SID_C, name: 'SymBot-my-box', name_display: 'SymBot-My Box', worker_data: { name: 'my-box', name_display: 'My Box' } } });
			const res = mockRes();
			await Common.downloadFile(DATED, 'logs', {}, res, false);
			await tick();
			ok(res.cap.download && res.cap.download.name === 'My-Box-' + DATED,
				'standalone download → clean own-identity prefix "My-Box-' + DATED + '" (not the product-prefixed name_display)');
			// A single instance needs no legend.
			const res2 = mockRes();
			await Common.showFiles('logs', {}, res2, false);
			const map = res2.cap.rendered && res2.cap.rendered.locals && res2.cap.rendered.locals.instancesMap;
			ok(map == null, 'standalone listing carries no instances legend (null)');
		}
	}
	finally {
		for (const sid of [ SID_A, SID_B, SID_C ]) {
			try { fs.rmSync(path.join(instancesBase, sid), { recursive: true, force: true }); } catch (e) {}
		}
	}

	console.log('\n' + passed + ' passed, ' + failed + ' failed');
})();
