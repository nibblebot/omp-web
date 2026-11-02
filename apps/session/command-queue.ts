import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { ConversationPosition } from "@oh-my-pi/pi-coding-agent/modes/utils/conversation-position";

/**
 * A `/compact` queued with the follow-up key while a turn runs. `origin` is the
 * conversation position it was queued at: a session switch or tree move before
 * it fires means it no longer belongs to the live conversation, so it is dropped.
 */
export interface QueuedCompaction {
	mode?: string;
	instructions?: string;
	origin: ConversationPosition;
}

/** A slash command waiting to run, with the images it was sent with (jx0b). */
export interface QueuedCommand {
	text: string;
	images?: ImageContent[];
	/** Set for a queued `/compact`: it runs through the compaction adapter, not the slash-command path. */
	compaction?: QueuedCompaction;
}

/**
 * Slash commands the SDK rejects while a turn runs (for example `/add-dir`
 * during streaming). They wait here and run in order once the turn ends.
 * `paused` is set by Stop and cleared by Resume queue, so a stopped turn never
 * starts the next command on its own. `draining` keeps two drains from running
 * the queue concurrently.
 */
export interface QueuedCommandState {
	commands: QueuedCommand[];
	paused: boolean;
	draining: boolean;
}

export interface CommandQueueHost {
	isStreaming(): boolean;
	/**
	 * Resolves once `command` may run: the run it waited behind has yielded, or the queue changed
	 * under it (paused, or `command` no longer at the head). Only a queued compaction waits here;
	 * every other command runs as soon as the session is idle.
	 */
	settle?(command: QueuedCommand): Promise<void>;
	/** Run one command (echo it, then run). Resolves once it has started: a builtin finished or a model turn began. */
	run(command: QueuedCommand): Promise<void>;
}

/**
 * Run queued commands in order while the session is idle and not paused. A
 * command that starts a model turn ends the loop; the turn's `agent_end`
 * drains the rest. A queued compaction at the head holds the drain until the
 * run yields (`settle`). Re-entrant calls while a drain is in progress return
 * immediately.
 */
export async function drainQueuedCommands(
	state: QueuedCommandState,
	host: CommandQueueHost,
): Promise<void> {
	if (state.draining) return;
	state.draining = true;
	try {
		while (!state.paused) {
			const command = state.commands[0];
			if (!command) return;
			if (command.compaction && host.settle) {
				// A queued compaction waits for the running turn to yield instead of leaving the drain.
				await host.settle(command);
				// Paused, removed or replaced while it waited: judge the queue again.
				if (state.paused || state.commands[0] !== command) continue;
			}
			if (host.isStreaming()) return;
			state.commands.shift();
			await host.run(command);
		}
	} finally {
		state.draining = false;
	}
}

/**
 * Remove the queued command at `index` when its text still matches the chip,
 * and return it (with its images) so the caller can run it.
 */
export function removeQueuedCommand(
	state: QueuedCommandState,
	index: number,
	text: string,
): QueuedCommand | undefined {
	if (state.commands[index]?.text !== text) return undefined;
	return state.commands.splice(index, 1)[0];
}

/** Whether a queued `/compact` is waiting: follow-ups sent now go behind it, never ahead of it. */
export function hasQueuedCompaction(state: Pick<QueuedCommandState, "commands">): boolean {
	return state.commands.some((command) => command.compaction !== undefined);
}
