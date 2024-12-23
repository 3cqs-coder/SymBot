'use strict';

const { Ollama } = require('ollama');

let ollama;
let modelCurrent;
let shareData;

const modelDefault = 'llama3.2';
const TIMEOUT_MS = 75000;

const streamChatResponse = async ({ room, model, message, abortSignal }) => {

	let fullResponse = '';

	// Reset conversation context
	const resetMessage = {
		role: 'system',
		content: 'Reset the conversation context.',
	};

	const response = await ollama.chat({
		'model': model,
		'stream': true,
		'messages': [resetMessage, message],
	});

	try {

		for await (const part of response) {

			if (abortSignal.aborted) {

				throw new Error('Stream aborted due to timeout');
			}

			const content = part.message.content;

			// Accumulate content for the full response
			fullResponse += content;

			sendMessage(room, content);
		}

		// Signal end of chat for the current conversation
		sendMessage(room, 'END_OF_CHAT');

		const logObj = {
			'room': room,
			'message': message,
			'response': fullResponse
		};

		shareData.Common.logger('Ollama Request: ' + JSON.stringify(logObj));
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


const streamChatResponseWithTimeout = async ({ room, model, message }) => {

	const abortController = new AbortController();

	const timeout = setTimeout(() => { abortController.abort(); }, TIMEOUT_MS);

	try {

		await streamChatResponse({
			room,
			model,
			message,
			abortSignal: abortController.signal
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

		await streamChatResponseWithTimeout({
			room,
			model,
			message
		});
	}
	catch(err) {

		sendError(room, err.message);
	}
}


async function sendMessage(room, msg) {

	shareData.Common.sendSocketMsg({
		'room': room,
		'type': 'message',
		'message': msg,
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
	catch(err) {

		sendError('', err.message);
	}
}


function stop() {

	if (ollama) {

		try {

			ollama.abort();
			ollama = null;
		}
		catch(e) {}
    }
}


module.exports = {

	start,
	stop,
	streamChat,

	init: function(obj) {

		shareData = obj;
	},
};
