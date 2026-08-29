'use strict';

// ── Diagnostics — clear-language explanations for warnings and integrity findings ──
//
// A single catalog that turns a stable machine code (e.g. "watchdog.capability_drift") into two
// short, human sentences: what the message MEANS and how to FIX it. The goal is that a user who
// sees a warning in the console or the Audit Log never has to guess — the next line tells them
// whether it matters and what to do.
//
// It is deliberately simple and self-contained: a pure data map plus a couple of tiny lookup
// helpers, with no DB, network, or side effects, so it is safe to call from anywhere (including the
// boot path) and easy to unit-test. Any subsystem can reuse it — the Watchdog annotates each
// finding, the version check annotates its warning, and a read-only endpoint hands the same catalog
// to the browser so the Audit Log can show the explanation on hover.
//
// Adding coverage for a new message is one entry below — no wiring changes. A code with no entry
// degrades gracefully: callers simply fall back to the bare message they already print today.

// code → { meaning, fix }. Keep each field to one or two calm sentences, American English, no
// jargon the reader can't act on. "meaning" says what happened and whether it is harmful; "fix"
// says the concrete next step (and explicitly says "nothing to do" when that is the honest answer).
const CATALOG = {

	// ── Access control / API keys ──
	'watchdog.capability_drift': {
		meaning: 'An active API key holds a permission that its owner can no longer grant — usually because the owner\'s role was narrowed after the key was made, or the owning user account was removed. The key keeps working, but it now carries more access than its owner could hand out today.',
		fix: 'Open Access Control → API Keys and either rotate or revoke the listed key, or restore the owner\'s role. A key that simply shows the built-in operator as owner is normal and is not reported.'
	},

	// ── Route / capability wiring (these indicate a build problem, not something you misconfigured) ──
	'watchdog.ungated_routes': {
		meaning: 'A route that changes data was found without a permission check in front of it. This is an internal wiring check, not something you set — it points at a build or version problem rather than your configuration.',
		fix: 'Update to a released version. If it persists on an official build, report the listed route names — the platform still runs, but treat that route as unprotected until it is fixed.'
	},
	'watchdog.undergated_routes': {
		meaning: 'A route that changes data is protected only by a read-level permission, so a read-only key could perform a write there. Like the check above, this is an internal wiring issue, not a setting of yours.',
		fix: 'Update to a released version and report the listed routes if the warning continues on an official build.'
	},
	'watchdog.unknown_capability': {
		meaning: 'A permission name used in the role or route tables does not exist in the permission catalog — typically a typo introduced in a build. A misspelled permission can silently weaken a gate.',
		fix: 'Update to a released version. Report the listed names if it appears on an official build; no action is needed on your side.'
	},

	// ── AI safety and knowledge base ──
	'watchdog.mutating_ai_tool': {
		meaning: 'A tool available to the AI assistant has a name that looks like it could change something (for example "create" or "sell"). The assistant is required to be strictly read-only and must never be able to place or alter a trade, so this is flagged as a safety violation.',
		fix: 'Do not rely on the AI assistant until this is resolved, and report the listed tool name. On an official build this should never appear; updating to a released version is the fix.'
	},
	'watchdog.ai_learning_coverage': {
		meaning: 'The AI assistant\'s local knowledge base is missing example coverage for one or more of its tools. The assistant still works; its answers for the uncovered areas may just be less sharp.',
		fix: 'Nothing is required — the knowledge base rebuilds itself over time. This is informational.'
	},
	'watchdog.ai_learning_orphans': {
		meaning: 'The AI knowledge base contains entries for tools that no longer exist. These stale entries are harmless and are ignored when answering.',
		fix: 'Nothing is required — the knowledge base prunes itself on the next rebuild. This is informational.'
	},
	'watchdog.tool_guide_coverage': {
		meaning: 'One or more of the AI assistant\'s tools is missing from its usage guide. The assistant still works; it may just be slightly less sure when to reach for the uncovered tool.',
		fix: 'Nothing is required — this is informational. On an official build it should not appear; updating to a released version is the fix.'
	},
	'watchdog.tool_schema_mismatch': {
		meaning: 'An AI tool\'s declared inputs do not match what the tool actually accepts. The assistant may misuse that tool, but it cannot affect trading (all AI tools are read-only).',
		fix: 'Update to a released version. Report the listed tool if it continues on an official build.'
	},

	// ── Secrets and storage ──
	'watchdog.undecryptable_secret': {
		meaning: 'A stored credential (such as an exchange key or an email password) could not be decrypted. This almost always means the encryption key changed — for example the config was copied from another machine or the instance identity changed.',
		fix: 'Re-enter the affected credential in Settings so it is encrypted with this instance\'s current key. Trading is unaffected for exchanges whose keys still decrypt.'
	},
	'watchdog.log_secret_detected': {
		meaning: 'Something that looks like a secret (a token or key) was found written in a log file. Logs stay on this machine and are not sent anywhere, but a secret should not live in them.',
		fix: 'Treat the affected credential as exposed and rotate it to be safe, then clear or archive the old log file.'
	},
	'watchdog.ip_filter_spoofable': {
		meaning: 'You have an IP allow/deny filter turned on, but SymBot is set to trust the client IP from forwarded headers (the default). If this instance can be reached directly — not only through a reverse proxy you control — someone could send a fake forwarded header to appear as an allowed IP and slip past the filter.',
		fix: 'Put a reverse proxy in front that overwrites the client-IP headers, or if there is no proxy, set security.trust_proxy to false in the configuration so those headers are ignored and the real socket IP is used.'
	},

	// ── Database and schedules ──
	'watchdog.missing_db_index': {
		meaning: 'An index the platform relies on for fast queries is not present in the database. Everything still works; some views may just be slower than usual on a large history.',
		fix: 'Indexes are created automatically at startup. If this persists, confirm the database user is allowed to create indexes, then restart.'
	},
	'watchdog.stranded_scoped_rows': {
		meaning: 'Some of this instance\'s data (e.g. signal activity, chat history, API keys) is still recorded under a previous Server ID after the ID changed, so it is hidden from the instance and left out of its backups.',
		fix: 'A restart re-homes these rows to the current Server ID automatically. If the warning persists after a restart, report it.'
	},
	'watchdog.orphaned_schedule_types': {
		meaning: 'A saved schedule refers to a task type that has no handler in this build, so it can never run. This does not affect anything else — the orphaned schedule is simply skipped.',
		fix: 'Delete the listed schedule, or update to a version that includes its task type. Your other schedules are unaffected.'
	},
	'watchdog.schedule_heartbeat': {
		meaning: 'One or more enabled schedules are not primed to fire — for example a schedule whose cron expression was invalid was skipped when the scheduler armed at startup, so it will never run. Trading runs on its own loop and is not affected, but the listed scheduled jobs (backups, reports) will not fire until this is resolved.',
		fix: 'Open Schedules and check the listed task(s): correct an invalid time/cron and re-save, or disable the schedule if it is no longer needed. Restart to re-arm if needed.'
	},
	'watchdog.recipe_file_integrity': {
		meaning: 'A built-in scheduled-task definition file could not be read or parsed. Only that one definition is affected; the rest of the platform is fine.',
		fix: 'Reinstall or restore the affected file (a fresh copy of the release fixes it). The broken definition is skipped until then.'
	},
	'watchdog.backup_last_run_failed': {
		meaning: 'Your scheduled database backup failed its most recent run(s), so this instance may not have a fresh backup. Trading is not affected — it runs from the live database — but you would have less to restore from if you needed to. This is a quiet reminder shown at startup; a persistent failure also raises its own alert.',
		fix: 'Open Schedules, find "System backup", and click "Run now" to run the full backup and see any error (or check the logs for the failure reason — common causes: a full or read-only disk, or an off-site/SFTP destination that is unreachable). The warning clears automatically once a backup succeeds.'
	},
	'watchdog.offsite_backup_last_upload_failed': {
		meaning: 'Your local database backup is being created, but its off-site (SFTP) copy has failed to upload its most recent time(s), so the off-site backup may be stale. The off-site upload runs in the background and never blocks or fails the local backup, which is why this is surfaced separately. Trading is not affected.',
		fix: 'Check the off-site destination in the Backups configuration (host, credentials, path, and that the server is reachable) and the logs for the "SFTP upload failed" reason. To test after a change, open Schedules → "System backup" → "Run now", which repeats the full upload. The warning clears automatically once an off-site upload succeeds.'
	},

	// ── Filesystem, auth safety, and trading integrity ──
	'watchdog.data_dir_unwritable': {
		meaning: 'A directory the platform must write to — where it saves settings, logs, or backups — is not writable. This is usually a file-permission problem, a read-only disk, or a full disk. Trading itself runs from the database and is not affected, but saving a config change, writing logs, or creating a backup will fail quietly.',
		fix: 'Check the ownership and permissions of the listed directory so the account running the platform can write to it, and confirm the disk is not full or mounted read-only. Restart afterward to clear the warning.'
	},
	'watchdog.no_active_admin': {
		meaning: 'You have created user accounts, but none of them is an active admin or owner. With no active administrator, no one can open Access Control to manage users or keys — you could lock yourself out.',
		fix: 'Promote one account to admin or owner, or re-enable a disabled administrator. If you are already locked out, the console has a recovery command to restore an owner account.'
	},
	'watchdog.over_privileged_user': {
		meaning: 'A non-owner account has been granted owner-level (full "*") access. That account can do everything the owner can — more than a delegated user usually needs.',
		fix: 'Review the listed account(s) in Access Control and reduce them to only the capabilities they need, unless the broad access is intentional.'
	},
	'watchdog.default_password': {
		meaning: 'The owner login password is still the default ("admin"). Anyone who can reach this instance over the network could log in and control it.',
		fix: 'Change the owner password on the Configuration page before exposing SymBot to any network.'
	},
	'watchdog.orphaned_open_deals': {
		meaning: 'One or more OPEN deals point at a bot that no longer exists — usually because the bot was deleted while it still had a deal running. The trading loop works through its bots, so a deal with no bot is never advanced and its funds can sit untouched.',
		fix: 'Review the listed deals in the Trading Journal. Recreate the bot to let the deal resume, or close the deal manually to release its funds. This never resolves itself, so it is worth acting on.'
	},
	'watchdog.duplicate_open_deals': {
		meaning: 'More than one OPEN deal exists for the same bot and trading pair. SymBot allows only one open deal per pair on a bot at a time, so this points at a deal that was created in a way that bypassed that guard (for example a crash mid-start, or the database being edited directly). The trading loop would then manage two deals against the same pair.',
		fix: 'Review the listed pair(s) in the Trading Journal and close or cancel the extra deal so only one open deal remains per bot and pair. This does not resolve itself.'
	},
	'watchdog.deal_missing_orders': {
		meaning: 'One or more OPEN deals are more than ten minutes old but have never filled a single order — a half-started deal that never actually entered a position, yet still holds its bot\'s slot for that pair so no new deal can open there.',
		fix: 'Review the listed deal(s) in the Trading Journal and cancel the stuck deal to free the pair. Check the log around the deal\'s start time for the base-order failure that stranded it (for example an exchange or funds error).'
	},
	'watchdog.signal_activity_recognizer': {
		meaning: 'The internal recognizer that labels inbound webhook signals (entry / add funds / close / panic sell) for the Signal Activity view no longer maps a command correctly — an internal wiring problem from a build, not a setting of yours. Signals still reach your bots and trade normally; they just may not be recorded on the Signal Activity screen.',
		fix: 'Update to a released version. If the warning continues on an official build, report the listed path — trading is unaffected, only the activity record is.'
	},

	// ── Audit-log tamper evidence ──
	'watchdog.audit_tampering': {
		meaning: 'The audit log is sealed as a hash chain — each entry carries a fingerprint of the one before it — so that editing, deleting, or reordering past entries can be detected. This check found a break in that chain: a recorded action appears to have been altered or removed after it was written. On a healthy system this never happens, so it is worth taking seriously; it can also, more rarely, come from the database being edited directly or restored from an inconsistent copy.',
		fix: 'Treat the audit log as no longer fully trustworthy from the reported point onward and investigate who has direct database access. The detail names the affected entry positions. Trading is unaffected — this is a records-integrity alert, not a trading fault — and normal maintenance (the automatic pruning of old entries) never triggers it.'
	},

	// ── Generic fallback for a check that errored ──
	'watchdog.check_failed': {
		meaning: 'One of the startup self-checks raised an error while running, so its result is unknown for this boot. This never blocks startup or trading — the check simply could not complete.',
		fix: 'The detail shows the underlying error. If it repeats on every start, report it; a one-time occurrence can be ignored.'
	},

	// ── App version comparison (shown on startup) ──
	'version.newer_than_remote': {
		meaning: 'This install\'s version is higher than the latest version published in the update source. That is expected when you run a pre-release or a locally built copy that is ahead of the public release — it is not an error and nothing is wrong.',
		fix: 'Nothing to do. The message is informational; it disappears once the public release catches up to your version.'
	},
	'version.outdated': {
		meaning: 'A newer version is available in the update source than the one you are running.',
		fix: 'Update when convenient to get the latest fixes and features. There is no rush unless a release notes an urgent fix.'
	}
};

// Look up the explanation for a code. Returns { meaning, fix } or null when the code is not in the
// catalog (the caller then keeps its plain message). Single exit.
function explain(code) {

	const entry = (code && Object.prototype.hasOwnProperty.call(CATALOG, code)) ? CATALOG[code] : null;
	return entry ? { meaning: entry.meaning, fix: entry.fix } : null;
}

// Format an explanation as indented console lines, ready to log beneath the bare message. Returns
// [] when the code is unknown, so a caller can always spread the result unconditionally:
//
//   logger('WATCHDOG — ' + action + ': ' + detail, true);
//   Diagnostics.annotate(action).forEach(line => logger(line, true));
//
// The arrow + indent visually tie the explanation to the line above it. Single exit.
function annotate(code) {

	const e = explain(code);
	const lines = [];

	if (e) {
		lines.push('    ↳ What it means: ' + e.meaning);
		lines.push('    ↳ How to fix:   ' + e.fix);
	}

	return lines;
}

// The whole catalog, shallow-copied, for handing to the browser via a read-only endpoint so the
// Audit Log can show the same explanations on hover. Single exit.
function catalog() {

	const out = {};
	Object.keys(CATALOG).forEach(k => { out[k] = { meaning: CATALOG[k].meaning, fix: CATALOG[k].fix }; });
	return out;
}

module.exports = { CATALOG, explain, annotate, catalog };
