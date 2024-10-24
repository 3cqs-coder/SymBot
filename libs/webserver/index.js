'use strict';

const fs = require('fs');
const path = require('path');

const pathRoot = path.dirname(fs.realpathSync(__dirname)).split(path.sep).join(path.posix.sep);

const bodyParser = require('body-parser');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const MongoDBStore = require('connect-mongodb-session')(session);
const app = express();
const router = express.Router();
const Routes = require(pathRoot + '/webserver/routes.js');

const serverTimeoutMins = 3;

let shareData;
let socket;



const shouldCompress = (req, res) => {

	if (req.headers['x-no-compression']) {

		return false;
	}

	return compression.filter(req, res);
}



function initApp() {

	const sessionExpireMins = 60 * 24;
	const sessionCookieName = 'SymBot' + shareData.appData.instance_name;

	let sessionSecret = shareData.appData.server_id;

	let store;

	if (!shareData.appData.config_mode) {

		store = new MongoDBStore({

			'uri': shareData.appData.mongo_db_url,
			'collection': 'sessions'
		},
		function(err) {

			if (err) {

				shareData.Common.logger(JSON.stringify(err));
			}
		});
	}
	else {

		sessionSecret = 'SymBot' + Math.floor(Math.random() * 1000000) + 1;

		const FileStore = require('session-file-store')(session);

		store = new FileStore({
			'path': path.join(pathRoot, '..', 'sessions'),
			'logFn': function() {}
		});
	}

	const sessionMiddleware = session({

		'secret': sessionSecret,
		'name': sessionCookieName,
		'resave': false,
		'saveUninitialized': false,
		'store': store,
		'cookie': {
			'expires': (sessionExpireMins * 60) * 1000
		}
	});

	app.disable('x-powered-by');

	app.use(sessionMiddleware);

	// Compress all HTTP responses
	app.use(compression({

		filter: shouldCompress,
		level: 6,

	}));

	app.use(function(err, req, res, next) {

		shareData.Common.logger(JSON.stringify(err.stack));
	});

	app.set('views', pathRoot + '/webserver/public/views');
	app.set('view engine', 'ejs');

	app.use('/js', express.static(pathRoot + '/webserver/public/js'));
	app.use('/css', express.static(pathRoot + '/webserver/public/css'));
	app.use('/data', express.static(pathRoot + '/webserver/public/data'));
	app.use('/images', express.static(pathRoot + '/webserver/public/images'));

	app.use(express.json());

	app.use(cookieParser());

	app.use((req, res, next) => {

		const allowedRoutes = ['/login', '/config'];

		const timeOut = (60 * 1000) * serverTimeoutMins;

		req.setTimeout((timeOut - (1000 * 5)));
		res.append('Server', shareData.appData.name + ' v' + shareData.appData.version);

		if (shareData.appData.config_mode && allowedRoutes.length > 0 && !allowedRoutes.includes(req.path)) {

			//return res.status(403).send('Access Forbidden: This route is not allowed.');
			res.redirect('/login');

			return;
		}

		if (shareData.appData.database_error || shareData.appData.system_pause) {

			let obj = {
				'date': new Date(),
				'error': shareData.appData.database_error || shareData.appData.system_pause
			};
		
			res.status(503).send(obj);
		}
		else {

			next();
		}
	});

	const upload = multer({
		dest: 'uploads/',
		limits: { fileSize: 100000000 }
	});

	app.use(bodyParser.json({

		limit: "100mb",
		extended: true

	}));

	app.use(bodyParser.urlencoded({

		limit: "100mb",
		extended: true,
		parameterLimit: 500000

	}));

	app.use('/', router);

	return { sessionMiddleware, upload };
}


function initSocket(sessionMiddleware, server) {

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

	socket.on('connect', function (client) {

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
			}
			else {

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

			client.on('notifications_history', function (data) {

				shareData.Common.getNotificationHistory(client, data);
			});
		}
	});
}


async function getSocket() {

	return socket;
}


function start(port) {

	let isError;

	const { sessionMiddleware, upload } = initApp();

	let server = app.listen(port, () => {

		shareData.Common.logger(`${shareData.appData.name} v${shareData.appData.version} listening on port ${port}`, true);

	}).on('error', function(err) {

		isError = err;

		if (err.code === 'EADDRINUSE') {

			shareData.Common.logger(`Port ${port} already in use`, true);

			shareData.System.shutDown();
		}
		else {

			shareData.Common.logger('Web Server Error: ' + err, true);
		}
	});

	if (isError == undefined || isError == null) {

		const serverTimeout = (60 * 1000) * serverTimeoutMins;

		const keepAliveTimeout = serverTimeout - (1000 * 5);
		const headersTimeout = keepAliveTimeout + (1000 * 3);

		server.setTimeout(serverTimeout);

		server.keepAliveTimeout = keepAliveTimeout;
		server.headersTimeout = headersTimeout;

		initSocket(sessionMiddleware, server);

		Routes.start(router, upload);
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

