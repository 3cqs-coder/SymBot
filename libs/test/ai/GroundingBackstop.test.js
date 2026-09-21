'use strict';

// Fail-closed grounding backstop, exercised through the real answer funnel (AIClient.finalizeAnswer).
//
// Generalizes the fabricated-deal-id backstop to trading PAIRS: a single off-result pair may be a legitimate
// example alongside grounded data (soft caveat), but SEVERAL pairs that are all absent from this turn's tool
// data is a fabricated position ENUMERATION — the "list my deals" answer inventing positions the user does
// not hold — and must be REPLACED wholesale, never shipped under a caveat. This is the defense-in-depth net
// behind the deterministic renderer: even if the weak model is reached and fabricates, the invented list
// never renders.

const assert = require('assert');
const AIClient = require('../../ai/AIClient.js');
const f = AIClient.finalizeAnswer;

let passed = 0;
function ok(cond, label) { assert.ok(cond, label); passed++; }

// Real tool data for this turn: the user holds ONLY ATOM/USD and TON/USD.
const sources = JSON.stringify({ closest_to_take_profit: [ { pair: 'ATOM/USD' }, { pair: 'TON/USD' } ] });

// A fabricated enumeration of positions the user does not hold (the exact failure that was observed).
const fabricated = [
	'1. XLM/USD — underwater, unrealized P/L -0.56',
	'2. LINK/USD — underwater, unrealized P/L -0.31',
	'3. EOS/USD — underwater',
	'4. BAT/USD — underwater',
	'5. XRP/USD — underwater',
	'6. DASH/USD — underwater',
	'7. LTC/USD — underwater'
].join('\n');

const outFab = f(fabricated, sources, 'tell me more', '', {});
ok(/won't guess|list your open deals/i.test(outFab), 'a fabricated enumeration of unheld pairs is replaced wholesale (fail-closed)');
ok(!/XLM\/USD|LINK\/USD|EOS\/USD/.test(outFab), 'none of the invented pairs survive into the shown answer');

// A single off-result pair alongside real, grounded data is a possible example — kept, with a soft caveat only.
const oneOff = 'Your ATOM/USD deal is underwater; a BTC/USD position would behave differently.';
const outOne = f(oneOff, sources, 'how is my atom deal', '', {});
ok(/ATOM\/USD/.test(outOne) && !/won't guess/i.test(outOne), 'a single off-result pair is NOT replaced (may be a legitimate example)');

// Two off-result pairs (a comparison) stay under the soft threshold and are not nuked.
const twoOff = 'Compared with BTC/USD and ETH/USD, your ATOM/USD deal is only slightly underwater.';
const outTwo = f(twoOff, sources, 'how is my atom deal', '', {});
ok(/ATOM\/USD/.test(outTwo) && !/won't guess/i.test(outTwo), 'two off-result pairs (a comparison) are not replaced');

// An answer whose pairs are ALL in the tool data is untouched (no false positive, no caveat).
const grounded = 'Your ATOM/USD and TON/USD deals are both underwater.';
const outGood = f(grounded, sources, 'how are my deals', '', {});
ok(/ATOM\/USD/.test(outGood) && /TON\/USD/.test(outGood) && !/won't guess/i.test(outGood), 'a fully grounded answer is left intact');

// ── Fail-closed on a materially-unsupported DATA answer (abstain, don't ship under a ⚠️ caveat) ──────────
// PRODUCTION REGRESSION: "hows my deals" reached the model, which stated the real total then INVENTED the
// specifics (a biggest-loss figure, a price) and shipped them under a "⚠️ may not be fully supported" caveat.
// For a question that REQUIRES live data, a materially-unsupported answer must ABSTAIN instead of caveating.
const numSources = JSON.stringify({ total_unrealized_pnl: -2585.81, closest_to_take_profit: [ { pair: 'ATOM/USD', currentPrice: 1.05 } ] });
const abst = /won't guess|couldn'?t pull/i;

// Two significant figures the tool data never returned → material fabrication → abstain.
const fabFigures = 'Your total unrealized P/L is -2585.81. The biggest loss deal is down 1234.56 and its price is 0.098765.';
const outFabFig = f(fabFigures, numSources, 'what is my unrealized p/l on my open deals', '', {});
ok(abst.test(outFabFig), 'a data answer with 2+ ungrounded figures abstains rather than shipping under a caveat');
ok(!/1234\.56|0\.098765/.test(outFabFig), 'the invented figures do not survive into the shown answer');

// A fabricated deal id (redacted to [unverified id] because tool data is present) → abstain wholesale.
const idSources = JSON.stringify({ closest_to_take_profit: [ { pair: 'ATOM/USD', dealId: 'ATOM_USD-REAL123-1760000010' } ] });
const fabId = 'Your deal FAKE_USD-ZZZ999-1799999999 is deep underwater right now.';
const outFabId = f(fabId, idSources, 'how are my deals doing', '', {});
ok(abst.test(outFabId), 'a data answer naming a fabricated deal id abstains instead of shipping "[unverified id]" under a caveat');
ok(!/\[unverified id\]|FAKE_USD/.test(outFabId), 'neither the fabricated id nor its redaction marker survives');

// ── The gate must NOT suppress good answers (no over-abstention) ─────────────────────────────────────────
// A fully grounded data answer — every significant figure is in the tool data — is emitted normally.
const groundedFig = 'Your total unrealized P/L is -2585.81 right now.';
const outGroundedFig = f(groundedFig, numSources, 'how are my deals', '', {});
ok(/2585\.81/.test(outGroundedFig) && !abst.test(outGroundedFig), 'a fully grounded data answer is emitted, never abstained');

// A single DERIVED/rounded figure (one ungrounded number among grounded ones) keeps the soft caveat — it can
// be a correct computation off the real values — and is NOT escalated to an abstention.
const oneDerived = 'Your total unrealized P/L is -2585.81, about 4.2% of your book.';
const outOneDerived = f(oneDerived, numSources, 'how are my deals', '', {});
ok(/2585\.81/.test(outOneDerived) && !abst.test(outOneDerived), 'a single derived figure keeps the caveat, not an abstention');

// A CONCEPT/definitional question (requiresGrounding=false) with an incidental ungrounded figure is NOT a
// data lookup, so it keeps the softer caveat rather than being abstained on.
const conceptAns = 'Unrealized P/L is the paper gain or loss on an open position — for example a deal down 1234.56 has not been realized yet.';
const outConcept = f(conceptAns, numSources, 'what does unrealized p/l mean', '', {});
ok(!abst.test(outConcept), 'a concept question is never fail-closed abstained (keeps the softer caveat)');

// A TRUSTED deterministic render is grounded by construction and exempt, even if a figure is not literally in
// the passed sources (e.g. a summary line the renderer composed).
const trustedAns = 'You have 45 open deals — total unrealized P/L 9999.99.';
const outTrusted = f(trustedAns, numSources, 'how are my deals', '', { trusted: true });
ok(!abst.test(outTrusted), 'a trusted deterministic render is never fail-closed abstained');

console.log('GroundingBackstop: ' + passed + ' assertions passed');