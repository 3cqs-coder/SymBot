/*
 * AddFundsMath — the forward add-funds calculation, extracted as a pure,
 * dependency-free function so there is ONE source of truth shared by:
 *   - the server (estimateFunds in DCABot.js calls it), and
 *   - the client (the Add Funds Estimator bar receives this function via EJS
 *     and runs the identical code for realtime what-if estimates).
 *
 * "Forward" = given an amount to add (and the price it fills at), compute the
 * resulting average price, target price, break-even, and the deltas. This is
 * the same net/gross average + target math estimateFunds already used; it is
 * simply parameterized on the fill price so the calculator can ask "what if I
 * add $X at price P" instead of assuming the current market price.
 *
 * Pure: no requires, no shareData, no server-only helpers — safe to stringify
 * and run in the browser. Rounding/precision that used to be applied around
 * the math (e.g. Common.adjustDecimals) is intentionally NOT baked in here; the
 * caller applies display precision after, so the shared core stays portable.
 *
 * PROJECTED PROFIT % (added 2026-08-08): optionally computes where the deal's
 * live Profit % column would move to if the add happened. This is the number
 * the estimator shows under the Profit % column. It MUST reconcile exactly with
 * the server-side calculateProfit() that drives that column, so it is built to
 * be self-calibrating and basis-anchored rather than re-deriving fee/slippage:
 *
 *   - calculateProfit does:  profit% = ((market - avg)/avg)*100 - fee - slippage
 *     where avg is the deal's REAL currentOrder.average (fee-inflated running
 *     basis) and (fee + slippage) is a server-only combined deduction.
 *   - We are given the row's actual current profit% (the column value) and its
 *     real current average. From those we back-solve the EXACT combined
 *     deduction the server used:  deduction = ((market-avg)/avg)*100 - profit%.
 *     This reproduces the column's fee+slippage without needing either value,
 *     and cannot drift from it.
 *   - The projected NEW average used for the profit projection is anchored to
 *     that same real average by reconstructing the basis sum as
 *     (currentAverageReal * qtySum), so at fill = market with no size change the
 *     projection reproduces the current column value to the penny. (The
 *     avg/target projection fields above keep using the caller-supplied sum for
 *     backward-compatible display; only the profit projection is basis-anchored,
 *     because only it sits next to a real-money number and must tie out.)
 *
 * Inputs for the projection are OPTIONAL. When currentAverageReal or
 * currentProfitPercent is absent/non-finite, projected_profit_valid stays false
 * and every other field is byte-identical to the pre-2026-08-08 behavior.
 */

function computeAddFundsForward(params) {

	const sumFloat        = parseFloat(params.sum);              // current invested (quote)
	const qtySumFloat     = parseFloat(params.qtySum);           // current base qty held
	const addAmount       = parseFloat(params.addAmount);        // gross quote to add
	const exchangeFee     = parseFloat(params.exchangeFee);      // percent, e.g. 0.25
	const targetProfitPct = parseFloat(params.targetProfitPercent);

	// OPTIONAL projected-profit inputs (see header). marketPrice defaults to the
	// current market price (params.price) when not given explicitly. The other
	// two are the deal's REAL current average and its live column profit %; when
	// either is missing the projection is skipped and left invalid.
	const marketPrice           = parseFloat(params.marketPrice !== undefined ? params.marketPrice : params.price);
	const currentAverageReal    = parseFloat(params.currentAverageReal);
	const currentProfitPercent  = parseFloat(params.currentProfitPercent);

	// Fill price for the hypothetical add. Defaults to current market price when
	// no explicit addPrice is supplied (blank override = "add at market").
	let fillPrice = parseFloat(params.addPrice);

	if (!isFinite(fillPrice) || fillPrice <= 0) {

		fillPrice = parseFloat(params.price);
	}

	// Round-trip fee (buy + sell => fee applied twice) — used below for the fee TOTAL and the break-even
	// price, both of which span a full buy-then-sell cycle. The take-profit TARGET applies a SINGLE fee
	// instead (matching the live engine's calculateTargetPrice), so the two are computed separately.
	const totalFeeRate = (exchangeFee / 100) * 2;

	const result = {
		valid: false,
		add_amount_gross: 0,
		add_amount_net: 0,
		exchange_fee_total: 0,
		fill_price: isFinite(fillPrice) ? fillPrice : 0,
		average_price_current: 0,
		average_price_net: 0,
		average_price_gross: 0,
		target_price_net: 0,
		target_price_gross: 0,
		break_even_net: 0,
		average_price_change_percent: 0,
		target_price_change_percent: 0,
		// Projected current profit % at market after the add (see header). Stays
		// invalid/zero unless the optional projection inputs are supplied.
		projected_profit_valid: false,
		projected_profit_percent: 0,
		projected_profit_change_percent: 0
	};

	// Guard against bad/empty inputs so the client bar never shows NaN.
	if (!isFinite(sumFloat) || !isFinite(qtySumFloat) || qtySumFloat <= 0 ||
		!isFinite(addAmount) || addAmount <= 0 || !isFinite(fillPrice) || fillPrice <= 0) {

		return result;
	}

	const currentAvg = sumFloat / qtySumFloat;

	// Split the gross add into net + fee (same rounding approach as estimateFunds).
	let amountWithFees = addAmount;
	let totalFee = amountWithFees * totalFeeRate;

	amountWithFees = Math.round((amountWithFees + Number.EPSILON) * 100) / 100;
	totalFee = Math.round((totalFee + Number.EPSILON) * 100) / 100;

	const amountWithoutFees = Math.round((amountWithFees - totalFee + Number.EPSILON) * 100) / 100;

	// New average price (net-based) — qty acquired uses the fill price.
	const addedQty_net = amountWithoutFees / fillPrice;
	const newQtySum_net = qtySumFloat + addedQty_net;
	const newSum_net = sumFloat + amountWithoutFees;
	const avgPrice_net = newQtySum_net > 0 ? newSum_net / newQtySum_net : 0;

	// New average price (gross-based).
	const addedQty_gross = amountWithFees / fillPrice;
	const newQtySum_gross = qtySumFloat + addedQty_gross;
	const newSum_gross = sumFloat + amountWithFees;
	const avgPrice_gross = newQtySum_gross > 0 ? newSum_gross / newQtySum_gross : 0;

	// New target price = new average x (1 + ONE fee + desired profit). A SINGLE fee, to match where the
	// deal ACTUALLY targets: the live ladder's calculateTargetPrice uses (takeProfit + one fee), which is
	// consistent with the calculateProfit model (profit% deducts one combined fee+slippage). Using the
	// round-trip 2x fee here made the projected target read ~fee% higher than the deal really closes at.
	// (Break-even below correctly keeps the round-trip 2x fee — recovering cost needs both buy and sell.)
	const targetMultiplier = 1 + (exchangeFee / 100) + (targetProfitPct / 100);
	const newTargetPrice_net = avgPrice_net * targetMultiplier;
	const newTargetPrice_gross = avgPrice_gross * targetMultiplier;

	// Break-even (net): price at which the position recovers cost incl. fees.
	const breakEven_net = avgPrice_net * (1 + totalFeeRate);

	// Deltas vs current (positive = improvement: average lowered, target lowered).
	let avgChangePercent = 0;
	let targetChangePercent = 0;

	if (currentAvg > 0) {

		avgChangePercent = ((currentAvg - avgPrice_net) / currentAvg) * 100;
	}

	const currentTarget = currentAvg * targetMultiplier;

	if (currentTarget > 0) {

		targetChangePercent = ((currentTarget - newTargetPrice_net) / currentTarget) * 100;
	}

	// ---- Projected current profit % after the add (optional, basis-anchored) ----
	// Only computed when we have the deal's real average and its live profit %.
	// Uses the SAME net-fill quantity math as the average projection, but anchors
	// the basis to the real average so it reconciles with the profit column.
	let projectedProfitValid = false;
	let projectedProfitPercent = 0;
	let projectedProfitChangePercent = 0;

	if (isFinite(currentAverageReal) && currentAverageReal > 0 &&
		isFinite(currentProfitPercent) &&
		isFinite(marketPrice) && marketPrice > 0) {

		// Reconstruct the real basis sum from the real average and the held qty,
		// so the projection's "current average" == the column's average exactly.
		const realSum = currentAverageReal * qtySumFloat;

		// New average on the REAL basis using the same net add + fill-price qty.
		const newQtySum_real = qtySumFloat + addedQty_net;
		const newSum_real = realSum + amountWithoutFees;
		const newAvg_real = newQtySum_real > 0 ? newSum_real / newQtySum_real : 0;

		if (newAvg_real > 0) {

			// Back-solve the exact combined deduction (fee + slippage) the server
			// applied, straight from the row's own numbers — cannot drift from the
			// column: deduction = rawProfitAtRealAvg - reportedProfit.
			const rawProfitCurrent = ((marketPrice - currentAverageReal) / currentAverageReal) * 100;
			const combinedDeduction = rawProfitCurrent - currentProfitPercent;

			// Projected profit % at current market against the new real average,
			// with the identical deduction applied. Mirrors calculateProfit.
			const rawProfitNew = ((marketPrice - newAvg_real) / newAvg_real) * 100;

			projectedProfitPercent = rawProfitNew - combinedDeduction;
			projectedProfitChangePercent = projectedProfitPercent - currentProfitPercent;
			projectedProfitValid = true;
		}
	}

	result.valid = true;
	result.add_amount_gross = amountWithFees;
	result.add_amount_net = amountWithoutFees;
	result.exchange_fee_total = totalFee;
	result.average_price_current = currentAvg;
	result.average_price_net = avgPrice_net;
	result.average_price_gross = avgPrice_gross;
	result.target_price_net = newTargetPrice_net;
	result.target_price_gross = newTargetPrice_gross;
	result.break_even_net = breakEven_net;
	result.average_price_change_percent = avgChangePercent;
	result.target_price_change_percent = targetChangePercent;
	result.projected_profit_valid = projectedProfitValid;
	result.projected_profit_percent = projectedProfitPercent;
	result.projected_profit_change_percent = projectedProfitChangePercent;

	return result;
}


// Export for the server (require). The client receives the function body via EJS
// (getAddFundsForward.toString()) and rebuilds it — see the estimator bar.
if (typeof module !== 'undefined' && module.exports) {

	module.exports = { computeAddFundsForward };
}