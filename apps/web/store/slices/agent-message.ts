// Pure slice for messages other agents send this session over IRC. Holds the
// transcript item type and the message parser that core event handlers and the
// history builder call, so state.ts and chat.ts never import the card.

/** `customType` of an IRC message delivered into this session (SDK `IrcBridge.deliver`). */
export const IRC_INCOMING_TYPE = "irc:incoming";

/** A message another agent (a subagent, a peer, the parent) sent this session. */
export type AgentMessageItem = {
	kind: "agentMessage";
	id: number;
	/**
	 * One delivery: the IRC message id, else sender and timestamp. The live
	 * delivery event and the transcript entry of the same message share it, so
	 * the message gets one card.
	 */
	key: string;
	/** The sending agent's id (`details.from`). */
	from: string;
	/** The message body as the sender wrote it (`details.message`), not the model-facing envelope. */
	text: string;
};

/**
 * The card fields of an agent's message (`role: "custom"`, `customType:
 * "irc:incoming"`, `details { id, from, message }`), or null for any other
 * message. Only `display` messages render: a parent's steer to a streaming
 * subagent is delivered hidden.
 */
export function agentMessageOf(message: unknown): Omit<AgentMessageItem, "kind" | "id"> | null {
	const m = message as {
		role?: unknown;
		customType?: unknown;
		display?: unknown;
		timestamp?: unknown;
		details?: { id?: unknown; from?: unknown; message?: unknown };
	};
	if (m?.role !== "custom" || m.customType !== IRC_INCOMING_TYPE || !m.display) return null;
	const details = m.details;
	const from = typeof details?.from === "string" && details.from !== "" ? details.from : "agent";
	const text = typeof details?.message === "string" ? details.message : "";
	const key =
		typeof details?.id === "string" && details.id !== ""
			? details.id
			: `${from}@${typeof m.timestamp === "number" ? m.timestamp : ""}`;
	return { key, from, text };
}
