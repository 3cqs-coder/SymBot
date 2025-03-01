'use strict';

const { Ollama } = require('ollama');

let ollama;
let modelCurrent;
let shareData;


const modelDefault = 'llama3.2';
const TIMEOUT_MS = 75000;
const maxHistory = 25;
const maxMessageAge = 2 * (60 * 60 * 1000);
const hoursInterval = 1;

// Map to store conversation history for each room
const conversationHistory = new Map();


setInterval(() => {

    cleanupRooms();

}, (hoursInterval * (60 * 60 * 1000)));


const streamChatResponse = async ({ room, model, message, abortSignal, reset }) => {

	let fullResponse = '';

	// Reset conversation context if requested
	if (reset) {

		const resetMessage = {
			role: 'system',
			content: 'Reset the conversation context.',
			timestamp: Date.now(),
		};

		// Reset the history for the room
		conversationHistory.set(room, [resetMessage]);
		//console.log('History reset for room:', room);
	}

	// Get the current conversation history for the room
	const history = conversationHistory.get(room) || [];

	// Append user message to history
	const userMessage = {
		role: 'user',
		content: message.content,
		timestamp: Date.now(),
	};

	history.push(userMessage);

	// Ensure the history is not more than maxHistory
	if (history.length > maxHistory) {

        history.shift();
	}

	// Proceed with chat response generation
	try {
		const response = await ollama.chat({
			model: model,
			stream: true,
			messages: history,
		});

		for await (const part of response) {

			if (abortSignal.aborted) {

				throw new Error('Stream aborted due to timeout');
			}

			const content = part.message.content;

			// Accumulate content for the full response
			fullResponse += content;

			sendMessage(room, content);
		}

		// Add the assistant's response to the conversation history
		const assistantMessage = {
			role: 'assistant',
			content: fullResponse,
			timestamp: Date.now(),
		};

		history.push(assistantMessage);

		// Ensure the history is not more than maxHistory after adding the assistant's message
		if (history.length > maxHistory) {

			history.shift();
		}

		// Signal end of chat for the current conversation
		sendMessage(room, 'END_OF_CHAT');

		const logObj = {
			room,
			message,
			response: fullResponse,
		};

		shareData.Common.logger('Ollama Request: ' + JSON.stringify(logObj));

		// Update the conversation history for the room
		conversationHistory.set(room, history);
	}
    catch (err) {

        if (abortSignal.aborted) {

            sendMessage(room, 'Stream aborted due to timeout');
		}
        else {
            
            throw err;
		}
	}
};


const streamChatResponseWithTimeout = async ({ room, model, message, reset }) => {

	const abortController = new AbortController();

	const timeout = setTimeout(() => { abortController.abort(); }, TIMEOUT_MS);

	try {
		await streamChatResponse({
			room,
			model,
			message,
			abortSignal: abortController.signal,
			reset,
		});
	}
    finally {

        clearTimeout(timeout);
	}
};


async function streamChat(data) {

	let room;
	let model = modelCurrent;

	try {
		const parsedData = JSON.parse(data);

		room = parsedData.message.room;

		if (parsedData.message.model) {

			model = parsedData.message.model;
		}

		const message = {
			role: 'user',
			content: parsedData.message.content,
		};

		const reset = parsedData.message.reset || false; // Check for reset flag

		await streamChatResponseWithTimeout({
			room,
			model,
			message,
			reset,
		});
	}
    catch (err) {

        sendError(room, err.message);
	}
}


async function sendMessage(room, msg) {

	shareData.Common.sendSocketMsg({
		room,
		type: 'message',
		message: msg,
	});
}


async function sendError(room, msg) {

    const logData = 'Ollama Error: ' + msg;

	shareData.Common.logger(logData);
	sendMessage(room, logData);
}


function start(host, model) {

	if (model != undefined && model != null && model != '') {

        modelCurrent = model;
	}
    else {

		modelCurrent = modelDefault;
	}

	try {
		ollama = new Ollama({
			'host': host,
		});
	}
    catch (err) {

        sendError('', err.message);
	}
}


function stop() {

    if (ollama) {

        try {
			ollama.abort();
			ollama = null;
		}
        catch (e) {}
	}
}


function cleanupRooms() {

    const now = Date.now();

	conversationHistory.forEach((history, room) => {
		// Remove messages older than maxMessageAge
		const filteredHistory = history.filter(msg => (now - msg.timestamp) <= maxMessageAge);

		// If the history becomes empty after filtering, delete the room's history
		if (filteredHistory.length === 0) {

            conversationHistory.delete(room);
			//console.log('Removed empty history for room:', room);
		}
        else {

            conversationHistory.set(room, filteredHistory);
			//console.log('History cleaned and updated for room:', room, filteredHistory);
		}
	});
}


module.exports = {
	start,
	stop,
	streamChat,

	init: function(obj) {
		shareData = obj;
	}
};