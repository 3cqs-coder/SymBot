'use strict';

const fs = require('fs');
const path = require('path');

const pathRoot = path.dirname(fs.realpathSync(__dirname)).split(path.sep).join(path.posix.sep);

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bodyParser = require('body-parser');
const Routes = require(pathRoot + '/hub/routes.js');

const app = express();
const router = express.Router();


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
				'logFn': function(){}
		}),
		'cookie': {
			'expires': (sessionExpireMins * 60) * 1000
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


async function initSocket(sessionMiddleware, server) {

	socket = require('socket.io')(server, {

		cors: {
			origin: '*',
			methods: ['PUT', 'GET', 'POST', 'DELETE', 'OPTIONS'],
			credentials: false
		},
		path: '/ws',
		serveClient: true,
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