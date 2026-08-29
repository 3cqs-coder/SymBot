'use strict';

let shareData;

const API_ROOM = 'api';

// Maximum concurrent in-flight requests per client
const MAX_CONCURRENT_REQUESTS = 5;

// Timeout in milliseconds for each handler before returning an error
const HANDLER_TIMEOUT_MS = 15000;


const apiHandlers = {
	'deals':           apiDeals,
	'deals/show':      apiDealsShow,
	'deals/completed': apiDealsCompleted,
	'bots':            apiBots,
	'balances':        apiBalances,
	'markets':         apiMarkets,
	'markets/ohlcv':   apiMarketsOhlcv
};

// Per-action capability requirements for the WebSocket API. Every handler above is read-only, but
// "read-only" is not "no permission" — the HTTP path requires deal.read / bot.read / account.read /
// stats.read for the same data (see RoutePermissions), so a scoped key with only e.g. deal.create must
// not be able to read balances or the whole book over the socket. These map each read handler to the
// same capability its HTTP twin needs; the gate in api() enforces it against the connection principal.
// Add an entry (e.g. 'deals/close': 'deal.close') when a state-changing handler is introduced.
const WS_CAPS = {
	'deals':           'deal.read',
	'deals/show':      'deal.read',
	'deals/completed': 'deal.read',
	'bots':            'bot.read',
	'balances':        'account.read',
	'markets':         'stats.read',
	'markets/ohlcv':   'stats.read'
};


async function apiDeals() {

	const req = {
		params: { path: '' },
		query:  { active: true }
	};

	return shareData.DCABotManager.apiGetActiveDeals(req, undefined, false);
}


async function apiMarkets(data) {

	const req = {
		params: { path: '' },
		query: {
			exchange:  data.exchange,
			pair:      data.pair
		}
	};

	return shareData.DCABotManager.apiGetMarkets(req, undefined, false);
}


async function apiMarketsOhlcv(data) {

	const req = {
		params: { path: 'ohlcv' },
		query: {
			exchange:  data.exchange,
			pair:      data.pair,
			timeframe: data.timeframe,
			type:      data.type,
			since:     data.since,
			limit:     data.limit
		}
	};

	return shareData.DCABotManager.apiGetMarkets(req, undefined, false);
}



async function apiDealsShow(data) {

	const dealId = data.dealId;

	const req = {
		params: { dealId: dealId },
		query:  {}
	};

	return shareData.DCABotManager.apiShowDeal(req, undefined, dealId, false);
}


async function apiDealsCompleted(data) {

	const req = {
		params: {},
		query: {
			from:           data.from,
			to:             data.to,
			timeZoneOffset: data.timeZoneOffset,
			botId:          data.botId
		}
	};

	return shareData.DCABotManager.apiGetDealsHistory(req, undefined, false);
}


async function apiBots(data) {

	const req = {
		params: {},
		query:  { active: data.active }
	};

	return shareData.DCABotManager.apiGetBots(req, undefined, false);
}


async function apiBalances() {

	return shareData.DCABotManager.apiGetBalances(undefined, undefined, false);
}


// Wraps a handler Promise with a timeout. Rejects with a clear message
// if the handler does not resolve within HANDLER_TIMEOUT_MS.
function withTimeout(promise, ms) {
	// Shared timeout logic (shareData.Common.withTimeout): reject with a clear message if the handler doesn't resolve in time.
	return shareData.Common.withTimeout(promise, ms, { message: 'Request timed out after ' + ms + 'ms' });
}


// Sends a structured response back to the requesting client.
// Used for both successful results and errors so the client always
// receives a reply for every api_action it sends.
function sendResponse(client, apiName, appId, messageId, message, error) {

	client.emit('data', {
		'type':              'api',
		'api':               apiName,
		'app_id':            appId,
		'message_id':        shareData.Common.uuidv4(),
		'message_id_client': messageId,
		'message':           message,
		'error':             error || null
	});
}


async function api(client, data, inflightMap) {

	const metaData  = data.meta || {};
	const apiName   = metaData.api;
	const appId     = metaData.appId;
	const messageId = metaData.id;

	// Strip MongoDB operator keys from the socket payload before any handler builds a query from it — the
	// WebSocket path does not pass through the HTTP ingress sanitizer, so {dealId:{$ne:null}} could otherwise
	// reach a Mongo filter (e.g. deals/show). Best-effort; never blocks the call.
	try { shareData.Common.stripMongoOperators(data); } catch (e) { /* defensive only */ }

	// Ensure client is in api room
	if (!client.rooms.has(API_ROOM)) {

		sendResponse(client, apiName, appId, messageId, null, 'Not registered. Emit register_client first.');
		return;
	}

	const handler = apiHandlers[apiName];

	if (!handler) {

		sendResponse(client, apiName, appId, messageId, null, 'Unknown API: ' + apiName);
		return;
	}

	// Re-resolve the connection principal on each API call so a key revoked, or a user disabled, AFTER the
	// socket opened stops being served — the principal cached at connect would otherwise keep reading
	// deals/bots/balances until the socket happened to disconnect. This mirrors the HTTP layer, which
	// re-resolves every request. In normal operation the legacy single API key resolves to the owner
	// principal (non-null), so it is re-resolved like any other; only if API access was disabled at connect
	// would a socket carry a null principal, and the `client.principal &&` guard below simply skips those
	// (that key is config-level, not per-session revocable).
	//
	// On a null result we REFUSE THIS ONE CALL rather than disconnecting the socket — exactly what the HTTP
	// layer does when it 401s a single request. resolvePrincipal catches its own DB errors internally and
	// returns null (not a throw), so a null is indistinguishable between a real revocation and a momentary
	// lookup blip; refusing-per-call (instead of dropping the socket) means a real revocation keeps failing
	// every call so nothing is ever served, while a transient blip costs one call and recovers on the next —
	// never bouncing a validly-connected named-user socket. The cached principal is left untouched on null so
	// the WS_CAPS gate below never runs against a half-resolved state.
	if (client.principal && shareData && shareData.AuthMiddleware && typeof shareData.AuthMiddleware.resolvePrincipal === 'function') {

		try {

			const ip = (shareData.Common && typeof shareData.Common.getClientIp === 'function') ? shareData.Common.getClientIp(client) : '';
			const fresh = await shareData.AuthMiddleware.resolvePrincipal({ session: client.request.session, headers: client.handshake.headers, ip });

			if (!fresh) {

				sendResponse(client, apiName, appId, messageId, null, 'Your session or key is no longer valid — please sign in again.');
				return;
			}

			client.principal = fresh;
		}
		catch (e) { /* transient resolution error — keep the cached principal; the next call re-checks */ }
	}

	// Capability gate for the WebSocket API. Every handler is read-only, but "read-only" is not "no
	// permission": WS_CAPS maps each read action to the same *.read capability its HTTP twin requires, so a
	// narrowly-scoped key can't read data over the socket that it couldn't read over HTTP. It is enforced
	// against the connection principal — re-resolved just above, so a revoked key or downgraded scope is
	// caught on the next call. When a state-changing WS handler is added, map its action name in WS_CAPS to
	// the capability it requires (e.g. 'deals/close': 'deal.close').
	const requiredCap = WS_CAPS[apiName];

	// Fail closed: every dispatchable handler must declare its capability in WS_CAPS. apiName is already
	// known to be a real handler here (resolved above), so a missing entry means a new handler was added
	// to apiHandlers but its WS_CAPS mapping was forgotten — deny it rather than serve it ungated. This is
	// the safe direction on an oversight (the Hub's action map falls back to a coarse cap; here we refuse).
	if (!requiredCap) {

		sendResponse(client, apiName, appId, messageId, null, 'Forbidden — this API has no capability mapping');
		if (shareData && shareData.Common) { shareData.Common.logger('WebSocket API "' + apiName + '" is dispatchable but has no WS_CAPS mapping — denied (fail-closed)'); }
		return;
	}

	if (shareData && shareData.Authz && !shareData.Authz.can(client.principal, requiredCap)) {

		sendResponse(client, apiName, appId, messageId, null, 'Forbidden — missing permission (' + requiredCap + ')');
		return;
	}

	// Rate limit — cap concurrent in-flight requests per client
	const inFlight = inflightMap.get(client.id) || 0;

	if (inFlight >= MAX_CONCURRENT_REQUESTS) {

		sendResponse(client, apiName, appId, messageId, null, 'Too many concurrent requests. Please wait.');
		return;
	}

	inflightMap.set(client.id, inFlight + 1);

	try {

		const message = await withTimeout(handler(data), HANDLER_TIMEOUT_MS);

		sendResponse(client, apiName, appId, messageId, message, null);
	}
	catch (e) {

		const errMsg = e?.message || 'Internal error';

		shareData.Common.logger('WebSocket API error [' + apiName + ']: ' + errMsg);

		sendResponse(client, apiName, appId, messageId, null, errMsg);
	}
	finally {

		const current = inflightMap.get(client.id) || 1;

		if (current <= 1) {
			inflightMap.delete(client.id);
		}
		else {
			inflightMap.set(client.id, current - 1);
		}
	}
}


module.exports = {

	api,

	init(obj) {

		shareData = obj;
	}
};