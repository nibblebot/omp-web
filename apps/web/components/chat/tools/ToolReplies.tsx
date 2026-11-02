import { createMemo, Index, Show, type Component } from "solid-js";
import { repliesOf, replyWriteText } from "../../../chat/tool-replies";
import type { ToolItem } from "../../../state";
import { Markdown } from "../../ui/Markdown";

/**
 * The `out://` replies of a bash or eval call, as assistant prose right after its card
 * (the TUI draws each as a reply block after the call). Live as replies arrive and settled
 * on a reload; draws nothing for a call without replies. Each reply is its own block, kept
 * in place as the list grows.
 */
export const ToolReplies: Component<{ item: ToolItem }> = (props) => {
	const replies = createMemo(() => repliesOf(props.item));
	return (
		<Show when={replies().length > 0}>
			<div class="msg-assistant tool-reply">
				<Index each={replies()}>{(reply) => <Markdown src={reply()} />}</Index>
			</div>
		</Show>
	);
};

/**
 * A `write` to an `out://` URL: the content is a message to the user, so it draws as
 * assistant prose, not a Write card. A failed write shows its error under the text.
 */
export const ReplyWrite: Component<{ item: ToolItem }> = (props) => {
	const text = createMemo(() => replyWriteText(props.item));
	return (
		<Show when={text().trim() !== "" || props.item.status === "error"}>
			<div class="msg-assistant tool-reply" data-tool-call-id={props.item.toolCallId}>
				<Show when={text().trim() !== ""}>
					<Markdown src={text()} />
				</Show>
				<Show when={props.item.status === "error"}>
					<div class="tool-reply-error" role="alert">
						{props.item.output || "The reply was not delivered."}
					</div>
				</Show>
			</div>
		</Show>
	);
};
