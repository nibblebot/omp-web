import type { ImageContent } from "@oh-my-pi/pi-ai";

/** A slash command waiting to run, with the images it was sent with (jx0b). */
export interface QueuedCommand {
	text: string;
	images?: ImageContent[];
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
	/** Run one command (echo it, then run). Resolves once it has started: a builtin finished or a model turn began. */
	run(command: QueuedCommand): Promise<void>;
}

/**
 * Run queued commands in order while the session is idle and not paused. A
 * command that starts a model turn ends the loop; the turn's `agent_end`
 * drains the rest. Re-entrant calls while a drain is in progress return
 * immediately.
 */
export async function drainQueuedCommands(
	state: QueuedCommandState,
	host: CommandQueueHost,
): Promise<void> {
	if (state.draining) return;
	state.draining = true;
	try {
		while (!state.paused && !host.isStreaming()) {
			const command = state.commands.shift();
			if (!command) return;
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
