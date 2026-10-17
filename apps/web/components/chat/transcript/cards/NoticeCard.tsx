import type { Component } from "solid-js";
import type { ChatItem } from "../../../../state";

/** One-line notice card. */
export const NoticeCard: Component<{ item: Extract<ChatItem, { kind: "notice" }> }> = (props) => {
	return (
		<div class="msg-notice" classList={{ "msg-notice-echo": props.item.level === "echo" }}>
			{props.item.message}
		</div>
	);
};
