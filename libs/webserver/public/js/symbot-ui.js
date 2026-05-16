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
