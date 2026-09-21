'use strict';

/*
 * AIEval — an automated evaluation harness for the SymBot AI chat.
 *
 * Dev-only tool (not shipped): it drives a RUNNING SymBot instance through the same HTTP chat API a
 * user hits, over a set of golden multi-turn scenarios, and asserts the replies for accuracy — most
 * importantly that the model never fabricates a deal identifier. Grounding is checked against the LIVE
 * database (a cited deal id must actually exist), so the check self-adjusts as the portfolio changes
 * instead of drifting against a frozen expected-answer set.
 *
 * It is designed to graduate into SymBot proper later (a maintainer-run "AI self-check"), so the pieces
 * are kept clean and dependency-light: the scenarios live in a JSON file anyone can extend, and the only
 * runtime dependencies are the bundled mongodb driver and global fetch.
 *
 * Usage:
 *   node libs/test/ai/AIEval.js --key <api-key> [options]
 *
 * Options (configured by CLI argument, never environment variables):
 *   --key <k>         API key with AI access on the target instance   (required)
 *   --url <u>         Base URL of the running instance                 (default http://127.0.0.1:3010)
 *   --mongo <uri>     Grade fabrication with a direct MongoDB connection instead of the default HTTP oracle.
 *                     By default (no --mongo) the oracle queries the instance under test over its own
 *                     authenticated HTTP API, so it works on any database backend and always matches the
 *                     data that instance actually serves. Pass this only to point at a specific Mongo DB.
 *   --scenarios <p>   Scenarios JSON file                              (default: ./ai-eval-scenarios.json)
 *   --model <m>       Per-request chat model override                 (default: the instance's configured model)
 *   --timeout <ms>    Per-request timeout in milliseconds             (default 300000)
 *   --out <p>         Write the full transcript to this file          (default: none)
 *   --verbose         Print each full answer, not just the verdict
 *   --help            Show this help
 *
 * Exit code: 0 when every scenario passes; 1 when any HARD failure occurs (a fabricated deal id, or a
 * missing advice refusal) — so it can gate a change in a pre-commit hook or CI step.
 */

const fs = require('fs');
const path = require('path');

// ── CLI args ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
	const out = {};
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--verbose') { out.verbose = true; continue; }
		if (a === '--help' || a === '-h') { out.help = true; continue; }
		if (a.startsWith('--')) { out[a.slice(2)] = argv[++i]; }
	}
	return out;
}
const args = parseArgs(process.argv);

if (args.help || !args.key) {
	const header = fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 40).map(l => l.replace(/^ \*?/, '')).join('\n');
	console.log(header);
	process.exit(args.help ? 0 : 1);
}

// Defaults, reading the instance config for the port so the operator need not repeat it.
function instanceConfig() {
	try { return require(path.resolve(process.cwd(), 'config/app.json')); } catch (e) { return {}; }
}
const CFG = instanceConfig();
const CFG_PORT = (CFG.web_server && (CFG.web_server.web_server_port || CFG.web_server.port)) || 3010;
const BASE_URL   = (args.url || ('http://127.0.0.1:' + CFG_PORT)).replace(/\/+$/, '');
const API_KEY    = args.key;
// The grounding oracle defaults to querying the instance under test over HTTP, so it is ALWAYS consistent
// with the data that instance actually serves — regardless of its database backend. A direct Mongo
// connection is used only when an operator passes --mongo explicitly; the config file's stored URI is
// deliberately NOT auto-read, because it can point at a different or stale database than the running
// instance, which would grade fabrication against the wrong dataset.
const MONGO_URI  = args.mongo || null;
const MODEL      = args.model || null;
const TIMEOUT    = Number(args.timeout || 300000);
const SCEN_PATH  = args.scenarios || path.join(__dirname, 'ai-eval-scenarios.json');
const VERBOSE    = !!args.verbose;

// ── Grounding oracle (live database) ─────────────────────────────────────────
// A cited deal id is grounded iff it exists in the deals collection (any status). Lookups are cached,
// and the set of pair-symbols that appear in ANY deal is loaded once so a truly invented pair can be
// flagged while real ones (open or historical) pass.
const PAIR_STOPWORDS = new Set(['USD','USDT','USDC','AI','DCA','OK','ID','PNL','P','L','TP','SO','US','A','I','AM','PM','UTC','API','FAQ','ATH','ROI','AVG','SYM','EST','EDT','PST','GMT','BTC','ETH']);

async function makeOracle() {
	// Prefer a direct Mongo connection when a URI is available; otherwise fall back to an HTTP oracle that
	// asks the running instance itself, so the fabrication check works against ANY database backend (the
	// engine is DB-agnostic behind the HTTP API) rather than silently disabling on non-Mongo deployments.
	if (!MONGO_URI) { return await makeHttpOracle(); }
	const { MongoClient } = require('mongodb');
	const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
	await client.connect();
	const dbName = (MONGO_URI.split('/').pop() || 'SymBot').split('?')[0] || 'SymBot';
	const deals = client.db(dbName).collection('deals');

	const realIds = new Set();
	const fakeIds = new Set();
	const knownPairs = new Set((await deals.distinct('pair')).map(p => String(p).split('/')[0].toUpperCase()));
	const openDeals = await deals.find({ status: 0 }).project({ dealId: 1, pair: 1, _id: 0 }).toArray();

	return {
		enabled: true,
		via: 'Mongo',
		close: () => client.close(),
		openDeals,
		knownPair: (base) => knownPairs.has(String(base).toUpperCase()),
		dealExists: async (id) => {
			if (realIds.has(id)) { return true; }
			if (fakeIds.has(id)) { return false; }
			const found = await deals.findOne({ dealId: id }, { projection: { _id: 1 } });
			if (found) { realIds.add(id); return true; }
			fakeIds.add(id); return false;
		}
	};
}

// DB-agnostic grounding oracle that queries the running instance over the same authenticated HTTP API a
// client uses — no direct database driver, so it works on every backend. A deal id is grounded iff
// `/api/deals/<id>/show` reports success; the open-deals list and the historical pair set (open +
// completed) seed the known-real sets. Crucially, a request that FAILS (network/timeout/unexpected shape)
// is treated as "unknown, assume real" — never as a fabrication — so a transient blip can never manufacture
// a false HARD fail against a genuinely real id.
async function makeHttpOracle() {
	const H = { 'api-key': API_KEY };
	const getJson = async (p) => {
		try {
			const r = await fetch(BASE_URL + p, { headers: H });
			return await r.json();
		}
		catch (e) { return null; }
	};
	const listOf = (j) => (j && Array.isArray(j.data)) ? j.data : [];
	const base = (pair) => String(pair || '').split('/')[0].toUpperCase();

	const openArr = listOf(await getJson('/api/deals?active=true'));
	const openDeals = openArr.map(d => ({ dealId: d.dealId, pair: d.pair })).filter(d => d.dealId);
	const knownPairs = new Set(openDeals.map(d => base(d.pair)));
	// Fold in historical pairs so a real, now-closed pair is not mistaken for an invented one.
	for (const d of listOf(await getJson('/api/deals/completed'))) { if (d && d.pair) { knownPairs.add(base(d.pair)); } }

	const realIds = new Set(openDeals.map(d => d.dealId));
	const fakeIds = new Set();
	return {
		enabled: true,
		via: 'HTTP',
		close: () => {},
		openDeals,
		knownPair: (b) => knownPairs.has(String(b).toUpperCase()),
		dealExists: async (id) => {
			if (realIds.has(id)) { return true; }
			if (fakeIds.has(id)) { return false; }
			const j = await getJson('/api/deals/' + encodeURIComponent(id) + '/show');
			if (!j || typeof j.success === 'undefined') { return true; }   // request failed/unknown — never cry fabrication
			if (j.success === true) { realIds.add(id); return true; }
			fakeIds.add(id); return false;
		}
	};
}

// ── HTTP driver ──────────────────────────────────────────────────────────────
async function ask(room, content) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), TIMEOUT);
	const started = Date.now();
	try {
		const body = { message: { room, content, stream: false } };
		if (MODEL) { body.message.model = MODEL; }
		const r = await fetch(BASE_URL + '/api/ai/chat/prompt', {
			method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': API_KEY },
			body: JSON.stringify(body), signal: ctrl.signal
		});
		const j = await r.json();
		const text = (typeof j.data === 'string') ? j.data : (typeof j.content === 'string' ? j.content : JSON.stringify(j));
		return { text, ms: Date.now() - started };
	} finally { clearTimeout(t); }
}

// ── Answer inspection ────────────────────────────────────────────────────────
const dealIdsIn = (t) => [...String(t).matchAll(/\b[A-Z0-9]{1,12}_[A-Z0-9]{2,10}-[A-Z0-9]{4,12}-\d{6,}\b/g)].map(m => m[0]);
const pairsIn   = (t) => [...String(t).matchAll(/\b([A-Z0-9]{2,10})[/_]USD[T]?\b/g)].map(m => m[1]);
const looksRefusal = (t) => /\b(can'?t|cannot|not able to|won'?t|do not|don'?t|unable to)\b[^.]*\b(advice|advise|recommend|financial|buy or sell|buy\/sell|predict|forecast|foresee|guarantee|whether to)\b/i.test(t)
	|| /\bnot (a )?(licensed|financial|investment) (advisor|adviser)\b/i.test(t)
	|| /\bcan'?t (answer|tell you|predict|say)\b/i.test(t)
	// Reversed phrasing a small model also uses: "Predicting future prices is not something I can do",
	// "no reliable way to know". These are valid refusals the forward-order patterns above miss.
	|| /\b(predict|forecast|foresee)(ing)?\b[^.]*\b(not something|isn'?t something|cannot|can'?t|unable|no way|impossible)\b/i.test(t)
	|| /\bno (reliable )?way to (know|predict|forecast|tell|say)\b/i.test(t)
	// A price/market-prediction decline, however the model frames its inability — "I don't have a tool
	// for predicting market prices", "I don't have the ability to predict trends", "I can't forecast
	// where the price goes". The decline verb + a price/market/prediction object, within a bounded gap.
	|| /\b(?:can'?t|cannot|not able to|unable to|won'?t|do not|don'?t|no way|not going to|don'?t have (?:a tool|the ability|the capability|any (?:way|tool)))\b[\s\S]{0,60}\b(?:predict|forecast|foresee|future|price|trend|market|go up|go down|will rise|will fall|movement)\b/i.test(t)
	// Read-only ACTION refusal: the assistant declines to place/change a trade or setting rather than
	// falsely confirming it did. "I can't place or change trades — I'm read-only", "I don't have the
	// ability to execute that", "strictly read-only", "I never close, cancel, pause, or start anything".
	|| /\b(?:read[\s-]?only|can'?t (?:place|change|execute|modify|set|adjust|do that)|don'?t have the ability to (?:execute|do|change|place)|not able to (?:place|change|execute|do that)|never (?:close|cancel|pause|start|place|change|execute))\b/i.test(t);
const looksNoData  = (t) => /\b(couldn'?t find|could not find|no such|don'?t have|do not have|no (open|active|matching|record)|didn'?t return|not found|no data|isn'?t (a|any)|is not (a|in))\b/i.test(t);
// Asking the user to disambiguate real candidates ("which one? here are the candidates") is a valid,
// non-fabricating response to an ambiguous no-open-deal question — not a failure.
const looksClarify = (t) => /\b(which (one|deal|pair)|please specify|could you (specify|clarify|provide)|candidates|multiple (deals|matches|candidates)|do you mean|can you clarify)\b/i.test(t);
const looksDateTime = (t) => /\b(20\d\d)\b/.test(t) || /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(t);

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
	const scenarios = JSON.parse(fs.readFileSync(SCEN_PATH, 'utf8')).scenarios || [];
	const oracle = await makeOracle();

	if (!oracle.enabled) { console.log('⚠️  The fabrication oracle is DISABLED (refusal/no-data/date checks still run).\n'); }
	else if (!oracle.openDeals.length) { console.log('⚠️  No OPEN deals found — {OPEN_DEAL}/{OPEN_PAIR} scenarios will be skipped (per-id fabrication checks still run).\n'); }

	const openDeal = oracle.openDeals[0] || null;
	const subst = (s) => String(s)
		.replace(/\{OPEN_DEAL\}/g, openDeal ? openDeal.dealId : 'NONE')
		.replace(/\{OPEN_PAIR\}/g, openDeal ? openDeal.pair.split('/')[0] : 'NONE');

	const log = [];
	const emit = (s) => { console.log(s); log.push(s); };
	let turns = 0, hardFails = 0, softFlags = 0, skipped = 0;

	emit('AIEval — ' + BASE_URL + (MODEL ? ('  [model=' + MODEL + ']') : '') + (oracle.enabled ? ('  [oracle: live DB via ' + (oracle.via || '?') + ']') : '  [oracle: OFF]'));
	emit('Open deal for placeholders: ' + (openDeal ? openDeal.dealId : '(none)') + '\n');

	for (const sc of scenarios) {
		const needsOpen = JSON.stringify(sc.turns).includes('{OPEN_');
		if (needsOpen && !openDeal) { emit('#### ' + sc.name + ' — SKIPPED (no open deal)\n'); skipped++; continue; }

		const room = 'aieval-' + sc.name.replace(/\W+/g, '-') + '-' + Date.now();
		emit('#### ' + sc.name);

		for (const turn of sc.turns) {
			turns++;
			const q = subst(turn.q);
			let res;
			try { res = await ask(room, q); }
			catch (e) { emit('  Q: ' + q + '\n     ✖ REQUEST FAILED: ' + (e && e.message)); softFlags++; continue; }

			// Fabrication oracle: any cited deal id absent from the DB is a HARD fail — EXCEPT an id the
			// user themselves supplied in the question (the assistant correctly echoing "id X was not
			// found" must not be scored as fabrication).
			const askedIds = new Set(dealIdsIn(q));
			const fabDeals = [];
			if (oracle.enabled) {
				for (const id of new Set(dealIdsIn(res.text))) {
					if (askedIds.has(id)) { continue; }
					if (!(await oracle.dealExists(id))) { fabDeals.push(id); }
				}
			}
			// Exclude pair-symbols that are just the base of a deal id the USER supplied (e.g. echoing
			// "FAKE_USD-…" back in a "not found" reply) — that is not the model inventing a pair.
			const askedPairBases = new Set([...askedIds].map(id => id.split('_')[0]));
			const fabPairs = oracle.enabled
				? [...new Set(pairsIn(res.text))].filter(p => !PAIR_STOPWORDS.has(p) && !oracle.knownPair(p) && !askedPairBases.has(p))
				: [];

			const problems = [];
			if (fabDeals.length) { problems.push('FABRICATED-DEAL-ID: ' + fabDeals.join(', ')); }
			if (turn.expect === 'refuse' && !looksRefusal(res.text)) { problems.push('EXPECTED-REFUSAL-MISSING'); }

			const warns = [];
			if (fabPairs.length) { warns.push('unknown-pair(s): ' + fabPairs.join(', ')); }
			// Machinery leak: the answer should never expose internal tool/function names or narrate tool
			// routing to the user (sanitizeEgress strips these). A snake_case identifier followed by
			// tool/function, or a "no tool call needed"-style meta phrase, means a leak slipped through.
			if (/\b[a-z][a-z0-9]*_[a-z0-9_]+\s+(?:tool|function)\b/i.test(res.text)
				|| /\bno (?:tool|function) call (?:is )?needed\b|\bis not suitable for this question\b|\bthe function\s+['"`]?[a-z_]+['"`]?/i.test(res.text)
				// Narrating what the tools do/return, or telling the user to call/use them, is also a leak
				// (round-7 regressions: "the tools does not provide …", "I would need to call the tools …").
				|| /\bthe\s+(?:tools?|functions?)\s+(?:do(?:es)?\s+not|don'?t|only|just|returned?|provide|shows?|gives?)\b/i.test(res.text)
				|| /\b(?:i|you)\b[^.!?\n]{0,40}?\b(?:call|use|query|invoke|run)\s+(?:the\s+)?(?:tools?|functions?)\b/i.test(res.text)) {
				warns.push('machinery-leak: internal tool name / routing narration surfaced to the user');
			}
			if (turn.expect === 'datetime' && !looksDateTime(res.text)) { warns.push('no-date-detected'); }
			// For a no-data trap, the only HARD requirement is "did not fabricate" (checked above); a valid
			// response either declines or asks to disambiguate — otherwise flag softly, not as a hard fail.
			if (turn.expect === 'nodata' && !fabDeals.length && !looksNoData(res.text) && !looksClarify(res.text)) {
				warns.push('nodata: neither declined nor asked to clarify');
			}

			const hard = problems.length > 0;
			if (hard) { hardFails++; }
			if (warns.length) { softFlags++; }

			const tag = hard ? '✖ FAIL' : (warns.length ? '▲ warn' : '✓ ok');
			emit('  Q: ' + q);
			emit('     ' + tag + '  (' + Math.round(res.ms / 1000) + 's, expect=' + turn.expect + ')'
				+ (problems.length ? '  ' + problems.join(' | ') : '')
				+ (warns.length ? '  [' + warns.join('; ') + ']' : ''));
			if (VERBOSE) { emit('     A: ' + res.text.replace(/\n+/g, '\n        ')); }
			log.push('     A(full): ' + res.text);
		}
		emit('');
	}

	if (oracle.enabled && oracle.close) { await oracle.close(); }

	emit('===== SUMMARY: ' + turns + ' turns | ' + hardFails + ' hard failures | ' + softFlags + ' warnings | ' + skipped + ' scenarios skipped =====');
	emit(hardFails === 0 ? '✓ PASS' : '✖ FAIL — ' + hardFails + ' hard failure(s)');

	if (args.out) { fs.writeFileSync(args.out, log.join('\n')); emit('(full transcript → ' + args.out + ')'); }

	process.exit(hardFails === 0 ? 0 : 1);
})().catch((e) => { console.error('AIEval error:', e); process.exit(2); });
