'use strict';

// Tests for Common.withTimeout — the single shared implementation behind the per-module withTimeout wrappers
// (market-data fetches, the scheduler run guard, the WebSocket handler guard, the AI judge calls). Each of
// those needs slightly different behavior, expressed via opts; this pins every mode so the wrappers stay
// correct: default reject, custom message, the scheduler's err.timedOut tag, and the AI fail-open resolve.

const assert = require('assert');
const Common = require('../../app/Common.js');

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + (e && e.message)); } }
const delay = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
const rejectIn = (ms, e) => new Promise((_, rej) => setTimeout(() => rej(e), ms));

(async () => {
	console.log('\nCommon.withTimeout:');

	await test('resolves with the promise value when the work wins the race', async () => {
		const v = await Common.withTimeout(delay(5, 'done'), 100);
		assert.strictEqual(v, 'done');
	});

	await test('propagates a genuine rejection from the work (not swallowed by the timeout)', async () => {
		let msg = null;
		try { await Common.withTimeout(rejectIn(5, new Error('real failure')), 100); }
		catch (e) { msg = e.message; }
		assert.strictEqual(msg, 'real failure');
	});

	await test('rejects with the default message on timeout', async () => {
		let err = null;
		try { await Common.withTimeout(delay(100, 'x'), 10); } catch (e) { err = e; }
		assert.ok(err && /timed out after 10ms/.test(err.message), 'default message names the timeout');
		assert.notStrictEqual(err.timedOut, true, 'no timedOut tag unless requested');
	});

	await test('rejects with a CUSTOM message on timeout (market-data / websocket wrappers)', async () => {
		let err = null;
		try { await Common.withTimeout(delay(100, 'x'), 10, { message: 'market data request timed out' }); } catch (e) { err = e; }
		assert.ok(err && err.message === 'market data request timed out');
	});

	await test('tags the rejection with err.timedOut when opts.timedOut (scheduler distinguishes timeout vs error)', async () => {
		let err = null;
		try { await Common.withTimeout(delay(100, 'x'), 10, { message: 'Scheduler run timed out after 10ms', timedOut: true }); } catch (e) { err = e; }
		assert.strictEqual(err && err.timedOut, true, 'timedOut flag is set');
	});

	await test('FAIL-OPEN: resolves with resolveValue on timeout instead of rejecting (AI judge)', async () => {
		let threw = false, val;
		try { val = await Common.withTimeout(delay(100, 'slow'), 10, { resolveValue: '' }); } catch (e) { threw = true; }
		assert.strictEqual(threw, false, 'never rejects in fail-open mode');
		assert.strictEqual(val, '', 'resolves the fail-open value');
	});

	await test('fail-open still returns the real value when the work finishes in time', async () => {
		const v = await Common.withTimeout(delay(5, 'answer'), 100, { resolveValue: '' });
		assert.strictEqual(v, 'answer');
	});

	await test('a resolveValue of a non-empty value is honored too', async () => {
		const v = await Common.withTimeout(delay(100, 'slow'), 10, { resolveValue: { fallback: true } });
		assert.deepStrictEqual(v, { fallback: true });
	});

	console.log('\n' + passed + ' passed, ' + failed + ' failed');
	process.exit(failed ? 1 : 0);
})();
