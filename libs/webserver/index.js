'use strict';

const fs = require('fs');
const path = require('path');

const pathRoot = path.dirname(fs.realpathSync(__dirname)).split(path.sep).join(path.posix.sep);

const bodyParser = require('body-parser');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const express = require('express');
const session = require('express-session');
const app = express();
const router = express.Router();
const Routes = require(pathRoot + '/webserver/routes.js');


const sessionExpireMins = 60 * 24;
const sessionSecret = genString(30);


let shareData;


const sessionMiddleware = session({

	secret: sessionSecret,
	resave: false,
	saveUninitialized: false,
	cookie: {
		expires: (sessionExpireMins * 60) * 1000
	}
});


const shouldCompress = (req, res) => {

	if (req.headers['x-no-compression']) {

		return false;
	}

	return compression.filter(req, res);
}



function initApp() {

	// Compress all HTTP responses
	app.use(compression({

		filter: shouldCompress,
		level: 6,

	}));

	app.disable('x-powered-by');

	app.use((req, res, next) => {

		res.append('Server', shareData.appData.name + ' v' + shareData.appData.version);

		next();
	});

	app.use(function(err, req, res, next) {

		shareData.Common.logger(JSON.stringify(err.stack));
	});

	app.set('views', pathRoot + '/webserver/public/views');
	app.set('view engine', 'ejs');

	app.use('/js', express.static(pathRoot + '/webserver/public/js'));
	app.use('/css', express.static(pathRoot + '/webserver/public/css'));
	app.use('/images', express.static(pathRoot + '/webserver/public/images'));

	app.use(sessionMiddleware);

	app.use(express.json());

	app.use(cookieParser());

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

	Routes.start(router);
}


function genString(len) {

	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

	let res = '';

	for (let i = 0; i < len; i++) {

		res += chars.charAt(Math.floor(Math.random() * chars.length));
	}

	return res;
}


function start(port) {

	initApp();

	app.listen(port, () => {
	
		shareData.Common.logger(`${shareData.appData.name} v${shareData.appData.version} listening on port ${port}`, true);

	}).on('error', function(err) {

		if (err.code === 'EADDRINUSE') {

			shareData.Common.logger(`Port ${port} already in use`, true);

			process.exit(1);
		}
	});
}


module.exports = {

	app,
	start,

	init: function(obj) {

		shareData = obj;
		Routes.init(shareData);
    }
}

