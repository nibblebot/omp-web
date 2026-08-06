import type { ImageArg } from "./protocol";
import { addBashItem, call, pushCompaction, pushNotice, resolveBashItem, setState, state, type BashResultLike } from "./state";

export type InputMode = "enter" | "followup";

export type ParsedInput =
	| { kind: "bash"; command: string; dimmed: boolean }
	| { kind: "python"; code: string; dimmed: boolean }
	| { kind: "slash"; name: string; args: string }
	| { kind: "queue"; steering: boolean; text: string }
	| { kind: "text" };

/**
 * Prefix semantics: `!!` dimmed bang-shell, `!` bang-shell, `$$` excluded
 * python, `$` python, `/name args` slash, `-> msg` steer-queue shorthand,
 * `=> msg` follow-up-queue shorthand, else plain text.
 */
export function parseInput(text: string): ParsedInput {
	if (text.startsWith("!!")) return { kind: "bash", command: text.slice(2).trim(), dimmed: true };
	if (text.startsWith("!")) return { kind: "bash", command: text.slice(1).trim(), dimmed: false };
	if (text.startsWith("$$")) return { kind: "python", code: text.slice(2).trim(), dimmed: true };
	if (text.startsWith("$")) return { kind: "python", code: text.slice(1).trim(), dimmed: false };
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
 * `/rename <title>` renames instantly via setSessionName; bare `/rename` keeps
 * the prompt passthrough so the agent auto-titles (server-side builtin).
 */
export function renameDispatch(args: string): { method: "setSessionName"; title: string } | { method: "prompt"; text: string } {
	const title = args.trim();
	return title ? { method: "setSessionName", title } : { method: "prompt", text: "/rename" };
}

/** `/handoff [focus...]` — free-text focus joins into one optional instructions arg. */
export function handoffArgs(args: string): [string | undefined] {
	const focus = args.trim();
	return [focus || undefined];
}

/**
 * `/goal` — on 17.1.8 /goal is NOT intercepted by the server's ACP builtin
 * dispatch, so it must never reach the prompt passthrough. Subcommands route
 * to the goalRuntime relay rows; anything else (bare, unknown, or `set`
 * without an objective) opens the goal popover, which owns objective entry.
 */
export function goalDispatch(
	args: string,
):
	| { kind: "popover" }
	| { kind: "call"; method: "goalCreate" | "goalPause" | "goalResume" | "goalDrop"; args: unknown[] } {
	const [sub, ...rest] = args.trim().split(/\s+/);
	switch (sub) {
		case "set":
			if (rest.length === 0) return { kind: "popover" };
			return { kind: "call", method: "goalCreate", args: [rest.join(" ")] };
		case "pause":
			return { kind: "call", method: "goalPause", args: [] };
		case "resume":
			return { kind: "call", method: "goalResume", args: [] };
		case "drop":
			return { kind: "call", method: "goalDrop", args: [] };
		default:
			return { kind: "popover" };
	}
}

/**
 * `/plan` toggle — same reasoning as /goal: 17.1.8 does not ACP-intercept
 * /plan, so the toggle drives setPlanModeState directly. planFilePath is not
 * read by the server runtime (only the CLI/tool-views mention it), so the
 * toggle passes "".
 */
export function planDispatch(): { method: "setPlanModeState"; args: [{ enabled: boolean; planFilePath: string }] } {
	return { method: "setPlanModeState", args: [{ enabled: !state.planModeEnabled, planFilePath: "" }] };
}

/** Shared /plan toggle used by the LOCAL_COMMANDS entry and the status-bar badge. */
export function planToggle(): void {
	const d = planDispatch();
	void call(d.method, d.args).catch(showError);
}

/** `/drop` mirrors /new but the confirm warns the transcript is discarded. */
function confirmDropSession(): void {
	if (state.items.length > 0 && !window.confirm("Drop this session? The current session transcript is discarded.")) return;
	void call("newSession").catch(showError);
}

/** `/dump`: transcript downloads client-side; the LLM-request JSON downloads via /download. */
function dumpSession(): void {
	void (async () => {
		try {
			const [text, dumpPath] = await Promise.all([call("formatSessionAsText"), call("dumpLlmRequestToTmpDir")]);
			if (typeof text === "string" && text) {
				const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
				const a = document.createElement("a");
				a.href = url;
				a.download = "transcript.txt";
				a.click();
				URL.revokeObjectURL(url);
			} else {
				pushNotice("info", "Transcript is empty — nothing to download.");
			}
			if (typeof dumpPath === "string" && dumpPath) {
				pushNotice("info", "LLM request dump", `/download?path=${encodeURIComponent(dumpPath)}`);
			} else {
				pushNotice("info", "No LLM request dump available yet.");
			}
		} catch (err) {
			showError(err);
		}
	})();
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
	retry: () =>
		void call("retry")
			.then(ok => {
				if (ok === false) pushNotice("error", "Nothing to retry — no failed turn or the session is busy.");
			})
			.catch(showError),
	fork: () =>
		void call("fork")
			.then(ok => {
				// HISTORY_RELOAD resync replaces the transcript; this is just the outcome.
				if (ok === false) pushNotice("error", "Fork failed.");
				else pushNotice("info", "Forked session.");
			})
			.catch(showError),
	fresh: () =>
		void call("freshSession")
			.then(() => pushNotice("info", "Fresh session — provider state reset, transcript kept."))
			.catch(showError),
	handoff: args =>
		void call("handoff", handoffArgs(args))
			.then(result => {
				const r = result as { document?: string; savedPath?: string } | null | undefined;
				// HISTORY_RELOAD resync brings in the new session's transcript.
				if (r?.document) {
					pushCompaction({ action: "handoff", summary: r.document, skipped: false, aborted: false, willRetry: false });
				} else {
					pushNotice("info", "Handoff complete — new session started.");
				}
				if (r?.savedPath) pushNotice("info", "Handoff document", `/download?path=${encodeURIComponent(r.savedPath)}`);
			})
			.catch(showError),
	drop: confirmDropSession,
	dump: dumpSession,
	rename: args => {
		const d = renameDispatch(args);
		void (d.method === "setSessionName" ? call("setSessionName", [d.title]) : call("prompt", [d.text])).catch(showError);
	},
	// Phase 9 (17.1.8): /goal and /plan are NOT ACP-intercepted, so they are
	// web-local — never prompt passthrough (see goalDispatch/planDispatch).
	goal: args => {
		const d = goalDispatch(args);
		if (d.kind === "popover") setState("modal", "goal");
		else void call(d.method, d.args).catch(showError);
	},
	plan: planToggle,
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
			// streamId routes bash_chunk frames to this item; dimmed = excluded
			// from the agent's context (server-side option).
			call("bash", [parsed.command, parsed.dimmed], 30_000, id)
				.then(result => resolveBashItem(id, result as BashResultLike))
				.catch(err => resolveBashItem(id, { error: String(err) }));
			return;
		}
		case "python": {
			if (!parsed.code) return;
			const id = addBashItem(parsed.code, parsed.dimmed, "python");
			call("python", [parsed.code, parsed.dimmed], 30_000, id)
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
