/**
 * Which web events raise a desktop notification. The SDK settings decide per
 * event, mirroring the TUI consumers: `completion.notify` and `error.notify`
 * (modes/controllers/event-controller.ts sendCompletionNotification /
 * sendErrorNotification) and `ask.notify` (tools/ask.ts #sendAskNotification).
 * The client-local `omp.notifyEnabled` toggle is only the browser-permission
 * grant: it gates delivery in chat.ts `notifyDesktop`, never the event choice.
 */

export type NotifyKind = "completion" | "error" | "ask";

/** Settings path that decides whether an event kind notifies. */
export const NOTIFY_SETTING_PATH: Record<NotifyKind, string> = {
	completion: "completion.notify",
	error: "error.notify",
	ask: "ask.notify",
};

/** SDK defaults (modes/settings.ts), used until the settings model has loaded. */
const NOTIFY_DEFAULT: Record<NotifyKind, "on" | "off"> = {
	completion: "on",
	error: "off",
	ask: "on",
};

/** Whether the effective SDK value for `kind` lets the event notify; anything unrecognised falls back to the SDK default. */
export function notifyKindEnabled(kind: NotifyKind, value: unknown): boolean {
	const effective = value === "on" || value === "off" ? value : NOTIFY_DEFAULT[kind];
	return effective === "on";
}

type AssistantLike = { role?: string; stopReason?: string; errorMessage?: string };

function lastAssistant(messages: readonly unknown[]): AssistantLike | undefined {
	return messages.findLast(
		(m): m is AssistantLike => (m as AssistantLike | null)?.role === "assistant",
	);
}

/**
 * A settled turn counts as complete unless its last assistant message stopped
 * in error or abort, matching sendCompletionNotification (those turns are
 * covered by the error notification, or by nothing when aborted).
 */
export function turnCompleted(messages: readonly unknown[] = []): boolean {
	const stop = lastAssistant(messages)?.stopReason;
	return stop !== "aborted" && stop !== "error";
}

/**
 * Desktop error text for a settled turn, or undefined when
 * sendErrorNotification stays silent: a non-terminal agent_end, a retry still
 * pending, or a last assistant message that did not stop in error. The text is
 * that message's errorMessage.
 */
export function turnFailure(
	messages: readonly unknown[] = [],
	{ terminal = true, retryPending = false }: { terminal?: boolean; retryPending?: boolean } = {},
): string | undefined {
	if (!terminal || retryPending) return undefined;
	const last = lastAssistant(messages);
	if (last?.stopReason !== "error") return undefined;
	return last.errorMessage ?? "";
}
