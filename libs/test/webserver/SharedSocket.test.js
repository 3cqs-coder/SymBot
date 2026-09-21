'use strict';

// Pins the shared Socket.IO connection resolver (sharedSocket.resolveConnection), which both the instance and
// Hub web servers use to decide who may open a websocket. The security-critical contract: a principal resolved
// from the handshake is attached to the socket; a session whose user no longer resolves to an active principal
// (disabled or deleted after login) is flagged `deprovisioned` so the caller refuses it; a resolver error never
// throws (it yields principal:null). Each surface composes its own final loggedIn on top of these primitives,
// so getting these building blocks wrong would silently change admission on BOTH surfaces.

const assert = require('assert');
const SharedSocket = require('../../webserver/sharedSocket.js');

let passed = 0, failed = 0;
function test(name, fn) {
	return Promise.resolve().then(fn).then(
		() => { passed++; console.log('  ok   - ' + name); },
		(e) => { failed++; process.exitCode = 1; console.log('  FAIL - ' + name + '\n         ' + e.message); }
	);
}

// A minimal fake socket client with a session and handshake headers.
function fakeClient(session) {
	return { request: { session: session }, handshake: { headers: { 'x-test': '1' } } };
}
// shareData whose AuthMiddleware.resolvePrincipal returns/throws whatever the test wants.
function shareWith(resolver) {
	return { AuthMiddleware: { resolvePrincipal: resolver } };
}

async function run() {

	console.log('\nShared socket connection resolver (resolveConnection):');

	await test('exports makeServer and resolveConnection', () => {
		assert.strictEqual(typeof SharedSocket.makeServer, 'function');
		assert.strictEqual(typeof SharedSocket.resolveConnection, 'function');
	});

	await test('a resolved principal is attached to the client and is not deprovisioned', async () => {
		const client = fakeClient({ loggedIn: true, userId: 'u1' });
		const r = await SharedSocket.resolveConnection(client, shareWith(async () => ({ id: 'u1', capabilities: ['*'] })), '127.0.0.1');
		assert.deepStrictEqual(r.principal, { id: 'u1', capabilities: ['*'] });
		assert.strictEqual(client.principal, r.principal, 'principal must be attached to the socket');
		assert.strictEqual(r.deprovisioned, false);
		assert.strictEqual(r.sess.loggedIn, true);
	});

	await test('a logged-in session whose user no longer resolves is flagged deprovisioned', async () => {
		// The classic disabled/deleted-after-login case: session says loggedIn with a userId, but the
		// resolver returns null -> must be refused (deprovisioned true), never silently admitted.
		const client = fakeClient({ loggedIn: true, userId: 'gone' });
		const r = await SharedSocket.resolveConnection(client, shareWith(async () => null), '127.0.0.1');
		assert.strictEqual(r.principal, null);
		assert.strictEqual(r.deprovisioned, true, 'a loggedIn session with a userId but no principal is deprovisioned');
	});

	await test('a legacy session with no userId resolves to the owner principal and is not deprovisioned', async () => {
		// Single-user installs: legacy session, resolver returns the owner principal (non-null).
		const client = fakeClient({ loggedIn: true });
		const r = await SharedSocket.resolveConnection(client, shareWith(async () => ({ id: 'owner' })), '127.0.0.1');
		assert.strictEqual(r.deprovisioned, false, 'no userId means not deprovisioned even before principal check');
	});

	await test('an anonymous session (not logged in, no principal) is not deprovisioned', async () => {
		const client = fakeClient({});
		const r = await SharedSocket.resolveConnection(client, shareWith(async () => null), '127.0.0.1');
		assert.strictEqual(r.principal, null);
		assert.strictEqual(r.deprovisioned, false, 'deprovisioned requires a loggedIn session with a userId');
		assert.deepStrictEqual(r.sess, {});
	});

	await test('a resolver that throws never throws out — yields principal null', async () => {
		const client = fakeClient({ loggedIn: true, userId: 'u1' });
		const r = await SharedSocket.resolveConnection(client, shareWith(async () => { throw new Error('boom'); }), '127.0.0.1');
		assert.strictEqual(r.principal, null, 'a resolver error is swallowed to null, not propagated');
		assert.strictEqual(client.principal, null);
	});

	await test('missing AuthMiddleware yields principal null and a safe empty session default', async () => {
		const client = { request: {}, handshake: { headers: {} } };   // no session at all
		const r = await SharedSocket.resolveConnection(client, {}, '');
		assert.strictEqual(r.principal, null);
		assert.deepStrictEqual(r.sess, {}, 'a missing session normalizes to {}');
		assert.strictEqual(r.deprovisioned, false);
	});

	// normalizeRooms: the joinRooms payload parser shared by both surfaces. A bad client emit (null/undefined/
	// non-object) must NOT throw — the instance handler runs inside the trading process — and a single room
	// must normalize to a one-element array.
	console.log('\nShared joinRooms payload parser (normalizeRooms):');

	await test('exports normalizeRooms', () => {
		assert.strictEqual(typeof SharedSocket.normalizeRooms, 'function');
	});

	await test('a null/undefined/non-object payload yields [] and never throws', () => {
		assert.deepStrictEqual(SharedSocket.normalizeRooms(undefined), [], 'undefined payload');
		assert.deepStrictEqual(SharedSocket.normalizeRooms(null), [], 'null payload');
		assert.deepStrictEqual(SharedSocket.normalizeRooms('nope'), [], 'string payload has no .rooms');
		assert.deepStrictEqual(SharedSocket.normalizeRooms({}), [], 'object with no rooms');
		assert.deepStrictEqual(SharedSocket.normalizeRooms({ rooms: null }), [], 'explicit null rooms');
	});

	await test('a single room becomes a one-element array; an array passes through', () => {
		assert.deepStrictEqual(SharedSocket.normalizeRooms({ rooms: 'memory' }), ['memory'], 'single room → [room]');
		assert.deepStrictEqual(SharedSocket.normalizeRooms({ rooms: ['a', 'b'] }), ['a', 'b'], 'array of rooms passes through');
	});

	console.log('\nSharedSocket: ' + (failed ? ('✗ ' + failed + ' failed, ') : '✓ ') + passed + ' passed\n');
}

run();
