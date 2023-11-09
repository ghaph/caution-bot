import { ChatType } from 'node-telegram-bot-api';

export type UserData = {
	id: string;

	// access hash
	hash?: string;

	// the public name on their telegram account
	name?: string;

	// can sometimes not exist, even if they have a username
	username?: string;

	// whether or not the user is on the DWC, independent from the reports list
	dwc?: boolean;

	// only used for staff hidden dwc command. if they get un-dwced this wont be removed. this should not be used anywhere in code
	dwcReason?: string;

	// whether theyre banned from using the bot or not. this is the reason why theyre banned
	banned?: string;

	// reports is a list of all the approved reports the user has against them
	// this is independent from dwc, which is a boolean that determines if the user is on the DWC. They can be listed as DWC without any reports
	reports?: ApprovedReport[];

	lastReport?: number;
	lastAppeal?: number;

	// if they have an appeal open
	appealing?: boolean;

	// the message in the main channel
	dwcMsg?: {
		chat: number;
		id: number;
	};

	// commands state
	commands?: {
		state: CommandState;

		amount?: number;

		reportSummary?: string;

		// for appeals and reports, list of message ids to forward
		msgs?: number[];

		// for reports
		// the id of the user theyre reporting
		reportingId?: number;
	};
};

export type AppealState = {
	status: 'pending' | 'approved' | 'denied';
	reason?: string;
};

export type ApprovedReport = {
	// the topic group which contains the proof to this report
	proof: {
		// the group id which contains the proof
		chat: number;

		// the topic id which contains the proof
		id: number;
	};

	summary: string;
	amountUsd: number | undefined;

	// the user id of the person who reported them
	reporter: number;
};

export type UnapprovedReport = {
	id: string;

	// the user who is reported
	reported: number;

	summary: string;
	amountUsd: number | undefined;

	// the user id of the person who reported them
	reporter: number;

	// the channel and msg id that this report was posted in
	channel: number;
	msg: number;

	// the forwarded messages
	evidence: {
		chat: number;
		msgs: number[];
	};
};

export type CommandState =
	| 'none'

	// reporting flow
	| 'report_getuser'

	// if theyre already listed itll ask them if they want to continue
	| 'report_continue_already_listed'
	| 'report_getsummary'
	| 'report_getamount'
	| 'report_awaitingproof'

	// appealing flow
	| 'appeal_awaitingproof';

export type PublicChat = {
	id: string;
	type: ChatType;

	// wherther chat is private or deleted
	priv?: boolean;

	// the last time an ad was posted in this chat
	ad?: number;

	// the last time the chat members were scraped (Date.now())
	scrape?: number;

	// whether the admins have disabled ads or not
	noAds?: boolean;

	// list of user ids
	users: number[];

	// the list of user ids that were banned by the bot
	banned: number[];
};
