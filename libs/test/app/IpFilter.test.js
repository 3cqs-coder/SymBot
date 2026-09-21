'use strict';

// IpFilter — the shared IP allow/deny matcher used at the server-wide, login and per-key layers.
// This is security-critical, so the tests exercise CIDR boundaries, IPv6, IPv4-mapped IPv6, the
// deny-wins rule, empty-allowlist semantics, and the always-exempt loopback behavior.

const assert = require('assert');
const Ip = require('../../app/IpFilter.js');

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log('  ok   - ' + name); } catch (e) { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); } }

console.log('\nIpFilter:');

test('exact IPv4 match', () => {
	assert.ok(Ip.matchOne('1.2.3.4', '1.2.3.4'));
	assert.ok(!Ip.matchOne('1.2.3.4', '1.2.3.5'));
});

test('IPv4 CIDR boundaries', () => {
	assert.ok(Ip.matchOne('10.1.2.3', '10.0.0.0/8'));
	assert.ok(Ip.matchOne('10.255.255.255', '10.0.0.0/8'));
	assert.ok(!Ip.matchOne('11.0.0.0', '10.0.0.0/8'));
	assert.ok(Ip.matchOne('192.168.1.55', '192.168.1.0/24'));
	assert.ok(!Ip.matchOne('192.168.2.1', '192.168.1.0/24'));
	// /32 = single host
	assert.ok(Ip.matchOne('5.5.5.5', '5.5.5.5/32'));
	assert.ok(!Ip.matchOne('5.5.5.6', '5.5.5.5/32'));
	// /0 matches everything
	assert.ok(Ip.matchOne('8.8.8.8', '0.0.0.0/0'));
});

test('IPv6 exact + CIDR', () => {
	assert.ok(Ip.matchOne('2001:db8::1', '2001:db8::1'));
	assert.ok(Ip.matchOne('2001:db8:0:0:0:0:0:1', '2001:db8::1'));   // equivalent forms
	assert.ok(Ip.matchOne('2001:db8:abcd:1234::1', '2001:db8::/32'));
	assert.ok(!Ip.matchOne('2001:dead::1', '2001:db8::/32'));
	assert.ok(Ip.matchOne('::1', '::1'));
});

test('IPv4-mapped IPv6 normalizes to IPv4', () => {
	assert.ok(Ip.matchOne('::ffff:192.168.0.1', '192.168.0.0/24'));
	assert.ok(Ip.matchOne('::ffff:1.2.3.4', '1.2.3.4'));
});

test('zone id is stripped', () => {
	assert.ok(Ip.matchOne('fe80::1%eth0', 'fe80::1'));
});

test('families never cross-match', () => {
	assert.ok(!Ip.matchOne('1.2.3.4', '::/0'));
	assert.ok(!Ip.matchOne('::1', '0.0.0.0/0'));
});

test('isLoopback', () => {
	assert.ok(Ip.isLoopback('127.0.0.1'));
	assert.ok(Ip.isLoopback('127.9.9.9'));
	assert.ok(Ip.isLoopback('::1'));
	assert.ok(Ip.isLoopback('::ffff:127.0.0.1'));
	assert.ok(!Ip.isLoopback('10.0.0.1'));
});

test('evaluate: empty lists allow all', () => {
	assert.strictEqual(Ip.evaluate('9.9.9.9', {}).allowed, true);
	assert.strictEqual(Ip.evaluate('9.9.9.9', { allow: [], deny: [] }).allowed, true);
});

test('evaluate: allowlist restricts', () => {
	assert.strictEqual(Ip.evaluate('10.0.0.5', { allow: ['10.0.0.0/8'] }).allowed, true);
	assert.strictEqual(Ip.evaluate('11.0.0.5', { allow: ['10.0.0.0/8'] }).allowed, false);
});

test('evaluate: deny wins over allow', () => {
	const rules = { allow: ['10.0.0.0/8'], deny: ['10.0.0.5'] };
	assert.strictEqual(Ip.evaluate('10.0.0.6', rules).allowed, true);
	assert.strictEqual(Ip.evaluate('10.0.0.5', rules).allowed, false);   // denied despite being allowed
});

test('evaluate: blocklist only', () => {
	assert.strictEqual(Ip.evaluate('1.2.3.4', { deny: ['1.2.3.4'] }).allowed, false);
	assert.strictEqual(Ip.evaluate('1.2.3.5', { deny: ['1.2.3.4'] }).allowed, true);
});

test('evaluate: loopback exempt only when opted in', () => {
	// A pathological allowlist that excludes localhost:
	const rules = { allow: ['203.0.113.0/24'] };
	assert.strictEqual(Ip.evaluate('127.0.0.1', rules, { allowLoopback: true }).allowed, true);
	assert.strictEqual(Ip.evaluate('127.0.0.1', rules, { allowLoopback: false }).allowed, false);
	// Loopback exemption never overrides a real remote allow decision.
	assert.strictEqual(Ip.evaluate('203.0.113.9', rules, { allowLoopback: true }).allowed, true);
});

test('IPv4 wildcard / partial notation', () => {
	// star wildcards
	assert.ok(Ip.matchOne('192.168.1.55', '192.168.1.*'));
	assert.ok(!Ip.matchOne('192.168.2.55', '192.168.1.*'));
	assert.ok(Ip.matchOne('192.168.9.9', '192.168.*'));
	assert.ok(!Ip.matchOne('192.169.0.1', '192.168.*'));
	assert.ok(Ip.matchOne('10.9.8.7', '10.*'));
	assert.ok(!Ip.matchOne('11.0.0.1', '10.*'));
	// trailing-dot partials
	assert.ok(Ip.matchOne('192.168.1.200', '192.168.1.'));
	assert.ok(Ip.matchOne('172.16.5.4', '172.16.'));
	assert.ok(!Ip.matchOne('172.17.5.4', '172.16.'));
	// expands to the right CIDR
	assert.strictEqual(Ip.expandRule('192.168.1.*'), '192.168.1.0/24');
	assert.strictEqual(Ip.expandRule('192.168.'), '192.168.0.0/16');
	assert.strictEqual(Ip.expandRule('10.*'), '10.0.0.0/8');
	// a fully-specified "partial" is just the exact address
	assert.strictEqual(Ip.expandRule('1.2.3.4'), '1.2.3.4');
	// concrete octet after a wildcard is rejected
	assert.ok(!Ip.validateRule('10.*.5').valid);
	assert.ok(!Ip.matchOne('10.4.5.6', '10.*.5'));
});

test('partials work through evaluate() like any rule', () => {
	assert.strictEqual(Ip.evaluate('192.168.1.10', { allow: ['192.168.1.*'] }).allowed, true);
	assert.strictEqual(Ip.evaluate('192.168.2.10', { allow: ['192.168.1.*'] }).allowed, false);
	assert.strictEqual(Ip.evaluate('10.0.0.9', { deny: ['10.*'] }).allowed, false);
});

test('validateRule + sanitizeList', () => {
	assert.ok(Ip.validateRule('1.2.3.4').valid);
	assert.ok(Ip.validateRule('10.0.0.0/8').valid);
	assert.ok(Ip.validateRule('2001:db8::/32').valid);
	assert.ok(!Ip.validateRule('999.1.1.1').valid);
	assert.ok(!Ip.validateRule('10.0.0.0/40').valid);
	assert.ok(!Ip.validateRule('not-an-ip').valid);
	assert.ok(!Ip.validateRule('').valid);
	assert.deepStrictEqual(Ip.sanitizeList(['1.2.3.4', 'junk', '10.0.0.0/8', '']), ['1.2.3.4', '10.0.0.0/8']);
});

test('garbage never matches / never throws', () => {
	assert.ok(!Ip.matchOne('', '1.2.3.4'));
	assert.ok(!Ip.matchOne('1.2.3.4', ''));
	assert.ok(!Ip.matchOne('not-an-ip', '10.0.0.0/8'));
	assert.ok(!Ip.matchOne('1.2.3.4', 'not-a-rule'));
	assert.strictEqual(Ip.evaluate('junk', { allow: ['10.0.0.0/8'] }).allowed, false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);