/**
 * symbot-bot-form.js
 * Shared client-side JS for bot create/update forms.
 * Used by both the instance DCABotCreateUpdateView and the Hub botEditView.
 * Exposes: BotForm.init(options)
 */

(function(window) {

	'use strict';

	const BotForm = {};


	BotForm.disableAll = function(disable) {

		$('input,select').not('[type=button]').prop('disabled', disable);
		$('[id^="selectAll"]').prop('disabled', disable);
		$('[id^="clearAll"]').prop('disabled', disable);
	};


	BotForm.resetForm = function() {

		$('#formSubmitPreview').show();
		$('#formSubmitReset').hide();
		$('#formSubmitStart').hide();
		$('#ordersBox').hide();

		BotForm.disableAll(false);
	};


	BotForm.clearAll = function() {

		$('#pair option').each(function() { this.selected = false; });
		$('#pair').trigger('change');
	};


	BotForm.selectAll = function(quote) {

		BotForm.clearAll();

		const allPairs = $('#pair option').map(function() { return this.value; }).get()
			.filter(function(v) {
				const parts = v.split('/');
				return parts[1] && parts[1].toUpperCase() === quote.toUpperCase();
			});

		$('#pair').val(allPairs).trigger('change');
	};


	BotForm.renderOrdersTable = function(res, botText) {

		const orders  = res.data && res.data.orders;
		const content = res.data && res.data.content;

		const orderSym  = (content && content.currency_symbol) || '$';
		const moneyCols = new Set([2, 3, 4, 6, 8]);

		let tableData = orders.steps.slice();
		tableData.unshift(orders.headers);

		const table = $('<table id="ordersTable" cellspacing=0 cellpadding=0>');

		for (let i = 0; i < tableData.length; i++) {

			const cols = tableData[i];
			const tag  = i === 0 ? 'th' : 'td';
			const row  = $('<tr/>');

			for (let x = 0; x < cols.length; x++) {

				let col = cols[x];

				if (i > 0 && moneyCols.has(x)) col = orderSym + col;

				row.append($('<' + tag + '>' + col + '</' + tag + '>'));
			}

			table.append(row);
		}

		const sym = content.currency_symbol || '$';

		let contentAdd = '<div id="ordersContent" style="position: relative; margin: 0 auto;">';

		if (content.balance < content.max_funds) {

			contentAdd += '<b style="color: red;">Your current balance does not have enough funds for all DCA orders</b><br><br>';
		}

		contentAdd += '<div style="position: relative; display: inline-block; text-align: left;">';
		contentAdd += '<b>Current Balance</b>: '      + sym + content.balance + '<br>\n';
		contentAdd += '<b>Max. Funds Per Pair</b>: '  + sym + Math.round(content.max_funds) + '<br>\n';
		contentAdd += '<b>Max. Funds Total</b>: '     + sym + content.bot_max_funds + '<br>\n';
		contentAdd += '<b>Max. Deviation</b>: '       + content.max_deviation_percent + '%<br>\n';
		contentAdd += '</div></div><br>\n';

		$('#ordersBox').html(table).prepend(contentAdd);

		$('#spinner-overlay').fadeOut(100);

		BotForm.disableAll(true);

		$('#ordersBox').show();
		$('#formSubmitReset').show();
		$('#formSubmitStart').show();

		$('html, body').animate({ scrollTop: $('#ordersBox').position().top - 75 }, 500);

		if (content.balance_error) {

			$('#formSubmitStart').hide();
			alertBox('<b>ERROR:</b> ' + content.balance_error);
		}
		else {

			alertBox('Verify orders and confirm to ' + botText);
		}
	};


	BotForm.initPairButtons = function(pairButtons) {

		for (let i = 0; i < pairButtons.length; i++) {

			const opt = pairButtons[i].toUpperCase();

			$('#pairButtons').append('<button id="selectAll-' + opt + '" class="btnAll">' + opt + '</button> ');
		}

		$('#clearAll').on('click', function(e) {

			e.preventDefault();
			BotForm.clearAll();
		});

		$(document).on('click', '[id^="selectAll-"]', function(e) {

			e.preventDefault();
			BotForm.selectAll(this.id.split('-')[1]);
		});
	};


	BotForm.initStartConditions = function(startConditionsMeta) {

		function showSub(val) {

			const data = (val || '').split('|');

			if (data[0] === 'signal') {

				const key = data[1];

				if (startConditionsMeta[key] && startConditionsMeta[key]['info']) {

					$('#infoBox').html('<div style="display: block;"><i>' + startConditionsMeta[key]['info'] + '</i></div>').show();
				}

				$('[id^="startConditionSub-' + key + '"]').show();
			}
			else {

				$('#infoBox').empty().hide();
				$('[id^="startConditionSub"]').hide();
			}
		}

		showSub($('#startCondition').val());

		$('#startCondition').on('change', function() { showSub(this.value); });
	};


	window.BotForm = BotForm;

})(window);
