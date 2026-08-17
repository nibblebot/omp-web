import type { Component } from "solid-js";
import type { ChatItem } from "../../../state";

/** One-line notice card; messages with a href render as external links. */
export const NoticeCard: Component<{ item: Extract<ChatItem, { kind: "notice" }> }> = (props) => {
	const notice = () => props.item;
	return (
		<div class="msg-notice">
			{notice().href ? (
				<a href={notice().href} target="_blank" rel="noreferrer">
					{notice().message}
				</a>
			) : (
				notice().message
			)}
		</div>
	);
};
