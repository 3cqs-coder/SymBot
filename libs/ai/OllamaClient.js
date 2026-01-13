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

let ollamaStarted = false;

setInterval(() => {

    cleanupRooms();

}, (hoursInterval * (60 * 60 * 1000)));


const streamChatResponse = async ({ room, model, message, abortSignal, reset, stream = true }) => {

	let fullResponse = '';

	// Reset conversation context if requested
	if (reset) {

		conversationHistory.set(room, [{
			role: 'system',
			content: 'Reset the conversation context.',
			timestamp: Date.now(),
		}]);
	}

	const history = conversationHistory.get(room) || [];

	history.push({
		role: 'user',
		content: message.content,
		timestamp: Date.now(),
	});

	if (history.length > maxHistory) history.shift();

	try {

		const result = await ollama.chat({
			model,
			stream,
			messages: history,
		});

		if (!stream) {

			// NON-STREAMING MODE

			if (abortSignal.aborted) {

				throw new Error('Request aborted due to timeout');
			}

			fullResponse = result.message.content;
		}
		else {

			// STREAMING MODE

			for await (const part of result) {

				if (abortSignal.aborted) {

					throw new Error('Stream aborted due to timeout');
				}

				const content = part?.message?.content;
				if (!content) continue;

				fullResponse += content;
				sendMessage(room, content);
			}

			sendMessage(room, 'END_OF_CHAT');
		}

		// Store assistant response
		history.push({
			role: 'assistant',
			content: fullResponse,
			timestamp: Date.now(),
		});

		if (history.length > maxHistory) history.shift();
		conversationHistory.set(room, history);

		shareData.Common.logger(
			'Ollama Request: ' + JSON.stringify({
				room,
				message,
				response: fullResponse,
			})
		);

		return stream ? undefined : fullResponse;
	}
	catch (err) {

		if (abortSignal.aborted && stream) {

			sendMessage(room, 'Stream aborted due to timeout');

			return;
		}

		throw err;
	}
};


const streamChatResponseWithTimeout = async ({ room, model, message, reset, stream, }) => {

	const abortController = new AbortController();

	const timeout = setTimeout(() => abortController.abort(),
		TIMEOUT_MS
	);

	try {

		return await streamChatResponse({
			room,
			model,
			message,
			abortSignal: abortController.signal,
			reset,
			stream,
		});
	}
	finally {

		clearTimeout(timeout);
	}
};


async function streamChat(data) {

	let room;
	let reset;
	let stream;
	let model = modelCurrent;
	let success = false;
	let dataOut = null;

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

		reset = parsedData.message.reset || false;
		stream = parsedData.message.stream ?? true;

		if (!ollamaStarted) {

			throw new Error('Ollama not started or is not enabled');
		}

		const result = await streamChatResponseWithTimeout({
			room,
			model,
			message,
			reset,
			stream,
		});

		success = true;

		if (!stream) {

			dataOut = result;
		}
	}
	catch (err) {

		success = false;
		dataOut = err.message;

		if (room && stream) {

			sendError(room, dataOut);
		}
	}

	return { success, data: dataOut };
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

		ollamaStarted = true;

		ollama = new Ollama({
			'host': host,
		});
	}
    catch (err) {

		ollamaStarted = false;

        sendError('', err.message);
	}
}


function stop() {

    if (ollama) {

		ollamaStarted = false;

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