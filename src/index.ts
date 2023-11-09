import TelegramBot from 'node-telegram-bot-api';
import config from './config';
import chalk from 'chalk';
import database, { chatsCollection } from './database/database';
import { PublicChat, UserData } from './database/types';
import { isStaff, sleep } from './utils';
import { banUserFromChat, queueChatForScrape } from './manager/manager';
import { Api, TelegramClient } from 'telegram';
import { StoreSession } from 'telegram/sessions';
import BigInteger from 'big-integer';

let selfUser: TelegramBot.User | null = null;

// bot is used for majority of things like message listener, sending messages, etc
export const bot = new TelegramBot(config.token);

// client is used for mtproto only queries like fetching detailed user data, etc
export const client = new TelegramClient(new StoreSession('bot_session'), config.apiId, config.apiHash, {
	autoReconnect: true,
	connectionRetries: 999999999,
});

client.setParseMode('html');

import './private';
import './ads';
import { getDisplayName } from 'telegram/Utils';

(async () => {
	while (!database.isReady()) {
		await sleep(100);
	}

	await client.start({
		botAuthToken: config.token,
	});

	bot.startPolling({
		polling: {
			interval: 0,
			params: {
				allowed_updates: [
					'update_id',
					'message',
					'edited_message',
					'channel_post',
					'edited_channel_post',
					'inline_query',
					'chosen_inline_result',
					'callback_query',
					'my_chat_member',
					'chat_member',
				],
			},
		},
	});

	bot.getMe().then((user) => {
		selfUser = user;

		console.log(chalk.magentaBright(`Logged in as @${user.username} (${user.id})`));
	});
})();

bot.on('error', (e) => {
	console.error(e);
});

// works for all users including the bot
bot.on('new_chat_members', async (msg) => {
	if (!msg.new_chat_members) {
		return;
	}

	const users = msg.new_chat_members.map((u) => u.id);

	try {
		const set: Partial<PublicChat> = {
			id: msg.chat.id.toString(),
			type: msg.chat.type,
		};

		const unset: { [key in keyof PublicChat]?: '' } = {
			priv: '',
		};

		const resp = await chatsCollection.updateOne(
			{
				id: msg.chat.id.toString(),
			},
			{
				$set: set,
				$unset: unset,
				$addToSet: {
					users: {
						$each: users,
					},
				},
			},
			{
				upsert: true,
			}
		);

		// if added to document we needa scrape
		if (resp.upsertedCount > 0) {
			queueChatForScrape(msg.chat);
		}

		for (const user of users) {
			if (await database.isUserDWC(user)) {
				// ban and send message
				await banUserFromChat(msg.chat.id, user);
			}
		}
	} catch (e) {
		console.error(e);
	}
});

// works for all members including the bot
bot.on('left_chat_member', async (msg) => {
	if (!msg.left_chat_member) {
		return;
	}

	try {
		const set: Partial<PublicChat> = {
			id: msg.chat.id.toString(),
			type: msg.chat.type,
		};

		const unset: { [key in keyof PublicChat]?: '' } = {};

		if (msg.left_chat_member.id == self().id) {
			set.priv = true;
		} else {
			unset.priv = '';
		}

		const resp = await chatsCollection.updateOne(
			{
				id: msg.chat.id.toString(),
			},
			{
				$set: set,
				$unset: unset,
				$pull: {
					users: msg.left_chat_member?.id,
				},
			},
			{
				upsert: true,
			}
		);

		// if added to document we needa scrape
		if (resp.upsertedCount > 0) {
			queueChatForScrape(msg.chat);
		}
	} catch (e) {
		console.error(e);
	}
});

export function self(): TelegramBot.User {
	return (
		selfUser || {
			id: 0,
			first_name: '',
			is_bot: true,
		}
	);
}

const messageHistory: { [key: string]: number } = {};

export async function sendMessage(chatId: number | string, text: string, options?: TelegramBot.SendMessageOptions & { rate_limit?: number }) {
	if (!options) {
		options = {};
	}

	options.parse_mode = 'HTML';

	if (options.rate_limit) {
		if (messageHistory[chatId.toString()] && Date.now() - messageHistory[chatId.toString()] < options.rate_limit) {
			return Promise.resolve(null);
		}

		delete options.rate_limit;
		messageHistory[chatId.toString()] = Date.now();
	}

	return bot.sendMessage(typeof chatId == 'string' ? parseInt(chatId) : chatId, text, options).catch((e) => {
		if (!e || !e.toString().toLowerCase().includes('bot was blocked by user')) {
			console.error(e);
		}
	});
}

export function isChatRateLimited(chatId: number | string, delay: number) {
	return messageHistory[chatId.toString()] && Date.now() - messageHistory[chatId.toString()] < delay;
}

type Name = {
	usernames: string[];
	name?: string;
};
const usernamesCache: { [key: number]: { name: Name; t: number } } = {};

export async function getUsernames(user: number | UserData): Promise<Name> {
	const uid = typeof user == 'number' ? user : parseInt(user.id);
	const cached = usernamesCache[uid];
	if (cached && Date.now() - cached.t < (isStaff(user) ? 1000 * 60 * 60 : 1000 * 60 * 5)) {
		return cached.name;
	}

	const hash = typeof user == 'number' ? undefined : user.hash;

	let usernames: string[] = typeof user != 'number' && user.username ? [user.username] : [];
	let name = typeof user != 'number' ? user.name : undefined;

	try {
		const resp = await client.invoke(
			new Api.users.GetUsers({
				id: [
					hash
						? new Api.InputUser({
								userId: BigInteger(uid),
								accessHash: BigInteger(hash),
						  })
						: BigInteger(uid),
				],
			})
		);

		for (const user of resp) {
			if (user.id.eq(uid) && user.className == 'User') {
				name = getDisplayName(user);

				usernames = [];

				if (user.username) {
					usernames.push(user.username);
				}

				if (user.usernames) {
					for (const un of user.usernames) {
						usernames.push(un.username);
					}
				}
			}
		}
	} catch (e) {
		console.error(e);
	}

	const elm = {
		usernames,
		name,
	};

	usernamesCache[uid] = {
		name: elm,
		t: Date.now(),
	};

	return elm;
}
