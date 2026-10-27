/**
 * Which web events raise a browser notification. Only sessions other than the
 * attached one notify (state.ts `session_activity`, delivered by roster.ts
 * `notifySession`). The SDK settings decide per event kind, mirroring the TUI
 * consumers: `completion.notify` and `error.notify`
 * (modes/controllers/event-controller.ts sendCompletionNotification /
 * sendErrorNotification) and `ask.notify` (tools/ask.ts #sendAskNotification).
 * The client-local `omp.notifyEnabled` toggle is only the browser-permission
 * grant: it gates delivery, never the event choice.
 */
import type { WireTurnOutcome } from "#lib/wire/protocol";
import { truncateHead } from "./chat";

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

/** Longest `errorMessage` excerpt carried in a notification body. */
const ERROR_BODY_MAX = 80;

/**
 * Notification kind and body for a detached session's settled turn: an
 * errored last assistant message notifies as `error` ("Stopped with error",
 * plus its errorMessage when non-empty), an aborted one as `completion`
 * ("Aborted"; the SDK has no abort setting), anything else, a missing
 * stopReason included, as `completion` ("Complete").
 */
export function outcomeNotice(outcome: WireTurnOutcome): { kind: NotifyKind; body: string } {
	if (outcome.stopReason === "error") {
		const message = outcome.errorMessage?.trim() ?? "";
		const body = message === "" ? "" : `: ${truncateHead(message, ERROR_BODY_MAX)}`;
		return { kind: "error", body: `Stopped with error${body}` };
	}
	if (outcome.stopReason === "aborted") return { kind: "completion", body: "Aborted" };
	return { kind: "completion", body: "Complete" };
}
