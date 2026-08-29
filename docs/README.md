


![SymBot Logo](https://user-images.githubusercontent.com/111208586/221390681-d13b9bce-dafb-4b55-a6f1-1bc5218cd204.png)

SymBot is a user friendly, self-hosted and automated DCA (Dollar Cost Averaging) cryptocurrency bot solution. Create and manage your bots entirely from your web browser or with simple built-in APIs. Best of all, your exchange credentials and keys always remain in your hands... not any other third-party.

![SymBot](https://github.com/user-attachments/assets/c0e8b81c-3ee8-4657-90c4-989c38f94297)

[![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/m8TyEpBaCg)


## Understanding SymBot

New to automated crypto trading? This section walks through how it all works, step by step. If you're already familiar with DCA bots, feel free to skip ahead to [Requirements](#requirements).

Dollar Cost Averaging (DCA) is a simple idea: instead of buying an asset — say Bitcoin — all at once, you spread your buys out. If Bitcoin's price falls after your first buy, you buy again at the lower price (and depending on your settings, in a larger amount). This pulls down your average entry cost, so the price only has to recover part of the way for the position to turn a profit. When it reaches your target, the position closes and the cycle can begin again.

SymBot automates the entire process for you. It watches the market, places those follow-up buys (called safety orders) automatically, and closes each deal when it hits your profit target — all running on your own server, with your exchange keys staying in your hands.

With that in mind, here's a simple way to picture how the pieces fit together.

Think of SymBot as a real-world business that you own. It's the entire operation... the building, the electrical and plumbing systems, the phone lines, the computers, the accounting department... everything that keeps the business running. It's the infrastructure that allows your trading operation to function.

Now think of each bot as one of your managers. Every manager is responsible for a team of employees, and those employees are your deals. Just like in a real business, your managers and employees need working capital to do their jobs.

Where do your managers get the work in the first place? Think of signals as your sales leads. A lead is a tip that an opportunity might be worth pursuing... and just like in a real business, a manager doesn't chase every lead that comes across the desk. You decide which leads your managers are allowed to act on, using each bot's start conditions. A good lead in the right market can be the beginning of a profitable deal; a weak one might be better left alone. Signals can come from sources like 3CQS or your own setup, but the important part is the same: they're the leads that tell your managers when it might be time to put someone to work... they don't guarantee a sale, and it's still up to you to decide which ones are worth acting on.

That same restraint applies to how much you take on. If business is slow, you probably wouldn't hire ten new managers and hundreds of employees just to have them standing around. The same principle applies to trading: you don't want to run more bots or open more deals than your capital and market conditions can comfortably support. Good risk management is really just good business management... adjusting your workforce to match the workload.

One of the fun features in SymBot is that you can even use AI to "chat" with your employees (your deals). Ask them how things are going, why they're taking so long, or when they think they might close a profitable sale. Just don't be too hard on them... they're simply following the instructions you gave them.

The goal isn't to build the biggest business. It's to build one that's efficient, well-managed, and profitable over the long run.

If you take away just two things, make it these. First, always be sure you can fully cover all your bots. Every deal a bot opens may need funding all the way down through its safety orders, so your capital has to be able to support the worst case, not just the best one. This is exactly why SymBot calculates a risk percentage for you... it shows how much of your portfolio you'd be committing if every bot ran to its maximum. Keep an eye on it, and don't let it get ahead of what you can actually cover.

Second, patience is key. DCA trading rewards discipline over urgency. Deals can take time to close in profit, and that's normal... it's the strategy working, not failing. Resist the urge to overextend, chase, or micromanage. A calm, well-funded operation almost always beats a busy, overstretched one.


## Table of Contents

- [Understanding SymBot](#understanding-symbot)
- [Requirements](#requirements)
- [Installation](#installation)
- [Installation Video](#installation-video)
- [Docker Installation](#installation-docker)
- [SymBot Hub](#symbot-hub)
- [Upgrading](#upgrading)
- [Configuration](#configuration)
- [Creating Your First Bot](#creating-your-first-bot)
- [Telegram Setup](#telegram-setup)
- [Advanced Setup](#advanced-setup)
- [Reverse Proxy Setup](#reverse-proxy-setup)
- [Circuit Breaker](#circuit-breaker)
- [Deal Health Indicator](#deal-health-indicator)
- [Deal Chart](#deal-chart)
- [Stop-Loss](#stop-loss)
- [Trailing Stop](#trailing-stop)
- [Add Funds Estimator](#add-funds-estimator)
- [Portfolio Summary Bar](#portfolio-summary-bar)
- [Transaction Export](#transaction-export)
- [Trading Journal](#trading-journal)
- [System Health](#system-health)
- [Artificial Intelligence (AI)](#artificial-intelligence-ai)
  - [AI Generation](#ai-generation)
  - [AI Chat](#ai-chat)
  - [AI Chat Conversations](#ai-chat-conversations)
  - [AI Chat File Attachments](#file-attachments)
  - [AI Chat Context Compression](#context-compression)
  - [AI Chat Deal Context](#deal-context)
  - [AI Tools (experimental)](#ai-tools-experimental)
  - [AI Learning (experimental)](#ai-learning-experimental)
- [Scheduled Tasks](#scheduled-tasks)
  - [Schedules in backups](#schedules-in-backups)
- [Access Control (Users, API Keys & Audit)](#access-control-users-api-keys--audit)
  - [API keys](#api-keys)
  - [Users](#users)
  - [Audit log](#audit-log)
  - [Watchdog](#watchdog)
- [API Information](#api-information)
  - [Getting started](#getting-started)
  - [Authentication](#authentication)
  - [Errors](#errors)
- [API Sample Usage](#api-sample-usage)
- [WebSocket API](#websocket-api)
- [Webhooks](#webhooks)
  - [Signal Bot](#signal-bot)
  - [Using TradingView](#using-tradingview)
  - [Signal Activity](#signal-activity)
- [Backup and Restore Features](#backup-and-restore-features)
- [Reset or Configure SymBot](#reset-or-configure-symbot)
- [Frequently Asked Questions (FAQ)](#frequently-asked-questions-faq)
- [Disclaimer](#disclaimer)
- [Help Support](#help-support)

## Requirements

- Linux, MacOS, or Windows based system
- [Node.js](https://nodejs.org) **v22.15** or later (a current v22 LTS release) must be installed on your system — this is the single minimum the rest of the documentation refers back to. Earlier versions will not run SymBot correctly, and `npm install` may warn that the Node version is unsupported. (See the FAQ if you are unsure how to check or update your Node version.)
- [MongoDB](https://www.mongodb.com) installed or a cloud host provider
- Access to a cryptocurrency exchange such as Binance or Coinbase
- Reliable high-speed internet connection
- 1GB RAM minimum; 2GB or more is comfortable for typical use with several bots. Running a local AI model on the same machine needs considerably more (see the [Artificial Intelligence (AI)](#artificial-intelligence-ai) section).
- 1GB disk space minimum

**NOTE:** Trading requires your system and internet connection to be running 24/7. Any interruption could result in missed trades, signals, etc. See also [Disclaimer](#disclaimer).


## Installation

If you prefer to run SymBot using Docker, feel free to skip this section and proceed to the [Docker Installation](#installation-docker) section below.

Once you have met all the requirements, follow these simple steps to install SymBot:

1. Open a command line terminal
2. Change directory to where SymBot files are located
3. Type: `npm install`
4. Wait for all packages to download and install
5. SymBot will start in configuration mode, allowing you to enter your database URL and other settings using the web interface.
	- Default password is *admin*
	- Modify the app and bot configuration files as necessary (see [Configuration](#configuration))
6. Type: `npm start`. You can also use `npm start consolelog` to display all logging to the console for testing purposes. The same information is also logged to files in the `logs` directory
7. Open a web browser and type: http://127.0.0.1:3000

<a id="pm2-id"></a>
### Recommended additional steps (optional)

To have SymBot run in the background it is recommended to use the Node.js process manager called pm2. Here's how to use it:

1. Install pm2 by typing: `npm install pm2 -g`
2. Create a file called `ecosystem.config.js` in the same location where your SymBot files are located and place the below configuration into it:
```
module.exports = {

	apps: [
			{
				name: 'symbot',
				namespace: 'symbot',
				script: '/home/symbot/symbot.js',
				kill_timeout: 8000,
				max_memory_restart: '4000M'
			}
		  ]
}
```
3. Replace `/home/symbot/symbot.js` with the actual location where SymBot resides on your server and save the file
4. Tell pm2 to start SymBot with a one time only command by typing: `pm2 start ecosystem.config.js`
5. Type: `pm2 save` to save the configuration
6. If you don't already have pm2 starting at system boot time, type this with root privileges: `pm2 startup`. Then type: `pm2 save`

SymBot will now start automatically even when the system is rebooted. With the above configuration pm2 will monitor SymBot and if memory exceeds roughly four gigabytes, a kill signal will be sent to SymBot. pm2 will wait eight seconds before terminating the process to give SymBot some time to safely shut itself down. pm2 will then start SymBot again. You can change those settings to suit your own server requirements and needs.

## Installation Video

Sometimes you want just a little more guidance on how to get everything installed, so here's a quick video that demonstrates how to get SymBot installed along with Node.js and MongoDB on Ubuntu.

**Note:** With SymBot's configuration mode, manually editing the configuration files before starting, as shown in the video, is no longer required.

<a href="https://youtu.be/p_gZtRrgNNQ" target="_blank">
	<picture>
		<img src="https://github.com/3cqs-coder/SymBot/assets/111208586/b428f4d4-7f1b-4ce3-9c48-0bb29d2b4e7e" width="720" />
	</picture>
</a>

## Installation (Docker)

Docker can be a great way to get SymBot up and running fast with all the necessary dependencies such as MongoDB.

The Docker build files can be modified as necessary, but should only be done if you're familiar with how they work. Running SymBot under Docker is considered experimental. Your configuration, databases, and backups are stored in named Docker volumes rather than inside the container image, so they are preserved across container restarts and image rebuilds, including upgrades. See Data persistence and upgrades below for how to upgrade safely.

1. Open a command line terminal
2. Change directory to where SymBot files are located
3. Make any additional changes to the app and bot configuration files as necessary (see [Configuration](#configuration))
	- SymBot will automatically configure the database URL and set your password to *admin*
4. Change directory to `docker` in the same location where SymBot files are located
5. Type: `docker compose -p symbot up -d --build` (older Docker installs use the hyphenated `docker-compose`)
6. Wait for Docker to build everything and all containers to start
7. Open a web browser and type: http://127.0.0.1:3000

SymBot will initially start in configuration mode. After you confirm the default settings and update, it will shutdown and restart automatically.

Mongo Express is also installed as an optional visual admin UI for MongoDB, reachable at http://127.0.0.1:3010. It is bound to localhost only and protected with basic authentication because it exposes full database access — change its password in `docker-compose.yml` before use, and never expose it on a public interface (on a remote or VPS host, reach it over an SSH tunnel, or remove the `mongo-express` service entirely).

### Data persistence and upgrades

SymBot's state is stored in named Docker volumes rather than inside the container image, so it survives container restarts and upgrades. The bundled MongoDB keeps its data in the `mongo-data` volume, and the SymBot container persists your configuration (`config/`, including your encrypted secrets and this instance's identity), the Hub database and runtime state (`data/`), your System backups (`backups/`), uploads, logs, and rollback snapshots. Only the application code is replaced when the image is rebuilt.

To upgrade a Docker install, update the SymBot files (for example with `git pull`) and rebuild from the `docker` directory:

```
docker compose -p symbot up -d --build
```

This rebuilds the image with the new code and recreates the containers while keeping all of the volumes above, so your bots, deals, history, and settings carry across intact. The rebuild also installs any new dependencies during the build, so there is no separate `npm install` step for Docker. If you use the one-click upgrade inside the web interface instead, its downloaded changes apply only until the container is next recreated — rebuild the image as above to make an upgrade permanent.

To start completely fresh, remove the volumes with `docker compose -p symbot down -v` before building again. This permanently deletes the database, configuration, and backups, so take a backup first if you might need them.

<a id="symbot-hub-id"></a>
## SymBot Hub

SymBot Hub makes it easy to manage multiple SymBot instances from a single codebase. Whether you're testing strategies on different exchanges, running real and paper (sandbox) trading, or managing other setups, you can control everything with just a click.

With SymBot Hub's simple web interface, you can easily add, update, restart, or disable any instance. It also combines all instances into one system using an internal proxy server, so you only need one port to access everything. Plus, SymBot Hub helps you monitor system resources like memory usage, making instance management straightforward and efficient.

### Hub Unified Views

In addition to instance management, SymBot Hub provides unified views that aggregate data across all running instances:

- **Dashboard** — the Hub home page shows a live summary refreshed every 30 seconds. Per-instance cards display active deal count, bot count, active P/L, portfolio balance, max funds, and risk percentage (color-coded green / amber / red). A combined totals bar across all instances sits at the top. Sandbox instances are clearly badged.

- **Active Deals** — view all active deals across every instance in a single table. Filter by instance or bot, adjust the refresh interval, and take actions directly from the Hub including closing, pausing, resuming, canceling deals, and stopping bots. Clicking on a pair opens a chart for that deal — a Deal tab overlaying the order ladder, average entry, and take-profit on candles, plus a TradingView tab for the same symbol (see [Deal Chart](#deal-chart)). Deals paused automatically by SymBot due to order verification failures are highlighted distinctly from manually paused deals.

- **Bots** — view all bots across every instance in a single table, including the exchange each bot is assigned to. Toggle bots on or off directly from the Hub without navigating to each instance individually. Click any bot row to open the full bot edit page, or use the ✕ button to delete a bot. The + Create Bot button opens a full bot create page for the selected instance. Both create and edit pages include the complete bot configuration form — pairs with exchange-sourced symbol list, all safety order parameters, start conditions, and a preview step that shows the projected order table before saving.

All views refresh automatically and pause when a confirmation dialog is open to prevent stale data from overwriting pending actions.

#### Memory Usage

In the Hub, several SymBot instances run together inside one program, which makes per-instance memory a little more nuanced than a single number. Because they share that one program, the operating system's total memory reading for it — its **resident memory**, or **RSS** — belongs to the whole group and can't be split cleanly between individual instances. So instead of one figure, the Manage Instances view shows a per-instance **Memory** column with two figures for each online instance:

- **Heap** — how much memory that instance's own working data (its JavaScript *heap*) is actively using.
- **Attr** (*Attributed*) — the memory that genuinely belongs to that instance: its heap plus its own off-heap buffers (the `External` and `Array Buffers` that hold things like network and file data). **This is the figure to compare between instances** when you are working out which one is the heaviest.

Because the instances share one program, these Attributed figures will normally add up to less than the program's total memory — the difference is shared runtime, buffers, and allocator overhead that isn't tied to any single instance. After an upgrade, an instance that has not yet restarted reports only its heap until it does.

Alongside memory, the view shows a single Host load figure in the "Managed Instances" header rather than repeating it on every row — because CPU load is host-level and identical for every instance sharing a machine. It reflects how busy the underlying server is. The figure is a percentage of CPU cores (color-coded green/amber/red, the same convention as the System Health card and portfolio Risk %), with the raw 1/5/15-minute averages and core count beside it. It appears once at least one online instance is reporting it, so instances that predate this feature don't contribute a load reading until they restart on the newer version.

### Starting SymBot Hub

Before starting SymBot Hub, make sure your first SymBot configuration is set up and working as expected. The initial instance will be created automatically using your default configuration files.

To get started:

1.  Open a command line terminal.
2.  If any SymBot instances are running, stop them.
3.  Navigate to the directory where your SymBot files are located.
4. You can change the default port in `hub.json` but it is recommended to make all instance additions or updates using the web interface.
5.  Run the command: `node symbot-hub.js`
6.  Open a web browser and go to: http://127.0.0.1:3100

Your SymBot instances are now all accessible through SymBot Hub. For example, if you have two SymBot instances running on ports 3000 and 3001, you can access them by visiting:

-   http://127.0.0.1:3100/instance/3000
-   http://127.0.0.1:3100/instance/3001

This setup also makes it easier to use a domain name to access your SymBot instances. By pointing your domain to SymBot Hub, you can access them at:

-   http://your-domain.com/instance/3000
-   http://your-domain.com/instance/3001

Once SymBot Hub is running, it is recommended to update your process manager to automatically start SymBot Hub instead of individual SymBot instances. This ensures that SymBot Hub takes over the management of all SymBot instances, while your process manager continues to handle the automatic startup of SymBot Hub itself.

If your process manager, such as [pm2](#pm2-id), has maximum memory restart parameters configured, you may need to increase the limit, as SymBot Hub will consume more resources as the number of instances grows.

Lastly, be aware that exchanges often impose connection limits, and if you’re using services like Telegram, 3CQS signals, or other providers requiring API keys, there may also be restrictions on the number of connections allowed per IP address or API key. To stay within these limits, you may need to disable certain services on specific instances.

## Upgrading

SymBot offers a convenient, one-click upgrade feature within its web interface. This feature automatically checks for new updates, downloads necessary files, installs them, and updates any required packages. Although the automated upgrade process eliminates the need to follow the manual steps below, it's recommended to review them to ensure that any process manager in use restarts SymBot correctly and that all trading activities resume smoothly.

> **Before upgrading:** make sure your Node.js meets the minimum listed under [Requirements](#requirements). If you upgrade the code on a machine running an older Node, SymBot will stop with a clear message asking you to update Node — upgrade Node first. After a manual upgrade, always run `npm install` so any new dependencies are installed; the in-app updater and a Docker image rebuild both do this for you.

The automatic upgrade replaces only shipped code. Your data is left untouched: the in-app updater preserves the `config/`, `data/`, `backups/`, `uploads/`, `logs/`, `sessions/`, and `rollbacks/` directories rather than overwriting them. That means your instance databases (external MongoDB, never touched by a file update), your configuration (new settings are merged in, your values kept), and — under SymBot Hub — the Hub database (users, API keys, and the audit log, stored at `data/hub/hub.db`) all carry across an upgrade intact. The Hub database also takes its own daily backup.

Before applying an update, SymBot automatically creates a rollback snapshot of the current code files in the `rollbacks/` directory. Up to three snapshots are retained.

If an update causes issues and SymBot is still running, you can restore a previous version using the Rollback System option in the System menu — no manual file management required.

If SymBot will not start at all after an update, use the rollback command directly from your terminal — the same way you would run a reset:

```
node symbot.js rollback
```

This lists available snapshots with their version and date, prompts you to select one, restores the code files, runs `npm install`, and exits. Start SymBot normally afterwards with `npm start`. You can also pass a snapshot name directly to skip the prompt:

```
node symbot.js rollback <snapshot-name>
```

Note that rollback restores code files only; the database is not affected. If an update introduced database schema changes, rolling back the code may require reviewing the logs after restart to confirm compatibility.

Rolling back across the move to encrypted credentials is handled for you. This version encrypts your exchange and provider secrets at rest, and older versions cannot read them. So when you roll back to a version from before that change, SymBot — still running the current code at that moment — first decrypts those secrets back to plaintext, so the older version can use them. This is version-aware: rolling back between two versions that both understand encryption leaves the secrets encrypted. As always, taking a full backup of your install directory before a major upgrade is the surest safety net.

When upgrading to a new version of SymBot it is recommended to follow the basic steps below.

1. Stop all running SymBot instances
	- If using pm2 suggested in the installation above, you can type: `pm2 stop ecosystem.config.js` in a command line terminal
2. Make a backup of the directory to where all current SymBot files are located
3. Extract new SymBot files to existing directory. If prompted, be sure to allow new files to replace the original or you may be running portions of a previous version
4. Copy existing configuration files from backup created previously
5. Compare parameters in the new SymBot configuration files such as `app.json` to existing files if any have been added or removed. Any changes must be added to existing configurations or this may cause SymBot to not start or run properly
6. Type: `npm install` to ensure all modules are installed properly
7. Start SymBot and verify the new version is running
8. Monitor logs for a few minutes either on the console, log files, or the web interface to ensure everything is operating as before

**NOTE:** If you are running SymBot behind any other services such as Apache, Nginx, Cloudflare, etc. you may need to clear caches in order for the latest upgraded files to be served properly.

**Security and secrets on upgrade.** This version stores your exchange API credentials encrypted at rest in the bot configuration file (previously they were kept as plain text). No action is required and nothing about trading changes:

- On the first start after upgrading, any existing plain-text keys are automatically encrypted in place.
- Keys are decrypted in memory only at the moment SymBot connects to the exchange.
- An existing plain-text key keeps working and is simply encrypted on that first start. (If the configuration file happens to be read-only — for example a locked Docker volume — the key stays readable and functional and is left as-is.)
- Because the encryption is derived from your configuration password, changing that password automatically re-encrypts the stored keys, so trading continues uninterrupted.

Two related least-privilege tightenings you may notice:

- **Scoped API keys are enforced per-route** — a key only works on the routes its capabilities cover.
- **The legacy webhook token is limited to deal actions only** — opening, funding, pausing, and closing deals. It can no longer start or stop bots, edit bot configuration, or read your data, since none of those are signal operations.

If you previously used a webhook to perform one of those now-blocked actions, grant that action explicitly to a scoped API key that holds the needed permission.


## Configuration

These files are located in the `config` directory

- **app.json**

	- `password` is a hashed password used to login to the SymBot web interface. The default password is automatically set as "*admin*" the very first time SymBot is started. This is not a plain text password, but rather an encrypted form of it, so it should not be manually entered or you may not be able to login properly. It is strongly recommended to change the default password using the web interface configuration. While the instance is still using the default password, a red security reminder is shown across the top of every page after you log in, and it disappears automatically the moment you set your own password.

	- `max_log_days` is the maximum number of previous days logs to keep. The default is 10 days.

	- `web_server` contains settings for the SymBot web server. The default port is 3000.

	- `api`
		- `key` is a hashed form of your API key that is generated using the web interface configuration. Do not set this manually or SymBot may not function properly.
		- `enabled` set to true to allow API access or false to disable access.

	- `webhook`
		- `enabled` set to true to allow Webhook usage.

	-	`bots`
		-	`start_conditions` contains keys and descriptions such as `asap` and `api` for various start conditions that can be used to start bots and deals. The keys should never be changed after the initial start of SymBot or they will not match previous bots and deals.
		-	`exchange` contains additional parameters that will apply to particular exchanges. Currently only the *default* exchange parameter is supported.
			-	`orders` contains buy and sell parameters
				-	`slippage_percent` is an additional percentage that is factored into the current price before another buy or sell order is placed on the exchange.  Sometimes orders will be executed at a different price than originally requested primarily with market orders. This helps to ensure orders are executed at or below the buy price and at or above the sell price requested. This can also potentially increase overall profit, but setting these values too high may cause further delays in closing your deals. Both buy and sell slippage percentages are configurable in **Configuration → Exchange Settings → Order Settings** without restarting SymBot.
			-	`account_balance_currencies` is an array of currencies that are used to show preferred exchange account balances in order of precedence (e.g. `["USD", "USDT", "USDC"]`). Configurable in **Configuration → Exchange Settings → Order Settings** using a tag-style input where each currency is added individually.
		- `pair_buttons` is an array of currencies that is used to automatically fill in pairs after clicking on one of these buttons when creating or updating bots.
		-	`pair_blacklist` is an array of pairs that you don't want to trade. You can use full pairs such as BTC/USD or wildcards such as BTC/*. This can be useful to prevent bots from starting deals using stablecoin pairs such as USDT/USD as those will generally have little volatility in typical market conditions.

	- `cron_backup` — **note:** as of this version the system backup is a scheduled job stored in the database (`schedules` collection, `type: backup`), not in `app.json`. On first start any existing `app.json` backup configuration is copied automatically into a backup schedule row. The `app.json` block itself is left untouched (read-only, as a legacy migration seed) so that, under the Hub, multiple instances sharing one `app.json` but using separate databases can each migrate their own backup row from it; after migration it is simply dormant and no longer used at runtime. The fields below describe that legacy shape; the live backup is edited through **Configuration → System Backups** exactly as before.
		- `schedule` this is a crontab format schedule of the days and time to process tasks.
		- `password` is the password that will be used to encrypt system backups. It is required and is not a plain text password, but rather an encrypted form of it, so it should not be manually entered. On the configuration screen this field is write-only — it shows "Password is set" when a value exists and is never displayed back; leave it blank to keep the existing password, or click the **[Clear]** link next to it to remove it.
		- `max` is the maximum number of backups to keep.
		- `include_chats` controls whether AI chat conversation history is included in scheduled automatic backups. Defaults to `true`. Can also be toggled per-backup when performing a manual backup from the System menu. AI chat history can also be reset independently via the CLI using `npm start reset aichats` or from the System menu during a database restore.
		- `enabled` is whether the cron scheduler will run and automatically process system backups.
		- `sftp`
			- `host` is the SFTP host to upload backups
			- `port` is the port to connect to (defaults to 22)
			- `username` to login as
			- `password` associated with the username. This is an encrypted value so it should not be manually entered. On the configuration screen this field is write-only — it shows "Password is set" when a value exists and is never displayed back; leave it blank to keep the existing password, or click the **[Clear]** link next to it to remove it.
			- `private_key` stores an encrypted form of your private key content. This should not be manually entered — paste the contents of your private key file (e.g. `id_rsa` or `id_ed25519`) into the Private Key field on the configuration screen. The key will be encrypted and stored securely. If the configuration password is ever changed, all stored SFTP secrets including the private key are automatically re-encrypted under the new password.
			- `passphrase` an optional passphrase for your private key. This is an encrypted value so it should not be manually entered. On the configuration screen this field is write-only — it shows "Passphrase is set" when a value exists and is never displayed back; leave it blank to keep the existing passphrase, or click the **[Clear]** link next to it to remove it.
			- `remote_directory` is the path on the remote host where your backups will be uploaded. Each instance uploads into its own subfolder of this path (named by the instance's internal identity), and the automatic removal of old backups (per the maximum-backups value) only ever affects that instance's own subfolder. Several instances can therefore safely share one `remote_directory` without one instance's rotation deleting another's off-site backups; any backups you had uploaded under an earlier version are moved into the subfolder automatically on the next upload. Because the subfolder is named by the instance's internal identity (not a human-readable name), the uploaded **file** is prefixed with the instance's own name — for example `Coinbase-Real-backup-<date>_<time>.zip.enc` — so a plain remote directory listing shows which instance a backup belongs to. That name comes from the instance's own stable identifier, so it is identical whether a backup was taken on schedule or on demand with *Run now*
			- `enabled` is whether the backups will be automatically uploaded after being processed via cron

	- `telegram` contains an optional Telegram token id and user id to send SymBot notifications to. This includes system warnings such as detected connectivity issues, bot and deal start / stops, and more! You must first create a Telegram bot with `@BotFather` to use (see [Telegram Setup](#telegram-setup)).

	- `mailer` contains optional outbound SMTP settings used to deliver schedule notifications sent to an Email destination. Edit these under **Configuration → Email Notifications (SMTP)** and use Test SMTP to verify them before saving.
		- `enabled` whether this instance's own mailer is active. Under the Hub the instance mailer is an override: when it is enabled and configured (a host is set) the instance sends through its own SMTP; otherwise the instance sends through the Hub's shared SMTP automatically (it relays the message to the Hub over the internal worker channel, so the Hub's SMTP password never leaves the Hub). A standalone instance with no SMTP of its own simply can't send email. The shared Hub SMTP is set once in the Hub's own Configuration page (stored in `hub.json`), so a fleet is configured in one place and each instance inherits it.
		- `host` / `port` the SMTP server and port. Common ports: `587` (STARTTLS), `465` (implicit TLS), `25` (unencrypted).
		- `secure` set for implicit TLS (usually port 465); leave off for STARTTLS on 587, which upgrades automatically. Port 465 is treated as secure regardless.
		- `user` the SMTP account username (often your full email address); leave blank for a server that needs no authentication.
		- `from` the From address on notification emails; defaults to `user` if blank.
		- `password` stores an encrypted form of the SMTP password — never entered directly into `app.json`. Enter it on the configuration screen (leave the field blank to keep the existing value, or click the **[Clear]** link next to it to remove it); it is encrypted at rest and, if the configuration password is ever changed, automatically re-encrypted under the new password alongside the other stored secrets.

	- `mongo_db_url` is the URL to your MongoDB instance.

		- **WARNING:**
			- Do not run multiple instances of SymBot using the same database. This will lead to severe bot malfunction and could irreversibly damage your bot's functionality.
			- Avoid direct access to MongoDB. You should never attempt to view, modify, or interact with the SymBot database directly through the MongoDB shell or any other utility. Doing so risks corrupting the database, which could lead to total data loss and irreversible damage to your bot's operation.
		- You do not need to enter this manually. It can be entered using the web interface while in configuration mode.
		- For quick set up, create a free account at https://cloud.mongodb.com and copy the URL given into the app config. It begins with something like: mongodb+srv://
		- If running a local MongoDB instance, specifying `mongodb://127.0.0.1:27017/SymBot` or `mongodb://localhost:27017/SymBot` should work fine, but setting up a username and password is also recommended
		- Keep in mind when using a cloud hosted database, the disk space capacity may be different from your server or the amount of data that can be stored may be limited.  This can cause issues with your bots and deals if your database does not have adequate disk space or there is increased latency accessing a remote database
		- For better speed and security, running your own local database is recommended

	- `signals` contains a section to use signals with SymBot. There is a 3CQS signals section by default. You must have a 3CQS API key for these to work. You can get one by signing up for free at https://www.3CQS.com. Webhooks must also be enabled for these signals to work. Enter the 3CQS API key on the configuration screen rather than directly in `app.json` — like the SMTP and provider keys it is encrypted at rest and write-only (leave the field blank to keep the saved key, or click the **[Clear]** link next to it to remove the saved key entirely), and is re-encrypted automatically if the configuration password changes.

	- `circuit_breaker` contains settings for the automatic circuit breaker that temporarily pauses deal processing during sudden market drops. See [Circuit Breaker](#circuit-breaker) for full details.
		- `enabled` set to true to enable the circuit breaker or false to disable it. Default is `true` — the circuit breaker is enabled by default.
		- `deal_ratio_threshold` the fraction of active deals that must trigger safety orders within the window to activate (e.g. `0.5` = 50% of active deals). Minimum 2 deals must trigger regardless of ratio.
		- `deal_ratio_window_secs` rolling time window in seconds for counting simultaneous safety order triggers. Default is `30`.
		- `price_drop_percent` percentage price drop within the window for a single pair that triggers the circuit breaker. Default is `5.0`.
		- `price_drop_window_secs` rolling time window in seconds for measuring price drops per pair. Default is `60`.
		- `price_drop_enabled` whether the price drop trigger is active. Set to `false` to use only the deal ratio trigger. Default is `true`.
		- `pause_duration_secs` how long in seconds to block new buys when the circuit breaker activates. Sells, cancels, and panic sells are always allowed through. Default is `60`.
		- `repeat_alert_window_secs` if the circuit breaker activates more than once within this window, an elevated Telegram alert is sent warning that market conditions may be deteriorating. Default is `3600` (1 hour).
		- `price_zero_alert_count` number of consecutive Invalid Price: 0 events for the same deal before a Telegram alert is sent. Default is `4`.
		- `price_deviation_high_ratio` reject a fetched price more than this multiple above a deal's DCA average as implausible (a corrupt price feed). Must be greater than 1 and above your largest take-profit multiple. Default is `2`.
		- `price_deviation_low_ratio` reject a fetched price more than this multiple below a deal's DCA average (i.e. price < average ÷ this). Set generously so deep averaging-down is never blocked. Default is `10`.
		- `price_implausible_alert_count` number of consecutive implausible-price events for the same deal before a Telegram alert is sent. Default is `4`.
		- `close_held_alert_count` number of consecutive ticks a pending panic sell / cancel is held (because the price feed is unreliable) before a safety alert is sent. This alert is sent regardless of whether the circuit breaker is enabled. Default is `15`.
		- `portfolio_loss_enabled` whether the portfolio-loss trigger is active — it blocks new buys when the whole portfolio's realized loss (from closed deals) exceeds the limit within the window. Default is `false`.
		- `loss_window_hours` rolling time window in hours over which the portfolio loss is measured. Default is `24`.
		- `loss_limit` the portfolio realized-loss threshold that trips the breaker (in the account's quote currency; `0` disables it). Default is `0`.

	- `ai` contains settings for the AI provider used with SymBot. See the [Artificial Intelligence (AI)](#artificial-intelligence-ai) section for full details and configuration options.
		- `max_history` is the maximum number of messages retained per conversation session. Defaults to 25. Messages older than 2 hours are automatically purged from memory.

- **bot.json**

	- This contains all default settings for your bot and exchange. Exchange credentials and trading mode can be managed directly from the web interface under **Configuration → Exchange**, so you do not need to edit this file manually. For a fresh install you can leave all credential fields empty and keep `sandBox: true` until you are ready to trade live.
	- **Exchange settings via the web interface** — navigate to **Configuration → Exchange** to:
		- Select your exchange from a full list of supported exchanges
		- Enter or update your API Key, Secret, Passphrase, and Password (credentials are write-only and never displayed once saved). They are encrypted at rest in the bot configuration file — never stored in plain text — and are decrypted only in memory at the moment SymBot connects to the exchange. If the configuration password is ever changed, the exchange credentials are automatically re-encrypted under the new password alongside the other stored secrets. An existing installation whose keys were previously stored in plain text is encrypted automatically on the next start (and if the credentials are edited directly in the file, they are encrypted on the following start as well).
		- **Set the key's permissions safely on the exchange.** When you create the API key on your exchange's website, grant only what SymBot needs: enable trading (usually called "spot" trading), and — importantly — leave **withdrawals disabled**, so the key can never move funds off your account even if it were exposed. If your exchange lets you restrict a key to specific IP addresses, add your SymBot server's address for an extra layer of safety.
		- Set the exchange fee percentage
		- Set the sandbox wallet balance used for paper trading
		- Set the default trading mode for **new** bots — Sandbox (paper trading) or Live — with password confirmation to prevent accidental changes. Like the exchange setting, this is the default for newly created bots only: existing bots keep the mode they were created with (shown in the Sandbox column of the Manage Bots view), so changing the default never flips a running bot between paper and live, and a running deal always finishes in the mode it started in. To run paper and live at the same time, create separate bots — or separate Hub instances — in each mode rather than switching one bot back and forth.
	- **Important:** Exchange settings are saved to `bot.json` only and apply to newly created bots. Existing bots retain the exchange they were created with, which is visible in the Exchange column of the Manage Bots view. When saving exchange settings, a confirmation dialog will offer the option to update all existing bots that have no active deals to use the new exchange (only shown if the exchange name has changed). Bots with active deals are skipped and must be updated manually once their deals complete.
	- The Order Settings subsection of Exchange Settings (Buy Slippage %, Sell Slippage %, Balance Currencies) are saved to `app.json` and take effect immediately on the next order without restart.
	- Valid exchanges include binance, binanceus, coinbase, and many others. SymBot uses the [CCXT](https://github.com/ccxt/ccxt) library so if the exchange is supported, you should be able to connect to it. When saving exchange settings the credentials are validated against the exchange before being written to disk.
	- Most bot settings do not need to be set here since they can be set when creating a bot in the web interface
	- Set your exchange fee appropriately:
		- The `exchangeFee` is used for multiple purposes including buying more of an asset to ensure accurate profitability when selling, and having enough additional quantity of the asset to sell. If you encounter sell errors, such as insufficient funds, you may want to increase this value even higher than your exchange's said fees. You may end up with slightly more assets or crypto "dust", but it will help prevent sell errors especially when trading the asset through repeated deals. Changing this value will only take effect on new deals.
		- Exchanges such as Binance often deduct trading fees from a separate token balance — for Binance, BNB (Binance Coin). If that balance runs low, a trade can fail, which may show up as errors such as being unable to sell or take profit. If that happens, consider disabling the fee-token option (for example paying fees with BNB) on your exchange, and raise the `exchangeFee` value so SymBot sets aside a little more for fees.
	- If you experience any issues with your bots or deals using a specific exchange, there is a special parameter that can pass options directly to the CCXT library by modifying `"exchangeOptions": { "defaultType": "spot" }`


- **server.json**

	- This file is created the very first time SymBot is started. It contains an automatically generated UUID v4 `server_id`. The primary purpose is to ensure if there are ever multiple instances of SymBot running, they do not accidentally conflict with the database used. When SymBot starts it will compare the `server_id` value in this file to the database entry. If they do not match, SymBot will shut down.
	- This file should never be copied to another folder or server if you plan to run additional instances of SymBot, or manually edited unless you have a good reason to do so.


## Creating Your First Bot

Once your exchange is connected (Configuration → Exchange), you create and manage bots entirely from the web interface — click **Create Bot**, choose the pair or pairs to trade, fill in the settings below, and use the **Preview** step to see the full order plan before you save. Keep the bot in Sandbox (paper trading) mode until you are comfortable with how it behaves.

A DCA bot buys in stages rather than all at once. It opens a deal with a first **base order**, and if the price falls it places additional **safety orders** to buy more at lower prices. Each safety order lowers your average buy price, so the price only has to recover a little — not all the way back to where you started — for the deal to reach its profit target and close. These are the main settings you'll set:

- **Base order amount** — the size of the first buy when a deal opens.
- **Safety order amount** — the size of the first safety order. Each following one can be larger (see the size multiplier).
- **Price step %** — how far the price must fall before the next safety order is placed.
- **Size multiplier** — makes each safety order larger than the one before it, so the lower buys carry more weight in your average.
- **Step multiplier** — widens the gap before each next safety order, so the ladder reaches further down as the price keeps falling.
- **Take-profit %** — how far above your average buy price the deal closes in profit. You can also choose whether that profit is taken in the *quote* currency (the money you spend, such as USDT) or the *base* currency (the asset you are buying, such as BTC) — the [FAQ](#frequently-asked-questions-faq) explains the difference.
- **Max safety orders** — how many safety orders the ladder may use before it stops adding more.
- **Max Pairs / Max Deals** — how many deals the bot may run at once, and (optionally) how many it may open in total.
- **Start condition** — *asap* means the bot opens deals on its own; *api* means it opens a deal only when it receives an external signal (see [Signal Bot](#signal-bot)).

**A quick example.** Suppose a bot buys BTC with a $20 base order and a take-profit of 1.5%. It opens a deal buying $20 of BTC at $100. If the price drops, it places safety orders that buy more at lower prices — each a little larger and a little further apart than the last — pulling your average buy price down below $100. Now the deal no longer needs BTC to climb all the way back to $100: it only needs the price to rise 1.5% above your new, lower average for the bot to sell and lock in the profit. If the price never falls, the deal simply closes on the base order once it is up 1.5%. The **Preview** step lays out this whole ladder — every safety order's price and size, and the take-profit target — before you commit, so you can see exactly how much money the bot could use in the worst case.

One thing to watch as you size those orders: SymBot shows a Risk % figure (see [Portfolio Summary Bar](#portfolio-summary-bar)) that tells you how much of your capital would be committed if every bot ran all of its safety orders at once. Keep it within what you can actually cover.

## Telegram Setup

Using Telegram with SymBot is a great way to know when bot deals start and finish, but also getting notifications when issues are detected, such as being unable to connect to your exchange.

You just need to create a Telegram bot with `@BotFather`. Here are some simple steps on how to do that:

1. Open a Telegram chat with `@BotFather`
2. Once there you may need to type or click on `/start`
3. Type: `/newbot`
4. Choose a name that will be displayed when you receive messages from Telegram. For simplicity, just use: SymBot. This does not need to be unique to Telegram.
5. Now you need to choose a unique Telegram username. This can be just about any string value, but it must end in the word bot. For example: MySymBotServer123_bot
6. If the username you chose was not already taken, then you should receive a token that looks something like: 12345:AbCdEfG_123Abc
7. Open a chat with your new bot MySymBotServer123_bot (use the actual name of your bot)
8. Type or click on `/start`
9. Copy your Telegram bot token into the SymBot `app.json` configuration file. You must also enter your own Telegram id or SymBot will not allow messages to be sent. If you don't know your Telegram id, open a chat with `@userinfobot`
10. Restart SymBot

## Advanced Setup

If you're experiencing issues such as application crashes or slow performance, there are a few things to consider:

- Ensure the system running SymBot has adequate resources available such as memory and hard drive space to help prevent these issues in the first place.
- Keep your system up to date with the latest security patches and performance improvements. Use your package manager to update the installed software regularly.
- Disable unnecessary services and daemons that are not required for your specific use case. This reduces the system's resource usage.

Below are some additional tips to optimizing your system and SymBot performance.

### Swap space
Swap space is a portion of your storage that the system uses as extra "virtual" memory when the real memory (RAM) fills up. It can keep the machine from crashing when it would otherwise run out of memory.

A few things to keep in mind:

- Swap is slower than real RAM, so only use it if you actually need it.
- A common rule of thumb is to allow at least as much swap as you have RAM.
- How you create and enable swap varies by operating system.

You can use the `swapon` command to check swap space on Linux. Just type `swapon -s` in the terminal, and it will show you the currently active swap devices and their usage. If nothing is displayed, it means there is no active swap space.

Another option is to use the `free` command with the `-h` option, which provides a human-readable summary of memory usage, including swap space.

### Heap size
The Node.js heap size is the memory allocated for storing data in an application. You typically don't need to change the default size, but you might increase it if your app needs more memory due to lots of data or for performance reasons. You can adjust it with the `--max-old-space-size` flag when running your app, but be cautious about using too much memory.

For example, if you wanted to increase the heap size to 4GB, you would start SymBot like this:

`node --max-old-space-size=4096 symbot.js`

Or if using pm2, your ecosystem.config.js file might look something like this:

```
module.exports = {

	apps: [
			{
				name: 'symbot',
				namespace: 'symbot',
				script: '/home/symbot/symbot.js',
				kill_timeout: 8000,
				max_memory_restart: '4000M',
				node_args: '--max_old_space_size=4096'
			}
		  ]
}
```

### Security

Securing login access to your server matters: it keeps unauthorized people out, protecting your data and preventing your server from being misused as a launching point for attacks. Keeping the operating system updated and patched closes known weak points, so the steps below are worth doing before you expose SymBot to the internet.

To secure login access to Linux, Mac, and Windows servers, it's crucial to implement robust security measures tailored to each operating system. Below are some basic steps to consider for each type of server.

- **Linux**: Start by configuring SSH (Secure Shell) to use key-based authentication instead of passwords, and disable root login to prevent unauthorized access. Regularly update and patch the system to address any vulnerabilities. Additionally, implement firewall rules using tools like iptables to control incoming and outgoing traffic.

- **Mac**: Leverage OpenSSH for secure remote access. Similar to Linux, enforce key-based authentication and disable remote root login. Regularly update the operating system and applications through the App Store or command line. Utilize macOS's built-in firewall to restrict unauthorized access to specific services.

- **Windows**: Prioritize strong password policies. Regularly update the system through Windows Update and enable Windows Defender or a reputable antivirus solution. Use Group Policy to manage user access and permissions effectively. Additionally, consider implementing Network Level Authentication (NLA) for Remote Desktop Services to enhance security.

Across all three operating systems:

- Regularly monitor and audit login attempts and system logs, so you can detect and respond to suspicious activity promptly.
- Consider an intrusion detection system, and keep up with current security best practices.
- Review and update these measures periodically to keep the server secure and resilient.

#### Login attempt protection

SymBot automatically protects its web login against password-guessing (brute-force) attempts. Failed logins are tracked per source IP address: after several consecutive failures from the same address within a short window, that address is temporarily blocked from attempting to log in at all — the password is not even checked while a block is in effect. A successful login immediately clears the record for that address.

When enabled with Telegram (see [Telegram Setup](#telegram-setup)), SymBot notifies you of every login — successful or failed — and sends a distinct alert when an address crosses the threshold and is blocked, so an in-progress brute-force attempt is visible rather than silent.

This protection is on by default and requires no configuration. The tracking is held in memory only, so it adds no files and resets if SymBot restarts. Sensible defaults apply (a handful of failures triggers a block of several minutes), and they can be tuned by adding an optional `security.login_throttle` block to your `app.json` configuration:

- `max_failures` — consecutive failed logins from one address before it is blocked. Default is `5`.
- `window_ms` — rolling time window, in milliseconds, over which failures are counted; older failures are forgiven so occasional typos never accumulate. Default is `900000` (15 minutes).
- `block_ms` — how long, in milliseconds, an address stays blocked once the threshold is crossed. Default is `900000` (15 minutes).
- `max_tracked_ips` — maximum number of addresses tracked at once, to bound memory under a distributed attack; oldest entries are evicted first. Default is `5000`.

Note that this protects the SymBot login specifically. It complements — and does not replace — the operating-system and network measures described above, and any protection provided by a reverse proxy or firewall in front of SymBot.

Because the protection works per source IP address, it assumes SymBot sees the real client address. When running behind a reverse proxy (the recommended setup — see [Reverse Proxy Setup](#reverse-proxy-setup)), SymBot honors the `X-Forwarded-For` / `CF-Connecting-IP` headers your proxy sets, which is correct. If instead SymBot is exposed directly to the internet without a trusted proxy, those headers can be forged. A client could then make each attempt appear to come from a different address, diluting the per-IP throttle. This is inherent to any IP-based protection; running behind a properly configured reverse proxy (and not forwarding those headers from untrusted sources) is the recommended way to keep the client address trustworthy.

For a direct-to-internet deployment, add `"security": { "trust_proxy": false }` to your `app.json`. SymBot then ignores the client-supplied forwarding headers and uses the real socket address everywhere it identifies a client. That covers the login throttle, the login IP filter, the server-wide IP filter, and per-key IP filters, so a forged `X-Forwarded-For` cannot spoof any of them. Leave it unset (the default) when a trusted proxy sits in front of SymBot, so the real client address from the proxy is used.

#### IP Access Control (allow / block lists)

Beyond the automatic brute-force throttle, SymBot can restrict access by source IP address at three independent layers, each optional and off by default:

1. **Server-wide** — a built-in firewall applied to *every* request before authentication (set on the Configuration page under *IP Access Control*, or the Hub config for the Hub).
2. **Login** — restricts who can sign in to the web UI (also on the Configuration page).
3. **Per API key** — each scoped key (and therefore each webhook using it) carries its own allow/block list, set when you create the key or via the IP action on the key in **Access Control → API Keys**. A per-key list only ever affects that key.

**Rule format.** One rule per line, in any of these forms: an exact address (`203.0.113.10` or an IPv6 address), a subnet in CIDR notation (`10.0.0.0/8`, `2001:db8::/32`), or a friendly IPv4 wildcard / partial (`192.168.1.*`, `192.168.`, `10.*`). A blocklist always wins over an allowlist, and an empty allowlist means "allow any" (still subject to the blocklist). Invalid entries are dropped automatically when you save. Both IPv4 and IPv6 are supported, and the client address is read proxy-aware (`X-Forwarded-For` / `CF-Connecting-IP`), so the lists work correctly behind NGINX, Apache, or Cloudflare.

**You cannot lock yourself out.** These safeguards are built in:

- **Loopback is always exempt** at the server-wide and login layers — a request from the machine itself (`127.0.0.1` / `::1`) is always allowed, even if your allowlist would exclude it, so local and SSH-tunnelled access always works.
- The Configuration page shows your current IP address and offers a one-click "Add to allowlists" button so you include yourself before saving.
- A per-key list can never affect your own UI access — only that key.
- If you ever do lock the web UI out with a bad rule, the console command clears both server-wide and login filters (your lists are preserved, just disabled) so you can correct them:

```bash
npm start reset ipfilter
```

A per-key IP filter is the recommended way to lock a webhook / signal source to the IP range it sends from (for example, restrict a TradingView-driven key to TradingView's published webhook address ranges) — see [Webhooks](#webhooks). As always, IP filtering complements, and does not replace, a reverse proxy or OS/network firewall in front of SymBot.

> **Trusting the client address.** Every IP layer here relies on SymBot seeing the *real* client address. Behind a reverse proxy (the recommended setup) SymBot reads it from the `X-Forwarded-For` / `CF-Connecting-IP` header your proxy sets, and your proxy must be configured to overwrite that header (e.g. NGINX `proxy_set_header X-Forwarded-For $remote_addr`) rather than append to a client-supplied one. If SymBot is instead exposed directly to the internet with no trusted proxy, those headers can be forged — a client could set `X-Forwarded-For` to an allowlisted address to bypass the filter. In that deployment, set `security.trust_proxy: false` in `app.json`, which makes SymBot ignore the forwarding headers and use the real socket address for the IP filters, the login filter, and the login throttle. This is the same setting described under [Login attempt protection](#login-attempt-protection).

#### Logs and sharing them safely

SymBot writes logs to three places: the console, dated files under each instance's own data folder (`data/instances/<server_id>/logs/`), and a live stream in the web interface (Logs in the navigation). Because people often need to share a log to get help, every log line is automatically scrubbed of credentials before it is written to any of them.

The scrubbing is central — it runs inside the single logging function every subsystem uses, so nothing can bypass it. It removes values by both shape and field name: SymBot API keys (the secret half only — the short non-secret prefix is kept so you can still tell keys apart), passwords and passphrases, exchange secrets, bearer tokens, Telegram bot tokens, and any credential embedded in a URL (a `user:pass@host`, or a `?token=…` on a notification webhook). Each becomes `[REDACTED]`. Ordinary content — prices, deal and bot IDs, error messages — is left untouched.

As a backstop, the boot-time [self-policing watchdog](#audit-log) also samples the recent logs and warns (in the audit log) if any line still looks like it holds an unredacted credential — so a gap in the scrubbing surfaces immediately rather than sitting unnoticed in a log you might share. The warning names the *shape* it found and the line count only; it never repeats the value.

One value is shown but never stored: on a brand-new install SymBot prints an auto-generated API key to the console once so you can copy it. That console line is deliberately kept out of the log file and the web stream — save it then, or generate a scoped key under **Access Control → API Keys**.

When you download a log or a backup from the web interface, it is saved with its instance's display name in front (for example `My-Bot-2025-01-31.log`), so a file keeps track of which instance it came from once it leaves SymBot — the on-disk name is left unchanged. Under SymBot Hub, the Logs and Backups pages also show a short **Instances in this list** legend that maps each instance's display name to its internal identity, so you can tell which instance any file — or any internally-named off-site backup subfolder — belongs to.

To share a log for support:

- Copy from the web Logs view (or send the dated file from the instance's `data/instances/<server_id>/logs/` folder) — it is already scrubbed.
- Do not send your `config/` files. Those legitimately hold your credentials (encrypted at rest, but still sensitive); logs are safe to share, config files are not.
- To be certain, search the log for your own known values (your exchange key, your webhook token) before sending — you should find `[REDACTED]` wherever they would have appeared.

To self-diagnose first: the Logs view streams live activity, the System Health card shows memory, uptime, deal count and CPU load, and — if AI is configured — you can ask the chat questions like *"were there any errors in the last hour?"*, *"why did this deal pause?"*, or *"how long has SymBot been running?"*. Its log-analysis and status tools read the same (already-scrubbed) logs and live health figures and summarize what happened.

## Reverse Proxy Setup

A reverse proxy is a special type of web server that receives requests, forwards them to another web server somewhere else, receives a reply, and forwards the reply to the original requester. Although there are many reasons to use a reverse proxy, they are generally used to help increase performance, security, and reliability. Two popular open-source software packages that can act as a reverse proxy are [Apache](https://apache.org) and [NGINX](https://nginx.org).

This is how requests will work when using a reverse proxy in front of SymBot:

***User*** <---> ***Reverse Proxy (Port 80)*** <---> ***SymBot (Port 3000)***

There are many different ways to set up either Apache or NGINX as a reverse proxy that can be used in front of SymBot, so this is just a basic guide. You may need to change configuration parameters depending on your operating system, version of these software packages, or if you're already running one of them on your system (server). The commands described here will also vary depending on your operating system.

If setting up a reverse proxy seems too advanced, a great alternative is to use a [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/) instead. This can also automatically encrypt all of your traffic without installing any additional SSL certificates on your web server and system.

### Apache

1. Update the apt-get package lists with the following command:
```
sudo apt-get update
```

2. Install Apache:
```
sudo apt-get install apache2
```

3. **Debian based systems (Ubuntu, etc.):** enable the Proxy and Rewrite modules with a single command, then skip to step 4:
```
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite
```

   **Redhat based systems (CentOS, Fedora, etc.):** open the Apache modules configuration file instead:
```
sudo nano /etc/httpd/conf.modules.d/00-proxy.conf
```
   and add or uncomment the below lines:
```
LoadModule proxy_module modules/mod_proxy.so
LoadModule proxy_http_module modules/mod_proxy_http.so
LoadModule proxy_wstunnel_module modules/mod_proxy_wstunnel.so
LoadModule rewrite_module modules/mod_rewrite.so
```

4. Create a virtual host configuration file for your domain:
```
# Debian based systems
sudo nano /etc/apache2/sites-available/your-domain-name.com.conf

# Redhat based systems
sudo nano /etc/httpd/conf.d/your-domain-name.com.conf
```

5. Add the below configuration block and save:
```
<VirtualHost *:80>
	ServerName your-domain-name.com
	ServerAlias www.your-domain-name.com
	ServerAdmin webmaster@your-domain-name.com

	LimitRequestBody 272629760

	RewriteEngine on
	RewriteCond %{HTTP:Upgrade} websocket [NC]
	RewriteCond %{HTTP:Connection} upgrade [NC]
	RewriteRule ^/?(.*) "ws://127.0.0.1:3000/$1" [P,L]

	ProxyPass / http://127.0.0.1:3000/
	ProxyPassReverse / http://127.0.0.1:3000/
	ProxyRequests off
</VirtualHost>
```
6. Restart Apache:
```
# Debian based systems
sudo a2ensite your-domain-name.com
sudo systemctl restart apache2

# Redhat based systems
sudo systemctl restart httpd
```

You should now be able to access SymBot by opening your web browser to http://your-domain-name.com

**Note:** The `LimitRequestBody` directive may be required depending on your Apache distribution. Some distributions set a restrictive default that will block system backup restores and AI Chat file attachments. The value `272629760` equals 260 MB — enough to cover SymBot's 250 MB backup restore limit and 25 MB AI Chat attachment limit.


### NGINX

1. Update the apt-get package lists with the following command:
```
sudo apt-get update
```

2. Install NGINX:
```
sudo apt-get install nginx
```

3. Open the default server block configuration file for editing:
```
sudo nano /etc/nginx/sites-available/default
```

4. Add the below configuration block and save:
```
server {
	listen 80;

	server_name your-domain-name.com;

	location / {
				client_max_body_size 260m;
				proxy_pass http://127.0.0.1:3000;
				proxy_http_version 1.1;
				proxy_set_header Upgrade $http_upgrade;
				proxy_set_header Connection 'upgrade';
				proxy_set_header Host $host;
				proxy_cache_bypass $http_upgrade;
	}
}
```

**Note:** The `client_max_body_size` directive is required for SymBot to function correctly. NGINX defaults to 1 MB which will reject system backup restores and AI Chat file attachments. SymBot supports backup files up to 250 MB and AI Chat attachments up to 25 MB — set `client_max_body_size` to at least `260m` to cover both.

5. Restart NGINX:
```
sudo systemctl restart nginx
```

You should now be able to access SymBot by opening your web browser to http://your-domain-name.com


## Circuit Breaker

The circuit breaker is an automatic risk management feature that blocks new position-opening during sudden market-wide volatility, while allowing existing positions to close normally. Its tripped state is memory-only — no database writes occur, and if the breaker is active when SymBot restarts, that active state clears on startup. (The portfolio-loss trigger below is a partial exception: it re-reads its loss totals from the database, so a restart does not erase the losses it measures — only the breaker's active/blocked state itself starts clear.)

### How It Works

The circuit breaker monitors three independent triggers. Any one is sufficient to activate it:

**Deal ratio trigger** — if a configurable fraction of your active deals trigger safety orders within a rolling time window, the circuit breaker fires. For example with a threshold of 0.5 and 30-second window: if 3 out of 5 active deals all trigger safety orders within 30 seconds, that's a 60% ratio which exceeds the threshold. A minimum of 2 deals must trigger regardless of ratio to avoid false positives on small portfolios.

**Price drop trigger** — if the price of any individual pair drops by a configurable percentage within a rolling time window (tracked from the first safety order price seen for that pair), the circuit breaker fires.

**Portfolio loss trigger** — off by default (`portfolio_loss_enabled`). When enabled, if your *realized* loss over a rolling window (`loss_window_hours`, default 24h) reaches the configured `loss_limit`, the circuit breaker fires. The loss is measured from deals that actually sold and is read from the database, so it survives a restart, and it uses the worst single quote-currency net (a loss in one currency is never masked by profit in another). Canceled deals are excluded — a cancel keeps the coins and sells nothing, so its marked-to-market figure is unrealized and does not count toward this trigger. Set `loss_limit` to `0` to keep this trigger disabled.

### What Gets Blocked and What Passes Through

When active, the circuit breaker blocks position-opening but allows position-closing:

**Blocked:**

- Base orders (starting new deals) — no new positions open into a falling market
- Safety order buys — no averaging down during a drop
- Any deal-start request from any client (3CQS signals, manual API calls, webhooks, or any future integration) — enforcement is in the core deal-start gate so no client needs to implement its own circuit breaker logic. The API response includes a clear reason: `"Circuit Breaker Active: <reason>"` so callers can distinguish a CB block from other failures and retry after the pause window expires.

> **Important for integration builders:** When the circuit breaker is active, a `start_deal` request is rejected before the deal is created. The base order is not queued for later — the request must be retried after the circuit breaker clears. If your integration (e.g. TradingView alert) is price-sensitive, check `circuit_breaker_active` in the API response before assuming a deal will open at the intended price. The circuit breaker clears automatically after `pause_duration_secs` (default 60s) or can be cleared manually via the UI.

**Always allowed through:**

- Take profit sells — if a volatility spike pushes a pair above its target, the deal closes normally
- Panic sells — manual emergency closes always execute regardless of circuit breaker state. (The one exception is unrelated to the circuit breaker: while the exchange price feed is unreliable, a panic sell is briefly *held* rather than executed on an untrusted price — see [Price Feed Sanity Guards](#price-feed-sanity-guards) below.)
- Deal cancels — manual cancels always execute
- `BOT_STOP` signals from 3CQS — protective close/cancel signals are never blocked
- The UI and API — full access to view deals, make manual changes, and clear the circuit breaker at any time

### Auto-Resume

The circuit breaker auto-clears after `pause_duration_secs`. Because each deal runs on its own independent timer, they naturally resume in a staggered fashion rather than all simultaneously — no burst of orders at resume time.

### UI Banner

When the circuit breaker activates, an amber warning banner appears at the top of the Active Deals page showing the reason (e.g. *"Deal ratio: 3/5 deals triggered safety orders within 30s"*) and a live countdown to auto-resume. A Clear button allows manual dismissal.

### Telegram Notifications

The circuit breaker sends Telegram alerts at key events:

**On activation** — sent immediately when the circuit breaker fires, including:
- The trigger reason (deal ratio, price drop, or portfolio loss, with specific values)
- Top affected pairs and how many times each triggered within the window (e.g. *PEPE/USD (8), RSR/USD (3)*)
- How long buys will be paused

**On repeat activation** — if the circuit breaker fires more than once within the `repeat_alert_window_secs` window (default 1 hour), the alert is elevated with a 🚨 prefix and includes how many minutes elapsed since the last activation. This is a signal that market conditions may be deteriorating beyond a single event.

**On auto-clear** — sent when the pause duration expires and normal processing resumes.

**On manual clear** — sent when a user clears the circuit breaker via the UI or API.

**On consecutive Invalid Price: 0** — if the exchange returns a price of 0 for the same deal `price_zero_alert_count` consecutive times (default 4), a Telegram alert is sent naming the pair and deal ID. The counter resets after the alert and also resets whenever a valid price is received for that deal.

**On consecutive implausible price** — if a deal receives an implausible (nonzero but out-of-band) price `price_implausible_alert_count` consecutive times (default 4), a Telegram alert is sent naming the pair and deal ID, noting the deal is being held rather than closed. See [Price Feed Sanity Guards](#price-feed-sanity-guards).

**On a held panic sell / cancel** — if a pending panic sell or cancel cannot execute because the price feed is unreliable, a safety alert is sent after `close_held_alert_count` held ticks (default 15) and periodically thereafter. Unlike the other alerts here, this one is not gated on the circuit breaker being enabled, because it concerns a stuck emergency action rather than a circuit-breaker event.

### Price Feed Sanity Guards

Separately from the volatility triggers above, SymBot guards against a corrupt price feed. During an exchange authentication or connectivity disruption, a ticker read can come back *nonzero but wildly wrong* (for example a price returned tens or thousands of times its real value). Left unchecked, such a price crosses a deal's take-profit target and closes the deal at an impossible profit.

Two guards prevent this, both fail-safe (they hold a deal rather than act on a suspect price — holding a position never loses money, acting on a garbage price can):

- **Zero / invalid price** — a price of 0, blank, or non-numeric is rejected. The deal is held and, after `price_zero_alert_count` consecutive events, an alert is sent.
- **Implausible price** — a nonzero price is compared against the deal's own DCA average (its known-good anchor). A price more than `price_deviation_high_ratio`× above the average (default 2×) or more than `price_deviation_low_ratio`× below it (default 10×) is rejected as implausible. The deal is held — no profit is computed against the price, and no buy or sell is placed on it — so it cannot be auto-closed at a fabricated profit. This applies both to the automatic take-profit path and to the Signal Bot graceful `close` command. Normal operation is unaffected: a legitimate take-profit sits far inside the band, and a deeply averaged-down deal stays within the generous low-side band.

While a price is untrusted (either guard tripping, or the exchange returning an error with no price), a pending panic sell or cancel is held rather than executed — it is never recorded as closed at a price that was never actually traded. Because the panic/cancel request persists on the deal, it completes automatically on the next tick once a valid price returns, at the real market price. If it stays stuck (for example a revoked API key), an alert is sent after `close_held_alert_count` held ticks.

The band ratios are configurable. If you run very high take-profit percentages, raise `price_deviation_high_ratio` above your largest take-profit multiple (e.g. a take-profit of 100% means a deal legitimately reaches 2× its average, so a ratio of `2` is the minimum that will not hold it).

### Configuration

Most circuit breaker settings are configurable in **Configuration → Circuit Breaker** and take effect immediately without restarting SymBot; they are stored in `config/app.json` under the `circuit_breaker` key. Four advanced tuning keys — `price_deviation_high_ratio`, `price_deviation_low_ratio`, `price_implausible_alert_count`, and `close_held_alert_count` (the last four rows below) — are **not** shown in that screen and are not present in the shipped default file; set them by hand-editing `config/app.json`, where they take effect on the next restart (they fall back to sensible built-in defaults when absent).

| Setting | Description | Default |
|---------|-------------|----------|
| `enabled` | Master switch for the circuit breaker (the deal-ratio and price-drop triggers) | `true` |
| `deal_ratio_threshold` | Fraction of active deals that must trigger safety orders within the window | `0.5` |
| `deal_ratio_window_secs` | Rolling window in seconds for counting simultaneous safety order triggers | `30` |
| `price_drop_percent` | Price drop % within the window for a single pair that triggers the CB | `5.0` |
| `price_drop_window_secs` | Rolling window in seconds for measuring price drops per pair | `60` |
| `pause_duration_secs` | How long in seconds to block new buys when activated | `60` |
| `price_drop_enabled` | Enable or disable the price drop trigger. When `false`, only the deal ratio trigger is active | `true` |
| `portfolio_loss_enabled` | Enable the portfolio-loss trigger. When `false`, realized loss is never evaluated | `false` |
| `loss_window_hours` | Rolling window in hours over which realized loss is summed for the portfolio-loss trigger | `24` |
| `loss_limit` | Realized loss (in quote currency, worst single currency) that fires the portfolio-loss trigger. `0` keeps the trigger disabled even when enabled | `0` |
| `repeat_alert_window_secs` | Window in seconds for detecting repeat CB activations and sending an elevated alert | `3600` |
| `price_zero_alert_count` | Consecutive zero-price events before a Telegram alert is sent for that deal | `4` |
| `price_deviation_high_ratio` | Reject a fetched price more than this multiple above a deal's DCA average as implausible (must exceed your largest take-profit multiple) | `2` |
| `price_deviation_low_ratio` | Reject a fetched price more than this multiple below a deal's DCA average | `10` |
| `price_implausible_alert_count` | Consecutive implausible-price events before a Telegram alert is sent for that deal | `4` |
| `close_held_alert_count` | Consecutive held ticks for a pending panic sell / cancel before a safety alert is sent (not gated on the circuit breaker) | `15` |

## Deal Health Indicator

The Active Deals view has a Health column (the first column) showing a small glyph for each deal, giving you an at-a-glance read on how it's doing without scanning the numbers. It is derived entirely from the deal's live state — you don't set it. Hovering over the glyph shows a short description of why it's in that state, and you can sort by the Health column to bring the deals that need attention to the top. The same Health column appears in the Hub's combined Active Deals view, so you get the same at-a-glance read across every instance at once.

A deal is "underwater" when its current price is below your average buy price — it is showing a paper (not yet realized) loss; "drawdown" is how far below that average the price has fallen.

| Glyph | Meaning |
|-------|---------|
| 🟢 | In profit — the deal is currently above its break-even point |
| 🟡 | Slightly underwater, with few or no safety orders used yet |
| 🟠 | Underwater and working through its safety orders (roughly 40%+ used) |
| 🔴 | Deep drawdown — most of the safety-order budget is consumed (roughly 75%+ used) |
| ⏸️ | Paused (manually or automatically) |
| ⚠️ | In an error state — check the logs |
| ⚪ | Connecting — the deal has resumed but its live figures haven't arrived yet (see below) |

The thresholds are based on how far the deal has drawn down and how much of its configured safety-order budget it has consumed, so a deal that's down a little with plenty of safety orders left reads very differently from one that's down and nearly out of room. Error and paused states take precedence over the profit/drawdown glyphs. Sorting the column orders deals by how much attention they need, so 🔴 / ⚠️ / ⏸️ deals rise to the top.

When SymBot restarts, your open deals are shown **immediately** with everything already known from their saved state — pair, deal count, safety orders used, average entry, and take-profit target — while the live-only figures (current price and profit) briefly read "updating…" and the Health dot is a neutral gray ⚪ until the first live price arrives from the exchange. This first price can take a few seconds longer if the exchange connection is slow to come up on a cold restart. The deals are never hidden while this happens, and no stale or placeholder profit number is ever shown as if it were live — the live cells fill in on their own the moment the price is available. This applies to both the instance view and the Hub's combined Active Deals view.


## Deal Chart

Click any pair in an active deals table — on an instance or in the Hub — to open a chart for that deal. The window has two tabs: a Deal tab (shown first) and a TradingView tab.

The Deal tab draws a candlestick chart of the pair with the deal's own levels drawn on top of it: every safety order in the ladder (filled orders as solid lines, still-pending orders as dashed), the average entry price, the take-profit target, and a marker on each fill. A facts row beneath the chart shows the average entry, take-profit, current price, and how many safety orders have been used, so you can see at a glance where the deal sits relative to where it fills and where it closes. You can zoom and pan the chart with the mouse wheel and drag, the same as a normal trading chart.

Pick the candle interval from the dropdown — the choices follow what your exchange actually offers — toggle the chart between light and dark independently of the app theme, or use Popout to open the same chart with all its controls in its own window. Both spot and futures / perpetual (swap) pairs are supported; the deal's own market type is used automatically. If your exchange does not provide candle data, the chart falls back to a simple line built from your order fills so you still see the ladder in context. Your last tab, interval, and light/dark choice are remembered in your browser.

The candles come from a read-only public market-data feed (no API keys, and entirely separate from the connection your bots trade on), so opening a chart never touches or interferes with trading. The TradingView tab keeps the full third-party TradingView widget for the same symbol, so you can still change symbols, add indicators, and use its own tools.

## Stop-Loss

Each DCA bot can run an optional stop-loss that closes a deal at market when the price falls to a defined level — a safety backstop for a deal that has run out of safety-order room. It is disabled by default, so nothing changes for an existing bot unless you turn it on.

Settings appear on the bot's create/update form (and can be changed per-deal — see below):

| Setting | What it does |
|---------|--------------|
| **Stop-Loss** | Enable or disable the stop-loss. |
| **Stop-Loss %** | How far below the reference price the stop sits. Set this *below* your full safety-order ladder so the stop acts as a backstop rather than firing before the bot finishes averaging down. |
| **Stop-Loss Reference** | What the % is measured from — the deal's **DCA Average** (moves down with the position as safety orders fill) or the **Last Safety Order** price (a fixed backstop below the deepest order). |
| **Move To Breakeven** | Once the deal reaches the Breakeven Trigger profit, ratchet the stop up to the break-even price (entry plus fees) so a winning deal cannot turn back into a loss. The stop only ever moves up, never down. |
| **Breakeven Trigger %** | The live net profit % at which the stop moves to break-even (only used when Move To Breakeven is on). |

**It never fires on a bad price feed.** The stop-loss is gated by the same price-plausibility check as the rest of the engine (see [Price Feed Sanity Guards](#price-feed-sanity-guards)), so an implausible or unreliable exchange price *holds* the deal instead of dumping it at a false low. An explicit panic sell or cancel always takes precedence.

**Changing a running deal.** A deal keeps the configuration it opened with, so editing a bot never changes deals that are already running — this is intentional. To change the stop-loss on an active deal, use the Edit action on that deal in the Active Deals view; the stop-loss settings are on the deal-edit form and take effect on the next price check without interrupting the deal. Reconfiguring a deal's stop-loss resets any break-even ratchet so the new settings apply from scratch.

**On the deal row.** When a stop-loss is active, the Active Deals view (and the Hub's combined view) shows the effective stop level beneath the Target price, with a 🔒 once the stop has moved to break-even.

### Trailing Stop

A trailing stop takes the same idea further: once the deal reaches a configured profit, it follows the price up and then closes on a pullback from the peak — used to let a winner run instead of capping it at the fixed Target Profit. It is also disabled by default.

| Setting | What it does |
|---------|--------------|
| **Trailing Stop** | Enable or disable the trailing stop (works on its own or alongside the hard stop-loss). |
| **Trailing Distance %** | How far below the running price peak the stop trails. Smaller locks in more of the gain but exits on smaller pullbacks; larger gives the price more room. |
| **Trailing Activation Profit %** | The live net profit % at which the trailing stop activates and starts tracking the peak. Below this, the deal behaves normally. |
| **Trailing Rides Past Take-Profit** | When enabled (default), an active trailing stop overrides the fixed Target Profit so the deal can ride an extended run-up and exit on the pullback. When disabled, the deal still closes at Target Profit and the trailing stop only protects the way there. |

Like the stop-loss, it never fires on an unreliable price feed, it can be changed on a running deal from the Edit action, and the stop only ever ratchets up. On the deal row an active trailing stop shows its level beneath the Target price marked with a ▲.


## Add Funds Estimator

The Active Deals view has an Add Funds Estimator — a what-if tool for seeing how adding funds to your open deals would affect each one, *before* you actually add anything. Open it from the toolbar and enter an amount; the estimator shows, inline on every deal row, where that add would move the deal's key numbers. It is purely a projection — nothing is bought and no deal is changed until you use the actual Add Funds action on a deal.

### What it shows

For each open deal, once you enter an amount the estimator adds a projection beneath three columns:

| Column | Projection |
|--------|-----------|
| **Price** | The new average entry price the deal would have after the add (shown as `→ avg <price>`). |
| **Price Target** | The new take-profit target price, with the reduction from the current target in parentheses (e.g. `→ <price> (-4.07%)`). A lower target is easier to reach, so a larger reduction is generally better. |
| **Profit %** | The projected current profit % the deal would show after the add, with the change from its current profit in parentheses (e.g. `→ -2.78% (+3.98%)`). A positive change means the add improves the deal's standing. |

The projected profit is always evaluated at the deal's current market price — it answers "if I added these funds, what would my live profit % become right now," not what you'd make at target (that figure is the separate Profit ≈ column, which is unaffected by an add).

### Testing a different fill price

By default the estimator assumes the add fills at the current market price. To test a specific price instead, click a deal's Price cell while the estimator is open — a small fill-price field appears for that row. Enter a price and all three projections for that deal recompute against it (the average shows a `@ <price>` tag so you can see which price is in effect). This lets you answer questions like "what if I add on a dip to $0.085 instead of at the current $0.095" — a lower fill price buys more of the asset, pulls the average down further, and improves the projected profit and target accordingly. Clear the field (or close the estimator) to return to the market-price assumption.

### Accuracy

The projected profit % is computed to reconcile exactly with the deal's live Profit % column: it uses the deal's real average cost basis and the same fee and slippage the running profit calculation applies. So at the current market price with no change, it reproduces the deal's current profit exactly. Because the projection also accounts for the exchange fee on the added purchase, the average and target it shows are net figures, consistent with how the deal's real numbers are maintained.


## Portfolio Summary Bar

The Active Deals view includes a live portfolio summary bar displayed below the deal statistics. It gives you an at-a-glance view of your overall account position without needing to navigate to the dashboard.

### What It Shows

| Field | Description |
|-------|-------------|
| **Portfolio** | Total free balance across all configured account balance currencies (e.g. USD, USDT, USDC) |
| **Max Funds** | Total worst-case capital commitment if all safety orders on all active deals were to fire simultaneously |
| **Risk %** | Max Funds as a percentage of total portfolio. Color coded: green below 70%, amber 70–89%, red 90%+ |
| **Balance** | How long ago the exchange balance was last fetched |

### Balance Caching

Exchange balance is fetched once per minute in the background and cached — the summary bar reads from the cache rather than calling the exchange on every refresh. This means the balance shown may be up to 60 seconds old, which is reflected by the Balance: Xm ago indicator. The cache is primed immediately at startup so the bar is populated on first load.

If the exchange is temporarily unreachable (for example a Coinbase outage, the same condition that can delay deals appearing on a restart), the balance fetch can fail. When that happens SymBot keeps your **last-known** balance rather than replacing it with zero, and marks it: the Balance indicator reads `Balance: Xm ago (updating…)` while it keeps retrying in the background. If no balance has ever been fetched yet (a fresh start during an outage), Portfolio and Risk simply read `updating…` instead of a misleading `$0.00` / `N/A`. This is display-only — an unavailable balance never affects trading, and in particular it does **not** affect the [portfolio-loss circuit-breaker trigger](#circuit-breaker), which is calculated from realized losses of closed deals in the database, never from the live balance figure.

### Sandbox Mode

When running in sandbox (paper trading) mode, the portfolio total is taken from the Sandbox Wallet value configured in **Configuration → Exchange** rather than a live exchange balance. The balance age indicator shows Sandbox instead of a timestamp.

### Risk % Color Coding

| Color | Range | Meaning |
|--------|-------|---------|
| 🟢 Green | Below 70% | Comfortable headroom — plenty of capital available |
| 🟡 Amber | 70–89% | Most capital committed — monitor closely |
| 🔴 Red | 90%+ | Near or over-extended — limited room for new safety orders |

A Risk % above 100% means your configured Max Funds across all bots exceeds your available balance. This does not mean anything is broken — it reflects the theoretical worst case if every safety order on every active deal fired at once, which is unlikely. It is a useful prompt to review your position sizing.

### Configuration

The currencies shown in the Portfolio total are the same ones configured in **Configuration → Exchange Settings → Order Settings** under Balance Currencies. These are stored in `config/app.json` under `bots.exchange.default.account_balance_currencies`.


## Transaction Export

SymBot can export your closed deals as a per-transaction CSV file that you can import into popular cryptocurrency tax software such as Koinly, CoinTracker, or CoinLedger. You'll find it in the sidebar under **Tools & Settings → Transaction Export**.

This is different from the CSV download on the Deals History page: that file has one row per deal (a summary of each completed deal's performance), whereas Transaction Export writes one row per individual buy and sell. Use Deals History to review how your deals performed, and Transaction Export when you need a per-transaction file for tax software.

Each buy (base order and every safety order) and each sell is written as its own transaction row, including the exchange fees SymBot recorded for that order, in the widely supported "Universal" column format these tools expect (Date, Sent, Received, Fee, and so on). Dates are written in UTC.

**How to use it:**

- Leave the Closed from and Closed to dates empty to export every closed deal (recommended — let your tax tool sort transactions into tax years), or set a range to pull the deals that closed within it. The range filters by each deal's close date; a deal's earlier buy orders are always included so your tax software can match every sale to the purchases that built it, so you may see some transaction dates earlier than your start date.
- Optionally choose a single Bot to limit the export to that bot's deals only.
- Tick Include sandbox deals if you want paper-trading deals included. By default they are excluded, since they are not real transactions — so if you run only sandbox deals and get an empty file, this is why.
- Click Download CSV. The file is named after your instance so exports from multiple instances stay distinct.

**Important — please read:**

This is a convenience feature, not a tax report. SymBot exports the transactions it executed on this account; it does not calculate your taxes, gains, or cost basis. Your tax software does that, using your complete account history.

Cryptocurrency tax rules differ from country to country and change over time — including how cost basis is calculated, whether holdings are tracked per-wallet or pooled, and what counts as a taxable event. SymBot only sees its own deals, not everything in your exchange account (manual trades, transfers, deposits, or activity from other tools), so it deliberately exports raw transactions and leaves all tax calculations to software built for your jurisdiction.

Because of this, the export may be incomplete for your overall tax picture, and if you also connect the same exchange to your tax software directly (for example by API), you should not import both or your transactions will be counted twice.

SymBot and this export do not constitute tax advice. Always review your transactions and have your tax return prepared or reviewed by a qualified tax professional in your country. See also the [Disclaimer](#disclaimer).

> **Note:** Exports covering a very large number of deals may take a little time to generate and can briefly affect system performance while running.


## System Health

The System Tools page shows a System Health card with an at-a-glance readout of the running instance:

- The core figures — memory usage, uptime, active deal count, and CPU load — plus host memory, the SymBot version, and the process ID.
- **Load** shown as a percentage of the machine's CPU cores (50% means the box is working at half its core capacity), color-coded green/amber/red as it rises, matching the Risk % convention used elsewhere.
- A sub-line with the raw 1-/5-/15-minute load averages and the core count (on platforms that don't report load, such as Windows, it shows just the core count).

A compact version of the same information (uptime, memory, active deals, and load) also appears on the instance home page. Both refresh automatically every 30 seconds.

The memory figure is reported accurately for how the instance is running. When SymBot runs standalone (its own process), the card shows real process memory (RSS). When an instance runs as a Hub worker (several instances share one process), RSS is process-wide and cannot be attributed to a single instance, so the card instead shows the memory genuinely attributable to that instance (heap + external + array buffers) and clearly notes that the process RSS is shared. This mirrors how the Hub dashboard attributes per-instance memory, so the number is never misleading in either mode.

The same data is available over the API at `GET /api/system/health` (see the API section).


## Trading Journal

The Trading Journal turns your completed deals into a running record with no manual bookkeeping. Every closed deal automatically becomes a journal entry showing the pair, its deal ID (so multiple deals on the same pair are easy to tell apart and reference), the bot, when it closed, how long it ran, the profit (percent and amount), and how many safety orders were used — so the journal is useful the moment you open it, with nothing to fill in. In the rare case where a deal closed but could not sell its entire position (the market kept refusing the remainder after repeated attempts), the entry is flagged with a **Closed (partial)** badge naming the unsold amount, so that leftover is visible and you can reconcile it on the exchange rather than it going unnoticed.

For any entry you can add your own free-form notes (why you started it, what you'd do differently, anything worth remembering), which are saved with that deal. You can filter the journal by bot and by date range.

If you have AI enabled (see [Artificial Intelligence (AI)](#artificial-intelligence-ai)), each entry also offers a Generate AI reflection button that writes a short, factual summary of how the deal went based on the deal's own data. The reflection is saved with the entry and can be regenerated at any time. When AI is not enabled, the journal works exactly the same minus that button.

**At-a-glance stats.** Above the entries, a summary strip reflects every deal matching your current bot/date filter (not just the visible page):

- Total deals, and win rate (with the win/loss split).
- Total realized profit/loss.
- Average hold time.
- Your current win-or-loss streak.
- Your best and worst deals by percentage.

These use the same definitions as the dashboard — a "win" is any deal closed in profit — so the numbers line up with what you see elsewhere. While the figures are being computed a brief Processing deal data… indicator is shown in place of the strip, so it's clear they are still being worked out rather than appearing to jump in. Computed figures are cached briefly per filter, so returning to a filter you've already viewed shows them right away (tagging a deal's mood refreshes them).

When an instance trades in more than one quote currency, the profit figures — on both the dashboard and the journal — are broken out per currency rather than summed into one meaningless mixed-currency total; with a single quote currency you see one figure as before, shown with its currency symbol.

**Mood tagging and the mood-vs-outcome view.** Each entry lets you tag how the deal went with a single mood — planned 🎯, confident 😌, neutral 😐, anxious 😰, or gambled 🎲 (tap the tag again to clear it). Once you've tagged some deals, a Mood vs. outcome panel shows the win rate and average profit for each mood, so you can see how your own state of mind lines up with your results — often the most useful thing a trading journal can show you. The panel is deliberately observational: it reports what happened and shows the sample size next to each mood, and it does not tell you what to do or imply that a small sample proves anything.

The journal loads the most recent entries first, a page at a time. If you have more history than the current page, a Load more button appears at the bottom to pull in the next page — so accounts with a long history of closed deals stay fast and don't load everything at once.

**Export.** An Export CSV button downloads the deals currently in view — the same bot and date filter you have applied — as a one-row-per-deal summary (deal id, bot, pair, open and close time, duration, safety orders used, close price, and realized profit, with any unsold remainder). This is a plain deal-level record for your own spreadsheets, distinct from the tax-oriented [Transaction Export](#transaction-export) (which lists per-transaction buy/sell legs). It is also available over the API: `GET /api/deals/export/deals` (honoring the same `botId`, `from`, and `to` filters).

Your note and the AI reflection are managed independently. You can delete just the note (a Delete note button appears once a note is saved) or just the reflection (a small × on the reflection itself), each with its own confirmation. Deleting one leaves the other in place, and neither affects the underlying deal — the auto-generated entry always remains; only the piece you removed goes away.

Notes and AI reflections are stored with each deal, so they persist and appear alongside the auto-generated facts whenever you revisit the journal.

The journal is also available over the API: `GET /api/journal` (supports `botId`, `from`, `to`, `limit`, and `skip` query parameters for filtering and paging), `GET /api/journal/stats` (the summary + mood-vs-outcome figures for the same filter), `POST /api/journal/note`, `POST /api/journal/mood` (body: `dealId`, `mood` — one of the mood ids, or empty to clear), `POST /api/journal/narrative`, and `POST /api/journal/delete` (which takes a `part` of `note`, `narrative`, or `all`). See the API section for authentication details.


## Artificial Intelligence (AI)

### What is Artificial Intelligence?

Artificial Intelligence (AI) refers to machines designed to think and learn like humans. These systems use data and algorithms to recognize patterns, make decisions, and improve over time without needing human input. AI is found in everyday tools, such as voice assistants and website recommendations, as well as in complex fields like healthcare and finance. SymBot makes it easy to integrate this powerful technology, allowing you to analyze your trades with ease.

### How Can AI Help with Trading?

AI can be a big help in trading by analyzing market trends, predicting price movements, and automating trades. It looks at data like price changes, trading volumes, and news to help traders make smarter decisions. AI can also spot risks in deals, help automate buying or selling based on certain conditions, and even analyze the mood of the market using tools like sentiment analysis. Large Language Models (LLMs), a type of AI, can also process and understand large amounts of text data, such as news or social media, to help predict how the market might react to certain events. This makes trading easier and safer for regular people by offering insights and automating tasks.

SymBot makes it easy to analyze your trading deals. With just one click, it uses information from your existing orders and current pricing which the AI then processes, analyzing price trends and market conditions to predict potential outcomes. This helps you make smarter decisions about whether to continue, adjust, or pause your strategy.

### Supported AI Providers

SymBot supports two AI providers. Only one provider can be active at a time, selected from the Active Provider dropdown in the configuration screen. Selecting None disables AI features entirely.

| Provider | Best For |
|----------|----------|
| **Ollama** | Self-hosted or Ollama Cloud — full control, no usage costs |
| **OpenAI** | Hosted API — easy setup, compatible with any OpenAI-compatible endpoint |

The active provider and all its settings are saved in `config/app.json` under the `ai` section.

**Model fields are drop-downs.** Every model field on the configuration screen — the provider Model, the Deal Context Router Model, and the Deal Analysis Model — is a drop-down populated from the models the relevant provider actually reports. The provider Model fields query the host and key you have entered (so the list updates as you change them, and works with a remote Ollama or any OpenAI-compatible endpoint), while the Router and Analysis fields list the active provider's models. If a provider cannot be reached or does not support listing, the field falls back to a Custom / enter manually option so you can always type a name.

#### Choosing a model for your hardware

You choose which model runs — pick one that fits both your hardware and how you want to use the chat. The trade-off is straightforward:

- **Smaller models** (roughly 3B and under, e.g. `llama3.2:3b`, `qwen2.5:3b`) are faster and need far less RAM/VRAM, so they run on modest hardware. They handle plain chat and the Deal Context router well, but are less reliable at tool-calling — the [AI Tools](#ai-tools-experimental) feature, where the model calls read-only lookups itself.
- **Mid-size models** (`llama3.1:8b`, `qwen2.5:7b`/`14b`) are the sweet spot for AI Tools: on public function-calling benchmarks (e.g. the [Berkeley Function-Calling Leaderboard](https://gorilla.cs.berkeley.edu/leaderboard.html)) 7B-and-up tool-trained models are around the point where tool selection becomes dependable, while models under ~3B are not.
- **Larger / hosted models** give the best reasoning if you have the hardware or use a cloud provider.

Two practical rules:

1. **Tool-calling is a per-model capability.** Not every model can do it, and on Ollama it also depends on the model version, so `ollama pull` the latest. When Active Provider is Ollama and AI Tools is enabled, the Model field shows a live check: a green *"supports tool-calling"* confirmation, or an amber warning if the chosen model can't — in which case AI Tools automatically falls back to the Deal Context router.
2. **On limited hardware, you have a clean choice:** run a small, fast model with AI Tools off and let the Deal Context router assemble what the chat needs, or run a tool-capable 7B+ model to use AI Tools. Either way the chat works; only the lookup mechanism differs.

The Deal Analysis Model can be set independently, so you can keep a light model for everyday chat and point one-off deal analysis at a stronger model.

Each analysis report states its own data source at the end: when live OHLCV candle data is available from the exchange, the market-condition figures (Trend, RSI, Volatility, ATR, and the Market Score) are technical indicators computed directly from those candles; if the exchange returns too few candles, the report says so and those values are fallback estimates instead. This note is generated from the actual data used — not written by the model — so it is always accurate, and asking the chat afterward whether OHLCV was used returns the same authoritative answer.

---

### Ollama

Ollama is an open-source AI tool that runs Large Language Models locally or via cloud services. It can analyze text, make predictions, and provide insights based on the information it receives. Running Ollama locally keeps your trading data entirely on your own infrastructure.

#### Ollama Installation

Before installing Ollama locally, ensure your system meets the following requirements:

-   **Processor:** A multi-core CPU
-   **Memory:** At least 16 GB of RAM is recommended, especially for running large models.
-   **GPU:**
    -   For Macs, an Apple Silicon GPU is ideal.
    -   For other systems, an NVIDIA GPU with CUDA support is preferred.
    -   Models can also run on a CPU, but this may result in significantly slower performance.

1. Visit [Ollama's official website](https://ollama.com), download the installer for your operating system and follow the provided installation instructions.
	- **NOTE:** You do not need to install Ollama locally if you sign up and use Ollama Cloud services.
2. Download a model using the command: `ollama pull <model_name>`. For example: `ollama pull llama3.2`.
3. By default, Ollama runs on port 11434.
	- If you need to access Ollama remotely, you must configure it to listen on `0.0.0.0` instead of `localhost`.
4. If Ollama did not start automatically, start it using: `ollama serve`.
5. In SymBot's configuration, set the Active Provider to **Ollama** and enter the host URL and model name. For example: `http://127.0.0.1:11434` and `llama3.2`.

**Running on memory-constrained hardware?** Two optional Ollama server settings can roughly halve the memory the model's context uses, which is what makes SymBot's keep-alive (model-resident) behavior and a larger context window affordable on a small box: set `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0` in the environment where Ollama itself runs (not SymBot), then restart Ollama. These tune Ollama, not SymBot, and are safe to leave unset — they only help when RAM/VRAM is tight.

#### Ollama Configuration Fields

| Field | Description |
|-------|-------------|
| **Host** | URL to the server running Ollama. For local installs this is typically `http://127.0.0.1:11434`. For Ollama Cloud, use the provided endpoint URL. |
| **API Key** | Required only when using Ollama Cloud services. Leave blank for local installations. Enter it on the configuration screen — it is encrypted at rest and write-only (the field is blank on load; leave it blank to keep the saved key), and is re-encrypted automatically if the configuration password changes. Do not enter it directly into `app.json`. **To remove a saved key** — for example when switching from Ollama Cloud back to a local host that needs none — click the **[Clear]** link shown next to the field, then save; a blank field alone keeps the existing key, so clearing is the way to delete it. |
| **Model** | The model to use for analysis, e.g. `llama3.2`. Must already be pulled on your Ollama instance. |
| **Keep-alive** | Set in `app.json` (`ai.ollama.keep_alive`), not on the configuration screen. How long Ollama keeps the model loaded in memory after a request. Ollama unloads an idle model after about 5 minutes by default, so the next chat turn then pays a multi-second cold reload. SymBot defaults this to `30m` and preloads the model at startup, so chat stays fast between questions without keeping the model resident forever. Set a longer window like `1h`, or `-1` to keep it always loaded (uses more memory), or a shorter one to free memory sooner. |

---

### OpenAI

SymBot supports OpenAI's API as well as any OpenAI-compatible API endpoint, including self-hosted models that expose an OpenAI-compatible interface (such as LM Studio, Ollama's OpenAI-compatible endpoint, and various other providers).

#### OpenAI Setup

1. Sign up at [platform.openai.com](https://platform.openai.com) and generate an API key, or obtain an API key from your chosen OpenAI-compatible provider.
2. In SymBot's configuration, set the Active Provider to **OpenAI** and fill in the settings described below.

#### OpenAI Configuration Fields

| Field | Description |
|-------|-------------|
| **API Key** | Your OpenAI API key, or the API key provided by your compatible provider. It is encrypted at rest and write-only (the field is blank on load; leave it blank to keep the saved key), and is re-encrypted automatically if the configuration password changes. Do not enter it directly into `app.json`. |
| **Model** | The model to use, e.g. `gpt-4o` or `gpt-4o-mini`. |
| **Base URL** | Optional. Override the API endpoint for OpenAI-compatible providers. Leave blank to use the default OpenAI endpoint (`https://api.openai.com/v1`). Set this when using a self-hosted or third-party OpenAI-compatible service. |

---

### AI Configuration in app.json

The `ai` section of `config/app.json` stores all provider settings:

```json
"ai": {
    "provider": "ollama",
    "max_history": 25,
    "ollama": {
        "enabled": true,
        "host": "http://127.0.0.1:11434",
        "model": "llama3.2",
        "api_key": "",
        "keep_alive": "30m"
    },
    "openai": {
        "enabled": false,
        "api_key": "",
        "model": "gpt-4o",
        "base_url": ""
    },
    "generation": {
        "analysis_model": "",
        "chat_temperature": "",
        "max_tokens": "",
        "num_ctx": ""
    }
}
```

- `provider` is set automatically by the Active Provider dropdown and determines which provider SymBot starts on launch. Valid values are `ollama`, `openai`, or `none`.
- Only one provider can have `enabled` set to `true` at a time. The configuration screen enforces this automatically.
- The `generation` block is optional and every field may be left blank — see [AI Generation](#ai-generation) below.
- Changes to AI settings take effect immediately after saving — no restart required.

---

### AI Generation

The AI Generation section of the configuration screen fine-tunes how the AI produces text. Every field is optional; left blank, SymBot uses sensible built-in defaults, so existing installs are unaffected.

| Field | Description |
| --- | --- |
| **Deal Analysis Model** | An optional, usually stronger model for the heavier analytical write-ups — the ⚡ deal report, the expert-analysis tool the chat can consult, and a Deep analysis's final report — which make no tool calls, so a more capable model is worth it. Tool-driven research stays on your chat model (the credential that must support tool calling); only the concluding write-up switches to this one, and follow-up questions *within a deal-analysis conversation* stay on it too. Applies immediately on save (no restart); leave blank to use the default chat model. |
| **Chat Temperature** | Controls how varied chat replies are: `0` is focused and consistent, higher is more creative (range 0–2). Applies to chat only. Leave blank for the provider default. |
| **Max Response Tokens** | Caps the length of chat and deal-analysis replies. Leave blank for the provider default. |
| **Context Window** | The model's context-window size in tokens (`num_ctx`). Leave blank to use the provider default; set it when your model or hardware needs an explicit window so long conversations and tool results are not silently truncated. |

Every deal analysis ends with a small note showing which model produced it (for example *Analyzed with llama3.1:8b*), so you can compare models at a glance.

**Choosing a model — quality vs. speed.** A stronger model gives steadier, better-reasoned recommendations, especially on borderline deals where two choices are nearly tied. The trade-off is speed: large *local* models can be slow enough to hit the analysis timeout on a first (cold) run, whereas hosted or cloud models usually respond faster. If you plan to use a large local model, run it once to warm it up, or prefer a cloud model your provider offers.

**How accuracy is kept high automatically.** Independently of the settings above, SymBot applies fixed, deterministic decoding to the parts of the system where consistency matters most:

- **Deal analysis** runs at temperature 0, so its read of the same position is deterministic and does not swing between refreshes. All figures (position value, P&L, projected profit, scenario timings) are computed in code and handed to the model to state verbatim — the model interprets, it does not do the arithmetic. The analysis prompt is self-contained, so the Deal Context lookup is skipped for it (no redundant data or extra round-trip).
- **Deal Context routing** — the short step that decides which deal or logs a chat question needs (used when AI Tools is off) — runs at temperature 0 and asks the provider for a schema-constrained JSON object (structured outputs), so a small local model returns a complete, correctly-typed routing decision instead of free-form JSON the code then has to repair. This matters most on the smaller models that suit modest hardware. If a model or endpoint supports only plain JSON mode, or neither, SymBot transparently falls back (plain JSON, then a lenient parse of the raw text, then a keyword heuristic) — so routing still works everywhere.
- **A grounding check** runs after each deal analysis. It is advisory only — it never changes what you see — and simply notes in the logs if a reply dropped its Hold / Add Funds recommendation or cited a figure that was not in the supplied data, so any drift is visible over time.

---

### AI Chat

SymBot includes a built-in AI chat interface accessible from the header bar. Click the chat bubble icon to open a conversation window where you can ask questions, get trading advice, or continue a deal analysis in a free-form conversation. The AI retains the full conversation context for the duration of the session (up to 25 messages, with messages older than 2 hours automatically cleared).

The chat features an animated assistant based on the SymBot logo. It appears as a friendly welcome in an empty chat and moves to a small spot in the header once a conversation begins, subtly reacting as it works and responds — for example, showing a processing animation while it thinks or analyzes a deal.

#### Analyzing a Deal

The AI chat can also be opened in context from the Active Deals view. Click the bolt (⚡) icon on any deal row to open an AI analysis for that specific deal. The analysis includes current position status, market conditions, scenario comparisons, and a recommendation. You can then continue the conversation with follow-up questions in the same window.

#### Pop-out Chat Window

On desktop, an additional pop-out button appears in the top-left corner of the chat window title bar. Clicking it opens the current conversation in a separate browser window, which can be moved to a second monitor or resized independently while you continue navigating the main SymBot interface.

- The full conversation history is preserved in the pop-out window — the AI retains all prior context
- The pop-out connects to the same session room, so responses stream in exactly as they would in the modal
- The pop-out respects the current light/dark theme and includes its own theme toggle
- On mobile the pop-out button is hidden — the modal is used instead
- Multiple pop-out windows can be open simultaneously, each maintaining its own independent conversation

### AI Chat Conversations

AI chat conversations can be saved, loaded, and managed across sessions. A conversation bar appears at the top of every chat window — both inline and in the pop-out.

#### Saving a Conversation

Click Save to name and save the current conversation. The save prompt pre-fills with the first message you typed (or the deal analysis title for AI analysis sessions) as a suggested name. Once a conversation is saved, it auto-saves silently after each AI response — no need to click Save again.

Each conversation in the dropdown is prefixed with a type icon — ⚡ for deal analysis sessions and 💬 for free-form chats. Hovering over a conversation shows a tooltip with how long ago it was last active.

#### Loading a Conversation

Select any saved conversation from the dropdown to load it. The full message history is restored and the AI model is seeded with the prior context, so the conversation continues seamlessly. If you open the pop-out while a saved conversation is active, it opens with that conversation pre-loaded.

#### Starting a New Conversation

Select New conversation from the dropdown. A confirmation prompt will appear before clearing the current chat to prevent accidental loss.

#### Deleting a Conversation

When a saved conversation is selected, a Delete button appears. Click it to permanently remove the conversation. The Save button is hidden while a saved conversation is active since auto-save handles persistence.

#### Storage and backups

Saved conversations are stored in the database and included in backups by default. Exclude them with the *Include AI Chats* toggle in **Configuration → System Backups** (or per-backup from the System menu), and clear them independently of your bot and deal data with the *Reset AI chat history* toggle when resetting the database.

#### File Attachments

You can attach documents to any AI chat message by clicking the 📎 paperclip button to the right of the chat input. Supported file types are PDF, DOCX, TXT, MD, and CSV, with a maximum size of 25 MB per file.

When you select a file, a pulsing pill appears above the input showing the filename while extraction is in progress. Once processed, the pill becomes a permanent badge with an × to remove it before sending. Multiple files can be attached to a single message.

**How it works** — the file is written to a temporary location on the server, the text is extracted, and the file is immediately deleted. The extracted text is injected into the model's context alongside your message. The raw file is never stored — only the extracted text is retained with the conversation.

**Follow-up questions** — the full extracted text is stored with the message in the conversation history, so the document stays available for the whole session (and is persisted to the database if the conversation is saved, so it survives a reload). For each message the model is given the part of the document most relevant to that question (see *Large documents* below), so follow-ups that mention different terms can surface different sections of the same file.

**Badge display** — a 📄 filename badge appears on the user message bubble in the chat to indicate which files were attached. These badges are restored when loading a saved conversation.

**Large documents** — a document up to about 20,000 characters is sent to the model in full. For larger files, SymBot extracts the roughly 8,000-character passage most relevant to your question (scored by keyword match and snapped to a paragraph boundary) and appends a short note that only a passage is being shown — so even a 25 MB file stays well within the model's context window. Ask a follow-up that mentions different terms to surface a different passage. This relevance-based windowing means large attachments no longer risk exceeding the context limit the way sending the whole document would, so it works with both OpenAI (large context) and local Ollama models (typically 4K–32K).

Attachments work whether or not AI Tools is enabled: the extracted text is injected into the same message the model reads, so it can answer from your file and look up live deal data with tools in the same turn.

**Reverse proxy users** — if running SymBot behind NGINX or Apache, you must configure the upload size limit in your reverse proxy. The limit must cover both AI Chat attachments (25 MB) and system backup restores (250 MB). See the [Reverse Proxy Setup](#reverse-proxy-setup) section for the required configuration.

#### Context Compression

As a conversation grows, the accumulated message history can exceed the model's context window limit — particularly with local Ollama models which typically have 4K–32K token contexts. Context compression automatically manages this by summarizing older turns into a concise structured summary, keeping the conversation within limits without losing the thread.

When the total character count of the conversation history exceeds the configured threshold, the middle turns (everything between the first exchange and the most recent N messages) are summarized into a single structured message using the same model. The summary uses these headings:

- **Topic** — what the conversation is about
- **Key Points** — main facts and findings discussed
- **Important Values / Numbers** — specific figures mentioned
- **Decisions Made** — conclusions reached
- **Still Open** — unresolved questions

The first exchange and the most recent messages are always preserved verbatim. On subsequent compressions the previous summary is updated rather than restarted, so information accumulates across multiple compression rounds.

If compression fails for any reason (model error, timeout) the conversation continues normally with the full history — compression is always silent and non-breaking.

Context compression is configured under **Configuration → Artificial Intelligence (AI) → Context Compression**:

| Field | Description | Default |
|---|---|---|
| Threshold (chars) | Compress when total history exceeds this character count. ~4 chars per token — 80000 ≈ 20K tokens | 80000 |
| Protect Last N | Number of most recent messages always preserved verbatim | 10 |
| Enabled | Enable or disable context compression | Enabled |

Context compression also applies to the `app.json` config file under `ai.context_compression`:

```json
"ai": {
    "context_compression": {
        "enabled": true,
        "threshold_chars": 80000,
        "protect_last_n": 10
    }
}
```

#### Deal Context

By default the AI chat has no access to your trading data — it is a general assistant and cannot answer questions such as *"why did this deal pause?"* or *"how does this deal compare to that one?"*. Turning on either Deal Context (described here) or the more capable [AI Tools](#ai-tools-experimental) below gives it that access. With Deal Context enabled, the chat looks up the deal records you ask about and reads the matching lines from SymBot's own log files, then answers from that data. Either way, general questions and ordinary conversation still work as before — only questions about your own account start drawing on your live data.

This is read only. The AI can describe deals and explain what happened to them. It cannot pause, cancel, panic sell, add funds, or modify anything. There is no write path.

Typical questions it can answer once enabled:

- *"Why did BTC_USD-1A2B3C4-1700000000 pause?"* — reads that deal's log events and explains the cause
- *"Compare deal A with deal B"* — pulls both records and contrasts status, safety orders, duration and prices
- *"How much did that deal make?"* — reports the realized profit or loss for a deal that has closed
- *"What happened today?"* — surfaces notable log events such as circuit breaker trips, canceled orders and completions
- *"What is paused right now?"* — lists paused deals and why
- *"How many Client Disconnected are in the logs?"* — searches the logs for a phrase you name and reports the count

Each deal carries its own safety order ladder, fixed when the deal was created. A bot's configuration is only the default applied to new deals. Two deals from the same bot can therefore have different ladder sizes, and the bot's current setting says nothing about a deal already running. The assistant reads the ladder from the deal itself and reports it as exhausted using the same test SymBot uses internally.

Counts report events, not raw text matches. SymBot logs the full text of AI chat requests, so a phrase you ask about can also appear inside an earlier conversation in the log. Those occurrences are excluded, which means a count here can be lower than a plain text search of the same file — the difference is the phrase being quoted back in chat rather than the event happening again.

When a log search finds nothing, the answer distinguishes between the two reasons it can happen. If the search used wording SymBot is known to write, or an exact deal id, an empty result means those events did not occur in the dates searched. If the phrase was taken from your question instead, an empty result only means that exact wording was not found — the logs may record it differently — and the assistant will say so rather than concluding nothing happened.

For deals that have closed, the sell price, quantity sold and realized profit or loss are included alongside the position details. Deals that are still open have no realized result — only their current average and target — and the AI is instructed not to present an open position as though it had made or lost money.

##### How It Works

When you send a message, SymBot decides what data — if any — is needed to answer it:

1. **If your message names deal IDs outright**, they are used directly and no extra model call is made. This is the fast path.
2. **If your message refers to something indirectly** — *"why did it pause?"*, *"how does that compare?"* — a short routing pass asks the model which deal you mean, resolving the reference from the conversation. If that pass fails, times out, or is disabled, keyword matching is used instead.
3. **If the question needs no trading data** — general questions, greetings — nothing is retrieved and the conversation proceeds normally.

Log access is restricted to the instance's own log folder (`data/instances/<server_id>/logs/`) and to files matching the dated-log shape SymBot itself writes (`YYYY-MM-DD.log`; older `YYYY-MM-DD-InstanceName.log` files still work). Subdirectories, symbolic links and any path outside that folder are rejected. Log files are streamed rather than loaded into memory, so scanning a large log costs little regardless of its size — a deal ID typically reduces a day's log to a hundred or so relevant lines.

If anything fails — the feature is disabled, the routing pass errors, no matching data is found — the chat behaves exactly as it does with the feature turned off. Retrieval is always silent and non-breaking.

##### A Note on Response Time

Retrieval itself is fast — typically well under a tenth of a second when your message names its deals. The time you wait for an answer is almost entirely the model generating it, which depends on your hardware and the length of the reply. If you use the routing pass and find it slow, setting a small fast model in Router Model keeps it quick, since classification is a much simpler task than answering.

Deal Context is configured under **Configuration → Artificial Intelligence (AI) → AI Deal Context**:

| Field | Description | Default |
|---|---|---|
| Router Model | Model used only for the routing step. Leave blank to use the default chat model | (blank) |
| Router Timeout (ms) | How long to wait for the routing step before falling back to keyword matching | 12000 |
| Use AI Router | Resolve indirect references such as *"why did it pause?"* using a short model pass. When off, keyword matching is used | Enabled |
| Enabled | Enable or disable deal context retrieval | Disabled |

Deal Context also applies to the `app.json` config file under `ai.deal_context`:

```json
"ai": {
    "deal_context": {
        "enabled": false,
        "use_router": true,
        "router_model": "",
        "router_timeout_ms": 12000
    }
}
```

#### AI Tools (experimental)

Deal Context works by *guessing* — a routing step decides which deal or logs a question probably needs, and prepends that data before the model answers. AI Tools takes a more direct approach: instead of guessing, the chat model is given a set of read-only tools and calls exactly the ones it needs, in a loop, until it has the data to answer.

It calls whatever tools a question needs, across these areas:

**Deals and their state**

- Look up your open deals, a specific deal, recent completed deals, deals for a pair, or paused and stuck deals.
- See live unrealized P/L per open deal, and which deals are closest to their next safety order or take-profit (from a cached price — no exchange call).
- Inspect a deal's order ladder: each safety order's price and exact fill time, plus the next one to fire (or a specific order by position).
- Reconcile a deal and explain what happened — the enriched fill ladder (each fill's running average, cumulative cost, and time since the previous fill), how far price fell from the base order, the outcome or live P/L, and plain-language findings, alongside the deal's own log events.

**Performance**

- Count filled base and safety orders in a day range, broken down per deal and per bot.
- Summarize performance over a named period, a from/to range, or all-time: deals, total profit (kept per quote currency so different currencies are never summed into a meaningless figure), average profit %, win rate, average time a deal stays open, best and worst deal, and a winners-vs-losers split.
- Break performance into per-day, per-week or per-month buckets — "how did I do each day this week?" or "profit by month this year?".

**Pairs, portfolio and risk**

- Rank pairs by profit, by worst performance, or by how actively they are traded (with the single best and worst).
- Summarize the portfolio: open deals, funds deployed, maximum committed if every safety order fills, and available balance.
- Break exposure down by quote currency or by pair — deployed now, the extra needed if every safety order fills, and the available balance (flagging a potential shortfall).
- Give a risk snapshot across all open deals: total unrealized P/L, how many are underwater by more than 2/5/10%, and the stop-loss picture (including deals within a few percent of triggering theirs).

**Bots and deal leaderboards**

- Rank your bots by realized profit, win rate, average duration and activity (with the best and worst).
- Produce a leaderboard of individual deals — best or worst by profit percentage, by amount, or by how long each ran — across completed or open deals.
- Find your oldest and longest-running open deals to surface stagnating positions, or your newest — the most recently opened — deals.
- Find open deals near the end of their safety-order ladder (the least room left to average down).

**Investigating one deal**

- Resolve a deal you describe — "the BTC deal", "my newest one" — to its exact id so a follow-up lookup can use it.
- Diagnose a single deal from its state plus its own log events.
- Contrastively compare a deal to its opposites — a loser against your winners on the same pair — showing the decisive differences in safety orders used, how far price fell below the base order, duration and settings, so "why did this one do so much worse?" gets a real answer.

**Errors, logs and status**

- Summarize genuine errors across all deals (real problems only, not routine events like finished deals).
- Count how many times SymBot restarted.
- Search the logs in plain language — it understands concepts like "insufficient funds", "circuit breaker", or "canceled", expands them to the phrases SymBot actually logs, and returns a line or two of surrounding context so an event on a neighboring line (such as a funds warning) is still tied back to its deal.
- Search the logs by time — ask "find logs around 10:43 PM", "what happened around 6:25 AM today?", or "show me events between 6:00 AM and 7:00 AM", and it reads the clock time in your own timezone, converts it correctly, and lists the real log lines from that window. A precise time or a named day (today/yesterday) searches that one moment; a looser time of day with no day — "any errors around 5pm?", "errors between 11am and 8pm?" — searches that time of day across the last few days, so a recurring pattern is not missed. It also understands relative days like "two days ago", "three days ago", or "yesterday and the day before", resolves them in your timezone, and tells you the exact date it searched. You can widen either dimension in the question: say "over the last week" or "over the last 5 days" to change how many days it looks back, and "within an hour" or "within 15 minutes" to change how wide the window around the time is.
- List your bots and their settings, report the circuit-breaker status, name the exchange(s) you trade on (live or sandbox), and read your cached account balances.
- When a question needs deeper reasoning than a lookup, consult a stronger model for a judgment on the figures already gathered.

Log questions can be scoped to a specific day, so "yesterday" means only yesterday.

And nothing else: the tools are strictly read-only, with deliberately no tool that can pause, cancel, sell, or change anything, so the assistant cannot take a trading action even if asked. If you do ask it to act — "close my XRP deal", "pause that bot" — it declines immediately with a short note that it is read-only and points you to the deal or bot controls, rather than attempting anything. It also declines a request to reveal its own system prompt or hidden instructions, and never returns your exchange keys or other credentials — those are never placed in its context in the first place.

For forensic and abstract-data questions the chat has five analysis tools that read the logs directly:

- Analyze the logs over a time window with flexible counting (how many times something happened, when it spiked, grouped by hour).
- List everything that happened in a time window across all deals.
- Correlate an incident around a moment — clustering errors, auth/network failures, invalid prices, restarts and completions, rolling them up into stable kinds (auth, network, order, funds, price, system) and naming the deals caught up in it.
- Compare the error mix to a baseline — count each error type in a target window against the days before it and flag what is *new* or *spiking* versus normal, so "is anything unusual today?" gets a real answer rather than a raw list.
- Scan for price anomalies — a zero/invalid price, an implausible profit, or a price that deviates wildly from a deal's average (the class of glitch where a bad exchange price produces a nonsensical figure).

These stream the log byte-by-byte with a hard memory ceiling and yield the event loop periodically so a large scan never blocks trading — SymBot is a trading platform first. When you ask for the detail behind a count, the log tools carry it: each error type comes back with a few real example lines and when it was first and last seen, so "show me those network errors" gets actual evidence, not just a total.

A count or grouped question (unlike a raw line list) keeps only small running totals in memory, so it streams the whole retained window in a memory-light way (a technique called map-reduce): each day's log is read and folded into the running totals in turn, rather than stopping at the first day or two.

If a range is large enough to run long, the scan stops on a soft time budget — well before the tool's own timeout — and returns an honest partial: the correct totals for the days it did reach, plus how many days it covered versus how many were asked for, instead of failing with nothing to show.

The chat runs under a strict grounding rulebook: it must answer account questions only from what the tools return, use per-item breakdowns verbatim (it will not invent a deal or pair to round out a list), and say "I don't have that data" rather than estimate when a tool returns nothing.

Several deterministic guardrails back that rulebook up in code, so the assistant stays honest even when the local model wobbles:

- **Grounded identifiers** — every composed answer is checked against the data the tools actually returned (plus anything already established earlier in the same conversation), and a deal id the answer states with no such backing is never shown to you. If the rest of the reply is sound, the stray identifier is redacted in place; if the whole reply had no live data behind it, the answer is replaced with an honest "I couldn't verify that — ask me to list your deals" note. An answer that carries an unverifiable identifier can never display the "✓ checked against your data" confirmation — the caution always wins.
- **Egress-sanitizing** — answers are cleaned before they reach you, so nothing that could quietly leak your data rides along in a reply: hidden tricks such as remote-image markup and invisible characters (known as data-exfiltration vectors) are stripped out.
- **Untrusted content is fenced off** — a tool's free-text fields, and especially an uploaded log file, are wrapped in random delimiters and marked as *data, never instructions*, so a prompt-injection buried in a log can't hijack the assistant. Because the tools are read-only, the worst case is bad text, never a trade.

The assistant will describe your data and explain concepts but declines to give buy/sell/hold or price-prediction advice, pivoting to what it can show from your own figures instead. Follow-ups stay on live data rather than the model's memory. A deictic follow-up like "why is *that* one stuck?" or "is *it* profitable?" resolves the reference to the deal you were just discussing; a ranking follow-up like "and which one is furthest away?" or "what's my best performer?" is treated as a fresh look across your deals; and a bare continuation — "tell me more", "go on", "elaborate", "break it down" — is treated as *continue on live data*. In each case the assistant re-runs the lookup and grounds the reply in real figures, rather than expanding its previous answer from memory (where a smaller local model can drift into invented rows). An optional topic guard (off by default; enable under AI Tools) declines off-topic requests with a friendly redirect.

The model is also told the current date and time in UTC (all deal and log timestamps are UTC), so questions phrased with "today", "yesterday", or "the last few days" resolve correctly.

Enable it under **Configuration → Artificial Intelligence (AI) → AI Tools**:

You don't need to change any of the options below to get accurate answers — the defaults are the recommended balance of accuracy and speed, and answers are already grounded in your data. Each option only adds extra depth in exchange for a little more time; turn one on only if you want that specific behavior. None of them is required for the assistant to answer correctly.

| Setting | Description |
| --- | --- |
| **Enabled** | Turn tool-calling on for the AI chat. Off by default; when off, chat uses the Deal Context router described above, unchanged. |
| **Max Tool Rounds** | How many tool-call rounds the model may take before it must answer (1–10, default 5). Higher allows more lookups per question but is slower. |
| **Verify answers** | Optional, off by default. After the chat answers from tool data, a second model pass checks the answer's figures against what the tools returned and appends a small one-line indicator: a ✓ when the figures are supported, or a ⚠️ caveat when something looks unsupported. Adds one extra model call per answer. |
| **Deep research (explore)** | Optional, off by default. Adds a single `explore` tool the model can call for broad, multi-step questions — instead of making a dozen lookups inline, it hands the question to a focused research sub-agent that runs its own bounded tool-calling loop over the same read-only tools and returns one synthesized answer, keeping the main conversation tidy. Best on a capable model; more expensive (a nested loop of model calls). Requires Enabled on. |

Requirements and behavior:

- **Needs a tool-calling model.** Recent local models on Ollama (e.g. Llama 3.1+, Qwen 2.5+) and OpenAI models support tool-calling. If the active model or endpoint does not, SymBot detects it on the first call and falls back automatically to the normal Deal Context path — nothing breaks. A more capable model (e.g. Qwen 2.5 14B) selects tools and phrases answers noticeably more reliably than a small 8B one, and models under ~3B are generally not dependable for tools; see [Choosing a model for your hardware](#choosing-a-model-for-your-hardware). To catch a mismatch before you rely on it, the config screen shows a live tool-calling check next to the Ollama Model field whenever AI Tools is enabled — green when the chosen model supports tools, amber when it doesn't.
- **Reliable with many tools.** Selection accuracy on small models drops off past ~10–15 tools, so rather than showing all 40+ tools every turn, SymBot shortlists the handful relevant to your question (a keyword router, with a small always-included core) and offers the model only those, along with a grouped "which tool for which question" guide. Tools requested together run concurrently, each with its own timeout so a slow scan can't hang the turn, and the loop stops and answers if the model repeats a call or hits a run of errors rather than looping or fabricating results.
	- **Compact results** — tools keep their output small so a single result stays within the model's size budget rather than being clipped into something it can't read. A long output — a deal with dozens of safety orders, a live status list covering many open deals, a long run of matching log lines, or a year-long day-by-day series — returns a representative page (most recent, or worst-first for open positions) while still reporting the true totals and the single best/worst entry.
- **Built for cross-provider compatibility.** The tool loop normalizes the differences between providers so it works with Ollama, OpenAI, and OpenAI-compatible endpoints (llama.cpp, vLLM, LM Studio, Groq, and similar). Four normalizations do the work:
  - Tool-call arguments are parsed tolerantly whether they arrive as an object or a JSON string, with light repair of fenced or trailing-comma JSON.
  - Missing tool-call ids are synthesized, so id-strict endpoints don't reject the follow-up.
  - A tool call a weaker model emits as plain text is recovered when its name matches a real tool.
  - An endpoint that silently ignores the tools falls back to the grounded path instead of answering blind.
- **Deep research sub-agent (explore).** With Deep research on, the model gains one extra tool, `explore`, for questions that need gathering and comparing a lot of data at once — e.g. *"review all my completed BTC deals this month and identify which safety-order setups performed best"*. Rather than run that in the main conversation (dozens of tool calls the round cap would cut short), it hands the question to a sub-agent:
	- **How it works** — the sub-agent is a second tool-calling loop over the *same read-only tools*, bounded by the same Max Tool Rounds and a hard time limit. It gathers what it needs on its own and returns a single synthesized answer.
	- **Kept safe and tidy** — it is read-only and cannot call `explore` itself (so it can never recurse), and its work stays out of the main chat's context: you get the conclusion, not the twenty lookups behind it.
	- **Off by default** — it costs more (a nested loop of model calls) and is most effective on a capable model. For a single lookup the model just uses the specific tool directly.
	- **`deep_explore`** (also off by default) — upgrades the sub-agent to a structured plan → gather → gap-check → cited-synthesis pass for the most demanding questions. It applies only when Deep research is already on.
- **Applies to chat only.** The one-off deal analysis (the ⚡ button) is a self-contained report and does not use tools; only your typed chat questions do.
- **The answer streams.** While the model is looking things up the assistant shows its "thinking" state; once it has the data, the final answer is revealed progressively rather than dropped in all at once.
- **Works over the API too.** The `/api/ai/chat/prompt` endpoint accepts an API key, so tool-augmented chat is reachable from `curl`. A streaming request (the default) is delivered over the Socket.IO room; a non-streaming request (`message.stream: false`) is answered synchronously with the composed reply in the HTTP response body (`data`), so a plain `curl` client with no socket still gets the full answer.
- When enabled, the Deal Context router is bypassed for chat — the tools replace it. You can keep Deal Context configured; it simply isn't used while AI Tools is on.

In `app.json` under `ai.tools`:

```json
"ai": {
    "tools": {
        "enabled": false,
        "max_iterations": 5,
        "verify": false,
        "explore": false,
        "deep_explore": false,
        "topic_guard": false,
        "trace": false,
        "corrective": false,
        "tool_model": ""
    }
}
```

`tool_model` is an advanced, optional **model cascade**, set in `app.json` only (it is intentionally kept out of the config screen to avoid cluttering it). Leave it blank and the whole assistant runs on one model. Set it to a stronger model name — for example a 14B where your chat model is an 8B — and SymBot uses that stronger model *only* for the data path (looking up your deals, counts and figures, the step where a small model is most likely to slip), while ordinary conversation stays fast on the lighter chat model. It must be a model your active provider can serve. This pays for the stronger model only on the calls where accuracy matters most.

`corrective` enables a recovery step: when a whole tool lookup comes back empty — every result had no matching rows — the assistant rephrases your question once and tries the tools again with the clearer wording before it answers "no data." It only runs on that empty-result path, makes at most one extra model call per question, and is off by default. It never invents data: if the retry also finds nothing, the honest "none found" answer stands. This mainly helps when an awkwardly-phrased question would otherwise miss data that is actually there.

(Tool shortlisting — which tools the assistant considers for a question — combines the precise keyword routes with a lexical match and fuses the two rankings, so a tool matched by both signals is preferred. This is automatic and needs no configuration.)

#### Diagnosing an AI chat answer

When an answer looks wrong, the fastest way to see *why* is the tool trace. Set `ai.tools.trace` to `true` and ask the question again. For every tool the model calls, a line is written to the instance log showing the tool name, the exact arguments the model chose, how long it took, and how the result came out:

```
AI trace [chat-123]: get_pair_performance args={"order":"most_profitable"} → 27ms ok (309 rows)
AI trace [chat-123]: get_pair_performance args={"days":30,"order":"least_profitable"} → 17ms ok (25 rows)
```

That single line usually explains the answer: it shows, for example, whether the model narrowed a question to a recent window when it should have looked at all history, whether a lookup returned no rows, or which tool answered. The trace never changes an answer — it only records how one was produced — and it is off by default so the log stays quiet.

To report a problem so it can be diagnosed (and, where a gap is found, so a new read-only tool can be added), include:

- The exact question asked, and the answer you got, and what you expected instead.
- The model and provider in use (Configuration → AI), since smaller models are less reliable at choosing tools and their arguments.
- The `AI trace …` lines for that question (enable `ai.tools.trace`, re-ask, then copy them from the instance log).

Chat conversations are also saved, so a saved conversation can be revisited later. Because every AI tool is strictly read-only, sharing a trace never exposes an action on your account — only which lookups ran.

#### AI Learning (experimental)

When AI Tools is on, the chat can also learn from use so it gets more accurate over time without any manual tuning. After each answer it records a small,
patterns-only note — the question you asked and which read-only tools answered it
— and, on your next question, injects the most similar past questions into the prompt so the model reuses the approach that worked instead of re-guessing which tool to call. It is off by default.

What it stores is deliberately narrow and safe:

- **Patterns only — never values.** A record holds the question text and the tool
  names that answered it, plus a cheap grounding flag (were the answer's figures all
  present in the tool output?). It never stores your P/L, balances, prices, deal ids,
  or the answer itself. There are no account values in the corpus at all.
- **Agnostic, not siloed.** The corpus is generic "which tool answers this kind of
  question" know-how, so it is stored once per database rather than partitioned per
  instance. In a Hub setup where instances share one database, they therefore
  share and aggregate their learning automatically and answer consistently; a
  standalone instance keeps its own.
- **Kept out of system backups.** Because it is know-how and not per-deal data, the
  learning corpus is deliberately excluded from the system backup and restore
  cycle — restoring an older deal backup never wipes or resets what the chat has
  learned.
- **Quality-filtered.** Only well-grounded answers (and any you explicitly rate 👍)
  are reused as examples; a shaky or 👎-rated answer is never fed back as a model to
  copy. Retrieval is a dependency-free keyword-similarity match (Okapi BM25, the ranking
  classic search engines use) — no embeddings, no external service, works offline.
- **Rating a reply.** While learning is on, a small, faint 👍/👎 appears beneath each
  answer that was built from your live data (deal, bot, portfolio, log and error
  answers). Plain conversational replies — which teach nothing about which tool to use —
  intentionally don't show it, so the control only appears where your feedback is useful.

Extras, all reachable from **Configuration → Artificial Intelligence (AI) → AI Learning**:

- **Smart on first install.** SymBot ships a curated starter corpus of hundreds of
  common question→tool patterns (covering every tool, in many phrasings), imported
  automatically the first time you use the chat with learning on — so it routes almost
  any question correctly from day one, before it has learned anything of its own. The
  shipped default is a read-only file in the install; it is merged into your writable
  corpus in the database, never edited in place. On upgrade, a newer default version
  merges its new patterns in (additively, deduped) without touching anything you have
  added, rated, or removed.
- **Export / import a corpus pack.** *Export* downloads the corpus as a patterns-only
  file (no values); *Import* merges a pack from another install. Every import is
  verified first — it must be a genuine SymBot corpus (manifest), pass an integrity
  checksum (so a corrupt or tampered file is rejected), and every pattern it references
  must map to a tool that exists in your install (so a pack can't smuggle in anything
  unknown). Invalid patterns are dropped and the rest still import.
- **Hub aggregation.** When several instances run under a Hub, they pool their
  learning: instances that share one database do so automatically, and instances on
  separate databases have their patterns relayed to the Hub, which periodically
  shares the combined set back — so every instance benefits from what the others learn.
- **Combine shared patterns and check they actually help.** If other people share their
  exported packs with you, you can combine several at once — and before saving anything,
  SymBot shows you whether it helps. It does this with a built-in set of *practice
  questions*: everyday questions each paired with the tool that should answer them, kept
  separate from the patterns SymBot ships so it is a fair test. SymBot answers them with
  and without the new patterns and reports how often it now points to the right tool
  (overall, and per tool), flags any tool that got *worse*, and lists the questions the
  new patterns fix. Patterns that many people learned independently are trusted; where
  people disagree on the same question it is flagged rather than guessed; and one-off
  patterns are left out. You then save only the vetted new patterns with one click — and
  on a Hub, they reach every connected instance. It is how a community can improve the
  assistant's tool-picking for everyone while you stay in control of what actually ships.
  (There is also a **Check current accuracy** button that runs the same practice test on
  your corpus as it stands — a simple score of how well what it has learned points to the
  right tool, and which questions it hasn't learned yet. A higher score is better; it is
  informational, not something you need to act on.)
- **Optional 👍/👎.** A small, unobtrusive thumbs-up/down appears under a finished
  answer; it simply nudges which patterns are preferred or avoided. Ignore it and the
  automatic grounding signal still does the work.

Enable it in `app.json` under `ai.learning`:

```json
"ai": {
    "learning": {
        "enabled": false
    }
}
```

When disabled (the default), nothing is recorded or injected and the chat behaves exactly as before.

#### Verifying and regenerating the corpus

The shipped starter corpus is protected by an integrity checksum, so a corrupt or edited file is rejected rather than silently trusted. If you edit the corpus — for example to add patterns after a new tool is introduced — the checksum must be recomputed. Two console commands do this without starting the trading engine:

```bash
node symbot.js corpus check
```

`check` reports whether the corpus passes its integrity check, whether its checksum and tool-set fingerprint still match this install, and lists any registered tools that have no pattern yet.

```bash
node symbot.js corpus regen
```

`regen` recomputes the checksum, record count, and tool-set fingerprint for the current records and writes the file back, then re-verifies it. Run it after editing the corpus so the file is valid again. Both commands touch only the corpus file — never the database or any trading state.

## Scheduled Tasks

SymBot can run tasks on a schedule and deliver the result to you automatically. A task is one of two kinds: an AI task — any prompt you would type into the chat, run on a schedule (a morning summary of your open deals, a periodic check for deals older than a week, an end-of-day P/L recap, or even a trivial one-off like *"what's the date and time?"*) — or a recipe, a ready-made task you add from a built-in library that runs a specific check, most of them without needing AI at all (see *Recipe library* below).

Every task, AI or not, is strictly read-only: it can look up deals, orders, logs and balances, but it can never place, change or cancel a trade. An AI task runs as a fresh, memory-less chat turn that uses the same read-only tools as the interactive chat. The result is delivered to one or more destinations you choose per schedule — the browser, Telegram, email, or a webhook — each firing on the run outcomes you pick (see **Notify** below).

Scheduled tasks live in the Schedules section in the navigation (they were previously under Configuration → AI; a link there now points to the section). The page's Scheduled Tasks panel lists every task and carries two buttons — + Add schedule (write your own AI task) and + Add from library (pick a ready-made recipe) — followed by a System Backup panel that summarizes the backup schedule, lets you **Run now** (which performs the full backup — the stored file, retention, and the off-site upload if configured — the same as a scheduled run, useful for taking a missed backup or testing an off-site change) or open its **History**, and links to its editor in Configuration. Once you have both recipes and your own tasks, the list groups them under Recipes and Your schedules headings so it stays legible. Click + Add schedule to open the editor:

| Field | Description |
| --- | --- |
| Name | A label for the task, shown in the list and at the top of the delivered notification (e.g. *Morning deal summary*). |
| **When** | *Repeating* runs on a recurring schedule; *Once* runs a single time at a date/time you pick. |
| **Repeat** | For a repeating schedule, pick the days (none = every day) and a time. All times are entered in your browser's local time and, by default, converted to UTC for storage (so every viewer sees them in their own local time), exactly like the System Backups scheduler. An optional "Keep fixed to my local time across DST" checkbox instead pins the schedule to your timezone, so it holds the same wall-clock time year-round across daylight-saving changes. An Advanced toggle lets you enter a raw 5-field cron expression directly (evaluated in UTC) for anything the day/time picker can't express. |
| **Run at** | For a *Once* schedule, a local date/time; it is converted to UTC when saved. |
| **Prompt** | Whatever you want the AI to do when the task runs, exactly as you would type it into the chat (e.g. *"Summarize my open deals and unrealized P/L; flag any deal older than 7 days."*). |
| **Notify** | A list of destinations that receive the result — add or remove as many as you like with + Add destination. Each row picks a channel (Browser, Telegram, Email, or Webhook), an optional target (a Telegram chat ID, comma-separated email recipients, or a webhook URL — blank uses your defaults), and *when* it fires (Always, On success, On failure, Success or failure, or On missed) — so you can, for example, get a browser note on every run but an email only on failures. See **Notifications** below for how each channel is delivered and what it needs. |
| **If missed** | What to do with runs that were due while SymBot was stopped: Skip (default — ignore them, wait for the next scheduled time), Run once (a single make-up as soon as SymBot restarts), or Run all missed (one make-up per missed occurrence, capped). Make-up runs happen in the background and appear in History like any other run. |
| **If already running** | What to do if a previous run is still going when the next is due: Forbid (default — skip the new run, recorded as *skipped*) or Allow (run it alongside). There is deliberately no "replace": a run in progress can't be force-stopped mid-flight in-process. |
| **Retries on failure** | How many extra attempts a failed run makes before giving up (0–5, default 0), with a Fixed or Exponential backoff between attempts. Only genuine errors are retried — a *timeout* is not (its abandoned handler may still be running). The run history records how many attempts a run took. |

Each task in the list shows its schedule, a green *enabled* / red *disabled* status, when it last ran, and actions: Run now (fire it immediately — this does not consume or disable a one-off), History, Edit (opens the same modal editor, pre-filled), Enable/Disable, and Delete. A recipe (see below) additionally offers Reset to defaults. A search box filters the list by name or prompt.

**Recipe library.** Alongside tasks you write yourself, SymBot ships a small library of ready-made recipes — pre-defined tasks you add with one click instead of composing a prompt. Click + Add from library to browse them. Each recipe is added to your list as a normal, fully-editable schedule, disabled by default so nothing runs until you turn it on, and is then managed exactly like your own tasks. Two extra behaviors are specific to recipes:

- **Reset to defaults** — restores the recipe's original schedule and settings if you have changed them, while keeping your notification destinations and enabled state. Useful after an update ships tuned defaults: because an added recipe is never silently overwritten, this is the explicit, opt-in way to pull the new defaults in.
- **Delete is durable** — deleting a recipe removes it for good; it will not reappear on the next restart. You can always add it back from the library (which clears the deletion).

Not every task needs AI, and the list makes that explicit with a badge on each task and library entry:

- **AI** — the task calls the AI model (every prompt you write is an AI task); it needs an AI provider configured.
- **no AI** — a plain deterministic check that runs with no AI provider at all.
- **AI optional** — runs without AI, but offers an Enhance with AI checkbox that adds a short AI-written summary over the same result when a provider is available.

Three recipes ship today, all read-only and needing no AI:

- **Error sentinel** — scans the logs on a schedule and alerts you only when an error type is *new* or *spiking* versus the previous days; silent when everything is normal.
- **Drawdown sentinel** — alerts you when an open deal is underwater past a threshold or its safety-order ladder is nearly exhausted; quiet when everything is healthy. This one is AI-optional — tick *Enhance with AI* to append a short written summary.
- **Resource sentinel** — samples the host machine's disk, memory and CPU on a schedule and alerts you only when one crosses a warning threshold (running low on disk, near out of memory, or CPU-saturated); quiet when everything is healthy. It uses only built-in system stats — nothing extra to install — and works on Linux, macOS and Windows. Memory alerts use true *available* memory on Linux and Windows; macOS does not expose that to a pure check, so there the memory figure is shown but not alerted on. Because it reads the host, in a Hub (several instances on one machine) enabling it on a single instance covers them all.

A recipe is just declarative data (a task type plus settings, carrying no account values), so the shipped set can grow over time; a newer version of a recipe never overwrites a task you have already added.

**Run history.** Every run's full output is recorded and kept per task. Retention keeps failures longer than successes — the newest 25 successful/normal runs and up to 50 failures (`error` / `timed_out`) are retained, so a burst of successes never evicts the failures you actually want to look back at. Open History on any task to browse past runs — each shows its time, whether it was scheduled or a manual *Run now*, status, duration, and the complete output. Status is one of `ok`, `error`, `timed_out` (the run exceeded its time limit and was abandoned) or `skipped` (a scheduled fire that landed while the previous run was still in progress). In the history view you can filter runs by a text search (matching the output or date) and by status, Run now again, delete an individual run, or Clear all history. Because full output lives here, the notifications themselves are truncated (about 800 characters) with a pointer back to the history.

**Download / export.** A task's history can be downloaded as a JSON file from the Download link in its History view, and Download all history on the Schedules page exports every task's runs. The same is available over the API: `GET /api/schedules/:id/runs/export` (one task) and `GET /api/schedule-runs/export` (all).

Behavior and safeguards:

- **Read-only, always.** Scheduled tasks go through the same tool registry as the chat, every tool of which is strictly read-only, so a task can only ever produce a report or an alert.
- **No concurrent runs.** A task cannot run twice at once — a second *Run now* while one is already in flight is refused, on both the UI and the API. When a *scheduled* fire lands while the previous run is still going, it is recorded as a `skipped` run so the overlap is visible in the history.
- **Runs can't hang forever.** Each run has a time limit (15 minutes by default, overridable per schedule via `settings.timeout_ms`); a handler that exceeds it is abandoned, recorded as `timed_out`, and — crucially — the schedule is freed so it can run again, rather than being stuck behind a hung run until the next restart.
- **Timezone-correct on any server.** A recurring schedule created with the day/time picker is stored in UTC by default and shown to every viewer in their own local time, so it fires at the intended moment regardless of the server's own timezone (a UTC VPS, or anywhere in the world). An optional *Keep fixed to my local time across DST* checkbox instead anchors the schedule to the creator's IANA timezone, so it holds the same wall-clock time across daylight-saving changes. Advanced *Raw cron (UTC)* entries and pre-existing schedules are evaluated in UTC, exactly as before. Invalid cron expressions are rejected when you save.
- **Missed runs follow your catch-up policy.** With the default Skip, a *Once* schedule whose time passed while SymBot was stopped is marked *missed* and disabled on the next start (no surprise late run), and missed *cron* occurrences are ignored. Set Run once or Run all missed to have SymBot make up what it missed during an outage — bounded to a 7-day look-back and a per-schedule cap so a long downtime can never trigger a flood. Missed cron occurrences are computed with a timezone-aware engine (so daylight-saving shifts are handled correctly). A one-off still disables itself automatically after it runs.
- **Survives restarts.** Enabled tasks are re-armed automatically when SymBot boots, so you set them once. You can enable, disable or delete any task from the list at any time.
- **Prompts are capped** at 2000 characters, and a *Once* schedule can be set at most 60 days into the future.

**One place for scheduled tasks.** Every timed job runs through the same scheduling system: AI analysis tasks, the error-watchdog, drawdown-sentinel and resource-sentinel recipes (which run without AI), and the system backup. Each task is either a one-time run at a chosen moment or a recurring job on a cron expression, and every kind of task shares the same run history, notifications, and reliability behavior described below.

**Notifications.** Every scheduled task can tell you when it runs, and all tasks share the same delivery. A notification target is a channel, who to send to, and when to fire — a target can reach one destination or many (several Telegram chats or several email recipients at once), and you choose the conditions: on success, on failure, always, or when a run is missed (a one-time task whose scheduled moment passed while the instance was down and whose catch-up policy is set to skip). The four channels each deliver a little differently:

- **Browser** — reuses the normal in-app notifications, so it also appears in your history.
- **Telegram** — fans out to every configured chat.
- **Email** — sent through your mailer in a branded template with a plain-text fallback.
- **Webhook** — posts the message as JSON to a URL you provide.

Older schedules that only had Browser and Telegram toggles keep working and gain the fuller set automatically. Email targets hold recipients only, never mail credentials — the mailer itself is resolved when the message is sent: an instance uses its own mailer when you have configured one, otherwise it falls back to a shared Hub mailer, so one mail setup can serve every instance.

**Reliability.** Every scheduled task shares the same reliability behavior:

- **Timeout** — each run has a timeout (default 15 minutes); after it, the run is marked timed out and the schedule is freed.
- **Overlap** — a fire that lands while the same job is still running is recorded as skipped.
- **Run history** — more failures than successes are retained, so problems stay visible.
- **Catch-up** — a policy of *skip*, *once*, or *all* makes up runs missed while the instance was down, using a bounded, timezone-aware make-up.
- **Concurrency** — a *forbid* or *allow* policy governs overlaps.
- **Retries** — a failed run can retry with fixed or exponential backoff, and each attempt is recorded.

Recurring times default to a fixed UTC instant shown in each viewer's local time. An optional *Keep fixed to my local time across DST* toggle instead anchors a schedule to the creator's timezone, so a "9:30 AM" schedule stays 9:30 AM across daylight-saving changes (existing UTC schedules are untouched).

All schedules — AI tasks *and* the system backup — are stored in the database (the `schedules` collection; run history is in `schedule_runs`) and managed through the API:

- `GET` / `POST /api/schedules` — list / create
- `POST /api/schedules/:id` — update (or send `{ "enabled": … }` to toggle)
- `DELETE /api/schedules/:id` — delete
- `POST /api/schedules/:id/run` — Run now
- `GET /api/schedules/:id/runs` — run history
- `DELETE /api/schedules/:id/runs/:runId` / `DELETE /api/schedules/:id/runs` — delete one run / clear all
- `GET /api/schedules/:id/runs/export` and `GET /api/schedule-runs/export` — export one task's runs / all runs

Recipes have their own endpoints: `GET /api/recipes` (browse the library), `POST /api/recipes/:id/add` (add one to your schedules) and `POST /api/recipes/:id/reset` (reset an added recipe to its shipped defaults); deleting a recipe-derived schedule records a tombstone so it is not re-imported on the next start.

Each row is scoped by `server_id`, so under the Hub an instance only runs its own schedules, even when instances share one `app.json`.

Note: if two instances share both the same `app.json` and the same database — and therefore the same `server_id` — they would each run the shared schedules. Give such instances distinct databases or `server_id` overrides to keep them independent; best practice under the Hub is a separate database per instance.

**How a schedule is identified as "this instance's".** `server_id` comes from the database's own `server` collection, so a given database only ever has one valid `server_id` at a time, and every schedule in it belongs to the instance that owns it. If that identity ever changes — a database restore, or a *Reset server ID* — schedule rows can be left under a previous `server_id`. They are adopted automatically on the next start: the instance re-scopes them to the current `server_id` (keeping the backup a singleton) so nothing is orphaned or left running under a stale identity. In short, schedules follow the database — you do not end up with lingering, unowned rows.

**The system backup migrated from `app.json`.** On earlier installs the backup schedule and its SFTP/encryption settings lived in `app.json`. The first time you run this version, that configuration is copied automatically into a `backup` schedule row — a one-time, idempotent step, so you do not need to re-enter anything. From then on the backup behaves like any other schedule and is edited in the System Backups panel as before.

The old `app.json` block is left in place as a dormant, read-only migration seed and is no longer used at runtime. This is deliberate: under the Hub, several instances can share one `app.json` but use separate databases, so each migrates its own backup row (re-migration is prevented by the presence of the instance's own row, not by an on-disk flag).

Because the backup's live secrets (encryption password, SFTP credentials) now live in the database, they are covered by the Include Schedules toggle on backup and the Restore schedules toggle on restore. As a disaster-recovery note: if you ever lose the database entirely, you would re-enter the SFTP credentials once to reach your off-site backups.

### Schedules in backups

Your schedules (both AI tasks and the system backup job itself, including any stored SFTP/backup credentials) are included in backups by default, controlled by an *Include Schedules* toggle in **Configuration → System Backups** and per-backup in the manual backup dialog. On restore, a *Restore schedules* toggle — off by default — controls whether the archive's schedules overwrite the current instance's own. Restoring is opt-in precisely because those rows carry credentials: the safe default leaves the running instance's schedules and stored SFTP/backup credentials untouched, and you check the box only when you deliberately want to bring the archive's schedules across.



## Access Control (Users, API Keys & Audit)

SymBot works out of the box for a single operator — you log in with one password and have full access, with nothing extra to set up. When you need finer control — a read-only key for a dashboard, a service that can start bots but not delete them, or a second person with limited access — the Access Control page (in the navigation) provides it, built on a single capability model.

**How it works.** Every permission is a `resource.action` capability (e.g. `bot.read`,
`deal.close`, `settings.write`). Roles are just named bundles of capabilities, in a ladder:

| Role | Can do |
| --- | --- |
| **viewer** | Read-only — view deals, bots, stats, logs. Cannot act. |
| **operator** | Everything viewer can, plus trade and manage running bots: start/stop bots, edit an existing bot’s settings, and start/pause/close deals. Cannot create or delete bots. |
| **admin** | Everything operator can, plus create/delete bots, change settings, manage API keys, add users, view the audit log. |
| **owner** | Full access. Your existing single password is the owner. |

Enforcement is deny-by-default and applies identically to the web UI, the HTTP/API (curl), and the WebSocket API — so a read-only key is refused (`403`) on any action it isn't granted, everywhere.

**Capabilities** (what you can grant a key or a role):

| Read | Write / act |
| --- | --- |
| `account.read` · `bot.read` · `deal.read` · `stats.read` · `logs.read` · `settings.read` · `apikey.read` · `user.read` · `instance.read` | `bot.write` · `bot.create` · `bot.delete` · `bot.start` · `bot.stop` · `deal.create` · `deal.pause` · `deal.close` · `settings.write` · `apikey.create` · `apikey.revoke` · `user.invite` · `user.manage` · `audit.read` · `instance.manage` |

For example, a signal source needs only `deal.create`; a monitoring dashboard needs a handful of `*.read` capabilities. Every state-changing route requires exactly one of these, and SymBot's startup watchdog verifies that none are missing (see Audit log below).

### API keys

Create keys under **Access Control → API Keys**. Each key:

- Is scoped — you tick exactly the capabilities it needs (a key can never exceed your own
  permissions).
- Is shown once at creation as `symb_live_…` — only a hash is stored, so it can't be
  retrieved again. The `symb_live_` prefix is just a format tag for recognizing a key at a
  glance; it does **not** by itself put anything into live trading. Whether a bot trades live
  or on paper is a per-bot setting, independent of the key.
- Can be disabled or revoked anytime, tracks last-used, and supports an optional expiry
  you can set, change, or clear at any time (an expired key is refused automatically).
- Can be rotated with one click — a **Rotate** action mints a successor key with the same
  scope (shown once, just like a new key) and grace-expires the old one after 24 hours, so a
  client can swap in the new secret before the old stops working, with no window of lost access.

Send a key as a header — either form works:

```bash
curl -H "api-key: symb_live_xxxx" http://localhost:3000/api/deals
curl -H "Authorization: Bearer symb_live_xxxx" http://localhost:3000/api/deals
```

Your previous single API key keeps working unchanged (it acts as the owner). Webhooks accept
either a scoped key (with the `deal.create` capability) or the legacy Webhook API Token —
see [Webhooks](#webhooks).

### Users

Add people under **Access Control → Users**, each with a role. Named users log in on the normal login page with their username and password; leaving the username blank logs you in as the
owner using the configuration password. Each request then carries that user's role
capabilities and is enforced the same way as an API key.

The single operator remains the implicit owner until you add anyone — so nothing changes for a solo setup. Safeguards prevent locking yourself out: the initial owner can't be demoted or disabled, and you can never remove the last active owner. If you ever do lock yourself out, the console recovery commands (`npm start reset password` / `reset users`) restore access — see [Reset or Configure SymBot](#reset-or-configure-symbot).

### Audit log

Security-relevant actions are recorded with who, what, when, and from where — viewable and filterable under **Access Control → Audit Log**. What is captured:

- **Authentication** — login, logout, failed login, and IP-blocked or IP-denied attempts.
- **Access-control changes** — minting, revoking, or re-scoping an API key; creating a user or changing a role or status.
- **Configuration changes** — settings saved, and (separately) a password change.
- **High-impact operations** — a system backup or restore, a system update or rollback, and, on the Hub, adding, starting, removing, or updating an instance.
- **Permission denials** — a key or user hitting a route it isn't granted.

Routine autonomous trading (a bot opening or closing its own deals) is deliberately *not* here — that belongs to the trading log and Journal. The audit log is for security and administration, so it stays a signal, not a firehose.

Every audit point is a single call to one shared helper (`Common.auditEvent`), so adding or removing what gets recorded is a one-line change, and the same helper is used identically on a single instance and on the Hub.

### Watchdog

SymBot watches its own health on two levels. Every time it starts, a self-policing watchdog runs a full sweep of integrity checks — the set listed below. Separately, you can enable an hourly **Error sentinel** ([a scheduled task](#scheduled-tasks)) that keeps sweeping your logs while SymBot runs and alerts you when an error type is new or spiking.

The startup sweep's results are recorded in the Audit Log (a clean run logs one `watchdog.ok` entry; any problem is logged as a `watchdog` finding rather than going unnoticed), and its checks are warn-only — they surface issues, never block startup. They cover:

- Every state-changing route has a permission gate, and the gates are strong.
- The capability model is internally consistent.
- The AI assistant's tools are all read-only.
- The AI learning corpus still lines up with the current tool registry.
- Every AI tool's runtime handler has a matching schema (and no schema is left without a handler).
- Every scheduled task's `type` maps to a registered handler (so a task can't silently never run).
- The shipped recipe files are valid.
- Encrypted config secrets still decrypt with the current app password.
- The critical database indexes are present.
- No recent log line looks like it leaked an unredacted credential.
- The directories SymBot writes to — for settings, logs, and backups — are actually writable (a read-only disk, a permissions mistake, or a full disk would otherwise make config saves and backups fail quietly).
- None of this instance's data is still recorded under a previous Server ID after the ID changed (a reset or a restore that re-minted it) — such rows are re-homed to the current ID automatically at startup, and this flags any the re-home did not carry across (which would hide them from the instance and drop them from its backups).
- Once you have created user accounts, at least one is an active admin or owner (so you can't accidentally lock yourself out of Access Control).
- No active API key still carries a capability its owner can no longer grant (privilege that outlived the grant).
- No non-owner user account holds owner-level (full) access (the shape a privilege escalation would leave behind).
- The owner login password is not still the default (a network-exposed instance on the default password is a trivially-known credential).
- Every enabled schedule is primed to fire (an invalid time that got skipped when the scheduler armed at startup would otherwise silently never run).
- The scheduled database backup's last run did not fail (a quiet, always-visible reminder that this instance may have no fresh backup — it appears before a run of failures grows large enough to raise the louder consecutive-failure alert, and clears once a backup succeeds).
- The off-site (SFTP) copy of the backup is uploading successfully (its upload runs in the background and never fails the local backup, so a persistently failing off-site copy would otherwise be visible only in the logs; checked only when an off-site destination is configured, and clears once an upload succeeds).
- No open deal points at a bot that no longer exists (a deal whose bot was deleted would never be advanced).
- No two open deals exist for the same bot and pair (only one is allowed at a time, so a duplicate means the single-deal-start guard was bypassed and the loop would manage both against one pair).
- No open deal is left stuck with no filled orders after a short grace period (a half-started deal that never actually entered but still holds its bot's slot for that pair).
- The audit log's tamper-evident hash chain is unbroken (a break means a past entry was altered or removed).
- The IP allow/block filter can't be spoofed by a forged client-address header when SymBot sits behind a proxy.

Every finding comes with a clear explanation. In the startup log each warning is followed by a short "What it means" and "How to fix" line, and in the Audit Log you can hover the finding to see the same explanation — so a machine code like `watchdog.capability_drift` is never a dead end. New checks are registered the same way, so the set grows as the codebase does.

## API Information

Take more control of your bots and deals using SymBot APIs. You can easily enable or disable bots and start deals using triggers or signals from 3CQS, TradingView, your own custom scripts and strategies, or from any of your other favorite providers.

> **Prefer scoped API keys.** The recommended credential is a scoped API key created under **Access Control → API Keys** (see [Access Control](#access-control-users-api-keys--audit)) — each key is limited to exactly the capabilities you grant and can be revoked or rotated on its own. The original single per-instance API key (Configuration) still works for backward compatibility but is deprecated; new integrations should use scoped keys.

### Getting started

Everything below is one convention: send a request to your instance, authenticate with a scoped API key, and read the JSON response. Here is the whole flow in three steps.

**1. Note your base URL.** A standalone instance answers on its own port; the same instance behind [SymBot Hub](#symbot-hub) is reached through an `/instance/<port>` prefix. Every path in this reference is relative to whichever base URL applies to you:

| Setup | Base URL |
| --- | --- |
| Standalone instance | `http://127.0.0.1:3000` |
| Behind SymBot Hub | `http://127.0.0.1:3100/instance/3000` |
| Behind a reverse proxy (NGINX/Apache/Cloudflare) | `https://your-domain` (see [Reverse Proxy Setup](#reverse-proxy-setup)) |

**2. Create a key with just the capability you need.** For a signal source that opens deals, create a key under **Access Control → API Keys** with the single `deal.create` capability. Copy the `symb_live_…` value shown once at creation.

**3. Send your first request.** This end-to-end example opens a deal on an existing `api` (Signal Bot) — replace `{botId}` with the bot's id and `{API-KEY}` with your key:

```bash
curl -i -X POST \
  -H 'Content-Type: application/json' \
  -H 'api-key: {API-KEY}' \
  -d '{ "pair": "BTC/USD" }' \
  http://127.0.0.1:3000/api/bots/{botId}/start_deal
```

A successful call returns HTTP `200` with a JSON body whose `success` field is `true`. If the key lacks `deal.create` the call is refused with HTTP `403`; if the credential is missing or invalid, HTTP `401`. See [Errors](#errors) for the full list. The identical request works as a header-free [webhook](#webhooks) by prefixing `/webhook` and moving the credential into the body — handy for senders (like TradingView) that can't set headers.

### Authentication

Every request identifies its caller in one of three ways, checked in this order:

- **`api-key` header** — `-H 'api-key: symb_live_…'`
- **`Authorization: Bearer` header** — `-H 'Authorization: Bearer symb_live_…'`
- **Webhook body token** — `"apiToken": "…"` in the JSON body, for senders that can't set headers (see [Webhooks](#webhooks))

An API request that presents no valid credential is rejected with `401 Unauthorized`; a valid credential that lacks the capability the route requires is rejected with `403 Forbidden`. Both are returned as JSON so an integration can act on them directly (a browser session that has expired is redirected to the login page instead).

The presented credential resolves to a principal carrying a set of capabilities, and each route requires exactly one capability (deny-by-default) — a state-changing route requires the matching write/action capability, and a read (`GET`) endpoint requires the matching `*.read` capability (a "Read-only" key granting all `*.read` is the intended credential for a dashboard or monitor; holding a write capability implies its read). A scoped key carries only the capabilities you ticked; the legacy single key and the owner session carry all of them, and every user role from viewer up holds all reads — so the web UI and existing integrations are unaffected, and only a narrowly-scoped key is restricted. The full model is described under [Access Control](#access-control-users-api-keys--audit); the capability each action requires is:

| Action | Endpoint | Capability |
| --- | --- | --- |
| Open a deal | `POST /api/bots/{botId}/start_deal` | `deal.create` |
| Dispatch a signal | `POST /api/signal/{botId}` | `deal.create` — or `deal.close` for the `close` / `panic_sell` / `close_all` actions |
| Add funds to a deal | `POST /api/{deals\|bots}/{id}/add_funds` | `deal.create` |
| Update a deal | `POST /api/deals/{dealId}/update_deal` | `deal.create` |
| Pause a deal | `POST /api/deals/{dealId}/pause` | `deal.pause` |
| Cancel a deal | `POST /api/deals/{dealId}/cancel` | `deal.close` |
| Close a deal | `POST /api/{deals\|bots}/{id}/close` | `deal.close` |
| Panic-sell a deal | `POST /api/{deals\|bots}/{id}/panic_sell` | `deal.close` |
| Create / update a bot | `POST /api/bots/{create\|update}` | `bot.write` |
| Enable / disable a bot | `POST /api/bots/{botId}/{enable\|disable}` | `bot.write` |
| Delete a bot | `DELETE /api/bots/{botId}` | `bot.delete` |
| Read account balances | `POST /api/accounts[/{name}]/balances` | `account.read` |
| Change settings / schedules / backups | `POST /config`, `/api/schedules…`, `/system/…` | `settings.write` |
| Use AI features | `GET\|POST\|DELETE /api/ai/…` | `stats.read` |

A single startup watchdog verifies that every state-changing route is covered by one of these rules, so a new route can never ship ungated (a gap is recorded in the [Audit log](#audit-log)).

#### Rate limits

A scoped API key may be given an optional per-key rate limit (requests per minute) when you create it. While a limit is set, every response on that key carries the current window state, and once the limit is exceeded the request is rejected until the window rolls over:

| Header | Meaning |
| --- | --- |
| `X-RateLimit-Limit` | The key's configured requests-per-minute ceiling |
| `X-RateLimit-Remaining` | Requests left in the current 60-second window |
| `X-RateLimit-Reset` | Seconds until the window resets |
| `Retry-After` | Seconds to wait before retrying (sent only on a `429`) |

Exceeding the limit returns HTTP `429` with `{ "success": false, "error": "Rate limit exceeded (<n>/min)" }`. Keys with no limit set — and the owner session and legacy key — are never throttled, so existing integrations are unaffected until you opt a key in. (This is separate from the WebSocket API's fixed 5 concurrent in-flight requests per connection, described under [WebSocket API → Rate Limiting](#rate-limiting).)

#### Idempotency (safe retries)

A webhook that opens or modifies a deal can be made safely retryable so a network hiccup or a duplicate alert never acts twice. Attach an idempotency key one of these ways:

- An **`Idempotency-Key`** request header (for senders that can set headers), or
- An **`idempotency_key`** field in the JSON body, or
- A **`signal_id`** field in the JSON body — a repeated signal id is treated as the same request

If SymBot sees the same key again within 5 minutes, it skips reprocessing and returns HTTP `200` with `{ "success": true, "duplicate": true }` instead of opening a second deal. Send a fresh key per distinct action. De-duplication applies to the **`/webhook/…`** path (where replayed alerts occur); a direct `/api/…` call is not de-duplicated.

```bash
curl -i -X POST \
  -H 'Content-Type: application/json' \
  -d '{ "apiToken": "{API-TOKEN}", "pair": "BTC/USD", "idempotency_key": "alert-2026-08-14-0001" }' \
  http://127.0.0.1:3000/webhook/api/bots/{botId}/start_deal
```

### Errors

SymBot uses HTTP status codes for the transport/authorization layer and a `success` flag in the JSON body for the outcome of a request that reached the handler. A request can therefore return HTTP `200` while reporting `success: false` in the body (for example, an unknown bot id) — always check both.

| Status | Meaning | Typical cause |
| --- | --- | --- |
| `200 OK` | Request reached the handler | Read the body's `success` (`true`/`false`) and `data`/`error` for the result |
| `401 Unauthorized` | No or invalid credential | Missing/expired/disabled API key, or the API is disabled in Configuration |
| `403 Forbidden` | Authenticated but not permitted | The key/user lacks the capability the route requires |
| `429 Too Many Requests` | Per-key rate limit exceeded | Back off until `Retry-After`; see [Rate limits](#rate-limits) |
| `500 Internal Server Error` | Unexpected server error | Check the instance log; the body is `{ "success": false, "error": "Internal server error" }` |
| `503 Service Unavailable` | Instance not ready | Database unavailable or the system is paused (e.g. mid-restart); retry shortly |

A body-level failure always looks like `{ "success": false, "data": "<reason>" }` (or `"error"` for the auth/rate layer), so a client can branch on `success` uniformly across REST, webhooks, and the WebSocket API.

### Create bot
| Name                      | Type | Mandatory | Values (default) | Description                                                         |
|-------------------------------|----------|---------------|----------------------|-------------------------------------------------------------------------|
| botName                       | string   | NO            |                      | Bot name will be generated if omitted                                   |
| pair                          | array    | YES           |                      | List of pairs used for the bot                                          |
| active                        | boolean  | NO            | false                | Enabled: true / Disabled: false                                         |
| createStep                    | string   | NO            |                      | Set to "getOrders" to preview all DCA orders without creating the bot   |
| firstOrderAmount              | number   | YES           |                      | Initial or base order amount for each deal                              |
| dcaOrderAmount                | number   | YES           |                      | Amount for every additional DCA / safety order                          |
| dcaOrderStepPercent           | number   | YES           |                      | Price deviation percentage to open safety orders                        |
| dcaOrderSizeMultiplier        | number   | YES           |                      | Multiplies the amount of funds used by the last safety order            |
| dcaOrderStepPercentMultiplier | number   | YES           |                      | Multiplies the price deviation percentage used by the last safety order |
| dcaTakeProfitPercent          | number   | YES           |                      | Take profit percentage the bot will use to close successful deals       |
| dcaMaxOrder                   | integer  | YES           |                      | Maximum DCA / safety orders allowed per deal                            |
| dealMax                       | integer  | NO            |                      | Maximum deals allowed before bot is disabled. Set to 0 for unlimited (Can reset for multi-pair bots or when re-enabled) |
| pairMax                       | integer  | NO            |                      | Maximum pairs allowed to start per bot. Set to 0 for unlimited          |
| pairDealsMax                  | integer  | NO            |                      | Maximum number of same pair deals that can run concurrently. Default is maximum one deal per pair when empty or set to 0. |
| pairBotsDealsMax              | integer  | NO            |                      | Maximum number of same pair deals that can run concurrently including all other active bots. Default is unlimited in relation to other bots when empty or set to 0. |
| volumeMin                     | number   | NO            |                      | Minimum 24h volume (specified in millions) symbol must have to start    |
| dealCoolDown                  | integer  | NO            |                      | Wait a number of seconds before starting a new deal after the last one completes. Multi-pair bots will have different timers for each pair. |
| profitCurrency                | string   | NO            | quote                | Currency used for the profit when trading with this bot. Can be set to "base" or "quote". |
| startCondition                | string   | NO            | asap                 | Start deals using "*asap*" (bot opens deals on its own) or "*api*" (opens a deal only on an external signal). An "*api*" bot opens one deal per signal and does not auto-reopen after a deal completes — see [Signal Bot](#signal-bot) |

```
POST /api/bots/create
```

### Update bot
| Name                      | Type | Mandatory | Values (default) | Description                                                         |
|-------------------------------|----------|---------------|----------------------|-------------------------------------------------------------------------|
| botId                         | string   | YES           |                      | Bot ID to be updated                                                    |
| botName                       | string   | NO            |                      | Bot name will be generated if omitted                                   |
| pair                          | array    | YES           |                      | List of pairs used for the bot                                          |
| active                        | boolean  | NO            | false                | Enabled: true / Disabled: false                                         |
| firstOrderAmount              | number   | YES           |                      | Initial or base order amount for each deal                              |
| dcaOrderAmount                | number   | YES           |                      | Amount for every additional DCA / safety order                          |
| dcaOrderStepPercent           | number   | YES           |                      | Price deviation percentage to open safety orders                        |
| dcaOrderSizeMultiplier        | number   | YES           |                      | Multiplies the amount of funds used by the last safety order            |
| dcaOrderStepPercentMultiplier | number   | YES           |                      | Multiplies the price deviation percentage used by the last safety order |
| dcaTakeProfitPercent          | number   | YES           |                      | Take profit percentage the bot will use to close successful deals       |
| dcaMaxOrder                   | integer  | YES           |                      | Maximum DCA / safety orders allowed per deal                            |
| dealMax                       | integer  | NO            |                      | Maximum deals allowed before bot is disabled. Set to 0 for unlimited (Can reset for multi-pair bots or when re-enabled) |
| pairMax                       | integer  | NO            |                      | Maximum pairs allowed to start per bot. Set to 0 for unlimited          |
| pairDealsMax                  | integer  | NO            |                      | Maximum number of same pair deals that can run concurrently. Default is maximum one deal per pair when empty or set to 0. |
| pairBotsDealsMax              | integer  | NO            |                      | Maximum number of same pair deals that can run concurrently including all other active bots. Default is unlimited in relation to other bots when empty or set to 0. |
| volumeMin                     | number   | NO            |                      | Minimum 24h volume (specified in millions) symbol must have to start    |
| dealCoolDown                  | integer  | NO            |                      | Wait a number of seconds before starting a new deal after the last one completes. Multi-pair bots will have different timers for each pair. |
| profitCurrency                | string   | NO            | quote                | Currency used for the profit when trading with this bot. Can be set to "base" or "quote". |
| startCondition                | string   | NO            | asap                 | Start deals using "*asap*" (bot opens deals on its own) or "*api*" (opens a deal only on an external signal). An "*api*" bot opens one deal per signal and does not auto-reopen after a deal completes — see [Signal Bot](#signal-bot) |

```
POST /api/bots/update
```

### Get bots

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| active   | boolean  | NO            |                      | Enabled = true / Disabled = false |

```
GET /api/bots
```

### System health

Returns a JSON snapshot of the running instance: memory (context-aware — real RSS when standalone, attributed memory when running as a Hub worker), uptime, active deal count, CPU load (1/5/15-minute averages and core count), SymBot version, and host memory. No parameters.

```
GET /api/system/health
```

### Enable bot

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| botId    | string   | YES           |                      |                 |

```
POST /api/bots/{botId}/enable
```

### Disable bot

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| botId    | string   | YES           |                      |                 |

```
POST /api/bots/{botId}/disable
```

### Delete bot

Permanently deletes a bot and all of its deal history. The bot must have no active deals before it can be deleted. This action cannot be undone.

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| botId    | string   | YES           |                      |                 |

```
DELETE /api/bots/{botId}
```

### Update deal

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| dcaTakeProfitPercent| number        | NO                   |                      | Take profit percentage the bot will use to close successful deals       |
| dcaMaxOrder         | integer       | NO                   |                      | Maximum DCA / safety orders allowed per deal                            |
| dealLast            | boolean       | NO                   | false                | Prevents a new deal from starting after this deal completes. Setting only applies to this deal. If you have multiple deals running with the same pair, this will not affect the other deals. |
| profitCurrency      | string        | NO                   | quote                | Currency used for the profit when trading with this bot. Can be set to "base" or "quote". |

```
POST /api/deals/{dealId}/update_deal
```

### Add funds to deal

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| volume   | number   | YES           |                      | Add funds to a deal by placing a manual safety order |

```
POST /api/deals/{dealId}/add_funds
```

A deal can also be targeted by bot instead of by deal id. This is useful for external signal sources (such as TradingView alerts) that send a fixed message and do not know the deal id that was generated when the deal opened. When you use the bot endpoint, SymBot resolves the bot's currently active deal automatically.

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| volume   | number   | YES           |                      | Add funds to a deal by placing a manual safety order |
| pair     | string   | NO            |                      | Required only for multi-pair bots, to select which pair's active deal to add to |

```
POST /api/bots/{botId}/add_funds
```

The bot endpoint resolves to the bot's single active deal. If the bot has more than one active deal (for example a multi-pair bot when no `pair` is supplied, or a pair configured to run concurrent deals), the request is rejected with a message asking you to specify a pair or use the deal id endpoint, so funds are never added to the wrong deal.

### Pause deal

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| pause    | boolean  | NO            | false                | Pause or resume both buy and sell orders |
| pauseBuy | boolean  | NO            | false                | Pause or resume only buy orders |
| pauseSell| boolean  | NO            | false                | Pause or resume only sell orders |

```
POST /api/deals/{dealId}/pause
```

### Cancel deal

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| -        |          |               |                      | Cancels deal without selling any assets bought from previous orders |

```
POST /api/deals/{dealId}/cancel
```


### Panic sell deal

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| -        |          |               |                      | Closes deal and sells at current market price |

```
POST /api/deals/{dealId}/panic_sell
```

As with add funds, a deal can also be closed by bot instead of by deal id. SymBot resolves the bot's currently active deal automatically. This lets an external signal trigger an emergency close without knowing the deal id.

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| pair     | string   | NO            |                      | Required only for multi-pair bots, to select which pair's active deal to close |

```
POST /api/bots/{botId}/panic_sell
```

The bot endpoint resolves to the bot's single active deal. If more than one active deal matches, the request is rejected asking you to specify a pair or use the deal id endpoint, so the wrong deal is never closed.


### Close deal

Closes the active deal only if the profit target is met — that is, only when current profit has reached the deal's take profit target. If the target is not met, the deal is left open and nothing is sold. This is the graceful counterpart to [Panic sell deal](#panic-sell-deal): use it for a routine "sell" signal that must never realize a loss. There is deliberately no option to force an unconditional close through this endpoint — use panic sell for that.

Can be targeted by deal id, or by bot (SymBot resolves the bot's active deal automatically, so a signal can close a deal without knowing the deal id).

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| pair     | string   | NO            |                      | Required only for multi-pair bots (bot endpoint), to select which pair's active deal to close |

```
POST /api/deals/{dealId}/close
POST /api/bots/{botId}/close
```

The response includes a `closed` field so you can distinguish an actual close from "handled, but target not met":

```
{ "success": true, "closed": false, "data": "Profit target not met (current price below take-profit target); deal left open" }
```

### Signal dispatcher (single endpoint)

A convenience endpoint that routes to the per-action handlers from a single URL, so an integration can point every alert at one address and vary only the `action` field. It adds no new order behavior — each action performs exactly what its dedicated endpoint does.

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| action   | string   | YES           | entry, add_funds, close, panic_sell | Command to perform. `close_all` is accepted as an alias of `panic_sell` |
| pair     | string   | NO            |                      | Only required for multi-pair bots |
| volume   | number   | NO            |                      | Amount for the `add_funds` action |
| signalId | string   | NO            |                      | Optional identifier for the signal (used on `entry`) |

```
POST /api/signal/{botId}
```


### Get deal information

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| -        |          |               |                      | Get information for a deal |


```
GET /api/deals/{dealId}/show
```

### Get active deals

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| -        |          |               |                      | Returns all current active deals |

```
GET /api/deals
```

### Get completed deals

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| from     | string   | NO            |                      | Returns most recent completed deals if start from date is not specified |
| to       | string   | NO            |                      | Returns all completed deals up to end of date specified |
| timeZoneOffset      | string        | NO                   |                      | Query results based on a timezone offset. Default is UTC |
| botId    | string   | NO            |                      | Returns completed deals for specified bot id |

```
GET /api/deals/completed
```

### Export transactions (CSV)

Streams a per-transaction CSV of closed deals (buys, sells, and fees) formatted for import into cryptocurrency tax software such as Koinly, CoinTracker, or CoinLedger. Returns a downloadable CSV file rather than JSON. See the [Transaction Export](#transaction-export) section for details on the format and its limitations.

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| from     | string   | NO            |                      | Start date (YYYY-MM-DD). Exports all completed deals if not specified |
| to       | string   | NO            |                      | End date (YYYY-MM-DD). Defaults to the from date if not specified |
| timeZoneOffset | string | NO          |                      | Interpret the date range using this timezone offset. Default is UTC |
| botId    | string   | NO            |                      | Export transactions for the specified bot id only |
| includeSandbox | string | NO          | true, false (false)  | Include sandbox (paper-trading) deals. Excluded by default |

```
GET /api/deals/export/transactions
```

### Start deal

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| botId    | string   | YES           |                      |                 |
| signalId | string   | NO            |                      | Used to identify signal that started deal |
| pair     | string   | NO            |                      | Only required for multi-pair bots |


```
POST /api/bots/{botId}/start_deal
```

### Get account balances

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| -        |          |               |                      | Get all account asset balances |

```
POST /api/accounts/balances
```

### Get markets

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| exchange | string   | YES           |                      | Exchange to retrieve market data for |
| pair     | string   | NO            |                      | Symbol pair pricing and data to retrieve. Omitting will return all valid symbols for specified exchange |


```
GET /api/markets
```

### Get market OHLCV

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| exchange | string   | YES           |                      | Exchange to retrieve market data for |
| pair     | string   | YES           |                      | Symbol pair data to retrieve |
| timeframe| string   | NO            |                      | Timeframe or interval to use. Default is 5m |
| type     | string   | NO            | spot                 | Market type to retrieve. Use "swap" for futures / perpetual markets; anything else is treated as spot |
| since    | integer  | NO            |                      | Starting timestamp in milliseconds from which to retrieve data |
| limit    | integer  | NO            |                      | Limit the number of results to return |


```
GET /api/markets/ohlcv
```

### AI analyze deal

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| dealId   | string   | YES           |                      | Deal ID to analyze using AI |
| prompt   | string   | NO            |                      | Prompt to use for analysis |
| template | string   | NO            |                      | Template to use for analysis |


```
POST /api/ai/analyze_deal
```


### Show TradingView chart

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| jquery   | boolean  | NO            | true                 | Automatically add required jQuery script to display charts |
| script   | boolean  | NO            | true                 | Automatically add required TradingView script to display charts |
| containerId | string   | NO         |                      | Element id used for the TradingView chart container |
| theme    | string   | NO            | dark                 | Theme to be used can be "*light*" or "*dark*" |
| exchange | string   | NO            | binance              | Exchange to be used for chart |
| pair     | string   | NO            | BTC_USDT             | Symbol pair to be used for chart |
| width    | integer  | NO            |                      | Width of chart in pixels |
| height   | integer  | NO            |                      | Height of chart in pixels |

```
GET /api/tradingview
```

### System backup

| Name | Type | Mandatory | Values (default) | Description |
|----------|----------|---------------|----------------------|-----------------|
| password    | string   | YES           |                      | Password used to encrypt the backup archive. |
| include_chats | boolean | NO | true | Include AI chat history. |
| include_schedules | boolean | NO | true | Include scheduled tasks and their stored credentials. |
| include_config | boolean | NO | false | Include configuration (app settings + exchange keys + Hub config). Makes the backup portable but it then carries your keys. |

```
POST /api/system/backup
```

### Clear circuit breaker

Manually clears an active circuit breaker, immediately resuming normal deal processing. No parameters required.

```
POST /api/circuit-breaker/clear
```

## API Sample Usage

Below are examples demonstrating how to use SymBot APIs. When using [SymBot Hub](#symbot-hub), you should replace the base URL with the appropriate Hub instance path, such as `/instance/3000`.

For SymBot WebSocket APIs, the default endpoint path is `/ws`. When accessed through SymBot Hub, the WebSocket path is prefixed with the instance path, such as `/instance/3000/ws`.

#### Create bot
```
curl -i -X POST \
-H 'Content-Type: application/json' \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
-d '{
		"pair": [ "BTC/USD" ],
		"botName": "",
		"active": false,
		"createStep": "",
		"firstOrderAmount": 20,
		"dcaOrderAmount": 45,
		"dcaOrderStepPercent": 1.3,
		"dcaOrderSizeMultiplier": 1.08,
		"dcaOrderStepPercentMultiplier": 1.0,
		"dcaTakeProfitPercent": 1.5,
		"dcaMaxOrder": 46,
		"dealMax": 0,
		"profitCurrency": "quote",
		"startCondition": "asap"
	}' \
http://127.0.0.1:3000/api/bots/create
```

#### Update bot
```
curl -i -X POST \
-H 'Content-Type: application/json' \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
-d '{
		"pair": [ "BTC/USD", "ETH/USD" ],
		"botId": "{botId}",
		"botName": "",
		"active": false,
		"firstOrderAmount": 20,
		"dcaOrderAmount": 45,
		"dcaOrderStepPercent": 1.3,
		"dcaOrderSizeMultiplier": 1.08,
		"dcaOrderStepPercentMultiplier": 1.0,
		"dcaTakeProfitPercent": 1.5,
		"dcaMaxOrder": 46,
		"dealMax": 0,
		"profitCurrency": "quote",
		"startCondition": "api"
	}' \
http://127.0.0.1:3000/api/bots/update
```

#### Get DCA orders without creating bot
```
curl -i -X POST \
-H 'Content-Type: application/json' \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
-d '{
		"pair": [ "BTC/USD" ],
		"createStep": "getOrders",
		"firstOrderAmount": 20,
		"dcaOrderAmount": 45,
		"dcaOrderStepPercent": 1.3,
		"dcaOrderSizeMultiplier": 1.08,
		"dcaOrderStepPercentMultiplier": 1.0,
		"dcaTakeProfitPercent": 1.5,
		"dcaMaxOrder": 46
	}' \
http://127.0.0.1:3000/api/bots/create
```

#### Get bots
```
curl -i -X GET \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
'http://127.0.0.1:3000/api/bots?active=true'
```

#### System health
```
curl -i -X GET \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
http://127.0.0.1:3000/api/system/health
```

#### Enable bot
```
curl -i -X POST \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
http://127.0.0.1:3000/api/bots/{botId}/enable
```

#### Disable bot
```
curl -i -X POST \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
http://127.0.0.1:3000/api/bots/{botId}/disable
```

#### Delete bot
```
curl -i -X DELETE \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
http://127.0.0.1:3000/api/bots/{botId}
```

#### Update deal
```
curl -i -X POST \
-H 'Content-Type: application/json' \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
-d '{
		"dcaTakeProfitPercent": 1.5,
		"dcaMaxOrder": 12,
		"profitCurrency": "base"
	}' \
http://127.0.0.1:3000/api/deals/{dealId}/update_deal
```

#### Add funds to deal
```
curl -i -X POST \
-H 'Content-Type: application/json' \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
-d '{
		"volume": 25
	}' \
http://127.0.0.1:3000/api/deals/{dealId}/add_funds
```

Or target the bot's active deal instead of a deal id (include `pair` only for multi-pair bots):

```
curl -i -X POST \
-H 'Content-Type: application/json' \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
-d '{
		"volume": 25,
		"pair": "BTC/USD"
	}' \
http://127.0.0.1:3000/api/bots/{botId}/add_funds
```

#### Pause deal
```
curl -i -X POST \
-H 'Content-Type: application/json' \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
-d '{
		"pause": true,
		"pauseBuy": false,
		"pauseSell": false
	}' \
http://127.0.0.1:3000/api/deals/{dealId}/pause
```

#### Cancel deal
```
curl -i -X POST \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
http://127.0.0.1:3000/api/deals/{dealId}/cancel
```


#### Panic sell deal
```
curl -i -X POST \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
http://127.0.0.1:3000/api/deals/{dealId}/panic_sell
```

Or target the bot's active deal instead of a deal id (include `pair` only for multi-pair bots):

```
curl -i -X POST \
-H 'Content-Type: application/json' \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
-d '{
		"pair": "BTC/USD"
	}' \
http://127.0.0.1:3000/api/bots/{botId}/panic_sell
```

#### Get deal information
```
curl -i -X GET \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
'http://127.0.0.1:3000/api/deals/{dealId}/show'
```

#### Get active deals
```
curl -i -X GET \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
'http://127.0.0.1:3000/api/deals'
```

#### Get completed deals
```
curl -i -X GET \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
'http://127.0.0.1:3000/api/deals/completed?from=2023-03-01&timeZoneOffset=-00:00'
```

#### Export transactions (CSV)
```
curl -i -X GET \
-H 'Accept: text/csv' \
-H 'api-key: {API-KEY}' \
-o transactions.csv \
'http://127.0.0.1:3000/api/deals/export/transactions?from=2023-01-01&to=2023-12-31&timeZoneOffset=-00:00'
```

#### Start deal
```
curl -i -X POST \
-H 'Content-Type: application/json' \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
-d '{ "pair": "BTC/USD" }' \
http://127.0.0.1:3000/api/bots/{botId}/start_deal
```

#### Get account balances
```
curl -i -X POST \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
http://127.0.0.1:3000/api/accounts/balances
```

#### Get markets
```
curl -i -X GET \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
'http://127.0.0.1:3000/api/markets?exchange=binance&pair=BTC_USDT'
```

#### Get market OHLCV
```
curl -i -X GET \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
'http://127.0.0.1:3000/api/markets/ohlcv?exchange=binance&pair=BTC_USDT'
```

#### AI analyze deal
```
curl -i -X POST \
-H 'Content-Type: application/json' \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
-d '{ "dealId": "BTC_USD-1A2B3C4-1700000000" }' \
http://127.0.0.1:3000/api/ai/analyze_deal
```

#### TradingView chart
```
http://127.0.0.1:3000/api/tradingview?script=true&exchange=binance&pair=BTC_USDT&theme=dark&width=1000&height=600
```

#### System backup
```
curl -X POST http://127.0.0.1:3000/api/system/backup \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
-d '{"password": "encryption_password", "include_config": false}' \
-o SymBot_Backup.zip.enc
```

#### Clear circuit breaker
```
curl -i -X POST \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
http://127.0.0.1:3000/api/circuit-breaker/clear
```

## WebSocket API


WebSocket APIs use the same parameters as the REST APIs, so the same requests can be reused without any changes.

WebSockets are useful when you want a continuous, live connection to the server. After connecting once, updates can be sent automatically in real time, instead of the client having to make repeated requests. This is especially helpful for live deal activity, market data, and notifications, and can be more efficient than using REST alone.

### Registration

Before using the WebSocket APIs, the application must first connect using your SymBot API key and register itself by emitting the `register_client` event. The server will acknowledge successful registration via a callback. Only after successful registration can the client send `api_action` events.

```js
socket.emit("register_client", { appId }, (ack) => {
  if (ack?.success) {
    console.log("Registered — ready to use WebSocket APIs");
  }
});
```

### Rate Limiting

Each connected client is limited to 5 concurrent in-flight requests. If a client sends more requests than this before previous ones have completed, the excess requests will be rejected immediately with an error response. This prevents a single client from overloading the server or exchange APIs.

### Timeouts

Each API request has a 15-second timeout. If the server or exchange does not respond within this window, the request is rejected and an error is returned to the client. The client does not need to implement its own timeout.

### Error Handling

Every `api_action` is guaranteed a response — both successful results and errors use the same response structure. Always check the `error` field before using the `message` field.

```js
socket.on("data", (msg) => {
  if (msg.type === "api") {
    if (msg.error) {
      console.error("API error:", msg.error);
    } else {
      console.log("Result:", msg.message);
    }
  }
});
```

### Response Structure

| Field | Description |
|-------|-------------|
| `type` | Always `"api"` for API responses |
| `api` | The API name that was requested |
| `app_id` | The `appId` sent by the client |
| `message_id` | A unique server-generated ID for this response |
| `message_id_client` | The `id` sent by the client in `meta`, for correlating responses to requests |
| `message` | The result data, or `null` if an error occurred |
| `error` | Error message string, or `null` if the request succeeded |

### Available APIs

| API | Description | Parameters |
|-----|-------------|------------|
| `deals` | Returns all active deals | — |
| `deals/show` | Returns details for a single deal | `dealId` (string, required) |
| `deals/completed` | Returns completed deals | `from` (string, optional), `to` (string, optional), `timeZoneOffset` (string, optional), `botId` (string, optional) |
| `bots` | Returns all bots | `active` (boolean, optional) |
| `balances` | Returns account balances for all configured exchanges | — |
| `markets` | Returns market ticker data | `exchange` (string, required), `pair` (string, optional) |
| `markets/ohlcv` | Returns OHLCV candle data | `exchange` (string, required), `pair` (string, required), `timeframe` (string, optional), `type` (string, optional — "swap" for futures, else spot), `since` (integer, optional), `limit` (integer, optional) |

### Example

Below is a complete Node.js example demonstrating how to connect, register, and use the WebSocket APIs with proper error handling.

```js
const { io } = require("socket.io-client");
const crypto = require("crypto");

const apiKey = "{API-KEY}";
const appId = "App-" + crypto.randomUUID().slice(0, 6);

const useHub = false; // set to true when using SymBot Hub

const host = useHub
  ? "http://127.0.0.1:3100"
  : "http://127.0.0.1:3000";

const path = useHub
  ? "/instance/3000/ws"
  : "/ws";

const socket = io(host, {
  path,
  extraHeaders: { "api-key": apiKey },
  transports: ["websocket", "polling"]
});

socket.on("connect", () => {

  // Register before sending any api_action events.
  // Wait for the acknowledgment before proceeding.
  socket.emit("register_client", { appId }, (ack) => {

    if (!ack?.success) {
      console.error("Registration failed");
      return;
    }

    socket.emit("joinRooms", { rooms: ["logs", "notifications"] });

    socket.emit("api_action", {
      meta: {
        id: crypto.randomUUID(),
        appId,
        api: "deals"
      }
    });
  });
});

socket.on("data", (msg) => {
  if (msg.type === "api") {
    if (msg.error) {
      console.error("API error [" + msg.api + "]:", msg.error);
    } else {
      console.log("API result [" + msg.api + "]:", msg.message);
    }
  }
});
```


## Webhooks

A webhook is like a special type of API. While APIs rely on one program asking for data and waiting for a response, webhooks work differently. They instantly send data from one program or service to another when a specific event happens. This eliminates the need for manual requests and makes data sharing between software systems smoother and faster.

SymBot makes using webhooks easy because they're nearly identical to API usage. Because many services (such as TradingView) cannot send custom HTTP headers, a webhook carries its credential in the JSON body as `apiToken` instead of in the header — which is what makes SymBot webhooks easy to integrate with third parties.

**Two credentials work, and you can mix them freely:**

- **A scoped API key (recommended).** Create one under **Access Control → API Keys** with the `deal.create` capability and use it as the `apiToken`. Because it is an ordinary scoped key you can name it, limit it to exactly the actions a signal needs, and revoke or rotate it on its own at any time without affecting anything else — ideal for a per-source signal credential (one key per TradingView alert set, for example). A scoped key may also be sent as an `api-token`/`api-key` header when your sender supports headers, which keeps it out of request-body logs; the header is checked before the body.
- **The legacy Webhook API Token.** The original per-instance token (shown in **Configuration → Webhook API Token**) still works exactly as before. It is derived from your API key and updates automatically whenever you regenerate the key or change your server id, so existing integrations keep working with no changes. It is deprecated, however; new signal sources should use a scoped API key.

> SymBot's own built-in signals client (the 3CQS client) uses a protected internal scoped key that SymBot provisions for itself automatically — you'll see it listed as a *system* key under Access Control, scoped only to opening deals (the `deal.create` capability) since that is all a signal source needs; it holds none of the read, bot-management, or settings capabilities. It needs no setup and cannot be revoked from the UI (it re-provisions on start), so built-in signals work out of the box on a fresh install just as they always have.

Since SymBot webhooks are layered on top of the APIs, you only need to prepend /webhook to the URL and supply your token. For example, let's say you wanted to start a new deal using a webhook. This is how the request would look:

```
curl -i -X POST \
-H 'Content-Type: application/json' \
-H 'Accept: application/json' \
-d '{
		"apiToken": "{API-TOKEN}",
		"pair": "BTC/USD"
	}' \
http://127.0.0.1:3000/webhook/api/bots/{botId}/start_deal
```

From this example you can see there are only three differences from SymBot APIs:

- Prepend /webhook to the URL
- Put your credential in the apiToken field of the body (a scoped API key or the legacy Webhook API Token) instead of an `api-key` header

Remember if you ever change your API key or alter your server id, the legacy Webhook API Token changes automatically to match — you can view it in the SymBot web interface configuration section. A scoped API key is independent: regenerating your API key does not affect it, and you revoke or rotate it yourself under Access Control.

> **Circuit Breaker and webhooks:** If the circuit breaker is active when a `start_deal` webhook fires, SymBot returns `{ "success": false, "data": "Circuit Breaker Active: <reason>" }`. The deal is not created and the base order is not queued — your integration must handle this response and retry after the circuit breaker clears (default 60 seconds). This is intentional: SymBot cannot guarantee entry at the intended price if the base order were queued and placed after an unknown delay.

### Signal Bot

A Signal Bot is an ordinary DCA bot that is driven by external alerts instead of by its own internal price logic. It is the point-and-click way to set up everything described in [Using TradingView](#using-tradingview): instead of hand-writing JSON or looking up a deal id, the bot's create/edit page builds the copy-paste alert messages for you.

Your DCA bot works exactly as it always has — a Signal Bot is optional. It simply lets an outside source (a TradingView alert, or any service that can POST a webhook) tell the bot *when* to enter, add a safety order, or close. SymBot still owns the deal, the safety-order ladder, and the exits; the alert only says "now."

#### The Signal Bot panel

On any bot's create or edit page, tick Signal Bot mode. This:

- Sets the bot's Start Condition to *Manually / API* so it opens deals only when a signal arrives.
- Generates the ready-to-paste webhook URL and message for each command, pre-filled with the bot's id. A Single-pair bot toggle drops the `pair` line for the simplest setup, and an optional Fill in my token toggle inserts your legacy per-instance webhook token into the messages.

Tip: set Max Safety Orders to `0` for a fully signal-driven bot (every safety order comes from an `add_funds` signal), or leave it non-zero for a hybrid where the bot places some automatically.

Two placeholders appear in the generated messages: `{{ticker}}` is filled in automatically by TradingView with the chart's symbol — leave it exactly as-is. `{{YOUR_TOKEN}}` is yours to replace with a credential; it is *not* a TradingView variable.

For that credential, use a **scoped API key**, created under **Access Control → [API Keys](#api-keys)**. When you create the key, tick **Start deals** — that single permission covers both the entry and add-funds signals; also tick **Close / cancel deals** if your alerts send the `close` or `panic_sell` commands. (In the key's permission list these appear under friendly names; they map to the `deal.create` and `deal.close` capabilities, which is what you'd name when scripting.) This is the recommended choice: a scoped key can be limited to exactly what a signal needs and revoked or rotated on its own without disturbing anything else. The signal webhook accepts it either in an `api-key`/`api-token` header (as the Signal Bot panel's own copy uses) or in the `apiToken` field of the message body (for senders like TradingView that cannot set custom headers). The legacy per-instance webhook token is still accepted (this is what the Fill in my token toggle inserts), but because it follows your main API key, regenerating that key changes it and so changes every signal setup at once — one more reason to prefer a scoped key per signal source.

You do not have to worry about the exact symbol format. TradingView sends the chart symbol in its own style (for example `BTCUSD`, or `COINBASE:BTC-USD`), and SymBot matches that back to the bot's configured pair (`BTC/USD`) automatically, so a multi-pair alert using `{{ticker}}` finds the right pair without any hand-formatting. The match is exact and unambiguous: a ticker is only accepted when it maps to exactly one of the bot's own configured pairs, and an unrecognized symbol is rejected rather than guessed at.

#### Command vocabulary

| Command | What it does | Endpoint |
|---|---|---|
| `entry` | Open a deal (base order) | `POST /webhook/api/bots/{botId}/start_deal` |
| `add_funds` | Add one safety order to the active deal | `POST /webhook/api/bots/{botId}/add_funds` |
| `close` | Graceful close — closes only if the profit target is met, otherwise leaves the deal open | `POST /webhook/api/bots/{botId}/close` |
| `panic_sell` | Emergency close — sells at market now, ignoring profit | `POST /webhook/api/bots/{botId}/panic_sell` |

`close` and `panic_sell` are deliberately different. `close` always respects your Target Profit %, so a routine "sell" signal can never dump a deal at a loss — if the target is not yet met the deal is simply left open. `panic_sell` is the emergency red button: it closes immediately at market and may realize a loss. Wire your everyday exit to `close`; reserve `panic_sell` for hard-stop conditions.

#### One deal per signal

A Signal Bot (Manually / API start condition) opens one deal per signal. When a deal completes it does not automatically re-open — the bot stays enabled and waits for the next entry signal. This differs from `asap` and provider-signal bots (such as 3CQS), which continue opening deals on their own.

#### Single signal endpoint (optional)

Rather than a separate URL per command, you can point every alert at one dispatcher URL and vary only an `action` field:

```
POST /webhook/api/signal/{botId}
{
	"apiToken": "{API-TOKEN}",
	"action": "entry" | "add_funds" | "close" | "panic_sell",
	"pair": "BTC/USD",     // optional for single-pair bots
	"volume": 20           // for add_funds
}
```

This is a convenience layer over the per-command endpoints above and adds no new behavior. `close_all` is also accepted as an alias of `panic_sell`. See [Signal dispatcher](#signal-dispatcher-single-endpoint).

#### Signal Bots under SymBot Hub

When you open an instance through [SymBot Hub](#symbot-hub) (via `/instance/<port>/…`), the Signal Bot panel builds each webhook URL with that same `/instance/<port>` prefix, so the alert routes through the Hub to the correct instance — copy it as-is. The Hub's own combined bot editor builds the very same copy-paste cards: each URL uses the `/instance/<port>` prefix so the webhook is routed through the Hub to the right instance (the instance still authenticates it with your token), and the address is taken from whatever domain you reach the Hub on, so your own domain and HTTPS are reflected automatically. Copy the alerts as shown, from either place.

For the full alert-by-alert walkthrough of the flow above, continue to [Using TradingView](#using-tradingview) below.

### Using TradingView

TradingView alerts can drive SymBot directly over webhooks. Because a TradingView alert sends a fixed message that you write ahead of time, every value in the request must be known when you create the alert — a bot id, a pair, your credential (a scoped API key with **Start deals** ticked is recommended; the legacy webhook token also works — see [Signal Bot](#signal-bot)), and a volume are all fixed values, so they work well. The one thing a TradingView alert cannot know is the deal id that SymBot generates when a deal opens. For that reason, the deal actions used here are targeted by bot, not by deal id (see [Add funds to deal](#add-funds-to-deal) and [Panic sell deal](#panic-sell-deal)), so your alerts never need a deal id.

A common setup is to let TradingView decide when to buy the base order and when to add each safety order, while SymBot still handles the take profit exit automatically. This section walks through that scenario end to end.

#### 1. Configure the bot

Create (or update) a bot with two key settings:

- `startCondition` set to `api` so the bot only opens a deal when it receives a signal, rather than on its own.
- `dcaMaxOrder` set to `0` so the bot places no automatic safety orders. Every safety order will instead come from a TradingView signal. (If you would rather have TradingView add *some* orders on top of a few automatic ones, set this to the number of automatic orders you want instead of `0`.)

Leave `dcaTakeProfitPercent` set to your desired target — the bot will still close the deal automatically when the target is reached, with no signal required.

```
curl -i -X POST \
-H 'Content-Type: application/json' \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
-d '{
		"pair": [ "BTC/USD" ],
		"botName": "TradingView BTC",
		"active": true,
		"firstOrderAmount": 20,
		"dcaOrderAmount": 20,
		"dcaOrderStepPercent": 1.0,
		"dcaOrderSizeMultiplier": 1.0,
		"dcaOrderStepPercentMultiplier": 1.0,
		"dcaTakeProfitPercent": 1.5,
		"dcaMaxOrder": 0,
		"startCondition": "api"
	}' \
http://127.0.0.1:3000/api/bots/create
```

Note the `botId` returned when the bot is created — you will use it in every TradingView alert below.

#### 2. Entry signal — open the deal (base order)

In TradingView, create an alert for your entry condition and set its Webhook URL to your SymBot address ending in `/webhook/api/bots/{botId}/start_deal`. Paste this into the alert Message field:

```
{
	"apiToken": "{API-TOKEN}",
	"pair": "BTC/USD"
}
```

When the alert fires, SymBot opens a new deal and places the base order. `pair` may be omitted for a single-pair bot; include it for multi-pair bots so the correct pair is used.

#### 3. Safety order signal — add funds to the open deal

Create a second alert for your "add a safety order" condition, with its Webhook URL ending in `/webhook/api/bots/{botId}/add_funds` and this Message:

```
{
	"apiToken": "{API-TOKEN}",
	"pair": "BTC/USD",
	"volume": 20
}
```

Each time this alert fires, SymBot places a manual safety order of `volume` on the bot's active deal. You can reuse the same alert as many times as your strategy needs. `pair` is only needed for multi-pair bots.

#### 4. Take profit — automatic

No signal is required to take profit. The bot closes the deal automatically when it reaches `dcaTakeProfitPercent`, using the average price across the base order and every safety order that was added.

#### 5. Normal close on a signal (optional)

If you want a TradingView "sell" signal to close the deal — but only when it is actually in profit — use the graceful close command. Create an alert with its Webhook URL ending in `/webhook/api/bots/{botId}/close` and this Message:

```
{
	"apiToken": "{API-TOKEN}",
	"pair": "BTC/USD"
}
```

When it fires, SymBot closes the deal only if it has reached your `dcaTakeProfitPercent` target; if it has not, the deal is left open and nothing is sold. This makes it safe to wire to a routine sell condition — unlike panic sell, `close` can never realize a loss. See [Close deal](#close-deal).

#### 6. Emergency close (optional)

If you want a way to force-close a deal at the current market price from TradingView — for example on a hard stop condition — create an alert with its Webhook URL ending in `/webhook/api/bots/{botId}/panic_sell` and this Message:

```
{
	"apiToken": "{API-TOKEN}",
	"pair": "BTC/USD"
}
```

> **Use panic sell only for emergencies.** It closes the deal immediately at the current market price, which may realize a loss. It is not a normal exit — routine profitable exits should be left to the bot's take profit target. Do not wire panic sell to your everyday sell condition.

#### Notes and limits

- **One active deal per pair.** By default a bot runs a single active deal per pair, so targeting by bot (and pair, for multi-pair bots) is unambiguous. If you have configured a pair to run concurrent deals, the bot endpoints cannot tell which deal you mean and will reject the request — in that case use the deal id endpoints with a deal id obtained from `GET /api/deals`.
- **Circuit breaker.** The circuit breaker note above applies to `start_deal` here too. If it is active, the entry is rejected and must be retried after it clears.
- **Security.** Your webhook token is the only credential in these requests, so treat it like a password: use HTTPS for your public SymBot URL and keep your alert messages private. If you change your API key or server id, the token changes automatically and you must update your alerts.
- **Testing first.** Before wiring up TradingView, confirm each request works with `curl` (prepend `/webhook` and put `apiToken` in the body, exactly as the alert will), and watch the deal open, receive funds, and close in the SymBot interface.
- **Confirming what a signal did.** Once alerts are firing live, the [Signal Activity](#signal-activity) page records every inbound signal and what SymBot did with it, so you never have to guess whether an alert arrived or why a deal did or did not open.

### Signal Activity

TradingView fires a webhook and moves on — it never shows you SymBot's reply. Signal Activity is a read-only record of every inbound Signal Bot signal and exactly what SymBot did with it, so you can confirm after the fact whether an alert arrived and why a deal did or did not open. Open it from the sidebar (Signal Activity) on any instance.

It covers every source that drives a bot through a webhook signal — a TradingView Signal Bot alert, the built-in 3CQS client, or your own script — in one place. Each row shows:

- Date — when the signal was received.
- Action — entry, add funds, close, or panic sell.
- Source — the channel the signal arrived on: 3CQS, Signal Bot (a TradingView or webhook alert), API (a manual call), or any other source. New sources appear automatically as they are seen.
- Bot and Pair — which bot and pair it targeted.
- Outcome — one of: Started (a deal opened), Processed (the action ran — for example a safety order was added, or a graceful close that was left open because the profit target was not yet met), Rejected (SymBot declined it), or Duplicate (a repeated alert ignored by idempotency).
- Reason — the plain-language detail: the new deal id, or exactly why it was rejected (a blacklisted pair, a pair limit, an active circuit breaker, insufficient funds, and so on).
- Source IP — where the signal came from. An internal 3CQS signal shows as a local address; an external TradingView alert shows its own address.
- Latency — how long SymBot took to reply to the signal. For an entry signal this includes the wait for the deal to open through the serial deal-start queue (up to about 30 seconds), so a high value usually means signals are queuing during a burst, not a network problem. A summary line above the table shows the average, p95, and max for the current filter and flags how many were slow.
- Deal ID — the deal the signal opened or acted on.

Filter by bot, source, action, outcome, or date range to narrow things down.

Entries are kept for up to 30 days and then removed automatically. A few details:

- **Fair per source** — each channel keeps its own recent history independently, so a high-volume feed (for example a busy 3CQS setup) can only ever trim its own older rows; it never pushes your rarer Signal Bot signals out of the log early.
- **Tunable** — the per-source row budgets have sensible defaults and can be adjusted in `config/app.json` under `signal_activity.retention` (each source has a `max_rows`, with a `default` used for any source you have not listed).
- **Separate under the Hub** — each instance's Signal Activity is kept separate, so instances sharing one database never see or prune each other's signals.

One thing worth knowing for troubleshooting: only authenticated signals are recorded. A signal is logged after its token has been accepted, so if an alert is not appearing at all, the cause is almost always that webhooks are disabled or the alert is using the wrong token — the request never authenticated, so there is nothing to record. This mirrors how other platforms behave: no log entry means the connection or the token is the problem.

The same data is available over the API for a `curl` client or your own dashboard:

```
GET /api/signals/activity?botId={botId}&source=signal_bot&action=entry&outcome=rejected&from=2026-08-01&to=2026-08-19
```

All parameters are optional. The endpoint is read-only and requires the `deal.read` capability — a browser session, the legacy single API key, or a scoped key that holds `deal.read`.

## Backup and Restore Features

SymBot has built-in System Backup and restore. You can create an encrypted backup from the web interface (System menu), programmatically through the API, or on a schedule, and restore one just as easily. Every backup is a single archive encrypted with a password you choose — you need that same password to restore it.

While a backup is being created, SymBot briefly pauses its trading activity so the snapshot captures everything at one consistent moment (if you refresh a page during this time you may see a short "database backup processing" message). The pause is usually only a few seconds — it scales with how much data you have — and anything that comes due during it, such as a sell, a take-profit, or a safety order, is delayed until the backup finishes rather than skipped. Trading resumes on its own the instant the backup completes.

#### What a backup contains

A backup always includes your database — bots, deals, trade history, and the rest of your trading data. Three things are optional, each a toggle in the backup dialog (and, for scheduled backups, in Configuration → System Backups):

- *Include AI chats* — your saved AI conversation history.
- *Include schedules* — your scheduled tasks and the backup job itself, including any stored SFTP/backup credentials.
- *Include configuration* — your configuration files: the app configuration (`app.json`), the bot configuration (`bot.json`, which holds your encrypted exchange API keys), and, under the Hub, `hub.json`. This is off by default. Turning it on makes the backup a complete, portable recovery unit, but the archive then carries your exchange keys and app-password hash, so keep it as protected as the server it came from. Because those secrets are encrypted with a key derived from your app password, a configuration-bearing backup only opens on a server that uses the same app password.

  **Under the Hub**, each instance is backed up individually and captures *its own* config files under their actual names — an instance configured to use `app-NE.json` and `bot-NE.json` backs up exactly those (a Hub typically gives each instance its own bot configuration, while the app configuration may be shared). On restore those are written back to the same names, so recovering one instance never overwrites another instance's own app or bot config, and the app and bot config are only ever applied together (the bot config's encrypted keys need the matching app password), never one without the other. The shared `hub.json` — which lists every instance — is handled specially: an existing one is **never overwritten**, so restoring a single instance can't revert the Hub's instance list or drop sibling instances (it is only restored to seed a machine that has none yet). A full Hub recovery therefore means restoring each instance's own backup.

Scheduled backups never bundle configuration unless you explicitly enable it, so a routine off-site (SFTP) upload does not ship your exchange credentials off the machine by accident.

#### Restoring

To restore, you provide the archive's encryption password. Before anything in your database is touched, SymBot verifies the archive against its manifest — every file's checksum is checked, and any file that is missing, altered, or not listed is rejected — so a corrupted or tampered archive is refused while your live data is still intact. The backup's version is also compared to the running version; a mismatch is noted as a caution and the restore still proceeds, so you can restore an older backup after an upgrade. The restore also parses the entire backup into memory before it writes anything, and if a restore ever fails after it has begun writing, the instance shuts down rather than resume trading on partially restored data.

The restore dialog mirrors the backup options. *Restore schedules* (off by default) overwrites this instance's schedules and their stored credentials with the archive's. *Restore configuration* (off by default, and only meaningful if the backup included configuration) overwrites this server's settings, exchange keys, and app password with the backup's — all together, so you never end up with a mismatched `app.json` and bot config whose secrets cannot decrypt. After a configuration restore you sign in with the app password from the *source* server, and the boot-time secret check confirms the restored keys decrypt.

#### Disaster recovery and cloning to another server

A configuration-included backup is what makes a backup a true recovery unit. With only a database backup, restoring onto a fresh host brings back your bots and deals but not your exchange credentials (which live in the config files) or your app password — so trading cannot resume from that archive alone. Including configuration closes that gap: the one encrypted archive carries everything needed to stand the instance back up.

The same mechanism lets you seed a test or staging server from a production backup in one step — take a backup with configuration on, move the archive to the other machine, and restore it with *Restore configuration* on. The target becomes a clone of the source (sign in with the source's app password). If you plan to run the clone alongside the original, use *Reset server ID* and a separate database so the two stay independent.

#### Importance of regular backups

Regular backups protect your trading data and the continuity of your strategies. Back up before any significant change to your settings or strategies, and store your encryption password securely — it is required to restore. If you rely on off-site backups to recover from a lost host, take at least one backup with configuration included and keep it somewhere safe, so a complete rebuild is always possible.


## Reset or Configure SymBot

SymBot can be configured, reset, and recovered from the command line using several commands. The most common are:

1.  **Enable Configuration Mode**: This option allows you to easily update your database URL and other settings through the web interface.

2.  **Reset the Entire Database**: Use this option if you need to reset all data within SymBot.

3.  **Reset the Server ID**: If you want to migrate an existing SymBot database to a different server or instance, you can reset just the server ID.

The full set of reset and recovery commands — including more targeted resets (login sessions, AI chat history) and the Access Control recovery commands for when you are locked out of the web interface — is described in the sections below.

To reset the SymBot database or server ID, you must use the command line. The system will first prompt you for confirmation, display a reset code that you must enter, and then require another confirmation to proceed.

#### Configuration mode
1. Stop any running instances of SymBot
2. Type: `npm start config` (or `node symbot.js config`)

#### Reset database
##### *** CAUTION *** This will purge all data from the SymBot database!

1. Stop any running instances of SymBot
2. Type: `npm start reset` (or `node symbot.js reset`)

#### Reset server ID only

1. Stop any running instances of SymBot
2. Type: `npm start reset serverid` (or `node symbot.js reset serverid`)

#### Reset login sessions only

1. Stop any running instances of SymBot
2. Type: `npm start reset sessions` (or `node symbot.js reset sessions`)

#### Reset AI chat history only

1. Stop any running instances of SymBot
2. Type: `npm start reset aichats` (or `node symbot.js reset aichats`)

#### Access Control recovery (lockout escape hatch)

These commands recover access if you are ever locked out of the web interface — for example, if the only owner account was disabled or misconfigured. They affect only the Access Control data (users, API keys, and the audit log); bots, deals, and settings are untouched. Each still requires the same confirm → reset code → confirm sequence.

- **Reset the login password** back to the default `admin` and clear all users (the initial owner is re-seeded from the new password the next time SymBot starts):
	- `npm start reset password` (or `node symbot.js reset password`)
- **Reset users only** — clear all users and roles (the initial owner is re-seeded from your configured password on the next start):
	- `npm start reset users` (or `node symbot.js reset users`)
- **Reset API keys only** — revoke and remove every scoped API key:
	- `npm start reset apikeys` (or `node symbot.js reset apikeys`)
- **Clear IP filters** — disable the server-wide and login IP allow/block lists if a rule locked you out of the web UI (your lists are preserved, just no longer enforced, so you can correct them). This one relaxes access only and asks for no confirmation:
	- `npm start reset ipfilter` (or `node symbot.js reset ipfilter`)

The same recovery commands exist on the Hub for its own SQLite-backed Access Control data:

- `node symbot-hub.js reset password` — reset the Hub login password to `admin` and clear Hub users
- `node symbot-hub.js reset users` — clear Hub users and roles
- `node symbot-hub.js reset apikeys` — remove all Hub API keys
- `node symbot-hub.js reset audit` — clear the Hub audit log

A snapshot of the Hub database is taken automatically before any of these Hub resets, so the action itself is recoverable from `data/hub/backups`.

### Running more than one instance from the same install

By default SymBot reads `config/app.json`, `config/bot.json`, and `config/server.json`. To run a second standalone instance from the same install — each with its own config files and database — pass alternate config files as command-line arguments (SymBot is configured via arguments, never environment variables):

```bash
node symbot.js --app-config app2.json --bot-config bot2.json --server-config server2.json
```

The Hub can likewise run a second (e.g. test) Hub without touching the primary Hub's config or database:

```bash
node symbot-hub.js --hub-config hub2.json --hub-data-dir data/hub2
```

These flags combine with the commands above (e.g. `node symbot.js reset users --app-config app2.json`).


## Frequently Asked Questions (FAQ)

#### Why SymBot?
- SymBot was developed with two primary goals in mind:
	- Create a simple, easy to use, yet powerful crypto trading bot that would provide anyone who wanted to start trading cryptocurrencies with the ability to get up and running quickly with little technical knowledge.
	- Reduce the risk of having any other parties with access to your most valuable information when it comes to trading, which are your exchange credentials or API keys. There are ever growing cyber-threats, hacks, data breaches, and just overall bad actors that are constantly looking for ways to scam through sometimes fairly elaborate schemes. If your keys get into the hands of anyone with malicious intentions, you could lose all of your money and cryptocurrencies on your exchange. SymBot connects directly to your exchange so your API keys are never sent or shared with any other third-party.

#### How is SymBot different from just trading directly on my exchange?
- An exchange gives you the tools to place individual orders by hand. SymBot turns those same tools into an automated, disciplined strategy that runs on your behalf around the clock. Running a DCA strategy manually would mean watching the market continuously, placing each safety order at the right price as the market moves, tracking your average entry across many partial fills, and closing at your target the instant it is reached, for every position, day and night. In practice that is very hard to do by hand without missing fills, miscalculating averages, or letting emotion drive decisions.
- SymBot does all of that for you. It places your base and safety orders, recalculates your average entry and take-profit target on every fill, and closes each deal when it reaches profit, across many pairs and many concurrent deals at once. It also enforces safeguards a manual trader has to remember on their own, such as the risk percentage that shows how much of your capital you would commit if every bot ran to its maximum, price-feed sanity checks, and an optional circuit breaker that pauses new orders during abnormal market moves.
- What SymBot does not do is change the exchange itself. Your orders still execute on your own exchange at its prices and fees, and SymBot connects directly with your own API keys so nothing is routed through a third party. The benefit is not a secret edge on price, it is consistent, automated, unemotional execution of a strategy that would be tedious and error-prone to run by hand.

#### What exchanges does SymBot support?
- SymBot uses the [CCXT](https://github.com/ccxt/ccxt) (CryptoCurrency eXchange Trading) library which supports many popular exchanges such as Binance and Coinbase. If your exchange is listed then you should be able to connect to it.

#### Should I try SymBot with fake money first?
- Yes — it is strongly recommended, especially if you are new to this. SymBot has a built-in Sandbox (paper trading) mode that runs your bots exactly as they would run live, but with a simulated wallet balance instead of real funds, so no real orders are placed. New bots default to Sandbox mode, and you can set a Sandbox wallet balance under **Configuration → Exchange**. Watch how your bots and deals behave in Sandbox until you are comfortable, then switch to Live when you are ready to trade with real money.

#### Can I run SymBot on my home network?
- Yes, however using a trusted hosting provider is a more stable choice. Trading requires your system to be running 24/7 along with an uninterrupted high-speed internet connection. Most established hosting data centers have readily available support teams to assist with system related issues, fully equipped with generators in case of power failures, redundant fiber connections, and operate inside hurricane resistant buildings. If your home experiences a power outage or any other unexpected scenarios, that may result in unplaced orders or missed trading signals which could impact your deals significantly.

#### Can I run multiple SymBot instances on the same server?

Yes, with [SymBot Hub](#symbot-hub-id) you can easily run multiple instances on the same server.

-  Although not recommended, if you would rather do it manually, follow these simple steps:

	1. Clone the SymBot code into a new directory and follow the same installation procedures
	2.  Change your `mongo_db_url` to point to a different database, such as `mongodb://127.0.0.1:27017/SymBot2`
	3.  Change your `web_server` port to any unused server port such as 3001

- Additional things to consider:
	- If you are using Telegram for notifications you will likely need to create a new bot since Telegram only allows one connection per account
	- If you are using pm2 or some other process manager, be sure to add the new SymBot instance there
	- If you are using the same exchange / account credentials this will impact any rate limiting, connections, etc. the exchange imposes for all SymBot instances

#### Can I access SymBot from my mobile device?
- Yes. If you set up SymBot on a home network and your mobile device is connected to the same wireless network, you should be able to open a web browser on your device and access SymBot just fine. Keep in mind that you need to use the IP address of the server that SymBot is running on, such as http://192.168.1.10:3000. However, being able to access it from other locations depends if your system is accessible to the public internet. This generally requires either opening ports on your router and system, or setting up a [Reverse Proxy](#reverse-proxy-setup).

#### Where should I host SymBot and how much does it cost?
- While there are a lot of hosting providers to choose from, using one you trust is generally the best way to ensure SymBot runs smoothly at all times. Many providers offer free tier services or very low cost options. A quick search for "VPS hosting" or "cloud server" will surface a wide range of providers at various price points. For personal use, a low-cost VPS with 1-2GB RAM and a single CPU core is generally sufficient to run SymBot with multiple bots.

#### How many DCA bots can I run at the same time?
- You can technically run an unlimited number of bots, however any limitations mostly come from how often your exchange allows APIs to be accessed, and the amount of resources your system (server) has such as CPU, memory, etc. The more bots you run generally requires additional API calls to your exchange and more system processing capability to manage all of your deals efficiently.

#### How does a bot decide which pairs to open deals on?
- A bot opens deals on the pairs you assign to it, in the order they are listed, and keeps opening on the next pair until it reaches its Max Pairs limit (the most deals it is allowed to run at once). Pairs are never chosen at random. A pair that already has an open deal is skipped rather than started again, so the bot fills its idle pairs instead of repeating one. If you want certain pairs to be considered first, list them earlier in the bot's pair list.

#### If my system is restarted will my deals be lost?
- SymBot is designed with resiliency in mind. Providing there are no issues with your database or other technical problems that caused your system to reboot, your bot deals will automatically resume upon restart. It is recommended to monitor the logs for a period of time to ensure everything is operating as expected.

#### If I disable a DCA bot will it close my deals?
- No. Disabling a DCA bot will only prevent new deals from being started. Any existing deals that are running will continue until they complete unless you choose to cancel or panic sell.

#### What does "take profit in base or quote currency" mean?

- When your bot takes profit, it sells some of your crypto to lock in gains. You can choose how you receive those profits:
- **Base currency** (the asset you're buying, e.g. BTC): great if you're a long-term holder who wants to accumulate more of the asset. The bot sells a portion of BTC and buys it back when the price dips again, helping you grow your holdings over time. Ideal if you plan to reinvest profits into the same asset at lower prices.
- **Quote currency** (the currency you're spending, e.g. USDT): better if you want to lock in profits in a stable currency. The bot sells BTC for USDT and holds the USDT, securing gains and reducing exposure. Useful if you want to cash out gradually.
- For example, trading BTC/USDT: **take profit in base** means the bot sells a portion of BTC and buys back BTC when the price dips (you keep stacking more BTC); **take profit in quote** means the bot sells BTC for USDT and keeps the USDT (you realize profit in dollars).
- You can switch between base and quote currency at any time by updating your bot or deal settings.

#### How is profit calculated when a sell fills in several parts?

- Most sells fill completely in one go and profit is reported from that single fill price and the deal's accumulated quantity.

- Occasionally an exchange fills only part of a market sell and cancels the rest (for example Coinbase price protection on a thin order book). SymBot retries the remainder, so the sell completes as a sequence of fills at different prices. In that case profit is reported from what actually executed: the total quantity filled across every attempt, valued at the volume-weighted average of those fill prices, against a cost basis matched to the quantity that sold. Reporting the pre-calculated ladder quantity at a single price would overstate the result, because a sell cascade on a thin book fills at progressively worse prices.

- Fee handling is unchanged — profit remains net of the exchange fee configured on the bot, not per-fill fees reported by the exchange.

- Actual fill data is used only when the exchange reports it reliably: SymBot reads the CCXT unified `average`, `cost`, and `price` fields, in that order of preference. Exchanges differ widely in what they return — some report nothing usable even after the order is queried — so SymBot falls back to its pre-calculated values whenever the data can't be trusted:
	- When no exchange-reported value is available.
	- When the reported quantity exceeds what the deal held.
	- When the resulting average price is implausible against the price the order was placed at.

	A deal on an exchange with poor fill reporting behaves exactly as it did before.

- Some exchanges report an order's cost net of fees while others report it gross. Because profit already accounts for the exchange fee configured on the bot, SymBot cross-checks a reported cost against the reported fill price and ignores it when it looks fee-inclusive, preventing fees from being deducted twice.

- Closed deals record which method was used, along with the quantity actually sold and each individual fill. Deals closed before this behavior was added retain their original figures — they are not recalculated.

#### Why does a closed deal show an unsold quantity?

- When the remaining amount after partial-fill retries is below the retry threshold, SymBot accepts the fill and closes the deal rather than chasing dust, which would burn retries and fees for a negligible amount. The leftover quantity stays in your exchange account and is reported on the deal so you can reconcile it manually. It is excluded from the deal's cost basis, so profit reflects only the coin that actually sold.

#### What happens when a buy order only partially fills?

- Occasionally an exchange fills only part of a safety-order buy and cancels the rest — the same thin-order-book behavior that affects sells (for example Coinbase price protection, or any immediate-or-cancel market order that clears the visible book and cancels the remainder). Buys and sells share one partial-fill engine, so both are handled identically: SymBot retries the outstanding quantity to try to complete the fill, then credits whatever actually filled into the deal — recalculating the deal's average entry and take-profit target so the position continues normally, with nothing left stranded and no manual step.

- Some exchanges *label* a fully executed order as "partially filled" even when 100% of it filled (a rounding quirk of quote-denominated market orders — the amount requested and the amount executed differ by a fraction). SymBot recognizes this: when the executed quantity matches what was requested within a small threshold, it treats the order as a normal completed buy — no retry, no separate credited rung, and no notification — rather than mistaking the label for a real shortfall. Only a genuine shortfall beyond that threshold goes through the credit-and-recalculate path above.

- The credited coin is booked exactly as a normal buy is, with the same fee accounting as every other order, so the deal's average, its take-profit target, and the eventual sell all stay accurate for the amount actually held.

- In the deal's order history the credited fill shows as a filled rung tagged **(system)** — the same way an automatic pause is distinguished from a manual one — so you can tell at a glance it was booked automatically rather than a buy you placed by hand (which shows as **(manual)**).

- An auto-credited fill re-uses an existing safety-order slot on the ladder, so it counts as a normal **safety order used**, not as an addition to your maximum. Only a manual **Add Funds** action appends a brand-new rung beyond the ladder, and only those show as an addition to the max — the `(+N)` you see next to the safety-order count on the deal list (identical on a standalone instance and on the Hub). Over the API each order rung carries a `manual` flag and, for a system action, a `manualReason` (for example `partial_fill_credit`): a user Add-Funds rung is `manual` with no reason, while an auto-credited fill is `manual` with a `manualReason`, so an integration can tell the two apart and count them the same way SymBot does.

- As with sells, this relies on the exchange reporting the fill: SymBot reads the CCXT unified `average`, `cost`, and `price` fields, in that order of preference. If the exchange reports no usable fill price, or the deal's ladder cannot be recomputed, SymBot keeps its previous safe behavior — it pauses further buys on that deal and alerts you with the exact amount filled so you can reconcile it on the exchange. A deal on an exchange with poor fill reporting behaves exactly as it did before.

- This applies to safety orders. A first (base) order that the exchange cannot confirm still follows SymBot's deliberate handling for a failed base order.

#### What is the difference between canceling and closing a deal?
- Canceling a deal will remove the active deal from any further trading without selling any assets already bought from previous orders.
- Closing a deal is basically panic selling where all assets are sold at the current market price whether at a profit or loss at the time of closing the deal.

#### Why are my deals not updating or not getting pricing?
- Your exchange credentials may be incorrect or you may be getting blocked, rate-limited, or experiencing some type of connectivity issues. Some exchanges also restrict access by region, so your server's IP address must reside in a location that is allowed. Check the logs for any error messages or unusual activity. You can do this from a command line terminal or in the SymBot web interface.

- Broken or flapping IPv6 on a server is a common cause of connectivity problems. A host can have an IPv6 address that is not actually routable, so an outbound request that tries IPv6 first fails — often seen as intermittent `NetworkError ... fetch failed` in the logs — even though IPv4 works perfectly. A few things to know:
	- **SymBot handles the common case for you** — it prefers IPv4 for outbound connections by default, so most such issues are sidestepped automatically with no change on your part.
	- **To use a different resolution order** — start SymBot with `--dns-order verbatim` (or `--dns-order ipv6first`).
	- **To disable IPv6 at the operating-system level** (if a server's IPv6 is genuinely misconfigured) — for example on Linux, `sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1`; add the same setting under `/etc/sysctl.d/` so it persists across reboots.
	- **The better long-term fix** is the underlying network configuration — IPv6 matters for the future of the internet — but preferring IPv4 keeps trading running in the meantime.

#### Why are my bots not starting new deals?
- Once you have confirmed your exchange credentials are correct and there are no connectivity issues, then this could be related to your bot settings. For example, if you have anything set for max deals, pairs, or minimum 24h volume, these can all restrict your bot from starting new deals. Also if your start condition is set to anything other than ASAP, such as if you're using a trading signal, then a deal will only start once a signal received matches your bot pairs and other allowed settings.

#### Why am I getting warning or error messages?
- SymBot is constantly tracking exchange responses, deals, and various other things for potential issues. If anything is detected, alerts and warnings may be displayed in the web interface and sent via Telegram if possible. This might include things such as being unable to poll the exchange for pricing, buy and sell errors, or virtually any other unsuccessful responses that occur over a period of time. It is best to check the logs immediately when seeing any of these alerts.

#### Why am I getting buy or sell errors?

- There are a variety of reasons you might be seeing errors when buying or selling, but these are some common situations:

	- Insufficient Funds:
		- Ensure that you have enough funds in your trading account to execute the buy or sell order, including any fees that may be incurred.
	- Order Size Limits:
		- Some exchanges impose minimum or maximum order size limits. Check the exchange documentation to see if your order size is within the allowed range.
	- API Rate Limits:
		- Exchanges often have rate limits on API requests. If you exceed these limits, your requests may be rejected.
	- Authentication Issues:
		- Ensure that you have properly configured API keys and that they have the necessary permissions for trading. Double-check that you are using the correct API key, secret, and passphrase if applicable.

- It is recommended to monitor your deals frequently, check logs, and if your deals continue to be unable to buy or sell, you may want to consider canceling the deal and managing the trade manually on your exchange.

#### Why do my orders in SymBot look different than on my exchange?
- Your orders in SymBot are close estimates, not exact matches to what you see on the exchange. A few reasons:
	- SymBot calculates all order steps ahead of time, following each exchange's own rules and fees, so the amounts and quantities are estimates.
	- The exchange fee set in your configuration also shifts the amounts.
	- Exchanges take a portion with each transaction, so it's rare for a deal to sell the exact quantity intended.
	- SymBot aims to sell as close to the maximum it bought as it can while still hitting your target profit, and adjusts the quantity down if an error such as insufficient funds occurs.
	- As a result, many deals leave behind a small amount of crypto, known as "dust". This is normal.

#### Why did my bot get disabled or deal get paused?
- A bot can be disabled or a deal can be paused several ways including manually through the web interface, programmatically using APIs or Webhooks, or even the usage of signals. SymBot also has some safety features built-in that may disable a bot or pause a deal automatically if an unknown error occurs as a precautionary measure to ensure there isn't something more problematic occurring. Sometimes it may just be the exchange does not allow a specific pair to be traded, so removing it from your bot is recommended. Since many errors are exchange specific, it is best to review the logs if you are unsure why your bot is disabled.

#### Can I delete a bot?
- Yes. You can permanently delete a bot and all of its deal history from the Manage Bots view using the delete button on any bot row. The bot must have no active deals — close or cancel all deals first. Deletion is irreversible and removes the bot and its complete deal history from the database. The action requires typing the bot name to confirm. Deletion is also available via the API using `DELETE /api/bots/{botId}`.

#### How can I tell if a deal was paused automatically vs manually?
- Deals paused automatically by SymBot due to an order verification failure are distinguished from manual pauses in the Active Deals view by a distinct row highlight color. When you attempt to resume a system-paused deal, the confirmation dialog will display a warning explaining the cause — either a buy order or sell order verification failure — and advise caution before resuming manually. The underlying issue should be investigated in the logs before resuming. If SymBot is restarted while a deal is mid-verification, the verification loop will resume automatically on startup without any manual intervention required.

#### Why is my system suddenly using more CPU or memory?
- SymBot is continuously monitoring and processing data — from exchanges, from any signal providers you use (such as 3CQS), from the database, and from house-keeping tasks like purging old logs. During market volatility more data can arrive faster and stay in memory longer, so occasional spikes in CPU or memory usage are normal.
	- When to look further: if either stays excessively high for an extended period, it's worth investigating. Upgrading your CPU, adding memory, or increasing disk capacity usually resolves it and improves performance — see also [Advanced Setup](#advanced-setup) for additional tips.

#### What is the difference between SymBot and SymBot Hub?
- SymBot is the software used for trading, while SymBot Hub serves as a central platform to manage multiple SymBot instances, offering a simplified and more efficient way to access them. SymBot Hub includes a live dashboard, unified active deals and bots views across all instances, and a full bot management interface for creating, editing, and deleting bots on any instance without switching between them. While SymBot Hub is optional, it is highly recommended if you're running multiple SymBot instances.

#### Why won't SymBot start, or why am I seeing an unsupported engine warning?
- SymBot requires the Node.js version listed under [Requirements](#requirements) — a current v22 LTS or newer. That minimum is driven by two of its built-in dependencies: the Hub's storage uses Node's built-in SQLite (`node:sqlite`), available without an experimental flag from v22.13.0 (or Node v24+), and the Hub's instance proxy needs a slightly newer v22 release. If you are running an older version, `npm install` may print an *unsupported engine* warning and the Hub may fail to start its storage layer. Check your version with `node --version` and upgrade if it is below the required minimum. On systems with multiple Node.js versions installed, a version manager such as nvm can be used to select the correct one.
- **A broken configuration file.** SymBot deliberately refuses to start if a configuration file (`app.json`, the bot config, or the server config) is present but cannot be parsed — for example an edit left invalid JSON. Rather than run with a half-loaded configuration, it stops immediately and logs a precise message naming the file and the exact parse error (e.g. *"Bot configuration file … is broken and cannot be parsed …"*) and exits with a non-zero code so a process manager surfaces the failure. Fix the JSON or restore the file from a backup, then restart. (A genuinely missing file on a fresh install is handled normally — it is only a *corrupt* file that halts startup.)

#### How can I disable logging to file to save disk space?
- While we do not recommend disabling logging to file, you have the option to do so by adding the argument `clglite` when starting the application.
	- `npm start clglite`

## Disclaimer

All investment strategies and investments involve risk of loss. All information found here, including any ideas, opinions, views, predictions, forecasts, or suggestions, expressed or implied herein, are for informational, entertainment or educational purposes only and should not be construed as personal investment advice. Conduct your own due diligence, or consult a licensed financial advisor or broker before making any and all investment decisions. Any investments, trades, speculations, or discussions made on the basis of any information found here, expressed or implied herein, are committed at your own risk, financial or otherwise.

By using the software, you acknowledge that you should only invest money you are prepared to lose. The authors and affiliates are not responsible for any trading results, and you use the software at your own risk.

## Help Support

If you enjoy SymBot and would like to help support its growth, please consider contributing. Your donations will assist in maintaining and enhancing the project for the future.

You can contribute any amount through:

- **BTC**: bc1qz35q0jf94j44ljd9tyfwvgh4fcc5w8hmt9y24h
- **ETH**: 0x85aa19CB35A023265875d4d76C7dA09CCa9EF639
- **USDT (ERC20)**: 0x85aa19CB35A023265875d4d76C7dA09CCa9EF639
- Or directly via [GitHub Sponsors](https://github.com/sponsors/3cqs-coder)