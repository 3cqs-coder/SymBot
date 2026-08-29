'use strict';


// Shared HTTP response helpers for the instance + Hub route layers, so the many route
// handlers don't each re-spell the JSON error envelope. Centralizing the shape means a
// future change (e.g. a stable error code or a correlation id) lands in one place instead
// of ~40 sites. Dependency-free on purpose.


// Standard error response. Historically every handler wrote
// `res.status(200).json({ success: false, error: e.message })` inline; this is that,
// once. Defaults to HTTP 200 (the app returns errors in the JSON body, not the status)
// but accepts an override for the few handlers that use a real error code.
function sendErr(res, e, code) {

	const message = (e && e.message) ? e.message : String(e);

	return res.status(code || 200).json({ success: false, error: message });
}


// Standard 404 for an unmatched route / missing resource. Shared by the instance and Hub
// wildcard handlers (they had byte-identical copies).
function redirectNotFound(res) {

	return res.status(404).send({ 'error': 'Not Found' });
}


// Consistent "not authenticated" response for a route whose caller failed the login / API-key check.
// The instance's data routes historically answered with res.redirect('/login') — a 302 to the HTML login
// page — which is wrong for an API-key or JSON/XHR client (it receives HTML it can't act on, the "works on
// one route but not another" class of bug). Content-negotiate instead, in one place so every route denies
// the same way: a plain browser navigation (accepts HTML, not an XHR, no API credential) still gets the
// friendly login redirect, while an API-key / token client, the dashboard's own XHR fetches (the front-end
// maps a 401 to a login redirect), or any JSON client gets a clean 401. Never throws.
function denyUnauthorized(req, res) {

	const isXhr = !!(req && req.xhr) || (req && req.headers && req.headers['x-requested-with'] === 'XMLHttpRequest');
	const hasApiCred = !!(req && req.headers && (req.headers['api-key'] || req.headers['api-token']));
	let wantsHtml = false;
	try { wantsHtml = !isXhr && !hasApiCred && typeof req.accepts === 'function' && req.accepts([ 'json', 'html' ]) === 'html'; }
	catch (e) { wantsHtml = false; }

	if (wantsHtml) { return res.redirect('/login'); }

	return res.status(401).json({ success: false, error: 'Unauthorized' });
}


// Shared capability-guard factory for the instance + Hub route layers. Both previously kept
// their own near-identical cap()/capAction() wrappers that delegate to the real authorization
// (shareData.AuthMiddleware.requireCap, deny-by-default) and tag the guard with __capGuard so
// RoutePermissions.auditCoverage recognizes the route as gated. They differ ONLY in the
// pre-wiring fallback (used before AuthMiddleware is attached), which the caller supplies as
// `opts.fallback(req,res,next)`. `capability` may be a string, or a function(req)->string for the
// Hub's action-dispatched routes; `opts.tag` is the capability recorded for audit coverage when a
// function is used. `opts.resourceIdFn` is passed through to requireCap for per-resource scoping.
function capGuard(shareData, capability, opts) {

	opts = opts || {};

	const guard = (req, res, next) => {

		const cap = (typeof capability === 'function') ? capability(req) : capability;
		const AM = shareData && shareData.AuthMiddleware;

		if (AM && typeof AM.requireCap === 'function') {

			AM.requireCap(cap, opts.resourceIdFn)(req, res, next);
		}
		else if (typeof opts.fallback === 'function') {

			opts.fallback(req, res, next);
		}
		else {

			res.status(401).json({ success: false, error: 'Unauthorized' });
		}
	};

	// Tag so RoutePermissions.auditCoverage recognizes this route as gated (inline style).
	guard.__capGuard = (typeof capability === 'function') ? opts.tag : capability;

	return guard;
}


module.exports = {
	sendErr,
	redirectNotFound,
	denyUnauthorized,
	capGuard
};