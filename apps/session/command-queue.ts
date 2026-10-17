/**
 * Slash commands the SDK rejects while a turn runs (for example `/add-dir`
 * during streaming). They wait here and run in order once the turn ends.
 * `paused` is set by Stop and cleared by Resume queue, so a stopped turn never
 * starts the next command on its own. `draining` keeps two drains from running
 * the queue concurrently.
 */
export interface QueuedCommandState {
	commands: string[];
	paused: boolean;
	draining: boolean;
}

export interface CommandQueueHost {
	isStreaming(): boolean;
	/** Run one command (echo it, then run). Resolves once it has started: a builtin finished or a model turn began. */
	run(text: string): Promise<void>;
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
		while (state.commands.length > 0 && !state.paused && !host.isStreaming()) {
			const text = state.commands.shift() as string;
			await host.run(text);
		}
	} finally {
		state.draining = false;
	}
}

/** Remove the queued command at `index` when its text still matches the chip. */
export function removeQueuedCommand(
	state: QueuedCommandState,
	index: number,
	text: string,
): boolean {
	if (state.commands[index] !== text) return false;
	state.commands.splice(index, 1);
	return true;
}
