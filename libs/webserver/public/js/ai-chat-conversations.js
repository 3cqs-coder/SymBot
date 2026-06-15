/**
 * ai-chat-conversations.js
 * Shared conversation management for inline and popout AI chat views.
 */

(function() {

	// Guard against double-initialisation (inline chat opens multiple times)
	if (window.AIChatConv_initialized) return;
	window.AIChatConv_initialized = true;

	function getRoom() { return window.AIChatConv_room || ''; }

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
				if (res.success && res.data && res.data.length) {
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

	// ── Auto-save (called on END_OF_CHAT) ────────────────────────────────────

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
		$('#aiChatSpinner').show();
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
					(typeof alertBox === 'function' ? alertBox : alert)('Could not load conversation.');
					if (onFail) onFail();
				}
			},
			error: function() {
				$('#aiChatSpinner').hide();
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
				const doConfirm = (typeof window.confirmBox === 'function')
					? window.confirmBox
					: function(msg, cb) {
						if (confirm(msg)) cb();
						else { $('#conversationSelect').val(window.AIChatConv_activeId || ''); updateDeleteBtn(); }
					};
				doConfirm('Start a new conversation? This will clear the current chat.', function() {
					resetConversation();
				});
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
			const doConfirm = (typeof window.confirmBox === 'function')
				? window.confirmBox
				: function(msg, cb) { if (confirm(msg)) cb(); };
			doConfirm('Delete conversation "' + name + '"?', function() {
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
			});
		});

	}

	initControls();

	// Load conversation list on init
	loadConversationList(window.AIChatConv_activeId || undefined);

})();
