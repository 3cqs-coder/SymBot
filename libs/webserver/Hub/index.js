'use strict';

const fs = require('fs');
const path = require('path');

const pathRoot = path.dirname(fs.realpathSync(__dirname)).split(path.sep).join(path.posix.sep);

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bodyParser = require('body-parser');
const Routes = require(pathRoot + '/Hub/routes.js');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const router = express.Router();

const proxyMap = new Map();

let socket;
let shareData;



async function initApp() {

	const sessionExpireMins = 60 * 24;
	const sessionCookieName = 'SymBotHub';

	const hashPassword = crypto.createHash('sha256').update(shareData.appData.password).digest('hex');

	const sessionMiddleware = session({

		'secret': hashPassword,
		'name': sessionCookieName,
		'resave': false,
		'saveUninitialized': false,
		'store': new FileStore({
			'path': shareData.appData.path_root + '/sessions',
			'logFn': function() {}
		}),
		'cookie': {
			'expires': (sessionExpireMins * 60) * 1000
		}
	});

	// Middleware to handle incoming requests
	app.use('/instance/:appId', async (req, res, next) => {

		const { appId } = req.params;

		/*
		console.log(`Received request for appId: ${appId}`);
		console.log(`Original URL: ${req.originalUrl}`);
		console.log(`Method: ${req.method}`);
		console.log(`Request Body:`, req.body);
		*/

		const proxyMiddleware = await getProxyMiddleware(appId);

		if (proxyMiddleware.success) {

			const proxy = proxyMiddleware.proxy;

			return proxy(req, res, next);
		}
		else {

			const err = proxyMiddleware.error;

			const msg = 'Error during proxying: ' + err;

			shareData.Hub.logger('error', msg);

			if (!res.headersSent) {
	
				return res.status(500).send(msg);
			}
		}		
	});

	app.use(sessionMiddleware);

	app.disable('x-powered-by');

	app.use((req, res, next) => {

		res.append('Server', 'SymBot Hub');
		next();
	});

	app.use(express.json());

	app.use(bodyParser.urlencoded({
		extended: true
	}));

	app.use(bodyParser.json());

	app.set('views', pathRoot + '/public/views');
	app.set('view engine', 'ejs');

	app.use('/js', express.static(pathRoot + '/public/js'));
	app.use('/css', express.static(pathRoot + '/public/css'));
	app.use('/data', express.static(pathRoot + '/public/data'));
	app.use('/images', express.static(pathRoot + '/public/images'));

	app.use('/', router);

	return { sessionMiddleware };
}


// Create or get the proxy middleware for an appId
const getProxyMiddleware = async (appId) => {

	let success = true;

	let isError;
	let proxyFound;

	if (!proxyMap.has(appId)) {

		const port = await getAppPort(appId);

		if (!port) {

			success = false;

			isError = `No matching port found for appId: ${appId}`;
		}

		if (success) {

			const targetUrl = `http://127.0.0.1:${port}`;

			//console.log(`Creating proxy middleware for ${appId} targeting ${targetUrl}`);

			const proxyMiddleware = createProxyMiddleware({
				target: targetUrl,
				changeOrigin: true,
				followRedirects: false,
				autoRewrite: true,
				hostRewrite: true,
				cookieDomainRewrite: true,
				ws: true,
				pathRewrite: (path) => path.replace(`/instance/${appId}`, ''),
				timeout: 120000,
				proxyTimeout: 120000,
				on: {
					proxyReq: (proxyReq, req) => {

						//console.log('Proxy Request:', req.method, req.originalUrl);

						const realIp = req.headers['x-forwarded-for'] 
							? `${req.headers['x-forwarded-for']}, ${req.socket.remoteAddress}`
							: req.socket.remoteAddress;

						proxyReq.setHeader('X-Forwarded-For', realIp);

						if (req.headers.cookie) {

							proxyReq.setHeader('Cookie', req.headers.cookie);
						}
					},
					proxyRes: (proxyRes, req, res) => {

						//console.log('Response received:', proxyRes.statusCode);

						if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400) {

							const location = proxyRes.headers['location'];
							const newLocation = `/instance/${appId}${location}`;

							//console.log(`Redirecting to: ${location}`);

							return res.redirect(proxyRes.statusCode, newLocation);
						}
					},
					error: (err, req, res) => {

						let msg = 'Proxy Error: ' + JSON.stringify(err.message);

						shareData.Hub.logger('error', msg);

						if (res && res.status && !res.headersSent) {

							return res.status(500).send(msg);
						}
						else {

							//console.error('Proxy response object is not valid:', res);
							shareData.Hub.logger('error', 'Proxy response object is not valid');
						}
					},
				},
			});

			proxyMap.set(appId, proxyMiddleware);
		}
	}

	if (success) {

		proxyFound = proxyMap.get(appId);
	}

	return ( { 'success': success, 'error': isError, 'proxy': proxyFound } );
};


async function getAppPort(appId) {

	const ports = shareData.appData['web_server_ports'];

	for (let port of ports) {

		if (port == appId) {

			return port;
		}
	}

	return undefined;
}


async function initSocket(sessionMiddleware, server) {

	socket = require('socket.io')(server, {

		cors: {
			origin: '*',
			methods: ['PUT', 'GET', 'POST', 'DELETE', 'OPTIONS'],
			credentials: false
		},
		path: '/' + shareData.appData['web_socket_path'],
		serveClient: false,
		pingInterval: 10000,
		pingTimeout: 5000,
		maxHttpBufferSize: 1e6,
		cookie: false
	});

	const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);

	socket.use(wrap(sessionMiddleware));

	socket.use((client, next) => {

		return next();
	});

	socket.on('connect', (client) => {

		let clientId = client.id;
		let loggedIn = client.request.session.loggedIn;
		let query = client.handshake.query;

		//console.log('Connected ID:', clientId, loggedIn);

		if (!loggedIn) {

			client.emit('error', 'Unauthorized');
			client.disconnect();
		}
		else {

			if (query.room == undefined || query.room == null || query.room == '') {

				client.join(roomAuth);
			} else {

				client.join(query.room);
			}

			client.on('joinRooms', (data) => {

				data.rooms.forEach(room => {

					client.join(room);
					//console.log(`Client joined room: ${room}`);
				});
			});

			client.on('leaveRoom', (room) => {

				client.leave(room);
				//console.log(`Client left room: ${room}`);
			});

			client.on('notifications_history', function(data) {

				//shareData.Common.getNotificationHistory(client, data);
			});
		}
	});
}


async function getSocket() {

	return socket;
}


async function start(port) {

	let isError;

	const { sessionMiddleware } = await initApp();

	let server = app.listen(port, () => {

		shareData.Hub.logger('info', `SymBot Hub running on port ${port}`);

	}).on('error', function(err) {

		isError = err;

		if (err.code === 'EADDRINUSE') {

			shareData.Hub.logger('error', `Port ${port} already in use`);

			process.exit(1);
		}
		else {

			shareData.Hub.logger('error', 'Web Server Error: ' + err);
		}
	});

	/*
		server.on('upgrade', async (req, socket, head) => {

			const segments = req.url.split('/');
	    
			const appId = segments[2];
		
			try {
				const proxyMiddleware = await getProxyMiddleware(appId);
				// Call the proxy middleware for WebSocket upgrade
				proxyMiddleware.upgrade(req, socket, head);
			} catch (err) {
				console.error('Error during WebSocket upgrade:', err);
				socket.destroy(); // Close the socket on error
			}
		});
	*/

	if (isError == undefined || isError == null) {

		await initSocket(sessionMiddleware, server);

		Routes.start(router);
	}
}



module.exports = {

	app,
	start,
	getSocket,

	init: function(obj) {

		shareData = obj;
		Routes.init(shareData);
	}
}