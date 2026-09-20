import type { Component } from "solid-js";
import type { ChatItem } from "../../../state";

/** One-line notice card. */
export const NoticeCard: Component<{ item: Extract<ChatItem, { kind: "notice" }> }> = (props) => {
	return <div class="msg-notice">{props.item.message}</div>;
};
