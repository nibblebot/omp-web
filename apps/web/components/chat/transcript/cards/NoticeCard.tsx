import { Show, type Component } from "solid-js";
import type { ChatItem } from "../../../../state";

/** A notice longer than either limit collapses behind a disclosure (CMD-09). */
const COLLAPSE_LINES = 6;
const COLLAPSE_CHARS = 400;

/**
 * Notice card. A forwarded command's echo row carries its name; its reply renders
 * attached under that echo (`msg-notice-reply`) without repeating the name. A long
 * reply collapses to its first line behind a disclosure.
 */
export const NoticeCard: Component<{ item: Extract<ChatItem, { kind: "notice" }> }> = (props) => {
	return (
		<div
			class="msg-notice"
			classList={{
				"msg-notice-echo": props.item.level === "echo",
				"msg-notice-reply": props.item.command !== undefined,
			}}
		>
			<Show
				when={
					props.item.message.length > COLLAPSE_CHARS ||
					props.item.message.split("\n").length > COLLAPSE_LINES
				}
				fallback={props.item.message}
			>
				<details class="msg-notice-long">
					<summary>{(props.item.message.split("\n")[0] ?? "").slice(0, 80)}…</summary>
					<div class="msg-notice-body">{props.item.message}</div>
				</details>
			</Show>
		</div>
	);
};
