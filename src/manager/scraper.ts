import { AnyBulkWriteOperation } from 'mongodb';
import { client } from '..';
import database, { chatsCollection, usersCollection } from '../database/database';
import { UserData } from '../database/types';
import { getDisplayName, getUsername, sleep } from '../utils';
import config from '../config';

// syncrhonous function to scrape all chats that need scraping. used to make quick dwc bans
async function scrape() {
	while (!client.connected) {
		await sleep(1000);
	}

	const needsScrape = await chatsCollection
		.find({
			$or: [{ scrape: { $exists: false } }, { scrape: { $lt: Date.now() - config.cooldowns.memberScrape * 60000 } }],
			priv: { $ne: true },
		})
		.toArray();

	if (needsScrape.length == 0) {
		return;
	}

	console.log(`Scraping ${needsScrape.length} chat${needsScrape.length != 1 ? 's' : ''}...`);

	// key is user id value is access hash
	const pairs: { [key: number]: { hash: string; name: string; username: string | undefined } } = {};

	for (const chatId of needsScrape.map((c) => c.id)) {
		const participants: number[] = [];

		try {
			for await (const user of client.iterParticipants(parseInt(chatId))) {
				const id = user.id.toJSNumber();

				if (user.accessHash) {
					pairs[id] = {
						hash: user.accessHash.toString(),
						name: getDisplayName(user),
						username: getUsername(user),
					};
				}

				participants.push(id);
			}
		} catch (e) {
			console.error(e);
			if (e?.toString().includes('CHANNEL_PRIVATE')) {
				console.log(`Failed to scrape ${chatId}, channel is private`);
				database.setChatPrivate(chatId, true).catch(console.error);
				continue;
			}
		}

		// overwrite users list
		try {
			await chatsCollection.updateOne(
				{
					id: chatId,
				},
				{
					$set: {
						users: participants,
						scrape: Date.now(),
					},
					$unset: {
						priv: '',
					},
				}
			);
		} catch (e) {
			console.error(e);
		}

		console.log(`Scraped ${chatId} for ${participants.length} user${participants.length != 1 ? 's' : ''}`);
	}

	const ops: AnyBulkWriteOperation<UserData>[] = [];

	for (const userId in pairs) {
		const data = pairs[userId];
		if (!data) {
			continue;
		}

		const set: Partial<UserData> = {
			id: userId,
			hash: data.hash,
			name: data.name,
		};

		if (data.username) {
			set['username'] = data.username;
		}

		ops.push({
			updateOne: {
				filter: {
					id: userId,
				},
				update: {
					$set: set,
				},
				upsert: true,
			},
		});
	}

	if (ops.length > 0) {
		usersCollection.bulkWrite(ops).catch(console.error);
	}
}

let running = false;

// run initial scrape
(async () => {
	while (!database.isReady()) {
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	if (running) {
		return;
	}

	running = true;

	try {
		await scrape();
	} catch (e) {
		console.error(e);
	} finally {
		running = false;
	}
})();

setInterval(async () => {
	if (running || !database.isReady()) {
		return;
	}

	try {
		await scrape();
	} catch (e) {
		console.error(e);
	} finally {
		running = true;
	}
}, 1000 * 60 * 30);
