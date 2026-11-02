import { toolReplies } from "#lib/wire/tool-live";
import { isRecord } from "#lib/wire/type-guards";
import type { ToolItem } from "../state";

/**
 * Replies: text the model sends to the user through `out://`, drawn as assistant prose
 * instead of tool output (pi-tui `chat/reply-write.ts`). A bash or eval call's commands
 * write there and the call's `details.replies` list the text, oldest first; a `write` to
 * an `out://` URL is a reply of its own. Pure, so the rules test without a DOM.
 */

const REPLY_URL = /^out:\/\//i;
const NO_REPLIES: readonly string[] = [];

/** The `out://` replies of a bash or eval call: the running call's live list, else the settled result's. */
export function repliesOf(item: ToolItem): readonly string[] {
	if (item.name !== "bash" && item.name !== "eval") return NO_REPLIES;
	if (item.status === "running") return item.replies ?? NO_REPLIES;
	return toolReplies(item.details) ?? item.replies ?? NO_REPLIES;
}

/** Whether a call is a `write` to an `out://` URL, which draws as a reply instead of a Write card. */
export function isReplyWrite(item: ToolItem): boolean {
	if (item.name !== "write" || !isRecord(item.args)) return false;
	const target = item.args.path ?? item.args.file_path;
	return typeof target === "string" && REPLY_URL.test(target);
}

/** The text of a reply write: the call's `content`, empty until the args carry it. */
export function replyWriteText(item: ToolItem): string {
	return isRecord(item.args) && typeof item.args.content === "string" ? item.args.content : "";
}
