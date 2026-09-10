'use strict';

// ── Non-blocking log file writer ─────────────────────────────────────────────
// The logger runs on every code path, including the live trading loop, so it must never block that loop
// on disk I/O. A synchronous fs.appendFileSync stalls the event loop for the duration of each write — tiny
// on a fast disk, but real under load, on a busy or networked volume, or when an unauthenticated path (a
// failed login) is being hammered. This writer replaces that synchronous append with an ORDERED, batched,
// fire-and-forget async queue that keeps the loop free, and it holds a hard cap on the memory the queue can
// ever use so a stuck disk can never grow it without bound.
//
// Guarantees, in order of importance for a trading system:
//   1. It NEVER blocks or throws into the caller. append() only pushes to an in-memory array and schedules
//      a drain; every write happens later, off the caller's stack, with all errors swallowed. Logging can
//      never stall or crash trading.
//   2. Memory is hard-bounded. The queued bytes can never exceed MAX_PENDING_BYTES; if a stuck or slow disk
//      lets the backlog reach that ceiling the OLDEST lines are dropped (with a one-time warning). Protecting
//      the trading process from an out-of-memory kill is worth more than keeping every line in that
//      pathological case — and in normal operation the queue drains every tick and stays near empty.
//   3. Lines are written in call order. Exactly one write is ever in flight per file, and pending lines are
//      a FIFO batched into a single append, so nothing is reordered or interleaved.
//   4. Nothing is lost on a graceful shutdown. flushSync() writes everything still queued — and the batch
//      currently in flight — synchronously, and is wired to process 'exit'. Only a hard kill (SIGKILL /
//      power loss) can lose the sub-tick of lines not yet written: the correct trade for never blocking.
//
// The filesystem is injectable so the queue logic is unit-testable without touching a real disk.

const path = require('path');

const MAX_PENDING_BYTES = 8 * 1024 * 1024;   // hard ceiling on queued log bytes (≈8 MB) before dropping oldest


function createLogWriter(fsImpl) {

	const fsx = fsImpl || require('fs');
	const queues = new Map();   // fileName -> { pending: string[], draining: bool, inflight: string|null }
	let pendingBytes = 0;       // running total of bytes buffered across every queue (the memory we bound)
	let droppedWarned = false;

	function queueFor(fileName) {
		let q = queues.get(fileName);
		if (!q) { q = { pending: [], draining: false, inflight: null }; queues.set(fileName, q); }
		return q;
	}

	// Cost of one queued line in bytes: the text plus the newline it will be written with.
	function cost(s) { return s.length + 1; }

	// Drop the oldest line from whichever queue holds the most, to pull memory back under the ceiling.
	function dropOldest() {
		let big = null;
		for (const q of queues.values()) { if (q.pending.length && (!big || q.pending.length > big.pending.length)) { big = q; } }
		if (!big) { return false; }
		pendingBytes -= cost(big.pending.shift());
		return true;
	}

	// Enqueue one line for its file. Synchronous, near-instant, never throws — safe to call from anywhere,
	// including the trading loop.
	function append(fileName, line) {

		try {

			if (!fileName) { return; }

			const s = String(line == null ? '' : line);
			const q = queueFor(fileName);
			q.pending.push(s);
			pendingBytes += cost(s);

			// Hard memory bound: if a stuck/slow disk let the backlog reach the ceiling, drop the oldest
			// lines until back under it. Warn once so the condition is visible without spamming.
			if (pendingBytes > MAX_PENDING_BYTES) {
				while (pendingBytes > MAX_PENDING_BYTES && dropOldest()) { /* keep dropping oldest */ }
				if (!droppedWarned) {
					droppedWarned = true;
					try { console.error('[LogWriter] log backlog hit the ' + MAX_PENDING_BYTES + '-byte cap; dropping oldest lines to protect memory'); } catch (e) {}
				}
			}

			if (!q.draining) { q.draining = true; scheduleDrain(fileName); }
		}
		catch (e) { /* logging must never throw into a caller */ }
	}

	// Next-tick so several appends in the same tick coalesce into ONE write (fewer syscalls, order kept).
	function scheduleDrain(fileName) {
		try { setImmediate(() => drain(fileName)); }
		catch (e) { try { drain(fileName); } catch (e2) {} }
	}

	function drain(fileName) {

		const q = queues.get(fileName);
		if (!q) { return; }

		if (q.pending.length === 0) { q.draining = false; return; }

		// Take the whole current backlog as one ordered batch; new lines arriving during the write collect
		// in a fresh array and are drained after this write finishes — so writes never overlap or reorder.
		const batch = q.pending;
		q.pending = [];
		const buf = batch.join('\n') + '\n';
		pendingBytes -= buf.length;          // these bytes left `pending`; they now live in `inflight`
		q.inflight = buf;                    // kept until the write confirms, so flushSync can re-flush it on a forced exit

		writeBatch(fileName, buf, () => {
			q.inflight = null;
			if (q.pending.length > 0) { scheduleDrain(fileName); }
			else { q.draining = false; }
		});
	}

	function writeBatch(fileName, buf, done) {

		let mkdirTried = false;

		const attempt = () => {
			try {
				fsx.appendFile(fileName, buf, 'utf8', (err) => {
					// The per-instance log directory may not exist on the first write — create it and retry once.
					if (err && err.code === 'ENOENT' && !mkdirTried) {
						mkdirTried = true;
						fsx.mkdir(path.dirname(fileName), { recursive: true }, () => attempt());
						return;
					}
					// Any other error is swallowed: best-effort logging must never take down the process.
					done();
				});
			}
			catch (e) { done(); }
		};

		attempt();
	}

	// Synchronous last-resort flush for process exit (exit handlers must be synchronous). Writes every
	// queued line now, in order, including a batch that was handed to an async write but may not have landed
	// (its data is re-written, so at worst a forced exit mid-write duplicates a batch rather than losing it).
	// Never throws.
	function flushSync() {

		try {
			for (const [fileName, q] of queues) {

				const buf = (q.inflight || '') + (q.pending.length ? (q.pending.join('\n') + '\n') : '');
				q.pending = [];
				q.inflight = null;
				if (!buf) { continue; }

				try { fsx.appendFileSync(fileName, buf, 'utf8'); }
				catch (e) {
					try { fsx.mkdirSync(path.dirname(fileName), { recursive: true }); fsx.appendFileSync(fileName, buf, 'utf8'); }
					catch (e2) {}
				}
			}
			pendingBytes = 0;
		}
		catch (e) {}
	}

	return { append, flushSync, _queues: queues, _pendingBytes: () => pendingBytes };
}


// The process-wide singleton the logger uses. Each thread (the Hub main thread and every worker instance)
// loads its own module instance and so its own writer, which is correct: they log to different files.
const defaultWriter = createLogWriter();

// Flush anything still queued on a graceful exit so a normal shutdown never drops the tail of the log.
try { process.once('exit', () => defaultWriter.flushSync()); } catch (e) {}


module.exports = {
	append: defaultWriter.append,
	flushSync: defaultWriter.flushSync,
	create: createLogWriter   // factory for tests (injectable fs)
};
