import type { CollabWireStatus } from "#lib/wire/protocol";

/** Collab host status pushed by the daemon as `collab_status` frames. */
export type CollabStatus = CollabWireStatus;

/** Before the daemon reports anything, the session is not shared. */
export const COLLAB_OFF: CollabStatus = { state: "off" };

/** `customType` of guest prompts the collab host injects (pi-wire COLLAB_PROMPT_MESSAGE_TYPE). */
export const COLLAB_PROMPT_TYPE = "collab-prompt";

/** A guest prompt as the transcript shows it. */
export interface GuestPrompt {
	from: string;
	text: string;
}

/** True while this session is shared (guests can join the room). */
export function collabLive(status: CollabStatus): boolean {
	return status.state === "live";
}

/**
 * A guest's prompt (`custom_message`, customType "collab-prompt", details.from),
 * or null for any other message. Mirrors the advisor branch: only display
 * messages render. Image blocks are dropped; the text is what the card shows.
 */
export function guestPromptOf(message: unknown): GuestPrompt | null {
	const m = message as {
		role?: unknown;
		customType?: unknown;
		display?: unknown;
		content?: unknown;
		details?: { from?: unknown };
	};
	if (m?.role !== "custom" || m.customType !== COLLAB_PROMPT_TYPE || !m.display) return null;
	const from =
		typeof m.details?.from === "string" && m.details.from !== "" ? m.details.from : "guest";
	const text =
		typeof m.content === "string"
			? m.content
			: Array.isArray(m.content)
				? m.content
						.filter((c: { type?: unknown }) => c?.type === "text")
						.map((c: { text?: unknown }) => (typeof c.text === "string" ? c.text : ""))
						.join("\n")
				: "";
	return { from, text };
}
