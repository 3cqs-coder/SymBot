## SymBot

SymBot is a user friendly, self-hosted DCA (Dollar Cost Averaging) automated cryptocurrency bot solution. Create and manage your bots entirely from a web interface. Best of all, your exchange credentials and keys always remain in your hands... not any other third-party.

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
6. Type: `npm start`
7. Open a web browser and type: http://127.0.0.1:3000

To have SymBot run in the background it is recommend to use the Node.js process manager called **pm2**. Here's how to use it:

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

Now SymBot will automatically start even when the system is rebooted. With the above configuration **pm2** will monitor SymBot and if memory exceeds roughly one gigabyte, a kill signal will be sent to SymBot. **pm2** will wait eight seconds before terminating the process to give SymBot some time to safely shut itself down. **pm2** will then start SymBot again. You can change those settings to suit your own server requirements and needs.

## Configuration

These files are located in the "config" directory

- **app.json**

	- "password" is the password used to login to the SymBot web portal. The default password is "admin".

	- "web_server" contains settings for the SymBot web server. The default port is 3000.

	- "telegram" contains an optional Telegram token id and user id to send SymBot notifications to. This includes system warnings such as detected connectivity issues, bot and deal start / stops, and more! You must first create a Telegram bot with @BotFather to use.

	- "mongo_db_url" is the URL to your MongoDB instance.

		- WARNING: If you run multiple instances of SymBot using the same database you will mess up your bots!
		- For quick set up, create a free account at https://cloud.mongodb.com and copy the URL given into the app config. It begins with something like: mongodb+srv://
		- For better security running your own local database is recommended

	- "signals" contains a section to use signals with SymBot. There is a 3CQS signals section by default. If you have an API key just copy it there or create an account at https://www.3CQS.com to get one.
	

- **bot.json**

	- This contains all default settings for your bot and exchange information. For test purposes, always leave "sandBox" set to true.
	- Valid exchanges include binance, binanceus, coinbase, and many others. SymBot uses the ccxt library so if the exchange is supported, you should be able to connect to it
	- Most bot settings do not need to be set here since they can be set when creating a bot in the web view

## Resetting SymBot

##### *** CAUTION *** This will purge all data from the SymBot database!

If you want to reset the SymBot database for any reason, you can do so only from the command line. It will first ask to confirm, then display a reset code you must enter, and confirm again.

1. Stop any running instances of SymBot
2. Type: `npm start reset` (or `node ./symbot.js reset`)

## Disclaimer

All investment strategies and investments involve risk of loss. All information found here, including any ideas, opinions, views, predictions, forecasts, or suggestions, expressed or implied herein, are for informational, entertainment or educational purposes only and should not be construed as personal investment advice. Conduct your own due diligence, or consult a licensed financial advisor or broker before making any and all investment decisions. Any investments, trades, speculations, or discussions made on the basis of any information found here, expressed or implied herein, are committed at your own risk, financial or otherwise. Use at your own risk.
