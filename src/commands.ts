import type { ImageArg } from "./protocol";
import { addBashItem, call, pushNotice, resolveBashItem, setState, state, type BashResultLike } from "./state";

export type InputMode = "enter" | "followup";

export type ParsedInput =
	| { kind: "bash"; command: string; dimmed: boolean }
	| { kind: "slash"; name: string; args: string }
	| { kind: "text" };

/** Prefix semantics: `!!` dimmed bang-shell, `!` bang-shell, `/name args` slash, else plain text. */
export function parseInput(text: string): ParsedInput {
	if (text.startsWith("!!")) return { kind: "bash", command: text.slice(2).trim(), dimmed: true };
	if (text.startsWith("!")) return { kind: "bash", command: text.slice(1).trim(), dimmed: false };
	if (text.startsWith("/")) {
		const m = /^\/(\S+)(?:\s+(.*))?$/s.exec(text);
		if (m) return { kind: "slash", name: m[1].toLowerCase(), args: m[2] ?? "" };
	}
	return { kind: "text" };
}

function showError(err: unknown): void {
	setState("error", String(err));
}

/**
 * Web-local slash commands: TUI-only commands that have RPC equivalents (or
 * web-native displays). Anything not in this table is sent to the agent
 * verbatim — server-side interception runs builtins/skills/extensions.
 */
export const LOCAL_COMMANDS: Record<string, (args: string) => void> = {
	new: () => void call("newSession").catch(showError),
	clear: () => void call("newSession").catch(showError),
	compact: args => void call("compact", args ? [args] : []).catch(showError),
	help: () => setState("modal", "help"),
	hotkeys: () => setState("modal", "help"),
	exit: () => pushNotice("info", "Session persists — close this browser tab to exit."),
	quit: () => pushNotice("info", "Session persists — close this browser tab to exit."),
};

export function dispatchInput(text: string, images: ImageArg[] | undefined, mode: InputMode): void {
	const trimmed = text.trim();
	const parsed = parseInput(trimmed);
	switch (parsed.kind) {
		case "bash": {
			if (!parsed.command) return;
			const id = addBashItem(parsed.command, parsed.dimmed);
			call("bash", [parsed.command])
				.then(result => resolveBashItem(id, result as BashResultLike))
				.catch(err => resolveBashItem(id, { error: String(err) }));
			return;
		}
		case "slash": {
			const handler = LOCAL_COMMANDS[parsed.name];
			if (handler) {
				handler(parsed.args);
				return;
			}
			// Agent-side builtin/skill/extension/file commands handle it. Their
			// command_output frames are unreachable over RPC (documented tradeoff).
			void call("prompt", [trimmed]).catch(showError);
			return;
		}
		case "text": {
			if (!trimmed && (!images || images.length === 0)) return;
			// steer on an idle session errors server-side; Enter falls back to prompt.
			const method = mode === "followup" ? "followUp" : state.streaming ? "steer" : "prompt";
			void call(method, [trimmed, images && images.length > 0 ? images : undefined]).catch(showError);
		}
	}
}
