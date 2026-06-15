'use strict';

const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const AttachmentSchema = new Schema({
	name:      { type: String, required: true },  // original filename
	type:      { type: String, required: true },  // 'pdf' | 'docx' | 'txt' | 'csv' | 'md'
	size:      { type: Number, default: 0 },      // bytes
	text:      { type: String, default: '' },     // extracted full text
	charCount: { type: Number, default: 0 },      // length of extracted text
}, { _id: false });

const MessageSchema = new Schema({
	role:        { type: String, required: true },
	content:     { type: String, required: true },
	timestamp:   { type: Number, default: () => Date.now() },
	attachments: { type: [AttachmentSchema], default: [] }
}, { _id: false });

const AIChatSchema = new Schema({
	conversation_id: { type: String, required: true, unique: true },
	server_id:       { type: String, required: true, index: true },
	username:        { type: String, default: null, index: true },
	name:            { type: String, default: 'New Conversation' },
	type:            { type: String, enum: ['chat', 'analysis'], default: 'chat' },
	deal_id:         { type: String, default: '' },
	messages:        { type: [MessageSchema], default: [] },
}, {
	collection: 'ai_conversations',
	timestamps: true
});

module.exports = {
	'AIChatSchema': mongoose.model('AIChatSchema', AIChatSchema)
};
