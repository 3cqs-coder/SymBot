***This branch provides Docker Swarm Support for SymBot  
Please see [README-Docker-Swarm.md](/docs/README-Docker-Swarm.md) for details***<br/>  


<br/>
<br/>

![SymBot Logo](https://user-images.githubusercontent.com/111208586/221390681-d13b9bce-dafb-4b55-a6f1-1bc5218cd204.png)

SymBot is a user friendly, self-hosted and automated DCA (Dollar Cost Averaging) cryptocurrency bot solution. Create and manage your bots entirely from your web browser or with simple built-in APIs. Best of all, your exchange credentials and keys always remain in your hands... not any other third-party.

![SymBot](https://user-images.githubusercontent.com/111208586/219070191-abe2ef94-ca5a-43a9-867c-2c2ff9609699.jpg)

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Installation Video](#installation-video)
- [Docker Installation](#installation-docker)
- [Upgrading](#upgrading)
- [Configuration](#configuration)
- [Telegram Setup](#telegram-setup)
- [Advanced Setup](#advanced-setup)
- [Reverse Proxy Setup](#reverse-proxy-setup)
- [API Information](#api-information)
- [API Sample Usage](#api-sample-usage)
- [Webhooks](#webhooks)
- [Resetting SymBot](#resetting-symbot)
- [Frequently Asked Questions (FAQ)](#frequently-asked-questions-faq)
- [Disclaimer](#disclaimer)

## Requirements

- Linux, MacOS, or Windows based system
- [Node.js](https://nodejs.org) must be installed on your system
- [MongoDB](https://www.mongodb.com) installed or a cloud host provider
- Access to a cryptocurrency exchange such as Binance or Coinbase
- Reliable high-speed internet connection
- 1GB RAM minimum but recommended at least 4GB
- 1GB disk space minimum

**NOTE:** Trading requires your system and internet connection to be running 24/7. Any interruption could result in missed trades, signals, etc. See also [Disclaimer](#disclaimer).


## Installation

If you would rather run SymBot using Docker then skip this section and go to the [Docker Installation](#installation-docker) below.


1. Open a command line terminal
2. Change directory to where SymBot files are located
3. Type: `npm install`
4. Wait until all packages are downloaded and installed
5. Modify the app and bot configuration files as necessary (see [Configuration](#configuration))
6. Type: `npm start`. You can also use `npm start consolelog` to display all logging to the console for testing purposes. The same information is also logged to files in the `logs` directory
7. Open a web browser and type: http://127.0.0.1:3000

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
3. Open the **app.json** configuration file and set `mongo_db_url` to `mongodb://symbot:symbot123@database/symbot`
4. Make any additional changes to the app and bot configuration files as necessary (see [Configuration](#configuration))
5. Change directory to `docker` in the same location where SymBot files are located
6. Type: `docker-compose -p symbot up -d --build`
7. Wait for Docker to build everything and all containers to start
8. Open a web browser and type: http://127.0.0.1:3000

Mongo Express is also installed which can be used to access MongoDB visually by opening a web browser to  http://127.0.0.1:3010

## Upgrading

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

	- `web_server` contains settings for the SymBot web server. The default port is 3000.

	- `api`
		- `key` is a hashed form of your API key that is generated using the web interface configuration. Do not set this manually or SymBot may not function properly.
		- `enabled` set to true to allow API access or false to disable access.

	- `webhook`
		- `enabled` set to true to allow Webhook usage.

	-	`bots`
		-	`start_conditions` contains keys and descriptions such as `asap` and `api` for various start conditions that can be used to start bots and deals. The keys should never be changed after the initial start of SymBot or they will not match previous bots and deals.
		- `pair_autofill_buttons` is an array of currencies that is used to automatically fill in pairs after clicking on one of these buttons when creating or updating bots.
		-	`pair_autofill_blacklist` is an array of trading pairs that you don't want automatically filled in the pair selection box when creating or updating bots and clicking one of the stablecoin buttons such as USD or USDT. You can use full pairs such as BTC/USD or wildcards such as BTC/*. This can be useful to prevent bots from starting deals using stablecoin pairs such as USDT/USD as those will generally have little volatility in typical market conditions.

	- `telegram` contains an optional Telegram token id and user id to send SymBot notifications to. This includes system warnings such as detected connectivity issues, bot and deal start / stops, and more! You must first create a Telegram bot with `@BotFather` to use (see [Telegram Setup](#telegram-setup)).

	- `mongo_db_url` is the URL to your MongoDB instance.

		- WARNING: If you run multiple instances of SymBot using the same database you will mess up your bots!
		- For quick set up, create a free account at https://cloud.mongodb.com and copy the URL given into the app config. It begins with something like: mongodb+srv://
		- If running a local MongoDB instance, specifying `
mongodb://127.0.0.1:27017/SymBot
` or `
mongodb://localhost:27017/SymBot
` should work fine, but setting up a username and password is also recommended
		- Keep in mind when using a cloud hosted database, the disk space capacity may be different from your server or the amount of data that can be stored may be limited.  This can cause issues with your bots and deals if your database does not have adequate disk space or there is increased latency accessing a remote database
		- For better speed and security, running your own local database is recommended

	- `signals` contains a section to use signals with SymBot. There is a 3CQS signals section by default. You must have a 3CQS API key for these to work. You can get one by signing up for free at https://www.3CQS.com. Webhooks must also be enabled for these signals to work.


- **bot.json**

	- This contains all default settings for your bot and exchange. Depending on your exchange, the API credentials you enter here usually include some of the following such as your exchange API key, secret, passphrase, or password. For testing purposes, often you can leave all of them empty but always leave `sandBox: true`.
	- Valid exchanges include binance, binanceus, coinbase, and many others. SymBot uses the [CCXT](https://github.com/ccxt/ccxt)  library so if the exchange is supported, you should be able to connect to it
	- Most bot settings do not need to be set here since they can be set when creating a bot in the web interface
	- Set your exchange fee appropriately. Exchanges such as Binance often use BNB (Binance Coin) for transaction fees. If you are receiving an error, it's possible that you don't have enough BNB to cover the fees associated with the trade. Binance deducts fees from your BNB balance, and if it's insufficient, the trade may fail. If you encounter trading errors such as being unable to sell or take profit, you may want to consider disabling certain trading fee enhancements like BNB (if applicable) on your exchange, and also increasing the `exchangeFee` value. Changing this value will only take affect on new deals.
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
		"dcaMaxOrder": 12
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

## Resetting SymBot

##### *** CAUTION *** This will purge all data from the SymBot database!

If you want to reset the SymBot database for any reason, you can do so only from the command line. It will first ask to confirm, then display a reset code you must enter, and confirm again.

1. Stop any running instances of SymBot
2. Type: `npm start reset` (or `node ./symbot.js reset`)

## Frequently Asked Questions (FAQ)

#### Why SymBot?
- SymBot was developed with two primary goals in mind:
	- Create a simple, easy to use, yet powerful crypto trading bot that would provide anyone who wanted to start trading cryptocurrencies with the ability to get up and running quickly with little technical knowledge.
	- Reduce the risk of having any other parties with access to your most valuable information when it comes to trading, which are your exchange credentials or API keys. There are ever growing cyber-threats, hacks, data breaches, and just overall bad actors that are constantly looking for ways to scam through sometimes fairly elaborate schemes. If your keys get into the hands of anyone with malicious intentions, you could lose all of your money and cryptocurrencies on your exchange. SymBot connects directly to your exchange so your API keys are never sent or shared with any other third-party.

#### What exchanges does SymBot support?
- SymBot uses the [CCXT](https://github.com/ccxt/ccxt) (CryptoCurrency eXchange Trading) library which supports many popular exchanges such as Binance and Coinbase. If your exchange is listed then you should be able to connect to it.

#### Can I run SymBot on my home network?
- Yes, however using a trusted hosting provider is a more stable choice. Trading requires your system to be running 24/7 along with an uninterrupted high-speed internet connection. Most established hosting data centers have readily available support teams to assist with system related issues, fully equipped with generators in case of power failures, redundant fiber connections, and operate inside hurricane resistant buildings. If your home experiences a power outage or any other unexpected scenarios, that may result in unplaced orders or missed trading signals which could impact your deals significantly.

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

#### Why is my system suddenly using more CPU or memory?
- SymBot is continuously monitoring and processing data from exchanges, potential signal providers you're using such as from 3CQS, accessing the database, or performing house-keeping tasks like purging old logs. During times of increased market volatility, more data could be coming in faster and may stay in memory for longer periods of time or as necessary. It is normal to see spikes in CPU or memory usage, but if either remain excessively high for extended periods of time you may want to look into it further. Many times upgrading your CPU, increasing system memory, or upgrading hard drive capacity tend to resolve most issues and provide much better performance and an improved trading experience. See also [Advanced Setup](#advanced-setup) for additional tips.

## Disclaimer

All investment strategies and investments involve risk of loss. All information found here, including any ideas, opinions, views, predictions, forecasts, or suggestions, expressed or implied herein, are for informational, entertainment or educational purposes only and should not be construed as personal investment advice. Conduct your own due diligence, or consult a licensed financial advisor or broker before making any and all investment decisions. Any investments, trades, speculations, or discussions made on the basis of any information found here, expressed or implied herein, are committed at your own risk, financial or otherwise.

By using the software, you acknowledge that you should only invest money you are prepared to lose. The authors and affiliates are not responsible for any trading results, and you use the software at your own risk.
