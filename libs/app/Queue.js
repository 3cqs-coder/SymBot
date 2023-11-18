'use strict';

const async = require('async');

let shareData;


async function create(concurrency) {

	const queue = async.queue((task, completed) => {

		const req = task.req;
		const res = task.res;
		const taskName = task.name;
		const initCallBack = task.init_callback;

		//console.log('Queued task: ' + taskName);

		if (taskName == 'start_deal') {

			initCallBack(req, res, { 'task': task, 'completed': completed });
		}
		else {

			const remaining = queue.length();

			return completed('Unknown task name', { task, remaining });
		}

	}, concurrency);


	const add = async function(taskObj, initCallBack) {

		taskObj['init_callback'] = initCallBack;

		queue.push(taskObj, (error, { task, remaining }) => {

			if (error) {

				let msg = `Queue error: Task ${task.name}: ${error}`;

				shareData.Common.logger(msg);

				try {

					const res = task.res;

					let obj = {

						'date': new Date(),
						'error': msg
					};

					res.status(404).send(obj);
				}
				catch(e) {}
			}
			else {

				//const data = JSON.stringify(task.data);
				//console.log(`Finished task ${task.name}. Data: ${data}. ${remaining} tasks remaining`);
			}
		});
	}


	const callBack = async function(res, resObj, taskObj) {

		let task = taskObj['task'];
		let completed = taskObj['completed'];

		task.data = resObj;

		const remaining = queue.length();

		completed(null, { task, remaining });

		if (res) {

			try {

				res.send(resObj);
			}
			catch(e) {}
		}
	}


	queue.drain(() => {

		//console.log('Queue complete.');
	});


	return { 'queue': queue, 'add': add, 'callBack': callBack };
}



module.exports = {

	create,

	init: function(obj) {

		shareData = obj;
	},
};
