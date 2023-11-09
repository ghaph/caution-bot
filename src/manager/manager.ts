import TelegramBot from 'node-telegram-bot-api';
import { chatsCollection, usersCollection } from '../database/database';
import { ApprovedReport, PublicChat, UserData } from '../database/types';
import { getDisplayName, getMention, getMentionFromData, getUsername } from '../utils';
import { sendMessage, bot, client, self, getUsernames } from '..';
import './scraper';
import { getText } from '../texts';
import config from '../config';

// key is chat id, value is a link to the message without any prefix
const chatLinks: { [key: number]: string } = {};

async function fetchChatLink(chatId: number): Promise<string> {
	if (chatLinks[chatId]) {
		return chatLinks[chatId];
	}

	try {
		const chat = await bot.getChat(chatId);
		let foundLink = chat.username || (chat.active_usernames && chat.active_usernames.reduce((a, b) => (a.length <= b.length ? a : b)));

		if (!foundLink) {
			foundLink = 'c/' + chat.id.toString().replace('-100', '');
		}

		chatLinks[chatId] = foundLink;
		return foundLink;
	} catch (e) {
		console.error(e);
		return '';
	}
}

export async function banUserFromChat(chatId: number | PublicChat, userId: number | UserData, silent?: boolean) {
	const chat: PublicChat | undefined =
		typeof chatId == 'number'
			? ((await chatsCollection.findOne({
					id: chatId.toString(),
			  })) as any)
			: chatId;

	chatId = typeof chatId == 'number' ? chatId : parseInt(chatId.id);

	if (!chatId || chatId == 0) {
		console.error(`Failed to ban user ${userId} from chat ${chatId}, invalid chat id: ${chatId}`);
		return;
	}

	try {
		const userData = typeof userId == 'number' ? await usersCollection.findOne({ id: userId.toString() }) : userId;
		userId = typeof userId == 'number' ? userId : parseInt(userId.id);

		const chatType = chat?.type || (await bot.getChat(chatId)).type;

		const result = await bot.banChatMember(chatId, userId, undefined, config.options.revokeMessagesOnBan);
		if (!result) {
			console.error(`Failed to ban ${userId} from ${chatId}`);
			sendMessage(config.channels.privateReports, `<b>[EXECUTE]</b> Failed to ban ${userId} from ${chatId}`).catch(console.error);
			return;
		}

		await chatsCollection.updateOne(
			{
				id: chatId.toString(),
			},
			{
				$set: {
					id: chatId.toString(),
					type: chatType,
				},
				$addToSet: {
					banned: userId,
				},
			},
			{
				upsert: true,
			}
		);

		// send notification in chat that user got banned
		if (!silent && (!chat || !chat.noAds) && chatType != 'channel' && chatType != 'private' && userData?.dwcMsg) {
			const link = await fetchChatLink(userData.dwcMsg.chat);
			if (!link) {
				sendMessage(config.channels.privateReports, `<b>[EXECUTE]</b> Failed to ban ${userId} from ${chatId}: Failed to fetch chat link`).catch(console.error);
				return;
			}

			const repLink = 'https://t.me/' + link + '/' + userData.dwcMsg.id;
			sendMessage(
				chatId,
				getText('banned_from_group')
					.replace(/{mention}/g, getMentionFromData(userData))
					.replace(/{report_message}/g, repLink)
					.replace(/{bot}/g, self().username || 'N/A'),
				{
					reply_markup: {
						inline_keyboard: [[{ text: 'View Report', url: repLink }]],
					},
				}
			).catch(console.error);
		}
	} catch (e) {
		console.error(e);
		sendMessage(config.channels.privateReports, `<b>[EXECUTE]</b> Failed to ban ${userId} from ${chatId}: ${e}`).catch(console.error);
	}
}

export async function executeUserDWC(user: TelegramBot.User | number, silent?: boolean): Promise<boolean> {
	const userId = typeof user == 'number' ? user : user.id;

	const userData = await usersCollection.findOne({
		id: userId.toString(),
	});

	if (!userData) {
		console.error(`[${userId}] Failed to execute user DWC, user not found`);
		return false;
	}

	// sends the dwc message to the main channel
	if (!silent) {
		let amounts = '';

		if (userData.reports) {
			for (const report of userData.reports) {
				if (!report.amountUsd || report.amountUsd <= 0) {
					continue;
				}

				if (amounts.length > 0) {
					amounts += ', ';
				}

				amounts += `$${report.amountUsd}`;
			}
		}

		if (amounts.length <= 0) {
			amounts = 'N/A';
		}

		const reports = userData.reports || [];
		let reportLinks = '';
		const foundLinks: string[] = [];
		let reportIndex = 0;

		for (const report of reports) {
			const lh = report.proof.chat + ':' + report.proof.id;
			if (foundLinks.includes(lh)) {
				continue;
			}

			foundLinks.push(lh);

			if (reportLinks.length > 0) {
				reportLinks += ' | ';
			}

			const link = await fetchChatLink(report.proof.chat);
			if (!link) {
				continue;
			}

			reportLinks += `<a href="https://t.me/${link}/${report.proof.id}">${reports.length == 1 ? 'Click here' : `Report #${(reportIndex += 1)}`}</a>`;
		}

		const usernames = await getUsernames(userData);
		const text = getText('public_listing')
			.replace(/{usernames}/g, usernames.usernames.length > 0 ? usernames.usernames.map((x) => '@' + x).join(' | ') : 'None')
			.replace(/{name}/g, usernames.name || (typeof user == 'number' ? userData.name || 'N/A' : getDisplayName(user)))
			.replace(/{user_link}/g, getMention(userId))
			.replace(/{amounts}/g, amounts)
			.replace(/{explanation}/g, userData.reports?.find((r) => r.summary)?.summary || 'N/A')
			.replace(/{reports}/g, reportLinks || 'N/A');

		if (userData.dwcMsg) {
			bot.editMessageText(text, {
				chat_id: userData.dwcMsg.chat,
				message_id: userData.dwcMsg.id,
				parse_mode: 'HTML',
				disable_web_page_preview: true,
			}).catch(console.error);
		} else {
			const msg = await sendMessage(config.channels.publicLog, text, {
				parse_mode: 'HTML',
				disable_web_page_preview: true,
			});

			if (msg) {
				await usersCollection.updateOne(
					{
						id: userId.toString(),
					},
					{
						$set: {
							dwcMsg: {
								chat: msg.chat.id,
								id: msg.message_id,
							},
						},
					}
				);
			}
		}
	}

	const sharedChats = await chatsCollection
		.find({
			users: userId,
			banned: { $ne: userId },
		})
		.toArray();

	for (const chat of sharedChats) {
		// needs to refetch user data
		await banUserFromChat(chat, userId, silent);
	}

	return true;
}

export async function removeUserDWC(user: TelegramBot.User | number): Promise<boolean> {
	const userId = typeof user == 'number' ? user : user.id;

	const userData = await usersCollection.findOne({
		id: userId.toString(),
	});

	if (!userData) {
		console.error(`[${userId}] Failed to remove user DWC, user not found`);
		return true;
	}

	let removedMsg = false;

	// removes the dwc message listed in the main channel
	if (userData.dwcMsg) {
		bot.deleteMessage(userData.dwcMsg.chat, userData.dwcMsg.id)
			.catch(console.error)
			.then(() => {
				if (!removedMsg) {
					usersCollection
						.updateOne(
							{
								id: userId.toString(),
							},
							{
								$unset: {
									dwcMsg: '',
								},
							}
						)
						.catch(console.error);
				}
			});
	}

	if (!userData.dwc) {
		console.error(`[${userId}] Failed to remove user DWC, user is not DWC`);
		return true;
	}

	const res = await usersCollection.updateOne(
		{
			id: userId.toString(),
		},
		{
			$unset: {
				dwc: '',
				reports: '',
				dwcMsg: '',
			},
		}
	);

	if (res.modifiedCount == 0) {
		console.error(`[${userId}] Failed to remove user DWC, no users were modified`);
		return false;
	}

	removedMsg = true;

	if (userData.reports) {
		for (const report of userData.reports) {
			bot.deleteForumTopic(report.proof.chat, report.proof.id).catch(console.error);
		}
	}

	const bannedChats = (
		await chatsCollection
			.find({
				banned: { $in: [userId] },
			})
			.toArray()
	).map((c) => c.id);

	for (const chat of bannedChats) {
		bot.unbanChatMember(chat, userId).catch(console.error);
	}

	// remove user id from all banned lists
	await chatsCollection.updateMany(
		{
			id: { $in: bannedChats },
			banned: userId,
		},
		{
			$pull: {
				banned: userId,
			},
		}
	);

	return true;
}

export async function applyUserDWC(user: TelegramBot.User | number, reason: ApprovedReport): Promise<boolean> {
	const userId = typeof user == 'number' ? user : user.id;

	const set: Partial<UserData> = {
		id: userId.toString(),
	};

	if (typeof user == 'number') {
		const data = await getUsernames(userId);
		set.name = data.name;
		set.username = data.usernames[0];
	} else {
		set.name = getDisplayName(user);
		set.username = getUsername(user);
	}

	await usersCollection.updateOne(
		{
			id: userId.toString(),
		},
		{
			$set: set,
		},
		{
			upsert: true,
		}
	);

	const userData = await usersCollection.findOne({
		id: userId.toString(),
	});

	if (!userData) {
		console.error(`[${userId}] Failed to apply user DWC, user not found`);
		return false;
	}

	if (userData.reports?.some((r) => r.proof.id == reason.proof.id && r.proof.chat == reason.proof.chat)) {
		console.error(`[${userId}] Failed to apply user DWC, user already has same report`);
		return false;
	}

	const res = await usersCollection.updateOne(
		{
			id: userId.toString(),
		},
		{
			$push: {
				reports: reason,
			},
			$set: {
				dwc: true,
			},
		}
	);

	if (res.modifiedCount == 0) {
		console.error(`[${userId}] Failed to apply user DWC, no reports were modified`);
		return false;
	}

	return await executeUserDWC(user);
}

export async function queueChatForScrape(chat: TelegramBot.Chat) {
	try {
		await chatsCollection.updateOne(
			{
				id: chat.id.toString(),
			},
			{
				$set: {
					id: chat.id.toString(),
					type: chat.type,
				},
				$setOnInsert: {
					needsScraped: true,
				},
			},
			{
				upsert: true,
			}
		);
	} catch (e) {
		console.error(e);
	}
}
