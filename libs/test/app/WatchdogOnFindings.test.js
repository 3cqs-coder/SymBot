'use strict';

// Phase 2 Tier A — the Watchdog's optional onFindings hook (libs/app/Watchdog.js). The Hub passes an onFindings
// callback so alert-worthy findings escalate from a buried audit line to a visible operator alert. This pins the
// contract the hook must keep: it receives the findings array after they are logged/audited, and — critically — a
// throwing or slow callback can NEVER break the sweep (on an instance, run() shares the trading process, so a bad
// hook must be fully isolated). Backward compatibility (a caller passing no onFindings is unaffected) is covered by
// every other Watchdog test, which pass no onFindings and still pass.

const assert = require('assert');
const Watchdog = require('../../app/Watchdog.js');

function share() { return { Common: { logger: () => {}, auditEvent: () => {} } }; }

(async () => {

	let passed = 0, failed = 0;
	async function test(name, fn) { try { await fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

	console.log('\nWatchdog onFindings hook:');

	// A check that always emits a finding, so there is guaranteed to be something to hand the hook.
	Watchdog.register('test_always_finds', () => ({ action: 'watchdog.test_always_finds', target: 't', detail: 'd' }));

	await test('onFindings receives the findings array when there are findings', async () => {
		let got = null;
		await Watchdog.run(share(), { onFindings: (findings) => { got = findings; } });
		assert.ok(Array.isArray(got), 'the hook received an array');
		assert.ok(got.some(f => f.action === 'watchdog.test_always_finds'), 'the array includes the emitted finding');
	});

	await test('a throwing onFindings never breaks the sweep', async () => {
		const findings = await Watchdog.run(share(), { onFindings: () => { throw new Error('boom'); } });
		assert.ok(Array.isArray(findings) && findings.length > 0, 'run still resolved with findings despite a throwing hook');
	});

	await test('an async onFindings that rejects is also isolated', async () => {
		const findings = await Watchdog.run(share(), { onFindings: async () => { throw new Error('async boom'); } });
		assert.ok(Array.isArray(findings) && findings.length > 0, 'run resolved despite a rejecting async hook');
	});

	console.log('\nWatchdogOnFindings: ' + passed + ' passed' + (failed ? (', ' + failed + ' failed') : ''));
	process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
