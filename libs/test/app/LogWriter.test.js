'use strict';

// LogWriter — the non-blocking, ordered, memory-bounded async log file writer the logger uses so it never
// blocks the trading loop on disk I/O. These tests drive it with an injected mock filesystem (no real disk)
// and pin the guarantees that matter for a trading system: lines are written in call order, same-tick lines
// batch into one write, the log directory is created on first write, a write error is swallowed (never
// thrown), a graceful-exit flush writes everything still queued AND the in-flight batch, memory is hard-
// bounded (oldest dropped under a stuck disk), and nothing ever throws back into the caller.

const assert = require('assert');
const LogWriter = require('../../app/LogWriter.js');

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

function mockFs(opts) {
	opts = opts || {};
	const files = {}, events = [], parked = [];
	let stuck = !!opts.stuck, failCode = opts.failCode || null;
	return {
		files, events, parked,
		setStuck(v) { stuck = v; },
		appendFile(fn, buf, enc, cb) {
			events.push([ 'appendFile', fn ]);
			if (stuck) { parked.push(cb); return; }
			if (failCode) { const c = failCode; failCode = null; const e = new Error(c); e.code = c; return setImmediate(() => cb(e)); }
			files[fn] = (files[fn] || '') + buf; setImmediate(() => cb(null));
		},
		mkdir(dir, o, cb) { events.push([ 'mkdir', dir ]); setImmediate(() => cb(null)); },
		appendFileSync(fn, buf) { events.push([ 'appendFileSync', fn ]); files[fn] = (files[fn] || '') + buf; },
		mkdirSync(dir) { events.push([ 'mkdirSync', dir ]); }
	};
}
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n) { for (let i = 0; i < (n || 6); i++) { await tick(); } }
const countEvents = (fs, kind, fn) => fs.events.filter((e) => e[0] === kind && (!fn || e[1] === fn)).length;

(async () => {

	console.log('\nLogWriter:');

	await test('same-tick lines write once, in order', async () => {
		const fs = mockFs();
		const w = LogWriter.create(fs);
		[ 'a', 'b', 'c', 'd' ].forEach((l) => w.append('/log/x.log', l));
		await settle();
		assert.strictEqual(fs.files['/log/x.log'], 'a\nb\nc\nd\n');
		assert.strictEqual(countEvents(fs, 'appendFile', '/log/x.log'), 1, 'coalesced into one write');
	});

	await test('lines across ticks stay ordered (writes never overlap)', async () => {
		const fs = mockFs();
		const w = LogWriter.create(fs);
		w.append('/log/x.log', 'one'); await settle();
		w.append('/log/x.log', 'two'); await settle();
		assert.strictEqual(fs.files['/log/x.log'], 'one\ntwo\n');
		assert.strictEqual(countEvents(fs, 'appendFile', '/log/x.log'), 2);
	});

	await test('creates the log directory on ENOENT, then writes', async () => {
		const fs = mockFs({ failCode: 'ENOENT' });
		const w = LogWriter.create(fs);
		w.append('/log/new/x.log', 'hi');
		await settle();
		assert.strictEqual(countEvents(fs, 'mkdir'), 1);
		assert.strictEqual(fs.files['/log/new/x.log'], 'hi\n');
	});

	await test('a write error is swallowed and does not wedge the queue', async () => {
		const fs = mockFs({ failCode: 'EACCES' });   // fails the first write (non-ENOENT)
		const w = LogWriter.create(fs);
		w.append('/log/x.log', 'lost');   // this batch fails and is dropped, but must not throw or stall
		await settle();
		w.append('/log/x.log', 'kept');   // a later line must still write
		await settle();
		assert.strictEqual(fs.files['/log/x.log'], 'kept\n');
	});

	await test('flushSync writes lines still queued (graceful exit)', async () => {
		const fs = mockFs();
		const w = LogWriter.create(fs);
		w.append('/log/x.log', 'q1');
		w.append('/log/x.log', 'q2');
		w.flushSync();   // called before the scheduled drain runs
		assert.strictEqual(fs.files['/log/x.log'], 'q1\nq2\n');
		assert.strictEqual(countEvents(fs, 'appendFileSync', '/log/x.log'), 1);
		await settle();   // the scheduled drain now finds nothing to do — no double write
		assert.strictEqual(countEvents(fs, 'appendFile', '/log/x.log'), 0);
	});

	await test('flushSync re-flushes an in-flight batch (forced exit mid-write)', async () => {
		const fs = mockFs({ stuck: true });   // appendFile never calls back — the batch is "in flight"
		const w = LogWriter.create(fs);
		w.append('/log/x.log', 'inflight');
		await settle();                        // drain runs, hands the batch to appendFile (which stalls)
		assert.strictEqual(countEvents(fs, 'appendFile', '/log/x.log'), 1);
		w.flushSync();                          // must re-write the in-flight batch synchronously
		assert.strictEqual(fs.files['/log/x.log'], 'inflight\n');
	});

	await test('memory is hard-bounded: oldest dropped under a stuck disk, never throws', async () => {
		const fs = mockFs({ stuck: true });    // nothing ever drains
		const w = LogWriter.create(fs);
		const line = 'x'.repeat(1024);          // ~1 KB lines
		assert.doesNotThrow(() => { for (let i = 0; i < 20000; i++) { w.append('/log/x.log', line); } });   // ~20 MB offered
		const bytes = w._pendingBytes();
		assert.ok(bytes <= 8 * 1024 * 1024, 'queued bytes stay under the 8 MB cap (was ' + bytes + ')');
		assert.ok(w._queues.get('/log/x.log').pending.length < 20000, 'oldest lines were dropped');
	});

	await test('never throws on odd input', async () => {
		const w = LogWriter.create(mockFs());
		assert.doesNotThrow(() => { w.append('', 'x'); w.append('/log/x.log', null); w.append(null, null); });
	});

	console.log('\n' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
})();
