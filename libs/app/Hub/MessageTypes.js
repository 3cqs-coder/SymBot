'use strict';


// Shared message type constants for Hub ↔ Worker inter-thread communication.
//
// Constants are namespaced by sender so call sites read as a clear statement
// of intent:
//
//   Hub/Main sending:   worker.postMessage({ type: HUB_TO_WORKER.SHUTDOWN });
//   Worker receiving:   if (message.type === HUB_TO_WORKER.SHUTDOWN) { ... }
//
//   Worker sending:     parentPort.postMessage({ type: WORKER_TO_HUB.LOG, ... });
//   Hub/Main receiving: if (message.type === WORKER_TO_HUB.LOG) { ... }
//
// All postMessage({ type }) calls and message.type checks in Hub.js, Main.js,
// Worker.js, and symbot-hub.js must use these constants — never raw strings.


// Messages sent from the Hub (or symbot-hub.js) to a Worker thread
const HUB_TO_WORKER = {

	SHUTDOWN:			'shutdown',
	// MEMORY intentionally shares the wire value 'memory' with WORKER_TO_HUB.MEMORY.
	// Hub sends 'memory' as a request; Worker sends 'memory' as a response with payload.
	// There is no ambiguity at runtime because each travels on a different channel
	// (Hub→Worker vs Worker→Hub). Do not change this value without updating Worker.js.
	MEMORY:				'memory',
	DEALS_ACTIVE:			'deals_active',
	BOTS_ACTIVE:			'bots_active',
	DEAL_ACTION:			'deal_action',
	SYSTEM_PAUSE:			'system_pause',
	BOT_ACTION:			'bot_action',
	// Aggregated AI-learning pack the Hub pushes down for the instance to import.
	LEARNING_PACK:			'learning_pack',
};


// Messages sent from a Worker thread back to the Hub
const WORKER_TO_HUB = {

	SHUTDOWN_RECEIVED:		'shutdown_received',
	MEMORY:				'memory',
	DEALS_ACTIVE_RECEIVED:		'deals_active_received',
	BOTS_ACTIVE_RECEIVED:		'bots_active_received',
	DEAL_ACTION_RECEIVED:		'deal_action_received',
	SYSTEM_PAUSE_RECEIVED:		'system_pause_received',
	BOT_ACTION_RECEIVED:		'bot_action_received',
	SYSTEM_PAUSE_ALL:		'system_pause_all',
	SHUTDOWN_HUB:			'shutdown_hub',
	LOG:				'log',
	// A batch of relayed log LINES (strings), flushed together to avoid one cross-thread message
	// per line. `error` lines are still relayed immediately (see Worker.js). Each line is logged
	// on the Hub exactly as a single LOG would be.
	LOG_BATCH:			'log_batch',
	// An instance with no SMTP of its own relays an outbound email to the Hub, which
	// sends it through the Hub's shared mailer. Fire-and-forget: no matching ack.
	SEND_EMAIL:			'send_email',
	// An instance relays a patterns-only AI-learning note (question → tools) to the Hub,
	// which pools it so separate-database instances learn from each other. Fire-and-forget.
	LEARNING:			'learning',
	// An instance reports its AI-tool names to the Hub (once, on startup). The Hub unions these
	// across the fleet so a maintainer aggregating contributed learning packs validates against the
	// tools instances actually have — not only the Hub process's own registry — and can see which
	// instances support a given tool. Fire-and-forget.
	TOOLS:				'tools',
};


module.exports = { HUB_TO_WORKER, WORKER_TO_HUB };
