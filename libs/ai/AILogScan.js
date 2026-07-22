'use strict';


// Read-only log retrieval for the AI assistant.
//
// Scans SymBot's own log files with pure Node.js streams. No shell, no spawn,
// no external process. Files are opened read-only and never written, moved or
// removed.
//
// Access is restricted to <path_root>/logs and to files whose names match the
// pattern SymBot itself writes (see Common.logger): YYYY-MM-DD[-InstanceName].log
// Nothing outside that directory is reachable: callers supply a date and an
// optional instance name, never a path, and every resolved candidate is checked
// for containment, subdirectories, symlinks and file type before it is opened.
//
// Scanning is deliberately byte-oriented. Lines are split on \n in the raw
// buffer and only the lines that match are decoded to UTF-8 strings, which keeps
// both time and memory flat regardless of how large the log is. Multi-byte
// characters that straddle a chunk boundary are reassembled before decoding
// because decoding only ever happens once a complete line has been isolated.


const fs = require('fs');
const path = require('path');


// Filename pattern SymBot writes: date, optional instance name, .log
const LOG_FILE_RE = /^\d{4}-\d{2}-\d{2}(?:-[A-Za-z0-9_.-]+)?\.log$/;

// Restart and shutdown records. These are meaningful in their own right, but
// when tracing a single deal they say only that the process stopped or resumed
// and crowd out the deal's own events, so per-deal scans suppress them.
const RESTART_RE = /Resuming Deal ID|SymBot is terminating/;

// Guard rails so a single question can never scan the whole archive.
const MAX_FILES_DEFAULT = 2;
const MAX_BYTES_DEFAULT = 400 * 1024 * 1024;
const MAX_LINES_DEFAULT = 400;
const MAX_LINE_CHARS = 2000;
const READ_CHUNK_BYTES = 1 << 20;

// Routine per-tick status lines. They repeat thousands of times per deal and
// carry no diagnostic value, so they are dropped unless explicitly requested.
const NOISE_RE = /Last Price:.*DCA Price:/;

// Lines that must never be fed back to the assistant.
//
// AI request logging writes the full prompt and response into the log, so a deal
// discussed in chat accumulates transcripts of previous questions and answers
// under its own deal id. Returning those as evidence would let an earlier reply
// be recycled as fact, so they are always dropped.
//
// Nothing else is excluded. Restart and shutdown lines were filtered here at one
// point as background chatter, which meant a question about restarts searched
// logs with the restart records removed and was answered with a confident zero.
// Operational lines are evidence, not noise: the caller decides what is relevant.
const EXCLUDE_RE = /AI Request \(|AI context:/;

// Event phrases worth surfacing when no specific deal is named. Kept as plain
// substrings so matching stays a byte comparison.
const EVENT_PATTERNS = [
	'CIRCUIT BREAKER',
	'Exchange-cancelled',
	'InsufficientFunds',
	'DCA Bot Finished',
	'Pausing any further',
	'Invalid order',
	'Invalid base order',
	'retries exhausted',
	'An error occurred',
	'Max safety orders used',
	'no pending order ID'
];


let shareData;


// Root of the only directory this module will ever read from.
function getLogDir() {

	const root = (shareData && shareData.appData && shareData.appData.path_root)
		? shareData.appData.path_root
		: path.resolve(__dirname, '..', '..');

	return path.join(root, 'logs');
}


// Resolve a log file name to an absolute path, or explain why it was refused.
// Single exit: every rejection sets result and falls through.
function resolveLogFile(fileName) {

	const logDir = getLogDir();

	let result = { 'success': false, 'error': 'Log file not available', 'path': null };

	if (typeof fileName === 'string' && fileName !== '' && LOG_FILE_RE.test(fileName)) {

		const full = path.resolve(logDir, fileName);
		const rel = path.relative(logDir, full);

		const contained = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
		const sameDir = path.dirname(full) === path.resolve(logDir);

		if (contained && sameDir) {

			let stat;

			try {

				// lstat, not stat: a symlink must be rejected rather than followed.
				stat = fs.lstatSync(full);
			}
			catch (e) {

				stat = null;
			}

			if (stat && stat.isFile()) {

				result = { 'success': true, 'error': null, 'path': full, 'size': stat.size };
			}
		}
	}

	return (result);
}


// Build the log file name for a date and optional instance, matching the
// convention in Common.logger. Dates arrive as YYYY-MM-DD.
function buildLogFileName(date, instanceName) {

	const namePart = (typeof instanceName === 'string' && instanceName.trim() !== '')
		? '-' + instanceName.trim()
		: '';

	return (date + namePart + '.log');
}


// List the log files present, newest first. Used to discover which dates and
// instances exist rather than guessing file names.
function listLogFiles() {

	const logDir = getLogDir();

	let files = [];

	try {

		files = fs.readdirSync(logDir)
			.filter(name => LOG_FILE_RE.test(name))
			.map(name => {

				const resolved = resolveLogFile(name);

				return (resolved.success ? { 'name': name, 'size': resolved.size } : null);
			})
			.filter(entry => entry != null)
			.sort((a, b) => b.name.localeCompare(a.name));
	}
	catch (e) {

		files = [];
	}

	return (files);
}


// Scan one file for lines containing any of the given needles.
//
// Reads in fixed-size chunks and splits on newline bytes. Only matching lines
// are turned into strings; everything else stays as raw bytes and is discarded,
// which is what keeps this fast and flat in memory on very large files.
async function scanFile(filePath, needles, options) {

	const opts = options || {};

	const maxLines = opts.maxLines || MAX_LINES_DEFAULT;
	const includeNoise = opts.includeNoise === true;
	const skipRestarts = opts.skipRestarts === true;

	const needleBufs = needles.map(n => Buffer.from(n, 'utf8'));

	const lines = [];

	let bytesRead = 0;
	let truncated = false;
	let matchCount = 0;

	const matches = (lineBuf) => needleBufs.some(nb => lineBuf.includes(nb));

	const keep = (lineBuf) => {

		let kept = false;

		if (matches(lineBuf)) {

			const text = lineBuf.toString('utf8');

			const isRestart = skipRestarts && RESTART_RE.test(text);
			const isNoise = !includeNoise && NOISE_RE.test(text);

			// A phrase appearing inside a logged AI request is the assistant quoting
			// itself, not the event happening, so such lines are neither counted nor
			// shown. Counting them would report a total higher than the events that
			// actually occurred, and would leave the count unsupported by the lines
			// displayed alongside it.
			const isTranscript = EXCLUDE_RE.test(text);

			if (!isRestart && !isNoise && !isTranscript) {

				matchCount++;

				if (lines.length < maxLines) {

					lines.push(text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) + ' …[truncated]' : text);

					kept = true;
				}
				else {

					truncated = true;
				}
			}
		}

		return (kept);
	};

	const stream = fs.createReadStream(filePath, { 'highWaterMark': READ_CHUNK_BYTES });

	let carry = Buffer.alloc(0);

	try {

		for await (const chunk of stream) {

			bytesRead += chunk.length;

			const buf = carry.length ? Buffer.concat([ carry, chunk ]) : chunk;

			let start = 0;

			while (true) {

				const nl = buf.indexOf(10, start);

				if (nl === -1) {

					break;
				}

				keep(buf.subarray(start, nl));

				start = nl + 1;
			}

			// Whatever follows the last newline is an incomplete line. Holding it
			// here is also what reunites a multi-byte character split by the chunk
			// boundary, since decoding happens only on complete lines.
			carry = buf.subarray(start);
		}

		// Final line when the file does not end with a newline.
		if (carry.length) {

			keep(carry);
		}
	}
	finally {

		stream.destroy();
	}

	return ({ 'lines': lines, 'bytesRead': bytesRead, 'truncated': truncated, 'matchCount': matchCount });
}


// Scan a set of log files for needles, honouring the byte and file budgets.
// Single exit.
async function scanLogs(params) {

	const opts = params || {};

	const needles = (opts.needles || []).filter(n => typeof n === 'string' && n !== '');
	const dates = (opts.dates || []).filter(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));

	const instanceName = opts.instanceName;
	const maxFiles = opts.maxFiles || MAX_FILES_DEFAULT;
	const maxBytes = opts.maxBytes || MAX_BYTES_DEFAULT;
	const maxLines = opts.maxLines || MAX_LINES_DEFAULT;

	let result = { 'success': false, 'error': null, 'lines': [], 'files': [], 'truncated': false };

	if (needles.length === 0 || dates.length === 0) {

		result.error = 'No search terms or dates provided';
	}
	else {

		const wanted = dates.slice(0, maxFiles).map(d => buildLogFileName(d, instanceName));

		let bytesBudget = maxBytes;
		let linesBudget = maxLines;

		const collected = [];
		const filesScanned = [];

		let totalMatches = 0;

		let truncated = false;
		let failure = null;

		for (const name of wanted) {

			if (linesBudget <= 0 || bytesBudget <= 0) {

				truncated = true;
			}
			else {

				const resolved = resolveLogFile(name);

				if (resolved.success) {

					try {

						const scan = await scanFile(resolved.path, needles, { 'maxLines': linesBudget, 'includeNoise': opts.includeNoise, 'skipRestarts': opts.skipRestarts });

						collected.push(...scan.lines);
						filesScanned.push(name);

						totalMatches += (scan.matchCount || 0);

						bytesBudget -= scan.bytesRead;
						linesBudget -= scan.lines.length;

						if (scan.truncated) {

							truncated = true;
						}
					}
					catch (e) {

						failure = e.message;
					}
				}
			}
		}

		result = {
			'success': failure == null,
			'error': failure,
			'lines': collected,
			'files': filesScanned,
			'truncated': truncated,
			'matchCount': totalMatches
		};
	}

	return (result);
}


// Everything logged for one deal, noise removed. This is the common case: a
// deal id reduces a day's log to a handful of lines.
async function getDealEvents(dealId, dates, instanceName, maxLines) {

	return (await scanLogs({
		'needles': [ dealId ],
		'dates': dates,
		'instanceName': instanceName,
		'maxLines': maxLines,
		'skipRestarts': true
	}));
}


// Notable events across all deals for the given dates.
async function getNotableEvents(dates, instanceName, maxLines) {

	return (await scanLogs({
		'needles': EVENT_PATTERNS,
		'dates': dates,
		'instanceName': instanceName,
		'maxLines': maxLines
	}));
}


module.exports = {

	scanLogs,
	scanFile,
	getDealEvents,
	getNotableEvents,
	listLogFiles,
	resolveLogFile,
	buildLogFileName,

	EVENT_PATTERNS,

	init: function(obj) {

		shareData = obj;
	}
};
