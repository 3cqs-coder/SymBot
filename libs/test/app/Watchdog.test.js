'use strict';

// Watchdog registry: registration is idempotent, each check is isolated (a throwing check becomes
// a finding rather than breaking the run), and the built-in checks pass against the real modules.
// run() is async (checks may query the DB), so every call is awaited.

const assert = require('assert');
const Watchdog = require('../../app/Watchdog.js');

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

const noop = { Common: { logger: () => {} } };

(async () => {

	console.log('\nwatchdog registry:');

	await test('the three built-in checks are registered', () => {
		const names = Watchdog.list();
		[ 'route_gating', 'capability_integrity', 'ai_read_only' ].forEach(n => assert.ok(names.indexOf(n) >= 0, n + ' registered'));
	});

	await test('built-in checks pass against the real modules (no findings)', async () => {
		const findings = await Watchdog.run(noop, {});   // no router → route_gating skips; others validate real data
		assert.strictEqual(findings.length, 0, 'clean run: ' + JSON.stringify(findings));
	});

	await test('a check returning a finding is reported', async () => {
		Watchdog.register('t_find', () => ({ action: 'test.finding', target: 'x', detail: 'bad thing' }));
		const findings = await Watchdog.run(noop, {});
		assert.ok(findings.some(f => f.action === 'test.finding' && f.detail === 'bad thing'), 'finding surfaced');
	});

	await test('an ASYNC check is awaited and its finding reported', async () => {
		Watchdog.register('t_async', async () => { return { action: 'test.async_finding', target: '1', detail: 'from a promise' }; });
		const findings = await Watchdog.run(noop, {});
		assert.ok(findings.some(f => f.action === 'test.async_finding'), 'async check finding surfaced');
	});

	await test('a THROWING check becomes a finding, never breaks the run', async () => {
		Watchdog.register('t_throw', () => { throw new Error('boom'); });
		const findings = await Watchdog.run(noop, {});
		assert.ok(findings.some(f => f.action === 'watchdog.check_failed' && /boom/.test(f.detail)), 'throwing check reported');
		assert.ok(findings.some(f => f.action === 'test.finding'), 'other checks still ran');
	});

	await test('a REJECTING async check becomes a finding, never breaks the run', async () => {
		Watchdog.register('t_reject', async () => { throw new Error('async boom'); });
		const findings = await Watchdog.run(noop, {});
		assert.ok(findings.some(f => f.action === 'watchdog.check_failed' && /async boom/.test(f.detail)), 'rejecting async check reported');
	});

	await test('registration is idempotent by name (re-register replaces, never duplicates)', async () => {
		const before = Watchdog.list().length;
		Watchdog.register('t_find', () => null);   // same name → replace
		assert.strictEqual(Watchdog.list().length, before, 'no duplicate registration');
		const findings = await Watchdog.run(noop, {});
		assert.ok(!findings.some(f => f.action === 'test.finding'), 'replaced check no longer fires');
	});

	await test('a run WITH findings still logs a one-line sweep summary + a watchdog.summary audit', async () => {
		const logs = [], audits = [];
		const share = { Common: { logger: (m) => logs.push(String(m)), auditEvent: (actor, action, target, detail) => audits.push({ actor, action, target, detail }) } };
		Watchdog.register('t_summary', () => ({ action: 'test.summary_finding', target: 'x', detail: 'a problem' }));
		await Watchdog.run(share, { label: 'instance' });
		// The sweep must announce itself even when a finding is present, so a single warning can't be mistaken
		// for "the integrity checks stopped running" (the exact confusion the default-password warning caused).
		assert.ok(logs.some(l => /integrity checks ran —/.test(l) && /passed/.test(l) && /finding\(s\)/.test(l)), 'sweep summary line present with findings: ' + JSON.stringify(logs));
		assert.ok(logs.some(l => /test\.summary_finding/.test(l)), 'the finding itself is still logged below the summary');
		assert.ok(audits.some(a => a.action === 'watchdog.summary'), 'a watchdog.summary audit entry is recorded when findings exist');
		Watchdog.register('t_summary', () => null);   // neutralize for the clean-run test below
	});

	await test('a CLEAN run logs the all-passed summary and a watchdog.ok audit', async () => {
		[ 't_find', 't_async', 't_throw', 't_reject', 't_summary' ].forEach(n => Watchdog.register(n, () => null));   // neutralize all test finders
		const logs = [], audits = [];
		const share = { Common: { logger: (m) => logs.push(String(m)), auditEvent: (actor, action, target, detail) => audits.push({ actor, action, target, detail }) } };
		const findings = await Watchdog.run(share, { label: 'instance' });
		assert.strictEqual(findings.length, 0, 'no findings once test checks are neutralized: ' + JSON.stringify(findings));
		assert.ok(logs.some(l => /all integrity checks passed/.test(l)), 'clean-run summary present');
		assert.ok(audits.some(a => a.action === 'watchdog.ok'), 'watchdog.ok audit recorded on a clean run');
	});

	console.log('\n' + passed + ' passed, ' + failed + ' failed');
	process.exit(failed ? 1 : 0);
})();
