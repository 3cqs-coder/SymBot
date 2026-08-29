/**
 * ai-chat-conversations.js
 * Shared conversation management for inline and popout AI chat views.
 */

(function() {

	// Guard against double-initialization (inline chat opens multiple times)
	if (window.AIChatConv_initialized) return;
	window.AIChatConv_initialized = true;

	function getRoom() { return window.AIChatConv_room || ''; }

	// Styled confirmation — reuses the app-wide SymBot.UI.confirmDialog (jquery-confirm) so these
	// prompts match every other confirm in SymBot instead of the native blocking confirm(). Falls back
	// to the native dialog only if that helper isn't present (a surface that didn't load symbot-ui.js).
	function chatConfirm(message, onConfirm, onCancel, confirmText) {
		onConfirm = onConfirm || function() {};
		onCancel  = onCancel  || function() {};
		if (window.SymBot && SymBot.UI && typeof SymBot.UI.confirmDialog === 'function') {
			SymBot.UI.confirmDialog({
				content: message,
				confirmText: confirmText || '<div style="color: var(--color-danger);">Confirm</div>',
				onConfirm: onConfirm,
				onCancel: onCancel
			});
		}
		else if (window.confirm(message)) { onConfirm(); }
		else { onCancel(); }
	}

	// Tag an outgoing chat message with the correct purpose and model routing.
	// This is the ONE place that decision lives, so every chat surface (inline
	// modal, popout, and any future one) sends consistently instead of each view
	// re-deriving it — the drift that let follow-ups quietly fall back to the chat
	// model. Behavior:
	//   • The first message of an analysis conversation IS the deal-analysis report
	//     prompt → purpose 'analysis' (runs on the Deal Analysis Model, gets the
	//     footer + grounding check).
	//   • Every other message is a normal chat turn (purpose 'chat'); inside an
	//     analysis conversation it stays on the Deal Analysis Model too, so the
	//     whole deal discussion uses one model, while general chat uses the chat model.
	function tagChatMessage(message, isInitial) {
		message = message || {};
		var isAnalysisConv = (window.AIChatConv_type === 'analysis');
		if (isInitial && isAnalysisConv) {
			message.purpose = 'analysis';
		}
		else {
			message.purpose = 'chat';
			if (isAnalysisConv) { message.useAnalysisModel = true; }
		}
		return message;
	}
	window.AIChatConv_tagMessage = tagChatMessage;

	function timeAgo(isoString) {
		if (!isoString) return '';
		const diff = Date.now() - new Date(isoString).getTime();
		const mins  = Math.floor(diff / 60000);
		const hours = Math.floor(diff / 3600000);
		const days  = Math.floor(diff / 86400000);
		if (mins < 1)   return 'just now';
		if (mins < 60)  return mins  + 'm ago';
		if (hours < 24) return hours + 'h ago';
		const rem = Math.round((diff % 86400000) / 3600000 * 10) / 10;
		return days + (rem > 0 ? '.' + String(rem).replace('.','').slice(0,1) : '') + 'd ago';
	}
	function getBase() { return window.AIChatConv_basePath || './'; }

	// ── Helpers ───────────────────────────────────────────────────────────────

	function generateConversationId() {
		return 'conv-' + Math.random().toString(36).slice(2) + Math.floor(Date.now() / 1000);
	}

	function updateDeleteBtn() {
		const hasSaved = !!$('#conversationSelect').val();
		$('#chatDeleteBtn').toggle(hasSaved);
		$('#chatSaveBtn').toggle(!hasSaved);
	}
	window.AIChatConv_updateDeleteBtn = updateDeleteBtn;

	// ── Conversation list ─────────────────────────────────────────────────────

	var listLoading = false;

	function loadConversationList(selectId) {

		if (listLoading) return;
		listLoading = true;

		$.ajax({
			type: 'GET', url: getBase() + 'api/ai/chat/conversations', dataType: 'json',
			success: function(res) {
				listLoading = false;
				const $sel = $('#conversationSelect');
				$sel.empty().append($('<option>', { value: '', text: 'New conversation' }));
				if (res && res.success && res.data && res.data.length) {
					res.data.forEach(function(conv) {
						const icon    = conv.type === 'analysis' ? '⚡ ' : '💬 ';
						const tooltip = conv.updatedAt ? 'Last active: ' + timeAgo(conv.updatedAt) : '';
						$sel.append($('<option>', { value: conv.conversation_id, text: icon + conv.name, title: tooltip }));
					});
				}
				if (selectId !== undefined) {
					$sel.val(selectId);
					// Restore type and deal_id from list data when pre-selecting a conversation
					if (selectId && res.data) {
						const match = res.data.find(function(conv) { return conv.conversation_id === selectId; });
						if (match) {
							window.AIChatConv_type    = match.type    || 'chat';
							window.AIChatConv_dealId  = match.deal_id || '';
							window.AIChatConv_savedName = match.name  || '';
						}
					}
				}
				updateDeleteBtn();
			},
			error: function() { listLoading = false; }
		});
	}
	window.AIChatConv_loadList = loadConversationList;

	// ── Save ─────────────────────────────────────────────────────────────────

	function doSave(conversation_id, name, startIndex, type, deal_id) {

		// Never save with "New conversation" as the name
		if (!name || name === 'New conversation') return;

		$.ajax({
			type: 'POST', url: getBase() + 'api/ai/chat/conversations/save',
			data: {
				conversation_id: conversation_id,
				name: name,
				room: getRoom(),
				start_index: startIndex || 0,
				type: type || 'chat',
				deal_id: deal_id || ''
			},
			dataType: 'json',
			success: function(res) {
				if (res.success) {
					window.AIChatConv_activeId = conversation_id;
					$('.aiChatContainer').data('convId', conversation_id);
					// Refresh list but preserve current selection
					loadConversationList(conversation_id);
				} else {
					(typeof alertBox === 'function' ? alertBox : alert)('Save failed: ' + (res.error || 'unknown error'));
				}
			}
		});
	}
	window.AIChatConv_doSave = doSave;

	// ── Auto-save (called on chat_end) ───────────────────────────────────────

	window.AIChatConv_autoSave = function() {
		const id = window.AIChatConv_activeId;
		if (!id) return;

		// Get name from the stored conversation name, not the dropdown text
		// (dropdown text includes icon + time suffix)
		const name = window.AIChatConv_savedName || '';
		if (!name || name === 'New conversation') return;

		doSave(id, name, undefined, window.AIChatConv_type || 'chat', window.AIChatConv_dealId || '');
	};

	// ── Load a conversation into the room ────────────────────────────────────

	function loadIntoRoom(conversation_id, onSuccess, onFail) {
		// Show the animated mascot loader while the saved conversation is fetched
		// (replaces the old hidden spinner). renderHistory empties the box below.
		$('#aiChatSpinner').hide();
		if (window.SymBot && SymBot.Mascot && SymBot.Mascot.loaderHtml) {
			$('#aiChatBox').html(SymBot.Mascot.loaderHtml('Loading conversation…'));
		}
		$.ajax({
			type: 'POST', url: getBase() + 'api/ai/chat/conversations/load',
			data: { conversation_id: conversation_id, room: getRoom() },
			dataType: 'json',
			success: function(res) {
				$('#aiChatSpinner').hide();
				if (res.success && res.data) {
					window.AIChatConv_activeId     = conversation_id;
					window.AIChatConv_sessionStart = res.data.messages.length;
					window.AIChatConv_savedName    = res.data.name;
					window.AIChatConv_type         = res.data.type    || 'chat';
					window.AIChatConv_dealId       = res.data.deal_id || '';
					$('.aiChatContainer').data('convId', conversation_id);
					$('#aiChatBox').empty();
					$('#chatAttachments').empty();
					if (typeof window.AIChatConv_renderHistory === 'function') {
						window.AIChatConv_renderHistory(res.data.messages);
					}
					updateDeleteBtn();
					if (onSuccess) onSuccess(res.data);
				} else {
					$('#aiChatBox').empty();
					if (typeof window.AIChatConv_updateMascotHero === 'function') window.AIChatConv_updateMascotHero();
					(typeof alertBox === 'function' ? alertBox : alert)('Could not load conversation.');
					if (onFail) onFail();
				}
			},
			error: function() {
				$('#aiChatSpinner').hide();
				$('#aiChatBox').empty();
				if (typeof window.AIChatConv_updateMascotHero === 'function') window.AIChatConv_updateMascotHero();
				if (onFail) onFail();
			}
		});
	}
	window.AIChatConv_loadIntoRoom = loadIntoRoom;

	// ── Reset to new conversation ─────────────────────────────────────────────

	function resetConversation() {
		window.AIChatConv_activeId     = null;
		window.AIChatConv_sessionStart = 0;
		window.AIChatConv_firstMessage = null;
		window.AIChatConv_savedName    = null;
		$('.aiChatContainer').data('convId', '');
		$('#aiChatBox').empty();
		$('#chatAttachments').empty();
		$('#conversationSelect').val('');
		updateDeleteBtn();
		// Re-show the empty-state mascot hero (the view registers this hook).
		if (typeof window.AIChatConv_updateMascotHero === 'function') window.AIChatConv_updateMascotHero();
		$.ajax({
			type: 'POST',
			url: getBase() + 'api/ai/chat/prompt',
			contentType: 'application/json',
			data: JSON.stringify({ message: { room: getRoom(), content: '', reset: true } }),
			dataType: 'json'
		});
	}
	window.AIChatConv_reset = resetConversation;

	// ── Wire up controls ─────────────────────────────────────────────────────

	// Execute immediately — document is already ready when this runs
	function initControls() {

		// Dropdown change
		$('#conversationSelect').off('change.conv').on('change.conv', function() {
			const id = $(this).val();
			if (!id) {
				chatConfirm('Start a new conversation? This will clear the current chat.',
					function() { resetConversation(); },
					function() { $('#conversationSelect').val(window.AIChatConv_activeId || ''); updateDeleteBtn(); },
					'<div>Start New</div>');
				return;
			}
			loadIntoRoom(id);
		});

		// Save button
		$('#chatSaveBtn').off('click.conv').on('click.conv', function() {
			const existingId = $('#conversationSelect').val();
			if (existingId) {
				const name = $('#conversationSelect option:selected').text();
				doSave(existingId, name);
			} else {
				const suggestion = (window.AIChatConv_firstMessage || '').slice(0, 60);
				const name = prompt('Save conversation as:', suggestion);
				if (!name || !name.trim()) return;
				const id = window.AIChatConv_activeId || generateConversationId();
				window.AIChatConv_activeId = id;
				window.AIChatConv_savedName = name.trim();
				doSave(id, name.trim(), window.AIChatConv_sessionStart || 0, window.AIChatConv_type || 'chat', window.AIChatConv_dealId || '');
			}
		});

		// Delete button
		$('#chatDeleteBtn').off('click.conv').on('click.conv', function() {
			const id   = $('#conversationSelect').val();
			const name = $('#conversationSelect option:selected').text();
			if (!id) return;
			// Escape the conversation name — the styled confirm dialog injects its content as HTML, and a
			// name is user/derived text (a saved title or a first message), so an unescaped "<img onerror>"
			// would execute here. The native confirm() fallback renders text and is already safe.
			const safeName = (window.SymBot && SymBot.UI && typeof SymBot.UI.esc === 'function') ? SymBot.UI.esc(name) : name;
			chatConfirm('Delete conversation "' + safeName + '"?', function() {
				$.ajax({
					type: 'DELETE',
					url: getBase() + 'api/ai/chat/conversations/' + id,
					dataType: 'json',
					success: function(res) {
						if (res.success) {
							resetConversation();
							// Small delay to let reset settle before refreshing list
							setTimeout(function() { loadConversationList(''); }, 100);
							if (typeof canSendMessage !== 'undefined') {
								canSendMessage = true;
								toggleInputState(false);
							}
						}
					}
				});
			}, null, '<div style="color: var(--color-danger);">Delete</div>');
		});

	}

	initControls();

	// Load conversation list on init
	loadConversationList(window.AIChatConv_activeId || undefined);

})();