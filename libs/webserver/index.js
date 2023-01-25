'use strict';

const fs = require('fs');
const path = require('path');

const pathRoot = path.dirname(fs.realpathSync(__dirname));

const bodyParser = require('body-parser');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const express = require('express');
const app = express();
const router = express.Router();



const port = process.env.PORT || 3000;


let shareData;





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
	
	initRoutes();
}


function initRoutes() {

	router.get('/', (req, res) => {

		res.set('Cache-Control', 'no-store');

		res.render( 'homeView', { 'appData': shareData.appData } );
	});


	router.all('*', (req, res) => {

		let obj = {

			'error': 'Not Found'
		};

		res.status(404).send(obj);
	});
}


function start() {

	initApp();

	app.listen(port, () => shareData.Common.logger(`${shareData.appData.name} v${shareData.appData.version} listening on port ${port}`));
}


module.exports = {

	app,
	start,

	init: function(obj) {

		shareData = obj;
    }
}

