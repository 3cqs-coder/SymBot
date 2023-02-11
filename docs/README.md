## SymBot

SymBot is a user friendly, self-hosted and automated DCA (Dollar Cost Averaging) cryptocurrency bot solution. Create and manage your bots entirely from a web interface. Best of all, your exchange credentials and keys always remain in your hands... not any other third-party.

## Requirements

- Node.js must be installed on your system
- MongoDB or a host provider
- Access to a cryptocurrency exchange such as Binance or Coinbase
- Reliable internet connection

## Installation

1. Open a command line terminal
2. Change directory to where SymBot files are located
3. Type: `npm install`
4. Wait until all packages are downloaded and installed
5. Modify the app and bot configuration files as necessary (see below)
6. Type: `npm start`. You can also use `npm start consolelog` to display all logging to the console for testing purposes. The same information is also logged to files in the `logs` directory
7. Open a web browser and type: http://127.0.0.1:3000

To have SymBot run in the background it is recommended to use the Node.js process manager called **pm2**. Here's how to use it:

1. Install **pm2** by typing: `npm install pm2 -g`
2. Create a file called `ecosystem.config.js` and place the below configuration into it:
```
module.exports = {

	apps: [
			{
				name: 'symbot',
				namespace: 'symbot',
				script: '/home/symbot/symbot.js',
				kill_timeout: 8000,
				max_memory_restart: '1000M'
			}
		  ]
}
```
3. Replace `/home/symbot/symbot.js` with the actual location where SymBot resides on your server and save the file
4. Tell **pm2** to start SymBot with a one time only command by typing: `pm2 start ecosystem.config.js`
5. Type: `pm2 save` to save the configuration
6. If you don't already have **pm2** starting at system boot time, type this with root privileges: `pm2 startup`. Then type: `pm2 save`

SymBot will now start automatically even when the system is rebooted. With the above configuration **pm2** will monitor SymBot and if memory exceeds roughly one gigabyte, a kill signal will be sent to SymBot. **pm2** will wait eight seconds before terminating the process to give SymBot some time to safely shut itself down. **pm2** will then start SymBot again. You can change those settings to suit your own server requirements and needs.

## Configuration

These files are located in the `config` directory

- **app.json**

	- `password` is the password used to login to the SymBot web portal. The default password is "admin".

	- `api_key` is a UUID v4 value that is randomly generated the first time SymBot starts. It is used to make API calls to SymBot. This can be set to most any string value you choose.

	- `web_server` contains settings for the SymBot web server. The default port is 3000.

	-	`bots` contains start condition keys and descriptions such as `asap` and `api`. The keys should never be changed after the initial start of SymBot or they will not match previous bots and deals.

	- `telegram` contains an optional Telegram token id and user id to send SymBot notifications to. This includes system warnings such as detected connectivity issues, bot and deal start / stops, and more! You must first create a Telegram bot with @BotFather to use.

	- `mongo_db_url` is the URL to your MongoDB instance.

		- WARNING: If you run multiple instances of SymBot using the same database you will mess up your bots!
		- For quick set up, create a free account at https://cloud.mongodb.com and copy the URL given into the app config. It begins with something like: mongodb+srv://
		- For better security running your own local database is recommended

	- `signals` contains a section to use signals with SymBot. There is a 3CQS signals section by default. If you have an API key just copy it there or create an account at https://www.3CQS.com to get one.
	

- **bot.json**

	- This contains all default settings for your bot and exchange information. For test purposes, always leave `sandBox: true`.
	- Valid exchanges include binance, binanceus, coinbase, and many others. SymBot uses the ccxt library so if the exchange is supported, you should be able to connect to it
	- Most bot settings do not need to be set here since they can be set when creating a bot in the web view

- **server.json**

	- This file is created the very first time SymBot is started. It contains an automatically generated UUID v4 `server_id`. The primary purpose is to ensure if there are ever multiple instances of SymBot running, they do not accidentally conflict with the database used. When SymBot starts it will compare the `server_id` value in this file to the database entry. If they do not match, SymBot will shut down. 
	- This file should never be copied to another folder or server if you plan to run additional instances of SymBot, or manually edited unless you have a good reason to do so.

## API Information

Take more control of your bots and deals using SymBot APIs. You can easily enable or disable bots and start deals using triggers or signals from 3CQS, TradingView, your own custom scripts and strategies, or from any of your other favorite providers.

### Create bot
| **Name**                      | **Type** | **Mandatory** | **Values (default)** | **Description**                                                         |   |
|-------------------------------|----------|---------------|----------------------|-------------------------------------------------------------------------|---|
| botName                       | string   | NO            |                      | Bot name will be generated if omitted                                   |   |
| pair                          | array    | YES           |                      | List of pairs used for the bot                                          |   |
| active                        | boolean  | NO            | false                | Enabled: true / Disabled: false                                         |   |
| createStep                    | string   | NO            |                      | Set to "getOrders" for a preview of DCA orders and not create the bot   |   |
| firstOrderAmount              | number   | YES           |                      | Initial or base order amount for each deal                              |   |
| dcaOrderAmount                | number   | YES           |                      | Amount for every additional DCA / safety order                          |   |
| dcaOrderStepPercent           | number   | YES           |                      | Price deviation percentage to open safety orders                        |   |
| dcaOrderSizeMultiplier        | number   | YES           |                      | Multiplies the amount of funds used by the last safety order            |   |
| dcaOrderStepPercentMultiplier | number   | YES           |                      | Multiplies the price deviation percentage used by the last safety order |   |
| dcaTakeProfitPercent          | number   | YES           |                      | Take profit percentage the bot will use to close successful deals       |   |
| dcaMaxOrder                   | integer  | YES           |                      | Maximum DCA / safety orders allowed per deal                            |   |
| dealMax                       | integer  | NO            |                      | Maximum deals allowed per pair. Set to 0 for unlimited                  |   |
| startCondition                | string   | NO            | asap                 | Start deals using "asap" or by "api"                                    |   |


```
POST /api/bots/create
```

### Update bot
| **Name**                      | **Type** | **Mandatory** | **Values (default)** | **Description**                                                         |   |
|-------------------------------|----------|---------------|----------------------|-------------------------------------------------------------------------|---|
| botId                         | string   | YES           |                      | Bot ID to be updated                                                    |   |
| botName                       | string   | NO            |                      | Bot name will be generated if omitted                                   |   |
| pair                          | array    | YES           |                      | List of pairs used for the bot                                          |   |
| active                        | boolean  | NO            | false                | Enabled: true / Disabled: false                                         |   |
| firstOrderAmount              | number   | YES           |                      | Initial or base order amount for each deal                              |   |
| dcaOrderAmount                | number   | YES           |                      | Amount for every additional DCA / safety order                          |   |
| dcaOrderStepPercent           | number   | YES           |                      | Price deviation percentage to open safety orders                        |   |
| dcaOrderSizeMultiplier        | number   | YES           |                      | Multiplies the amount of funds used by the last safety order            |   |
| dcaOrderStepPercentMultiplier | number   | YES           |                      | Multiplies the price deviation percentage used by the last safety order |   |
| dcaTakeProfitPercent          | number   | YES           |                      | Take profit percentage the bot will use to close successful deals       |   |
| dcaMaxOrder                   | integer  | YES           |                      | Maximum DCA / safety orders allowed per deal                            |   |
| dealMax                       | integer  | NO            |                      | Maximum deals allowed per pair. Set to 0 for unlimited                  |   |
| startCondition                | string   | NO            | asap                 | Start deals using "asap" or by "api"                                    |   |



```
POST /api/bots/update
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

### Start deal

| **Name** | **Type** | **Mandatory** | **Values (default)** | **Description** |
|----------|----------|---------------|----------------------|-----------------|
| botId    | string   | YES           |                      |                 |
| pair     | string   | NO            |                      | Only required for multi-pair bots |


```
POST /api/bots/{botId}/start_deal
```

### Sample  Usage:

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
http://127.0.0.1:3000/api/bots/update
```

#### Enable bot
```
curl -i -X POST \
-H 'Accept: application/json' \
-H 'api-key: {API-KEY}' \
http://127.0.0.1:3000/api/bots/{botId}/enable
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

## Resetting SymBot

##### *** CAUTION *** This will purge all data from the SymBot database!

If you want to reset the SymBot database for any reason, you can do so only from the command line. It will first ask to confirm, then display a reset code you must enter, and confirm again.

1. Stop any running instances of SymBot
2. Type: `npm start reset` (or `node ./symbot.js reset`)

## Disclaimer

All investment strategies and investments involve risk of loss. All information found here, including any ideas, opinions, views, predictions, forecasts, or suggestions, expressed or implied herein, are for informational, entertainment or educational purposes only and should not be construed as personal investment advice. Conduct your own due diligence, or consult a licensed financial advisor or broker before making any and all investment decisions. Any investments, trades, speculations, or discussions made on the basis of any information found here, expressed or implied herein, are committed at your own risk, financial or otherwise. Use at your own risk.
