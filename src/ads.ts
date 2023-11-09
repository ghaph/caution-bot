import database, { chatsCollection } from './database/database';
import { bot, isChatRateLimited, sendMessage } from '.';
import { getText } from './texts';
import { sleep } from './utils';
import config from './config';

const commands = ['/noads', '/noadvertisements', '/toggleads', '/toggleadvertisements'];
bot.on('message', async (msg) => {
	if (
		isChatRateLimited(msg.chat.id, 1000) ||
		msg.chat.type == 'channel' ||
		msg.chat.type == 'private' ||
		!msg.text ||
		!msg.from ||
		!commands.includes(msg.text.toLowerCase().split(' ')[0])
	) {
		return;
	}

	const member = await bot.getChatMember(msg.chat.id, msg.from.id);
	if (!member || (member.status != 'creator' && member.status != 'administrator')) {
		return;
	}

	const chat = await chatsCollection.findOne({
		id: msg.chat.id.toString(),
	});

	if (!chat) {
		return;
	}

	const noAds = !chat.noAds;

	await chatsCollection.updateOne(
		{
			id: msg.chat.id.toString(),
		},
		{
			$set: noAds
				? {
						noAds,
				  }
				: {},
			$unset: noAds
				? {}
				: {
						noAds: '',
				  },
		}
	);

	sendMessage(msg.chat.id, noAds ? getText('ads_disabled') : getText('ads_enabled'), {
		rate_limit: 250,
		reply_to_message_id: msg.message_id,
	}).catch((e) => {
		if (e.toString().includes('the group chat was deleted') || e.toString().includes('CHANNEL_PRIVATE')) {
			database.setChatPrivate(msg.chat.id, true).catch(console.error);
		}
	});
});

async function tick() {
	const validChats = await chatsCollection
		.find({
			noAds: { $ne: true },
			priv: { $ne: true },
			$or: [{ ad: { $lt: Date.now() - config.cooldowns.advertisement * 60000 } }, { ad: { $exists: false } }],
		})
		.toArray();

	if (validChats.length == 0) {
		return;
	}

	for (const chat of validChats) {
		if (chat.noAds || !chat.ad || chat.ad == 0 || chat.type == 'channel' || chat.type == 'private') {
			continue;
		}

		sendMessage(parseInt(chat.id), getText('advertisement'), {
			reply_markup: {
				inline_keyboard: [
					[
						{
							text: '@CAUTION',
							url: 'https://t.me/caution',
						},
					],
				],
			},
		});
		await sleep(1000);
	}

	await chatsCollection.updateMany(
		{
			id: { $in: validChats.map((c) => c.id) },
		},
		{
			$set: {
				ad: Date.now(),
			},
		}
	);
}

let running = false;
setInterval(async () => {
	if (running || !database.isReady()) {
		return;
	}

	running = true;

	try {
		await tick();
	} catch (e) {
		console.error(e);
	} finally {
		running = false;
	}
}, 60000);

tick();
