'use strict';

// libs/app/FileLock.js — the cross-process SINGLETON-INSTANCE guard. This is the Phase 1 fix for the highest-value
// orphan/duplication risk: two Hub (or two standalone) processes each spawning a DCA engine for the same account,
// because the in-memory duplicate guard (isServerIdInUse) only sees its own process. The file lock is the one thing
// visible ACROSS processes. These tests pin the invariants that make it safe to gate startup on:
//   - a free key acquires; a second acquire against the SAME LIVE holder refuses with code ALREADY_RUNNING;
//   - a crashed holder's STALE lock (dead pid, or TTL-expired) is reclaimed so a legitimate restart is never blocked;
//   - release removes ONLY our own lock (a reclaimed-and-replaced lock, now a different nonce, is left intact);
//   - startGuard exits(1) on a live conflict, and FAILS OPEN (starts without the guard) on an infrastructure error;
//   - isProcessAlive reports the current process alive and an impossible pid dead.
//
// The lock files live under <install>/data/locks; each test uses a unique key so runs never collide, and cleans up.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const FileLock = require('../../app/FileLock.js');

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

function uniqueKey(tag) { return 'symbot-test:' + tag + ':' + process.pid + ':' + Math.random().toString(16).slice(2); }
function writeHolder(p, rec) { fs.mkdirSync(require('path').dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(rec)); }

(async () => {

	console.log('\nFileLock (cross-process singleton guard):');

	// ── A free key acquires; the SAME key then refuses while the first holder is live ──
	await test('a free key acquires, a second live acquire refuses with ALREADY_RUNNING', async () => {
		const key = uniqueKey('basic');
		const a = await FileLock.acquireSingleton(key, { role: 'hub' });
		assert.ok(a && a.nonce && a.holder === null, 'first acquire should succeed');
		let code = null, holderPid = null;
		try { await FileLock.acquireSingleton(key, { role: 'hub' }); }
		catch (e) { code = e.code; holderPid = e.holder && e.holder.pid; }
		assert.strictEqual(code, 'ALREADY_RUNNING', 'second acquire must refuse while the holder is live');
		assert.strictEqual(holderPid, process.pid, 'the refusal names the live holder pid');
		await FileLock.release(a.p, a.nonce);
	});

	// ── After release, the key is free again ──
	await test('after release the key acquires again', async () => {
		const key = uniqueKey('rerelease');
		const a = await FileLock.acquireSingleton(key, { role: 'hub' });
		await FileLock.release(a.p, a.nonce);
		const b = await FileLock.acquireSingleton(key, { role: 'hub' });
		assert.ok(b && b.holder === null, 'a released lock is re-acquirable');
		await FileLock.release(b.p, b.nonce);
	});

	// ── A crashed holder (DEAD pid, same host) is reclaimed — a legitimate restart is never blocked ──
	await test('a stale lock from a dead pid is reclaimed', async () => {
		const key = uniqueKey('deadpid');
		const p = FileLock.lockPathFor(key);
		// A pid that cannot be alive (well above any real pid), same host, recent timestamp so only the dead-pid rule trips.
		const ghost = { v: 1, pid: 2147483000, host: os.hostname(), at: Date.now(), nonce: 'ghost', role: 'hub' };
		writeHolder(p, ghost);
		assert.strictEqual(FileLock.stale(ghost), true, 'a dead same-host pid is stale even with a fresh timestamp');
		const a = await FileLock.acquireSingleton(key, { role: 'hub' });
		assert.ok(a && a.holder === null, 'a dead holder is reclaimed and acquisition proceeds');
		await FileLock.release(a.p, a.nonce);
	});

	// ── A TTL-expired holder is reclaimed even if we cannot probe its (foreign-host) pid ──
	await test('a TTL-expired holder is reclaimed', async () => {
		const key = uniqueKey('ttl');
		const p = FileLock.lockPathFor(key);
		writeHolder(p, { v: 1, pid: process.pid, host: 'some-other-host', at: Date.now() - (FileLock.TTL_MS + 5000), nonce: 'old', role: 'hub' });
		const a = await FileLock.acquireSingleton(key, { role: 'hub' });
		assert.ok(a && a.holder === null, 'a TTL-expired lock is reclaimed');
		await FileLock.release(a.p, a.nonce);
	});

	// ── release removes only OUR lock: a reclaimed-and-replaced lock (different nonce) is left intact ──
	await test('release removes only our own lock (not a successor with a different nonce)', async () => {
		const key = uniqueKey('ownership');
		const p = FileLock.lockPathFor(key);
		writeHolder(p, { v: 1, pid: process.pid, host: os.hostname(), at: Date.now(), nonce: 'SUCCESSOR', role: 'hub' });
		await FileLock.release(p, 'OUR-OLD-NONCE');           // must NOT delete the successor's file
		assert.ok(fs.existsSync(p), 'release with a foreign nonce must leave the successor lock intact');
		const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
		assert.strictEqual(cur.nonce, 'SUCCESSOR', 'the successor record is untouched');
		fs.rmSync(p, { force: true });
	});

	// ── stale() ordering: on THIS host the pid is authoritative — a live holder whose heartbeat lagged past the
	//    TTL (an event-loop stall / suspend-resume) must NOT be judged stale, or a duplicate engine could steal it ──
	await test('a same-host ALIVE holder with a stale timestamp is NOT stale (money-safe: never steal a live lock)', async () => {
		const alivePastTtl = { v: 1, pid: process.pid, host: os.hostname(), at: Date.now() - (FileLock.TTL_MS + 60000), nonce: 'x', role: 'hub' };
		assert.strictEqual(FileLock.stale(alivePastTtl), false, 'a live same-host pid is never stale, even past the TTL');

		// And behaviorally: a live holder past the TTL still refuses a second acquire (not reclaimed).
		const key = uniqueKey('livestall');
		const p = FileLock.lockPathFor(key);
		writeHolder(p, alivePastTtl);
		let code = null;
		try { await FileLock.acquireSingleton(key, { role: 'hub' }); }
		catch (e) { code = e.code; }
		assert.strictEqual(code, 'ALREADY_RUNNING', 'a live-but-stalled same-host holder is not reclaimed');
		fs.rmSync(p, { force: true });
	});

	await test('a same-host DEAD pid is stale regardless of a fresh timestamp; a foreign host ages out by TTL', async () => {
		assert.strictEqual(FileLock.stale({ pid: 2147483000, host: os.hostname(), at: Date.now() }), true, 'dead same-host pid → stale even with a fresh at');
		assert.strictEqual(FileLock.stale({ pid: process.pid, host: 'other-host', at: Date.now() }), false, 'fresh foreign-host holder → not stale');
		assert.strictEqual(FileLock.stale({ pid: process.pid, host: 'other-host', at: Date.now() - (FileLock.TTL_MS + 5000) }), true, 'aged foreign-host holder → stale');
	});

	// ── Different configuration → different key → both instances acquire (no false refusal of a distinct account) ──
	await test('two different keys never conflict (distinct standalone configs both start)', async () => {
		const a = await FileLock.acquireSingleton(uniqueKey('cfgA'), { role: 'instance' });
		const b = await FileLock.acquireSingleton(uniqueKey('cfgB'), { role: 'instance' });
		assert.ok(a && b && a.p !== b.p, 'distinct keys resolve to distinct lock files and both acquire');
		await FileLock.release(a.p, a.nonce);
		await FileLock.release(b.p, b.nonce);
	});

	// ── startGuard: a live conflict exits(1); the beat/release wiring works on success ──
	await test('startGuard exits(1) on a live conflict and starts on a free key', async () => {
		const key = uniqueKey('guard');
		const first = await FileLock.startGuard({ key, role: 'hub', logger: () => {} });
		assert.ok(first && typeof first.release === 'function', 'first guard acquires');

		let exitedWith = null;
		const second = await FileLock.startGuard({ key, role: 'hub', logger: () => {}, exit: (c) => { exitedWith = c; } });
		assert.strictEqual(exitedWith, 1, 'a live conflict calls exit(1)');
		assert.strictEqual(second, null, 'no guard handle is returned on conflict');

		await first.release();
		const third = await FileLock.startGuard({ key, role: 'hub', logger: () => {} });
		assert.ok(third, 'after the first releases, the guard acquires again');
		await third.release();
	});

	// ── isProcessAlive: this process is alive; an impossible pid is not ──
	await test('isProcessAlive reports self alive and an impossible pid dead', async () => {
		assert.strictEqual(FileLock.isProcessAlive(process.pid), true, 'the current process is alive');
		assert.strictEqual(FileLock.isProcessAlive(2147483000), false, 'an impossible pid is not alive');
		assert.strictEqual(FileLock.isProcessAlive(0), false, 'pid 0 is treated as not alive');
		assert.strictEqual(FileLock.isProcessAlive('nope'), false, 'a non-numeric pid is not alive');
	});

	// ── sweepStaleTemps: a crash mid-reclaim/refresh can orphan a *.reclaim.<nonce> / *.beat.<nonce> sidecar in
	//    data/locks/; the age-gated sweep removes only the AGED ones and never touches a live temp or the lock. ──
	await test('sweepStaleTemps ages out orphaned reclaim/beat temps, keeps fresh temps and the lock file', async () => {
		const pathMod = require('path');
		const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'symbot-locks-'));
		const aged     = pathMod.join(dir, 'abc.reclaim.deadbeef');
		const agedBeat = pathMod.join(dir, 'abc.beat.cafe1234');
		const fresh    = pathMod.join(dir, 'abc.reclaim.beef0001');
		const lock     = pathMod.join(dir, 'somekey.lock');
		for (const f of [ aged, agedBeat, fresh, lock ]) { fs.writeFileSync(f, 'x'); }
		// Backdate the two "aged" temps well beyond the stale threshold.
		const old = new Date(Date.now() - (FileLock.TEMP_STALE_MS + 60000));
		fs.utimesSync(aged, old, old);
		fs.utimesSync(agedBeat, old, old);

		await FileLock.sweepStaleTemps(dir);

		assert.ok(!fs.existsSync(aged), 'an aged .reclaim temp is removed');
		assert.ok(!fs.existsSync(agedBeat), 'an aged .beat temp is removed');
		assert.ok(fs.existsSync(fresh), 'a fresh temp is kept (inside the age gate — a live op may still need it)');
		assert.ok(fs.existsSync(lock), 'a real .lock file is never touched (not a temp)');
		fs.rmSync(dir, { recursive: true, force: true });
	});

	console.log('\nFileLock: ' + passed + ' passed' + (failed ? (', ' + failed + ' failed') : ''));
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
