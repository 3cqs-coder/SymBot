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
	 *   type: 'dot' (a coloured status dot) or 'glyph' (paused/error symbol)
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

		// A coloured dot for the four running states; a styled glyph for
		// paused/error. Both use the same sized slot so the column reads as one
		// coherent system. Colours are theme-aware via CSS (see style.css) so they
		// stay legible and un-harsh in light mode — the old emoji couldn't be tuned.
		const inner = (h.type === 'glyph')
			? '<span class="deal-health-glyph ' + h.cls + '"></span>'
			: '<span class="deal-health-dot ' + h.cls + '"></span>';

		return '<td class="deal-health-cell" data-health-rank="' + h.rank + '" title="' + title + '"><span class="deal-health">' + inner + '</span></td>';
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
	}
};

window.SymBot = SymBot;
