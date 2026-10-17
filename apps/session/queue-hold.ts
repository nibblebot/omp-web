import type { RestoredQueuedMessage } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { QueuedMessageKind, QueuedMessageRef } from "#lib/wire/protocol";
import type { QueuedCommandState } from "./command-queue";

/**
 * User messages a Stop withdrew from the live queues. They stay here, paused,
 * until the operator resumes the queue, runs one now, edits it, or deletes it.
 */
export interface HeldQueuedMessage {
	kind: QueuedMessageKind;
	message: RestoredQueuedMessage;
}

/** The slice of AgentSession the queue helpers drive. */
export interface QueueHost {
	clearQueue(options: { forInterrupt: boolean }): {
		steering: RestoredQueuedMessage[];
		followUp: RestoredQueuedMessage[];
	};
	takeQueuedMessage(
		text: string,
		queue: "steering" | "followUp",
	): RestoredQueuedMessage | undefined;
	steer(text: string, images?: RestoredQueuedMessage["images"]): Promise<void>;
	followUp(text: string, images?: RestoredQueuedMessage["images"]): Promise<void>;
}

/**
 * Withdraw every user-authored queued message, live steers included, into
 * `held` in resume order: steers first, then follow-ups. Call before aborting
 * so the aborted turn cannot auto-run a steer or follow-up.
 */
export function holdQueuedMessages(
	host: Pick<QueueHost, "clearQueue">,
	held: HeldQueuedMessage[],
): void {
	const { steering, followUp } = host.clearQueue({ forInterrupt: true });
	for (const message of steering) held.push({ kind: "steer", message });
	for (const message of followUp) held.push({ kind: "follow-up", message });
}

/**
 * Re-send held messages in order through the normal steer/follow-up path. A
 * failed send keeps the unsent tail held so nothing is silently dropped.
 */
export async function resumeHeldQueue(host: QueueHost, held: HeldQueuedMessage[]): Promise<void> {
	const items = held.splice(0);
	let index = 0;
	try {
		for (; index < items.length; index++) {
			const { kind, message } = items[index];
			if (kind === "steer") await host.steer(message.text, message.images);
			else await host.followUp(message.text, message.images);
		}
	} catch (err) {
		held.unshift(...items.slice(index));
		throw err;
	}
}

/**
 * Remove the chip a ref names and return its message. Paused refs must match
 * kind and text at the given index, so a stale index never removes a different
 * message. Live refs go through the SDK's text match on the matching queue.
 */
export function takeQueuedMessage(
	host: Pick<QueueHost, "takeQueuedMessage">,
	held: HeldQueuedMessage[],
	ref: QueuedMessageRef,
): RestoredQueuedMessage | undefined {
	if (ref.paused !== undefined) {
		const item = held[ref.paused];
		if (!item || item.kind !== ref.kind || item.message.text !== ref.text) return undefined;
		held.splice(ref.paused, 1);
		return item.message;
	}
	return host.takeQueuedMessage(ref.text, ref.kind === "steer" ? "steering" : "followUp");
}

/**
 * Forget everything a Stop held when the session's transcript is replaced (new,
 * switched, branched): held steers and slash commands belong to the old session
 * and must never resume into the new one. The command pause is also reset so
 * commands queued in the new session run normally.
 */
export function dropHeldQueue(entry: {
	pausedQueue: HeldQueuedMessage[];
	queuedCommands: QueuedCommandState;
}): void {
	entry.pausedQueue.length = 0;
	entry.queuedCommands.commands.length = 0;
	entry.queuedCommands.paused = false;
}
