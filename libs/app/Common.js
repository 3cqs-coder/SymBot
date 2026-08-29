'use strict';

const fs   = require('fs');
const fsp  = require('fs').promises;
const path = require('path');
const os   = require('os');
const multer = require('multer');

const pathRoot = path.resolve(__dirname, ...Array(2).fill('..'));

const crypto = require('crypto');
const IpFilter = require('./IpFilter.js');
const Notifications = require('./Notifications.js');
const ArtifactIndex = require('./ArtifactIndex.js');
const Convert = require('ansi-to-html');
const fetch = require('node-fetch-commonjs');
const packageJson = require(pathRoot + '/package.json');

// escapeXML: the converter HTML-escapes the text content itself (so a log/notification line that
// happens to contain <, > or & — a pair name, an error echoing user input — can never inject markup),
// while still emitting its own color <span>s. This makes toHtml() output safe to render directly in
// the browser (the live Logs view and the notification panel both do), colors intact.
const convertAnsi = new Convert({ escapeXML: true });

// Convert an ANSI-colored log/notification line to browser-safe colored HTML. The SINGLE canonical
// converter for both the instance and the Hub (which formerly built its own Convert instance), so the
// load-bearing escapeXML XSS-safety setting can never drift between them. Coerces null/undefined to ''.
function ansiToHtml(str) {
	return convertAnsi.toHtml(String(str == null ? '' : str));
}


// Race a promise against a timeout so a single hung call can never stall its caller. The ONE shared
// implementation behind the thin per-module withTimeout wrappers (trading market-data fetches, the
// scheduler run guard, the WebSocket handler guard, the AI judge/model calls) — the timeout LOGIC lives
// here once instead of in four copies that could drift, while each caller keeps its own behavior via opts:
//   • opts.message       custom timeout error message (default 'timed out after <ms>ms').
//   • opts.timedOut      tag the rejection with err.timedOut = true (the scheduler distinguishes a timeout
//                        from a genuine handler error on this flag).
//   • opts.resolveValue  when present, RESOLVE with this value on timeout instead of rejecting — a fail-open
//                        path (the AI judge passes '' so a hung model can never stall the chat).
// The timer is always cleared once the race settles, and is unref'd so a pending timeout can never hold the
// process open. JavaScript cannot cancel the underlying work; the point is to free the caller, not the work.
function withTimeout(promise, ms, opts) {
	opts = opts || {};
	const hasResolveValue = Object.prototype.hasOwnProperty.call(opts, 'resolveValue');
	let timer;
	const guard = new Promise((resolve, reject) => {
		timer = setTimeout(() => {
			if (hasResolveValue) { resolve(opts.resolveValue); return; }
			const err = new Error(opts.message || ('timed out after ' + ms + 'ms'));
			if (opts.timedOut) { err.timedOut = true; }
			reject(err);
		}, ms);
		if (timer && typeof timer.unref === 'function') { timer.unref(); }
	});
	return Promise.race([ promise, guard ]).finally(() => clearTimeout(timer));
}

// Remove ANSI color/escape sequences (from the `colors` library) so a line can be written to a file
// as plain text. Single source of truth reused by both logger paths (instance + Hub) so they can't drift.
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
function stripAnsi(str) { return String(str == null ? '' : str).replace(ANSI_RE, ''); }

const logNotifications = pathRoot + '/logs/services/notifications/notifications{INSTANCE_NAME}.log';

let shareData;


async function getConfig(fileName) {

	let data;
	let success = false;

	try {
		data = JSON.parse(
			fs.readFileSync(pathRoot + '/config/' + fileName, {
				encoding: 'utf8',
				flag: 'r',
			})
		);

		success = true;
	} catch (e) {
		data = e;
	}

	return {
		success,
		data
	};
}


async function saveConfig(fileName, data, updated) {

	let err;
	let success = false;

	if ((updated == undefined || updated == null || updated == '') && updated !== false) {

		updated = true;
	}

	try {

		if (updated) {

			data.updated = new Date().toISOString();
		}

		// Atomic write: serialize to a temp file, then rename over the target. rename() is atomic on the
		// same filesystem, so a crash mid-write — or a concurrent reader (e.g. the Hub reading an
		// instance's app.json) — never observes a truncated/torn config. A failed write leaves the
		// previous good file intact.
		const target = pathRoot + '/config/' + fileName;
		const tmp = target + '.tmp';

		fs.writeFileSync(tmp, JSON.stringify(data, null, 4));
		fs.renameSync(tmp, target);

		success = true;
	} catch (e) {
		err = e;
	}

	return {
		success,
		data: err
	};
}


// Serialize the whole-file app.json read-modify-write. _updateConfigImpl reads the entire config,
// mutates it, and writes it back with long awaits in between (secret re-encryption, a live DB
// connect test, an SFTP test upload). Two overlapping /config saves would otherwise drop each
// other's fields (last writer wins). This promise-chain mutex makes config saves run one at a time.
let _configSaveChain = Promise.resolve();

async function updateConfig(req, res) {

	let release;
	const prior = _configSaveChain;
	_configSaveChain = new Promise((resolve) => { release = resolve; });

	// Wait for any in-flight save; a prior rejection must not deadlock later saves.
	try { await prior; }
	catch (e) { /* ignore */ }

	try { return await _updateConfigImpl(req, res); }
	finally { release(); }
}


async function _updateConfigImpl(req, res) {

	const body = req.body;
	const sessionId = req.session.id;
	const mongodburl = body.mongodburl;
	const password = body.password;
	const passwordNew = body.passwordnew;
	const apiKey = body.apikey;

	const telegram = body.telegram_enabled;
	const telegramTokenId = body.telegram_token_id;
	const telegramUserId = body.telegram_user_id;

	const signals3CQS = body.signals_3cqs_enabled;
	const signals3CQSApiKey = body.signals_3cqs_api_key;

	const ollamaHost = body.ollama_host;
	const ollamaApiKey = body.ollama_api_key;
	const ollamaModel = body.ollama_model;

	const openaiApiKey = body.openai_api_key;
	const openaiModel = body.openai_model;
	const openaiBaseUrl = body.openai_base_url;

	const aiProviderSelected = body.ai_provider;

	const cronBackup = body.cron_backup_enabled;
	const cronBackupSchedule = body.cron_backup_schedule;
	const cronBackupPassword = body.cron_backup_password;
	const cronBackupMax = Number(body.cron_backup_max ?? 1) || 1;
	const cronBackupIncludeChats = convertBoolean(body.cron_backup_include_chats, true);
	const cronBackupIncludeSchedules = convertBoolean(body.cron_backup_include_schedules, true);
	// Configuration (exchange keys + settings) is NEVER bundled into a scheduled/off-site backup unless
	// the operator explicitly turns it on — default false so a routine SFTP upload can't ship credentials.
	const cronBackupIncludeConfig = convertBoolean(body.cron_backup_include_config, false);

	const ctxCompEnabled    = convertBoolean(body.ctx_compression_enabled, true);
	const ctxCompThreshold  = parseInt(body.ctx_compression_threshold) || 80000;
	const ctxCompProtectN   = parseInt(body.ctx_compression_protect_n)  || 10;

	const dealCtxEnabled    = convertBoolean(body.deal_context_enabled, false);
	const dealCtxUseRouter  = convertBoolean(body.deal_context_use_router, true);
	const dealCtxModel      = typeof body.deal_context_router_model === 'string' ? body.deal_context_router_model.trim() : '';
	const dealCtxTimeout    = Math.min(Math.max(parseInt(body.deal_context_router_timeout_ms) || 12000, 1000), 60000);

	// Generation settings. All optional: an empty analysis model falls back to the
	// chat model, and empty temperature / token cap leave the provider defaults.
	const genAnalysisModel  = typeof body.ai_analysis_model === 'string' ? body.ai_analysis_model.trim() : '';
	const genChatTempParsed = parseFloat(body.ai_chat_temperature);
	const genChatTemp       = isNaN(genChatTempParsed) ? '' : Math.min(Math.max(genChatTempParsed, 0), 2);
	const genMaxTokParsed   = parseInt(body.ai_max_tokens, 10);
	const genMaxTokens      = (isNaN(genMaxTokParsed) || genMaxTokParsed <= 0) ? '' : genMaxTokParsed;
	// Optional context window (Ollama num_ctx). Empty leaves the provider default; a value is passed to
	// the model AND sizes the context-eviction guard so the grounding prompt always fits.
	const genNumCtxParsed   = parseInt(body.ai_num_ctx, 10);
	const genNumCtx         = (isNaN(genNumCtxParsed) || genNumCtxParsed <= 0) ? '' : genNumCtxParsed;

	// AI tools (experimental): let the chat model look up deal/log data via read-only
	// tools instead of the deal-context router. Off by default.
	const toolsEnabled      = convertBoolean(body.ai_tools_enabled, false);
	const toolsMaxIterParsed = parseInt(body.ai_tools_max_iterations, 10);
	const toolsMaxIter      = (isNaN(toolsMaxIterParsed) || toolsMaxIterParsed <= 0) ? 5 : Math.min(toolsMaxIterParsed, 10);
	const toolsVerify       = convertBoolean(body.ai_tools_verify, false);
	const toolsExplore      = convertBoolean(body.ai_tools_explore, false);
	const toolsDeepExplore  = convertBoolean(body.ai_tools_deep_explore, false);

	// AI learning (experimental): the chat records patterns-only "question → tools"
	// notes and reuses similar past ones to get more accurate over time. Off by default.
	const learningEnabled   = convertBoolean(body.ai_learning_enabled, false);

	const cbEnabled        = convertBoolean(body.cb_enabled, true);


	const cbDealRatio      = Math.min(Math.max(parseFloat(body.cb_deal_ratio_threshold)   || 0.5,  0.1), 1.0);
	const cbDealWindow     = Math.min(Math.max(parseInt(body.cb_deal_ratio_window_secs)   || 30,   5),   300);
	const cbPriceDrop      = Math.min(Math.max(parseFloat(body.cb_price_drop_percent)     || 5.0,  0.5), 50.0);
	const cbPriceWindow    = Math.min(Math.max(parseInt(body.cb_price_drop_window_secs)   || 60,   10),  600);
	const cbPriceDropEnabled = convertBoolean(body.cb_price_drop_enabled, true);
	const cbPauseDuration  = Math.min(Math.max(parseInt(body.cb_pause_duration_secs)      || 60,   10),  600);
	const cbRepeatWindow   = Math.min(Math.max(parseInt(body.cb_repeat_alert_window_secs) || 3600, 60),  86400);
	const cbPriceZeroAlert = Math.min(Math.max(parseInt(body.cb_price_zero_alert_count)   || 4,    2),   20);

	// Portfolio-loss trigger (opt-in, default off): pause new deals when realized losses over the
	// rolling window reach the limit. loss_limit 0 = disabled. Window clamped 1h–30d.
	const cbPortfolioLossEnabled = convertBoolean(body.cb_portfolio_loss_enabled, false);
	const cbLossWindowHours      = Math.min(Math.max(parseInt(body.cb_loss_window_hours) || 24, 1), 720);
	const cbLossLimit            = Math.max(parseFloat(body.cb_loss_limit) || 0, 0);

	const sftp = body.sftp_enabled;
 	const sftpHost = body.sftp_host;
	const sftpPort = Number(body.sftp_port ?? 22) || 22;
	const sftpUsername = body.sftp_username;
	const sftpPassword = body.sftp_password;
	const sftpPrivateKeyInput = body.sftp_private_key;
	const sftpPrivateKeyClear = body.sftp_private_key_clear;
	const sftpPassphrase = body.sftp_passphrase;
	const sftpRemoteDirectory = body.sftp_remote_directory;

	// Outbound mailer (SMTP). The password is optional on save: a blank field preserves the
	// stored (encrypted) value so a routine save never erases it — the same convention the
	// SFTP private key uses.
	const mailerEnabled = convertBoolean(body.mailer_enabled, false);
	const mailerHost = (body.mailer_host || '').trim();
	const mailerPort = Number(body.mailer_port ?? 587) || 587;
	const mailerSecure = convertBoolean(body.mailer_secure, false);
	const mailerUser = (body.mailer_user || '').trim();
	const mailerFrom = (body.mailer_from || '').trim();
	const mailerPassword = body.mailer_password;

	let pairButtons = body.pairbuttons;
	let pairBlacklist = body.pairblacklist;

	let sftpEnabled = convertBoolean(sftp, false);
	let telegramEnabled = convertBoolean(telegram, false);
	let signals3CQSEnabled = convertBoolean(signals3CQS, false);
	let cronBackupEnabled = convertBoolean(cronBackup, false);

	// Provider dropdown is the single source of truth for which AI provider is active
	const aiProvider = (aiProviderSelected === 'openai' || aiProviderSelected === 'ollama') ? aiProviderSelected : 'none';
	const ollamaEnabled = aiProvider === 'ollama';
	const openaiEnabled = aiProvider === 'openai';

	let dbErr;
	let sftpPasswordFinal;
	let sftpPassphraseFinal;
	let sftpPrivateKeyFinal;
	let cronBackupPasswordFinal;
	let hubInstance = false;
	let dataMessage = 'Configuration Updated';

	const instanceName = await getInstanceName();

	if (instanceName && instanceName.trim() !== '') {

		hubInstance = true;
	}

	const appConfigFile = shareData.appData.app_config;

	if (pairButtons == undefined || pairButtons == null || pairButtons == '') {

		pairButtons = [];
	}
	else if (typeof pairButtons === 'string') {

		pairButtons = [pairButtons];
	}

	if (pairBlacklist == undefined || pairBlacklist == null || pairBlacklist == '') {

		pairBlacklist = [];
	}
	else if (typeof pairBlacklist === 'string') {

		pairBlacklist = [pairBlacklist];
	}

	const pairButtonsUC = pairButtons.map(data => data.toUpperCase());
	const pairBlacklistUC = pairBlacklist.map(data => data.toUpperCase());

	const dataPass = shareData.appData.password.split(':');

	let success = await verifyPasswordHash( { 'salt': dataPass[0], 'hash': dataPass[1], 'data': password } );

	if (success) {

		// Record the configuration change in the audit trail (settings and/or credentials updated).
		auditEvent(req, 'config.update', '', '');

		let disconnectClients = false;

		let data = await getConfig(appConfigFile);

		// If app.json can't be read/parsed at save time, `data.data` is an Error, not config — proceeding
		// would throw on the first field write and (the route calls this un-awaited) hang the request with
		// no response. Fail cleanly instead so trading configuration is never left half-applied.
		if (!data || data.success === false || !data.data || typeof data.data !== 'object') {

			res.send({ 'success': false, 'data': 'Unable to read the current configuration — no changes were made.' });
			return;
		}

		let appConfig = data.data;

		if (passwordNew != undefined && passwordNew != null && passwordNew != '') {

			disconnectClients = true;

			auditEvent(req, 'auth.password_change', '', 'configuration password changed');

			const dataPassNew = await genPasswordHash({ 'data': passwordNew, 'iterations': PASSWORD_PBKDF2_ITERATIONS });

			const passwordHashed = dataPassNew['salt'] + ':' + dataPassNew['hash'];

			// Re-encrypt all existing app.json secrets under the new password before
			// updating shareData.appData.password. The old password hash is still
			// in shareData.appData.password at this point — that is the same key
			// material used when the secrets were originally stored. The new hash
			// (passwordHashed) is what decrypt/encrypt will use going forward. The path
			// set is the single shared APP_SECRET_PATHS list (System.js), so this flow,
			// the console re-key, and the decryptability watchdog can never drift.
			const secretsToReEncrypt = (shareData.System.APP_SECRET_PATHS || []).map(key => ({ key }));

			const oldPasswordKey = shareData.appData.password;

			for (const secret of secretsToReEncrypt) {

				const encryptedValue = secret.key.reduce((obj, k) => obj?.[k], appConfig);

				if (encryptedValue) {

					// Decrypt with the current (old) password hash
					const decObj = await shareData.System.decrypt(encryptedValue, oldPasswordKey);

					if (decObj.success) {

						// Re-encrypt with the new password hash
						const reEncObj = await shareData.System.encrypt(decObj.data, passwordHashed);

						// Verify the re-encrypted value decrypts back under the NEW key before committing it —
						// the same round-trip guard the bot-config and console re-key paths use, so a password
						// change can never write a secret it cannot recover (which would orphan it). If the
						// verify fails the old ciphertext is left in place and the decryptability watchdog
						// surfaces it on the next boot rather than silently losing the secret.
						if (reEncObj.success) {

							const checkObj = await shareData.System.decrypt(reEncObj.data, passwordHashed);

							if (checkObj.success && checkObj.data === decObj.data) {

								// Write re-encrypted value back into appConfig
								const keys = secret.key;
								const target = keys.slice(0, -1).reduce((obj, k) => obj[k], appConfig);
								target[keys[keys.length - 1]] = reEncObj.data;
							}
						}
					}
				}
			}

			// Re-encrypt the exchange credentials in this instance's bot-config file under the new
			// password. They use the SAME password-derived key as the app.json secrets above, so a
			// password change must re-key them too — otherwise connectExchange would (correctly)
			// refuse to send an un-decryptable key and trading would stop. Each field is proven to
			// round-trip under the NEW key before it is written; a value that can't be recovered
			// under the old key is left untouched (never double-encrypted). The file name comes from
			// appData.bot_config, so a Hub instance with a differently-named bot config is covered.
			//
			// Money-path safety: if these credentials are re-encrypted but CANNOT be persisted (a
			// read-only/locked config volume, a disk error, or an unexpected throw mid-rekey), the
			// password change must be ABORTED. Committing it anyway would move the app password anchor
			// to the new value while the on-disk exchange keys stay encrypted under the OLD one — so
			// connectExchange would (correctly) refuse them and trading would stop until the operator
			// re-entered the keys. botCredsPersistFailed carries that condition out to the abort check
			// below, which returns before the anchor / backup-secret rekey / app.json write, leaving a
			// fully consistent OLD state.
			//
			// Crash safety across the two-file window: the bot-config write below is the FIRST on-disk
			// commit and the app.json write (further down) is the LAST. Record a re-key journal now, before
			// either is touched, so that a crash BETWEEN them is finished (or safely discarded) by
			// recoverRekeyJournal() on the next boot instead of leaving the anchor and the exchange creds
			// disagreeing. Cleared on the abort path and after the app.json save succeeds.
			writeRekeyJournal({ old: oldPasswordKey, new: passwordHashed, app_config: appConfigFile, bot_config: shareData.appData.bot_config });

			let botCredsPersistFailed = false;

			try {

				const botConfigFile = shareData.appData.bot_config;

				if (botConfigFile) {

					const botData = await getConfig(botConfigFile);
					const botCfg = botData && botData.data;

					if (botCfg) {

						let botChanged = false;

						for (const field of ['apiKey', 'apiSecret', 'apiPassphrase', 'apiPassword']) {

							const val = botCfg[field];

							if (!val || typeof val !== 'string') { continue; }

							let plaintext = null;

							if (isEncrypted(val)) {

								// Encrypted under the OLD key — recover the plaintext.
								const decObj = await shareData.System.decrypt(val, oldPasswordKey);
								if (decObj && decObj.success && decObj.data != null) { plaintext = decObj.data; }
								// else: can't recover under the old key → leave as-is, do NOT double-encrypt.
							}
							else {

								// Legacy plaintext → take this chance to encrypt it under the new key.
								plaintext = val;
							}

							if (plaintext != null) {

								const reEnc = await shareData.System.encrypt(plaintext, passwordHashed);

								if (reEnc && reEnc.success && reEnc.data) {

									// Only trust the re-encrypted value if it decrypts back to the exact
									// plaintext under the NEW key.
									const check = await shareData.System.decrypt(reEnc.data, passwordHashed);

									if (check && check.success && check.data === plaintext) {

										botCfg[field] = reEnc.data;
										botChanged = true;
									}
									else {

										logger('Password change: bot credential "' + field + '" failed round-trip verification under the new key — left unchanged. Re-enter it if the exchange rejects the connection.');
									}
								}
							}
						}

						if (botChanged) {

							const botSaveRes = await saveConfig(botConfigFile, botCfg);

							// saveConfig fails closed ({ success: false }) on a read-only/locked config
							// volume or a disk error — flag it so the password change is aborted below.
							if (!botSaveRes || botSaveRes.success === false) { botCredsPersistFailed = true; }
						}
					}
				}
			}
			catch (botReEncErr) {

				// An unexpected throw means the re-key could not complete — treat it the same as a failed
				// persist and abort, rather than committing a password whose exchange keys we couldn't re-key.
				botCredsPersistFailed = true;

				logger('Password change: failed to re-encrypt bot exchange credentials: ' + (botReEncErr && botReEncErr.message ? botReEncErr.message : botReEncErr));
			}

			if (botCredsPersistFailed) {

				// Abort BEFORE the password anchor, backup-secret rekey, and app.json write — trading is
				// unaffected because nothing was committed and the exchange keys still decrypt under the
				// unchanged password. Nothing was persisted under the new key, so discard the re-key journal.
				clearRekeyJournal();

				res.send({ 'success': false, 'data': 'Password change aborted: your exchange credentials could not be re-encrypted under the new password (the bot configuration file may be read-only or unwritable). Your password was NOT changed and trading is unaffected. Fix the file permission/disk issue and try again.' });

				return;
			}

			// The backup's own secrets now live on its schedule row (schedules collection),
			// not in app.json, so re-encrypt them there under the new password as well.
			await shareData.System.reEncryptBackupSecrets(oldPasswordKey, passwordHashed);

			appConfig['password'] = passwordHashed;
			shareData['appData']['password'] = passwordHashed;

			// Keep the "still on the default password" nudge in sync: it clears the moment the
			// operator sets any non-default password, and (unlikely) re-arms if they set it back
			// to "admin". Drives a UI hint only — never gates login or trading.
			shareData['appData']['default_password'] = (passwordNew === 'admin');

			// Remove all other existing Mongo-backed sessions to require login again. In CONFIGURATION
			// MODE there is no database connection (and sessions live in a file store, not Mongo), so
			// guard the access — without this, dereferencing the undefined connection throws, and because
			// the /config route calls updateConfig un-awaited the throw becomes an unhandled rejection and
			// the password-change request hangs on a fresh install. Best-effort: a purge failure must
			// never block a password change.
			try {

				const conn = shareData.DB && shareData.DB.mongoose && shareData.DB.mongoose.connection;

				if (!shareData.appData.config_mode && conn && conn.readyState === 1 && conn.db) {

					const collection = conn.db.collection('sessions');

					await collection.deleteMany({ '_id': { '$ne': sessionId } }).catch(e => {});
				}
			}
			catch (sessionPurgeErr) {

				logger('Password change: session purge skipped (' + (sessionPurgeErr && sessionPurgeErr.message ? sessionPurgeErr.message : sessionPurgeErr) + ')');
			}
		}

		if (apiKey != undefined && apiKey != null && apiKey != '') {

			disconnectClients = true;

			const apiKeyHashed = await genApiKey(apiKey);

			appConfig['api']['key'] = apiKeyHashed;
			shareData['appData']['api_key'] = apiKeyHashed;

			// Set API token
			await setToken();
		}

		if (disconnectClients) {

			await shareData.WebServer.disconnectAllClients();
		}

		// A blank field leaves sftpPasswordFinal / sftpPassphraseFinal undefined so the appConfig write
		// below preserves the existing stored value — the same write-only convention as the private key
		// and SMTP password. The browser is never sent these secrets, so a save that doesn't retype them
		// must not wipe them.
		if (sftpPassword) {

			const sftpPasswordEncObj = await shareData.System.encrypt(sftpPassword, shareData.appData.password);

			if (sftpPasswordEncObj.success) {

				sftpPasswordFinal = sftpPasswordEncObj.data;
			}
		}
		// An explicit [Clear] forces the stored value to empty (Final='' resolves to '' below); typing a new
		// value cancels the clear client-side, so the two never conflict.
		if (body.sftp_password_clear === '1') { sftpPasswordFinal = ''; }

		if (sftpPassphrase) {

			const sftpPassphraseEncObj = await shareData.System.encrypt(sftpPassphrase, shareData.appData.password);

			if (sftpPassphraseEncObj.success) {

				sftpPassphraseFinal = sftpPassphraseEncObj.data;
			}
		}
		if (body.sftp_passphrase_clear === '1') { sftpPassphraseFinal = ''; }

		if (sftpPrivateKeyInput) {

			// Encrypt the pasted private key content and store the encrypted blob.
			// If the field was submitted empty the existing encrypted value in
			// appConfig is preserved below — the key is never cleared by accident.
			const sftpPrivateKeyEncObj = await shareData.System.encrypt(sftpPrivateKeyInput, shareData.appData.password);

			if (sftpPrivateKeyEncObj.success) {

				sftpPrivateKeyFinal = sftpPrivateKeyEncObj.data;
			}
		}
		// If sftpPrivateKeyInput is empty, sftpPrivateKeyFinal stays undefined
		// and the appConfig write below preserves the existing encrypted value.

		// Encrypt the SMTP password under the current master-password key. A blank field
		// leaves mailerPasswordFinal undefined so the existing stored value is preserved.
		let mailerPasswordFinal;

		if (mailerPassword) {

			const mailerPasswordEncObj = await shareData.System.encrypt(mailerPassword, shareData.appData.password);

			if (mailerPasswordEncObj.success) {

				mailerPasswordFinal = mailerPasswordEncObj.data;
			}
		}
		if (body.mailer_password_clear === '1') { mailerPasswordFinal = ''; }

		// Blank leaves cronBackupPasswordFinal undefined so the write below preserves the stored value
		// (same write-only convention as the SFTP/SMTP secrets — the browser never receives it).
		if (cronBackupPassword) {

			const cronBackupPasswordEncObj = await shareData.System.encrypt(cronBackupPassword, shareData.appData.password);

			if (cronBackupPasswordEncObj.success) {

				cronBackupPasswordFinal = cronBackupPasswordEncObj.data;
			}
		}

		const telegramEnabledOrig = shareData['appData']['telegram_enabled'];
		const signals3CQSEnabledOrig = shareData['appData']['signals_3cqs_enabled'];

		appConfig['bots']['pair_buttons'] = pairButtonsUC;
		shareData['appData']['bots']['pair_buttons'] = pairButtonsUC;

		appConfig['bots']['pair_blacklist'] = pairBlacklistUC;
		shareData['appData']['bots']['pair_blacklist'] = pairBlacklistUC;

		// Provider secret: encrypt on change, and a blank field preserves the stored (encrypted or
		// legacy-plaintext) value — the same write-only convention as the SMTP/SFTP secrets. appConfig
		// already holds the existing value, so simply not overwriting it preserves it.
		await applySecretUpdate(appConfig['signals']['3CQS'], 'api_key', signals3CQSApiKey, body.signals_3cqs_api_key_clear);
		appConfig['signals']['3CQS']['enabled'] = signals3CQSEnabled;
		shareData['appData']['signals_3cqs_enabled'] = signals3CQSEnabled;

		appConfig['telegram']['enabled'] = telegramEnabled;
		// The Telegram bot token is a live credential — encrypt it at rest (like the 3CQS key and AI keys)
		// and preserve the existing one when the field is left blank, so it is never stored or shipped to
		// the config page in plaintext. readSecret passes a legacy plaintext token through unchanged, so
		// existing installs keep working until their next save re-encrypts it.
		await applySecretUpdate(appConfig['telegram'], 'token_id', telegramTokenId, body.telegram_token_id_clear);
		appConfig['telegram']['notify_user_id'] = telegramUserId;

		// The database backup is stored as a scheduled job (schedules collection), not in
		// app.json. Its settings are assembled and saved via the Scheduler further below.

		if (!appConfig['circuit_breaker']) appConfig['circuit_breaker'] = {};
		appConfig['circuit_breaker']['enabled']               = cbEnabled;
		appConfig['circuit_breaker']['deal_ratio_threshold']  = cbDealRatio;
		appConfig['circuit_breaker']['deal_ratio_window_secs']= cbDealWindow;
		appConfig['circuit_breaker']['price_drop_percent']    = cbPriceDrop;
		appConfig['circuit_breaker']['price_drop_window_secs']= cbPriceWindow;
		appConfig['circuit_breaker']['price_drop_enabled']    = cbPriceDropEnabled;
		appConfig['circuit_breaker']['pause_duration_secs']   = cbPauseDuration;
		appConfig['circuit_breaker']['repeat_alert_window_secs'] = cbRepeatWindow;
		appConfig['circuit_breaker']['price_zero_alert_count']   = cbPriceZeroAlert;
		appConfig['circuit_breaker']['portfolio_loss_enabled']   = cbPortfolioLossEnabled;
		appConfig['circuit_breaker']['loss_window_hours']        = cbLossWindowHours;
		appConfig['circuit_breaker']['loss_limit']               = cbLossLimit;

		// IP allow/deny (server-wide + login). Each list accepts exact IP, CIDR, or wildcard/partial
		// notation; invalid entries are dropped here. Loopback is always exempt at enforcement time
		// and the console `reset ipfilter` command clears these, so a mistake can't cause a lockout.
		const parseIpList = (v) => IpFilter.sanitizeList(Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/[\s,]+/) : []));
		if (!appConfig['ip_filter']) appConfig['ip_filter'] = {};
		// Only rebuild a layer when its fields are actually present in the request body. A partial or
		// programmatic /config save that omits them must NOT silently wipe a configured allow/block
		// list or disable the filter — the full Configuration form always submits these fields.
		if (body.ip_server_enabled !== undefined || body.ip_server_allow !== undefined || body.ip_server_block !== undefined) {
			appConfig['ip_filter']['server'] = {
				'enabled':   convertBoolean(body.ip_server_enabled, false),
				'allowlist': parseIpList(body.ip_server_allow),
				'blocklist': parseIpList(body.ip_server_block)
			};
		}
		if (body.ip_login_enabled !== undefined || body.ip_login_allow !== undefined || body.ip_login_block !== undefined) {
			appConfig['ip_filter']['login'] = {
				'enabled':   convertBoolean(body.ip_login_enabled, false),
				'allowlist': parseIpList(body.ip_login_allow),
				'blocklist': parseIpList(body.ip_login_block)
			};
		}

		// Context compression settings
		if (!appConfig['ai'])                      appConfig['ai'] = {};
		if (!appConfig['ai']['context_compression']) appConfig['ai']['context_compression'] = {};
		appConfig['ai']['context_compression']['enabled']         = ctxCompEnabled;
		appConfig['ai']['context_compression']['threshold_chars'] = ctxCompThreshold;
		appConfig['ai']['context_compression']['protect_last_n']  = ctxCompProtectN;
		if (!shareData.appData.ai)                 shareData.appData.ai = {};
		shareData.appData.ai.context_compression = appConfig['ai']['context_compression'];

		// Deal context settings (AI access to deal records and logs)
		if (!appConfig['ai']['deal_context']) appConfig['ai']['deal_context'] = {};
		appConfig['ai']['deal_context']['enabled']            = dealCtxEnabled;
		appConfig['ai']['deal_context']['use_router']         = dealCtxUseRouter;
		appConfig['ai']['deal_context']['router_model']       = dealCtxModel;
		appConfig['ai']['deal_context']['router_timeout_ms']  = dealCtxTimeout;
		shareData.appData.ai.deal_context = appConfig['ai']['deal_context'];


		if (!appConfig['ai']['generation']) appConfig['ai']['generation'] = {};
		appConfig['ai']['generation']['analysis_model']   = genAnalysisModel;
		appConfig['ai']['generation']['chat_temperature'] = genChatTemp;
		appConfig['ai']['generation']['max_tokens']       = genMaxTokens;
		appConfig['ai']['generation']['num_ctx']          = genNumCtx;
		shareData.appData.ai.generation = appConfig['ai']['generation'];


		if (!appConfig['ai']['tools']) appConfig['ai']['tools'] = {};
		appConfig['ai']['tools']['enabled']        = toolsEnabled;
		appConfig['ai']['tools']['max_iterations'] = toolsMaxIter;
		appConfig['ai']['tools']['verify']         = toolsVerify;
		appConfig['ai']['tools']['explore']        = toolsExplore;
		appConfig['ai']['tools']['deep_explore']   = toolsDeepExplore;
		// tool_model (the optional stronger data-path model — a model cascade) is intentionally an
		// ADVANCED, app.json-only setting to keep the config UI uncluttered. It is preserved as-is here
		// (never overwritten from the form), and read at runtime by getToolsConfig().
		shareData.appData.ai.tools = appConfig['ai']['tools'];

		if (!appConfig['ai']['learning']) appConfig['ai']['learning'] = {};
		appConfig['ai']['learning']['enabled'] = learningEnabled;
		shareData.appData.ai.learning = appConfig['ai']['learning'];

		// Update live appData so circuit breaker takes effect immediately without restart
		shareData.appData.circuit_breaker = appConfig['circuit_breaker'];


		// Assemble the backup settings for the schedule row. Secrets left blank on the
		// form fall back to the current stored values (sourced from the backup schedule,
		// mirrored in shareData.appData.cron_backup), so a routine save never erases them.
		const existingBackup = shareData.appData.cron_backup || {};
		const existingSftp = existingBackup.sftp || {};

		let privateKeyFinal;
		if (sftpPrivateKeyClear === '1') { privateKeyFinal = ''; }
		else if (sftpPrivateKeyFinal !== undefined) { privateKeyFinal = sftpPrivateKeyFinal; }
		else { privateKeyFinal = existingSftp.private_key || ''; }

		// Blank-on-save preserves the stored secret (undefined => fall back to the existing encrypted
		// value), matching the private-key handling above and the write-only convention throughout.
		const cronBackupPasswordResolved = (cronBackupPasswordFinal !== undefined) ? cronBackupPasswordFinal : (existingBackup.password || '');
		const sftpPasswordResolved = (sftpPasswordFinal !== undefined) ? sftpPasswordFinal : (existingSftp.password || '');
		const sftpPassphraseResolved = (sftpPassphraseFinal !== undefined) ? sftpPassphraseFinal : (existingSftp.passphrase || '');

		const cronBackupSettings = {
			'max': cronBackupMax,
			'password': cronBackupPasswordResolved,
			'include_chats': cronBackupIncludeChats,
			'include_schedules': cronBackupIncludeSchedules,
			'include_config': cronBackupIncludeConfig,
			'sftp': {
				'enabled': sftpEnabled,
				'host': sftpHost,
				'port': sftpPort,
				'username': sftpUsername,
				'password': sftpPasswordResolved,
				'passphrase': sftpPassphraseResolved,
				'private_key': privateKeyFinal,
				'remote_directory': sftpRemoteDirectory
			}
		};

		// Ensure ai sub-objects exist before writing — app.json files on the old
		// schema may be missing 'provider' or the 'openai' sub-object entirely,
		// which would throw a TypeError when trying to set properties on undefined.
		if (!appConfig['ai']) {
			appConfig['ai'] = {};
		}

		if (!appConfig['ai']['ollama']) {
			appConfig['ai']['ollama'] = {};
		}

		if (!appConfig['ai']['openai']) {
			appConfig['ai']['openai'] = {};
		}

		appConfig['ai']['provider'] = aiProvider;

		appConfig['ai']['ollama']['enabled'] = ollamaEnabled;
		appConfig['ai']['ollama']['host'] = ollamaHost;
		// Encrypt on change; blank preserves the stored value (write-only, like the SMTP secret).
		await applySecretUpdate(appConfig['ai']['ollama'], 'api_key', ollamaApiKey, body.ollama_api_key_clear);
		appConfig['ai']['ollama']['model'] = ollamaModel;

		appConfig['ai']['openai']['enabled'] = openaiEnabled;
		await applySecretUpdate(appConfig['ai']['openai'], 'api_key', openaiApiKey, body.openai_api_key_clear);
		appConfig['ai']['openai']['model'] = openaiModel;
		appConfig['ai']['openai']['base_url'] = openaiBaseUrl;

		// Outbound mailer (SMTP). Preserve the stored encrypted password when the form field
		// was left blank; if the master password just changed, appConfig.mailer.password was
		// already re-encrypted above, so reading it here keeps the correct key.
		if (!appConfig['mailer']) { appConfig['mailer'] = {}; }

		const mailerPasswordExisting = appConfig['mailer']['password'] || '';

		appConfig['mailer'] = {
			'enabled': mailerEnabled,
			'host': mailerHost,
			'port': mailerPort,
			'secure': mailerSecure,
			'user': mailerUser,
			'from': mailerFrom,
			'password': (mailerPasswordFinal !== undefined) ? mailerPasswordFinal : mailerPasswordExisting
		};

		shareData['appData']['mailer'] = appConfig['mailer'];

		// Granular notification preferences. The form posts the whole block as one JSON string; parse it,
		// keep only recognized fields (so a malformed post can never inject arbitrary config), stamp the
		// schema version, and apply it live. An empty/absent value clears the block back to legacy
		// "deliver everywhere" behavior. Never throws on a bad payload — it just leaves the block unset.
		if (typeof body.notifications === 'string') {
			let notifParsed = null;
			const raw = body.notifications.trim();
			if (raw !== '') {
				try {
					const n = JSON.parse(raw);
					if (n && typeof n === 'object') {
						notifParsed = {
							'schema_version': Notifications.SCHEMA_VERSION,
							'min_severity': (n.min_severity && typeof n.min_severity === 'object') ? n.min_severity : {},
							'quiet_hours': (n.quiet_hours && typeof n.quiet_hours === 'object') ? n.quiet_hours : {},
							'email_to': Array.isArray(n.email_to) ? n.email_to.filter(x => typeof x === 'string' && x.trim() !== '') : [],
							'events': (n.events && typeof n.events === 'object') ? n.events : {}
						};
					}
				}
				catch (e) {}
			}
			appConfig['notifications'] = notifParsed;
			shareData['appData']['notifications'] = notifParsed;
		}

		// Apply the IP filter live so it takes effect on the next request without a restart.
		shareData['appData']['ip_filter'] = appConfig['ip_filter'];

		shareData['appData']['telegram_id'] = telegramUserId;
		shareData['appData']['telegram_enabled'] = telegramEnabled;
		shareData['appData']['telegram_enabled_config'] = telegramEnabled;

		// The backup lives in the schedules collection now (saved via the Scheduler
		// below, which also refreshes appData). app.json's cron_backup is left untouched
		// as a read-only legacy migration seed — never written here — so that Hub
		// instances sharing one app.json but using separate databases can each still
		// migrate their own backup row from it.

		if (shareData.appData.config_mode) {

			try {

				const db = await shareData.System.connectDb(mongodburl);

				await db.close();

				if (db == undefined || db == null || db == '') {

					dbErr = 'Unabled to connect to database';
				}
			}
			catch(e) {

				dbErr = e.message;
			}

			if (dbErr != undefined && dbErr != null && dbErr != '') {

				success = false;
				dataMessage = 'Database Error: ' + dbErr;
			}
			else {

				let msg = 'Database URL modified. Shutting down. Please restart for changes to take effect.';

				dataMessage = msg;

				// Successful configuration. Shutdown to start fresh config.
				appConfig['mongo_db_url'] = mongodburl;

				logger(msg, true);

				setTimeout(() => { shareData.System.shutDown(); }, 1500);
			}
		}

		if (success) {

			// A failed disk write must not be reported as success: otherwise the live in-memory appData
			// (already updated above) silently diverges from the on-disk config, and the settings revert
			// on the next restart. Surface the failure to the user.
			const saveResult = await saveConfig(appConfigFile, appConfig);

			if (saveResult && saveResult.success === false) {

				success = false;
				dataMessage = 'Failed to save configuration to disk: ' + ((saveResult.data && saveResult.data.message) || 'write error') + '. Settings were applied to the running process but NOT persisted — please retry.';
			}
			else {

				// app.json (new anchor + re-keyed secrets) is now on disk alongside the already-written
				// bot-config — a password re-key, if any, is fully committed, so retire the crash-recovery
				// journal. Harmless no-op when no password changed (the journal was never written).
				clearRekeyJournal();
			}

			// Rebuild the mailer transport from the saved config. Fire-and-forget: the
			// decrypt/transport rebuild must not hold up the config-save response.
			if (shareData.Mailer && typeof shareData.Mailer.configure === 'function') {

				shareData.Mailer.configure().catch(function () {});
			}

			// Stop / Restart AI client
			shareData.AIClient.stop();

			if (openaiEnabled) {

				shareData.AIClient.start('openai', {
					// Use the effective STORED key (decrypted), not the form value — the field is
					// write-only and submits blank when the key is unchanged.
					api_key: await readSecret(appConfig['ai']['openai']['api_key']),
					model: openaiModel,
					base_url: openaiBaseUrl,
				});
			}
			else if (ollamaEnabled) {

				shareData.AIClient.start('ollama', {
					host: ollamaHost,
					api_key: await readSecret(appConfig['ai']['ollama']['api_key']),
					model: ollamaModel,
				});
			}

			// Restart Signals (best-effort: its early steps read config/secrets before any internal
			// guard, so contain a possible throw here rather than let it surface as an unhandled rejection)
			Promise.resolve(startSignals()).catch(() => {});

			// Restart Telegram based on if Hub in use as it may be overriding instance settings
			if (!hubInstance || (hubInstance && telegramEnabledOrig)) {

				shareData.Telegram.stop();

				if (telegramEnabled) {

					await delay(1000);
					// Resolve the effective token from the stored (now encrypted) config — this also covers a
					// blank-field save where the token was preserved rather than re-supplied. readSecret decrypts
					// it (or passes plaintext through for a not-yet-migrated install).
					shareData.Telegram.start(await readSecret(appConfig['telegram']['token_id']), telegramEnabled);
				}
			}

			// Save the backup as a scheduled job (creates/updates the schedules row,
			// re-arms it, and refreshes shareData.appData.cron_backup).
			await shareData.System.saveBackupSchedule(cronBackupSettings, cronBackupSchedule, cronBackupEnabled, body.cron_backup_timezone || '');

			if (sftpEnabled && sftpHost && sftpPort) {

				const tempDir = path.join(pathRoot, 'temp');

				if (!fs.existsSync(tempDir)) {

					fs.mkdirSync(tempDir, {
						recursive: true
					});
				}

				const tempFileName = `sftp-test-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.bin`;
				const localFilePath = path.join(tempDir, tempFileName);

				try {

					const kBytes = 1;

					const randomData = crypto.randomBytes(kBytes * 1024);

					fs.writeFileSync(localFilePath, randomData);

					const res = await shareData.System.sftpUploadFile(localFilePath, true);

					if (!res.success) {
						
						dataMessage = 'WARNING (SFTP): ' + res.error;
					}
				}
				catch (err) {

					dataMessage = 'WARNING (SFTP): ' + err;
				}
				finally {

					if (fs.existsSync(localFilePath)) {
		
						fs.unlinkSync(localFilePath);
					}
				}
			}
		}

		let obj = { 'success': success, 'data': dataMessage };
		
		res.send(obj);
	}
	else {

		let obj = { 'success': false, 'data': 'Password Incorrect' };
		
		res.send(obj);
	}
}


async function startSignals() {

	// Start signals after everything else is finished loading

	const appConfigFile = shareData.appData.app_config;

	const appConfig = await getConfig(appConfigFile);

	let enabled = shareData.appData['signals_3cqs_enabled'];

	const apiKey = await readSecret(appConfig['data']['signals']['3CQS']['api_key']);

	const socket = await shareData.Signals3CQS.start(enabled, apiKey);
}


async function pairBlackListed(pair) {

    let pairInvalid = false;

	const pairBlackList = shareData.appData.bots['pair_blacklist'];

    function wildCardToRegExp(str) {

		return new RegExp('^' + str.split(/\*+/).map(regExpEscape).join('.*') + '$');
    }

    function regExpEscape(str) {

		return str.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
    }

    for (let x = 0; x < pairBlackList.length; x++) {

		let pairRegExp = wildCardToRegExp(pairBlackList[x]);

        if (new RegExp(pairRegExp, 'i').test(pair)) {

			pairInvalid = true;

			break;
        }
    }

    return pairInvalid;
}


async function getData(fileName) {

	let data;
	let err = '';
	let success = true;

	if (fs.existsSync(fileName)) {

		try {
				data = fs.readFileSync(fileName, {
							encoding: 'utf8',
							flag: 'r'
						}
					);
			}
			catch (e) {

				err = e;
				success = false;
			}
	}
	else {

		success = false;
		err = fileName + ' does not exist';
	}

	return ({ 'success': success, 'data': data, 'error': err });
}


async function saveData(fileName, data) {

	let err = '';

	try {

		fs.writeFileSync(fileName, data);
	}
	catch (e) {

		err = e;
	}

	return err;
}


async function fetchURL(data) {

	let url = data['url'];
	let method = data['method'];
	let headers = data['headers'];
	let body = data['body'];

	let res;
	let errMsg;

	let success = true;
	let isJSON = false;

	if (method == undefined || method == null || method == '') {

		method = 'get';
	}

	const response = await fetch(url, {
		method: method,
		headers: headers,
		body: JSON.stringify(body),
	})
	.then(response => {

		return response;
	})
	.catch(err => {

		success = false;
		errMsg = err;

		return err;
	});

	if (success) {

		res = await response.text();

		try {

			res = JSON.parse(res);

			isJSON = true;
		}
		catch(e) {

			isJSON = false;
		}
	}

	let resObj = {
					'success': success,
					'json': isJSON,
					'data': res,
					'error': errMsg
				 };

	return resObj;
}


async function makeDir(dirName) {

	let dir = pathRoot + '/' + dirName;

	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir);
	}
}


async function showTradingView(req, res) {

	let jquery = convertBoolean(req.query.jquery, true);
	let script = convertBoolean(req.query.script, true);
	let containerId = req.query.containerId;
	let width = req.query.width;
	let height = req.query.height;
	let theme = req.query.theme;
	let exchange = req.query.exchange;
	let pair = req.query.pair;

	if (containerId == undefined || containerId == null || containerId == '') {

		containerId = 'tvChart' + Math.floor(1000 + Math.random() * 90000);
	}

	if (theme == undefined || theme == null || theme == '') {

		theme = 'dark';
	}

	if (exchange == undefined || exchange == null || exchange == '') {

		exchange = 'BINANCE';
	}

	if (pair == undefined || pair == null || pair == '') {

		pair = 'BTC_USDT';
	}

	// Every value below is reflected into the TradingView template, which renders them with unescaped
	// <%- %> sinks (HTML id attribute and single-quoted JS strings). Constrain each to its safe character
	// class at the source so a crafted query string cannot break out of that context (reflected XSS).
	containerId = String(containerId).replace(/[^A-Za-z0-9_]/g, '');
	if (containerId === '') { containerId = 'tvChart' + Math.floor(1000 + Math.random() * 90000); }

	theme = String(theme).toLowerCase() === 'light' ? 'light' : 'dark';
	exchange = String(exchange).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
	width = String(width == null ? '' : width).replace(/[^0-9]/g, '');
	height = String(height == null ? '' : height).replace(/[^0-9]/g, '');

	let tvData = await getData(pathRoot + '/libs/webserver/public/data/tradingViewData.json');

	let dataObj = {
					'container_id': containerId,
					'jquery': jquery,
					'script': script,
					'width': width,
					'height': height,
					'theme': theme,
					'exchange': exchange,
					'pair': pair.replace(/[^a-z0-9]/gi, '').toUpperCase(),
					'tv_data': tvData.data
				  };

	res.render( 'tradingView', { 'appData': shareData.appData, 'data': dataObj } );
}


async function sendNotification(data) {

	let maxNotifications = 500;
	let fileName = logNotifications;

	// Best-effort throughout: sendNotification is fire-and-forget and is called (un-awaited) from the
	// trading path, so every step below is guarded — a failure to resolve the instance name, read/write
	// the history file, or deliver to a channel can only be logged and skipped, never rejected into a
	// caller. The notification is peripheral; it must never propagate an error toward the trading loop.
	let instanceName = '';
	try { instanceName = await getInstanceName(); } catch (e) {}

	if (instanceName && instanceName.trim() !== '') {

		fileName = fileName.replace('{INSTANCE_NAME}', `-${instanceName}`);
	}
	else {

		fileName = fileName.replace('{INSTANCE_NAME}', '');
	}

	// Scrub any credential BEFORE the notification is stored, delivered, or shown — the same guarantee
	// the logger gives its sinks. Notifications are persisted to the history file and pushed to Telegram
	// and the browser panel; an error message echoing a key/token/URL-with-userinfo would otherwise leak
	// there even though the parallel log line is scrubbed. Operators share both, so both must be clean.
	let msg = redactSecrets(String(data['message'] == null ? '' : data['message']));
	let msgType = data['type'];
	let telegramId = data['telegram_id'];

	if (msgType == undefined || msgType == null || msgType == '') {

		msgType = 'info';
	}

	let obj = { 'date': new Date(), 'type': msgType, 'message': msg };

	// Get notifications
	let historyArr = [];
	try { historyArr = await getNotificationHistory(); } catch (e) {}
	if (!Array.isArray(historyArr)) { historyArr = []; }

	historyArr.push(obj);

	historyArr = historyArr.slice(-maxNotifications);

	// Resolve which channels this event may reach, from the operator's per-instance `notifications`
	// preferences (event × channel × min-severity + quiet hours). With no block configured this returns
	// browser + Telegram on and email off — i.e. the previous behavior, unchanged. The notification
	// HISTORY below is always written regardless, so the browser panel keeps the full record even when
	// live channels are dialed down.
	// Resolve which channels this event may reach. On any failure fall back to the documented default
	// (browser + Telegram on, email off) so a routing error degrades to the previous behavior rather
	// than dropping the notification or rejecting.
	let notif;
	let route;
	try {
		notif = Notifications.resolveEvent(data);
		route = Notifications.routing(
			shareData.appData ? shareData.appData.notifications : null,
			notif.event,
			notif.severity,
			{ 'server_id': getServerId(), 'bot_name': data['bot_name'] }
		);
	}
	catch (e) {
		notif = { 'event': 'generic', 'severity': msgType };
		route = { 'browser': true, 'telegram': true, 'email': false };
	}

	if (route.telegram && telegramId != undefined && telegramId != null && telegramId != '') {

		// Un-awaited by design (fire-and-forget); guard so a Telegram failure can't become an unhandled
		// rejection escaping toward the trading path.
		try { Promise.resolve(shareData.Telegram.sendMessage(telegramId, msg)).catch(() => {}); } catch (e) {}
	}

	// Relay message to WebSocket notifications room (the browser channel). Callers can opt out per
	// message by passing browser:false; otherwise it is gated by the event's browser routing.
	if (data['browser'] !== false && route.browser) {

		try {
			Promise.resolve(sendSocketMsg({

				'room': 'notifications',
				'type': 'notification',
				// Convert to safe HTML (ANSI colors → spans, text escaped) so the browser panel renders it
				// with color like the live Logs view. The raw `msg` is kept for Telegram and history storage.
				'message': ansiToHtml(msg)
			})).catch(() => {});
		}
		catch (e) {}
	}

	// Email is a new, opt-in channel: deliver only when the event routes to email AND recipients are
	// configured, reusing ScheduleNotifier's mailer resolution (instance SMTP, else the Hub relay) so
	// there is one email path. Recipients name addresses only — never SMTP credentials.
	if (route.email) {

		try {
			const emailTo = (shareData.appData && shareData.appData.notifications && Array.isArray(shareData.appData.notifications.email_to))
				? shareData.appData.notifications.email_to.filter(x => typeof x === 'string' && x.trim() !== '')
				: [];

			if (emailTo.length && shareData.ScheduleNotifier && typeof shareData.ScheduleNotifier.sendEmail === 'function') {

				shareData.ScheduleNotifier.sendEmail(emailTo, msg);
			}
		}
		catch (e) {}
	}

	// Security/observability linkage: a delivered CRITICAL notification (circuit-breaker trip, a
	// portfolio halt, a system failure) is also written to the audit log, so the risk-relevant alert
	// history is queryable alongside auth events. Never throws.
	if (Notifications.severityRank(notif.severity) >= Notifications.severityRank('critical') && (route.browser || route.telegram || route.email)) {

		try { auditEvent('system', 'notification.' + notif.event, '', String(msg).slice(0, 300)); }
		catch (e) {}
	}

	// Save notifications (best-effort; a write failure must not reject into a fire-and-forget caller).
	try { saveData(fileName, JSON.stringify(historyArr)); } catch (e) {}
}


async function getNotificationHistory(client, data) {

	let fileName = logNotifications;

	const instanceName = await getInstanceName();

	if (instanceName && instanceName.trim() !== '') {

		fileName = fileName.replace('{INSTANCE_NAME}', `-${instanceName}`);
	}
	else {

		fileName = fileName.replace('{INSTANCE_NAME}', '');
	}

	let historyArr = [];

	try {
		
		let data = await getData(fileName);

		if (data.success) {

			historyArr = JSON.parse(data.data);
		}
	}
	catch (e) {

	}

	if (client) {

		// Convert each stored (raw) message to safe HTML for the browser, matching the live path, so
		// history renders with ANSI colors too. Storage stays raw (Telegram-friendly, re-convertible).
		const clientArr = historyArr.map(o => Object.assign({}, o, {
			'message': ansiToHtml(o && o.message)
		}));

		client.emit('history', clientArr);
	}
	else {

		return historyArr;
	}
}


async function listFiles(type = 'logs', isHub) {

	let allFiles = [];

	// The Hub aggregates a migrated kind across every instance's folder (data/instances/*/<kind>) PLUS
	// the flat legacy dir (its own <date>-hub.log, and any not-yet-migrated leftovers during the
	// transition); an instance, or any not-yet-migrated kind, reads a single flat directory.
	const dirs = (isHub && MIGRATED_KINDS.has(type))
		? instanceDataDirsAll(type).concat([ pathRoot + '/' + type ])
		: [ instanceDataDir(type) ];

	for (const dir of dirs) {

		let files;
		try { files = fs.readdirSync(dir); } catch (e) { continue; }

		// The server_id this folder belongs to (data/instances/<server_id>/<kind>) — '' for the flat legacy
		// dir. The Hub carries it into the download link so a bare, same-named file (e.g. two instances' own
		// "<date>.log") resolves unambiguously to the right instance's folder.
		let dirServerId = '';
		try { if (path.basename(path.dirname(path.dirname(dir))) === 'instances') { dirServerId = path.basename(path.dirname(dir)); } }
		catch (e) {}

		// Load this directory's artifact manifest once so each row can carry the RECORDED creation time and
		// the instance's DISPLAY name (the label a rename updates) instead of leaning on the filesystem ctime
		// or parsing the instance name out of the filename. Best-effort: a missing/partial manifest just falls
		// back to the filesystem values, since the directory remains the source of truth for what exists.
		let byFile = null;
		let displayName = '';
		try {
			const manifest = ArtifactIndex.load(dir, type);
			displayName = manifest.instance_name || '';
			byFile = new Map(manifest.entries.map(e => [ e.file, e ]));
		}
		catch (e) { byFile = null; }

		for (let fileName of files) {

			const filePath = `${dir}/${fileName}`;

			let stats;
			try { stats = fs.statSync(filePath); } catch (e) { continue; }

			if (!stats.isDirectory()) {

				const meta = byFile ? byFile.get(fileName) : null;
				const createdUtc = (meta && meta.created_utc) ? new Date(meta.created_utc) : stats.ctime;

				allFiles.push({
					'name': fileName,
					'created': createdUtc,                                   // prefer the recorded creation time
					'modified': stats.mtime,
					'size': stats.size,
					'size_human': numFormatter(stats.size),
					// The Hub aggregates several instances, so it labels each row and keys its download link by
					// server_id; a single instance owns one folder, so it needs neither (cleaner links/markup).
					'instance_name': isHub ? displayName : '',
					'server_id': isHub ? dirServerId : ''
				});
			}
		}
	}

	return allFiles.length > 0 ? sortByKey(allFiles, 'created').reverse() : [];
}


// The two artifact-shape predicates, each the SINGLE definition of what a log / a backup filename looks
// like — identified by shape only, with no instance-name or product-token coupling, so they keep matching
// whatever the filename prefix happens to be. Every consumer (the listing/download gate, local retention,
// the index reconcile, and the log reader in LogScan) routes through these, so cleanup and search can never
// disagree about what a log or a backup is.
//   log:    <date>…​.log     (a legacy <date>-<name>.log, a plain <date>.log, or a <date>-hub.log)
//   backup: …​.zip.enc
function isLogArtifact(fileName)    { return /^\d{4}-\d{2}-\d{2}.*\.log$/.test(String(fileName)); }
function isBackupArtifact(fileName) { return /\.zip\.enc$/i.test(String(fileName)); }

// Whether a filename is one of a KIND's real artifacts. Rejects the manifest, markers and any other stray
// file. The single predicate both the listing and the download gate use.
function isArtifactType(fileName, type) {
	if (type === 'logs')    { return isLogArtifact(fileName); }
	if (type === 'backups') { return isBackupArtifact(fileName); }
	return false;
}

// Whether a given filename is in scope for the given type, gating BOTH the listing and the download so the
// two can never disagree. Two guarantees:
//   1) Basename only — a name that isn't a bare filename (a path separator or "." / ".." traversal) is
//      rejected, so nothing can escape the logs/backups directory. (resolveDataFilePath re-checks this too.)
//   2) Artifact type — only a real log/backup, never the manifest or a marker.
// ISOLATION between instances is provided by the DIRECTORY, not the filename: a non-Hub instance resolves
// downloads only within its own data/instances/<server_id>/<kind>/ folder (resolveDataFilePath), so a name
// shaped like a sibling's file simply is not found there; the Hub is the aggregator and legitimately serves
// every instance's file. This is why the old per-name regex — the fragile, hardcoded-"SymBot" coupling — is
// gone: the folder already does the isolation the name used to.
function fileInScope(fileName, type) {

	if (!fileName || fileName === '.' || fileName === '..' || fileName !== path.basename(fileName)) { return false; }
	// Reject any control character (NUL included): a NUL would satisfy the shape regex ("." matches it) but
	// make the fs layer throw, turning an un-awaited downloadFile into an unhandled rejection instead of a
	// clean 404. A real log/backup name never contains a control char, so this only refuses crafted input.
	if (/[\x00-\x1f]/.test(fileName)) { return false; }

	return isArtifactType(fileName, type);
}


async function showFiles(type = 'logs', req, res, isHub) {

	const files = await listFiles(type, isHub);

	const filesFiltered = files.filter(file => fileInScope(file.name, type));

	// On the Hub's backups page, also surface the Hub's own control-plane database (SQLite)
	// snapshots — these are separate from the instance database backups listed above and are
	// rendered in their own clearly-labeled section by backupsView.
	let hubBackups = null;

	if (isHub && type === 'backups' && shareData.HubStore && typeof shareData.HubStore.listBackups === 'function' && shareData.HubStore.isAvailable && shareData.HubStore.isAvailable()) {

		hubBackups = shareData.HubStore.listBackups().map(b => ({
			'name': b.name,
			'size_human': numFormatter(b.size),
			'modified': b.modified
		}));
	}

	// The Hub aggregates several instances into one list, and the download links / off-site SFTP folders are
	// keyed by server_id. Build a small legend — instance display name ↔ server_id ↔ how many files here — so
	// an operator can decode which instance any file (or any raw "<server_id>/" off-site folder) belongs to.
	// Reuses the per-file server_id/instance_name the listing already attached; a single instance needs none.
	let instancesMap = null;

	if (isHub) {

		const byServer = new Map();

		for (const f of filesFiltered) {

			const sid = f.server_id || '';
			const key = sid || ('n:' + (f.instance_name || ''));
			const cur = byServer.get(key) || { 'server_id': sid, 'name': f.instance_name || '', 'count': 0 };

			cur.count++;
			if (!cur.name && f.instance_name) { cur.name = f.instance_name; }
			byServer.set(key, cur);
		}

		instancesMap = [ ...byServer.values() ].sort((a, b) => String(a.name).localeCompare(String(b.name)));
	}

	res.render(`${type}View`, {
		'appData': shareData.appData,
		'files': filesFiltered,
		'hubBackups': hubBackups,
		'instancesMap': instancesMap,
		isHub
	});
}


// A filesystem-safe, bounded label from an instance's name — used to prefix a file that must stay identifiable
// once its folder no longer tells you the instance: the friendly DOWNLOAD name (a downloaded file leaves SymBot
// into a flat folder) and the OFF-SITE (SFTP) filename (the remote subfolder is named by the non-human-readable
// server_id, so the filename carries the instance name). The locally-stored backup and logs, which stay in the
// named `data/instances/<server_id>/` tree the operator can map, keep clean instance-agnostic filenames instead.
// Anything outside [A-Za-z0-9._-] collapses to a single dash; edge dashes/dots are trimmed; length is capped.
// Returns '' for an empty/unusable name so the caller falls back to the bare filename.
function safeInstanceLabel(name) {
	return String(name == null ? '' : name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
}

// Build the off-site (SFTP) filename for THIS instance's own backup: the instance's name prefixed to the local
// filename — e.g. "Coinbase-Real-backup-<date>_<time>.zip.enc" — so a remote listing (whose subfolder is the
// internal server_id) shows which instance a backup belongs to. The name is instanceNameSync(), the instance's
// stable identifier, present with or without a Hub display name, resolved from the live identity (NOT the
// manifest-first friendly resolver, so it is the instance's own name however the backup was triggered). If the
// live identity is unavailable it falls back to the server_id data-folder marker (.instance.json, tied to the
// data being backed up); a standalone with no instance name uploads the bare filename. `localFile` is the local
// backup path (data/instances/<server_id>/backups/<file>); only its basename is used for the name.
function instanceBackupFileName(localFile) {
	let name = safeInstanceLabel(instanceNameSync());
	if (!name) {
		try {
			const marker = JSON.parse(fs.readFileSync(path.dirname(path.dirname(String(localFile))) + '/.instance.json', 'utf8'));
			name = safeInstanceLabel(marker && marker.instance_name);
		}
		catch (e) {}
	}
	const base = path.basename(String(localFile));
	return name ? (name + '-' + base) : base;
}

// The friendly download name for an artifact: "<instance-label>-<original filename>", so a saved log/backup
// says which instance it belongs to even after it leaves the app. The instance name is read from the SAME
// per-folder .index.json the listing uses (identical for a standalone instance and for the Hub, which has
// resolved the file to the right instance's folder by server_id), with a fail-safe fallback chain:
//   index instance_name → the name embedded in a legacy "<date>-<name>.log" / "SymBot-<name>-backup-…"
//   filename → this instance's OWN identity when it is not the Hub → the bare filename (today's behavior).
// The own-identity fallback reuses instanceIndexMeta() — the SAME metadata the manifest records — so a
// not-yet-indexed file names itself exactly as its index would, never a divergent idiom. NEVER changes the
// on-disk name and NEVER throws — worst case the download keeps its bare name.
function friendlyArtifactName(filePath, fileName, type, isHub) {
	let name = '';
	try {
		const manifest = ArtifactIndex.load(path.dirname(String(filePath)), type);
		if (manifest && manifest.instance_name) { name = String(manifest.instance_name).trim(); }
	}
	catch (e) { /* fall through to the filename / own-identity fallbacks */ }
	if (!name) {
		const legacyLog = /^\d{4}-\d{2}-\d{2}-(.+)\.log$/i.exec(String(fileName));
		const legacyBak = /^SymBot-(.+)-backup-/i.exec(String(fileName));
		if (legacyLog && legacyLog[1]) { name = legacyLog[1]; }
		else if (legacyBak && legacyBak[1]) { name = legacyBak[1]; }
	}
	if (!name && !isHub) {
		try { name = String(instanceIndexMeta().instance_name || '').trim(); }
		catch (e) { /* keep name empty → bare filename */ }
	}
	const label = safeInstanceLabel(name);
	return label ? (label + '-' + fileName) : fileName;
}


async function downloadFile(fileName, type = 'logs', req, res, isHub, serverId) {

	// Only serve a real artifact, and never a traversal name. Cross-instance isolation is the DIRECTORY:
	// resolveDataFilePath below resolves a non-Hub download only within this instance's own folder, so a
	// sibling's filename simply is not found; the Hub resolves to the exact instance folder by server_id
	// (or, with none, the first basename match). 404 (not 403) so we never confirm an out-of-scope file.
	if (!fileInScope(fileName, type)) {

		if (!res.headersSent) { return res.status(404).send({ error: 'File not found' }); }
		return;
	}

	const filePath = resolveDataFilePath(type, fileName, isHub, serverId);

	if (!filePath) {

		if (!res.headersSent) { return res.status(404).send({ error: 'File not found' }); }
		return;
	}

	// lstat (not access): the file must exist AND be a plain regular file — a symlink has isFile() === false,
	// so it is refused here too, a final belt-and-suspenders gate on top of resolveDataFilePath's own check.
	fs.lstat(filePath, (err, st) => {

		if (err || !st || !st.isFile()) {

			// File doesn't exist (or is not a regular file, e.g. a symlink)
			if (!res.headersSent) {

				return res.status(404).send({

					error: 'File not found'
				});
			}

			return;
		}

		// Serve under a friendly "<instance>-<file>" name so the SAVED file says which instance it belongs to,
		// while the on-disk name (bare, server_id-foldered) is untouched. Fail-safe: falls back to the bare
		// filename if the instance name can't be resolved.
		res.download(filePath, friendlyArtifactName(filePath, fileName, type, isHub), (err) => {

			if (err && !res.headersSent) {

				res.status(err.statusCode || 500).send({
					error: err.message
				});
			}
			else if (err) {

				// Headers already sent
				//console.warn('Download error (after headers sent):', err.message);
			}
		});
	});
}


// Factory for a module-scoped logger. Returns a function that forwards to the central logger with a
// fixed prefix, so each subsystem can do `logger = shareData.Common.makeLogger('Foo: ')` in its init()
// instead of re-writing the same "is Common wired?" guard shim. The returned function is always safe to
// call (it closes over the central logger, which is defined here), and forwards the optional console flag.
function makeLogger(prefix) {

	const p = prefix || '';

	return function (msg, consoleLog) { logger(p + msg, consoleLog); };
}


// ── Audit helper ─────────────────────────────────────────────────────────────
// The ONE place every subsystem records a security-relevant event. It routes through the wired
// audit store (Mongo on an instance, SQLite on the Hub — both exposed as shareData.Audit.audit with
// the same (actor, action, target, detail, ip) signature), guards the store's presence, and never
// throws. So adding OR removing an audit point anywhere is a single self-contained one-liner:
//     shareData.Common.auditEvent(req, 'config.update', '', 'settings changed');
// `actor` may be an Express request (principal + client IP derived from it), an Authz principal, or
// a plain "kind:id" string. Actions are dot-namespaced (e.g. 'auth.login', 'system.restore').
function auditEvent(actor, action, target, detail, ip) {
	try {
		if (shareData && shareData.Audit && typeof shareData.Audit.audit === 'function') {
			shareData.Audit.audit(actor, action, target || '', detail || '', ip);
		}
	}
	catch (e) { /* auditing must never break the caller */ }
	return true;
}


// ── Log secret redaction ─────────────────────────────────────────────────────
// Central, always-on scrub applied to EVERY log line before it reaches ANY sink (the dated
// log file, the console, and the browser live-stream). Credentials must never persist in a
// log, because operators routinely share their logs to diagnose an issue. Redaction is done
// two complementary ways: by known secret FORMAT (so a value is caught even when it appears
// without its field name — e.g. inside an exchange error string) and by sensitive FIELD NAME
// (JSON `"k":"v"` or `k=v`). A cheap trigger test short-circuits the vast majority of lines
// (price ticks, deal state) so the hot logging path pays almost nothing.
const SECRET_TRIGGER = /(symb_(?:live|test|auto)_|passphrase|password|secret|api[_-]?key|apitoken|api_token|token_id|private_?key|authorization|bearer|:\/\/[^\s/@]+:[^\s/@]+@|[?&](?:token|key|secret|sig|signature|pass|password|api[_-]?key)=)/i;


// Recursively remove any object key that begins with '$' (a MongoDB query operator) from user-supplied
// input, in place. A body/query/socket payload like {"dealId":{"$ne":null}} would otherwise smuggle an
// operator into a Mongo filter and match/act on an arbitrary document — Mongoose schema casting does NOT
// strip operators (verified). Only operator KEYS are removed; string VALUES are never touched (a value
// like "$5" or a coin named "$DOGE" is legitimate). Depth-bounded so a pathological nested payload can't
// stall the request. Never throws. Applied at every ingress the money/data path trusts: the HTTP body/
// query/params, the WebSocket message, and the Hub worker message.
function stripMongoOperators(obj, depth) {

	depth = depth || 0;

	if (!obj || typeof obj !== 'object' || depth > 12) { return obj; }

	if (Array.isArray(obj)) {

		for (let i = 0; i < obj.length; i++) { stripMongoOperators(obj[i], depth + 1); }
		return obj;
	}

	for (const key of Object.keys(obj)) {

		if (key.charCodeAt(0) === 36) {   // '$' — a Mongo operator key has no legitimate place in request input

			delete obj[key];
		}
		else {

			stripMongoOperators(obj[key], depth + 1);
		}
	}

	return obj;
}


function redactSecrets(str) {

	if (typeof str !== 'string' || str.length === 0) { return str; }

	// Fast path — skip lines with no credential-shaped marker at all.
	if (!SECRET_TRIGGER.test(str)) { return str; }

	let out = str;

	// Scoped SymBot API keys: symb_live_<prefix>_<secret> — keep the head + non-secret lookup
	// prefix (useful for correlation), redact only the secret half.
	out = out.replace(/\b(symb_(?:live|test)_[0-9a-f]{6,})_[0-9a-f]{16,}\b/gi, '$1_[REDACTED]');

	// Default (auto-generated) legacy API key: symb_auto_<hex> — the whole value is the secret
	// (hashed as one string), so redact it entirely, keeping only the recognizable head.
	out = out.replace(/\bsymb_auto_[0-9a-f]{16,}\b/gi, 'symb_auto_[REDACTED]');

	// URLs: user:pass@host credentials and sensitive query parameters (Discord/Slack-style
	// webhook tokens, signed URLs, mongodb://user:pass@…).
	out = out.replace(/(:\/\/[^\s/@:]+:)[^\s/@]+(@)/g, '$1[REDACTED]$2');
	out = out.replace(/([?&](?:token|key|secret|sig|signature|pass|password|api[_-]?key)=)[^&\s"']+/gi, '$1[REDACTED]');

	// HTTP bearer tokens.
	out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1[REDACTED]');

	// Sensitive field values in JSON (`"key":"value"`) or key=value / key: value form.
	out = out.replace(
		/("?\b(?:apiToken|api_token|apiKey|api_key|apiSecret|api_secret|apiPassphrase|apiPassword|passphrase|password|private_?key|token_id|smtp_pass|bot_token)\b"?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|[^"\s,}{)]+)/gi,
		'$1[REDACTED]'
	);

	return out;
}


async function logger(data, consoleLog) {

	const instanceName = await getInstanceName();

	if (typeof data !== 'string') {
		data = JSON.stringify(data);
	}

	// Scrub any credential before the line reaches the file, console, or browser stream.
	data = redactSecrets(data);

	let dateNow = new Date().toISOString();

	let logData = `${dateNow} ${data}`;

	if(process.argv[2] && process.argv[2].toLowerCase() == 'clglite') {
		console.log(logData);
		return;
	}

	if (consoleLog || shareData.appData.console_log) {

		console.log(logData);
	}

	const dateObj = getDateParts(dateNow);

	const fileName = logFilePath(dateObj.date, instanceName);

	const logDataOrig = logData;

	logData = stripAnsi(logData);

	logData = logData.replace(/[\t\r\n]+/g, ' ');

	try {
		fs.appendFileSync(fileName, logData + '\n', 'utf8');
	}
	catch (e) {
		// The per-instance log directory may not exist yet on the first write (or a fresh
		// server_id folder) — create it and retry once. mkdir is recursive and idempotent.
		try { fs.mkdirSync(path.dirname(fileName), { recursive: true }); fs.appendFileSync(fileName, logData + '\n', 'utf8'); }
		catch (e2) {}
	}

	if (shareData && shareData.WebServer) {

		sendSocketMsg({

			'room': 'logs',
			'type': 'log',
			'message': ansiToHtml(logDataOrig)
		});
	}
}


// ── Per-instance data paths (single source of truth) ─────────────────────────
// Every writer (logger, retention sweep, backups) and reader (LogScan, file listing/download, the
// log-secret watchdog) resolves its paths through these helpers, so the write side and the read side
// can never drift — the previous bug class where Common.logger and LogScan independently rebuilt the
// same "<date>-<name>.log" string. Phase 0 points these at the CURRENT flat locations, so it is a
// pure refactor with no behavior change; a later phase flips the bodies to
// data/instances/<server_id>/<kind>/ without any caller changing.

// The instance's effective server_id (its data identity), or '' before it is resolved / in config mode.
function getServerId() {
	try { return (shareData.appData && shareData.appData.server_id) ? String(shareData.appData.server_id) : ''; }
	catch (e) { return ''; }
}

// The instance's IDENTIFIER name (from worker_data), synchronously. This is the stable, dash-only key
// used for log/backup filenames, config filenames and /instance/<name> routing — NOT for display.
// '' for an unnamed standalone.
function instanceNameSync() {
	try { return (shareData.appData.worker_data && shareData.appData.worker_data.name) || ''; }
	catch (e) { return ''; }
}

// The instance's human DISPLAY label — the friendly name the operator set in the Hub (may contain
// spaces). Resolves to the identifier when no display name was set (existing instances, standalone),
// so callers always get something sensible. This is the single source of truth for the label: symbot.js
// stores it on appData.instance_label at boot; everything else reads it here rather than re-deriving
// `name_display || name`. Display/UI only — never use it to build a filename or route.
function instanceLabelSync() {
	try {
		const a = shareData.appData || {};
		if (a.instance_label && String(a.instance_label).trim() !== '') { return String(a.instance_label); }
		const wd = a.worker_data;
		if (wd && wd.name_display && String(wd.name_display).trim() !== '') { return String(wd.name_display); }
	}
	catch (e) {}
	return instanceNameSync();
}

// Root of this instance's per-server_id data tree. Before server_id resolves (early boot / config
// mode) it falls back to a `_bootstrap` dir, so a path is always available.
function perInstanceRoot() {
	return pathRoot + '/data/instances/' + (getServerId() || '_bootstrap');
}

// Kinds relocated into the per-instance tree (data/instances/<server_id>/<kind>/); anything not listed
// stays in its legacy flat root location. Both logs and backups now live per-instance.
const MIGRATED_KINDS = new Set(['backups', 'logs']);

// Directory holding a KIND of this instance's data ('logs' | 'backups' | 'uploads'). A migrated kind
// lives under data/instances/<server_id>/<kind>/; anything else stays in the legacy flat root dir.
// The HUB PROCESS is not a per-instance worker — its aggregate log (<date>-hub.log) stays in the flat
// logs/ dir (its own store is already under data/hub/), so its own writes/retention keep the legacy
// location. (Only the Hub process carries appData.hub_config; per-instance workers do not.)
function instanceDataDir(kind) {
	try { if (shareData.appData && shareData.appData.hub_config) { return pathRoot + '/' + kind; } } catch (e) {}
	return MIGRATED_KINDS.has(kind) ? (perInstanceRoot() + '/' + kind) : (pathRoot + '/' + kind);
}

// Ensure a kind's directory exists (recursive — the per-instance tree has parent dirs to create).
function ensureDataDir(kind) {
	const dir = instanceDataDir(kind);
	try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
	return dir;
}

// Every instance's directory for a KIND across the per-instance tree (data/instances/*/<kind>). Used
// by the Hub to aggregate a migrated kind (e.g. list every instance's backups) without name matching.
function instanceDataDirsAll(kind) {
	const base = pathRoot + '/data/instances';
	const out = [];
	try {
		for (const sid of fs.readdirSync(base)) {
			if (sid === '_bootstrap') { continue; }   // transient pre-identity dir, not a real instance
			const d = base + '/' + sid + '/' + kind;
			try { if (fs.statSync(d).isDirectory()) { out.push(d); } } catch (e) {}
		}
	}
	catch (e) {}
	return out;
}

// Resolve a bare filename to an absolute path for download. An instance (or a non-migrated kind) reads its
// own directory. The Hub, aggregating a migrated kind across per-instance folders, resolves to the EXACT
// instance folder when a server_id is given (the robust, unambiguous path — a bare "<date>.log" can be held
// by several instances); with no server_id it falls back to the first basename match across folders (the
// legacy behaviour, kept so an old link or a still-unique filename still resolves). Both server_id and
// fileName are basename-guarded, so neither can escape the data tree. Returns null if not found.
function resolveDataFilePath(type, fileName, isHub, serverId) {
	if (!fileName || fileName !== path.basename(fileName)) { return null; }   // traversal guard (filename)
	if (isHub && MIGRATED_KINDS.has(type)) {
		if (serverId) {
			const sid = String(serverId);
			if (sid !== path.basename(sid) || sid === '.' || sid === '..') { return null; }   // traversal guard (server_id)
			const p = pathRoot + '/data/instances/' + sid + '/' + type + '/' + fileName;
			try { if (fs.lstatSync(p).isFile()) { return p; } } catch (e) {}   // lstat: a symlink is not a regular file → refused
			return null;
		}
		for (const dir of instanceDataDirsAll(type).concat([ pathRoot + '/' + type ])) {
			const p = dir + '/' + fileName;
			try { if (fs.lstatSync(p).isFile()) { return p; } } catch (e) {}
		}
		return null;
	}
	// Single instance: resolve within its own folder, and lstat-refuse anything that is not a plain regular
	// file (a symlink is not) — symmetric with the Hub branches above, so a symlink planted in the data dir
	// can never be followed on download regardless of which branch resolves it.
	const own = path.join(instanceDataDir(type), fileName);
	try { if (fs.lstatSync(own).isFile()) { return own; } } catch (e) {}
	return null;
}

// The logs directory and the dated log filename/path — used by BOTH the writer and the readers so
// they can never diverge. The per-server_id directory carries the data LOCATION (and gives
// rename-safety, since a rename never moves the folder), while the instance name stays IN the
// filename as a stable, globally-unique label: the Hub aggregates every instance's logs into one
// view, so two instances must not both produce a bare "<date>.log" that collides on listing and
// download. The Hub process itself writes "<date>-hub.log" (instanceNameSync() === 'hub').
function logDir() { return instanceDataDir('logs'); }
function logFileName(date, instanceName) {
	// The Hub process writes into the shared, flat logs/ folder, so its log keeps a distinguishing "-hub"
	// suffix. A per-instance worker owns an isolated per-server_id folder, so its log needs NO name in the
	// filename — the directory carries identity and the manifest the display label. Legacy
	// "<date>-<name>.log" files still list, search and prune fine (all the readers are name-agnostic); only
	// NEW files use this simplified name.
	let isHub = false;
	try { isHub = !!(shareData.appData && shareData.appData.hub_config); } catch (e) {}
	if (!isHub && instanceName === 'hub') { isHub = true; }   // the Hub's own writer, belt-and-suspenders
	return isHub ? (date + '-hub.log') : (date + '.log');
}
function logFilePath(date, instanceName) { return logDir() + '/' + logFileName(date, instanceName); }


// One-time, idempotent migration: move this instance's legacy flat backups
// (pathRoot/backups/SymBot-<name>-backup-…enc) into its per-server_id folder
// (data/instances/<server_id>/backups/). Runs instance-side after server_id resolves, and matches
// ONLY this instance's own filename prefix so that on a Hub-shared folder no instance ever moves
// another's file. The legacy filename is preserved on the move (listing, download and pruning are all
// name-agnostic — they key on the per-server_id folder + manifest, and rotation on the `.zip.enc` shape),
// so a mixed folder of legacy-named and new clean `backup-<date>` files is fine. Never throws.
// Move a file that may cross a filesystem boundary. fs.renameSync is atomic but throws EXDEV when the
// source and destination sit on different mounts (common when data/ is its own volume on a VPS) — and the
// migration callers swallow errors, so a bare renameSync would silently STRAND the file in its old flat
// location where the per-instance readers no longer look (retention and the Hub's listing would miss it
// too). Fall back to copy + size-verify + unlink so the file always reaches its destination. The source is
// removed only once the copy is confirmed, never ahead of a verified destination, so a failure mid-copy
// leaves the original intact rather than losing data. Throws only if even the copy fails (the caller's
// try/catch then logs and continues). Used by the log/backup migrations below.
function moveFileAcrossFs(src, dest) {

	try {

		fs.renameSync(src, dest);
	}
	catch (e) {

		if (e && e.code === 'EXDEV') {

			fs.copyFileSync(src, dest);
			if (fs.statSync(dest).size === fs.statSync(src).size) { fs.unlinkSync(src); }
		}
		else { throw e; }
	}
}


async function migrateLegacyBackups() {

	try {

		if (!getServerId()) { return; }   // no data identity yet (config mode / early boot) → skip

		const legacyDir = pathRoot + '/backups';

		let files;
		try { files = fs.readdirSync(legacyDir); } catch (e) { return; }   // no legacy dir → nothing to do

		const prefix = (shareData.appData && shareData.appData.name ? shareData.appData.name : 'SymBot') + '-backup-';
		const destDir = ensureDataDir('backups');

		let moved = 0;

		for (const f of files) {

			if (!f.startsWith(prefix)) { continue; }   // only this instance's own backups

			const src = legacyDir + '/' + f;
			const dest = destDir + '/' + f;

			try {
				if (fs.existsSync(dest)) { continue; }         // idempotent — already migrated
				if (!fs.statSync(src).isFile()) { continue; }
				moveFileAcrossFs(src, dest);
				moved++;
			}
			catch (e) {}
		}

		if (moved > 0) { logger('Migrated ' + moved + ' backup archive(s) into ' + destDir + '.'); }
	}
	catch (e) { logger('Backup migration skipped: ' + (e && e.message ? e.message : e)); }
}


// Self-heal the per-instance data folder when server_id CHANGES (a reset, restore, or override). Each
// folder carries a `.instance.json` marker keyed on a STABLE, UNIQUE identity that does NOT change on
// a server_id reset: under the Hub, the instance's own registry id (worker_data.id) — unique even when
// two instances share one app config, so this instance can never match a sibling's orphan folder; on a
// standalone install, the server_config filename, where there is only ever one instance so it cannot
// collide. On boot, once server_id is resolved, this self-heals two kinds of change:
//   - server_id changed/reset → the current-id folder is missing but an orphan folder's marker matches
//     our stable key: RENAME the orphan to the new id, carrying logs and backups across intact;
//   - instance NAME changed → the folder is right but the marker's recorded name differs: rename the
//     name-carrying files inside (logs, encrypted backups) to the new name so name-based retention,
//     own-scope filtering and the Hub's aggregated listing all keep working.
// Synchronous and must run BEFORE the first write to the new folder. Never throws.
function healDataLayout() {

	try {

		const sid = getServerId();
		if (!sid) { return; }   // no identity yet (config mode / very early) → nothing to heal

		const base = pathRoot + '/data/instances';
		const wd = (shareData.appData && shareData.appData.worker_data) ? shareData.appData.worker_data : null;
		const instId = (wd && wd.id != undefined && wd.id != null && wd.id !== '') ? String(wd.id) : '';
		const cfgKey = (shareData.appData && shareData.appData.server_config) ? shareData.appData.server_config : 'server.json';
		const currentDir = base + '/' + sid;
		const newName = instanceNameSync();

		const readMarker = (dir) => {
			try { return JSON.parse(fs.readFileSync(dir + '/.instance.json', 'utf8')); }
			catch (e) { return null; }
		};
		const writeMarker = (dir) => {
			try {
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(dir + '/.instance.json', JSON.stringify({ server_id: sid, instance_id: instId, instance_name: newName, server_config: cfgKey }, null, 2));
			}
			catch (e) {}
		};

		// Does an orphan folder's marker belong to THIS instance? Under the Hub, discriminate strictly by
		// the unique instance id; standalone (no instance id) matches the server_config filename, but only
		// against a marker that likewise carries no instance id, so a standalone never adopts a Hub folder.
		const markerIsMine = (m) => {
			if (!m) { return false; }
			if (instId) { return m.instance_id === instId; }
			return !m.instance_id && m.server_config === cfgKey;
		};

		// 1) Settle the folder for the current server_id. If it is missing, adopt this instance's orphan
		//    folder (a server_id change/reset) by renaming it to the current id.
		if (!fs.existsSync(currentDir)) {

			let orphan = null;
			try {
				for (const d of fs.readdirSync(base)) {
					if (d === sid || d === '_bootstrap') { continue; }
					if (markerIsMine(readMarker(base + '/' + d))) { orphan = d; break; }
				}
			}
			catch (e) {}

			if (orphan) {
				try {
					fs.renameSync(base + '/' + orphan, currentDir);
					logger('Data layout: server_id changed (' + orphan + ' → ' + sid + '); renamed this instance\'s data folder to self-heal — logs and backups carried across. Stranded database rows are re-homed to the current id at boot.');
				}
				catch (e) {}
			}
		}

		// 2) On an instance NAME change there is nothing to rename on disk: listing, retention and log search
		//    all key on the DIRECTORY + the artifact manifest, not on the name embedded in the filename. So a
		//    rename is just a metadata touch — refresh the display label each manifest carries.
		const prior = readMarker(currentDir);
		if (prior && prior.instance_name != null && prior.instance_name !== '' && prior.instance_name !== newName) {
			refreshArtifactDisplayName(currentDir, newName);
			logger('Data layout: instance renamed (' + prior.instance_name + ' → ' + newName + '); updated the artifact manifests\' display name — no files renamed (identity is the folder, not the filename).');
		}

		// 3) Refresh the marker to the current identity.
		writeMarker(currentDir);
	}
	catch (e) {}

	return null;
}


// After an instance rename, refresh the DISPLAY label each artifact manifest carries (logs + backups) so
// the UI shows the new name. No files move: the per-server_id directory and the manifest are the identity
// now, so a rename is a metadata touch, not a disk rewrite. Only touches a manifest whose directory already
// exists (never creates an empty artifact folder). Never throws.
function refreshArtifactDisplayName(instanceDir, newName) {

	for (const kind of [ 'logs', 'backups' ]) {

		try {
			const dir = instanceDir + '/' + kind;
			if (!fs.existsSync(dir)) { continue; }
			const manifest = ArtifactIndex.load(dir, kind);
			manifest.instance_name = String(newName == null ? '' : newName);
			ArtifactIndex.save(dir, manifest);
		}
		catch (e) {}
	}
}


// Move the early-boot bootstrap logs (written before server_id resolved) into this instance's real
// per-server_id logs folder, merging any same-date file. Under the Hub several instance workers share
// one filesystem and all write to _bootstrap/logs before their ids resolve, so match ONLY this
// instance's own "<date>-<name>.log" files — the name in the filename tells the workers apart, so no
// worker sweeps another's early-boot lines. Never throws.
async function relocateBootstrapLogs() {

	try {

		if (!getServerId()) { return; }

		const bootDir = pathRoot + '/data/instances/_bootstrap/logs';

		let files;
		try { files = fs.readdirSync(bootDir); } catch (e) { return; }

		const name = instanceNameSync();
		const esc = name ? String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
		const re = esc ? new RegExp('^\\d{4}-\\d{2}-\\d{2}-' + esc + '\\.log$') : /^\d{4}-\d{2}-\d{2}\.log$/;

		const destDir = ensureDataDir('logs');
		let moved = 0;

		for (const f of files) {

			if (!re.test(f)) { continue; }

			const src = bootDir + '/' + f;
			const dest = destDir + '/' + f;

			try {
				if (fs.existsSync(dest)) { fs.appendFileSync(dest, fs.readFileSync(src)); fs.unlinkSync(src); }
				else { moveFileAcrossFs(src, dest); }
				moved++;
			}
			catch (e) {}
		}

		try { if (fs.readdirSync(bootDir).length === 0) { fs.rmdirSync(bootDir); } } catch (e) {}

		if (moved > 0) { logger('Relocated ' + moved + ' bootstrap log file(s) into ' + destDir + '.'); }
	}
	catch (e) {}
}


// One-time, idempotent migration: move this instance's legacy flat logs
// (pathRoot/logs/<date>-<name>.log) into its per-server_id folder, keeping the same filename so each
// instance's logs stay uniquely named for the Hub's aggregated view. Own files only, matched on the
// date boundary so a name that is a PREFIX of another can't pick up the other's logs. Never throws.
async function migrateLegacyLogs() {

	try {

		if (!getServerId()) { return; }

		const legacyDir = pathRoot + '/logs';

		let files;
		try { files = fs.readdirSync(legacyDir); } catch (e) { return; }

		const name = instanceNameSync();
		const esc = name ? String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
		// This instance's legacy log files: "<date>-<name>.log" (named) or "<date>.log" (unnamed).
		const re = esc ? new RegExp('^\\d{4}-\\d{2}-\\d{2}-' + esc + '\\.log$') : /^\d{4}-\d{2}-\d{2}\.log$/;

		const destDir = ensureDataDir('logs');
		let moved = 0;

		for (const f of files) {

			if (!re.test(f)) { continue; }

			const src = legacyDir + '/' + f;
			const dest = destDir + '/' + f;   // keep the same filename (name stays for uniqueness)

			try {
				if (!fs.statSync(src).isFile()) { continue; }
				if (fs.existsSync(dest)) { fs.appendFileSync(dest, fs.readFileSync(src)); fs.unlinkSync(src); }
				else { moveFileAcrossFs(src, dest); }
				moved++;
			}
			catch (e) {}
		}

		if (moved > 0) { logger('Migrated ' + moved + ' log file(s) into ' + destDir + '.'); }
	}
	catch (e) { logger('Log migration skipped: ' + (e && e.message ? e.message : e)); }
}


// The one instance-side data-layout boot step: relocate bootstrap logs, then migrate legacy flat logs
// and backups into the per-server_id tree. Runs after server_id is resolved (healDataLayout has
// already run synchronously to reconcile any id change). Idempotent; never blocks startup.
async function migrateDataLayout() {
	await relocateBootstrapLogs();
	await migrateLegacyLogs();
	await migrateLegacyBackups();
}


// ── Password re-key crash-safety journal ─────────────────────────────────────────────────────────────
// A password change / console reset re-encrypts the exchange credentials (bot-config file) and the app
// password anchor (app.json) under the new key. Those are two separate files that cannot be written
// atomically, so a crash BETWEEN the two writes could leave the bot-config re-keyed but the anchor still
// old — and on the next boot the exchange credentials would (correctly) fail to decrypt under the stale
// anchor, halting trading until the operator re-entered them. This tiny write-ahead journal closes that
// window: it is written BEFORE the first file is committed and removed AFTER the last, so if it survives to
// the next boot a re-key was interrupted. recoverRekeyJournal() then finishes it deterministically — and
// ONLY when it can prove the outcome from the on-disk credentials; anything ambiguous is left untouched for
// the decryptability watchdog, so recovery can never make trading worse than the existing safety net. The
// common boot path is a single existsSync that returns immediately (the journal almost never exists).

function rekeyJournalPath() { return perInstanceRoot() + '/.rekey.json'; }

function writeRekeyJournal(entry) {
	try {
		const tmp = rekeyJournalPath() + '.tmp';
		fs.writeFileSync(tmp, JSON.stringify(entry));
		fs.renameSync(tmp, rekeyJournalPath());   // atomic publish
	}
	catch (e) { logger('Re-key journal write skipped: ' + (e && e.message ? e.message : e)); }   // best-effort — never block a password change
}

function clearRekeyJournal() {
	try { if (fs.existsSync(rekeyJournalPath())) { fs.unlinkSync(rekeyJournalPath()); } }
	catch (e) { /* leave it; recovery is idempotent and re-evaluates on the next boot */ }
}


// Finish (or safely discard) a password re-key that a crash interrupted. Runs once at boot, right after the
// data-layout self-heal and BEFORE the trading engine connects to the exchange. Conservative by
// construction: it only rewrites app.json when it can PROVE the exchange credentials are already encrypted
// under the new key (so the anchor merely needs to catch up); every other state is left untouched for the
// decryptability watchdog. Never throws.
async function recoverRekeyJournal() {

	let journal = null;

	try {
		const p = rekeyJournalPath();
		if (!fs.existsSync(p)) { return; }                       // the common case — no interrupted re-key
		journal = JSON.parse(fs.readFileSync(p, 'utf8'));
	}
	catch (e) { logger('Re-key recovery: journal unreadable, ignoring: ' + (e && e.message ? e.message : e)); return; }

	try {
		const oldKey = journal && journal.old;
		const newKey = journal && journal.new;
		const appConfigFile = journal && journal.app_config;
		const botConfigFile = journal && journal.bot_config;

		if (!oldKey || !newKey || !appConfigFile) { clearRekeyJournal(); return; }   // malformed → discard

		const appRes = await getConfig(appConfigFile);
		const appData = (appRes && appRes.success !== false) ? appRes.data : null;
		if (!appData || typeof appData !== 'object') { clearRekeyJournal(); return; }

		// The app.json anchor was already advanced to the new key → the re-key completed; just clear.
		if (appData.password === newKey) { clearRekeyJournal(); return; }

		// The anchor is NOT the new key. Decide from the ON-DISK exchange credentials whether the re-key had
		// reached the bot-config (the first file committed) before the crash. botReadOk records that the
		// bot-config was actually inspected (read cleanly, or genuinely absent) — a bot-config we could not
		// read this boot leaves us unable to prove anything, so it must be treated as unresolved, NOT as
		// "no credentials", or a transient read hiccup during a half-applied re-key could orphan real creds.
		let botNew = false, botOld = false, botEncryptedSeen = false, botReadOk = false;

		if (!botConfigFile) {

			botReadOk = true;   // no bot-config configured at all → there are genuinely no exchange credentials
		}
		else if (shareData.System && typeof shareData.System.decrypt === 'function') {

			const botRes = await getConfig(botConfigFile);
			const botCfg = (botRes && botRes.success !== false) ? botRes.data : null;

			if (botCfg) {
				botReadOk = true;
				for (const f of [ 'apiKey', 'apiSecret', 'apiPassphrase', 'apiPassword' ]) {
					const v = botCfg[f];
					if (!v || typeof v !== 'string' || !isEncrypted(v)) { continue; }
					botEncryptedSeen = true;
					const dNew = await shareData.System.decrypt(v, newKey);
					if (dNew && dNew.success) { botNew = true; continue; }
					const dOld = await shareData.System.decrypt(v, oldKey);
					if (dOld && dOld.success) { botOld = true; }
				}
			}
			// else: bot-config present but unreadable this boot → botReadOk stays false (defer to the watchdog)
		}

		// Complete the re-key forward only when it is SAFE to advance the anchor to the new key: either the
		// exchange credentials are PROVEN already under the new key (a half-applied re-key), OR the bot-config
		// was read cleanly and holds no encrypted exchange credentials to orphan. In both cases finishing the
		// re-key (app.json's own secrets + the DB backup secrets + the anchor) via the same round-trip-verified
		// path leaves every store agreeing on the new key — and, in the no-credential case, also re-keys any DB
		// backup secret the crash had already advanced, so nothing is left orphaned. We deliberately do NOT
		// advance the anchor when the bot-config could not be read: it might still hold credentials under the
		// OLD key, and advancing would orphan them (that case falls through to the watchdog below).
		const canComplete = (botEncryptedSeen && botNew && !botOld) || (botReadOk && !botEncryptedSeen);

		if (canComplete) {

			if (shareData.System && typeof shareData.System.rekeyAllSecrets === 'function') {
				await shareData.System.rekeyAllSecrets(appData, oldKey, newKey);
			}
			appData.password = newKey;
			await saveConfig(appConfigFile, appData);
			shareData.appData.password = newKey;
			clearRekeyJournal();
			logger('Recovered an interrupted password change at startup: the app configuration was brought in line with the new password. No action needed.');
			return;
		}

		if (botEncryptedSeen && botOld && !botNew) {

			// The exchange credentials are still under the OLD key → the change never reached its first
			// commit. Discard the journal; the old, consistent state stands.
			clearRekeyJournal();
			return;
		}

		// Unreadable bot-config, or a genuinely contradictory state (credentials that decrypt under BOTH keys,
		// or under neither) — never guess on the money path: leave every file as-is and let the decryptability
		// watchdog surface it with operator guidance, exactly as before this journal existed. A later boot that
		// can read the bot-config re-evaluates and completes.
		logger('Re-key recovery: an interrupted password change was detected but its state could not be resolved this boot; leaving it for the integrity watchdog. If the exchange connection is refused, re-enter your API credentials in the configuration.');
	}
	catch (e) {
		logger('Re-key recovery skipped after an error (left for the watchdog): ' + (e && e.message ? e.message : e));
	}
}


// ── Log artifact index / retention ──────────────────────────────────────────
// Old-log cleanup keys on the per-instance logs directory's manifest (ArtifactIndex) rather than a per-name
// regex + filesystem mtime. Because each instance owns its own logs folder, EVERY dated log in it is this
// instance's, so retention no longer depends on the filename carrying the instance name — a log whose name
// stops matching an old regex can no longer escape cleanup and grow the disk without bound. A log's age is
// its DATE (from the filename), so a file touched today but dated weeks ago is pruned correctly (the old
// mtime sort got that wrong). The per-line logger is never involved: the index is maintained HERE, on the
// periodic sweep, so nothing is added to the hot logging path.

// Display/identity context stored in every artifact manifest (logs AND backups). server_id is the immutable
// data-identity key; instance_name is the human display label a rename updates (never the filename). Read
// defensively so a partially-initialised appData can't throw here. Shared by System's backup indexing so the
// two kinds record identity identically.
function instanceIndexMeta() {
	const ad = (shareData && shareData.appData) ? shareData.appData : {};
	const wd = ad.worker_data || {};
	const name = (wd.name_display && String(wd.name_display).trim()) || wd.name || instanceNameSync() || ad.name || '';
	return { server_id: ad.server_id != null ? String(ad.server_id) : '', instance_name: String(name) };
}

// Delete this instance's log files older than `maxDays`, by the log's own date, via the directory manifest.
// The Hub process shares the flat logs/ folder, so there it tracks ONLY its own "<date>-hub.log"; a
// per-instance worker owns an isolated folder, so it tracks every "<date>(-name)?.log" in it. Today's log
// (age 0) is never eligible while maxDays >= 1, so the file being actively appended is always safe.
// Best-effort; never throws.
function retainLogs(maxDays, dirOverride) {
	try {
		const days = Number(maxDays);
		if (!(days >= 1)) { return; }
		const dir = dirOverride || logDir();   // dirOverride is a testability seam; production always uses logDir()
		// A per-instance worker owns an ISOLATED folder, so track EVERY date-prefixed .log in it — including
		// odd suffixes like "<date>-.log" that a name quirk once produced — so no log can escape cleanup.
		// The Hub process shares the flat logs/ folder with other instances' not-yet-migrated leftovers, so
		// there it must stay strict and prune ONLY its own "<date>-hub.log".
		const isHub = !!(shareData.appData && shareData.appData.hub_config);
		const isArtifact = isHub
			? (n) => /^\d{4}-\d{2}-\d{2}-hub\.log$/.test(n)
			: isLogArtifact;
		const deriveEntry = (name) => { const d = name.slice(0, 10); return { date: d, created_utc: d + 'T00:00:00.000Z' }; };
		const r = ArtifactIndex.reconcile(dir, { kind: 'logs', meta: instanceIndexMeta(), isArtifact: isArtifact, deriveEntry: deriveEntry });

		// Expire by CALENDAR DATE — the basis logs are actually named on — not by an absolute-timestamp age.
		// Log filenames use the server's LOCAL date, so measuring age with Date.now() against a local date
		// pinned to UTC midnight skews by the UTC offset and could delete TODAY's still-open log at
		// max_log_days = 1 anywhere west of UTC. Keep today plus the previous (days-1) local days; because the
		// cutoff is derived the same local way the filename is, today's date is never below it (days >= 1).
		// Step back whole days from local NOON (not from Date.now()): anchoring at noon means the ±1h shift on a
		// DST-transition day can never move the cutoff onto the adjacent local date. JS normalises the day
		// underflow across month/year boundaries.
		const t = getDateParts(new Date());
		const cutoffDate = getDateParts(new Date(Number(t.year), Number(t.month) - 1, Number(t.day) - (days - 1), 12, 0, 0)).date;
		const victims = r.manifest.entries.filter((e) => {
			const d = (typeof e.date === 'string' && e.date) ? e.date : String(e.file || '').slice(0, 10);
			return /^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoffDate;
		});
		for (const v of victims) {
			try { fs.unlinkSync(path.join(dir, v.file)); } catch (e) {}
			ArtifactIndex.dropByFile(r.manifest, v.file);
		}
		if (victims.length) { ArtifactIndex.save(dir, r.manifest); }
	}
	catch (e) {}
}


function logMonitor() {

	const hoursInterval = 4;

	let maxDays = shareData['appData']['max_log_days'];

	if (maxDays == undefined || maxDays == null || maxDays < 1) {

		maxDays = 10;
	}

	// Monitor and remove old logs (via the directory manifest) plus sweep the ephemeral dirs. Each cleanup
	// is isolated so a missing directory or a stat/unlink race throws only a logged warning for that one
	// target — it can never abort the remaining cleanups or surface as an uncaught exception every interval.
	// This periodic background work stays self-contained rather than leaning on the global process-level net.
	// Run one log pass immediately at boot (server_id is resolved by now) so old logs are pruned and the log
	// manifest is populated from the start, rather than waiting for the first interval hours later.
	retainLogs(maxDays);

	setInterval(() => {

		const sweep = (dir, days, deleteSubdirs, matchFn) => {
			try { delFiles(dir, days, deleteSubdirs, matchFn); }
			catch (e) { try { logger('Log/temp cleanup skipped for ' + dir + ': ' + ((e && e.message) ? e.message : e)); } catch (le) {} }
		};

		retainLogs(maxDays);                        // manifest-based, by log date (self-wrapped)
		sweep(pathRoot + '/temp', 1, true);
		sweep(pathRoot + '/uploads', 1, true);
		sweep(pathRoot + '/downloads', 1, true);

	}, (hoursInterval * (60 * 60 * 1000)));
}


async function delay(msec) {

	return new Promise(resolve => {

		setTimeout(() => { resolve('') }, msec);
	});
}


// The IDENTIFIER name (dash-only key). Use for filenames, log names, routing — never for display.
async function getInstanceName() {

	return instanceNameSync();
}


// The human DISPLAY label (friendly name; falls back to the identifier). Use for anything shown to a
// user. Async sibling of getInstanceName so callers can pick identifier-vs-label at the call site.
async function getInstanceLabel() {

	return instanceLabelSync();
}


async function getSignalConfigs() {

	let isError;
	let count = 1;
	let success = true;
	let configs = {};

	let dir = pathRoot + '/libs/signals';

	let files = fs.readdirSync(dir);

	for (let i in files) {

		let file = dir + '/' + files[i];

		let stats = fs.statSync(file);

		let created = stats.ctime;
		let modified = stats.mtime;

		if (stats.isDirectory()) {

			let signalFile = file + '/signals.json';

			if (fs.existsSync(signalFile)) {

				try {
					let data = JSON.parse(
						fs.readFileSync(signalFile, {
							encoding: 'utf8',
							flag: 'r'
						})
					);

					data.file = file;

					let dataRoot = {};
					dataRoot['PROVIDER' + count] = data;

					configs = Object.assign({}, configs, dataRoot);

					count++;
				}
				catch (e) {
							isError = 'File: ' + signalFile + ' ' + e;
							success = false;
						  }
			}
		}
	}

	return { 'success': success, 'data': configs, 'error': isError };
}


// Delete files older than `days` in `directory`. `matchFn(fileName)` — when provided — restricts
// deletion to files it returns true for, so an instance's cleanup only ever removes ITS OWN files
// and never another instance's logs/backups in a shared install. Directories are still recursed
// (for size) when deleteSubdirs is set, but a file is only unlinked if it passes matchFn.
function delFiles(directory, days, deleteSubdirs, matchFn) {

    const dateNow = new Date();
    const secondsPerDay = 86400;
    const matches = (typeof matchFn === 'function') ? matchFn : () => true;

    function isDirectoryEmpty(dir) {

        return fs.readdirSync(dir).length === 0;
    }

    function getDirectoryModificationTime(dir) {

        try {
            const stats = fs.statSync(dir);
            return stats.mtime;
        }
		catch (err) {

			//console.error(`Error getting modification time for directory ${dir}:`, err);
            return null;
        }
    }

    function deleteFilesInDir(dir, days) {

        let isDirEmpty = true;
        let dirModifiedTime = getDirectoryModificationTime(dir);

        fs.readdirSync(dir).forEach(file => {

            const filePath = path.join(dir, file);
            const stats = fs.statSync(filePath);
            const diffSec = (dateNow.getTime() - stats.mtime.getTime()) / 1000;

            if (stats.isDirectory()) {
                // Recursively process subdirectories
                if (deleteSubdirs) {
                    deleteFilesInDir(filePath, days);

                    // Get the updated modification time after processing subdirectory
                    dirModifiedTime = getDirectoryModificationTime(dir);

                    // Remove empty subdirectory if it's not the main directory
                    if (dir !== directory && isDirectoryEmpty(filePath)) {
                        fs.rmdirSync(filePath);
                    }
                }
                isDirEmpty = false; // A directory is not empty if it has files or subdirectories
            } else if (diffSec >= secondsPerDay * days && matches(file)) {
                fs.unlinkSync(filePath);
                isDirEmpty = false;
            } else if (diffSec < secondsPerDay * days || !matches(file)) {
                // a file that is too new, or not this instance's, keeps the directory non-empty
                isDirEmpty = false;
            }
        });

        // Remove directory if it's empty, deleteSubdirs is true, and it's not the main directory
        if (deleteSubdirs && dir !== directory && isDirEmpty && isDirectoryEmpty(dir)) {
            // Check if the directory modification time is old enough to be deleted
            const dirAgeSec = (dateNow.getTime() - dirModifiedTime.getTime()) / 1000;
            if (dirAgeSec >= secondsPerDay * days) {
                fs.rmdirSync(dir);
            }
        }
    }

    deleteFilesInDir(directory, days);
}


async function getProcessInfo() {

	let memoryUsage = process.memoryUsage();

	Object.keys(memoryUsage).forEach((key) => {

		memoryUsage[key] = ((memoryUsage[key] / (1024 * 1024)).toFixed(2)) + 'MB';
	});

	const obj = {
					'pid': process.pid,
					'memory_usage': memoryUsage,
					'file_name': path.basename(shareData.appData.app_filename),
				};

	return obj;
}


// Accurate AVAILABLE host memory, computed with only Node built-ins (no shell, no native module), and
// per-platform because os.freemem() means different things on different OSes:
//   • Linux  → MemAvailable from /proc/meminfo (counts reclaimable page cache; a plain fs read).
//              os.freemem() there is MemFree, which EXCLUDES that cache and badly understates headroom.
//   • Windows → os.freemem() already reports AVAILABLE physical memory, so it is used as-is.
//   • macOS / other → no pure-Node source for true availability (it needs vm_stat / Mach APIs), so
//              os.freemem() (free pages only) is returned but flagged reliable:false, so a caller can
//              SHOW the figure yet not alert on a number it knows understates availability on that OS.
// Shared single source: the System Tools health card (getSystemHealth) and the resource_sentinel
// scheduled task both read host memory through here, so the platform handling lives in one place.
// HUB NOTE: this is a HOST-level reading — every instance in one Hub process shares the same machine,
// so it is identical across those workers (it describes the host, not a single instance).
function hostMemory() {

	const totalBytes = os.totalmem();
	if (!(totalBytes > 0)) { return { totalBytes: 0, availableBytes: null, availablePct: null, reliable: false, basis: 'unknown' }; }

	if (process.platform === 'linux') {

		try {
			const info = fs.readFileSync('/proc/meminfo', 'utf8');
			const availKb = /^MemAvailable:\s+(\d+)\s*kB/m.exec(info);
			const totalKb = /^MemTotal:\s+(\d+)\s*kB/m.exec(info);
			if (availKb && totalKb) {
				const availableBytes = Number(availKb[1]) * 1024;
				const tb = Number(totalKb[1]) * 1024;
				if (tb > 0) { return { totalBytes: tb, availableBytes, availablePct: Math.round((availableBytes / tb) * 100), reliable: true, basis: 'available' }; }
			}
		}
		catch (e) { /* /proc unreadable → fall through to os.freemem below */ }
	}

	const availableBytes = os.freemem();
	const reliable = (process.platform === 'win32');   // Windows os.freemem() == available physical memory
	return { totalBytes, availableBytes, availablePct: Math.round((availableBytes / totalBytes) * 100), reliable, basis: reliable ? 'available' : 'free' };
}


// Accurate per-instance system health for the System Tools health card.
//
// MEMORY ACCURACY (mirrors the Hub #67 attribution model):
//   process.memoryUsage().rss is PROCESS-WIDE. When this instance runs as a Hub
//   worker thread, every instance in the Hub process shares the same rss, so rss
//   is NOT attributable to one instance — the honest per-instance figure is
//   heapUsed + external + arrayBuffers ("attributed"). When this instance runs
//   standalone (its own process), rss IS its real footprint and is meaningful.
//   We detect context via appData.parent_port (set only for Hub workers) and
//   expose BOTH numbers plus which one is authoritative for this context, so the
//   card never shows a misleading shared rss as if it were the instance's own.
// Safe arithmetic evaluator — supports + - * / ^ % , parentheses, unary +/-, decimals and scientific
// notation. It is a hand-written recursive-descent parser over a fixed token set: it never uses eval or
// the Function constructor, so it cannot execute arbitrary code no matter what string is passed. Returns
// { ok: true, value } or { ok: false, error }. Backs the AI `calculate` tool so a small model never has
// to do multi-step arithmetic (safety-order compounding, percentages) in its head. Single exit.
function safeEvalArithmetic(expr) {

	const s = String(expr == null ? '' : expr).trim();
	let result;

	if (s === '') { result = { ok: false, error: 'empty expression' }; }
	else if (s.length > 200) { result = { ok: false, error: 'expression too long' }; }
	else {

		// Tokenize into numbers and single-char operators/parentheses; any other character is rejected.
		const tokens = [];
		const re = /\s*([0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|[-+*/^%()])\s*/y;
		let i = 0;
		let bad = false;

		while (i < s.length) {
			re.lastIndex = i;
			const m = re.exec(s);
			if (!m || m.index !== i) { bad = true; break; }
			tokens.push(m[1]);
			i = re.lastIndex;
		}

		if (bad || !tokens.length) { result = { ok: false, error: 'invalid character in expression' }; }
		else {

			let p = 0;
			let error = null;
			const peek = () => tokens[p];
			const next = () => tokens[p++];

			// expr = term (('+'|'-') term)* ; term = factor (('*'|'/'|'%') factor)* ;
			// factor = base ('^' factor)? ; base = number | '(' expr ')' | ('-'|'+') base
			const parseExpr = () => {
				let v = parseTerm();
				while (!error && (peek() === '+' || peek() === '-')) { const op = next(); const r = parseTerm(); v = op === '+' ? v + r : v - r; }
				return v;
			};
			const parseTerm = () => {
				let v = parseFactor();
				while (!error && (peek() === '*' || peek() === '/' || peek() === '%')) {
					const op = next(); const r = parseFactor();
					if (op === '*') { v = v * r; }
					else if (r === 0) { error = 'division by zero'; }
					else { v = op === '/' ? v / r : v % r; }
				}
				return v;
			};
			const parseFactor = () => {
				const b = parseBase();
				if (!error && peek() === '^') { next(); return Math.pow(b, parseFactor()); }
				return b;
			};
			const parseBase = () => {
				const tk = peek();
				if (tk === '-') { next(); return -parseBase(); }
				if (tk === '+') { next(); return parseBase(); }
				if (tk === '(') { next(); const v = parseExpr(); if (peek() !== ')') { error = 'unbalanced parentheses'; return 0; } next(); return v; }
				if (tk !== undefined && /^[0-9.]/.test(tk)) { next(); return parseFloat(tk); }
				error = 'unexpected token'; return 0;
			};

			const value = parseExpr();

			if (error) { result = { ok: false, error: error }; }
			else if (p !== tokens.length) { result = { ok: false, error: 'unexpected trailing input' }; }
			else if (!Number.isFinite(value)) { result = { ok: false, error: 'result is not a finite number' }; }
			else { result = { ok: true, value: value }; }
		}
	}

	return result;
}


async function getSystemHealth() {

	const mem = process.memoryUsage();

	const bytesToMb = (b) => Number(((b || 0) / (1024 * 1024)).toFixed(2));

	// Host memory via the shared, platform-accurate helper (fixes os.freemem() understating available
	// memory on Linux and macOS). Same single source the resource_sentinel scheduled task reads.
	const hostMem = hostMemory();

	// Portion genuinely attributable to THIS instance (same formula as Hub Main.js).
	const attributed = (mem.heapUsed || 0) + (mem.external || 0) + (mem.arrayBuffers || 0);

	// Is this instance a Hub worker (shares the process) or standalone?
	const isHubWorker = shareData.appData.parent_port != null;

	// Uptime from when this instance started.
	const started = shareData.appData.started ? new Date(shareData.appData.started) : null;
	const uptimeSeconds = started ? Math.max(0, Math.floor((Date.now() - started.getTime()) / 1000)) : null;

	// Active deal count (best-effort; never let it break the health payload).
	let activeDeals = null;

	try {

		const deals = await shareData.DCABot.getActiveDeals(true);
		activeDeals = Array.isArray(deals) ? deals.length : null;
	}
	catch (e) {

		activeDeals = null;
	}

	// Host CPU load. os.loadavg() returns [1m, 5m, 15m] run-queue averages; pairing
	// it with the core count lets the UI show an easy-to-read "% of cores" figure
	// (raw load is meaningless without knowing how many cores it's spread across).
	// On platforms that don't report load (e.g. Windows) loadavg() returns zeros.
	const loadAvg = os.loadavg();
	const cpuCount = Array.isArray(os.cpus()) ? os.cpus().length : null;

	const obj = {
					'pid': process.pid,
					'is_hub_worker': isHubWorker,
					'memory': {
						// The figure to display prominently for this context:
						// standalone -> rss (real process footprint);
						// Hub worker -> attributed (rss would be the shared total).
						'primary_mb': isHubWorker ? bytesToMb(attributed) : bytesToMb(mem.rss),
						'primary_label': isHubWorker ? 'Attributed' : 'RSS',
						'attributed_mb': bytesToMb(attributed),
						'rss_mb': bytesToMb(mem.rss),
						'heap_used_mb': bytesToMb(mem.heapUsed),
						'heap_total_mb': bytesToMb(mem.heapTotal),
						'external_mb': bytesToMb(mem.external),
						'array_buffers_mb': bytesToMb(mem.arrayBuffers),
						// rss is process-wide when running as a Hub worker — flag it so
						// the UI can annotate rather than mislead.
						'rss_is_shared': isHubWorker
					},
					'uptime_seconds': uptimeSeconds,
					'started': started ? started.toISOString() : null,
					'active_deals': activeDeals,
					'load_avg': Array.isArray(loadAvg) ? loadAvg.map(l => Math.round(l * 100) / 100) : null,
					'cpu_count': cpuCount,
					'app_version': shareData.appData.version || null,
					'platform': process.platform,
					'host_total_mem_mb': bytesToMb(hostMem.totalBytes),
					// AVAILABLE memory from the shared helper — on Linux this is MemAvailable (counts
					// reclaimable cache), not the misleading MemFree; on macOS it falls back to free pages,
					// flagged via host_mem_reliable/basis so the card can label it honestly.
					'host_available_mem_mb': hostMem.availableBytes != null ? bytesToMb(hostMem.availableBytes) : null,
					'host_mem_basis': hostMem.basis,
					'host_mem_reliable': hostMem.reliable
				};

	return obj;
}


function getDateParts(date, utc) {

	let year;
	let month;
	let day;
	let hour;
	let min;
	let sec;

	let dateObj = new Date(date);

	if (!utc) {
		year = dateObj.getFullYear();
		month = dateObj.getMonth() + 1;
		day = dateObj.getDate();

		hour = dateObj.getHours();
		min = dateObj.getMinutes();
		sec = dateObj.getSeconds();
	} else {
		year = dateObj.getUTCFullYear();
		month = dateObj.getUTCMonth() + 1;
		day = dateObj.getUTCDate();

		hour = dateObj.getUTCHours();
		min = dateObj.getUTCMinutes();
		sec = dateObj.getUTCSeconds();
	}

	if (day < 10) {
		day = '0' + day;
	}

	if (month < 10) {
		month = '0' + month;
	}

	if (hour < 10) {
		hour = '0' + hour;
	}

	if (min < 10) {
		min = '0' + min;
	}

	if (sec < 10) {
		sec = '0' + sec;
	}

	let datePart = year + '-' + month + '-' + day;
	let timePart = hour + ':' + min + ':' + sec;

	let hourTemp = parseInt(timePart.split(':')[0]) % 12;

	if (hourTemp < 10) {
		hourTemp = '0' + hourTemp;
	}

	let timePartAmPm =
		(hourTemp == 0 ? '12' : hourTemp) +
		':' +
		timePart.split(':')[1] +
		' ' +
		(parseInt(parseInt(timePart.split(':')[0]) / 12) < 1 ? 'AM' : 'PM');

	let dateParts = {
		year: year,
		month: month,
		day: day,
		hour: hour,
		minute: min,
		second: sec,
		date: datePart,
		time: timePart,
		timeAmPm: timePartAmPm,
	};

	return dateParts;
}


// ── Timezone-aware calendar-day helpers ──────────────────────────────────────
// Resolve "which calendar day" an instant falls on, and the UTC span of a calendar day, in a CALLER-
// CHOSEN timezone rather than only the server's. Used so a user reaches the same "today"/"this month"
// answer whether the server runs UTC or they connect remotely from another zone. IANA names (e.g.
// "America/New_York") are DST-correct; a null/invalid zone falls back to the SERVER-LOCAL day (via
// getDateParts), preserving prior behavior. Pure, no I/O — safe to reuse anywhere.

// Validate an IANA timezone name; returns the usable name or null.
function normalizeTimeZone(tz) {

	let out = null;

	if (typeof tz === 'string' && tz.trim() !== '') {
		const name = tz.trim();
		try { new Intl.DateTimeFormat('en-US', { timeZone: name }); out = name; }
		catch (e) { out = null; }
	}

	return out;
}

// Offset in MILLISECONDS to add to a UTC instant to get local wall-clock time in `tz`, at that instant
// (so it reflects DST correctly). Returns 0 on any failure. Single exit.
function tzOffsetMsAt(instant, tz) {

	let ms = 0;

	try {
		const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
			.formatToParts(instant instanceof Date ? instant : new Date(instant))
			.reduce((a, x) => { a[x.type] = x.value; return a; }, {});
		let hh = parseInt(p.hour, 10); if (hh === 24) { hh = 0; }
		ms = Date.UTC(+p.year, +p.month - 1, +p.day, hh, +p.minute, +p.second) - (instant instanceof Date ? instant.getTime() : new Date(instant).getTime());
	}
	catch (e) { ms = 0; }

	return ms;
}

// The YYYY-MM-DD calendar date of an instant in `tz` (or the server-local date when tz is null/invalid).
function zonedDateStr(instant, tz) {

	const d = (instant instanceof Date) ? instant : new Date(instant);
	const name = normalizeTimeZone(tz);

	if (name) {
		try { return new Intl.DateTimeFormat('en-CA', { timeZone: name, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
		catch (e) { /* fall through to server-local */ }
	}

	return getDateParts(d).date;
}

// The UTC [from, to] Date instants covering the local calendar day `dateStr` (YYYY-MM-DD) in `tz`. When
// tz is null/invalid the day is the SERVER-LOCAL day (matching how the logger names its files), so the
// default is unchanged. Returns null for an unparseable date. Single exit.
function zonedDayRangeUTC(dateStr, tz) {

	let out = null;
	const parts = String(dateStr || '').split('-').map(Number);

	if (parts.length === 3 && !parts.some(isNaN)) {
		const [ y, m, d ] = parts;
		const name = normalizeTimeZone(tz);
		// Offset anchored at local noon of the day, so a DST transition at ~midnight can't flip it.
		const offMs = name
			? tzOffsetMsAt(new Date(Date.UTC(y, m - 1, d, 12, 0, 0)), name)
			: -(new Date(y, m - 1, d, 12, 0, 0).getTimezoneOffset()) * 60000;
		const startUTC = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - offMs;
		out = { from: new Date(startUTC), to: new Date(startUTC + 86400000 - 1) };
	}

	return out;
}


function timeDiff(dateStart, dateEnd) {

	let diff = Math.abs(dateEnd - dateStart) / 1000;

	let diffString = '';

	let days = Math.floor(diff / 86400);
	diff -= days * 86400;

	let hours = Math.floor(diff / 3600) % 24;
	diff -= hours * 3600;

	let minutes = Math.floor(diff / 60) % 60;
	diff -= minutes * 60;

	let seconds = Math.floor(diff / 1) % 60;
	diff -= seconds * 60;

	if (days > 0) {
		diffString += `${days}d`;
	}

	if (hours > 0) {
		diffString += ` ${hours}h`;
	}

	if (minutes > 0) {
		diffString += ` ${minutes}m`;
	}

	if (seconds > 0) {
		diffString += ` ${seconds}s`;
	}

	diffString = diffString.trim();

	return diffString;
}

function dealDurationMinutes(dateStart, dateEnd) {

	let diff = Math.abs(dateEnd - dateStart) / 1000;

	let minutes = Math.floor(diff / 60);

	return minutes;

}


// Aggregate stats over an array of processed (closed) deals. This is the single
// source of truth for the "how did a set of deals do" primitives that both the
// dashboard (per-bot groups) and the Trading Journal (flat, filter-wide) need,
// so the two can never drift on the definition of a win, a win rate, an average
// duration, etc. Pure — no shareData, no I/O. A "win" is profit > 0.
//   deals: array of objects with numeric `profit`, `safety_orders`, and
//          `date_start` / `date_end` (Date or ms).
// Returns raw aggregates plus the rounded presentation values the callers use.
function roundWinRate(wins, total) {

	if (total <= 0) { return 0; }

	const pct = Math.round((wins / total) * 100);

	// Never let rounding show a misleading boundary: a set with any loss must not
	// read as a perfect 100%, and a set with any win must not read as 0%. Only a
	// truly perfect (all wins) or winless set shows the 100% / 0% boundary.
	if (pct >= 100 && wins < total) { return 99; }
	if (pct <= 0 && wins > 0) { return 1; }

	return pct;
}


function computeDealSetStats(deals) {

	deals = Array.isArray(deals) ? deals : [];

	let total = 0;
	let wins = 0;
	let breakEven = 0;     // profit === 0 is a real break-even outcome, NOT a loss
	let totalProfit = 0;
	let durationSum = 0;
	let soSum = 0;
	let grossProfit = 0;   // sum of winning-deal profits
	let grossLoss = 0;     // sum of |losing-deal profits|

	for (const d of deals) {

		const profit = Number.isFinite(d.profit) ? d.profit : 0;

		total++;
		if (profit > 0) { wins++; grossProfit += profit; }
		else if (profit < 0) { grossLoss += -profit; }
		else { breakEven++; }
		totalProfit += profit;
		durationSum += dealDurationMinutes(d.date_start, d.date_end);
		soSum += (typeof d.safety_orders === 'number' ? d.safety_orders : 0);
	}

	// Max drawdown of the realized equity curve: the largest peak-to-trough drop in cumulative profit,
	// with deals ordered by close date. This is the standard "how deep did realized P/L dip" figure.
	let maxDrawdown = 0;
	const ordered = deals
		.filter(d => Number.isFinite(d.profit))
		.slice()
		.sort((a, b) => new Date(a.date_end || a.date_start || 0).getTime() - new Date(b.date_end || b.date_start || 0).getTime());
	let cum = 0, peak = 0;
	for (const d of ordered) {
		cum += d.profit;
		if (cum > peak) { peak = cum; }
		const dd = peak - cum;
		if (dd > maxDrawdown) { maxDrawdown = dd; }
	}

	const losses = total - wins - breakEven;   // strictly profit < 0; break-evens are their own bucket

	return {
		total: total,
		wins: wins,
		losses: losses,
		break_even: breakEven,
		total_profit: totalProfit,
		gross_profit: grossProfit,
		gross_loss: grossLoss,
		duration_sum_mins: durationSum,
		so_sum: soSum,
		// Rounded presentation values (same rounding both callers used before).
		win_rate: roundWinRate(wins, total),
		avg_duration_mins: total > 0 ? Math.round(durationSum / total) : 0,
		avg_safety_orders: total > 0 ? Number((soSum / total).toFixed(1)) : 0,
		// Derived analytics over the realized money profit per deal. profit_factor is null when there are
		// no losing deals (an all-wins set has no finite ratio) so callers can render it as "—".
		profit_factor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : null,
		expectancy: total > 0 ? Number((totalProfit / total).toFixed(2)) : 0,   // avg realized profit per deal
		avg_win: wins > 0 ? Number((grossProfit / wins).toFixed(2)) : 0,
		avg_loss: losses > 0 ? Number((grossLoss / losses).toFixed(2)) : 0,
		max_drawdown: Number(maxDrawdown.toFixed(2))
	};
}


function freezeProperty(obj, keys) {

	const list = Array.isArray(keys) ? keys : [keys];

	for (const key of list) {

		const value = obj[key];

		Object.defineProperty(obj, key, {
			value,
			writable: false,
			configurable: false,
			enumerable: true
		});
	}

	return obj;
}


function convertBoolean(param, defaultVal) {

	let paramBool;

	// Handle a real boolean first so an explicit false is honored (a plain truthiness test would treat
	// false as unset and wrongly fall through to the default). A JSON/curl client can then post a real
	// boolean to turn an option off, not only the string 'false' the browser form sends.
	// NOTE: this function is embedded verbatim into a client script via a template literal in the EJS
	// views, so its source must never contain a backtick or a dollar-brace, in code OR comments.
	if (typeof param == 'boolean') {

		paramBool = param;
	}
	else if (typeof param == 'string' && param !== '') {

		paramBool = param.toLowerCase() === 'false' ? false : true;
	}
	else {

		// Unset ('' / null / undefined) or an unexpected non-string type — fall back to the default
		// (leaving paramBool undefined when no boolean default is given, preserving the original contract).
		if (typeof defaultVal == 'boolean') {

			paramBool = defaultVal;
		}
	}

	return paramBool;
}


function convertToCamelCase(obj) {

	return Object.fromEntries(
		Object.entries(obj).map(([key, value]) => [
			key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()),
			value
		])
	);
}


function convertStringToNumeric(obj) {

    if (typeof obj !== 'object' || obj === null) {

        return obj;
    }

    if (Array.isArray(obj)) {

        for (let i = 0; i < obj.length; i++) {

			obj[i] = convertStringToNumeric(obj[i]);
        }
    }
	else {

        for (const key in obj) {

			if (obj.hasOwnProperty(key)) {

				if (typeof obj[key] === 'string' && isNumeric(obj[key])) {

					obj[key] = parseFloat(obj[key]);

                } else if (typeof obj[key] === 'object') {

                    obj[key] = convertStringToNumeric(obj[key]);
                }
            }
        }
    }

    return obj;
}


function isNumeric(str) {

    return /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(str);
}


function hashCode(str) {

	let h = 0;

	for (let i = 0; i < str.length; i++) {

		h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
	}

	return Math.abs(h);
}


function numToBase26(num) {

	num = parseInt(num, 10);

	let str = num.toString(26).toUpperCase();

	return str;
}


function roundAmount(amount) {

	amount = Number(amount);

	if (Math.abs(amount) >= 0.01) {

		amount = Number(amount.toFixed(2));
	}
	else {

		amount = Number(amount.toFixed(8));
	}

	return amount;
}


// Read a stored provider secret (OpenAI / Ollama / 3CQS API key) for USE. These are encrypted at
// rest with System.encrypt (format "<32-hex IV>:<base64>"), but a value saved by an older version
// — or the plaintext key shipped for the built-in 3CQS client — must keep working unchanged. So:
// decrypt when the value is in the encrypted format, otherwise pass it through as legacy plaintext.
// Never throws. Async (decrypt is async). Single exit.
// The single source of truth for the "encrypted at rest" format produced by System.encrypt:
// a 32-hex IV, a colon, then the ciphertext. Everything that must tell an encrypted value from a
// legacy plaintext one (readSecret, encryptCredential, the boot migration, the password-change
// re-key, the Mailer, and connectExchange's guard) uses THIS, so the ciphertext format is defined
// in exactly one place.
function isEncrypted(value) {
	return typeof value === 'string' && /^[0-9a-f]{32}:/i.test(value);
}


async function readSecret(value) {

	let out = (typeof value === 'string') ? value : '';

	if (out && isEncrypted(out) && shareData && shareData.System && typeof shareData.System.decrypt === 'function') {

		try {
			const dec = await shareData.System.decrypt(out, shareData.appData.password);
			if (dec && dec.success && dec.data != null) { out = dec.data; }
		}
		catch (e) { /* not decryptable → treat as plaintext */ }
	}

	return out;
}

// Encrypt a provider secret for storage. Returns the encrypted string, or the original value if
// encryption is unavailable (so a save never silently drops the secret). Single exit.
async function encryptSecret(value) {

	let out = value;

	if (value && typeof value === 'string' && shareData && shareData.System && typeof shareData.System.encrypt === 'function') {

		try {
			const enc = await shareData.System.encrypt(value, shareData.appData.password);
			if (enc && enc.success && enc.data) { out = enc.data; }
		}
		catch (e) { /* keep original on failure */ }
	}

	return out;
}


// Apply a submitted write-only secret to a config slot, with the three cases every provider secret shares —
// consolidated here instead of copied per field (AI provider keys, 3CQS key, Telegram token):
//   • CLEAR flag set ('1')      → erase the stored secret (the user is removing it — e.g. switching Ollama
//                                 from the cloud service back to a local host that needs no key);
//   • a NEW value was typed      → encrypt it at rest and store it;
//   • BLANK with no clear flag    → leave the existing stored value untouched ("leave blank to keep").
// `container` is the object holding the secret (e.g. appConfig['ai']['ollama']); `key` the property name.
async function applySecretUpdate(container, key, submitted, clearFlag) {
	if (!container) { return; }
	if (clearFlag === '1' || clearFlag === 1 || clearFlag === true) { container[key] = ''; return; }
	if (submitted !== undefined && submitted !== '') { container[key] = await encryptSecret(submitted); }
	// else: blank and not cleared — keep whatever is already stored.
}


// Encrypt an EXCHANGE credential for storage, but only after proving it round-trips back to the
// exact plaintext under the current key. This is the money path: a stored credential that cannot be
// decrypted would be refused by connectExchange (halting trading), so we must never persist one.
//   - already encrypted-at-rest  → returned unchanged (never double-encrypt)
//   - encrypts + verifies         → returns the ciphertext
//   - anything less than a proven round-trip → returns the ORIGINAL plaintext (which still works,
//     since readSecret passes legacy plaintext through on load)
async function encryptCredential(value) {

	if (!value || typeof value !== 'string') { return value; }

	if (isEncrypted(value)) { return value; }

	try {

		const enc = await encryptSecret(value);

		if (enc && enc !== value && isEncrypted(enc)) {

			const back = await readSecret(enc);

			if (back === value) { return enc; }
		}
	}
	catch (e) { /* fall through to plaintext */ }

	return value;
}


// One-time-per-boot migration: encrypt any plaintext exchange credentials in this instance's
// bot-config file so they are no longer stored in the clear. There is no in-app UI to enter
// exchange keys (they are placed directly in the bot-config file), so this boot pass is the main
// point at which existing plaintext keys become encrypted at rest. Safe by construction:
//   - only NON-empty, NOT-already-encrypted values are touched (idempotent — re-running is a no-op)
//   - encryptCredential proves each value round-trips before returning ciphertext, otherwise it
//     returns the plaintext unchanged, so a credential can never be made unrecoverable
//   - the file is written only if something actually changed, and the whole thing is wrapped so a
//     failure can never stop startup or trading (the plaintext keeps working via readSecret)
async function migrateBotCredentials() {

	try {

		if (!shareData || !shareData.System || typeof shareData.System.encrypt !== 'function') { return; }

		const botConfigFile = shareData.appData && shareData.appData.bot_config;

		if (!botConfigFile) { return; }

		const botData = await getConfig(botConfigFile);
		const botCfg = botData && botData.data;

		if (!botCfg) { return; }

		let changed = 0;

		for (const field of ['apiKey', 'apiSecret', 'apiPassphrase', 'apiPassword']) {

			const val = botCfg[field];

			if (!val || typeof val !== 'string') { continue; }
			if (isEncrypted(val)) { continue; }   // already encrypted at rest

			const enc = await encryptCredential(val);

			if (enc !== val && isEncrypted(enc)) {

				botCfg[field] = enc;
				changed++;
			}
		}

		if (changed > 0) {

			const saveResult = await saveConfig(botConfigFile, botCfg);

			if (saveResult && saveResult.success) {

				logger('Encrypted ' + changed + ' plaintext exchange credential(s) at rest in ' + botConfigFile + '.');
			}
			else {

				logger('Could not save encrypted exchange credentials to ' + botConfigFile + ' (they remain readable and functional): ' + (saveResult && saveResult.data ? saveResult.data : 'unknown error'));
			}
		}
	}
	catch (e) {

		logger('Bot credential encryption migration skipped: ' + (e && e.message ? e.message : e));
	}
}


// Rollback safety: decrypt any at-rest config secret back to plaintext so a rolled-back OLDER version
// — which has no decryption of its own — can still read exchange/provider credentials. The CURRENT
// (encryption-aware) code runs this as the final step of a rollback, using the key it already holds
// (derived from the stored config password). Drift-proof and safe by construction: it walks each
// config object and rewrites a value ONLY when it both looks encrypted-at-rest AND decrypts cleanly,
// so a password hash — or any non-secret that merely resembles the ciphertext format — is left
// untouched (its decrypt fails and it is skipped). No field list to maintain, so a newly-added
// encrypted field is covered automatically. A later re-upgrade re-encrypts in place on boot
// (idempotent), so this round-trips. `files` defaults to this process's own configs (instance:
// app.json + bot.json; Hub: hub.json — each decrypts only what its own password can).
async function decryptConfigSecretsForRollback(files) {

	const result = { changed: 0, files: [] };

	if (!shareData || !shareData.System || typeof shareData.System.decrypt !== 'function') { return result; }

	const app = shareData.appData || {};
	const key = app.password;
	if (!key) { return result; }

	const targets = (Array.isArray(files) && files.length)
		? files
		: [ app.app_config, app.bot_config, 'hub.json' ].filter(Boolean);

	const walk = async (obj) => {
		let n = 0;
		if (!obj || typeof obj !== 'object') { return n; }
		for (const k of Object.keys(obj)) {
			const v = obj[k];
			if (typeof v === 'string') {
				if (isEncrypted(v)) {
					try {
						const dec = await shareData.System.decrypt(v, key);
						if (dec && dec.success && dec.data != null && dec.data !== v) { obj[k] = dec.data; n++; }
					}
					catch (e) { /* not our ciphertext under this key → leave as-is */ }
				}
			}
			else if (v && typeof v === 'object') {
				n += await walk(v);
			}
		}
		return n;
	};

	for (const file of targets) {
		try {
			const res = await getConfig(file);
			const cfg = res && res.data;
			if (!cfg || typeof cfg !== 'object') { continue; }

			const n = await walk(cfg);

			if (n > 0) {
				await saveConfig(file, cfg);
				result.changed += n;
				result.files.push(file);
				logger('Rollback: decrypted ' + n + ' at-rest secret(s) in ' + file + ' so an older version can read them.');
			}
		}
		catch (e) {
			logger('Rollback: could not process secrets in ' + file + ': ' + (e && e.message ? e.message : e));
		}
	}

	return result;
}


// Quote currencies that use 2-decimal ("cents") accounting: the US dollar, USD-pegged
// stablecoins, and major fiat. For a pair quoted in one of these, a deal's cost basis is rounded
// to 2 decimals exactly as it always has been, so existing USD/USDT deals stay byte-identical.
const TWO_DECIMAL_QUOTES = new Set([
	'USD', 'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP', 'FDUSD', 'PYUSD', 'GUSD', 'USDD', 'FRAX',
	'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'JPY', 'NZD', 'SGD', 'HKD', 'ZAR', 'BRL', 'TRY', 'MXN', 'PLN'
]);

// Round a deal COST BASIS — an amount denominated in the pair's QUOTE currency (order sum,
// running deal sum, adjusted order amount). This is the single, consolidated source for the
// rounding that used to be hardcoded as `Math.round(x * 100) / 100` in three places in the DCA
// engine.
//
// Why it exists: two decimals is correct only for a USD/stablecoin/fiat quote. For a pair quoted
// in a CRYPTO (e.g. BTC in ETH/BTC, where the cost needs up to 8 decimals) that same rounding
// truncated 0.0523 BTC to 0.05, and because the cost basis feeds average -> take-profit target ->
// reported profit, the deal's numbers were skewed on such pairs. Orders actually placed were never
// affected (those use exchange precision via filterPrice/filterAmount) — only the internal
// accounting.
//
// Behavior, deliberately conservative so nothing changes for the current fleet:
//   * unknown/unparseable pair, or a USD-stable/fiat quote -> 2 decimals via the EXACT prior
//     expression (Math.round(value * 100) / 100), i.e. byte-identical to before.
//   * any other (crypto) quote -> preserved to 8 decimals, normalizing float artifacts.
// The value passed in has already been through filterPrice (exchange precision) at every call
// site, so the 8-decimal branch normalizes rather than invents precision.
function roundCost(value, pair) {

	value = Number(value);

	if (!isFinite(value)) {

		return 0;
	}

	// Resolve the quote via the ONE canonical helper so the underscore pair form ("ETH_BTC") is recognized
	// as well as the slash form — otherwise a "_"-form crypto-quote pair would fall through to the 2-decimal
	// branch and truncate the cost basis. An unparseable pair yields 'UNKNOWN', which keeps the previous
	// 2-decimal default via the guard below. For a normal "BASE/QUOTE" pair this is identical to before.
	const q = quoteCurrency(pair);
	const quote = (q && q !== 'UNKNOWN') ? q.trim() : null;

	// Unknown/2-decimal quote → identical to the previous hardcoded rounding.
	if (!quote || TWO_DECIMAL_QUOTES.has(quote)) {

		return Math.round(value * 100) / 100;
	}

	// Crypto quote → keep finer precision (up to 8 decimals) instead of truncating to cents.
	return Number(value.toFixed(8));
}


// CCXT occasionally renames an exchange (e.g. coinbasepro -> coinbaseexchange). Single source of the
// rename so the trading side and the public market-data service resolve a configured exchange name
// identically and can never drift apart. Pure and synchronous — safe to call from any context.
function exchangeAlias(name) {

	if (typeof name === 'string' && name.toLowerCase() === 'coinbasepro') {

		return 'coinbaseexchange';
	}

	return name;
}


// Coerce a value to a finite number, or null. Empty string / null / undefined and any non-finite
// result (NaN, Infinity) all become null, so callers can treat "no usable number" uniformly rather
// than guarding each parse. Used by the pure DCA strategy helpers (signalBot / priceGuard / stopLoss).
function toNum(value) {

	if (value === undefined || value === null || value === '') { return null; }

	const n = Number(value);

	return Number.isFinite(n) ? n : null;
}


// Count the number of decimal places in a number, ROBUST to JavaScript's exponential string form.
// `(0.0000002).toString()` is "2e-7" (no "."), so the naive `String(n).split('.')[1].length` throws
// on any magnitude below ~1e-6 — a real hazard for high-precision coins whose minimum movement is
// sub-1e-6. This derives the count from both the mantissa fraction and the exponent, and matches the
// naive result exactly for ordinary (non-exponential) decimals. 0 for integers / 0 / non-finite input.
function countDecimals(value) {

	const n = Number(value);
	let places = 0;

	if (Number.isFinite(n) && n !== 0) {

		const s = Math.abs(n).toString();
		const eIdx = s.indexOf('e');

		if (eIdx !== -1) {

			// Exponential form, e.g. "2e-7" or "1.5e-8".
			const mantissa = s.slice(0, eIdx);
			const exp = parseInt(s.slice(eIdx + 1), 10) || 0;
			const dot = mantissa.indexOf('.');
			const mantissaFrac = (dot === -1) ? 0 : (mantissa.length - dot - 1);

			places = Math.max(0, mantissaFrac - exp);   // exp is negative for small numbers, so −exp adds places
		}
		else {

			const dot = s.indexOf('.');
			places = (dot === -1) ? 0 : (s.length - dot - 1);
		}
	}

	return places;
}


function adjustDecimals(value, ...arr) {

	const numValue = Number(value);

	if (isNaN(numValue)) {
		return 0;
	}

	const flattenedArr = arr.flat();

	const decimalPlaces = flattenedArr
		.map(v => (isNaN(Number(v)) ? 0 : (String(v).split('.').length > 1 ? String(v).split('.')[1].length : 0)))
		.filter(v => v > 0);

	const maxDecimals = decimalPlaces.length > 0 ? Math.max(...decimalPlaces) : 0;

	return numValue.toFixed(maxDecimals);
}


function getPrecision(arr) {

	return 10 ** -Math.max(...arr.map(n => (n.toString().split('.')[1] || '').length));
}


function uuidv4() {

	if (crypto.randomUUID) return crypto.randomUUID();

	const bytes = crypto.randomBytes(16);

	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;

	const hex = bytes.toString('hex');

	return (
		hex.substr(0, 8) + '-' +
		hex.substr(8, 4) + '-' +
		hex.substr(12, 4) + '-' +
		hex.substr(16, 4) + '-' +
		hex.substr(20, 12)
	);
}


function numFormatter(num) {

	num = Number(num);

	// Ordered >= thresholds with a plain-number fallback, so EVERY finite input maps to a string. The
	// previous chain (num > 999 … num < 900) left a gap at 900–999 and missed the exact 10^n boundaries
	// (1000000, 1000000000, …), returning undefined — which rendered blank in the file-size / memory
	// displays that call this.
	if (num >= 1000000000000) { return (num / 1000000000000).toFixed(2) + 'T'; }
	if (num >= 1000000000)    { return (num / 1000000000).toFixed(2) + 'B'; }
	if (num >= 1000000)       { return (num / 1000000).toFixed(2) + 'M'; }
	if (num >= 1000)          { return (num / 1000).toFixed(2) + 'k'; }

	return num;
}


function sortByKey(array, key) {

	return array.sort(function(a, b) {
		let x = a[key];
		var y = b[key];
		return x < y ? -1 : x > y ? 1 : 0;
	});
}


function deepCopy(obj, seen = new WeakMap()) {

	if (obj === null || typeof obj !== 'object') return obj;
	if (seen.has(obj)) return seen.get(obj);

	if (obj instanceof Date) return new Date(obj);
	if (obj instanceof RegExp) return new RegExp(obj);
	if (obj instanceof Map) return new Map([...obj].map(([k, v]) => [deepCopy(k, seen), deepCopy(v, seen)]));
	if (obj instanceof Set) return new Set([...obj].map(v => deepCopy(v, seen)));

	// Preserve prototype chain
	const copy = Array.isArray(obj) ? [] : Object.create(Object.getPrototypeOf(obj));
	seen.set(obj, copy);

	// Get all own property keys (string and symbol), including non-enumerable
	const keys = [
		...Object.getOwnPropertyNames(obj),
		...Object.getOwnPropertySymbols(obj)
	];

	for (const key of keys) {

		const desc = Object.getOwnPropertyDescriptor(obj, key);

		if (desc.get || desc.set) {

			// If there are getters/setters, just copy them directly (not invoking)
			Object.defineProperty(copy, key, desc);
		}
		else {

			// Otherwise, copy the value deeply
			desc.value = deepCopy(desc.value, seen);
			Object.defineProperty(copy, key, desc);
		}
	}

	return copy;
}


async function genApiKey(key) {

	const data = await genPasswordHash({'data': key });

	const apiKeyHashed = data['salt'] + ':' + data['hash'];

	return apiKeyHashed;
}


// The default API key generated on a fresh install when none is configured. The value is
// arbitrary — SymBot hashes it (genApiKey), so any string authenticates — so it carries a
// recognizable `symb_auto_` prefix instead of an opaque UUID. That prefix lets the log
// redactor mask the key if it ever reaches a log line, which a bare UUID could not (a UUID is
// indistinguishable from the deal/bot/instance ids that legitimately fill the logs). It is
// deliberately NOT a scoped-key head (`symb_live_` / `symb_test_`), so AuthMiddleware resolves
// it through the legacy api-key path, not the scoped-key store.
function genDefaultApiKey() {

	return 'symb_auto_' + crypto.randomBytes(32).toString('hex');
}


// Constant-time string comparison — the ONE canonical timing-safe compare for raw secrets/
// tokens (webhook api_token, etc.). Hashing both sides to a fixed-length sha256 digest first
// makes the comparison length-independent, so it never leaks length via an early mismatch and
// never throws on differing lengths. Use this instead of re-implementing timingSafeEqual at a
// call site. (Note: ApiKeys.secretMatchesHash and HubStore.verifyPassword are intentionally
// separate — they hash/derive an input first and HubStore is deliberately Common-independent.)
function safeEqual(a, b) {

	const ha = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
	const hb = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();

	return crypto.timingSafeEqual(ha, hb);
}


async function genToken() {

	const salt = shareData.appData.server_id;
	const data = shareData.appData.api_key.split(':');

	const hash = data[1];

	const token = await genPasswordHash({'data': hash, 'salt': salt });

	return token;
}


async function setToken() {

	const token = await genToken();
	shareData.appData['api_token'] = token['hash'];
}


// PBKDF2 work factors. High-entropy secrets (random API keys, the derived webhook token) are hashed at
// the LEGACY factor: they cannot be brute-forced regardless, and they are verified on the hot webhook /
// API path, so a slow KDF there would add latency to every trading signal. A low-entropy human PASSWORD
// is hashed at the much higher PASSWORD factor (OWASP's PBKDF2-HMAC-SHA256 guidance), because it is only
// verified at login (rare) and a stolen hash must resist offline brute force.
const LEGACY_PBKDF2_ITERATIONS   = 1000;
const PASSWORD_PBKDF2_ITERATIONS = 600000;

async function genPasswordHash(dataObj) {

	let salt = dataObj['salt'];
	let data = dataObj['data'];

	if (salt == undefined || salt == null || salt == '') {

		salt = crypto.randomBytes(16).toString('hex');
	}

	// Default keeps the API-key / webhook-token derivation unchanged (fast, high-entropy input); a
	// password-set call passes PASSWORD_PBKDF2_ITERATIONS to store a strong hash.
	const iterations = (dataObj['iterations'] != undefined && Number(dataObj['iterations']) > 0) ? Number(dataObj['iterations']) : LEGACY_PBKDF2_ITERATIONS;

	const hash = crypto.pbkdf2Sync(data, salt, iterations, 64, 'sha256').toString('hex');

	let obj = { 'salt': salt, 'hash': hash };

	return obj;
}


async function verifyPasswordHash(dataObj) {

	let success = false;

	let salt = dataObj['salt'];
	let hash = dataObj['hash'];
	let data = dataObj['data'];

	// Only passwords are verified through this function, so try the strong PASSWORD factor first and fall
	// back to the LEGACY factor. That keeps every password hashed before this change verifying unchanged
	// (they are upgraded to the strong factor the next time the password is set), with no stored format to
	// migrate. Constant-time compare (defense in depth) rather than `===`.
	for (const iterations of [ PASSWORD_PBKDF2_ITERATIONS, LEGACY_PBKDF2_ITERATIONS ]) {

		let hashData;

		try { hashData = crypto.pbkdf2Sync(data, salt, iterations, 64, 'sha256').toString('hex'); }
		catch (e) { continue; }

		if (safeEqual(hash, hashData)) { success = true; break; }
	}

	return success;
}


// ---------------------------------------------------------------------------
// Failed-login lockout / throttle (backlog #71)
//
// In-memory only, keyed by source IP. Counts consecutive failed logins in a
// rolling window and temporarily blocks an IP once it crosses a threshold, so a
// brute-force attempt is slowed to uselessness rather than merely notified.
//
// In-memory is deliberate: the state only needs to outlive an attack window,
// not a restart, and this keeps it dependency-free with no schema change. A
// process restart clears all counters (and any active block), which is an
// acceptable trade for simplicity — an attacker cannot force a restart, and a
// legitimate operator restarting simply gets a clean slate.
//
// Successful login clears the IP's record. Blocks fail closed: while an IP is
// blocked, the password is not even checked.
// ---------------------------------------------------------------------------

const loginThrottleDefaults = {
	// Consecutive failures from one IP before it is blocked.
	'maxFailures': 5,
	// Rolling window (ms) in which failures accumulate. Failures older than this
	// are forgiven, so occasional typos by a legitimate user never build up.
	'windowMs': 15 * 60 * 1000,
	// How long an IP stays blocked once the threshold is crossed (ms).
	'blockMs': 15 * 60 * 1000,
	// Cap on tracked IPs, so the map cannot grow unbounded under a distributed
	// attack. Oldest entries are evicted first.
	'maxTrackedIps': 5000
};

// ip -> { failures: [timestamps], blockedUntil: ms|null }
const loginAttempts = new Map();

function getLoginThrottleConfig() {

	// Allow overrides from appData.security.login_throttle if present, else defaults.
	const cfg = shareData?.appData?.security?.login_throttle;

	if (cfg == undefined || cfg == null) {

		return loginThrottleDefaults;
	}

	return {
		'maxFailures':   Number(cfg.max_failures)    > 0 ? Number(cfg.max_failures)    : loginThrottleDefaults['maxFailures'],
		'windowMs':      Number(cfg.window_ms)        > 0 ? Number(cfg.window_ms)       : loginThrottleDefaults['windowMs'],
		'blockMs':       Number(cfg.block_ms)         > 0 ? Number(cfg.block_ms)        : loginThrottleDefaults['blockMs'],
		'maxTrackedIps': Number(cfg.max_tracked_ips)  > 0 ? Number(cfg.max_tracked_ips) : loginThrottleDefaults['maxTrackedIps']
	};
}

// Returns { blocked: bool, retryAfterSec: number } without mutating counters.
function checkLoginBlocked(ip) {

	if (ip == undefined || ip == null || ip === '') {

		// No usable IP — cannot throttle safely, so do not block (fail open on
		// identification, never on the password check itself).
		return { 'blocked': false, 'retryAfterSec': 0 };
	}

	const record = loginAttempts.get(ip);

	if (record == undefined || record.blockedUntil == null) {

		return { 'blocked': false, 'retryAfterSec': 0 };
	}

	const now = Date.now();

	if (record.blockedUntil > now) {

		return { 'blocked': true, 'retryAfterSec': Math.ceil((record.blockedUntil - now) / 1000) };
	}

	// Block has expired — clear it and let the attempt proceed with a clean slate.
	loginAttempts.delete(ip);

	return { 'blocked': false, 'retryAfterSec': 0 };
}

// Records a failed attempt; blocks the IP if it crosses the threshold.
// Returns { blocked: bool, retryAfterSec: number, failures: number }.
function recordLoginFailure(ip) {

	if (ip == undefined || ip == null || ip === '') {

		return { 'blocked': false, 'retryAfterSec': 0, 'failures': 0 };
	}

	const config = getLoginThrottleConfig();
	const now = Date.now();

	// Evict oldest entry if the map is at capacity and this IP is new.
	if (!loginAttempts.has(ip) && loginAttempts.size >= config['maxTrackedIps']) {

		const oldestKey = loginAttempts.keys().next().value;

		if (oldestKey != undefined) {

			loginAttempts.delete(oldestKey);
		}
	}

	let record = loginAttempts.get(ip);

	if (record == undefined) {

		record = { 'failures': [], 'blockedUntil': null };
	}

	// Drop failures outside the rolling window, then add this one.
	record.failures = record.failures.filter(ts => (now - ts) < config['windowMs']);
	record.failures.push(now);

	let blocked = false;
	let retryAfterSec = 0;

	if (record.failures.length >= config['maxFailures']) {

		record.blockedUntil = now + config['blockMs'];
		blocked = true;
		retryAfterSec = Math.ceil(config['blockMs'] / 1000);
	}

	loginAttempts.set(ip, record);

	return { 'blocked': blocked, 'retryAfterSec': retryAfterSec, 'failures': record.failures.length };
}

// Clears an IP's record on successful login.
function recordLoginSuccess(ip) {

	if (ip != undefined && ip != null && ip !== '') {

		loginAttempts.delete(ip);
	}
}


async function verifyLogin(req, res, isHub) {

	let msg;

	const body = req.body;
	const password = body.password;
	const userAgent = req.headers['user-agent'];

	const ip = getClientIp(req);

	// Before checking the password, reject outright if this IP is currently
	// blocked from too many recent failures. The password is not evaluated.
	const blockStatus = checkLoginBlocked(ip);

	if (blockStatus['blocked']) {

		const blockMsg = 'Login BLOCKED (too many attempts) from: ' + ip + ' / Browser: ' + userAgent + ' / Retry after: ' + blockStatus['retryAfterSec'] + 's';

		if (!isHub) {

			logger(blockMsg);
			sendNotification({ 'message': blockMsg, 'telegram_id': shareData.appData.telegram_id });
		}

		auditEvent('anonymous', 'auth.login_blocked', ip, 'too many attempts; retry ' + blockStatus['retryAfterSec'] + 's', ip);

		res.set('Retry-After', String(blockStatus['retryAfterSec']));
		res.status(429).send('Too many login attempts. Try again in ' + blockStatus['retryAfterSec'] + ' seconds.');

		return;
	}

	// Optional per-login IP allow/deny. Opt-in (default off). Loopback is ALWAYS exempt so local /
	// console access can never be locked out, and the console `reset ipfilter` command clears it.
	// The check fails OPEN on any internal error — a bug in the filter must never lock a user out.
	try {

		const loginIpCfg = shareData.appData && shareData.appData.ip_filter && shareData.appData.ip_filter.login;

		if (loginIpCfg && loginIpCfg.enabled) {

			const decision = IpFilter.evaluate(ip, { allow: loginIpCfg.allowlist || [], deny: loginIpCfg.blocklist || [] }, { allowLoopback: true });

			if (!decision.allowed) {

				const denyMsg = 'Login DENIED by IP filter from: ' + ip + ' (' + decision.reason + ') / Browser: ' + userAgent;

				if (!isHub) { logger(denyMsg); sendNotification({ 'message': denyMsg, 'telegram_id': shareData.appData.telegram_id }); }

				auditEvent('anonymous', 'auth.login_denied_ip', ip, 'ip filter: ' + decision.reason, ip);

				res.status(403).send('Access from your IP address is not permitted.');

				return;
			}
		}
	}
	catch (e) { /* fail open — never lock out on a filter error */ }

	const username = (body.username || '').toString().trim();

	let success = false;
	let userId = null;

	if (username !== '') {

		// Named user → authenticate against the user store (Mongo on an instance, SQLite on the
		// Hub). A valid user's role capabilities are carried via req.session.userId, which
		// resolvePrincipal turns into the correct scoped principal on each request.
		let user = null;

		try {

			if (isHub) {

				if (shareData.HubStore && typeof shareData.HubStore.authenticate === 'function') {

					user = shareData.HubStore.authenticate(username, password);
				}
			}
			else if (shareData.Users && typeof shareData.Users.authenticate === 'function') {

				user = await shareData.Users.authenticate(username, password);
			}
		}
		catch (e) { user = null; }

		if (user) {

			success = true;
			userId = user.user_id;
		}
	}
	else {

		// No username → the owner login via the config-file password. Always available for
		// backward compatibility and as the recovery path if the user store is unavailable.
		const dataPass = shareData.appData.password.split(':');

		success = await verifyPasswordHash( { 'salt': dataPass[0], 'hash': dataPass[1], 'data': password } );
	}

	let justBlocked = false;
	let retryAfterSec = 0;

	if (success) {

		// Regenerate the session id at the privilege boundary (anonymous → authenticated) to defeat session
		// fixation: an id planted or fixated on the victim before login must not carry into the authenticated
		// session. Best-effort — if regenerate is unavailable or errors, fall back to the existing session so
		// login can never break. Web layer only; never touches trading.
		await new Promise((resolve) => {

			if (req && req.session && typeof req.session.regenerate === 'function') {

				req.session.regenerate(() => resolve());
			}
			else { resolve(); }
		});

		req.session.loggedIn = true;

		// A named user carries their userId so the request resolves to their role's capabilities;
		// the owner (blank username) has no userId and resolves to the implicit owner.
		if (userId) { req.session.userId = userId; }
		else { delete req.session.userId; }

		// Clear this IP's failure record on any successful login.
		recordLoginSuccess(ip);

		msg = 'SUCCESS';
	}
	else {

		// Record the failure; may push this IP over the threshold into a block.
		const failResult = recordLoginFailure(ip);

		justBlocked = failResult['blocked'];
		retryAfterSec = failResult['retryAfterSec'];

		msg = 'FAILED' + (justBlocked ? ' (now blocked for ' + retryAfterSec + 's)' : '');
	}

	// Record the authentication event in the audit trail (who / what / when / from where), so
	// logins and failed attempts are queryable under Access Control → Audit Log alongside the
	// key/user/config changes — not only in the verbose general log. Best-effort; never blocks login.
	if (success) {
		auditEvent(userId ? ('user:' + userId) : 'user:owner', 'auth.login', ip, userId ? ('user ' + username) : 'owner', ip);
	}
	else {
		auditEvent('anonymous', 'auth.login_failed', ip, 'attempted ' + (username ? ('user ' + username) : 'owner') + (justBlocked ? ' — now blocked ' + retryAfterSec + 's' : ''), ip);
	}

	msg = 'Login ' + msg + ' from: ' + ip + ' / Browser: ' + userAgent;

	if (!isHub) {

		logger(msg);
		sendNotification({ 'message': msg, 'telegram_id': shareData.appData.telegram_id });
	}

	if (success) {

		if (isHub) {

			renderView('Hub/homeView', req, res, isHub);
		}
		else {

			// Redirect to config view if in config mode
			if (shareData.appData.config_mode) {

				res.redirect('/config');
			}
			else {

				renderView('homeView', req, res);
			}
		}
	}
	else {

		// If this failure triggered a block, tell the client with a 429 so the
		// lockout is visible rather than looking like an ordinary bad password.
		if (justBlocked) {

			res.set('Retry-After', String(retryAfterSec));
			res.status(429).send('Too many login attempts. Try again in ' + retryAfterSec + ' seconds.');
		}
		else {

			res.redirect('/login');
		}
	}
}


function validateApiKey(key) {

	let data;
	let hashData;
	let success = false;

	try {
		data = shareData.appData.api_key.split(':');
	}
	catch(e) {

		return success;
	}

	const salt = data[0];
	const hash = data[1];

	try {

		hashData = crypto.pbkdf2Sync(key, salt, 1000, 64, 'sha256').toString('hex');
	}
	catch(e) {}

	// Constant-time compare (defense in depth; matches the webhook-token path) rather than `===`.
	if (safeEqual(hash, hashData)) {

		success = true;
	}

	return success;
}


function getClientIp(ctx) {

	const headers = ctx?.handshake?.headers || ctx?.headers || {};

	const socket =
		ctx?.request?.socket ||
		ctx?.socket ||
		ctx?.connection;

	// By default SymBot trusts the proxy forwarding headers (cf-connecting-ip / x-forwarded-for)
	// so it sees the real client IP behind NGINX / Apache / Cloudflare — the standard deployment.
	// A deployment that is reachable DIRECTLY (no trusted proxy) can set
	// `security.trust_proxy: false` in app.json so these client-supplied headers are ignored and
	// the real socket address is used instead — otherwise an attacker could spoof x-forwarded-for
	// to dodge the per-IP login throttle. Default (unset) preserves today's behavior.
	const trustProxy = !(shareData && shareData.appData && shareData.appData.security && shareData.appData.security.trust_proxy === false);

	const rawIp = (
			(trustProxy ? (headers['cf-connecting-ip'] || headers['x-forwarded-for']) : '') ||
			socket?.remoteAddress ||
			ctx?.handshake?.address ||
			ctx?.ip ||                       // Express req.ip (last resort — socket address is preferred for the anti-spoof reason above)
			''
		)
		.split(',')[0]
		.trim();

	// Normalize the IPv4-mapped IPv6 form (::ffff:127.0.0.1 → 127.0.0.1) and the bare IPv6 loopback
	// (::1 → 127.0.0.1), so localhost is reported consistently as 127.0.0.1 everywhere — the IP
	// filters, the audit log, and the login notifications. This is the ONE canonical IP resolver —
	// AuthMiddleware.clientIp and Audit.resolveIp delegate here so every enforcement point and the
	// audit log agree on the same, already-normalized address.
	let ip = rawIp.startsWith('::ffff:') ? rawIp.substring(7) : rawIp;
	if (ip === '::1') { ip = '127.0.0.1'; }
	return ip;
}


async function sendSocketMsg(data) {

	const roomAuth = 'logs';

	let room = data['room'];
	let msg = data['message'];
	let msgType = data['type'];

	const socket = await shareData.WebServer.getSocket();

	let sendRoom = roomAuth;

	if (room != undefined && room != null && room != '') {

		sendRoom = room;
	}

	if (msgType == undefined || msgType == null || msgType == '') {

		msgType = sendRoom;
	}

	if (socket) {

		socket.to(sendRoom).emit('data', { 'type': msgType, 'message': msg });
	}
}


async function sendParentMsg(data) {

	const parentPort = shareData.appData.parent_port;

	let msg = data['data'];
	let msgType = data['type'];

	let success = false;

	if (parentPort) {

		success = true;

		parentPort.postMessage({

			'type': msgType,
			'data': msg
		});
	}

	return { 'success': success };
}


async function renderView(view, req, res, isHub) {

	res.render( view, { 'isHub': isHub, 'appData': shareData.appData, 'getCurrencySymbol': getCurrencySymbol.toString() } );
}


const stripNonNumeric = (inputString) => inputString.replace(/[^0-9.]/g, '');


async function validateAppVersion() {

	const owner = '3cqs-coder';
	const repo = 'SymBot';
	const url = `https://api.github.com/repos/${owner}/${repo}/tags`;

	let remoteVersion = '0.0.0';
	let localVersion = '0.0.0';
	let success = true;
	let error = null;
	let update_available = false;

	// Bound the network call so a slow or unreachable update source can never hang startup — without
	// a timeout, fetch can wait far longer than any boot should. On abort/failure the catch below
	// leaves this as a best-effort no-op (success=false) and startup continues normally.
	const VERSION_FETCH_TIMEOUT_MS = 4000;
	const controller = new AbortController();
	const timer = setTimeout(() => { try { controller.abort(); } catch (e) {} }, VERSION_FETCH_TIMEOUT_MS);

	try {

		const response = await fetch(url, { signal: controller.signal });

		if (!response.ok) {

			success = false;
			error = `Failed to fetch tags: ${response.statusText}`;
		}
		else {

			const tags = await response.json();

			if (tags.length === 0) {

				success = false;
				error = 'No tags found for this repository.';
			}
			else {

				const latestTag = tags[0].name;

				localVersion = stripNonNumeric(packageJson.version);
				remoteVersion = stripNonNumeric(latestTag);

				// Compare version segments NUMERICALLY. A string comparison would order "9" after "10"
				// (character '9' > '1'), so it would miss updates like 1.9 -> 1.10. Missing segments count
				// as 0, so 1.9 and 1.9.0 compare equal.
				const parseVersion = (version) => version.split(/[\.-]/).map((n) => parseInt(n, 10) || 0);

				const localParts = parseVersion(localVersion);
				const remoteParts = parseVersion(remoteVersion);

				for (let i = 0; i < Math.max(localParts.length, remoteParts.length); i++) {

					const localSegment = i < localParts.length ? localParts[i] : 0;
					const remoteSegment = i < remoteParts.length ? remoteParts[i] : 0;

					if (remoteSegment > localSegment) {

						update_available = true;
						break;
					}

					if (remoteSegment < localSegment) {

						update_available = false;
						break;
					}
				}

				if (!update_available) {

					success = false;
					error = 'You already have the latest version';
				}
			}
		}
	}
	catch (err) {

		success = false;
		error = 'Failed to retrieve remote application version';
	}
	finally { clearTimeout(timer); }

	if (update_available) {

		logger('WARNING: Your app version is outdated. Please update to the latest version.', true);
		logger(`Current version: ${localVersion} Latest version: ${remoteVersion}`, true);
		require('./Diagnostics.js').annotate('version.outdated').forEach(line => logger(line, true));
	}
	else if (localVersion !== remoteVersion) {

		// Benign and expected for a pre-release or locally built copy that is ahead of the public
		// release — there is nothing to act on, so keep it to a single quiet line rather than a
		// multi-line explanation on every startup. (The full explanation still lives in Diagnostics
		// under version.newer_than_remote, served by the diagnostics API.)
		logger(`NOTICE: This build (v${localVersion}) is newer than the latest published version (v${remoteVersion}) — expected for a pre-release; nothing to do.`, true);
	}

	return {
		owner,
		repo,
		remote: remoteVersion,
		local: localVersion,
		success,
		error,
		update_available
	};
}



async function getBotConfig(req, res) {

	let success = false;
	let data;

	const botConfigFile = shareData.appData.bot_config;
	const botConfig = await getConfig(botConfigFile);

	if (!botConfig.success) {

		data = 'Unable to read bot configuration file: ' + botConfigFile;
	}
	else {

		const cfg = botConfig.data;

		// Translate stored exchange name through the canonical alias map in DCABot
		// so the UI always sees the current name (e.g. coinbasepro -> coinbaseexchange).
		// Never send actual credential values to the browser — send boolean flags instead.
		const exchangeCanonical = await shareData.DCABot.getExchangeAlias(cfg.exchange || '');

		data = {
			exchange:      exchangeCanonical,
			apiKey:        !!cfg.apiKey,
			apiSecret:     !!cfg.apiSecret,
			apiPassphrase: !!cfg.apiPassphrase,
			apiPassword:   !!cfg.apiPassword,
			sandBox:       cfg.sandBox === true,
			sandBoxWallet: cfg.sandBoxWallet || 0,
			exchangeFee:   cfg.exchangeFee   || 0,
		};

		success = true;
	}

	res.send({ success, data });
}


async function updateBotConfig(req, res) {

	let success = false;
	let dataMessage;

	const body = req.body;
	const password = body.password;

	const dataPass = shareData.appData.password.split(':');
	const passwordOk = await verifyPasswordHash({ salt: dataPass[0], hash: dataPass[1], data: password });

	if (!passwordOk) {

		dataMessage = 'Password incorrect';
	}
	else {

		const botConfigFile = shareData.appData.bot_config;
		const botConfig = await getConfig(botConfigFile);

		if (!botConfig.success) {

			dataMessage = 'Unable to read bot configuration file: ' + botConfigFile;
		}
		else {

			const cfg = botConfig.data;

			// Exchange name
			if (body.exchange && body.exchange.trim() !== '') {

				cfg.exchange = body.exchange.trim().toLowerCase();
			}

			// Credentials — three possible states per field:
			//   clear flag = '1' → explicitly erase the stored value
			//   new value entered → update with the new value
			//   blank with no clear flag → leave existing value untouched
			const credFields = ['apiKey', 'apiSecret', 'apiPassphrase', 'apiPassword'];

			for (const field of credFields) {

				if (body[field + '_clear'] === '1') {

					cfg[field] = '';
				}
				else if (body[field] && body[field].trim() !== '') {

					// Encrypt the newly-entered credential at rest (verified round-trip; falls back to
					// plaintext only if encryption can't be proven to decrypt). Existing untouched
					// values are left exactly as stored, so nothing is ever double-encrypted.
					cfg[field] = await encryptCredential(body[field].trim());
				}
			}

			const sandBoxWallet = parseFloat(body.sandBoxWallet);
			if (!isNaN(sandBoxWallet) && sandBoxWallet >= 0) {

				cfg.sandBoxWallet = sandBoxWallet;

				// Keep Hub per-instance override in sync if it exists
				if (shareData.appData.sandbox_wallet_override !== undefined) {

					shareData.appData.sandbox_wallet_override = sandBoxWallet;
				}
			}

			const exchangeFee = parseFloat(body.exchangeFee);
			if (!isNaN(exchangeFee) && exchangeFee >= 0) cfg.exchangeFee = exchangeFee;

			// Persist ONLY the connectivity-independent fields now (they must not be blocked by the
			// exchange-validation timeout below). The exchange name + credentials staged into `cfg` above
			// are deliberately NOT written here: a failed validation must never leave unverified or
			// incorrect exchange credentials on disk that a later connectExchange would try (and fail) to
			// trade with. Re-read the on-disk config — still holding the original exchange and credentials,
			// since nothing has been written yet — and apply only wallet/fee, so this intermediate write
			// cannot carry the un-validated exchange/credential change. The full `cfg` (with the new
			// credentials) is written only after validation succeeds, below.
			const preValidate = await getConfig(botConfigFile);

			if (preValidate.success && preValidate.data) {

				const pv = preValidate.data;

				if (!isNaN(sandBoxWallet) && sandBoxWallet >= 0) { pv.sandBoxWallet = sandBoxWallet; }
				if (!isNaN(exchangeFee) && exchangeFee >= 0) { pv.exchangeFee = exchangeFee; }

				await saveConfig(botConfigFile, pv);
			}

			const buySlippage  = parseFloat(body.exchange_buy_slippage);
			const sellSlippage = parseFloat(body.exchange_sell_slippage);
			let balanceCurrencies = body.exchange_balance_currencies;
			if (!Array.isArray(balanceCurrencies)) {
				balanceCurrencies = balanceCurrencies ? [balanceCurrencies] : [];
			}
			balanceCurrencies = balanceCurrencies.map(s => s.trim().toUpperCase()).filter(s => s.length > 0);

			// sandBox toggle is handled separately via /api/bot-config/sandbox
			// to enforce the confirmation step — do not allow it via this route.

			// Validate the exchange name and credentials.
			// If credentials are present, attempt fetchBalance to confirm they are accepted.
			// If no credentials are set, just verify the exchange name is recognized.
			try {

				const testCfg = {
					exchange:      cfg.exchange,
					apiKey:        cfg.apiKey        || '',
					apiSecret:     cfg.apiSecret     || '',
					apiPassphrase: cfg.apiPassphrase || '',
					apiPassword:   cfg.apiPassword   || '',
				};

				const exchange = await shareData.DCABot.connectExchange(testCfg);

				if (!exchange) {

					dataMessage = 'Could not connect to exchange. Please verify the exchange name.';
				}
				else {

					const hasCredentials = cfg.apiKey || cfg.apiSecret;

					if (hasCredentials) {

						// Credentials provided — validate them with a balance fetch
						await exchange.fetchBalance();
					}

					// Flush the exchange connection cache so the new credentials take effect
					if (shareData.appData.exchanges) shareData.appData.exchanges = {};

					const saveResult = await saveConfig(botConfigFile, cfg);

					if (!saveResult.success) {

						dataMessage = 'Failed to save bot configuration: ' + saveResult.data;
					}
					else {

						dataMessage = 'Exchange configuration updated successfully';
						success = true;

						// Save order settings (slippage, balance currencies) to app.json
						const appConfigFile = shareData.appData.app_config;
						const appCfgResult = await getConfig(appConfigFile);
						if (appCfgResult.success) {
							const appCfg = appCfgResult.data;
							const excDef = appCfg?.bots?.exchange?.default;
							if (excDef) {
								if (!isNaN(buySlippage)  && buySlippage  >= 0) excDef.orders.buy.slippage_percent  = buySlippage;
								if (!isNaN(sellSlippage) && sellSlippage >= 0) excDef.orders.sell.slippage_percent = sellSlippage;
								if (balanceCurrencies.length > 0) excDef.account_balance_currencies = balanceCurrencies;
								await saveConfig(appConfigFile, appCfg);
								shareData.appData.bots.exchange = appCfg.bots.exchange;
							}
						}
					}
				}
			}
			catch (e) {

				dataMessage = 'Exchange validation failed: ' + e.message;
			}
		}
	}

	res.send({ success, data: dataMessage });
}


async function updateBotConfigSandbox(req, res) {

	let success = false;
	let dataMessage;

	const body = req.body;
	const password = body.password;
	const sandBox = body.sandBox === 'true' || body.sandBox === true;

	const dataPass = shareData.appData.password.split(':');
	const passwordOk = await verifyPasswordHash({ salt: dataPass[0], hash: dataPass[1], data: password });

	if (!passwordOk) {

		dataMessage = 'Password incorrect';
	}
	else {

		const botConfigFile = shareData.appData.bot_config;
		const botConfig = await getConfig(botConfigFile);

		if (!botConfig.success) {

			dataMessage = 'Unable to read bot configuration file: ' + botConfigFile;
		}
		else {

			const cfg = botConfig.data;
			cfg.sandBox = sandBox;

			const saveResult = await saveConfig(botConfigFile, cfg);

			if (!saveResult.success) {

				dataMessage = 'Failed to save bot configuration: ' + saveResult.data;
			}
			else {

				// Flush exchange connection cache
				if (shareData.appData.exchanges) shareData.appData.exchanges = {};

				const modeLabel = sandBox ? 'Sandbox (paper trading)' : 'Live trading';
				dataMessage = 'Trading mode changed to: ' + modeLabel;
				success = true;
			}
		}
	}

	res.send({ success, data: dataMessage });
}


function getCurrencySymbol(code) {

	if (!code) return '';

	// Check known crypto symbols first — Intl won't handle these correctly
	const crypto = {
		'BTC':  '₿',
		'ETH':  'Ξ',
		'USDT': '$',
		'USDC': '$',
		'BUSD': '$',
		'DAI':  '$'
	};

	if (crypto[code.toUpperCase()]) return crypto[code.toUpperCase()];

	try {

		// Intl handles all ISO 4217 fiat codes automatically
		const sym = (0).toLocaleString('en', {
			style: 'currency',
			currency: code,
			minimumFractionDigits: 0,
			maximumFractionDigits: 0
		}).replace(/\d/g, '').trim();

		// Intl returns the code itself for unknown currencies — treat that as no symbol
		if (sym.toUpperCase() === code.toUpperCase()) return '';

		return sym;
	}
	catch (e) {

		return '';
	}
}


// The quote currency of a trading pair — the asset a deal's profit is denominated in
// (e.g. "USDT" for "BTC/USDT"). Profits in different quote currencies must never be summed
// into one figure, so every per-currency bucketing (dashboard KPIs, the trading journal)
// keys on this ONE canonical helper rather than an inline split, so they can never diverge.
// Accepts both the "/" and "_" pair forms and upper-cases the result; returns 'UNKNOWN' for
// anything unparseable so a malformed pair is visibly quarantined, never mislabeled.
function quoteCurrency(pair) {

	if (typeof pair !== 'string') { return 'UNKNOWN'; }

	const sep = pair.indexOf('/') >= 0 ? '/' : (pair.indexOf('_') >= 0 ? '_' : null);

	if (sep == null) { return 'UNKNOWN'; }

	const parts = pair.split(sep);

	return (parts.length >= 2 && parts[1]) ? parts[1].toUpperCase() : 'UNKNOWN';
}


async function uploadAiChatFile(req, res) {

	const chatUpload = multer({
		storage: multer.diskStorage({
			destination: (_req, _file, cb) => cb(null, os.tmpdir()),
			filename:    (_req, file, cb) => cb(null, 'symbot-chat-' + Date.now() + path.extname(file.originalname).toLowerCase())
		}),
		limits: { fileSize: 25 * 1024 * 1024 }
	});

	chatUpload.single('file')(req, res, async (err) => {

		if (err) {
			const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 25 MB)' : err.message;
			logger('AI chat upload multer error: ' + msg);
			if (!res.headersSent) return res.status(400).json({ success: false, error: msg });
			return;
		}

		if (!req.file) return res.status(400).json({ success: false, error: 'No file received' });

		const file    = req.file;
		const ext     = path.extname(file.originalname).toLowerCase();
		const allowed = ['.pdf', '.docx', '.txt', '.md', '.csv'];

		if (!allowed.includes(ext)) {
			fs.unlink(file.path, () => {});
			return res.status(400).json({ success: false, error: `Unsupported file type: ${ext}. Allowed: ${allowed.join(', ')}` });
		}

		try {

			let text = '';

			if (ext === '.pdf') {
				// Run pdf-parse in a worker thread — keeps the event loop free
				// during CPU-heavy parsing (large PDFs can take several seconds)
				const { Worker } = require('worker_threads');
				const buffer = await fsp.readFile(file.path);

				const workerCode = `
					const { parentPort, workerData } = require('worker_threads');
					const { PDFParse } = require('pdf-parse');
					(async () => {
						try {
							const buf = Buffer.from(workerData.buffer);
							const parser = new PDFParse({ data: buf });
							const data = await parser.getText();
							await parser.destroy();
							parentPort.postMessage({ success: true, text: data.text || '' });
						} catch(e) {
							parentPort.postMessage({ success: false, error: e.message });
						}
					})();
				`;

				text = await new Promise((resolve, reject) => {
					const ab = buffer.buffer.slice(
						buffer.byteOffset,
						buffer.byteOffset + buffer.byteLength
					);
					const worker = new Worker(workerCode, {
						eval: true,
						workerData: { buffer: ab },
						transferList: [ab]
					});
					worker.once('message', msg => {
						if (msg.success) resolve(msg.text);
						else reject(new Error(msg.error));
					});
					worker.once('error', reject);
				});
			}
			else if (ext === '.docx') {
				const mammoth = require('mammoth');
				const result  = await mammoth.extractRawText({ path: file.path });
				text = result.value || '';
			}
			else {
				text = await fsp.readFile(file.path, 'utf-8');
			}

			// Delete temp file immediately — only extracted text is retained
			fs.unlink(file.path, () => {});

			text = text.trim();

			if (!text) return res.status(400).json({ success: false, error: 'Could not extract text from file' });

			// Store text server-side — never sent to client
			if (!shareData.attachmentCache) shareData.attachmentCache = new Map();

			const attachmentId = uuidv4();

			shareData.attachmentCache.set(attachmentId, { name: file.originalname, text });

			// Auto-expire after 1 hour
			setTimeout(() => shareData.attachmentCache.delete(attachmentId), 60 * 60 * 1000);

			res.status(200).json({
				success:      true,
				attachmentId: attachmentId,
				name:         file.originalname,
				type:         ext.slice(1),
				size:         file.size,
				charCount:    text.length,
			});

		}
		catch (e) {

			fs.unlink(file.path, () => {});
			logger('AI chat upload error: ' + e.message);
			if (!res.headersSent) {
				res.status(500).json({ success: false, error: 'Extraction failed: ' + e.message });
			}
		}
	});
}


module.exports = {

	getCurrencySymbol,
	quoteCurrency,
	delay,
	uuidv4,
	uploadAiChatFile,
	makeDir,
	convertBoolean,
	convertToCamelCase,
	convertStringToNumeric,
	freezeProperty,
	isNumeric,
	sortByKey,
	getConfig,
	getSignalConfigs,
	saveConfig,
	updateConfig,
	pairBlackListed,
	getInstanceName,
	getInstanceLabel,
	getData,
	saveData,
	getDateParts,
	normalizeTimeZone,
	tzOffsetMsAt,
	zonedDateStr,
	zonedDayRangeUTC,
	roundAmount,
	roundCost,
	exchangeAlias,
	toNum,
	countDecimals,
	readSecret,
	isEncrypted,
	encryptSecret,
	encryptCredential,
	migrateBotCredentials,
	adjustDecimals,
	getPrecision,
	deepCopy,
	numToBase26,
	numFormatter,
	hashCode,
	genApiKey,
	genDefaultApiKey,
	decryptConfigSecretsForRollback,
	genToken,
	safeEqual,
	setToken,
	genPasswordHash,
	verifyPasswordHash,
	verifyLogin,
	checkLoginBlocked,
	recordLoginFailure,
	recordLoginSuccess,
	validateApiKey,
	renderView,
	timeDiff,
	logger,
	makeLogger,
	auditEvent,
	redactSecrets,
	stripMongoOperators,
	stripAnsi,
	ansiToHtml,
	withTimeout,
	// Notification routing catalog/defaults for the config UI (the router itself is used internally
	// by sendNotification). Pass-throughs so views/routes reach them via the always-present Common.
	notificationsCatalog: () => Notifications.catalog(),
	notificationsDefaults: () => Notifications.defaultConfig(),
	getServerId,
	instanceNameSync,
	instanceLabelSync,
	instanceDataDir,
	ensureDataDir,
	logDir,
	logFileName,
	logFilePath,
	healDataLayout,
	migrateDataLayout,
	writeRekeyJournal,
	clearRekeyJournal,
	recoverRekeyJournal,
	logMonitor,
	showFiles,
	downloadFile,
	fileInScope,
	isLogArtifact,         // single source of truth for the log-filename shape (reused by System + LogScan)
	isBackupArtifact,      // single source of truth for the backup-filename shape (reused by System)
	safeInstanceLabel,     // filesystem-safe instance-name sanitizer used by friendlyArtifactName (exported for tests)
	instanceBackupFileName,// "<instance>-<file>" off-site (SFTP) backup filename, from the instance's own identity
	friendlyArtifactName,  // "<instance>-<file>" download name, resolved from the artifact index
	instanceIndexMeta,     // identity metadata (server_id + display name) stored in every artifact manifest
	resolveDataFilePath,   // exposed for tests (Hub server_id resolution + traversal guards)
	sendNotification,
	getNotificationHistory,
	showTradingView,
	fetchURL,
	getClientIp,
	getProcessInfo,
	getSystemHealth,
	safeEvalArithmetic,
	hostMemory,
	validateAppVersion,
	dealDurationMinutes,
	computeDealSetStats,
	roundWinRate,
	startSignals,
	retainLogs,
	sendSocketMsg,
	sendParentMsg,
	getBotConfig,
	updateBotConfig,
	updateBotConfigSandbox,

	init: function(obj) {

		shareData = obj;
	},
};