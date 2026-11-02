import {
	conversationPosition,
	continuesConversation,
} from "@oh-my-pi/pi-coding-agent/modes/utils/conversation-position";
import type { QueueCompactionArgs } from "#lib/wire/protocol";
import { type QueuedCommand, hasQueuedCompaction } from "./command-queue";
import type { SessionEntry } from "./session-entry";

/**
 * `/compact` sent with the follow-up key while a turn runs (SDK 18.14.1, queueable
 * compaction; interactive mode keeps this in `ctx.yieldCompaction`, which headless
 * sessions cannot reach). It waits in the entry's command queue, which already holds
 * a command until the turn ends, pauses on Stop, drops on a session change, and shows
 * as a removable chip. Follow-ups sent after it queue behind it (`hasQueuedCompaction`).
 */

/** The text the chip shows and a removal matches: the command as the user typed it, normalised. */
export function compactCommandText(args: QueueCompactionArgs): string {
	return ["/compact", args.mode, args.instructions?.trim()].filter(Boolean).join(" ");
}

/** Queue entry for a `/compact`, stamped with the conversation position it was sent in. */
export function queuedCompactionCommand(
	entry: Pick<SessionEntry, "session">,
	args: QueueCompactionArgs,
): QueuedCommand {
	const { mode, instructions } = args;
	return {
		text: compactCommandText(args),
		compaction: {
			...(mode ? { mode } : {}),
			...(instructions?.trim() ? { instructions } : {}),
			origin: conversationPosition(entry.session.sessionManager),
		},
	};
}

/** Whether the queued compaction still belongs to the live conversation (no switch or tree move since). */
export function compactionStillApplies(
	entry: Pick<SessionEntry, "session">,
	command: QueuedCommand,
): boolean {
	const origin = command.compaction?.origin;
	return origin === undefined || continuesConversation(entry.session.sessionManager, origin);
}

/**
 * Whether a follow-up sent now queues behind the command queue instead of joining the session's:
 * while a compaction waits, and while one that came from the queue runs. Interactive mode holds
 * them in its compaction queue the same way; they run after the compaction, in order.
 */
export function holdsFollowUps(entry: Pick<SessionEntry, "session" | "queuedCommands">): boolean {
	const queue = entry.queuedCommands;
	return hasQueuedCompaction(queue) || (queue.draining && entry.session.isCompacting);
}

const YIELD_POLL_MS = 25;

/**
 * Resolve once the run the compaction waited behind has yielded: nothing streams, retries,
 * switches, is being admitted, is queued for the agent, or can still wake it (a background
 * job's result), the point where interactive mode fires it. Returns early, leaving the
 * judgement to the drain, when Stop pauses the queue or the command leaves the head.
 */
export async function awaitYield(
	entry: Pick<SessionEntry, "session" | "queuedCommands">,
	command: QueuedCommand,
): Promise<void> {
	const { session, queuedCommands: queue } = entry;
	while (!queue.paused && queue.commands[0] === command) {
		await session.waitForIdle();
		if (session.isSessionTransitioning) await session.waitForSessionTransition();
		if (
			!session.isStreaming &&
			!session.isRetrying &&
			!session.isSessionTransitioning &&
			!session.hasAdmittedSubmission &&
			!session.hasPendingAsyncWork() &&
			session.queuedMessageCount === 0
		)
			return;
		await Bun.sleep(YIELD_POLL_MS);
	}
}
