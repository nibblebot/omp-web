import type { Component } from "solid-js";
import type { ChatItem } from "../../../../state";

/**
 * Guest prompt card (COL-02): the question a guest sent through the shared
 * room. The host's transcript shows it live and after reload, next to the
 * answer it produced.
 */
export const GuestPromptCard: Component<{ item: Extract<ChatItem, { kind: "guestPrompt" }> }> = (
	props,
) => (
	<div class="guest-prompt" aria-label={`Prompt from guest ${props.item.from}`}>
		<div class="guest-prompt-from">Guest · {props.item.from}</div>
		<div class="guest-prompt-text">{props.item.text}</div>
	</div>
);
