'use strict';

/**
 * SymBot.UI — shared client-side utilities
 * Included via partialsHeaderView.ejs, available in all Hub and instance views.
 */
const SymBot = window.SymBot || {};

SymBot.UI = {

	/**
	 * Returns true if any jquery-confirm dialog or jQuery UI dialog is currently open.
	 * Used to pause auto-refresh while the user is interacting with a dialog.
	 */
	isDialogOpen: function() {

		return $('.jconfirm').length > 0 || $('.ui-dialog:visible').length > 0;
	},


	/**
	 * Turn a failed jQuery AJAX jqXHR into a clean, human-readable message instead of dumping the
	 * raw object. Maps common statuses (403/401/429) to friendly text and otherwise prefers the
	 * server's { error } / { data } message. Pass a context-specific `fallback` for the generic case.
	 */
	ajaxError: function(jqXHR, fallback) {

		let msg = fallback || 'Something went wrong. Please try again.';

		try {
			let body = jqXHR && jqXHR.responseJSON;
			if (!body && jqXHR && jqXHR.responseText) { try { body = JSON.parse(jqXHR.responseText); } catch (e) {} }
			const serverMsg = body && (body.error || body.data);

			if (jqXHR && jqXHR.status === 403) { msg = 'You don\'t have permission to make this change.'; }
			else if (jqXHR && jqXHR.status === 401) { msg = 'Your session has expired — please sign in again.'; }
			else if (jqXHR && jqXHR.status === 429) { msg = 'Too many requests — please wait a moment and try again.'; }
			else if (serverMsg) { msg = String(serverMsg); }
		}
		catch (e) {}

		return msg;
	},


	/**
	 * Wires up the column selector toggle button.
	 * Call once after DOM ready in any view that uses the botDealSelectorWrapper.
	 */
	initColumnSelector: function() {

		$('#botDealSelectorShow').click(function() {

			$('.botDealSelectorWrapper').toggleClass('is-visible');
		});
	},


	/**
	 * Applies rounded top corners to the first/last VISIBLE header cell of a
	 * tablesorter table. Needed because the column selector hides columns via an
	 * injected `nth-child(){display:none}` stylesheet rule — the hidden cell stays
	 * :first-child/:last-child in the DOM, so a plain CSS :first-child/:last-child
	 * corner would cling to a hidden column and the visible end column would render
	 * square. Call once after tablesorter init, and bind it to the table's
	 * `columnUpdate` event so it re-runs whenever the column selection changes.
	 * @param {string} tableSelector - e.g. '#botsDeals', '#hubDeals', '#hubBots'
	 */
	updateHeaderCorners: function(tableSelector) {

		const $ths = $(tableSelector + ' thead tr').first().children('th');
		if (!$ths.length) { return; }

		$ths.removeClass('th-round-left th-round-right');

		const $visible = $ths.filter(':visible');
		if (!$visible.length) { return; }

		$visible.first().addClass('th-round-left');
		$visible.last().addClass('th-round-right');
	},


	/**
	 * Convenience: bind updateHeaderCorners to a table's columnUpdate event and
	 * run it now (plus once shortly after, to catch late layout/sticky-clone).
	 * @param {string} tableSelector
	 */
	initHeaderCorners: function(tableSelector) {

		const self = this;

		$(tableSelector).on('columnUpdate', function() { self.updateHeaderCorners(tableSelector); });
		self.updateHeaderCorners(tableSelector);
		setTimeout(function() { self.updateHeaderCorners(tableSelector); }, 200);
	},


	/**
	 * At-a-glance health assessment for an active deal, derived purely from live
	 * state (no user input). Shared by the instance and Hub active-deal views so
	 * there is one definition of what each glyph means.
	 * Precedence: error/paused first, then profit, then how deep the deal is into
	 * its safety-order budget.
	 * @param {object} opts - { profitPerc, soUsed, soMax, hasError, isPaused }
	 * @returns {object} { type, cls, label, rank }  (higher rank = needs more attention)
	 *   type: 'dot' (a colored status dot) or 'glyph' (paused/error symbol)
	 *   cls:  the CSS modifier class for the span
	 */
	dealHealth: function(opts) {

		opts = opts || {};

		const profitPerc = Number(opts.profitPerc);
		const soUsed = Number(opts.soUsed) || 0;
		const soMax = Number(opts.soMax) || 0;
		const hasError = !!opts.hasError;
		const isPaused = !!opts.isPaused;

		if (hasError) { return { type: 'glyph', cls: 'dh-error',  label: 'Error — check logs', rank: 5 }; }
		if (isPaused) { return { type: 'glyph', cls: 'dh-paused', label: 'Paused', rank: 4 }; }

		// A just-resumed deal whose live figures have not arrived yet (the first price tick is still pending
		// after a restart). Neutral dot + honest tooltip, so it never shows a red/green health it can't know.
		if (opts.awaiting) { return { type: 'dot', cls: 'dh-pending', label: 'Connecting — live figures updating', rank: 0 }; }

		// In profit: healthy.
		if (profitPerc > 0) { return { type: 'dot', cls: 'dh-green', label: 'In profit (' + profitPerc + '%)', rank: 0 }; }

		// Underwater — grade by how much of the safety-order budget is consumed.
		const soFrac = soMax > 0 ? (soUsed / soMax) : 0;

		if (soFrac >= 0.75) { return { type: 'dot', cls: 'dh-red',    label: 'Stressed — ' + soUsed + '/' + soMax + ' safety orders used, down ' + profitPerc + '%', rank: 3 }; }
		if (soFrac >= 0.4)  { return { type: 'dot', cls: 'dh-orange', label: 'Working — ' + soUsed + '/' + soMax + ' safety orders used, down ' + profitPerc + '%', rank: 2 }; }

		return { type: 'dot', cls: 'dh-yellow', label: 'Watching — down ' + profitPerc + '%', rank: 1 };
	},


	/**
	 * Builds the full Health <td> cell (glyph + tooltip + sort rank) for a deal
	 * row, so instance and Hub views render an identical cell. Pass the same opts
	 * as dealHealth().
	 * @param {object} opts
	 * @returns {string} HTML for a single <td>
	 */
	dealHealthCell: function(opts) {

		const h = this.dealHealth(opts);
		const title = h.label.replace(/"/g, '&quot;');

		// A colored dot for the four running states; a styled glyph for
		// paused/error. Both use the same sized slot so the column reads as one
		// coherent system. Colors are theme-aware via CSS (see style.css) so they
		// stay legible and un-harsh in light mode — the old emoji couldn't be tuned.
		const inner = (h.type === 'glyph')
			? '<span class="deal-health-glyph ' + h.cls + '"></span>'
			: '<span class="deal-health-dot ' + h.cls + '"></span>';

		return '<td class="deal-health-cell" data-health-rank="' + h.rank + '" title="' + title + '"><span class="deal-health">' + inner + '</span></td>';
	},


	/**
	 * Stop-loss annotation appended inside the Target cell (#104a): the effective stop level, with a
	 * lock glyph once the stop has moved to break-even and an up-triangle while it is trailing. Returns
	 * '' when stop-loss is off or has no price, so callers can concatenate unconditionally. Single source
	 * for both the instance and Hub deals views. `notation` is the page's convertNotation formatter
	 * (passed in, since it lives in the header partial's scope), falling back to a global if present.
	 * @param {object} dealInfo  deal['info']
	 * @param {string} dealSym   currency symbol for the pair
	 * @param {function} [notation]
	 * @returns {string}
	 */
	stopLossCell: function(dealInfo, dealSym, notation) {

		if (!dealInfo || !dealInfo['stop_loss_enabled'] || !(Number(dealInfo['stop_loss_price']) > 0)) { return ''; }

		var fmt = (typeof notation === 'function')
			? notation
			: ((typeof convertNotation === 'function') ? convertNotation : function(v) { return v; });

		var armed    = dealInfo['stop_loss_armed'];
		var trailing = dealInfo['stop_loss_trailing'];
		var title    = trailing ? 'Trailing stop level' : ('Stop-loss level' + (armed ? ' (moved to break-even)' : ''));
		var glyph    = trailing ? ' &#9650;' : (armed ? ' &#128274;' : '');

		return '<br><span class="sl-annot" title="' + title + '">SL ' + dealSym + fmt(dealInfo['stop_loss_price']) + glyph + '</span>';
	},


	/**
	 * A live-only cell value that isn't known yet — a just-resumed deal whose first price tick hasn't
	 * arrived (info.awaiting_live). Returns a subtle "updating…" placeholder when awaiting, otherwise the
	 * ready HTML. Single source so the instance and Hub deals views render pending cells identically, and
	 * never show a stale or fabricated live figure. Opacity keeps it legible in both themes with no new CSS.
	 * @param {boolean} awaiting  deal['info']['awaiting_live']
	 * @param {string} readyHtml  the normal cell HTML to show once the live value is known
	 * @returns {string}
	 */
	pendingCell: function(awaiting, readyHtml) {

		return awaiting ? '<span style="opacity: 0.55;" title="Live figure updating — the exchange is reconnecting">updating&hellip;</span>' : readyHtml;
	},


	// ── Shared deals-view primitives ──────────────────────────────────────────────────────────────
	// Extracted from the (byte-identical) copies in the instance and Hub active-deals views so the two
	// can't drift. Only the truly-common, non-action pieces live here; each view keeps its own action
	// buttons and filter dropdowns, which legitimately differ (the Hub is a trimmed subset).

	// Total capital in a deal = sum of `amount` over its FILLED orders.
	dealVolume: function(orders) {
		return (orders || []).filter(function(o){ return o && o.filled; }).reduce(function(a, o){ return a + Number(o.amount); }, 0);
	},

	// A deal is "stale" when its last-updated time is more than maxMins behind the snapshot time — both
	// views flag these with a "not updating" warning. One definition so the threshold can't diverge.
	isDealStale: function(nowDate, lastUpdated, maxMins) {
		var diffSec = (new Date(nowDate).getTime() - new Date(lastUpdated).getTime()) / 1000;
		return diffSec > (60 * Number(maxMins));
	},

	// The common per-deal state the client dealTracker holds. Both views build on this; the Hub adds its
	// own instanceId / instanceName / pair on top. Single source so the shape stays in lockstep.
	buildDealTrackerEntry: function(deal) {
		return { date: deal.date, info: deal.info, config: deal.config, orders: deal.orders };
	},

	// The disabled "Stop bot" pill shown when a deal's bot is inactive — was copy-pasted verbatim.
	disabledStopButton: function() {
		return '<span class="pill-btn pill-disabled" title="Stop bot (bot inactive)"><span class="icon icon-stop" style="width:13px;height:13px;pointer-events:none;"></span></span>';
	},


	/**
	 * Classify a deal's pauseReason. A "system" pause is one SymBot applied itself (order verification,
	 * a sell error) rather than a manual user pause — the UI tints those rows and warns before a manual
	 * resume. Single source of truth for both the deal list and the pause/resume dialog so a new reason
	 * is recognized everywhere at once.
	 * @param {string} pauseReason
	 * @returns {{ isSystem: boolean, type: string, description: string }}
	 */
	systemPauseInfo: function(pauseReason) {

		const map = {
			'order_verify_buy':    { type: 'buy order',  description: 'a buy order that could not be verified' },
			'buy_error':           { type: 'buy order',  description: 'a buy order error (buys are paused; the deal can still take profit or stop-loss)' },
			'order_verify_sell':   { type: 'sell order', description: 'a sell order that could not be verified' },
			'sell_error':          { type: 'sell order', description: 'a sell order error (it retries automatically)' },
			'sell_finalize_error': { type: 'sell order', description: 'a sell that filled but could not be finalized' }
		};

		const info = map[pauseReason || ''];

		return { isSystem: !!info, type: info ? info.type : '', description: info ? info.description : '' };
	},


	/**
	 * Classify a filled MANUAL ladder rung as a system action or a user action — the order-rung analogue of
	 * systemPauseInfo. A rung the system injected itself (currently an auto-credited partial buy fill) carries
	 * a manualReason; a user Add-Funds rung is manual with no reason. Single source of truth for the order
	 * history display, so a new system order-source is described in one place. Purely descriptive — the flag
	 * is never read by trading/recalculation logic.
	 * @param {object} order
	 * @returns {{ isManual: boolean, isSystem: boolean, label: string, tooltip: string }}
	 */
	systemOrderInfo: function(order) {

		const map = {
			'partial_fill_credit': 'System: a partial buy fill the exchange executed was booked into the deal automatically, and the take-profit recalculated.'
		};

		const manual = !!(order && order['manual']);
		const reason = (order && order['manualReason']) || '';
		const isSystem = manual && !!map[reason];

		return {
			isManual: manual,
			isSystem: isSystem,
			label: !manual ? '' : (isSystem ? 'system' : 'manual'),
			tooltip: !manual ? '' : (map[reason] || 'Manually added funds.')
		};
	},


	/**
	 * Count of USER Add-Funds rungs in a deal's orders — the genuine ADDITIONS beyond the configured max
	 * safety orders, shown as "(+N)". Reuses systemOrderInfo so the distinction lives in ONE place: a user
	 * Add-Funds rung is manual with no system reason and APPENDS a new rung (it extends the max), whereas an
	 * auto partial-fill-credit rung (isSystem) RE-USES an existing safety-order slot and is therefore NOT an
	 * addition — it is already counted in "safety orders used". Shared by the instance and Hub deal lists so
	 * both surfaces show the same "(+N)".
	 * @param {Array} orders
	 * @returns {number}
	 */
	addedFundsCount: function(orders) {

		if (!Array.isArray(orders)) { return 0; }

		return orders.filter(function(o) {

			if (!o || !o.filled) { return false; }

			const info = SymBot.UI.systemOrderInfo(o);
			return info.isManual && !info.isSystem;
		}).length;
	},


	/**
	 * Wrapper around $.confirm with the standard app settings.
	 * @param {object} options - title, content, onConfirm, onCancel, confirmText, cancelText
	 */
	confirmDialog: function(options) {

		const confirmText = options.confirmText || 'Confirm';
		const cancelText  = options.cancelText  || 'Cancel';

		const buttons = {};

		buttons.confirm = {
			btnClass: 'btn-default',
			text: options.confirmText || '<div>Confirm</div>',
			action: options.onConfirm || function() {}
		};

		buttons.cancel = {
			btnClass: 'btn-default',
			text: '<div style="color: #000000;">' + cancelText + '</div>',
			action: options.onCancel || function() {}
		};

		$.confirm({
			title: false,
			boxWidth: '50%',
			useBootstrap: false,
			content: '<div style="font-size: 1.2rem; text-align: left;">' + (options.content || '') + '</div>',
			buttons: buttons,
			onContentReady: options.onContentReady || function() {}
		});
	},


	/**
	 * A "check the box to confirm" dialog — the standard gate for a heavy, mistake-prone action
	 * (shutdown / update / etc.). Consolidates the identical scaffold that was copy-pasted per
	 * action: a required #confirmBox checkbox, a form that submits on Enter, and a Cancel button.
	 * @param {object} options - content (HTML above the checkbox), confirmLabel (bold line beside
	 *   the checkbox), confirmText (submit button HTML), warn (alert when unchecked), onConfirm.
	 */
	confirmWithCheckbox: function(options) {

		const warn = options.warn || 'You must check the box to confirm';
		const onCancel = (typeof options.onCancel === 'function') ? options.onCancel : function() {};

		$.confirm({
			title: false,
			boxWidth: options.boxWidth || '50%',
			useBootstrap: false,
			content: '<div style="font-size: var(--fs-dialog-title); text-align: left;">' + (options.content || '') +
				'<form action="" style="display:inline;"><br><input type="checkbox" id="confirmBox" class="form-field" style="width:20px;" /> <b>' +
				(options.confirmLabel || 'Check the box to confirm') + '</b></form></div>',
			buttons: {
				formSubmit: {
					btnClass: 'btn-default',
					text: options.confirmText || '<div>Confirm</div>',
					action: function() {
						// Keep the dialog open on a missing check: return false so jquery-confirm doesn't close.
						if (!$('#confirmBox').prop('checked')) { alertBox(warn, function() {}); return false; }
						if (typeof options.onConfirm === 'function') { options.onConfirm(); }
					}
				},
				cancel: {
					btnClass: 'btn-default',
					text: '<div style="color:#000000;">Cancel</div>',
					action: onCancel
				}
			},
			onContentReady: function() {
				$('#confirmBox').prop('checked', false);
				const jc = this;
				this.$content.find('form').on('submit', function(e) { e.preventDefault(); jc.$$formSubmit.trigger('click'); });
			}
		});
	},

	/**
	 * Password-confirm dialog: the shared shell for "enter your current password to confirm" actions
	 * (e.g. changing trading mode, saving exchange credentials). Renders the prompt + a password field,
	 * enforces a non-empty entry (keeps the dialog open with a nudge otherwise), then calls
	 * onConfirm(password). The password field is #cwpPassword. options:
	 *   message      string  — the prompt line (default "Enter your current password to confirm:")
	 *   confirmLabel string  — confirm button text (default "Confirm")
	 *   confirmColor string  — 'danger' | 'success' | ... → var(--color-<x>) (default 'success')
	 *   extraHtml    string  — optional extra markup below the field (e.g. an "update bots" checkbox)
	 *   onConfirm    fn(pw)  — required; runs the action with the entered password
	 *   onCancel     fn()    — optional
	 *   boxWidth     string  — optional (default '40%')
	 */
	confirmWithPassword: function(options) {

		options = options || {};

		const onCancel = (typeof options.onCancel === 'function') ? options.onCancel : function() {};
		const color = options.confirmColor || 'success';

		$.confirm({
			title: false,
			boxWidth: options.boxWidth || '40%',
			useBootstrap: false,
			content: '<div style="font-size: var(--fs-dialog-title);">' + (options.message || 'Enter your current password to confirm:') + '</div>' +
				'<br><input type="password" id="cwpPassword" class="form-field" style="width: 250px;" placeholder="Password">' +
				(options.extraHtml || ''),
			buttons: {
				confirm: {
					btnClass: 'btn-default',
					text: '<div style="color: var(--color-' + color + ');">' + (options.confirmLabel || 'Confirm') + '</div>',
					action: function() {
						const pw = $('#cwpPassword').val();
						// Keep the dialog open on a missing password: return false so jquery-confirm doesn't close.
						if (!pw) { alertBox('Please enter your password'); return false; }
						if (typeof options.onConfirm === 'function') { options.onConfirm(pw); }
					}
				},
				cancel: {
					btnClass: 'btn-default',
					text: '<div style="color: #000;">Cancel</div>',
					action: onCancel
				}
			},
			onContentReady: function() { const $i = $('#cwpPassword'); setTimeout(function() { $i.trigger('focus'); }, 30); }
		});
	},


	/**
	 * Shared auto-refresh timer for the live views (Hub bots/deals, DCABot active deals). Owns its own
	 * timeout internally and returns { schedule, stop, initSelector, getMs } so a view keeps thin local
	 * wrappers (e.g. setReloadTimeout) and its callsites don't change.
	 *
	 * cfg:
	 *   onReload   fn()      — called when the timer fires (required)
	 *   defaultMs  number    — interval when none is stored / no selector (required)
	 *   shouldDefer fn():bool — when it returns true, skip THIS reload and reschedule instead
	 *                           (default: SymBot.UI.isDialogOpen — pause while a dialog is open)
	 *   storageKey string    — optional: persist a user-chosen interval in localStorage under this key
	 *   intervals  [{label,ms}] — optional: the choices for the interval selector
	 *   selector   string    — optional: jQuery selector of the <select> to populate/bind
	 * With storageKey+intervals+selector the interval is user-selectable and remembered; without them
	 * it is a fixed defaultMs interval (and initSelector is a no-op).
	 */
	autoRefresh: function(cfg) {

		cfg = cfg || {};

		const intervals = cfg.intervals || [];
		const shouldDefer = (typeof cfg.shouldDefer === 'function') ? cfg.shouldDefer : function() { return SymBot.UI.isDialogOpen(); };

		let timerId = null;

		function getMs() {

			if (cfg.storageKey && intervals.length) {

				try {

					const stored = parseInt(localStorage.getItem(cfg.storageKey), 10);

					if (!isNaN(stored) && intervals.some(function(r) { return r.ms === stored; })) { return stored; }
				}
				catch (e) {}
			}

			return cfg.defaultMs;
		}

		function saveMs(ms) { if (cfg.storageKey) { try { localStorage.setItem(cfg.storageKey, ms); } catch (e) {} } }

		const api = {};

		api.stop = function() { if (timerId) { clearTimeout(timerId); timerId = null; } };

		api.schedule = function() {

			api.stop();

			const ms = getMs();

			if (ms > 0) {

				timerId = setTimeout(function() {

					if (shouldDefer()) { api.schedule(); }
					else { cfg.onReload(); }

				}, ms);
			}
		};

		api.initSelector = function() {

			if (!cfg.selector || !intervals.length) { return; }

			const $sel = $(cfg.selector);

			$sel.empty();

			intervals.forEach(function(r) { $sel.append('<option value="' + r.ms + '">' + r.label + '</option>'); });

			$sel.val(getMs());

			$sel.on('change', function() {

				const ms = parseInt($(this).val(), 10);

				saveMs(ms);
				api.stop();

				if (ms > 0) { api.schedule(); }
			});
		};

		api.getMs = getMs;

		return api;
	},


	/**
	 * Shared hover-tooltip machinery for the action-pill views (Hub manage/deals, DCABot active deals).
	 * They differ ONLY in how an element id maps to tooltip text, so the view supplies `resolve(id)`
	 * (returns the text, or null/'' for none) and this owns the identical mouseenter/leave delay +
	 * throttle + show/hide of the `.toolTipButtons` bubble. `target` defaults to `'[id]'`.
	 *
	 * cfg: { resolve: fn(id)->text|null, target='[id]', delayMs=250, throttleMs=1000 }
	 */
	initTooltips: function(cfg) {

		cfg = cfg || {};

		const resolve = cfg.resolve;
		if (typeof resolve !== 'function') { return; }

		const target = cfg.target || '[id]';
		const delayMs = cfg.delayMs != null ? cfg.delayMs : 250;
		const throttleMs = cfg.throttleMs != null ? cfg.throttleMs : 1000;

		const lastShown = {};   // id -> last-displayed timestamp (throttle)

		$(document).on('mouseenter', target, function() {

			const $this = $(this);
			const id = $this.attr('id');
			const text = resolve(id);

			if (!text) { return; }

			const now = Date.now();
			const last = lastShown[id];

			if (last && now - last < throttleMs) { return; }

			$this.data('tooltipTimeout', setTimeout(function() {

				const tooltip = $('<div class="toolTipButtons"></div>').appendTo('body');

				tooltip.text(text).css({
					'top': $this.offset().top - tooltip.outerHeight() - 10,
					'left': $this.offset().left + ($this.outerWidth() / 2) - (tooltip.outerWidth() / 2)
				}).fadeIn(200);

				lastShown[id] = now;

			}, delayMs));
		});

		$(document).on('mouseleave click', target, function() {

			clearTimeout($(this).data('tooltipTimeout'));
			$('.toolTipButtons').fadeOut(200);
		});
	},


	/**
	 * Shared "fire a POST action" helper for the Hub bot/deal action buttons: shows the spinner
	 * overlay, POSTs JSON, hides the spinner, and on completion pops an alertBox and runs a callback.
	 * The views differ only in url / payload / which reload to run, so those are parameters; the
	 * spinner + 401→login + error-shaping skeleton lives here once. `alertBox` is a page global.
	 *
	 * opts: { url, payload, successMsg='Done', onSuccess=fn(), onFailure=onSuccess }
	 *   onSuccess runs after the success alert is dismissed; onFailure after a failure/error alert.
	 */
	postAction: function(opts) {

		opts = opts || {};

		const onSuccess = (typeof opts.onSuccess === 'function') ? opts.onSuccess : function() {};
		const onFailure = (typeof opts.onFailure === 'function') ? opts.onFailure : onSuccess;

		$('#spinner-overlay').fadeIn(100);

		$.ajax({
			type: 'POST',
			url: opts.url,
			contentType: 'application/json',
			data: JSON.stringify(opts.payload || {}),
			dataType: 'json',
			success: function(res) {

				$('#spinner-overlay').fadeOut(100);

				if (!res || !res.success) {
					alertBox('Error: ' + ((res && (res.data || res.message)) || 'Unknown error'), onFailure);
				}
				else {
					alertBox(opts.successMsg || 'Done', onSuccess);
				}
			},
			error: function(err) {

				$('#spinner-overlay').fadeOut(100);

				if (err && err.status === 401) { window.location.href = './login'; return; }

				alertBox('Error: ' + JSON.stringify(err), onFailure);
			}
		});
	},

	// HTML-escape for building markup from data. (Shared — was duplicated per view.)
	esc: function(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); },

	// Build the /api/tradingview widget URL for a pair, mapping ccxt exchange ids to TradingView's names.
	// Single source of truth shared by showTradingView (the modal widget) and the deal chart's
	// TradingView tab, so the exchange mapping isn't duplicated.
	tradingViewUrl: function(pair, exchange, jquery, script) {
		var map = { 'coinbasepro': 'COINBASE', 'coinbaseexchange': 'COINBASE', 'coinbaseinternational': 'COINBASE',
		            'binanceus': 'BINANCEUS', 'gate': 'GATEIO', 'myokx': 'OKX' };
		var ex = String(exchange || '').toLowerCase();
		ex = map[ex] || ex.toUpperCase();
		// Follow the app's light/dark theme so the embedded widget matches the rest of the UI instead of
		// always rendering dark. The server sanitizes this to exactly 'light' or 'dark'.
		var theme = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-theme') === 'dark') ? 'dark' : 'light';
		return './api/tradingview?jquery=' + (jquery ? 'true' : 'false') + '&script=' + (script ? 'true' : 'false') +
		       '&theme=' + theme +
		       '&exchange=' + encodeURIComponent(ex) + '&pair=' + encodeURIComponent(String(pair || '').replace(/[^a-z0-9]/gi, '_'));
	},

	// Short timezone abbreviation (e.g. "EDT") for an IANA zone. (Shared — was duplicated per view.)
	tzAbbrev: function(tz) { if (!tz) { return ''; } try { var parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()); var p = parts.filter(function (x) { return x.type === 'timeZoneName'; })[0]; return p ? p.value : tz; } catch (e) { return tz; } },

	// Currency symbol for a deal, honoring base/quote profit currency. The view passes its own
	// getCurrencySymbol resolver in (it is in scope at the call site), so this never depends on a
	// cross-script global. (Shared — was byte-identical across the deal views.)
	dealSymbol: function(pair, profitCurrency, resolver) { var parts = (pair || '').split('/'); var code = profitCurrency === 'base' ? parts[0] : parts[1]; var fn = (typeof resolver === 'function') ? resolver : ((typeof getCurrencySymbol === 'function') ? getCurrencySymbol : null); return (fn && fn(code)) || '$'; },

	// Fetch the bot list (GET ./api/bots) and hand the raw bots array to cb; cb([]) on error.
	// Each view keeps its own option-rendering. (Shared — dedupes the ajax boilerplate.)
	fetchBots: function(cb) { $.ajax({ type: 'GET', url: './api/bots', dataType: 'json', success: function(res) { cb((res && res.data) || []); }, error: function() { cb([]); } }); }
};

window.SymBot = SymBot;