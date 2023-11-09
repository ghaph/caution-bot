import { Api } from 'telegram';
import { bot, client, getUsernames, sendMessage } from '..';
import config from '../config';
import database, { reportsCollection, usersCollection } from '../database/database';
import { ApprovedReport, UnapprovedReport } from '../database/types';
import { getText } from '../texts';
import { getMention, isStaff } from '../utils';
import fs from 'fs';
import { applyUserDWC, removeUserDWC } from './manager';

if (!fs.existsSync('./data')) {
	fs.mkdirSync('./data');
}

const staffStates: {
	[key: number]: {
		state: 'none' | 'report_reason' | 'appeal_reason';

		channel?: number;

		// the report id or the appeal id
		reasonId?: string;

		// this is used to prevent a report/appeal being approved 2 times at t he same time
		approving?: boolean;
	};
} = fs.existsSync('./data/staffStates.json') ? JSON.parse(fs.readFileSync('./data/staffStates.json', 'utf-8')) : {};

bot.on('callback_query', async (query) => {
	if (!query.from || !query.message || !query.data?.startsWith('staff_') || !isStaff(query.from.id)) {
		return;
	}

	const chatId = query.message.chat.id;

	const userState = staffStates[query.from.id] || { state: 'none' };
	staffStates[query.from.id] = userState;

	const args = query.data.split('_');
	args.shift();

	const rid = args[1];

	// remove buttons from messaage
	bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(console.error);

	const prefix = (query.from.username ? `@${query.from.username} (${query.from.id})` : getMention(query.from.id)) + '\n';

	switch (args[0]) {
		case 'approvereport':
			{
				const report = await reportsCollection.findOne({ id: rid });
				if (!report) {
					console.error('Report not found');
					sendMessage(chatId, 'Report not found', {
						reply_to_message_id: query.message.message_id,
						rate_limit: 500,
					});
					return;
				}

				if (userState.approving) {
					sendMessage(chatId, prefix + 'You are already approving a report/appeal', {
						rate_limit: 500,
					});
					return;
				}

				userState.approving = true;

				try {
					let threadId: number = 0;

					if (!threadId) {
						const currentUser = await usersCollection.findOne({ id: report.reported.toString() });
						if (currentUser?.reports && currentUser.reports.length > 0) {
							threadId = currentUser.reports.find((x) => x.proof.chat == config.channels.proofTopics)?.proof.id || 0;
						}
					}

					if (!threadId) {
						const usernames = (await getUsernames(report.reported)).usernames;
						const resp = await bot.createForumTopic(
							config.channels.proofTopics,
							`Proof of [${usernames.length > 0 ? usernames.map((u) => '@' + u).join(' | ') : 'None'}] (${report.reported})`
						);
						if (!resp) {
							throw new Error('Failed to create forum topic');
						}

						// typings are wrong here
						threadId = (resp as any).message_thread_id;
						if (!threadId) {
							throw new Error('Failed to find forum topic id: ' + JSON.stringify(resp));
						}
					}

					await client.invoke(
						new Api.messages.ForwardMessages({
							fromPeer: report.evidence.chat,
							id: report.evidence.msgs,
							topMsgId: threadId,
							toPeer: config.channels.proofTopics,
							silent: true,
						})
					);

					const approvedReport: ApprovedReport = {
						amountUsd: report.amountUsd,
						proof: {
							chat: config.channels.proofTopics,
							id: threadId,
						},
						reporter: report.reporter,
						summary: report.summary,
					};

					sendMessage(chatId, `${prefix} has approved this report`, {
						reply_to_message_id: query.message.message_id,
					});

					const res = await applyUserDWC(report.reported, approvedReport);

					sendMessage(chatId, `${res ? 'Successfully' : 'Failed to'} execute${res ? 'd' : ''} DWC`, {
						reply_to_message_id: query.message?.message_id,
					});

					// delete old unapproved report
					await reportsCollection.deleteOne({ id: report.id });

					const usernames = (await getUsernames(report.reported)).usernames;
					sendMessage(
						report.reporter,
						getText('reporter_notify_approved').replace(/{mention}/g, usernames.length > 0 ? '@' + usernames[0] : getMention(report.reported))
					);
				} catch (e) {
					console.error(e);

					sendMessage(chatId, `${prefix}There was an error approving this report`, {
						reply_to_message_id: query.message.message_id,
					});
				} finally {
					userState.approving = false;
					saveState();
				}
			}
			break;
		case 'denyreport':
			{
				const report = await reportsCollection.findOne({ id: rid });
				if (!report) {
					console.error('Report not found');
					sendMessage(chatId, 'Report not found', {
						reply_to_message_id: query.message.message_id,
						rate_limit: 500,
					});
					return;
				}

				if (userState.approving) {
					sendMessage(chatId, `@${query.from.username} You are approving a report/appeal, please wait a bit`, {
						rate_limit: 500,
					});
					return;
				}

				userState.state = 'report_reason';
				userState.reasonId = report.id;
				userState.channel = chatId;
				saveState();

				sendMessage(chatId, `${prefix}Please send the reason for denying this report. At least 3 characters`, {
					reply_to_message_id: query.message.message_id,
				});
			}
			break;
		case 'approveappeal':
			if (!(await database.isUserAppealing(rid))) {
				sendMessage(chatId, `${prefix}This user\'s appeal has already been reviewed`, {
					reply_to_message_id: query.message.message_id,
				});
				return;
			}

			if (userState.approving) {
				sendMessage(chatId, `@${query.from.username} You are approving an appeal, please wait a bit`, {
					rate_limit: 500,
				});
				return;
			}

			userState.approving = true;

			try {
				const uid = parseInt(rid);

				await database.setUserAppealing(uid, false);
				if (!(await removeUserDWC(uid))) {
					throw new Error('Failed to remove user DWC');
				}

				const usernames = await getUsernames(uid);
				sendMessage(chatId, `${prefix}Successfully un-dwc'd @${usernames.usernames[0]} (${uid})`, {
					reply_to_message_id: query.message.message_id,
				});
			} catch (e) {
				console.error(e);
				sendMessage(chatId, `${prefix}Failed to unappeal user, please manually un-dwc them`, {
					reply_to_message_id: query.message.message_id,
				});
			} finally {
				userState.approving = false;
				saveState();
			}
			break;
		case 'denyappeal':
			{
				if (!(await database.isUserAppealing(rid))) {
					sendMessage(chatId, `${prefix}This user\'s appeal has already been reviewed`, {
						reply_to_message_id: query.message.message_id,
					});
					return;
				}

				userState.state = 'appeal_reason';
				userState.reasonId = rid;
				userState.channel = chatId;
				saveState();

				sendMessage(chatId, `${prefix}Please send the reason for denying this appeal. At least 3 characters`, {
					reply_to_message_id: query.message.message_id,
				});
			}
			break;
	}
});

bot.on('message', async (msg) => {
	if (!msg.from || !isStaff(msg.from.id) || !msg.text) {
		return;
	}

	const userState = staffStates[msg.from.id] || { state: 'none' };
	if (userState.state == 'none' || userState.channel != msg.chat.id) {
		return;
	}

	if (userState.state == 'appeal_reason' || userState.state == 'report_reason') {
		if (msg.text.length < 3) {
			sendMessage(msg.chat.id, `Your reason needs to be atleast 3 characters`, {
				reply_to_message_id: msg.message_id,
			});

			return;
		}

		staffStates[msg.from.id] = { state: 'none' };
		saveState();
	}

	switch (userState.state) {
		case 'appeal_reason':
			{
				const userId = parseInt(userState.reasonId || '0');

				database.setUserAppealing(userId, false).catch(console.error);

				sendMessage(userId, getText('appeal_denied').replace(/{reason}/g, msg.text));
				sendMessage(msg.chat.id, `@${msg.from.username} (${msg.from.id})\nSuccessfully denied this appeal`, {
					reply_to_message_id: msg.message_id,
				});
			}
			break;
		case 'report_reason':
			{
				const report = await reportsCollection.findOne({ id: userState.reasonId });
				if (!report || report.id != userState.reasonId) {
					console.error('Report not found');
					sendMessage(msg.chat.id, 'Report not found', {
						reply_to_message_id: msg.message_id,
						rate_limit: 500,
					});
					return;
				}

				await reportsCollection.deleteOne({ id: report.id });

				const usernames = (await getUsernames(report.reported)).usernames;
				sendMessage(
					report.reporter,
					getText('reporter_notify_denied')
						.replace(/{mention}/g, usernames.length > 0 ? '@' + usernames[0] : getMention(report.reported))
						.replace(/{reason}/g, msg.text)
				);

				sendMessage(msg.chat.id, `@${msg.from.username} (${msg.from.id})\nSuccessfully denied this report`, {
					reply_to_message_id: msg.message_id,
				});
			}
			break;
	}
});

export async function forwardReport(fromUser: number, reportingId: number, msgs: number[], summary: string, amount: number | undefined) {
	if (msgs.length == 0) {
		console.error('No messages to forward');
		return;
	}

	const report: UnapprovedReport = {
		id: Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15),
		amountUsd: amount,
		reporter: fromUser,
		summary,
		reported: reportingId,

		// to be set later
		channel: config.channels.privateReports,
		msg: 0,

		evidence: {
			chat: config.channels.privateProofDump,

			// set later too
			msgs: [],
		},
	};

	try {
		let resp = await client.forwardMessages(config.channels.privateProofDump, {
			fromPeer: reportingId,
			messages: msgs,
		});

		if (Array.isArray(resp[0])) {
			resp = resp[0];
		}

		for (const msg of resp) {
			if (!msg || !msg.id) {
				continue;
			}

			report.evidence.msgs.push(msg.id);
		}
	} catch (e) {
		console.error(e);
	}

	const usernames = (await getUsernames(reportingId)).usernames;
	const reporterUsernames = (await getUsernames(fromUser)).usernames;
	const msg = await sendMessage(
		config.channels.privateReports,
		getText('private_report')
			.replace(/{reporter}/g, reporterUsernames.length > 0 ? reporterUsernames.map((x) => '@' + x).join(', ') + ' (' + getMention(fromUser) + ')' : getMention(fromUser))
			.replace(/{reported}/g, getMention(reportingId))
			.replace(/{usernames}/g, usernames.length > 0 ? usernames.map((x) => '@' + x).join(', ') : 'None')
			.replace(/{summary}/g, summary)
			.replace(/{amount}/g, amount && amount > 0 ? '$' + amount.toFixed(2) : 'N/A')
			.replace(/{proofs}/g, report.evidence.msgs.map((x) => `<a href="https://t.me/c/${report.evidence.chat.toString().replace('-100', '')}/${x}">${x}</a>`).join(', ')),
		{
			reply_markup: {
				inline_keyboard: [
					[
						{ text: 'Approve', callback_data: 'staff_approvereport_' + report.id },
						{ text: 'Deny', callback_data: 'staff_denyreport_' + report.id },
					],
				],
			},
		}
	);
	if (!msg) {
		console.error('Failed to send report');
		return;
	}

	report.msg = msg.message_id;
	await reportsCollection.insertOne(report);
}

export async function forwardAppeal(fromUser: number, fromMsgs: number[]) {
	if (fromMsgs.length == 0) {
		console.error('No messages to forward');
		return;
	}

	// forward all messages
	const msgs: number[] = [];
	try {
		let resp = await client.forwardMessages(config.channels.privateProofDump, {
			fromPeer: fromUser,
			messages: fromMsgs,
		});

		if (Array.isArray(resp[0])) {
			resp = resp[0];
		}

		for (const msg of resp) {
			if (!msg || !msg.id) {
				continue;
			}

			msgs.push(msg.id);
		}
	} catch (e) {
		console.error(e);
	}

	const usernames = (await getUsernames(fromUser)).usernames;
	await sendMessage(
		config.channels.privateAppeals,
		getText('private_appeal')
			.replace(/{usernames}/g, usernames.length > 0 ? usernames.map((x) => '@' + x).join(', ') : 'None')
			.replace(/{mention}/g, getMention(fromUser))
			.replace(/{proofs}/g, msgs.map((x) => `<a href="https://t.me/c/${config.channels.privateProofDump.toString().replace('-100', '')}/${x}">${x}</a>`).join(', ')),
		{
			reply_markup: {
				inline_keyboard: [
					[
						{ text: 'Approve', callback_data: 'staff_approveappeal_' + fromUser },
						{ text: 'Deny', callback_data: 'staff_denyappeal_' + fromUser },
					],
				],
			},
		}
	);
}

function saveState() {
	fs.writeFileSync('./data/staffStates.json', JSON.stringify(staffStates, null, 4));
}
