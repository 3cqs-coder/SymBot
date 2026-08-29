'use strict';

// ── Axioms — deterministic answer-verification registry ──────────────────────
//
// A small set of DOMAIN INVARIANTS every composed AI answer must respect, checked
// with plain code (no model call) AFTER the answer is written but BEFORE it reaches
// the user. It complements the grounding backstop rather than repeating it:
//
//   • Grounding (verifyGroundedEntities / checkNumbers) asks "did every id and figure
//     in the answer actually appear in the tool results?" — it catches inventions.
//   • Axioms ask "does the answer CONTRADICT something the tool results state as
//     fact, or violate a rule of the domain?" — e.g. reporting a different open-deal
//     count than the data reports, quoting a template placeholder as a real value, or
//     summing profit across mixed quote currencies (which the data explicitly forbids).
//
// The design mirrors the boot-time Watchdog registry: checks REGISTER themselves and
// `evaluate()` runs every one. Adding an axiom later is a single `register(name, fn)`
// call — no edits to the runner or the caller.
//
// Design rules (kept deliberately strict so this layer can never harm anything):
//   • READ-ONLY over the answer text and the turn's tool sources. It never touches
//     trading, never calls a model, and never throws into its caller — a broken axiom
//     is caught and ignored, exactly like the Watchdog.
//   • Each axiom is `fn(context) -> violation | violation[] | null`, where `context`
//     is `{ answer, sourcesText, questionText }` and a violation is
//     `{ axiom, severity, detail, redact? }`.
//   • Severity follows the verification research's tiering (hard → correctable → soft):
//       - 'redact' : a specific bad token must be removed in place (e.g. a template
//                    placeholder); the violation carries `redact` (string | string[]).
//       - 'caveat' : the answer may be wrong in a way that can't be surgically fixed,
//                    so it ships with the standard uncertainty note appended.
//     The axiom only REPORTS a severity; how to apply it is the caller's decision, so
//     the same registry can back different presentation policies over time.

const CURRENCY = '(?:\\$|€|£|USD|USDT|USDC|BUSD|EUR|GBP|BTC|ETH)';

// Reused from the grounding layer so the id/pair shapes stay defined in exactly one place.
const extractEntities = require('./AIGuardrails').extractEntities;


// ── Registry ─────────────────────────────────────────────────────────────────

const axioms = [];   // { name, fn }

// Register a named axiom. Idempotent by name (re-registering replaces), so requiring
// this module more than once never double-runs a check. Single exit.
function register(name, fn) {
	if (name && typeof fn === 'function') {
		const i = axioms.findIndex(a => a.name === name);
		if (i >= 0) { axioms[i] = { name: name, fn: fn }; } else { axioms.push({ name: name, fn: fn }); }
	}
	return axioms.length;
}

function list() { return axioms.map(a => a.name); }


// Run every registered axiom over one answer. Synchronous and total: it never throws,
// and an axiom that throws is skipped (its failure can never block an answer). Returns
// a flattened array of violations (empty when the answer is clean). Single exit.
function evaluate(context) {

	const ctx = context || {};
	const violations = [];

	for (let i = 0; i < axioms.length; i++) {
		try {
			const res = axioms[i].fn(ctx);
			const arr = Array.isArray(res) ? res : (res ? [ res ] : []);
			arr.filter(Boolean).forEach(v => violations.push({
				axiom: v.axiom || axioms[i].name,
				severity: v.severity || 'caveat',
				detail: v.detail || '',
				redact: v.redact || null,
				correct: v.correct || null
			}));
		}
		catch (e) { /* an axiom must never break the answer */ }
	}

	return violations;
}


// ── Helpers ────────────────────────────────────────────────────────────────────

// Every distinct value the tool results report for a given "…": N numeric field. Used
// to read authoritative counts out of the source text without parsing the full JSON.
function sourceNumbers(sourcesText, field) {
	const out = [];
	if (!sourcesText) { return out; }
	const re = new RegExp('"?' + field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"?\\s*:\\s*(-?\\d+(?:\\.\\d+)?)', 'g');
	let m;
	while ((m = re.exec(sourcesText)) !== null) {
		const n = Number(m[1]);
		if (Number.isFinite(n) && out.indexOf(n) === -1) { out.push(n); }
	}
	return out;
}


// ── Built-in axioms ──────────────────────────────────────────────────────────

// Countable entities whose authoritative TOTAL the tool results report in a single
// canonical field. Adding a new countable is one row here — `count_consistency` picks it
// up automatically, no other change. `noun` is the FIXED phrase (its qualifier included)
// that must immediately follow the number in the answer for it to count as a claim about
// this entity; because the phrase is fixed, a qualified subset like "3 winning closed
// deals" never matches the "closed deals" row, so subsets are never mistaken for a total.
const COUNTABLES = [
	{ field: 'open_deals_total', noun: '(?:open|active)\\s+(?:deals?|positions?|trades?)' },
	{ field: 'completed_deals',  noun: '(?:closed|completed)\\s+deals?' }
];

const TOTAL_LEAD = '(?:you (?:have|currently have|now have)|there are|a total of|in total,?\\s*(?:you have\\s*)?|total(?:ling|ing|s)?\\s*(?:of\\s*)?)';

// 1) count_consistency — the flagship. When the tool results report an authoritative
//    total for a countable entity (open deals, closed/completed deals), the answer must
//    not state a total that contradicts it, and must never claim MORE of them than exist
//    (a subset can't exceed the whole, and a total can't exceed itself). This is the exact
//    failure a weaker model produces most often — "you have 15 open deals" when the data
//    says 16, or "53 open deals" when it is 8 — and it is invisible to the grounding check
//    because every individual number it printed does appear somewhere in the sources.
//
//    Kept conservative to avoid false positives on legitimate subset phrasings ("3 of your
//    16 open deals are in profit"): the total is read from the canonical field only, and a
//    countable with more than one distinct value in the sources (e.g. a per-bot breakdown)
//    is skipped as ambiguous. The answer is flagged on two unambiguous conditions — a
//    number adjacent to the fixed noun that EXCEEDS the true total (impossible), or an
//    explicit total-claim ("you have N open deals", "a total of N completed deals") whose
//    N differs from the true total.
register('count_consistency', function (ctx) {

	const answer = String(ctx.answer || '');
	if (!answer) { return null; }

	for (let i = 0; i < COUNTABLES.length; i++) {
		const c = COUNTABLES[i];
		const totals = sourceNumbers(ctx.sourcesText, c.field);
		if (totals.length !== 1) { continue; }   // absent, or values disagreed → don't judge
		const truth = totals[0];
		if (!Number.isFinite(truth)) { continue; }

		// Rule B FIRST — an explicit claim about the OVERALL count that disagrees with the true total. Checked
		// before the over-count caveat because a total-claim we can locate is CORRECTED in place, which beats
		// merely caveating a number we can fix (e.g. confirming a user's false premise, "you have exactly 100
		// open deals"). Anchored on total-claiming lead-ins so a subset sentence ("3 open deals are underwater")
		// is never mistaken for a total; tolerates an intervening qualifier ("exactly", "only", "just",
		// "currently") that a model — especially a stronger one echoing the user's wording — inserts.
		const totalClaim = new RegExp('\\b' + TOTAL_LEAD + '\\s+(?:exactly\\s+|only\\s+|just\\s+|currently\\s+|now\\s+|still\\s+|precisely\\s+)*(\\d{1,4})\\s+(?:currently\\s+)?' + c.noun + '\\b', 'i');
		const cm = totalClaim.exec(answer);
		if (cm) {
			const n = Number(cm[1]);
			if (Number.isFinite(n) && n !== truth) {
				// A total-claim tells us the model MEANT the overall total, and we hold the authoritative
				// value — so CORRECT the stated number in place rather than only caveating a number we can
				// fix. Swap the digits and fix the noun's plurality ("you have 1 open deal" → "you have 16
				// open deals"). Rule A (an ambiguous over-count) is never auto-corrected — we don't know the
				// intended figure there — so only this explicit-total path carries a correction.
				let replace = cm[0].replace(/\b\d{1,4}\b/, String(truth));
				replace = (truth === 1)
					? replace.replace(/\b(deal|position|trade)s\b/i, '$1')
					: replace.replace(/\b(deal|position|trade)(?!s)\b/i, '$1s');
				return {
					severity: 'correct',
					detail: 'answer claims a total of ' + n + ' where the data reports ' + truth,
					correct: { find: cm[0], replace: replace }
				};
			}
		}

		// Rule A — impossible over-count: ANY "<n> <noun>" with n greater than the true total is necessarily
		// wrong, whatever the surrounding phrasing (total or subset). Caveat only — an ambiguous over-count
		// (which could be a subset) is not safe to rewrite to the total.
		const adjacent = new RegExp('\\b(\\d{1,4})\\s+(?:currently\\s+)?' + c.noun + '\\b', 'gi');
		let m;
		while ((m = adjacent.exec(answer)) !== null) {
			const n = Number(m[1]);
			if (Number.isFinite(n) && n > truth) {
				return { severity: 'caveat', detail: 'answer states ' + n + ' where the data reports ' + truth };
			}
		}
	}

	return null;
});


// 2) no_placeholder — a data answer must never present a TEMPLATE token as if it were a
//    real value. These are the tell-tale shapes a model emits when it wants to show the
//    format of an id/figure but has no real one: angle/bracket slots (<deal_id>, [id]),
//    runs of X or N used as a stand-in (XXXXXX, NNNN), or the literal word placeholder.
//    Bracket/slot forms are redacted in place (they are never legitimate content in a
//    finished answer); their presence also caveats the answer. Only runs when the turn
//    actually produced tool data, so a concept reply explaining a format is left alone.
register('no_placeholder', function (ctx) {

	const answer = String(ctx.answer || '');
	if (!answer) { return null; }

	const redact = [];
	let m;

	// Runs of X/N as a value stand-in (id or amount), the literal word "placeholder", and templated
	// UPPER_CASE id stand-ins the model builds when it has no real id ("PAIR_QUOTE-…", "BASE_QUOTE",
	// "SYMBOL_QUOTE", "COIN_USD" as a template) — the tell is a schema word, not a real ticker. These are
	// NEVER legitimate in a user-facing answer — they are the model regurgitating a FORMAT EXAMPLE from its
	// own prompt as fabricated data. Checked on EVERY path, INCLUDING free-form (no tool data this turn),
	// because a "tell me more" that invents a deal list from nothing is exactly where they surface uncaught.
	const filler = /\b[Xx]{4,}\b|\bN{4,}\b|\bplaceholders?\b|\b(?:PAIR|BASE|QUOTE|SYMBOL|COIN|TOKEN|TICKER)_(?:QUOTE|USD|PAIR|SYMBOL|BASE|COIN)\b/g;
	let flagged = false;
	while ((m = filler.exec(answer)) !== null) { flagged = true; if (m[0].length && redact.indexOf(m[0]) === -1) { redact.push(m[0]); } }

	// Angle-bracket or square-bracket slots (<deal_id>, [amount]) — judged only when there IS tool data this
	// turn, so an illustrative bracket in a pure concept answer ("take profit is [percent] above…") is left
	// alone. Excludes the notes the pipeline itself adds ("[unverified id]", "[unavailable]").
	if (ctx.sourcesText) {
		const slot = /<[a-z][a-z0-9_ ]{1,24}>|\[(?!unverified|unavailable)[a-z][a-z0-9_ ]{1,24}\]/gi;
		while ((m = slot.exec(answer)) !== null) { if (redact.indexOf(m[0]) === -1) { redact.push(m[0]); } }
	}

	if (!redact.length && !flagged) { return null; }
	return { severity: 'redact', detail: 'answer contains template placeholder(s): ' + redact.join(', '), redact: redact };
});


// 3) no_currency_sum — profit/value figures in DIFFERENT quote currencies are not
//    comparable and must never be added into one total. The data layer already refuses
//    to do this: whenever open or completed deals span multiple quote currencies it sets
//    total_profit/total to null, fills a per-currency breakdown, and attaches a note
//    saying so. This axiom enforces the same rule on the ANSWER: when the sources carry
//    that multi-currency signal, an answer that still presents a single aggregate money
//    figure ("a total profit of $1,234", "totaling $5,000") is contradicting the data
//    and is caveated. Keyed strictly on the data's own multi-currency signal, so a
//    normal single-currency total is never touched.
register('no_currency_sum', function (ctx) {

	const src = String(ctx.sourcesText || '');
	if (!src) { return null; }

	const multiCurrency = /multiple quote currenc/i.test(src) || /"profit_by_currency"/.test(src) || /"unrealizedByCurrency"/.test(src) || /"deployed_by_currency"/.test(src);
	if (!multiCurrency) { return null; }

	const answer = String(ctx.answer || '');
	// A single aggregate money claim: "total … <currency><amount>" or "<currency><amount> … total".
	const aggregate = new RegExp('\\b(?:total|combined|overall|altogether|sum(?:ming)?|added up)\\b[^.\\n]{0,40}?' + CURRENCY + '\\s?-?\\d', 'i');
	const aggregateRev = new RegExp(CURRENCY + '\\s?-?[\\d,]+(?:\\.\\d+)?[^.\\n]{0,25}?\\b(?:in total|combined|overall|altogether)\\b', 'i');
	if (aggregate.test(answer) || aggregateRev.test(answer)) {
		return { severity: 'caveat', detail: 'answer sums a single money total while the data spans multiple quote currencies' };
	}

	return null;
});


// 4) impossible_percentage — a win/success rate is a share of a whole and can never exceed
//    100%. The grounding check can't catch this: a model that computes the rate wrongly
//    from real wins/losses prints a number that never appears in the sources as such, but
//    it can also land on an out-of-range value the check reads as just another figure. This
//    axiom asserts the mathematical bound directly, in either word order ("win rate of 150%"
//    or "150% win rate"). It is deliberately narrow — only rates explicitly labeled win or
//    success rate — so an ordinary percentage (a return, a deviation, a drawdown) is untouched.
register('impossible_percentage', function (ctx) {

	const answer = String(ctx.answer || '');
	if (!answer) { return null; }

	const patterns = [
		/\b(?:win|success)\s*rate\b[^.\n]{0,25}?(\d{1,3}(?:\.\d+)?)\s*%/gi,
		/\b(\d{1,3}(?:\.\d+)?)\s*%\s+(?:win|success)\s*rate\b/gi
	];
	for (let p = 0; p < patterns.length; p++) {
		let m;
		while ((m = patterns[p].exec(answer)) !== null) {
			const v = Number(m[1]);
			if (Number.isFinite(v) && v > 100) {
				return { severity: 'caveat', detail: 'answer states an impossible ' + v + '% win rate' };
			}
		}
	}

	return null;
});


// The authoritative best/worst deal the open-deal tools already computed: parse the entity out of a
// `"biggest_gain": { "dealId": …, "pair": … }` (or biggest_loss) object in the sources. Returns
// { dealId, pair } or null. Kept tolerant of key spacing/order.
function rankEntity(src, field) {
	const m = new RegExp('"' + field + '"\\s*:\\s*\\{([\\s\\S]{0,400}?)\\}').exec(src || '');
	if (!m) { return null; }
	const idM = /"dealId"\s*:\s*"([^"]+)"/.exec(m[1]);
	const pairM = /"pair"\s*:\s*"([^"]+)"/.exec(m[1]);
	if (!idM && !pairM) { return null; }
	return { dealId: idM ? idM[1] : null, pair: pairM ? pairM[1] : null };
}

// 5) ranking_consistency — the open-deal tools compute the authoritative best (`biggest_gain`) and worst
//    (`biggest_loss`) deal. A weak model re-scanning the list sometimes names the SAME deal as both the
//    best and the worst, or pins the "worst" label on the deal the data says is the biggest GAINER (and
//    vice versa). When the sources report two DISTINCT best/worst deals, the answer must not contradict
//    that. Deterministic — it reuses the ranking the tool already computed, which the verification
//    research favors over expensive self-consistency sampling for a constrained pick like this. Caveat
//    only (the model's surrounding prose may still be useful); never fires when the data itself makes the
//    best and worst the same single deal.
register('ranking_consistency', function (ctx) {

	const src = String(ctx.sourcesText || '');
	const answer = String(ctx.answer || '');
	if (!src || !answer) { return null; }

	const gain = rankEntity(src, 'biggest_gain');
	const loss = rankEntity(src, 'biggest_loss');
	if (!gain || !loss) { return null; }

	// Nothing to contradict if the data's own best and worst are the same deal.
	const gainKey = gain.dealId || gain.pair;
	const lossKey = loss.dealId || loss.pair;
	if (!gainKey || !lossKey || gainKey === lossKey) { return null; }

	const BEST = /\b(best|biggest gain|highest gain|top perform\w*|doing (?:the )?best|greatest gain|best[- ]perform\w*|most profitable open)\b/i;
	const WORST = /\b(worst|biggest loss|largest loss|furthest underwater|deepest underwater|doing (?:the )?worst|most underwater|biggest los\w*|greatest loss)\b/i;

	// Classify each SENTENCE as best-only, worst-only, or mixed. A sentence that mentions BOTH
	// superlatives ("X is best and Y is worst") is skipped as ambiguous — position alone can't reliably
	// tell which entity each label belongs to there, so it is never risked as a false positive. Only the
	// unambiguous single-label sentences drive the check.
	const bestEnts = new Set();   // entities named in a best-only sentence
	const worstEnts = new Set();  // entities named in a worst-only sentence
	for (const s of answer.split(/(?<=[.!?\n])/)) {
		const hasBest = BEST.test(s), hasWorst = WORST.test(s);
		if (hasBest === hasWorst) { continue; }   // neither, or both (ambiguous) → skip
		const ent = extractEntities(s);
		const named = ent.dealIds.concat(ent.pairs);
		named.forEach(e => (hasBest ? bestEnts : worstEnts).add(e));
	}

	// A) the SAME deal named as both best (in one sentence) and worst (in another).
	for (const e of bestEnts) {
		if (worstEnts.has(e)) {
			return { severity: 'caveat', detail: 'answer names the same deal (' + e + ') as both best and worst, but the data reports different deals' };
		}
	}
	// B) a "worst" sentence names the deal the data says is the biggest GAINER (or a "best" sentence names
	//    the biggest LOSER) — the exact best/worst confusion, checked against the tool's own ranking.
	for (const e of worstEnts) {
		if (e === gain.dealId || e === gain.pair) {
			return { severity: 'caveat', detail: 'answer labels the biggest gainer (' + e + ') as the worst deal' };
		}
	}
	for (const e of bestEnts) {
		if (e === loss.dealId || e === loss.pair) {
			return { severity: 'caveat', detail: 'answer labels the biggest loser (' + e + ') as the best deal' };
		}
	}

	return null;
});


// 7) profit_state_count — the open-deal tools now report how many open deals are in profit
//    (`open_deals_in_profit`) and underwater (`open_deals_underwater`). A weak model still sometimes
//    mis-reads these ("16 open deals in profit" when the field says 0). The answer must never claim MORE
//    deals in a state than the authoritative count for it — a subset can't exceed the reported size. Fires
//    only on that impossible over-claim (caveat), so a correct or smaller subset is never flagged.
register('profit_state_count', function (ctx) {

	const answer = String(ctx.answer || '');
	if (!answer) { return null; }

	const specs = [
		{ field: 'open_deals_in_profit', re: /\b(\d{1,4})\b[^.\n]{0,45}?\b(?:deals?|positions?)\b[^.\n]{0,20}?\bin\s+profit\b/i, phrase: 'in profit' },
		{ field: 'open_deals_underwater', re: /\b(\d{1,4})\b[^.\n]{0,45}?\b(?:deals?|positions?)\b[^.\n]{0,20}?\b(?:underwater|in the red)\b/i, phrase: 'underwater' }
	];

	for (let i = 0; i < specs.length; i++) {
		const totals = sourceNumbers(ctx.sourcesText, specs[i].field);
		if (totals.length !== 1) { continue; }
		const truth = totals[0];
		if (!Number.isFinite(truth)) { continue; }
		const m = specs[i].re.exec(answer);
		if (!m) { continue; }
		const n = Number(m[1]);
		if (Number.isFinite(n) && n > truth) {
			return { severity: 'caveat', detail: 'answer claims ' + n + ' deals ' + specs[i].phrase + ' but the data reports ' + truth };
		}
	}

	return null;
});


// Trim a computed result to a readable number: round to 6 significant decimals and drop trailing zeros,
// so 1.5^4 renders as 5.0625, not 5.062500000001.
function tidyNumber(n) {
	if (!Number.isFinite(n)) { return null; }
	let s = (Math.round(n * 1e6) / 1e6).toString();
	if (s.indexOf('.') !== -1) { s = s.replace(/0+$/, '').replace(/\.$/, ''); }
	return s;
}

// 6) arithmetic_consistency — verify a piece of arithmetic the answer states OUT LOUD and correct a wrong
//    result in place. A weak local model often states the right METHOD ("1.5 to the power of 4") but then
//    computes it wrong in its head ("= 3.375" instead of 5.0625), and does not reliably reach for the
//    calculate tool. Because the operation is stated explicitly we can recompute it deterministically and
//    fix only the result. Scoped to a single unambiguous operation (power or product) with an explicit
//    stated result, and only corrects a GROSS error (well beyond rounding), so a legitimately rounded
//    figure ("1.05^4 ≈ 1.2155") is never touched and ordinary prose numbers are ignored.
register('arithmetic_consistency', function (ctx) {

	const answer = String(ctx.answer || '');
	if (!answer) { return null; }

	const num = '(-?\\d+(?:\\.\\d+)?)';
	const result = '\\s*(?:is|=|equals|comes to|gives|would be|becomes|:)\\s*' + num;
	const patterns = [
		{ op: 'pow', re: new RegExp(num + '\\s*(?:\\^|\\*\\*|to the power of|raised to the power(?:\\s+of)?)\\s*' + num + result, 'i') },
		{ op: 'mul', re: new RegExp(num + '\\s*(?:\\*|×|times|multiplied by)\\s*' + num + result, 'i') }
	];

	for (let i = 0; i < patterns.length; i++) {
		const m = patterns[i].re.exec(answer);
		if (!m) { continue; }
		const a = Number(m[1]), b = Number(m[2]), claimed = Number(m[3]);
		if (![ a, b, claimed ].every(Number.isFinite)) { continue; }

		const real = patterns[i].op === 'pow' ? Math.pow(a, b) : (a * b);
		if (!Number.isFinite(real)) { continue; }

		// Correct only a gross error — relative error over 1% and an absolute gap over 0.001 — so a valid
		// rounding of the true value is left as the model wrote it.
		const denom = Math.abs(real) > 1e-9 ? Math.abs(real) : 1;
		if (Math.abs(real - claimed) / denom <= 0.01 || Math.abs(real - claimed) <= 0.001) { continue; }

		const fixed = tidyNumber(real);
		if (fixed == null) { continue; }
		// Replace the claimed result token within the exact matched span (not globally) so only this
		// figure is changed.
		const corrected = m[0].replace(new RegExp('(' + result + ')$'), (whole) => whole.replace(String(m[3]), fixed));
		return {
			severity: 'correct',
			detail: 'answer computes ' + a + (patterns[i].op === 'pow' ? '^' : '×') + b + ' as ' + claimed + ' but it is ' + fixed,
			correct: { find: m[0], replace: corrected }
		};
	}

	return null;
});


module.exports = { register, list, evaluate };