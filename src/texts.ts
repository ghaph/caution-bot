import fs from 'fs';

export function getText(t: TextType): string {
	return fs.readFileSync('./texts/' + t + '.txt', 'utf-8');
}

type TextType =
	// the text that is sent to a user which is blacklisted from using the bot
	| 'banned'
	| 'state_cancel'
	// the text that gets sent when a user is banned from a group
	| 'banned_from_group'
	// the public listing text in the main channel
	| 'public_listing'
	| 'report_getuser'
	| 'report_badusername'
	| 'report_getsummary'
	| 'report_getamount'
	| 'report_sendproof'
	| 'report_cooldown'
	// if the user being reported is already listed this message is sent to confirm
	| 'report_already_listed'
	// the report was successfully sent to the staff
	| 'report_success'
	// the notification they get when their report is approved
	| 'reporter_notify_approved'
	// the notification they get when their report is denied
	| 'reporter_notify_denied'
	| 'appeal_cannot'
	| 'appeal_denied'
	| 'appeal_sendproof'
	| 'appeal_notdwc'
	| 'appeal_success'

	// used for both /report and /appeal. when theyre trying to use /send before uploading proof it saids this
	| 'send_nomsgs'

	// the report message thats sent in the private group
	| 'private_report'

	// the appeal message thats sent in the private group
	| 'private_appeal'

	// advertisements
	| 'advertisement'
	| 'ads_enabled'
	| 'ads_disabled';
