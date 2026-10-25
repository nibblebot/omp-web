/**
 * Busy policy for forwarded slash commands (jx0b, CMD-08). The browser and the
 * session share it: a command runs while a turn streams only when it is known to
 * be read-only; a destructive command refuses; everything else queues, so a new
 * SDK builtin, extension, skill or file command is safe by default.
 */
import type { AvailableSlashCommand } from "./protocol";

/** Where a slash command comes from; `builtin` covers SDK builtins the browser forwards. */
export type SlashCommandSource = AvailableSlashCommand["source"] | "builtin";

/** `now` runs at once; `queue` waits as a command chip; `refuse` tells the user why. */
export type SlashBusyPolicy = "now" | "queue" | "refuse";

/** Forwarded builtins that only read state, so they run while a turn streams. */
export const RUN_WHEN_BUSY_BUILTINS: readonly string[] = ["changelog", "dirs", "jobs"];

export interface SlashBusyInput {
	/** Unknown origin counts as non-builtin, so it queues. */
	source?: SlashCommandSource;
	name: string;
	/** Arguments after the command name; `/session` branches on its verb. */
	args?: string;
}

/** Busy policy for one forwarded command. Only consulted while a turn streams. */
export function slashBusyPolicy({ source, name, args = "" }: SlashBusyInput): SlashBusyPolicy {
	if (source !== "builtin") return "queue";
	if (name === "session") {
		const verb = args.trim().toLowerCase();
		if (verb === "delete") return "refuse";
		return verb === "" || verb === "info" ? "now" : "queue";
	}
	return RUN_WHEN_BUSY_BUILTINS.includes(name) ? "now" : "queue";
}
