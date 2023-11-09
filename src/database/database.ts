import { MongoClient, Db, Collection } from 'mongodb';
import config from '../config';
import { PublicChat, UnapprovedReport, UserData } from './types';
import { sleep } from '../utils';
import TelegramBot from 'node-telegram-bot-api';

const client: MongoClient = new MongoClient(config.mongo.url);
const db: Db = client.db(config.mongo.dbName);

export const chatsCollection: Collection<PublicChat> = db.collection('chats');
export const usersCollection: Collection<UserData> = db.collection('users');

// only used for unapproved reports
export const reportsCollection: Collection<UnapprovedReport> = db.collection('reports');

let ready = false;

(async () => {
	try {
		await client.connect();
		ready = true;
	} catch (e) {
		console.error(e);

		await sleep(2000);
		process.exit();
	}

	try {
		await db.createCollection(chatsCollection.collectionName);
	} catch {}

	try {
		await db.createCollection(usersCollection.collectionName);
	} catch {}

	try {
		await db.createCollection(reportsCollection.collectionName);
	} catch {}

	try {
		if (!(await usersCollection.indexExists('id'))) {
			await usersCollection.createIndex({ id: 1 }, { unique: true });
		}
	} catch {}

	try {
		if (!(await usersCollection.indexExists('hash'))) {
			await usersCollection.createIndex({ hash: 1 }, {});
		}
	} catch {}

	try {
		if (!(await usersCollection.indexExists('dwc'))) {
			await usersCollection.createIndex({ dwc: 1 });
		}
	} catch {}

	try {
		if (!(await usersCollection.indexExists('username'))) {
			// not unique just in case someone changes their username
			await usersCollection.createIndex({ username: 1 });
		}
	} catch {}

	try {
		if (!(await chatsCollection.indexExists('id'))) {
			await chatsCollection.createIndex({ id: 1 }, { unique: true });
		}
	} catch {}

	try {
		if (!(await reportsCollection.indexExists('id'))) {
			await reportsCollection.createIndex({ id: 1 }, { unique: true });
		}
	} catch {}

	console.log('Database is ready');
})();

const userBannedCache: { [key: string]: { banned: string | undefined; time: number } } = {};

async function isUserBanned(id: string | number | TelegramBot.User): Promise<string | undefined> {
	if (typeof id != 'string' && typeof id != 'number') {
		id = id.id;
	}

	const elm = userBannedCache[id.toString()];

	// cache each result for 2 minutes to deal with spamming
	if (elm && Date.now() - elm.time < 1000 * 60 * 2) {
		return elm.banned;
	}

	const status = (await usersCollection.findOne({ id: id.toString() }))?.banned || undefined;
	userBannedCache[id.toString()] = {
		banned: status,
		time: Date.now(),
	};

	return status;
}

const dwcCache: { [key: string]: { dwc: boolean; time: number } } = {};

async function isUserDWC(user: number | TelegramBot.User): Promise<boolean> {
	if (typeof user != 'number') {
		user = user.id;
	}

	const elm = dwcCache[user.toString()];
	if (elm && Date.now() - elm.time < 1000 * 20) {
		return elm.dwc;
	}

	const data = await usersCollection.findOne({
		id: user.toString(),
	});

	const status = data?.dwc || false;
	dwcCache[user.toString()] = {
		dwc: status,
		time: Date.now(),
	};

	return status;
}

async function isUserAppealing(user: number | string | TelegramBot.User): Promise<boolean> {
	if (typeof user == 'string') {
		user = parseInt(user);
	} else if (typeof user != 'number') {
		user = user.id;
	}

	const data = await usersCollection.findOne({
		id: user.toString(),
	});

	return data?.appealing || false;
}

async function canUserAppeal(user: number | string | TelegramBot.User): Promise<boolean> {
	if (typeof user == 'string') {
		user = parseInt(user);
	} else if (typeof user != 'number') {
		user = user.id;
	}

	const data = await usersCollection.findOne({
		id: user.toString(),
	});

	if (!data) {
		return false;
	}

	return !data.appealing && data.dwc === true && Date.now() - (data.lastAppeal || 0) > config.cooldowns.appeals * 60000;
}

async function setUserAppealing(user: number | string, state: boolean) {
	if (typeof user == 'string') {
		user = parseInt(user);
	}

	await usersCollection.updateOne(
		{
			id: user.toString(),
		},
		{
			$set: state
				? {
						appealing: true,
						lastAppeal: Date.now(),
				  }
				: {},
			$unset: !state
				? {
						appealing: '',
				  }
				: {},
		}
	);
}

async function setChatPrivate(chatId: string | number, state: boolean) {
	await chatsCollection.updateOne({ id: chatId.toString() }, { $set: state ? { priv: true } : {}, $unset: !state ? { priv: '' } : {} });
}

export default {
	isReady: () => ready,
	isUserBanned,
	isUserDWC,
	isUserAppealing,
	setUserAppealing,
	canUserAppeal,
	setChatPrivate,
};
