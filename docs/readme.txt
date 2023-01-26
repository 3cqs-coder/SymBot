Installation:

1. Open a command line terminal
2. Change directory to where SymBot files are located
3. Type: npm install
4. Wait until all packages are downloaded and installed
5. Modify the app and bot configuration files as necessary (see below)
6. Type: npm start
7. Open a web browser and type: http://127.0.0.1:3000



Configuration:

These files are located in the "config" directory

* app.json

	- "mongo_db_url" is the URL to your MongoDB instance.
		- For quick set up, create a free account at https://cloud.mongodb.com and copy the URL given into the app config. It begins with something like: mongodb+srv://
		- For better security running your own local database is recommended

	- "signals" contains a section to use signals with SymBot. There is a 3CQS signals section by default. If have an API key just copy it there or create an account at https://www.3CQS.com to get one.
	

* bot.json

	- This contains all default settings for your bot and exchange information. For test purposes, always leave "sandBox" set to true.
	- Valid exchanges include binance, binanceus, coinbase, and many others. SymBot uses the ccxt library so if the exchange is supported, you should be able to connect to it
