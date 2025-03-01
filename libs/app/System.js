'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const bson = require('bson');
const crypto = require('crypto');
const mongoose = require('mongoose');
const archiver = require('archiver');
const unzipper = require('unzipper');
const fetch = require('node-fetch-commonjs');
const { exec } = require('child_process');

const prompt = require('prompt-sync')({
	sigint: true
});

let pathRoot = path.dirname(fs.realpathSync(__dirname)).split(path.sep).join(path.posix.sep);
pathRoot = pathRoot.substring(0, pathRoot.lastIndexOf('/'));

let shareData;
let shutDownFunction;
let dbUrl;

const backupDir = pathRoot + '/backups';


const connectDb = async (url) => {

	if (url == undefined || url == null || url == '') {

		url = dbUrl;
	}

	try {

		const connection = mongoose.createConnection(url, {});

		// Ensure the connection is fully established
		await new Promise((resolve, reject) => {

			connection.once('open', resolve);
			connection.once('error', reject);
		});

		return connection;
	}
	catch (err) {

		shareData.Common.logger('Could not connect to MongoDB: ' + err);

		throw err;
	}
};


const resetDatabase = async (resetDb, resetServerId) => {

	let success = true;

	let isErr;
	let collectionBots;
	let collectionDeals;
	let collectionServer;

	try {

		const dbConnection = await connectDb();
		const db = dbConnection.db;

		if (resetDb) {

			collectionBots = await db.dropCollection('bots');
			collectionDeals = await db.dropCollection('deals');
		}

		if (resetServerId) {

			collectionServer = await db.dropCollection('server');

			await shareData.Common.saveConfig('server.json', { 'server_id': ''});
		}

		await dbConnection.close();
	}
	catch(e) {

		success = false;
		isErr = e;
	}

	const resObj =  {
						'success': success,
						'error': isErr,
						'collectionBots': collectionBots,
						'collectionDeals': collectionDeals,
						'collectionServer': collectionServer
					};

	return resObj;
};


const backupAllCollections = async (dbConnection, dir) => {

    let success = true;
	let isErr;

    try {
        const db = dbConnection.db;
        const collections = await db.listCollections().toArray();

        if (!fs.existsSync(dir)) {

			fs.mkdirSync(dir, { recursive: true });
        }

		const dbDir = dir + '/database';

		fs.mkdirSync(dbDir, { recursive: true });

        for (const collection of collections) {

            const collectionName = collection.name;
            const cursor = db.collection(collectionName).find();
            const filePath = path.join(dbDir, `${collectionName}.bson`);
            const fileStream = fs.createWriteStream(filePath);

            fileStream.on('error', (err) => {
                throw err;
            });

            while (await cursor.hasNext()) {

                const doc = await cursor.next();
                const serializedData = bson.serialize(doc);
                const dataSizeBuffer = Buffer.alloc(4);
                dataSizeBuffer.writeInt32LE(serializedData.length);
                fileStream.write(dataSizeBuffer);
                fileStream.write(serializedData);
            }

            fileStream.end();

			shareData.Common.logger(`Backup of ${collectionName} successful.`);
        }
    }
	catch (err) {
 
		success = false;
		isErr = err.message;

		shareData.Common.logger('Backup failed: ' + isErr);
    }

    return { 'success': success, 'error': isErr };
};


const restoreAllCollections = async (dbConnection, dir) => {

    let success = true;
	let isErr;

	const dbDir = dir + '/database';

    try {
        const db = dbConnection.db;
        const files = fs.readdirSync(dbDir);

		if (files.length < 1) {

			const msg = 'No database files found';

			throw new Error(msg);
		}

		for (const file of files) {

            if (file.endsWith('.bson')) {

                const filePath = path.join(dbDir, file);
                const dataBuffer = fs.readFileSync(filePath);

                let offset = 0;
                const collectionName = path.basename(file, '.bson');
                const collection = db.collection(collectionName);

                // Clear the collection before restoring
                await collection.deleteMany();

                while (offset < dataBuffer.length) {

                    // Read the document size (4 bytes)
                    const documentSize = dataBuffer.readInt32LE(offset);
                    offset += 4;

                    // Extract the document data
                    const docBuffer = dataBuffer.slice(offset, offset + documentSize);
                    const doc = bson.deserialize(docBuffer);

                    // Insert the document
                    await collection.insertOne(doc);

                    // Move to the next document
                    offset += documentSize;
                }

				shareData.Common.logger(`Restore of ${collectionName} successful.`);
            }
        }
    }
	catch (err) {

        success = false;
		isErr = err.message;

		shareData.Common.logger('Restore failed: ' + isErr);
    }

    return { 'success': success, 'error': isErr };
};


const backupDb = async () => {

	let res;

	const dir = backupDir + '/' + shareData.Common.uuidv4();

	shareData.Common.logger('Database backup started');

	const dbConnection = await connectDb();

	try {

		res = await backupAllCollections(dbConnection, dir);
	}
	finally {

		await dbConnection.close();
	}

	return { 'success': res.success, 'error': res.error, 'dir': dir };
};


const restoreDb = async (dir) => {

	let res;

	shareData.Common.logger('Database restore started');

	const dbConnection = await connectDb();

	try {

		res = await restoreAllCollections(dbConnection, dir);
	}
	finally {

		await dbConnection.close();
	}

	return { 'success': res.success, 'error': res.error, 'dir': dir };
};


async function routeBackupDb(req, res) {

	if (await appStarting(req, res)) {

		return;
	}

	await pause(true, 'Database Backup Processing');

	// Wait short delay for data to stop processing
	await shareData.Common.delay(5000);

	const body = req.body;

	let password = body.password;

	const dateParts = shareData.Common.getDateParts(new Date());

	let dateNow = dateParts.date
	let timeNow = dateParts.time;

	dateNow = dateNow.replace(/[^a-zA-Z0-9]/g, '');
	timeNow = timeNow.replace(/[^a-zA-Z0-9]/g, '');

	const fileName = shareData.appData.name + '-backup-' + dateNow + '_' + timeNow + '.zip';

	const outFile = backupDir + '/' + fileName;

	const resBackup = await backupDb();

	const success = resBackup['success'];
	const dir = resBackup['dir'];

	if (success) {

		const manifestFile = dir + '/.manifest.json';

		// Create manifest
		await logManifest(shareData.appData.version, dir, manifestFile);

		shareData.Common.logger('Compressing: ' + fileName);

		await compress(dir, outFile);

		removeDirectorySync(dir);

		const outFileEnc = outFile + '.enc';
		const fileNameEnc = fileName + '.enc';

		shareData.Common.logger('Encrypting: ' + fileName);

		const encryptObj = await encryptFile(outFile, outFileEnc, password);

		// Delete unencrypted file
		fs.unlinkSync(outFile);

		await pause(false);

		if (!encryptObj.success) {

			let msg = 'Encryption failed: ' + encryptObj.error;

			shareData.Common.logger(msg);

			throw new Error(msg);
		}

		res.download(outFileEnc, fileNameEnc, (err) => {

			if (err) {

				//console.error('Error sending file:', err);

				res.status(500).send('Error sending file');
			}
		});
	}
	else {

		res.status(500).send('Unable to process database backup');
	}
}


async function routeRestoreDb(req, res) {

	if (await appStarting(req, res)) {

		return;
	}

	const tempPath = req.file.path;
	const targetPath = backupDir + '/' + req.file.originalname;

	const body = req.body;

	let password = body.password;
	let convertData = shareData.Common.convertBoolean(body.convertData, false);
	let resetServerId = shareData.Common.convertBoolean(body.resetServerId, false);

	try {

		// Check if a file with the same name already exists
		try {

			await fsp.access(targetPath, fs.constants.F_OK);

			// File exists, remove it
			await fsp.unlink(targetPath);
		}
		catch (err) {

			// If the error is anything other than file not existing, rethrow
			if (err.code !== 'ENOENT') throw err;
		}

		// Process restore
		await processRestoreDb(tempPath, targetPath, password, convertData, resetServerId);

		// Send a success response
		res.status(200).send('File uploaded and database restored successfully.');
	}
	catch (err) {

		//console.error('File processing error:', err);

		res.status(500).send('An error occurred during the file processing: ' + err.message);
	}
}


async function processRestoreDb(tempPath, targetPath, password, convertData, resetServerId) {

	await pause(true, 'Database Restore Processing');

	// Wait short delay for data to stop processing
	await shareData.Common.delay(5000);

	const dir = backupDir + '/' + shareData.Common.uuidv4();

	let targetPathDec;
	let success = true;

	try {

		// Move uploaded backup file
		await fsp.rename(tempPath, targetPath);

		targetPathDec = targetPath + '.zip';

		shareData.Common.logger('Decrypting: ' + targetPath);

		const decryptObj = await decryptFile(targetPath, targetPathDec, password);

		if (!decryptObj.success) {

			let msg = 'Decryption failed: ' + decryptObj.error;

			shareData.Common.logger(msg);

			throw new Error(msg);
		}

		shareData.Common.logger('Decompressing: ' + targetPathDec);

		// Decompress backup file
		await decompress(targetPathDec, dir);

		// Restore database
		let res = await restoreDb(dir);

		if (!res.success) {

			throw new Error(res.error);
		}
	}
	catch (err) {

		success = false;

		throw new Error('An error occurred during restore: ' + err.message);
	}
	finally {

		// Remove files
		removeDirectorySync(dir);

		fs.unlinkSync(targetPath);
		fs.unlinkSync(targetPathDec);

		if (success) {

			if (convertData) {

				await shareData.DCABot.convertDataToSandBox();
			}

			if (resetServerId) {

				await resetDatabase(false, true);
			}

			// Shutdown
			shutDownFunction();
		}
		else {

			await pause(false);
		}
	}
}


async function generateChecksum(filePath) {

	const hash = crypto.createHash('sha256');
	const stream = fs.createReadStream(filePath);

	return new Promise((resolve, reject) => {
		stream.on('data', (data) => hash.update(data));
		stream.on('end', () => resolve(hash.digest('hex')));
		stream.on('error', reject);
	});
}


async function logManifest(version, directory, manifestFile) {

	const manifest = {
		date: new Date().toISOString(),
		version: version,
		files: []
	};

	async function processDirectory(dir) {

		const files = await fsp.readdir(dir);

		for (const file of files) {

			const filePath = path.join(dir, file);
			const stats = await fsp.lstat(filePath);

			const fileEntry = {
				filename: path.relative(directory, filePath),
				permissions: stats.mode.toString(8), // File permissions in octal format
				timestamp: stats.mtime.toISOString(), // Modification timestamp,
				size: stats.size // File size in bytes
			};

			if (stats.isFile()) {

				fileEntry.checksum = await generateChecksum(filePath);
				manifest.files.push(fileEntry);
			}
			else if (stats.isDirectory()) {

				fileEntry.type = 'directory';
				manifest.files.push(fileEntry);
				await processDirectory(filePath); // Recursively process the directory
			}
		}
	}

	await processDirectory(directory);

	await fsp.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
}


async function compress(source, out) {

    return new Promise((resolve, reject) => {

		const output = fs.createWriteStream(out);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve(archive.pointer()));

		// Handle errors from the write stream
		output.on('error', err => reject(err));

		// Handle errors from archiver
        archive.on('error', err => reject(err));

        archive.pipe(output);

        const sourcePath = path.resolve(source);

        try {

			if (fs.lstatSync(sourcePath).isDirectory()) {

                archive.directory(sourcePath, false);
            }
			else {

				archive.file(sourcePath, { name: path.basename(sourcePath) });
            }

            archive.finalize();
        }
		catch (err) {
 
			reject(err); // Handle errors related to sourcePath or archiving setup
        }
    });
}


async function decompress(zipPath, outDir) {

    try {

        await new Promise((resolve, reject) => {

            fs.createReadStream(zipPath)
                .pipe(unzipper.Extract({ path: outDir }))
                .on('error', reject) // Handle stream errors
                .on('finish', resolve); // Resolve when extraction is complete
        });
    }
	catch (error) {

		throw new Error('Error during decompression: ' + err.message);
    }
}


async function encryptFile(inputPath, outputPath, password) {

	try {

		// Create a SHA-256 hash of the password
        const key = crypto.createHash('sha256').update(password).digest();

        // Generate a random initialization vector (IV)
        const iv = crypto.randomBytes(16);

        // Create the cipher with the key and IV
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

        // Create read and write streams
        const input = fs.createReadStream(inputPath);
        const output = fs.createWriteStream(outputPath);

        return await new Promise((resolve, reject) => {
            // Handle errors in the cipher stream
            cipher.on('error', (error) => {

                reject({ success: false, error: 'Encryption failed: ' + error.message });
            });

            // Handle errors in the output stream
            output.on('error', (error) => {

                reject({ success: false, error: 'Write stream error: ' + error.message });
            });

            // Handle the completion of the encryption
            output.on('finish', () => {

                resolve({ success: true });
            });

            // Write the IV to the output file
            output.write(iv);

            // Pipe the input stream through the cipher and to the output stream
            input.pipe(cipher).pipe(output);
        });

    }
	catch (error) {

		// Handle unexpected errors

        return { success: false, error: 'Unexpected error: ' + error.message };
    }
}


async function decryptFile(inputPath, outputPath, password) {

    try {
        // Create a SHA-256 hash of the password
        const key = crypto.createHash('sha256').update(password).digest();

        // Allocate buffer for the initialization vector (IV) and read it from the file
        const iv = Buffer.alloc(16);
        const ivFile = await fs.promises.open(inputPath, 'r');
        await ivFile.read(iv, 0, 16, 0);
        await ivFile.close();

        // Create the decipher with the key and IV
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

        // Create a read stream starting after the IV, and a write stream for the output
        const input = fs.createReadStream(inputPath, { start: 16 });
        const output = fs.createWriteStream(outputPath);

        return await new Promise((resolve, reject) => {
            // Handle errors in the decipher stream
            decipher.on('error', (error) => {

				reject({ success: false, error: 'Decryption failed: ' + error.message });
            });

            // Handle errors in the output stream
            output.on('error', (error) => {

                reject({ success: false, error: 'Write stream error: ' + error.message });
            });

            // Resolve the promise when decryption is successful
            output.on('finish', () => {

                resolve({ success: true });
            });

            // Pipe the input stream through the decipher and to the output stream
            input.pipe(decipher).pipe(output);
        });

    }
	catch (error) {

		// Handle unexpected errors

        return { success: false, error: 'Unexpected error: ' + error.message };
    }
}


function removeDirectorySync(directoryPath) {

    function deleteRecursiveSync(dir) {

        if (fs.existsSync(dir)) {

            const files = fs.readdirSync(dir);

            for (const file of files) {

				const filePath = path.join(dir, file);

				if (fs.statSync(filePath).isDirectory()) {

					deleteRecursiveSync(filePath);
                }
				else {

					fs.unlinkSync(filePath);
                }
            }

            fs.rmdirSync(dir);
        }
    }

    try {

		deleteRecursiveSync(directoryPath);
    }
	catch (error) {
 
		//console.error(`Error removing ${directoryPath}:`, error);
    }
}


async function appStarting(req, res) {

	if (shareData.appData.starting_dca) {

		const msg = 'DCA bots start in progress. Please wait until it finishes.';

		shareData.Common.logger(msg);

		res.status(500).send(msg);

		return true;
	}

	return false;
}


async function pause(bool, msg) {

	if (msg == undefined || msg == null || msg == '') {

		msg = 'Paused';
	}

	if (bool) {

		shareData.appData.system_pause = msg;
	}
	else {

		delete shareData.appData.system_pause;
	}
}


async function routeUpdateSystem(req, res) {

	const dataUpdate = await updateSystem();

	if (dataUpdate.success) {

		res.status(200).send('System update complete.');
	}
	else {

		res.status(500).send('An error occurred during update: ' + dataUpdate.error);
	}
}


async function updateSystem() {

	let success = false;
	let systemMsg = 'System Updating';

	const outputDir = pathRoot + '/downloads';
	const extractDir = outputDir + '/' + shareData.Common.uuidv4();

	const appVersion = shareData.appData.version;
	const appConfigFile = shareData.appData.app_config;
	const botConfigFile = shareData.appData.bot_config;

	let isErr;
	let cmdError = '';
	let cmdStdError = '';
	let cmdStdOut = '';
	let extractDirName = '';

	const getFirstDir = rootPath => fs.readdirSync(rootPath).find(f => fs.statSync(path.join(rootPath, f)).isDirectory()) || null;

	const mergeConfigs = (param, data, configs) => {

		const instanceConfigs = new Set(data.instances.map(instance => instance[param]));

		configs.forEach(config => instanceConfigs.add(config));

		return Array.from(instanceConfigs);
	};

	// If Hub is running, send system pause to all instances
	const resParent = await shareData.Common.sendParentMsg({

		'type': 'system_pause_all',
		'data': { 'pause': true, 'message': systemMsg }
	});

	if (!resParent.success) {

		await pause(true, systemMsg);
	}

	shareData.Common.logger(systemMsg);

	try {

		let appConfigs = [];
		let botConfigs = [];

		appConfigs.push(appConfigFile);
		botConfigs.push(botConfigFile);

		const appInfo = await shareData.Common.validateAppVersion();

		const owner = appInfo.owner;
		const repo = appInfo.repo;
		const latestTag = appInfo.remote;

		if (!appInfo.success || !appInfo.update_available) {

			throw new Error('You already have the latest version');
		}

		// Wait short delay for data to stop processing
		await shareData.Common.delay(5000);

		// Download latest tag zip file
		const downloadUrl = `https://github.com/${owner}/${repo}/archive/refs/tags/${latestTag}.zip`;
		const zipResponse = await fetch(downloadUrl);

		if (!zipResponse.ok) throw new Error(`Failed to download zip: ${zipResponse.statusText}`);

		// Create output directory if it doesn't exist
		if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

		const filename = `${repo}-${latestTag}.zip`;
		const outFile = outputDir + '/' + filename;

		// Write the zip file to disk
		const fileStream = fs.createWriteStream(outFile);

		await new Promise((resolve, reject) => {
			zipResponse.body.pipe(fileStream);
			zipResponse.body.on('error', reject);
			fileStream.on('finish', resolve);
		});

		await decompress(outFile, extractDir);

		try {

			extractDirName = getFirstDir(extractDir);
		}
		catch(e) {

			throw new Error(e.message);
		}

		let appConfigNew = await shareData.Common.getData(extractDir + '/' + extractDirName + '/config/app.json');
		let botConfigNew = await shareData.Common.getData(extractDir + '/' + extractDirName + '/config/bot.json');

		let hubConfig = await shareData.Common.getData(pathRoot + '/config/hub.json');

		if (hubConfig.success) {

			appConfigs = mergeConfigs('app_config', JSON.parse(hubConfig.data), appConfigs);
			botConfigs = mergeConfigs('bot_config', JSON.parse(hubConfig.data), botConfigs);
		}

		// Combine configs
		const allConfigs = [
			...appConfigs.map(file => ({ file, updated: true, newData: appConfigNew.data })),
			...botConfigs.map(file => ({ file, updated: false, newData: botConfigNew.data }))
		];

		// Update all config files
		for (let { file, updated, newData } of allConfigs) {

			let configOld = await shareData.Common.getData(pathRoot + '/config/' + file);

			let diffs = await findMissingParameters(JSON.parse(configOld.data), JSON.parse(newData));
			let configCombined = diffs.combined;

			// Save new config
			await shareData.Common.saveConfig(file, configCombined, updated);
		}

		// Remove existing files except config folder and replace with new 
		await moveFiles(pathRoot, extractDir + '/' + extractDirName);

		// Cleanup files
		fs.unlinkSync(outFile);
		removeDirectorySync(extractDir);

		// Execute "npm install" in the original directory
		await new Promise((resolve, reject) => {

			exec('npm install', {
				'cwd': pathRoot
			}, (error, stdout, stderr) => {

				if (error) {

					cmdError = error.message;
					reject(error);

					return;
				}

				if (stderr && !stderr.includes('warning')) {

					cmdStdError = stderr;
					reject(new Error(stderr));

					return;
				}
		
				cmdStdOut += stdout;

				resolve();
			});
		});

		if (!cmdError && !cmdStdError) {

			success = true;
		}
	}
	catch (error) {

		isErr = error.message;
	}

	const resObj = {
		'success': success,
		'error': isErr,
		'cmd': {
			'stdout': cmdStdOut,
			'stderr': cmdStdError,
			'error': cmdError
		}
	};

	shareData.Common.logger('System Update Complete: ' + JSON.stringify(resObj));

	if (success) {

		// If Hub is running, shutdown all instances
		const resParent = await shareData.Common.sendParentMsg({

			'type': 'shutdown_hub',
			'data': ''
		});

		if (!resParent.success) {

			shutDownFunction();
		}
	}
	else {

		// If Hub is running, send system unpause to all instances
		const resParent = await shareData.Common.sendParentMsg({

			'type': 'system_pause_all',
			'data': { 'pause': false, 'message': '' }
		});

		if (!resParent.success) {

			await pause(false, '');
		}
	}

	return resObj;
}


async function moveFiles(originalDir, newDir) {

	try {

		const items = await fsp.readdir(newDir);

		for (const item of items) {

			// Skip "config" directory
			if (item === 'config') {

				continue;
			}

			const newItemPath = path.join(newDir, item);
			const originalItemPath = path.join(originalDir, item);

			const stats = await fsp.stat(newItemPath);

			if (stats.isFile()) {

				// File
				await fsp.unlink(originalItemPath).catch(() => {});
				await fsp.rename(newItemPath, originalItemPath);
			}
			else if (stats.isDirectory()) {

				// Directory
				removeDirectorySync(originalItemPath);
				await fsp.rename(newItemPath, originalItemPath);
			}
		}
	}
	catch (e) {

		throw new Error(e.message);
	}
}


async function findMissingParameters(obj1, obj2, path = '') {

	const missing = {};
	const combined = Array.isArray(obj1) ? [...obj1] : {
		...obj1
	};

	// Check for missing properties in obj2
	for (const key in obj2) {

		const fullPath = path ? `${path}.${key}` : key;

		if (!(key in obj1)) {

			missing[fullPath] = 'Missing in obj1'; // Key exists in obj2 but not in obj1
			combined[key] = obj2[key]; // Include the missing key from obj2 in the combined object
		}
		else if (typeof obj2[key] === 'object' && obj2[key] !== null) {

			if (Array.isArray(obj2[key])) {

				// If it's an array, we need to ensure it's merged appropriately
				if (!Array.isArray(obj1[key])) {

					combined[key] = obj2[key];
				}
				else {

					// Merge arrays without overwriting
					combined[key] = [...new Set([...obj1[key], ...obj2[key]])];
				}
			}
			else {

				// Recursive check for nested objects
				const nestedResult = await findMissingParameters(obj1[key], obj2[key], fullPath);

				Object.assign(missing, nestedResult.missing); // Merge missing keys

				combined[key] = nestedResult.combined; // Combine objects
			}
		}
	}

	// Check for missing properties in obj1
	for (const key in obj1) {

		const fullPath = path ? `${path}.${key}` : key;

		if (!(key in obj2)) {

			missing[fullPath] = 'Missing in obj2'; // Key exists in obj1 but not in obj2
		}
	}

	return {
		missing,
		combined
	};
}


async function resetConsole(serverIdError, resetServerId) {

	// Reset database from command line

	let success = false;

	let isErr;
	let confirm;
	let resetCode = Math.floor(Math.random() * 1000000000);

	let warnMsg = '\n*** CAUTION *** You are about to reset ' + shareData.appData.name + ' ';

	if (resetServerId) {

		warnMsg += 'server ID!'
	}
	else {

		warnMsg += 'database!';
	}

	warnMsg += '\n\n';
	warnMsg += 'Database to reset: ' + shareData.appData['mongo_db_url'] + '\n';

	console.log(warnMsg);

	if (serverIdError) {

		console.log('\n*** WARNING *** Your server ID does not match! Confirm you are connected to the correct database!\n');
	}

	confirm = prompt('Do you want to continue? (Y/n): ');

	if (confirm == 'Y') {

		console.log('\nReset code: ' + resetCode);

		confirm = prompt('Enter the reset code above to reset ' + shareData.appData.name + ': ');

		if (confirm == resetCode) {

			confirm = prompt('Final warning before reset. Do you want to continue? (Y/n): ');

			if (confirm == 'Y') {

				success = true;

				if (resetServerId) {

					const resetData = await resetDatabase(false, true);

					if (!resetData['success']) {

						success = false;
						isErr = resetData['error'];
					}

					console.log('Server reset: ' + resetData['collectionServer']);
				}
				else {

					const resetData = await resetDatabase(true, false);

					if (!resetData['success']) {

						success = false;
						isErr = resetData['error'];
					}

					console.log('Bots reset: ' + resetData['collectionBots']);
					console.log('Deals reset: ' + resetData['collectionDeals']);
				}

				if (!success) {

					console.log('Error occurred: ', isErr);
				}

				console.log('\nReset finished.');
			}
		}
		else {

			console.log('\nReset code incorrect.');
		}
	}

	if (!success) {

		console.log('\nReset aborted.');
	}

	process.exit(1);
}


async function start(url) {

	dbUrl = url;
}


module.exports = {

	start,
	pause,
	resetConsole,
	resetDatabase,
	updateSystem,
	connectDb,
	backupDb,
	restoreDb,
	routeBackupDb,
	routeRestoreDb,
	routeUpdateSystem,
	get shutDown() {
        return shutDownFunction;
    },

	init: function(obj, shutDown) {

		shareData = obj;
		shutDownFunction = shutDown;
	},
};