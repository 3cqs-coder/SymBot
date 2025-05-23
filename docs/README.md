


![SymBot Logo](https://user-images.githubusercontent.com/111208586/221390681-d13b9bce-dafb-4b55-a6f1-1bc5218cd204.png)

SymBot is a user friendly, self-hosted and automated DCA (Dollar Cost Averaging) cryptocurrency bot solution. Create and manage your bots entirely from your web browser or with simple built-in APIs. Best of all, your exchange credentials and keys always remain in your hands... not any other third-party.

![SymBot](https://user-images.githubusercontent.com/111208586/219070191-abe2ef94-ca5a-43a9-867c-2c2ff9609699.jpg)

[![Discord](https://img.shields.io/badge/Discord-%235865F2.svg?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/m8TyEpBaCg)


## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Installation Video](#installation-video)
- [Docker Installation](#installation-docker)
- [SymBot Hub](#symbot-hub)
- [Upgrading](#upgrading)
- [Configuration](#configuration)
- [Telegram Setup](#telegram-setup)
- [Advanced Setup](#advanced-setup)
- [Reverse Proxy Setup](#reverse-proxy-setup)
- [Artificial Intelligence (AI)](#artificial-intelligence-ai)
- [API Information](#api-information)
- [API Sample Usage](#api-sample-usage)
- [Webhooks](#webhooks)
- [Backup and Restore Features](#backup-and-restore-features)
- [Reset or Configure SymBot](#reset-or-configure-symbot)
- [Frequently Asked Questions (FAQ)](#frequently-asked-questions-faq)
- [Disclaimer](#disclaimer)
- [Help Support](#help-support)

## Requirements

- Linux, MacOS, or Windows based system
- [Node.js](https://nodejs.org) v19+ must be installed on your system
- [MongoDB](https://www.mongodb.com) installed or a cloud host provider
- Access to a cryptocurrency exchange such as Binance or Coinbase
- Reliable high-speed internet connection
- 1GB RAM minimum but recommended at least 4GB
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

To have SymBot run in the background it is recommended to use the Node.js process manager called **pm2**. Here's how to use it:

1. Install **pm2** by typing: `npm install pm2 -g`
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
4. Tell **pm2** to start SymBot with a one time only command by typing: `pm2 start ecosystem.config.js`
5. Type: `pm2 save` to save the configuration
6. If you don't already have **pm2** starting at system boot time, type this with root privileges: `pm2 startup`. Then type: `pm2 save`

SymBot will now start automatically even when the system is rebooted. With the above configuration **pm2** will monitor SymBot and if memory exceeds roughly four gigabytes, a kill signal will be sent to SymBot. **pm2** will wait eight seconds before terminating the process to give SymBot some time to safely shut itself down. **pm2** will then start SymBot again. You can change those settings to suit your own server requirements and needs.

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

The Docker build files can be modified as necessary, but should only be done if you're familiar with how they work. Running SymBot under Docker is considered experimental and performing any upgrades could cause unexpected issues.

1. Open a command line terminal
2. Change directory to where SymBot files are located
3. Make any additional changes to the app and bot configuration files as necessary (see [Configuration](#configuration))
	- SymBot will automatically configure the database URL and set your password to *admin*
4. Change directory to `docker` in the same location where SymBot files are located
5. Type: `docker-compose -p symbot up -d --build`
6. Wait for Docker to build everything and all containers to start
7. Open a web browser and type: http://127.0.0.1:3000

SymBot will initially start in configuration mode. After you confirm the default settings and update, it will shutdown and restart automatically.

Mongo Express is also installed which can be used to access MongoDB visually by opening a web browser to  http://127.0.0.1:3010

<a id="symbot-hub-id"></a>
## SymBot Hub

SymBot Hub makes it easy to manage multiple SymBot instances from a single codebase. Whether you're testing strategies on different exchanges, running real and paper (sandbox) trading, or managing other setups, you can control everything with just a click.

With SymBot Hub's simple web interface, you can easily add, update, restart, or disable any instance. It also combines all instances into one system using an internal proxy server, so you only need one port to access everything. Plus, SymBot Hub helps you monitor system resources like memory usage, making instance management straightforward and efficient.

### Starting SymBot Hub

Before starting SymBot Hub, make sure your first SymBot configuration is set up and working as expected. The initial instance will be created automatically using your default configuration files.

To get started:

1.  Open a command line terminal.
2.  If any SymBot instances are running, stop them.
3.  Navigate to the directory where your SymBot files are located.
4. You can change the default port in **hub.json** but it is recommended to make all instance additions or updates using the web interface.
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

When upgrading to a new version of SymBot it is recommended to follow the basic steps below.

1. Stop all running SymBot instances
	- If using **pm2** suggested in the installation above, you can type: `pm2 stop ecosystem.config.js` in a command line terminal
2. Make a backup of the directory to where all current SymBot files are located
3. Extract new SymBot files to existing directory. If prompted, be sure to allow new files to replace the original or you may be running portions of a previous version
4. Copy existing configuration files from backup created previously
5. Compare parameters in the new SymBot configuration files such as **app.json** to existing files if any have been added or removed. Any changes must be added to existing configurations or this may cause SymBot to not start or run properly
6. Type: `npm install` to ensure all modules are installed properly
7. Start SymBot and verify the new version is running
8. Monitor logs for a few minutes either on the console, log files, or the web interface to ensure everything is operating as before

**NOTE:** If you are running SymBot behind any other services such as Apache, Nginx, Cloudflare, etc. you may need to clear caches in order for the latest upgraded files to be served properly.


## Configuration

These files are located in the `config` directory

- **app.json**

	- `password` is a hashed password used to login to the SymBot web interface. The default password is automatically set as "*admin*" the very first time SymBot is started. This is not a plain text password, but rather an encrypted form of it, so it should not be manually entered or you may not be able to login properly. It is strongly recommended to change the default password using the web interface configuration.

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
				-	`slippage_percent` is an additional percentage that is factored into the current price before another buy or sell order is placed on the exchange.  Sometimes orders will be executed at a different price than originally requested primarily with market orders. This helps to ensure orders are executed at or below the buy price and at or above the sell price requested. This can also potentially increase overall profit, but setting these values too high may cause further delays in closing your deals.
			-	`account_balance_currencies` is an array of currencies that are used to show preferred exchange account balances in order of precedence.
		- `pair_buttons` is an array of currencies that is used to automatically fill in pairs after clicking on one of these buttons when creating or updating bots.
		-	`pair_blacklist` is an array of pairs that you don't want to trade. You can use full pairs such as BTC/USD or wildcards such as BTC/*. This can be useful to prevent bots from starting deals using stablecoin pairs such as USDT/USD as those will generally have little volatility in typical market conditions.

	- `cron_backup` 
		- `schedule` this is a crontab format schedule of the days and time to process tasks.
		- `password` is the password that will be used to encrypt database backups. It is required and is not a plain text password, but rather an encrypted form of it, so it should not be manually entered.
		- `max` is the maximum number of backups to keep.
		- `enabled` is whether the cron scheduler will run and automatically process database backups.

	- `telegram` contains an optional Telegram token id and user id to send SymBot notifications to. This includes system warnings such as detected connectivity issues, bot and deal start / stops, and more! You must first create a Telegram bot with `@BotFather` to use (see [Telegram Setup](#telegram-setup)).

	- `mongo_db_url` is the URL to your MongoDB instance.

		- **WARNING:**
			- Do not run multiple instances of SymBot using the same database. This will lead to severe bot malfunction and could irreversibly damage your bot's functionality.
			- Avoid direct access to MongoDB. You should never attempt to view, modify, or interact with the SymBot database directly through the MongoDB shell or any other utility. Doing so risks corrupting the database, which could lead to total data loss and irreversible damage to your bot's operation.
		- You do not need to enter this manually. It can be entered using the web interface while in configuration mode.
		- For quick set up, create a free account at https://cloud.mongodb.com and copy the URL given into the app config. It begins with something like: mongodb+srv://
		- If running a local MongoDB instance, specifying `
mongodb://127.0.0.1:27017/SymBot
` or `
mongodb://localhost:27017/SymBot
` should work fine, but setting up a username and password is also recommended
		- Keep in mind when using a cloud hosted database, the disk space capacity may be different from your server or the amount of data that can be stored may be limited.  This can cause issues with your bots and deals if your database does not have adequate disk space or there is increased latency accessing a remote database
		- For better speed and security, running your own local database is recommended

	- `signals` contains a section to use signals with SymBot. There is a 3CQS signals section by default. You must have a 3CQS API key for these to work. You can get one by signing up for free at https://www.3CQS.com. Webhooks must also be enabled for these signals to work.

	- `ai` contains a section to use artificial intelligent services with SymBot. 

- **bot.json**

	- This contains all default settings for your bot and exchange. Depending on your exchange, the API credentials you enter here usually include some of the following such as your exchange API key, secret, passphrase, or password. For testing purposes, often you can leave all of them empty but always leave `sandBox: true`.
	- Valid exchanges include binance, binanceus, coinbase, and many others. SymBot uses the [CCXT](https://github.com/ccxt/ccxt)  library so if the exchange is supported, you should be able to connect to it
	- Most bot settings do not need to be set here since they can be set when creating a bot in the web interface
	- Set your exchange fee appropriately:
		- The `exchangeFee` is used for multiple purposes including buying more of an asset to ensure accurate profitability when selling, and having enough additional quantity of the asset to sell. If you encounter sell errors, such as insufficient funds, you may want to increase this value even higher than your exchange's said fees. You may end up with slightly more assets or crypto "dust", but it will help prevent sell errors especially when trading the asset through repeated deals. Changing this value will only take affect on new deals.
		- Exchanges such as Binance often use BNB (Binance Coin) for transaction fees. If you are receiving an error, it's possible that you don't have enough BNB to cover the fees associated with the trade. Binance deducts fees from your BNB balance, and if it's insufficient, the trade may fail. If you encounter trading errors such as being unable to sell or take profit, you may want to consider disabling certain trading fee enhancements like BNB (if applicable) on your exchange, and also increasing the `exchangeFee` value.
	- If you experience any issues with your bots or deals using a specific exchange, there is a special parameter that can pass options directly to the CCXT library by modifying `"exchangeOptions": { "defaultType": "spot" }`


- **server.json**

	- This file is created the very first time SymBot is started. It contains an automatically generated UUID v4 `server_id`. The primary purpose is to ensure if there are ever multiple instances of SymBot running, they do not accidentally conflict with the database used. When SymBot starts it will compare the `server_id` value in this file to the database entry. If they do not match, SymBot will shut down. 
	- This file should never be copied to another folder or server if you plan to run additional instances of SymBot, or manually edited unless you have a good reason to do so.


## Telegram Setup

Using Telegram with SymBot is a great way to know when bot deals start and finish, but also getting notifications when issues are detected, such as being unable to connect to your exchange.

You just need to create a Telegram bot with `@BotFather`. Here are some simple steps on how to do that:

1. Open a Telegram chat with `@BotFather`
2. Once there you may need to type or click on `/start`
3. Type: `/newbot`
4. Choose a name that will be displayed when you receive messages from Telegram. For simplicity, just use: **SymBot**. This does not need to be unique to Telegram.
5. Now you need to choose a unique Telegram username. This can be just about any string value, but it must end in the word **bot**. For example: **MySymBotServer123_bot**
6. If the username you chose was not already taken, then you should receive a token that looks something like: **12345:AbCdEfG_123Abc**
7. Open a chat with your new bot **MySymBotServer123_bot** (use the actual name of your bot)
8. Type or click on `/start`
9. Copy your Telegram bot token into the SymBot **app.json** configuration file. You must also enter your own Telegram id or SymBot will not allow messages to be sent. If you don't know your Telegram id, open a chat with `@userinfobot`
10. Restart SymBot 

## Advanced Setup

If you're experiencing issues such as application crashes or slow performance, there are a few things to consider:

- Ensure the system running SymBot has adequate resources available such as memory and hard drive space to help prevent these issues in the first place.
- Keep your system up to date with the latest security patches and performance improvements. Use your package manager to update the installed software regularly.
- Disable unnecessary services and daemons that are not required for your specific use case. This reduces the system's resource usage.

Below are some additional tips to optimizing your system and SymBot performance.

### Swap space
Swap space is a portion of a computer's hard drive or other storage devices that is used as virtual memory. It's like extra memory for your computer when the real memory (RAM) is full and prevents your computer from crashing when it runs out of memory. However, using swap space can slow down your computer, so you should only use it if you need it. The amount of swap space to use depends on how much memory your computer has and what you use it for, but it's typically recommended to have at least as much swap space as RAM.  Creating and enabling swap space will vary depending on your operating system.

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

Securing login access to servers is like putting a lock on the door of your digital space. It's important because it keeps unauthorized people out, protecting sensitive information and preventing potential damage to your system. Without proper security, hackers could gain access, mess with your data, or even use your server as a launching point for attacks on other systems. Regularly updating and patching your server is like installing security updates to fix any weak points. It's an ongoing process to stay ahead of potential threats and ensure your server stays safe and reliable. In a nutshell, securing login access is about keeping your digital space locked and guarded to maintain a strong defense against cyber threats.

To secure login access to Linux, Mac, and Windows servers, it's crucial to implement robust security measures tailored to each operating system. Below are some basic steps to consider for each type of server.

- **Linux**: Start by configuring SSH (Secure Shell) to use key-based authentication instead of passwords, and disable root login to prevent unauthorized access. Regularly update and patch the system to address any vulnerabilities. Additionally, implement firewall rules using tools like iptables to control incoming and outgoing traffic.

- **Mac**: Leverage OpenSSH for secure remote access. Similar to Linux, enforce key-based authentication and disable remote root login. Regularly update the operating system and applications through the App Store or command line. Utilize macOS's built-in firewall to restrict unauthorized access to specific services.

- **Windows**: Prioritize strong password policies. Regularly update the system through Windows Update and enable Windows Defender or a reputable antivirus solution. Use Group Policy to manage user access and permissions effectively. Additionally, consider implementing Network Level Authentication (NLA) for Remote Desktop Services to enhance security.

For all three operating systems, regularly monitor and audit login attempts and system logs to detect and respond to any suspicious activities promptly. Implementing intrusion detection systems and keeping abreast of security best practices will contribute to a more robust defense against potential threats. Regularly reviewing and updating these security measures will help maintain a secure and resilient server environment.

## Reverse Proxy Setup

A reverse proxy is a special type of web server that receives requests, forwards them to another web server somewhere else, receives a reply, and forwards the reply to the original requester. Although there are many reasons to use a reverse proxy, they are generally used to help increase performance, security, and reliability. Two popular open-source software packages that can act as a reverse proxy are [Apache](https://apache.org) and [NGINX](https://nginx.org).

This is how requests will work when using a reverse proxy in front of SymBot:

***User*** <---> ***Reverse Proxy (Port 80)*** <---> ***SymBot (Port 3000)***

There are many different ways to set up either Apache or NGINX as a reverse proxy that can be used in front of SymBot, so this is just a basic guide. You may need to change configuration parameters depending on your operating system, version of these software packages, or if you're already running one of them on your system (server). The commands described here will also vary depending on your operating system.

If setting up a reverse proxy seems too advanced, a great alternative is to use a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks) instead. This can also automatically encrypt all of your traffic without installing any additional SSL certificates on your web server and system.

### Apache

1. Update the apt-get package lists with the following command:
```
sudo apt-get update
```

2. Install Apache:
```
sudo apt-get install apache2
```

3. Open the Apache configuration file:
```
# Apache 2.4+
sudo nano /etc/httpd/conf.modules.d/00-proxy.conf

# Apache < 2.4
sudo nano /etc/httpd/conf/httpd.conf
```

4. Enable the Proxy and Rewrite modules by adding or uncommenting the below lines:
```
LoadModule proxy_module modules/mod_proxy.so
LoadModule proxy_http_module modules/mod_proxy_http.so
LoadModule proxy_wstunnel_module modules/mod_proxy_wstunnel.so
LoadModule rewrite_module modules/mod_rewrite.so
```

5. For Debian based systems, enable the modules using the following command:
```
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite
```

6. Create a virtual host configuration file for your domain:
```
# Debian based systems 
sudo nano /etc/apache2/sites-available/your-domain-name.com.conf

# Redhat based systems 
sudo nano /etc/httpd/conf.d/your-domain-name.com.conf
```

7. Add  the below configuration block and save:
```
<VirtualHost *:80>
	ServerName your-domain-name.com
	ServerAlias www.your-domain-name.com
	ServerAdmin webmaster@your-domain-name.com

	RewriteEngine on
	RewriteCond ${HTTP:Upgrade} websocket [NC]
	RewriteCond ${HTTP:Connection} upgrade [NC]
	RewriteRule .* "ws:/127.0.0.1:3000/$1" [P,L]
  
	ProxyPass / http://127.0.0.1:3000/
	ProxyPassReverse / http://127.0.0.1:3000/
	ProxyRequests off
</VirtualHost>
```
8. Restart Apache:
```
# Debian based systems 
sudo a2ensite your-domain-name.com
sudo systemctl restart apache2

# Redhat based systems 
sudo systemctl restart httpd
```

You should now be able to access SymBot by opening your web browser to http://your-domain-name.com


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
				proxy_pass http://127.0.0.1:3000;
				proxy_http_version 1.1;
				proxy_set_header Upgrade $http_upgrade;
				proxy_set_header Connection 'upgrade';
				proxy_set_header Host $host;
				proxy_cache_bypass $http_upgrade;
	}
}
```

5. Restart NGINX:
```
sudo systemctl nginx restart
```

You should now be able to access SymBot by opening your web browser to http://your-domain-name.com


## Artificial Intelligence (AI)

### What is Artificial Intelligence?

Artificial Intelligence (AI) refers to machines designed to think and learn like humans. These systems use data and algorithms to recognize patterns, make decisions, and improve over time without needing human input. AI is found in everyday tools, such as voice assistants and website recommendations, as well as in complex fields like healthcare and finance. SymBot makes it easy to integrate this powerful technology, allowing you to analyze your trades with ease.

### How Can AI Help with Trading?

AI can be a big help in trading by analyzing market trends, predicting price movements, and automating trades. It looks at data like price changes, trading volumes, and news to help traders make smarter decisions. AI can also spot risks in deals, help automate buying or selling based on certain conditions, and even analyze the mood of the market using tools like sentiment analysis. Large Language Models (LLMs), a type of AI, can also process and understand large amounts of text data, such as news or social media, to help predict how the market might react to certain events. This makes trading easier and safer for regular people by offering insights and automating tasks.

SymBot makes it easy to analyze your trading deals. With just one click, it uses information from your existing orders and current pricing which then, using Ollama, the AI processes this data, analyzing price trends and market conditions to predict potential outcomes. This helps you make smarter decisions about whether to continue, adjust, or pause your strategy.

### What is Ollama?

Ollama is an AI tool that helps process and understand large amounts of data. It can analyze text, make predictions, and provide insights based on the information it receives. Ollama is designed to handle complex tasks like analyzing market data or understanding trends, making it easier to make informed decisions.

SymBot uses Ollama to quickly analyze your trading data, such as your deal orders and current prices, to help predict if a deal will be profitable. You don’t need to be an expert; just click and let SymBot handle the analysis!

### Ollama Installation

Before installing Ollama, ensure your system meets the following requirements:

-   **Processor:** A multi-core CPU
-   **Memory:** At least 16 GB of RAM is recommended, especially for running large models.
-   **GPU:**
    -   For Macs, an Apple Silicon GPU is ideal.
    -   For other systems, an NVIDIA GPU with CUDA support is preferred.
    -   Models can also run on a CPU, but this may result in significantly slower performance.

1. Visit [Ollama's official website](https://ollama.com), download the installer for your operating system and follow the provided installation instructions.
2. Download a model using the command: `ollama pull <model_name>`. For example: `ollama pull llama3.2`.
3. By default, Ollama runs on port 11434.
	- If you need to access Ollama remotely, you must configure it to listen on `0.0.0.0` instead of `localhost`.
4. If Ollama did not start automatically, start it using: `ollama serve`.
5. Now just put the host URL and model in SymBot's configuration. For example: `http://127.0.0.1:11434` and `llama3.2` to use Ollama for AI trading analysis.

## API Information

Take more control of your bots and deals using SymBot APIs. You can easily enable or disable bots and start deals using triggers or signals from 3CQS, TradingView, your own custom scripts and strategies, or from any of your other favorite providers.

### Create bot
| **Name**                      | **Type** | **Mandatory** | **Values (default)** | **Description**                                                         |
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
| volumeMin                     | number   | NO            |                      | Minimum 24h volume (specified in millions) symbol must have to start    |
| dealCoolDown                  | integer  | NO            |                      | Wait a number of seconds before starting a new deal after the last one completes. Multi-pair bots will have different timers for each pair. |
| profitCurrency                | string   | NO            | quote                | Currency used for the profit when trading with this bot. Can be set to "base" or "quote". |
| startCondition                | string   | NO            | asap                 | Start deals using "*asap*" or by "*api*"                                |

```
POST /api/bots/create
```

### Update bot
| **Name**                      | **Type** | **Mandatory** | **Values (default)** | **Description**                                                         |
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
| volumeMin                     | number   | NO            |                      | Minimum 24h volume (specified in millions) symbol must have to start    |
| dealCoolDown                  | integer  | NO            |                      | Wait a number of seconds before starting a new deal after the last one completes. Multi-pair bots will have different timers for each pair. |
| profitCurrency                | string   | NO            | quote                | Currency used for the profit when trading with this bot. Can be set to "base" or "quote". |
| startCondition                | string   | NO            | asap                 | Start deals using "*asap*" or by "*api*"                                |

```
POST /api/bots/update
```

### Get bots

| **Name** | **Type** | **Mandatory** | **Values (default)** | **Description** |
|----------|----------|---------------|----------------------|-----------------|
| active   | boolean  | NO            |                      | Enabled = true / Disabled = false |

```
GET /api/bots
```

### Enable bot

| **Name** | **Type** | **Mandatory** | **Values (default)** | **Description** |
|----------|----------|---------------|----------------------|-----------------|
| botId    | string   | YES           |                      |                 |

```
POST /api/bots/{botId}/enable
```

### Disable bot

| **Name** | **Type** | **Mandatory** | **Values (default)** | **Description** |
|----------|----------|---------------|----------------------|-----------------|
| botId    | string   | YES           |                      |                 |

```
POST /api/bots/{botId}/disable
```

### Update deal

| **Name** | **Type** | **Mandatory** | **Values (default)** | **Description** |
|----------|----------|---------------|----------------------|-----------------|
| dcaTakeProfitPercent| number        | NO                   |                      | Take profit percentage the bot will use to close successful deals       |
| dcaMaxOrder         | integer       | NO                   |                      | Maximum DCA / safety orders allowed per deal                            |
| dealLast            | boolean       | NO                   | false                | Prevents a new deal from starting after this deal completes. Setting only applies to this deal. If you have multiple deals running with the same pair, this will not affect the other deals. |
| profitCurrency      | string        | NO                   | quote                | Currency used for the profit when trading with this bot. Can be set to "base" or "quote". |

```
POST /api/deals/{dealId}/update_deal
```

### Add funds to deal

| **Name** | **Type** | **Mandatory** | **Values (default)** | **Description** |
|----------|----------|---------------|----------------------|-----------------|
| volume   | number   | YES           |                      | Add funds to a deal by placing a manual safety order |

```
POST /api/deals/{dealId}/add_funds
```

### Pause deal

| **Name** | **Type** | **Mandatory** | **Values (default)** | **Description** |
|----------|----------|---------------|----------------------|-----------------|
| pause    | boolean  | NO            | false                | Pause or resume both buy and sell orders |
| pauseBuy | boolean  | NO            | false                | Pause or resume only buy orders |
| pauseSell| boolean  | NO            | false                | Pause or resume only sell orders |

```
POST /api/deals/{dealId}/pause
```

### Cancel deal

| **Name** | **Type** | **Mandatory** | **Values (default)** | **Description** |
|----------|----------|---------------|----------------------|-----------------|
| -        |          |               |                      | Cancels deal without selling any assets bought from previous orders |

```
POST /api/deals/{dealId}/cancel
```


### Panic sell deal

| **Name** | **Type** | **Mandatory** | **Values (default)** | **Description** |
|----------|----------|---------------|----------------------|-----------------|
| -        |          |               |                      | Closes deal and sells at current market price |

```
POST /api/deals/{dealId}/panic_sell
```


### Get deal information

| **Name** | **Type** | **Mandatory** | **Values (default)** | **Description** |
|----------|----------|---------------|----------------------|-----------------|
| -        |          |               |                      | Get information for a deal |


```
GET /api/deals/{dealId}/show
```

### Get active deals

| **Name** | **Type** | **Mandatory** | **Values (default)** | **Description** |
|----------|----------|---------------|----------------------|-----------------|
| -        |          |               |                      | Returns all current active deals |

```
GET /api/deals
```

### Get completed deals

| **Name** | **Type** | **Mandatory** | **Values (default)** | **Description** |
|----------|----------|---------------|----------------------|-----------------|
| from     | string   | NO            |                      | Returns most recent completed deals if start from date is not specified |
| to       | string   | NO            |                      | Returns all completed deals up to end of date specified |
| botId    | string   | NO            |                      | Returns completed deals for specified bot id |

```
GET /api/deals/completed
```

### Start deal

| **Name** | **Type** | **Mandatory** | **Values (default)** | **Description** |
|----------|----------|---------------|----------------------|-----------------|
| botId    | string   | YES           |                      |                 |
| signalId | string   | NO            |                      | Used to identify signal that started deal |
| pair     | string   | NO            |                      | Only required for multi-pair bots |


```
POST /api/bots/{botId}/start_deal
```

### Get account balances

| **Name** | **Type** | **Mandatory** | **Values (default)** | **Description** |
|----------|----------|---------------|----------------------|-----------------|
| -        |          |               |                      | Get all account asset balances |

```
POST /api/accounts/balances
```

### Get markets

| **Name** | **Type** | **Mandatory** | **Values (default)** | **Description** |
|----------|----------|---------------|----------------------|-----------------|
| exchange | string   | YES           |                      | Exchange to retrieve market data for |
| pair     | string   | NO            |                      | Symbol pair pricing and data to retrieve. Omitting will return all valid symbols for specified exchange |


```
GET /api/markets
```


### Show TradingView chart

| **Name** | **Type** | **Mandatory** | **Values (default)** | **Description** |
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

### Backup database

| **Name** | **Type** | **Mandatory** | **Values (default)** | **Description** |
|----------|----------|---------------|----------------------|-----------------|
| password    | string   | YES           |                      |                 |

```
POST /api/system/backup
```

## API Sample Usage

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

#### Enable bot
```
curl -i -X POST \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
http://127.0.0.1:3000/api/bots/{botId}/enable
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
'http://127.0.0.1:3000/api/deals/completed?from=2023-03-01'
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

#### TradingView chart
```
http://127.0.0.1:3000/api/tradingview?script=true&exchange=binance&pair=BTC_USDT&theme=dark&width=1000&height=600
```

#### Backup database
```
curl -X POST http://127.0.0.1:3000/api/system/backup \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
-d '{"password": "encryption_password"}' \
-o SymBot_Backup_DB.zip.enc
```

## Webhooks

A webhook is like a special type of API. While APIs rely on one program asking for data and waiting for a response, webhooks work differently. They instantly send data from one program or service to another when a specific event happens. This eliminates the need for manual requests and makes data sharing between software systems smoother and faster.

SymBot makes using webhooks easy because they're nearly identical to API usage. SymBot also adds another layer of security by using a token to access webhooks. The token is a hash of your hashed API key and SymBot server id.  This is used in your webhook requests instead of your API key in the header. Many companies do not allow passing custom headers, so using Symbot webhooks makes it easier to integrate with third-parties such as TradingView.

Since SymBot webhooks are layered on top of the APIs, you only need to prepend **/webhook** to the URL and supply your token. For example, let's say you wanted to start a new deal using a webhook. This is how the request would look:

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

- No API key is passed in the header
- Prepend **/webhook** to the URL
- Add your token to the **apiToken** parameter of the body

Remember if you ever change your API key or alter your server id, your token will also change automatically. You can get your token from the SymBot web interface configuration section.

## Backup and Restore Features

SymBot offers built-in backup and restore capabilities that focus on safeguarding your database. These features can be accessed directly through the web interface, ensuring that your trading data is securely stored and easily recoverable.

#### Backup Capabilities

You can manually create encrypted backups of SymBot's database through the web interface, programmatically using the integrated API, or schedule automatic backups in the web interface.  This ensures that all trading data, including bot configurations and trade history, is securely stored and protected from unauthorized access.

#### Restore Capabilities

To restore a backup, you must enter the encryption password used during the backup process. This security measure ensures that only authorized users can restore and access the database. The web interface makes it easy to restore your database to a previous state quickly and securely.

#### Importance of Regular Backups

Regular backups of your database are vital for protecting your trading data and ensuring the continuity of your strategies. It's essential to backup your database regularly, particularly before making significant changes to your settings or deploying new strategies. Always remember to securely store your encryption password, as it is required to restore your database.


## Reset or Configure SymBot

There are three command line options available for modifying SymBot:

1.  **Enable Configuration Mode**: This option allows you to easily update your database URL and other settings through the web interface.

2.  **Reset the Entire Database**: Use this option if you need to reset all data within SymBot.

3.  **Reset the Server ID**: If you want to migrate an existing SymBot database to a different server or instance, you can reset just the server ID.

To reset the SymBot database or server ID, you must use the command line. The system will first prompt you for confirmation, display a reset code that you must enter, and then require another confirmation to proceed.

#### Configuration mode
1. Stop any running instances of SymBot
2. Type: `npm start config` (or `node ./symbot.js config`)

#### Reset database
##### *** CAUTION *** This will purge all data from the SymBot database!

1. Stop any running instances of SymBot
2. Type: `npm start reset` (or `node ./symbot.js reset`)

#### Reset server ID only

1. Stop any running instances of SymBot
2. Type: `npm start reset serverid` (or `node ./symbot.js reset serverid`)


## Frequently Asked Questions (FAQ)

#### Why SymBot?
- SymBot was developed with two primary goals in mind:
	- Create a simple, easy to use, yet powerful crypto trading bot that would provide anyone who wanted to start trading cryptocurrencies with the ability to get up and running quickly with little technical knowledge.
	- Reduce the risk of having any other parties with access to your most valuable information when it comes to trading, which are your exchange credentials or API keys. There are ever growing cyber-threats, hacks, data breaches, and just overall bad actors that are constantly looking for ways to scam through sometimes fairly elaborate schemes. If your keys get into the hands of anyone with malicious intentions, you could lose all of your money and cryptocurrencies on your exchange. SymBot connects directly to your exchange so your API keys are never sent or shared with any other third-party.

#### What exchanges does SymBot support?
- SymBot uses the [CCXT](https://github.com/ccxt/ccxt) (CryptoCurrency eXchange Trading) library which supports many popular exchanges such as Binance and Coinbase. If your exchange is listed then you should be able to connect to it.

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
- While there are a lot of hosting providers to choose from, using one you trust is generally the best way to ensure SymBot runs smoothly at all times. Many providers offer free tier services or very low cost options. Although this is not a recommendation to use any of these providers, this [Cloud Free Tier Comparison](https://github.com/cloudcommunity/Cloud-Free-Tier-Comparison) list is a good place to start.

#### How many DCA bots can I run at the same time?
- You can technically run an unlimited number of bots, however any limitations mostly come from how often your exchange allows APIs to be accessed, and the amount of resources your system (server) has such as CPU, memory, etc. The more bots you run generally requires additional API calls to your exchange and more system processing capability to manage all of your deals efficiently.

#### If my system is restarted will my deals be lost?
- SymBot is designed with resiliency in mind. Providing there are no issues with your database or other technical problems that caused your system to reboot, your bot deals will automatically resume upon restart. It is recommended to monitor the logs for a period of time to ensure everything is operating as expected.

#### If I disable a DCA bot will it close my deals?
- No. Disabling a DCA bot will only prevent new deals from being started. Any existing deals that are running will continue until they complete unless you choose to cancel or panic sell.

#### What does "take profit in base or quote currency" mean?

- When your bot takes profit, it means it sells some of your crypto to lock in gains. You can choose how you want to receive those profits:

	- *Base currency*: This is the asset you're buying (e.g., BTC if you're buying Bitcoin).
		- Choosing this option is great if you're a long-term holder who wants to accumulate more of the crypto asset. The bot sells a portion of BTC and buys back BTC when the price dips again — helping you grow your holdings over time. It's ideal if you plan to reinvest profits into the same asset at lower prices.

	- *Quote currency*: This is the currency you're spending (e.g., USDT if you're using dollars).  
		- This option is better if you want to lock in profits in a stable currency like USDT. The bot sells BTC for USDT and holds the USDT, allowing you to secure gains and reduce exposure. It’s also useful if you’re looking to cash out gradually.

- For example, let’s say you're trading BTC/USDT:

	- *Take profit in base*: Bot sells a portion of BTC and buys back BTC when the price dips again (you keep stacking more BTC).
	- *Take profit in quote*: Bot sells BTC for USDT and keeps the USDT (you realize profit in dollars).

- You can switch between base and quote currency at any time by updating your bot or deal settings.

#### What is the difference between canceling and closing a deal?
- Canceling a deal will remove the active deal from any further trading without selling any assets already bought from previous orders.
- Closing a deal is basically panic selling where all assets are sold at the current market price whether at a profit or loss at the time of closing the deal.

#### Why are my deals not updating or not getting pricing?
- Your exchange credentials may be incorrect or you may be getting blocked, rate-limited, or experiencing some type of connectivity issues. Some exchanges also restrict access by region, so your server's IP address must reside in a location that is allowed. Check the logs for any error messages or unusual activity. You can do this from a command line terminal or in the SymBot web interface.

- If you're experiencing connectivity problems, you might find that disabling IPv6 can help. This is often the case when there are compatibility issues or misconfiguration with IPv6. By doing this, your system will rely on IPv4, the older version of the Internet Protocol, for its connections, which can work better in certain situations. However, it's important to note that IPv6 is crucial for the future of the internet, so it's better to resolve the root cause of the problem and ensure that both IPv4 and IPv6 are correctly configured for a stable and long-term internet connection.

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
- SymBot calculates all order steps ahead of time, considering the unique requirements and fees of different exchanges. Due to these variations, the order amounts and quantities in SymBot are essentially close estimates. The exchange fee set in the configuration also affects the process. Since exchanges often take a portion with each transaction due to rules and fees, it's rare for deals to sell the exact quantity desired. SymBot aims to sell as close to the maximum bought while still hitting the target profit percentage. If errors like insufficient funds occur, it adjusts the quantity accordingly. However, many deals will likely leave behind small amounts of crypto otherwise known as crypto "dust".

#### Why did my bot get disabled or deal get paused?
- A bot can be disabled or a deal can be paused several ways including manually through the web interface, programmatically using APIs or Webhooks, or even the usage of signals. SymBot also has some safety features built-in that may disable a bot or pause a deal automatically if an unknown error occurs as a precautionary measure to ensure there isn't something more problematic occurring. Sometimes it may just be the exchange does not allow a specific pair to be traded, so removing it from your bot is recommended. Since many errors are exchange specific, it is best to review the logs if you are unsure why your bot is disabled.

#### Why is my system suddenly using more CPU or memory?
- SymBot is continuously monitoring and processing data from exchanges, potential signal providers you're using such as from 3CQS, accessing the database, or performing house-keeping tasks like purging old logs. During times of increased market volatility, more data could be coming in faster and may stay in memory for longer periods of time or as necessary. It is normal to see spikes in CPU or memory usage, but if either remain excessively high for extended periods of time you may want to look into it further. Many times upgrading your CPU, increasing system memory, or upgrading hard drive capacity tend to resolve most issues and provide much better performance and an improved trading experience. See also [Advanced Setup](#advanced-setup) for additional tips.

#### What is the difference between SymBot and SymBot Hub?
- SymBot is the software used for trading, while SymBot Hub serves as a central platform to manage multiple SymBot instances, offering a simplified and more efficient way to access them. While SymBot Hub is optional, it is highly recommended if you're running multiple SymBot instances.

#### How can I disable logging to file to save disk space?
- While we do not recommend disabling logging to file, you have the option to do so by running adding the argument `clglite` when starting the application. 
	- `npm start clglite`

## Disclaimer

All investment strategies and investments involve risk of loss. All information found here, including any ideas, opinions, views, predictions, forecasts, or suggestions, expressed or implied herein, are for informational, entertainment or educational purposes only and should not be construed as personal investment advice. Conduct your own due diligence, or consult a licensed financial advisor or broker before making any and all investment decisions. Any investments, trades, speculations, or discussions made on the basis of any information found here, expressed or implied herein, are committed at your own risk, financial or otherwise.

By using the software, you acknowledge that you should only invest money you are prepared to lose. The authors and affiliates are not responsible for any trading results, and you use the software at your own risk.

## Help Support

If you enjoy **SymBot** and would like to help support its growth, please consider contributing. Your donations will assist in maintaining and enhancing the project for the future.

You can contribute any amount through:

- **BTC**: bc1qz35q0jf94j44ljd9tyfwvgh4fcc5w8hmt9y24h
- **ETH**: 0x85aa19CB35A023265875d4d76C7dA09CCa9EF639
- **USDT (ERC20)**: 0x85aa19CB35A023265875d4d76C7dA09CCa9EF639
- Or directly via [GitHub Sponsors](https://github.com/sponsors/3cqs-coder)
