import TelegramBot, { ChatType, User } from 'node-telegram-bot-api';
import config from './config';
import { Api } from 'telegram';
import { UserData } from './database/types';

export function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getUsername(user: TelegramBot.User | Api.User): string | undefined {
	if (user instanceof Api.User) {
		return user.username || (user.usernames && user.usernames.length > 0 ? user.usernames[0].username : undefined);
	}

	// todo get nft usernames if needed
	return user.username;
}

export function getDisplayName(user: TelegramBot.User | Api.User): string {
	if (user instanceof Api.User) {
		return user.firstName + (user.lastName ? ' ' + user.lastName : '');
	}

	return user.first_name + (user.last_name ? ' ' + user.last_name : '');
}

export function getMentionFromData(user: UserData): string {
	return `<a href="tg://user?id=${user.id}">${user.username ? '@' + user.username : user.name}</a>`;
}

export function getMention(user: TelegramBot.User | Api.User | number): string {
	if (typeof user == 'number') {
		return `<a href="tg://user?id=${user}">${user}</a>`;
	}

	const username = getUsername(user);
	return `<a href="tg://user?id=${user.id}">${username ? '@' + username : getDisplayName(user)}</a>`;
}

export function isStaff(user: TelegramBot.User | UserData | number | string) {
	if (typeof user != 'string' && typeof user != 'number') {
		user = user.id;
	}

	if (typeof user == 'string') {
		user = parseInt(user);
	}

	return config.staff.includes(user);
}

export function isAllDigits(str: string) {
	return /^\d+$/.test(str);
}
