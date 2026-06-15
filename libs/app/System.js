'use strict';

const os = require('os');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const bson = require('bson');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { ZipArchive: ArchiverZip } = require('archiver');
const unzipper = require('unzipper');
const fetch = require('node-fetch-commonjs');
const sftpClient = require('ssh2-sftp-client');
const { exec, spawn } = require('child_process');

const prompt = require('prompt-sync')({
	sigint: true
});

const pathRoot = path.resolve(__dirname, ...Array(2).fill('..'));

let shareData;
let shutDownFunction;
let dbUrl;

const activeCrons = {};

const tempDir = pathRoot + '/temp';
const backupDir = pathRoot + '/backups';
const rollbackDir = pathRoot + '/rollbacks';
const MAX_ROLLBACKS = 3;


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


const resetDatabase = async (resetDb, resetServerId, resetAiChats = false) => {

	let success = true;

	let isErr;
	let collectionBots;
	let collectionDeals;
	let collectionSessions;
	let collectionServer;
	let collectionAiChats;

	try {

		const dbConnection = await connectDb();
		const db = dbConnection.db;

		if (resetDb) {

			collectionBots = await db.dropCollection('bots');
			collectionDeals = await db.dropCollection('deals');
			collectionSessions = await db.dropCollection('sessions');
		}

		if (resetAiChats) {

			try { collectionAiChats = await db.dropCollection('ai_conversations'); } catch(e) {}
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
						'collectionServer': collectionServer,
						'collectionSessions': collectionSessions,
						'collectionAiChats': collectionAiChats
					};

	return resObj;
};


const resetSessions = async () => {

	let success = true;
	let isErr;
	let collectionSessions;

	const collection = 'sessions';

	try {

		const dbConnection = await connectDb();
		const db = dbConnection.db;

		const collections = await db.listCollections({
			'name': collection
		}).toArray();

		if (collections.length > 0) {

			collectionSessions = await db.collection(collection).drop();
		}

		await dbConnection.close();
	}
	catch (e) {

		success = false;
		isErr = e;
	}

	const resObj = {
		'success': success,
		'error': isErr,
		'collectionSessions': collectionSessions
	};

	return resObj;
};


const backupAllCollections = async (dbConnection, dir, includeChats = true) => {

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

			if (collectionName === 'ai_conversations' && !includeChats) {
				shareData.Common.logger('Skipping ai_conversations backup (include_chats is false).');
				continue;
			}
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


const backupDb = async (includeChats) => {

	// Default to app.json config for cron backups; manual backups pass explicit value
	if (includeChats === undefined) {
		includeChats = !(shareData.appData.cron_backup && shareData.appData.cron_backup.include_chats === false);
	}

	let res;

	const dir = tempDir + '/' + shareData.Common.uuidv4();

	shareData.Common.logger('Database backup started');

	const dbConnection = await connectDb();

	try {

		res = await backupAllCollections(dbConnection, dir, includeChats);
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

	const body = req.body;

	let password = body.password;
	let includeChats = shareData.Common.convertBoolean(body.include_chats, true);

	const resBackup = await processBackupDb(password, includeChats);

	const msg = resBackup.msg;
	const outFileEnc = resBackup.full_path;
	const fileNameEnc = resBackup.file_name;

	if (resBackup.success) {

		res.download(outFileEnc, fileNameEnc, (err) => {

			if (err) {

				//console.error('Error sending file:', err);

				res.status(500).send('Error sending file');
			}
		});
	}
	else {

		res.status(500).send(msg);
	}
}


async function routeRestoreDb(req, res) {

	if (await appStarting(req, res)) {

		return;
	}

	const tempPath = req.file.path;
	const targetPath = tempDir + '/' + req.file.originalname;

	const body = req.body;

	let password = body.password;
	let convertData = shareData.Common.convertBoolean(body.convertData, false);
	let resetServerId = shareData.Common.convertBoolean(body.resetServerId, false);
	let resetAiChats  = shareData.Common.convertBoolean(body.resetAiChats, false);

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
		await processRestoreDb(tempPath, targetPath, password, convertData, resetServerId, resetAiChats);

		// Send a success response
		res.status(200).send('File uploaded and database restored successfully.');
	}
	catch (err) {

		//console.error('File processing error:', err);

		res.status(500).send('An error occurred during the file processing: ' + err.message);
	}
}


async function processBackupDb(password, includeChats = true) {

	let msg;
	let outFileEnc;
	let fileNameEnc;

	const dateParts = shareData.Common.getDateParts(new Date());

	let dateNow = dateParts.date
	let timeNow = dateParts.time;

	dateNow = dateNow.replace(/[^a-zA-Z0-9]/g, '');
	timeNow = timeNow.replace(/[^a-zA-Z0-9]/g, '');

	const fileName = shareData.appData.name + '-backup-' + dateNow + '_' + timeNow + '.zip';

	const outFile = tempDir + '/' + fileName;

	await pause(true, 'Database Backup Processing');

	// Wait short delay for data to stop processing
	await shareData.Common.delay(5000);

	const resBackup = await backupDb(includeChats);

	let success = resBackup['success'];
	const dir = resBackup['dir'];

	if (success) {

		const manifestFile = dir + '/.manifest.json';

		// Create manifest
		await logManifest(shareData.appData.version, dir, manifestFile);

		shareData.Common.logger('Compressing: ' + fileName);

		await compress(dir, outFile);

		removeDirectorySync(dir);

		outFileEnc = outFile + '.enc';
		fileNameEnc = fileName + '.enc';

		shareData.Common.logger('Encrypting: ' + fileName);

		const encryptObj = await encryptFile(outFile, outFileEnc, password);

		// Delete unencrypted file
		fs.unlinkSync(outFile);

		if (!encryptObj.success) {

			success = false;

			msg = 'Encryption failed: ' + encryptObj.error;

			shareData.Common.logger(msg);
		}
	}

	await pause(false);

	return { 'success': success, 'msg': msg, 'full_path': outFileEnc, 'file_name': fileNameEnc };
}


async function processRestoreDb(tempPath, targetPath, password, convertData, resetServerId, resetAiChats = false) {

	await pause(true, 'Database Restore Processing');
	await shareData.Common.delay(5000);

	const dir = tempDir + '/' + shareData.Common.uuidv4();

	let targetPathDec;
	let success = true;
	let caughtError = null;

	try {

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

		await decompress(targetPathDec, dir);

		let res = await restoreDb(dir);

		if (!res.success) {

			throw new Error(res.error);
		}
	}
	catch (err) {

		success = false;

		caughtError = new Error('An error occurred during restore: ' + err.message);
	}
	finally {

		removeDirectorySync(dir);

		fs.unlinkSync(targetPath);
		fs.unlinkSync(targetPathDec);

		if (success) {

			if (convertData) {

				await shareData.DCABot.convertDataToSandBox();
			}

			if (resetAiChats) {

				await resetDatabase(false, false, true);
			}

			if (resetServerId) {

				await resetDatabase(false, true);
			}

			shutDownFunction();
		}
		else {

			await pause(false);
		}
	}

	if (caughtError) throw caughtError;
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
        const archive = new ArchiverZip({ zlib: { level: 9 } });

        output.on('close', () => resolve(archive.pointer()));

		// Handle errors from the write stream
		output.on('error', err => reject(err));

		// Handle errors from archiver
        archive.on('error', err => reject(err));

        archive.pipe(output);

        const sourcePath = path.resolve(source);

        try {

			if (fs.lstatSync(sourcePath).isDirectory()) {

				archive.directory(sourcePath, false, { dot: true });
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

		const directory = await unzipper.Open.file(zipPath);

		for (const entry of directory.files) {

			try {

				const fullPath = path.join(outDir, entry.path);

				if (entry.type === 'Directory') {

					await fsp.mkdir(fullPath, {
						recursive: true
					});
				}
				else {

					await fsp.mkdir(path.dirname(fullPath), {
						recursive: true
					});

					await new Promise((resolve, reject) => {

						entry.stream()
							.pipe(fs.createWriteStream(fullPath))
							.on('finish', resolve)
							.on('error', reject);
					});
				}
			}
			catch (entryErr) {

				//console.error(`Error extracting entry "${entry.path}":`, entryErr);
			}
		}

	}
	catch (err) {

		//console.error(`Failed to decompress "${zipPath}" to "${outDir}":`, err);
		throw err;
	}
}


async function encrypt(data, password) {

	let success = false, encryptedData = null, error = null;

	try {
	
		const key = crypto.createHash('sha256').update(password).digest();
		const iv = crypto.randomBytes(16);
		const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

		const serialized = Buffer.from(JSON.stringify({ data }));
		const encrypted = Buffer.concat([cipher.update(serialized), cipher.final()]);

		encryptedData = iv.toString('hex') + ':' + encrypted.toString('base64');

		success = true;
	}
	catch (err) {

		error = 'Unexpected error: ' + err.message;
	}

	return { success, data: encryptedData, error };
}


async function decrypt(data, password) {

	let success = false, decryptedData = null, error = null;

	try {

		const key = crypto.createHash('sha256').update(password).digest();
		const [ivHex, encryptedBase64] = data.split(':');

		if (!ivHex || !encryptedBase64) throw new Error('Invalid encrypted format');

		const iv = Buffer.from(ivHex, 'hex');
		const encryptedBuffer = Buffer.from(encryptedBase64, 'base64');

		const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
		const decryptedBuffer = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);

		const {	data: originalData } = JSON.parse(decryptedBuffer.toString());

		decryptedData = originalData;

		success = true;
	}
	catch (err) {

		error = 'Unexpected error: ' + err.message;
	}

	return { success, data: decryptedData, error };
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

		try {

			res.status(500).send(msg);
		}
		catch(e) {

		}

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


async function createRollbackSnapshot(version) {

	let success = false;
	let snapshotNameResult = null;
	let error = null;

	const dateParts = shareData.Common.getDateParts(new Date());
	const dateStr = dateParts.date.replace(/[^a-zA-Z0-9]/g, '') + '_' + dateParts.time.replace(/[^a-zA-Z0-9]/g, '');
	const snapshotName = `${version}_${dateStr}`;
	const snapshotDir = rollbackDir + '/' + snapshotName;

	if (!fs.existsSync(rollbackDir)) fs.mkdirSync(rollbackDir, { recursive: true });

	const exclude = new Set(['backups', 'config', 'node_modules', 'rollbacks', 'temp', 'downloads', 'sessions', 'logs']);

	try {

		const items = fs.readdirSync(pathRoot);

		for (const item of items) {

			if (exclude.has(item)) continue;

			const src = path.join(pathRoot, item);
			const dest = path.join(snapshotDir, item);
			const stats = fs.statSync(src);

			if (stats.isDirectory()) {

				await fsp.cp(src, dest, { recursive: true });
			}
			else {

				await fsp.mkdir(path.dirname(dest), { recursive: true });
				await fsp.copyFile(src, dest);
			}
		}

		// Write manifest
		const manifest = { version, date: new Date().toISOString(), snapshotName };
		await fsp.writeFile(snapshotDir + '/.rollback-manifest.json', JSON.stringify(manifest, null, 2));

		shareData.Common.logger(`Rollback snapshot created: ${snapshotName}`);

		// Trim old rollbacks — keep only MAX_ROLLBACKS
		const snapshots = fs.readdirSync(rollbackDir)
			.filter(f => fs.statSync(path.join(rollbackDir, f)).isDirectory())
			.map(f => ({ name: f, mtime: fs.statSync(path.join(rollbackDir, f)).mtime }))
			.sort((a, b) => a.mtime - b.mtime);

		while (snapshots.length > MAX_ROLLBACKS) {

			const oldest = snapshots.shift();
			removeDirectorySync(path.join(rollbackDir, oldest.name));
			shareData.Common.logger(`Removed old rollback snapshot: ${oldest.name}`);
		}

		success = true;
		snapshotNameResult = snapshotName;
	}
	catch (err) {

		shareData.Common.logger('Failed to create rollback snapshot: ' + err.message);
		error = err.message;
	}

	return { success, snapshotName: snapshotNameResult, error };
}


async function listRollbacks() {

	if (!fs.existsSync(rollbackDir)) return [];

	const snapshots = fs.readdirSync(rollbackDir)
		.filter(f => fs.statSync(path.join(rollbackDir, f)).isDirectory())
		.map(f => {

			let manifest = { version: 'unknown', date: null, snapshotName: f };

			try {

				const raw = fs.readFileSync(path.join(rollbackDir, f, '.rollback-manifest.json'), 'utf8');
				manifest = { ...manifest, ...JSON.parse(raw) };
			}
			catch(e) {}

			return manifest;
		})
		.sort((a, b) => new Date(b.date) - new Date(a.date));

	return snapshots;
}


async function routeListRollbacks(req, res) {

	const rollbacks = await listRollbacks();

	res.json({ success: true, data: rollbacks });
}


async function routeRollbackSystem(req, res) {

	const { snapshotName } = req.body;

	if (!snapshotName) {

		return res.status(400).json({ success: false, error: 'No snapshot name provided.' });
	}

	const snapshotDir = path.join(rollbackDir, snapshotName);

	if (!fs.existsSync(snapshotDir)) {

		return res.status(404).json({ success: false, error: 'Snapshot not found.' });
	}

	let success = false;
	let error;

	try {

		shareData.Common.logger(`Rolling back to snapshot: ${snapshotName}`);

		await copyFiles(snapshotDir, pathRoot);

		// Run npm install to restore node_modules to the rolled-back state
		await new Promise((resolve, reject) => {

			exec('npm install', { cwd: pathRoot }, (err, stdout, stderr) => {

				if (err) return reject(err);
				resolve();
			});
		});

		success = true;

		shareData.Common.logger(`Rollback to ${snapshotName} complete. Shutting down.`);
	}
	catch (err) {

		error = err.message;
		shareData.Common.logger('Rollback failed: ' + error);
	}

	res.json({ success, error });

	if (success) {

		// Shutdown so process manager restarts with rolled-back code
		const resParent = await shareData.Common.sendParentMsg({
			'type': 'shutdown_hub',
			'data': ''
		});

		if (!resParent.success) {

			shutDownFunction();
		}
	}
}


async function rollbackConsole(snapshotName) {

	const rollbackPath = pathRoot + '/rollbacks';
	let selected = null;
	let exitCode = 0;
	let message = '';

	if (!fs.existsSync(rollbackPath)) {

		message = '\nNo rollback snapshots found in: ' + rollbackPath + '\nSnapshots are created automatically before each update.';
		exitCode = 1;
	}
	else {

		const snapshots = fs.readdirSync(rollbackPath)
			.filter(f => fs.statSync(path.join(rollbackPath, f)).isDirectory())
			.map(f => {

				let manifest = { version: 'unknown', date: null, snapshotName: f };

				try {

					const raw = fs.readFileSync(path.join(rollbackPath, f, '.rollback-manifest.json'), 'utf8');
					manifest = { ...manifest, ...JSON.parse(raw) };
				}
				catch(e) {}

				return manifest;
			})
			.sort((a, b) => new Date(b.date) - new Date(a.date));

		if (snapshots.length === 0) {

			message = '\nNo rollback snapshots available.';
			exitCode = 1;
		}
		else if (snapshotName) {

			selected = snapshots.find(s => s.snapshotName === snapshotName);

			if (!selected) {

				message = '\nSnapshot not found: ' + snapshotName + '\n\nAvailable snapshots:\n' +
					snapshots.map(s => '  ' + s.snapshotName).join('\n');
				exitCode = 1;
			}
		}
		else if (snapshots.length === 1) {

			selected = snapshots[0];
		}
		else {

			console.log('\nAvailable rollback snapshots:\n');

			snapshots.forEach((s, i) => {

				const date = s.date ? new Date(s.date).toLocaleString() : 'Unknown date';
				console.log('  [' + (i + 1) + '] v' + s.version + ' — ' + date + ' (' + s.snapshotName + ')');
			});

			console.log('');

			const input = prompt('Select snapshot [1-' + snapshots.length + ']: ');
			const idx   = parseInt(input, 10) - 1;

			if (isNaN(idx) || idx < 0 || idx >= snapshots.length) {

				message = 'Invalid selection. Exiting.';
				exitCode = 1;
			}
			else {

				selected = snapshots[idx];
			}
		}

		if (selected && exitCode === 0) {

			const date = selected.date ? new Date(selected.date).toLocaleString() : 'Unknown date';

			console.log('\nSelected: v' + selected.version + ' — ' + date);
			console.log('\n*** CAUTION *** This will restore code files from the snapshot.');
			console.log('The database will NOT be affected.\n');

			const confirm = prompt('Do you want to continue? (Y/n): ');

			if (confirm !== 'Y') {

				message = 'Rollback cancelled.';
			}
			else {

				const snapshotDir = path.join(rollbackPath, selected.snapshotName);

				try {

					console.log('\nRestoring files from: ' + selected.snapshotName);

					await copyFiles(snapshotDir, pathRoot);

					console.log('Files restored.');
					console.log('\nRunning npm install...');

					await new Promise((resolve, reject) => {

						exec('npm install', { cwd: pathRoot }, (err) => {

							if (err) return reject(err);
							resolve();
						});
					});

					message = 'npm install complete.\n\nRollback complete. Start SymBot normally with: npm start';
				}
				catch (err) {

					message = '\nRollback failed: ' + err.message;
					exitCode = 1;
				}
			}
		}
	}

	if (message) console.log(message);

	if (exitCode !== 0) process.exit(exitCode);
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
		let hubConfigNew = await shareData.Common.getData(extractDir + '/' + extractDirName + '/config/hub.json');

		let hubConfigOld = await shareData.Common.getData(pathRoot + '/config/hub.json');

		// Check for new hub.json params
		if (hubConfigOld.success && hubConfigNew.success) {

			let diffs = await findMissingParameters(JSON.parse(hubConfigOld.data), JSON.parse(hubConfigNew.data));
			let configCombined = diffs.combined;

			// Save new hub config
			await shareData.Common.saveConfig('hub.json', configCombined, true);
		}

		// Reload hub config
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

		// Create rollback snapshot before overwriting files
		const snapshotResult = await createRollbackSnapshot(appVersion);

		if (!snapshotResult.success) {

			shareData.Common.logger('Warning: Could not create rollback snapshot: ' + snapshotResult.error);
		}

		// Remove existing files except backups and config folders and replace with new 
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


async function copyFiles(sourceDir, destDir) {

	try {

		const items = await fsp.readdir(sourceDir);

		for (const item of items) {

			// Preserve live data
			if (item === 'backups' || item === 'config' || item === 'rollbacks') {

				continue;
			}

			// Skip the manifest file
			if (item === '.rollback-manifest.json') {

				continue;
			}

			const src   = path.join(sourceDir, item);
			const dest  = path.join(destDir, item);
			const stats = await fsp.stat(src);

			if (stats.isDirectory()) {

				// Copy directory atomically via temp path
				const tmp = dest + '.new';

				if (fs.existsSync(tmp)) {

					removeDirectorySync(tmp);
				}

				await fsp.cp(src, tmp, { recursive: true });
				removeDirectorySync(dest);
				await fsp.rename(tmp, dest);
			}
			else {

				// Copy file safely
				const tmp = dest + '.new';

				await fsp.copyFile(src, tmp);
				await fsp.rename(tmp, dest);
			}
		}
	}
	catch (e) {

		throw new Error(`copyFiles failed: ${e.message}`);
	}
}


async function moveFiles(originalDir, newDir) {

	try {

		const items = await fsp.readdir(newDir);

		for (const item of items) {

			// Preserve live data
			if (item === 'backups' || item === 'config' || item === 'rollbacks') {

				continue;
			}

			const src = path.join(newDir, item);
			const dest = path.join(originalDir, item);
			const stats = await fsp.stat(src);

			if (stats.isDirectory()) {

				// Replace whole directory atomically
				const tmp = dest + '.new';

				if (fs.existsSync(tmp)) {

					removeDirectorySync(tmp);
				}

				await fsp.rename(src, tmp);
				removeDirectorySync(dest);
				await fsp.rename(tmp, dest);
			}
			else {

				// Replace file safely even if running
				const tmp = dest + '.new';

				await fsp.copyFile(src, tmp);
				await fsp.rename(tmp, dest);
			}
		}
	}
	catch (e) {

		throw new Error(`moveFiles failed: ${e.message}`);
	}
}


async function trimFiles(dir, name, max) {

	try {

		const files = await fsp.readdir(dir);

		// Filter files that start with the given name
		const matchingFiles = files
			.filter(file => file.startsWith(name))
			.map(file => ({ file, fullPath: path.join(dir, file) }));

		if (matchingFiles.length <= Number(max)) return;

		// Get stats and sort by modification time
		const filesWithStats = await Promise.all(

			matchingFiles.map(async ({ file, fullPath }) => ({
		 		 file,
				 fullPath,
				 mtime: (await fsp.stat(fullPath)).mtime
			}))
	  	);

		filesWithStats.sort((a, b) => a.mtime - b.mtime);
		
		const filesToDelete = filesWithStats.slice(0, filesWithStats.length - Number(max));

		for (const { fullPath } of filesToDelete) {

			await fsp.unlink(fullPath);

			//console.log(`Deleted: ${fullPath}`);
		}
	}
	catch (err) {

		//console.error('Error trimming files:', err);
	}
}


async function cronBackupStart(cronSchedule, start) {

	let resStart;
	let resStop;

	let jobName = 'cron_backup';

	if (!start) {

		resStop = await cronJobToggle(jobName, '', cronBackup, false);
	}
	else {

		// Start or restart job
		resStart = await cronJobToggle(jobName, cronSchedule, cronBackup, true);
	}

	const resData = { 'job_name': jobName, 'start_result': resStart, 'stop_result': resStop};

	shareData.Common.logger('Cron Backup Job: ' + JSON.stringify(resData));
}


async function cronBackup() {

	let error;
	let backupFile;
	let attempts = 0;
	let success = false;
	let appStillStarting = true;

	// Verify if app is starting before allowing backup
	while (attempts < 30) {

		if (await appStarting(null, null)) {

			await shareData.Common.delay(5000);

			attempts++;
		}
		else {
		
			appStillStarting = false;
		
			break;
		}
	}

	if (appStillStarting) {

		shareData.Common.logger('Unable to perform scheduled database backup. App is still starting.');

		return { 'success': success };
	}

	const cronBackupPasswordEnc = shareData['appData']['cron_backup']['password'];

	if (cronBackupPasswordEnc) {

		const cronBackupPasswordDecObj = await decrypt(cronBackupPasswordEnc, shareData.appData.password);

		if (cronBackupPasswordDecObj.success) {

			const password = cronBackupPasswordDecObj.data;

			if (password) {

				shareData.Common.logger('Performing scheduled database backup');

				const resBackup = await processBackupDb(password);

				if (resBackup.success) {

					try {

						backupFile = backupDir + '/' + resBackup.file_name;

						await fsp.rename(resBackup.full_path, backupFile);

						success = true;
					}
					catch (err) {

						error  = 'Failed to move file: ' + err;
					}
				}

				const logData = { 'backup_result': resBackup, 'error': error };

				shareData.Common.logger('Completed scheduled database backup: ' + JSON.stringify(logData));
			}
		}
	}

	let maxFiles = Number(shareData['appData']['cron_backup']['max']);

	if (maxFiles < 1) {

		maxFiles = 1;
	}

	// Remove files in backupDir matching appName beyond maxFiles
	await trimFiles(backupDir, shareData.appData.name, maxFiles);

	if (shareData.appData['cron_backup']['sftp']['enabled'] && shareData.appData['cron_backup']['sftp']['host']) {

		// Upload backup file in the background
		sftpUploadFile(backupFile, false)
			.then(() => {

				shareData.Common.logger('SFTP upload success: ' + backupFile);
			})
			.catch(err => {

				shareData.Common.logger('SFTP upload failed: ' + JSON.stringify(err));
			});
	}

	return { 'success': success, 'error': error };
}


async function cronJobToggle(name, schedule, task, shouldStart) {

	let success = false;
	let error = null;
	let message;

	try {

		if (shouldStart) {

			// If already running, stop it first
			if (activeCrons[name]) {

				try  {

					activeCrons[name].stop();
					activeCrons[name].destroy();

					// console.log(`Stopped existing job: ${name}`);
				}
				catch(e) {

				}
			}

			// Try scheduling the new job
			const job = cron.schedule(schedule, task, { timezone: 'UTC' });

			if (job) {

				activeCrons[name] = job;
				message = `Started job '${name}' with schedule '${schedule}'`;

				success = true;
			}
			else {

				error = new Error(`Failed to schedule job: '${name}'`);
			}
		}
		else {

			if (activeCrons[name]) {

				try {

					activeCrons[name].stop();
					activeCrons[name].destroy();

					message = `Stopped job '${name}'`;
					delete activeCrons[name];
				}
				catch(e) {

				}

				success = true;
			}
			else {

				message = `Job '${name}' is not running.`;
			}
		}
	}
	catch (err) {

		shareData.Common.logger(`Error with cron job '${name}': ` + err);

		error = err;
	}

	return { success, error, message };
}


async function sftpUploadBackup(configObj, localFile, remoteDir, maxBackups, isTest) {

	let success = false;
	let error = null;

	maxBackups = Number(maxBackups);

	const sftp = new sftpClient();

	try {

		let config = JSON.parse(JSON.stringify(configObj));

		// privateKey is already decrypted content passed in via config.privateKey.
		// Remove it from the config object if empty so ssh2-sftp-client
		// falls back to password auth cleanly.
		if (!config.privateKey) {

			delete config.privateKey;
		}

		await sftp.connect(config);

		try {

			await sftp.stat(remoteDir);
		}
		catch {

			await sftp.mkdir(remoteDir, true);
		}

		const fileName = path.basename(localFile);
		const remotePath = `${remoteDir}/${fileName}`;

		//console.log(`Uploading backup: ${remotePath}`);

		await sftp.fastPut(localFile, remotePath);

		//console.log("Upload OK");

		// Rotate AFTER successful upload so we never delete old backups
		// without first confirming the new one was uploaded successfully.
		if (!isTest && maxBackups && maxBackups > 0) {

			await sftpRotateBackups(sftp, remoteDir, shareData.appData.name, maxBackups);
		}

		if (isTest) {

			try {

				await sftp.delete(remotePath);
			}
			catch(e) {}
		}

		success = true;
	}
	catch (err) {

		success = false;
		error = err.message;

		//console.error("SFTP Error:", error);
	}
	finally {

		await sftp.end();
	}

	const resObj = { success, error };

	shareData.Common.logger('SFTP Backup: ' + JSON.stringify(resObj));

	return resObj;
}


async function sftpRotateBackups(sftp, remoteDir, name, maxBackups) {

	try {

		const list = await sftp.list(remoteDir);

		const matchingFiles = list.filter(
			f => f.type === '-' && f.name.startsWith(name)
		);

		if (matchingFiles.length <= Number(maxBackups)) return;

		matchingFiles.sort((a, b) => a.modifyTime - b.modifyTime);

		const filesToDelete = matchingFiles.slice(0, matchingFiles.length - Number(maxBackups));

		for (const f of filesToDelete) {

			await sftp.delete(`${remoteDir}/${f.name}`);
		}
	}
	catch (e) {

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


async function resetAiChatsConsole() {

	let success = false;
	let isErr;

	console.log('\n*** CAUTION *** You are about to reset all AI chat conversations for ' + shareData.appData.name + '!\n');
	console.log('Database: ' + shareData.appData['mongo_db_url'] + '\n');

	const confirm = prompt('Do you want to continue? (Y/n): ');

	if (confirm === 'Y') {

		const resetCode = Math.floor(Math.random() * 1000000000);
		console.log('\nReset code: ' + resetCode);

		const code = prompt('Enter the reset code above to reset AI chat history: ');

		if (code == resetCode) {

			try {

				const resetData = await resetDatabase(false, false, true);

				success = resetData['success'];
				isErr   = resetData['error'];

				console.log('\nAI conversations reset: ' + resetData['collectionAiChats']);
			}
			catch(e) {

				isErr = e.message;
			}
		}
		else {

			console.log('\nReset code did not match. Aborted.');
		}
	}
	else {

		console.log('\nReset aborted.');
	}

	return { 'success': success, 'error': isErr };
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
					console.log('Sessions reset: ' + resetData['collectionSessions']);
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


async function spawnCommand(command, options = {}) {

	const {
		logFile = null,
		timeout = null,
		onData = null,
		capture = false,
		killSignal = 'SIGTERM'
	} = options;

	let p, logStream;

	if (logFile) {

		logStream = fs.createWriteStream(logFile, {
			flags: 'a'
		});
	}

	try {

		if (Array.isArray(command)) {

			const [cmd, ...args] = command;

			p = spawn(cmd, args, {
				stdio: ['ignore', 'pipe', 'pipe']
			});
		}
		else {

			const shell = os.platform() === 'win32' ? 'cmd.exe' : 'sh';
			const args = os.platform() === 'win32' ? ['/c', command] : ['-c', command];

			p = spawn(shell, args, {
				stdio: ['ignore', 'pipe', 'pipe']
			});
		}
	}
	catch (err) {
	
		if (logStream) logStream.end();

		return {
			success: false,
			code: 'SPAWN_FAILED',
			stdout: '',
			stderr: '',
			error: err.message
		};
	}

	// Only buffer output if explicitly requested
	let stdoutData = capture ? '' : null;
	let stderrData = capture ? '' : null;
	let timer = null;

	return new Promise(resolve => {

		if (timeout) {

			timer = setTimeout(() => {

				p.kill(killSignal);

				setTimeout(() => {

					if (!p.killed) p.kill('SIGKILL');

				}, 500);

				if (logStream) logStream.end();

				resolve({
					success: false,
					code: 'ETIMEDOUT',
					stdout: stdoutData,
					stderr: stderrData,
					error: `Command timed out after ${timeout}ms`
				});
			}, timeout);
		}

		const handleChunk = (chunk, type) => {

			const text = chunk.toString();

			if (capture) {

				if (type === 'stdout') stdoutData += text;
				else stderrData += text;
			}

			if (logStream) logStream.write(text);
			if (onData) onData(text, type);
		};

		p.stdout.on('data', chunk => handleChunk(chunk, 'stdout'));
		p.stderr.on('data', chunk => handleChunk(chunk, 'stderr'));

		p.on('error', err => {

			if (timer) clearTimeout(timer);
			if (logStream) logStream.end();

			resolve({
				success: false,
				code: 'SPAWN_ERROR',
				stdout: stdoutData,
				stderr: stderrData,
				error: err.message
			});
		});

		p.on('exit', code => {

			if (timer) clearTimeout(timer);
			if (logStream) logStream.end();

			resolve({
				success: code === 0,
				code,
				stdout: stdoutData,
				stderr: stderrData,
				error: code === 0 ? null : `Command failed with exit code ${code}`
			});
		});
	});
}


async function pingHost(host, count) {

	count = count ?? 4;

	const isWin = process.platform === 'win32';
	const countFlag = isWin ? '-n' : '-c';

	const result = await spawnCommand(['ping', countFlag, count, host], {
		onData: (data, type) => {
			if (type === 'stdout') process.stdout.write(`${data}`);
			if (type === 'stderr') process.stdout.write(`[stderr] ${data}`);
		},
		timeout: undefined,
		logFile: undefined,
		capture: false
	});

	return result;
}


async function sftpUploadFile(localFile, isTest) {

	let password = '';
	let passphrase = '';

	const sftpPasswordEnc = shareData['appData']['cron_backup']['sftp']['password'];
	const sftpPassphraseEnc = shareData['appData']['cron_backup']['sftp']['passphrase'];

	if (sftpPasswordEnc) {

		const sftpPasswordDecObj = await decrypt(sftpPasswordEnc, shareData.appData.password);

		if (sftpPasswordDecObj.success) {

			password = sftpPasswordDecObj.data;
		}
	}

	if (sftpPassphraseEnc) {

		const sftpPassphraseDecObj = await decrypt(sftpPassphraseEnc, shareData.appData.password);

		if (sftpPassphraseDecObj.success) {

			passphrase = sftpPassphraseDecObj.data;
		}
	}

	// Decrypt the stored private key content.
	// The value in app.json is now an encrypted blob, not a file path.
	let privateKey = '';

	const sftpPrivateKeyEnc = shareData['appData']['cron_backup']['sftp']['private_key'];

	if (sftpPrivateKeyEnc) {

		const sftpPrivateKeyDecObj = await decrypt(sftpPrivateKeyEnc, shareData.appData.password);

		if (sftpPrivateKeyDecObj.success) {

			privateKey = sftpPrivateKeyDecObj.data;
		}
	}

	const config = {
        'host': shareData.appData['cron_backup']['sftp']['host'],
        'port': shareData.appData['cron_backup']['sftp']['port'],
        'username': shareData.appData['cron_backup']['sftp']['username'],
        'password': password,
        'privateKey': privateKey,
        'passphrase': passphrase
    };

    const remoteDir = shareData.appData['cron_backup']['sftp']['remote_directory'];
    const maxBackups = shareData.appData['cron_backup']['max'];

	const res = await sftpUploadBackup(config, localFile, remoteDir, maxBackups, isTest);

	return res;
}


async function start(url) {

	dbUrl = url;

	const cronEnabled = shareData.appData['cron_backup']['enabled'];
	const cronSchedule = shareData.appData['cron_backup']['schedule'];
  
	if (cronEnabled && (cronSchedule != undefined && cronSchedule != null && cronSchedule != '')) {

		cronBackupStart(cronSchedule, true);
	}
}


module.exports = {

	start,
	pause,
	resetConsole,
	resetAiChatsConsole,
	resetDatabase,
	resetSessions,
	updateSystem,
	connectDb,
	backupDb,
	encrypt,
	decrypt,
	encryptFile,
	decryptFile,
	restoreDb,
	routeBackupDb,
	routeRestoreDb,
	routeUpdateSystem,
	rollbackConsole,
	routeListRollbacks,
	routeRollbackSystem,
	cronJobToggle,
	cronBackupStart,
	spawnCommand,
	sftpUploadFile,
	get shutDown() {
        return shutDownFunction;
    },

	init: function(obj, shutDown) {

		shareData = obj;
		shutDownFunction = shutDown;
	},
};