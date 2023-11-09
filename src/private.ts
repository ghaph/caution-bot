import TelegramBot, { Message } from 'node-telegram-bot-api';
import { sendMessage, bot, client, self, getUsernames, isChatRateLimited } from '.';
import database, { usersCollection } from './database/database';
import { CommandState, UserData } from './database/types';
import { getDisplayName, getMention, getMentionFromData, getUsername, isAllDigits, isStaff } from './utils';
import { getText } from './texts';
import { executeUserDWC, removeUserDWC } from './manager/manager';
import { Api } from 'telegram';
import BigInteger from 'big-integer';
import { MatchKeysAndValues } from 'mongodb';
import { forwardAppeal, forwardReport } from './manager/staffarea';
import config from './config';

// key is user id value is user data
const flowCache: { [key: number]: UserData } = {};

// used on report_getuser, used to prevent people rate limiting the bot
const lastSearches: { [key: number]: number } = {};

bot.on('message', async (msg: TelegramBot.Message) => {
	if (msg.chat.type != 'private' || !msg.from || msg.from.id == self().id) {
		return;
	}

	if (await database.isUserBanned(msg.from.id)) {
		if (msg.text && msg.text.length > 0) {
			sendMessage(msg.chat.id, getText('banned'), {
				rate_limit: 3000,
			});
		}

		return;
	}

	msg.text = msg.text || '';

	const args = msg.text.split(' ');
	const command = args.shift()?.toLowerCase();

	switch (command) {
		case '/start':
		case '/report':
			if (isChatRateLimited(msg.chat.id, 1000)) {
				return;
			}

			{
				if (!isStaff(msg.from.id)) {
					const userData = await getUserDataCached(msg.from.id);
					if (Date.now() - (userData?.lastReport || 0) < config.cooldowns.reports * 60000) {
						sendMessage(msg.chat.id, getText('report_cooldown'), {
							rate_limit: 1000,
						});
						return;
					}
				}

				setState(msg.from, 'report_getuser');
				sendMessage(msg.chat.id, getText('report_getuser'), {
					rate_limit: 1000,
				});
			}
			return;
		case '/send':
			await sendProof(msg);
			return;
		case '/cancel':
			closeState(msg.from);
			sendMessage(msg.chat.id, getText('state_cancel'), {
				rate_limit: 1000,
			});
			return;
		case '/appeal':
			if (isChatRateLimited(msg.chat.id, 1000)) {
				return;
			}

			if (!(await database.isUserDWC(msg.from))) {
				sendMessage(msg.chat.id, getText('appeal_notdwc'), {
					rate_limit: 1000,
				});
				return;
			}

			if (!(await database.canUserAppeal(msg.from.id))) {
				sendMessage(msg.chat.id, getText('appeal_cannot'), {
					rate_limit: 1000,
				});
				return;
			}

			setState(msg.from, 'appeal_awaitingproof');

			sendMessage(msg.chat.id, getText('appeal_sendproof'), {
				rate_limit: 1000,
				reply_to_message_id: msg.message_id,
				reply_markup: {
					inline_keyboard: [[{ text: 'Send', callback_data: 'reporting_send' }]],
				},
			});
			return;
		case '/blacklist':
			if (!isStaff(msg.from)) {
				return;
			}

			try {
				const userId = parseInt(args[0]);
				if (!userId || isNaN(userId) || userId <= 0) {
					sendMessage(msg.chat.id, 'Invalid user id', {
						reply_to_message_id: msg.message_id,
					});
					return;
				}

				const reason = args.slice(1).join(' ');
				if (!reason) {
					sendMessage(msg.chat.id, 'No reason provided', {
						reply_to_message_id: msg.message_id,
					});
					return;
				}

				await usersCollection.updateOne(
					{
						id: userId.toString(),
					},
					{
						$set: {
							banned: reason,
							id: userId.toString(),
						},
					},
					{
						upsert: true,
					}
				);

				sendMessage(msg.chat.id, 'Successfully blacklisted that user', {
					reply_to_message_id: msg.message_id,
				});

				sendMessage(config.channels.privateReports, `User ${getMention(userId)} was blacklisted by ${getMention(msg.from)} for reason: ${reason}`);
			} catch (e) {
				console.error(e);
				sendMessage(msg.chat.id, 'An error occured blacklisting that user', {
					reply_to_message_id: msg.message_id,
				});
			}

			return;
		case '/dwc':
			if (!isStaff(msg.from)) {
				return;
			}

			try {
				const userId = parseInt(args[0]);
				if (!userId || isNaN(userId) || userId <= 0) {
					sendMessage(msg.chat.id, 'Invalid user id', {
						reply_to_message_id: msg.message_id,
					});
					return;
				}

				const reason = args.slice(1).join(' ');
				if (!reason) {
					sendMessage(msg.chat.id, 'No reason provided', {
						reply_to_message_id: msg.message_id,
					});
					return;
				}

				await usersCollection.updateOne(
					{
						id: userId.toString(),
					},
					{
						$set: {
							id: userId.toString(),
							dwc: true,
							dwcReason: reason,
						},
					},
					{
						upsert: true,
					}
				);

				sendMessage(msg.chat.id, "Successfully silent DWC'd that user. Executing now...", {
					reply_to_message_id: msg.message_id,
				});

				executeUserDWC(userId, true)
					.catch((e) => {
						console.error(e);
						sendMessage(msg.chat.id, 'Failed to execute DWC on that user: ' + e, {
							reply_to_message_id: msg.message_id,
						});
					})
					.then((success) => {
						sendMessage(msg.chat.id, (success ? 'Successfully' : 'Failed to') + ' execute DWC on that user', {
							reply_to_message_id: msg.message_id,
						});
					});

				sendMessage(config.channels.privateReports, `User ${getMention(userId)} was DWC'd by ${getMention(msg.from)} for reason: ${reason}`);
			} catch (e) {
				console.error(e);
				sendMessage(msg.chat.id, 'An error occured DWCing that user: ' + e, {
					reply_to_message_id: msg.message_id,
				});
			}
			return;
		case '/undwc':
			if (!isStaff(msg.from)) {
				return;
			}

			try {
				const userId = parseInt(args[0]);
				if (!userId || isNaN(userId) || userId <= 0) {
					sendMessage(msg.chat.id, 'Invalid user id', {
						reply_to_message_id: msg.message_id,
					});
					return;
				}

				sendMessage(msg.chat.id, 'Successfully UnDWCd that user. Executing now...', {
					reply_to_message_id: msg.message_id,
				});

				removeUserDWC(userId)
					.catch((e) => {
						console.error(e);
						sendMessage(msg.chat.id, 'Failed to execute UnDWC on that user: ' + e, {
							reply_to_message_id: msg.message_id,
						});
					})
					.then((success) => {
						sendMessage(msg.chat.id, (success ? 'Successfully' : 'Failed to') + ' execute UnDWC on that user', {
							reply_to_message_id: msg.message_id,
						});
					});

				sendMessage(config.channels.privateReports, `User ${getMention(userId)} was UnDWC'd by ${getMention(msg.from)}`);
			} catch (e) {
				console.error(e);
				sendMessage(msg.chat.id, 'An error occured UnDWCing that user: ' + e, {
					reply_to_message_id: msg.message_id,
				});
			}

			return;
	}

	const userData = await getUserDataCached(msg.from.id);
	if (!userData) {
		return;
	}

	switch (userData.commands?.state) {
		case 'report_awaitingproof':
		case 'appeal_awaitingproof':
			if (!userData.commands.msgs) {
				userData.commands.msgs = [];
			} else if (userData.commands.msgs.length >= 100) {
				break;
			}

			userData.commands.msgs.push(msg.message_id);

			delete flowCache[msg.from.id];

			// add message id to database to retrieve later
			usersCollection.updateOne(
				{
					id: msg.from.id.toString(),
				},
				{
					$addToSet: {
						'commands.msgs': msg.message_id,
					},
				}
			);
			break;
		case 'report_getsummary':
			if (msg.text.length < 20 || msg.text.length > 200) {
				sendMessage(msg.chat.id, getText('report_getsummary'), {
					reply_to_message_id: msg.message_id,
					rate_limit: 500,
				});
				break;
			}

			userData.commands.reportSummary = msg.text;
			setState(msg.from, 'report_getamount', {
				'commands.reportSummary': msg.text,
			});

			sendMessage(msg.chat.id, getText('report_getamount'), {
				reply_to_message_id: msg.message_id,
			});
			break;
		case 'report_getuser': {
			let reportingUser: TelegramBot.User | Api.User | undefined = msg.forward_from;
			if (!reportingUser) {
				if (Date.now() - (lastSearches[msg.from.id] || 0) < 5000) {
					sendMessage(msg.chat.id, 'Please wait a few seconds before searching again', {
						reply_to_message_id: msg.message_id,
					});
					break;
				}

				lastSearches[msg.from.id] = Date.now();

				const trimmed = msg.text.trim();
				if (trimmed.startsWith('@')) {
					const username = trimmed.slice(1);
					if (username.length < 4 || username.length > 32 || username.includes(' ')) {
						sendMessage(msg.chat.id, 'Invalid username, please try again', {
							reply_to_message_id: msg.message_id,
						});
						break;
					}

					try {
						const entity = await client.getEntity(username);
						if (entity.className != 'User') {
							sendMessage(msg.chat.id, getText('report_badusername'), {
								reply_to_message_id: msg.message_id,
							});
							break;
						}

						reportingUser = entity;
					} catch {
						sendMessage(msg.chat.id, getText('report_badusername'), {
							reply_to_message_id: msg.message_id,
						});
						break;
					}
				} else if (isAllDigits(trimmed)) {
					const user = await usersCollection.findOne({
						id: trimmed.toString(),
					});

					if (!user) {
						sendMessage(msg.chat.id, 'Invalid user id or that user id is not in the database, please try again', {
							reply_to_message_id: msg.message_id,
						});
						break;
					}
				}

				if (!reportingUser) {
					sendMessage(msg.chat.id, getText('report_getuser'), {
						reply_to_message_id: msg.message_id,
					});
					break;
				}
			}

			const reportingId = typeof reportingUser.id == 'number' ? reportingUser.id : reportingUser.id.toJSNumber();

			if (await database.isUserDWC(reportingId)) {
				sendMessage(msg.chat.id, getText('report_already_listed'), {
					reply_to_message_id: msg.message_id,
					reply_markup: {
						inline_keyboard: [
							[
								{ text: 'Deny', callback_data: 'reporting_deny' },
								{ text: 'Confirm', callback_data: 'reporting_confirm_' + reportingId },
							],
						],
					},
				});
				break;
			}

			setState(msg.from, 'report_getsummary', {
				'commands.reportingId': reportingId,
			});

			sendMessage(msg.chat.id, getText('report_getsummary'));
			break;
		}
		case 'report_getamount':
			{
				if (!userData.commands.reportingId) {
					closeState(msg.from);
					break;
				}

				let amount = -1;
				if (msg.text.toLowerCase() != 'n/a') {
					amount = parseFloat(msg.text.replace(/,|\$|\s/g, ''));
					if (isNaN(amount) || amount <= 0) {
						sendMessage(msg.chat.id, getText('report_getamount'), {
							reply_to_message_id: msg.message_id,
							rate_limit: 500,
						});
						break;
					}
				}

				setState(msg.from, 'report_awaitingproof', {
					'commands.amount': amount,
				});

				let retrievedUser: Api.User | undefined;

				const usernames = await getUsernames(userData.commands.reportingId);
				sendMessage(
					msg.chat.id,
					getText('report_sendproof')
						.replace(/{usernames}/g, usernames.usernames.length > 0 ? usernames.usernames.map((x) => '@' + x).join(' | ') : 'None')
						.replace(/{name}/g, usernames.name || (retrievedUser ? getDisplayName(retrievedUser) : userData.name || 'N/A'))
						.replace(/{mention}/g, retrievedUser ? getMention(retrievedUser) : getMentionFromData(userData))
						.replace(/{uid}/g, getMention(userData.commands.reportingId))
						.replace(/{amount}/g, amount > 0 ? '$' + amount.toFixed(2) : 'N/A'),
					{
						reply_to_message_id: msg.message_id,
						reply_markup: {
							inline_keyboard: [[{ text: 'Send', callback_data: 'reporting_send' }]],
						},
					}
				);
			}
			break;
	}
});

bot.on('callback_query', async (cb) => {
	if (!cb.data?.startsWith('reporting_') || !cb.message) {
		return;
	}

	bot.editMessageReplyMarkup(
		{
			inline_keyboard: [],
		},
		{
			chat_id: cb.from.id,
			message_id: cb.message.message_id,
		}
	).catch(console.error);

	const userData = await getUserDataCached(cb.from.id);
	if (!userData || !(userData.commands?.state == 'report_getuser' || userData.commands?.state == 'report_awaitingproof' || userData.commands?.state == 'appeal_awaitingproof')) {
		return;
	}

	switch (cb.data.split('_')[1]) {
		case 'send':
			sendProof(cb.message).catch(console.error);
			break;
		case 'confirm':
			setState(cb.from, 'report_getsummary', {
				'commands.reportingId': parseInt(cb.data.split('_')[2]),
			});

			sendMessage(cb.from.id, getText('report_getsummary'), {
				reply_to_message_id: cb.message.message_id,
			});
			break;
		case 'deny':
			closeState(cb.from);
			break;
	}
});

async function sendProof(msg: Message) {
	if (msg.chat.type != 'private' || !msg.from) {
		return;
	}

	const userId = !self() || self().id == msg.from.id ? msg.chat.id : msg.from.id;
	const userData = await getUserDataCached(userId, true);
	if (!userData?.commands?.msgs || userData.commands.msgs.length <= 0 || (userData.commands.state == 'report_awaitingproof' && !userData.commands.reportingId)) {
		sendMessage(userId, getText('send_nomsgs'));
		return;
	}

	switch (userData.commands.state) {
		case 'report_awaitingproof':
			if (!isStaff(userId) && Date.now() - (userData.lastReport || 0) < config.cooldowns.reports * 60000) {
				sendMessage(userId, getText('report_cooldown'));
				return;
			}

			forwardReport(userId, userData.commands.reportingId as number, userData.commands.msgs, userData.commands.reportSummary || 'N/A', userData.commands.amount);
			closeState(userId, {
				lastReport: Date.now(),
			});
			sendMessage(userId, getText('report_success'));
			break;
		case 'appeal_awaitingproof':
			if (!isStaff(userId) && Date.now() - (userData.lastAppeal || 0) < config.cooldowns.appeals * 60000) {
				sendMessage(userId, getText('appeal_cannot'));
				return;
			}

			forwardAppeal(userId, userData.commands.msgs);
			closeState(userId, {
				appealing: true,
				lastAppeal: Date.now(),
			});
			sendMessage(userId, getText('appeal_success'));
			break;
	}
}

async function closeState(user: TelegramBot.User | number, add: MatchKeysAndValues<UserData> = {}) {
	const userId = typeof user == 'number' ? user : user.id;
	delete flowCache[userId];

	try {
		const base: Partial<UserData> & Record<string, string> = {
			id: userId.toString(),
		};

		if (typeof user != 'number') {
			base['name'] = getDisplayName(user);
			base['username'] = getUsername(user);
		}

		for (const a in add) {
			base[a] = add[a];
		}

		const resp = await usersCollection.updateOne(
			{
				id: userId.toString(),
			},
			{
				$set: base,
				$unset: {
					commands: '',
				},
			},
			{
				upsert: true,
			}
		);

		// if none were modified and none were upserted state was already set
		if (resp.modifiedCount == 0 && resp.upsertedCount == 0) {
			return;
		}
	} catch (e) {
		console.error(e);
	}
}

async function setState(user: TelegramBot.User, state: CommandState, add: MatchKeysAndValues<UserData> = {}) {
	delete flowCache[user.id];

	try {
		const base: MatchKeysAndValues<UserData> = {
			id: user.id.toString(),
			name: getDisplayName(user),
			'commands.state': state,
			username: getUsername(user),
		};

		for (const a in add) {
			base[a] = add[a];
		}

		await usersCollection.updateOne(
			{
				id: user.id.toString(),
			},
			{
				$set: base,
			},
			{
				upsert: true,
			}
		);
	} catch (e) {
		console.error(e);
	}
}

async function getUserDataCached(uid: number, noCache?: boolean): Promise<UserData | undefined> {
	if (!noCache) {
		const cached = flowCache[uid];
		if (cached) {
			return cached;
		}
	}

	const db = await usersCollection.findOne({
		id: uid.toString(),
	});

	if (!db) {
		return;
	}

	flowCache[uid] = db;
	return db;
}
