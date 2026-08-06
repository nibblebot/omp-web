import type { ImageArg } from "./protocol";
import { addBashItem, call, pushCompaction, pushNotice, resolveBashItem, setState, state, type BashResultLike } from "./state";

export type InputMode = "enter" | "followup";

export type ParsedInput =
	| { kind: "bash"; command: string; dimmed: boolean }
	| { kind: "slash"; name: string; args: string }
	| { kind: "queue"; steering: boolean; text: string }
	| { kind: "text" };

/**
 * Prefix semantics: `!!` dimmed bang-shell, `!` bang-shell, `/name args` slash,
 * `-> msg` steer-queue shorthand, `=> msg` follow-up-queue shorthand, else plain text.
 */
export function parseInput(text: string): ParsedInput {
	if (text.startsWith("!!")) return { kind: "bash", command: text.slice(2).trim(), dimmed: true };
	if (text.startsWith("!")) return { kind: "bash", command: text.slice(1).trim(), dimmed: false };
	if (text.startsWith("-> ")) return { kind: "queue", steering: true, text: text.slice(3) };
	if (text.startsWith("=> ")) return { kind: "queue", steering: false, text: text.slice(3) };
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
 * New session: `/new` and the header button share this. Confirmation only
 * when the transcript is non-empty.
 */
function confirmNewSession(): void {
	if (state.items.length > 0 && !window.confirm("Start a new session? The current transcript is replaced.")) return;
	void call("newSession").catch(showError);
}

function exportSession(): void {
	void call("exportHtml")
		.then(result => {
			const path = (result as { path?: string } | null)?.path;
			if (path) pushNotice("info", "Exported session HTML", `/download?path=${encodeURIComponent(path)}`);
			else pushNotice("info", "Exported session HTML");
		})
		.catch(showError);
}

/**
 * Web-local slash commands: TUI-only commands that have session-method
 * equivalents (or web-native displays). Anything not in this table is sent to the agent
 * verbatim — server-side interception runs builtins/skills/extensions.
 */
export const LOCAL_COMMANDS: Record<string, (args: string) => void> = {
	new: confirmNewSession,
	clear: confirmNewSession,
	resume: () => setState("modal", "sessions"),
	tree: () => setState("modal", "branch"),
	branch: () => setState("modal", "branch"),
	export: exportSession,
	queue: args => {
		const msg = args.trim();
		if (!msg) return;
		void call("followUp", [msg]).catch(showError);
	},
	compact: args =>
		void call("compact", args ? [args] : [])
			.then(result => {
				const r = result as { summary?: string; tokensBefore?: number } | null;
				pushCompaction({
					action: "manual",
					summary: r?.summary,
					tokensBefore: r?.tokensBefore,
					skipped: false,
					aborted: false,
					willRetry: false,
				});
			})
			.catch(showError),
	model: () => setState("modal", "model"),
	usage: () => setState("modal", "stats"),
	context: () => setState("modal", "stats"),
	tools: () => setState("modal", "stats"),
	help: () => setState("modal", "help"),
	hotkeys: () => setState("modal", "help"),
	exit: () => pushNotice("info", "Session persists — close this browser tab to exit."),
	quit: () => pushNotice("info", "Session persists — close this browser tab to exit."),
};

/**
 * Queue-shorthand method selection: `->` steer-queues while streaming but
 * falls back to prompt when idle (steer errors on an idle session);
 * `=>` follow-up queues regardless of streaming state.
 */
export function queueMethod(steering: boolean, streaming: boolean): "prompt" | "steer" | "followUp" {
	return steering ? (streaming ? "steer" : "prompt") : "followUp";
}

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
			// command_output frames are unreachable over the WebSocket protocol (documented tradeoff).
			void call("prompt", [trimmed]).catch(showError);
			return;
		}
		case "queue": {
			const body = parsed.text.trim();
			if (!body && (!images || images.length === 0)) return;
			// `->` forces steer-queue: steer errors on an idle session, so it
			// falls back to prompt. `=>` forces follow-up queue in both states.
			const method = queueMethod(parsed.steering, state.streaming);
			void call(method, [body, images && images.length > 0 ? images : undefined]).catch(showError);
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
