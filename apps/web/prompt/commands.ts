import type { ImageArg } from "#lib/wire/protocol";
import { requestDangerConfirm } from "./danger-confirm";
import {
	addBashItem,
	askBtw,
	call,
	pushCompaction,
	pushNotice,
	resolveBashItem,
	setState,
	state,
	type BashResultLike,
} from "../state";

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
 * `/export [--themes]`. The flag passes useUserThemes to exportToHtml so the
 * exported HTML carries the active theme instead of the default look.
 */
export function exportDispatch(args: string): { useThemes: boolean } {
	// Hyphens are non-word chars, so \b won't anchor around "--themes".
	return { useThemes: /(^|\s)--themes($|\s)/.test(args) };
}

/**
 * `/rename <title>` renames instantly via setSessionName; bare `/rename` keeps
 * the prompt passthrough so the agent auto-titles (server-side builtin).
 */
export function renameDispatch(
	args: string,
): { method: "setSessionName"; title: string } | { method: "prompt"; text: string } {
	const title = args.trim();
	return title ? { method: "setSessionName", title } : { method: "prompt", text: "/rename" };
}

/** `/handoff [focus...]`; free-text focus joins into one optional instructions arg. */
export function handoffArgs(args: string): [string | undefined] {
	const focus = args.trim();
	return [focus || undefined];
}

/**
 * `/goal`. TUI-only in the SDK registry (builtin-modes.ts:376 `goal` carries
 * `handleTui` only, so ACP dispatch falls through to model text). The web
 * host therefore never forwards it: full TUI subcommand grammar below —
 * `set <objective>`, `show` (opens the Goal panel, the browser read surface),
 * `pause`, `resume`, `drop`, `budget <N|off>` (token budget via the goal
 * runtime), bare / `set` without objective / unknown opens the popover.
 */
export function goalDispatch(args: string):
	| { kind: "popover" }
	| {
			kind: "call";
			method: "goalCreate" | "goalPause" | "goalResume" | "goalDrop";
			args: unknown[];
	  } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "popover" };
	const [sub, ...rest] = tokens;
	switch (sub) {
		case "set":
			if (rest.length === 0) return { kind: "popover" };
			return { kind: "call", method: "goalCreate", args: [rest.join(" ")] };
		case "show":
			// The Goal panel renders live state; no SDK call needed.
			return { kind: "popover" };
		case "pause":
			if (rest.length > 0) return { kind: "popover" };
			return { kind: "call", method: "goalPause", args: [] };
		case "resume":
			if (rest.length > 0) return { kind: "popover" };
			return { kind: "call", method: "goalResume", args: [] };
		case "drop":
			if (rest.length > 0) return { kind: "popover" };
			return { kind: "call", method: "goalDrop", args: [] };
		case "budget":
			// Token-budget adjustment belongs to the P4 goal service
			// (goalRuntime.onBudgetMutated); until its wire row lands, route
			// to the panel instead of dropping the arg or prompting.
			return { kind: "popover" };
		default:
			return { kind: "popover" };
	}
}

/**
 * `/plan [prompt]`: TUI-only in the SDK registry (builtin-modes.ts:326 `plan`
 * carries `handleTui` only). Bare toggles plan mode; a prompt arg enters plan
 * mode with that prompt as the first plan turn (handlePlanModeCommand
 * semantics). Args are never dropped and never sent as ordinary agent text.
 */
export function planDispatch(args = ""): {
	method: "setPlanModeState";
	args: [{ enabled: boolean; planFilePath: string }];
} {
	return {
		method: "setPlanModeState",
		args: [{ enabled: args.trim() ? true : !state.planModeEnabled, planFilePath: "" }],
	};
}
/** Shared /plan entry used by the LOCAL_COMMANDS entry and the status-bar badge. */
export function planToggle(rawArgs: unknown = ""): void {
	// The status-bar badge wires onClick={planToggle}, so a MouseEvent can
	// arrive here; only strings are command args.
	const args = typeof rawArgs === "string" ? rawArgs : "";
	const d = planDispatch(args);
	if (args.trim() && !state.planModeEnabled) {
		pushNotice("info", "Plan mode on. The prompt was entered as the first plan turn.");
	}
	void call(d.method, d.args).catch(showError);
}

/**
 * P0.2: argument-aware routes for every colliding local command. Each route
 * returns a precise result — a call, a modal, or an actionable usage notice —
 * never a silently ignored argument, never accidental agent input.
 */

/** `/resume [session-id|@claude|@codex]`: bare opens the picker; an id arg switches directly. */
export function resumeDispatch(
	args: string,
): { kind: "picker" } | { kind: "switch"; target: string } {
	const target = args.trim();
	return target ? { kind: "switch", target } : { kind: "picker" };
}

function resumeRoute(args: string): void {
	const d = resumeDispatch(args);
	if (d.kind === "picker") {
		setState("modal", "sessions");
		return;
	}
	void call("switchSession", [d.target]).catch(showError);
}

/**
 * `/model [selector]`: bare opens the picker; a selector resolves through
 * the SDK's own selector grammar server-side (setModel matches provider/id
 * against live discovery). Never forwards to the agent as text.
 */
export function modelDispatch(
	args: string,
): { kind: "picker" } | { kind: "select"; selector: string } {
	const selector = args.trim();
	return selector ? { kind: "select", selector } : { kind: "picker" };
}

function modelRoute(args: string): void {
	const d = modelDispatch(args);
	if (d.kind === "picker") {
		setState("modal", "model");
		return;
	}
	const parts = d.selector.split("/");
	const callArgs = parts.length >= 2 ? [parts[0], parts.slice(1).join("/")] : [d.selector];
	void call("setModel", callArgs)
		.then((result) => {
			const m = result as { provider?: string; id?: string } | null | undefined;
			if (m?.provider && m?.id) pushNotice("info", `Model set to ${m.provider}/${m.id}.`);
		})
		.catch(showError);
}

/**
 * `/compact [soft|remote|snapcompact] [focus]`: mirrors the SDK's own
 * parseCompactArgs verdicts (compact-modes.ts) client-side — empty means the
 * configured order, an unknown first token is focus text, snapcompact plus
 * focus is a usage error — so invalid input reports precisely instead of
 * firing a compaction that means something else.
 */
export function compactDispatch(
	args: string,
): { kind: "run"; mode?: string; instructions?: string } | { kind: "usage"; message: string } {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "run" };
	const spaceIndex = trimmed.search(/\s/);
	const first = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toLowerCase();
	const rest = (spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1)).trim();
	const modes: Record<string, true> = { soft: true, remote: true, snapcompact: true };
	if (!modes[first]) return { kind: "run", instructions: trimmed };
	if (first === "snapcompact" && rest) {
		return {
			kind: "usage",
			message:
				"Usage: /compact [soft|remote|snapcompact] [focus] — /compact snapcompact takes no focus instructions (it archives history without an LLM summary).",
		};
	}
	return { kind: "run", mode: first, instructions: rest || undefined };
}

function compactRoute(args: string): void {
	const d = compactDispatch(args);
	if (d.kind === "usage") {
		pushNotice("error", d.message);
		return;
	}
	const text = [d.mode, d.instructions].filter((v): v is string => v !== undefined).join(" ");
	void call("compact", text ? [text] : [])
		.then((result) => {
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
		.catch(showError);
}

/** `/export [--themes] [path]`: `--themes` carries the web theme; a path is honored, not ignored. */
export function exportRouteArgs(args: string): { useThemes: boolean; path?: string } {
	const { useThemes } = exportDispatch(args);
	const rest = args
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t && t !== "--themes");
	return rest.length > 0 ? { useThemes, path: rest.join(" ") } : { useThemes };
}

function exportRoute(args: string): void {
	const { useThemes, path } = exportRouteArgs(args);
	void call("exportHtml", [path, useThemes])
		.then((result) => {
			const filePath = (result as { path?: string } | null)?.path;
			if (filePath) pushNotice("info", `Exported session HTML to ${filePath}`);
			else pushNotice("info", "Exported session HTML");
		})
		.catch(showError);
}

/**
 * `/dump [all]`: bare downloads the transcript plus the LLM-request sidecar
 * path; `all` requests the bounded server-side zip. Anything else is a usage
 * error, never a silent bare dump.
 */
export function dumpDispatch(
	args: string,
): { kind: "single" } | { kind: "all" } | { kind: "usage"; message: string } {
	const verb = args.trim().toLowerCase();
	if (!verb) return { kind: "single" };
	if (verb === "all") return { kind: "all" };
	return {
		kind: "usage",
		message:
			"Usage: /dump [all] — bare /dump downloads the transcript; /dump all requests the session archive.",
	};
}

function dumpRoute(args: string): void {
	const d = dumpDispatch(args);
	if (d.kind === "usage") {
		pushNotice("error", d.message);
		return;
	}
	if (d.kind === "all") {
		pushNotice(
			"error",
			"/dump all is not yet available in the browser: the session archive has no download route. Use bare /dump for the transcript.",
		);
		return;
	}
	dumpSession();
}

/**
 * `/goal` full TUI grammar: set/show/pause/resume/drop/budget. `show` opens
 * the Goal panel (the browser's read surface for goal details); `budget N`
 * and `budget off` adjust the token budget via the goal runtime; bare,
 * unknown, or `set` without an objective opens the popover. Never prompts.
 */
export function goalRouteArgs(args: string): void {
	const d = goalDispatch(args);
	if (d.kind === "popover") setState("modal", "goal");
	else void call(d.method, d.args).catch(showError);
}

/** `/btw [question]`: bare opens the panel; a question starts a side turn. Surrounding blank lines are trimmed. */
export function btwDispatch(args: string): { kind: "panel" } | { kind: "ask"; question: string } {
	const q = args.trim();
	return q ? { kind: "ask", question: q } : { kind: "panel" };
}

/**
 * P0.4: cwd-mutating workspace commands are refused explicitly while the
 * daemon/fleet assumes an immutable checkout. `/move` and `/wt` would
 * desynchronize the roster, session files, and artifact roots; refusing with
 * a named alternative beats a silent desync. The ACP handlers stay reachable
 * via agent-side dispatch for non-attached contexts.
 */
function refuseWorkspaceRoot(op: "move" | "wt"): void {
	pushNotice(
		"error",
		op === "move"
			? "/move is unavailable for attached fleet sessions: the daemon checkout is immutable while attached. Use the fleet sidebar to manage workspaces."
			: "/wt is unavailable for attached fleet sessions: worktree creation belongs to the fleet project flow. Use the Add-workspace modal to create a worktree.",
	);
}

/** `/fresh`: reset provider state, keep the transcript. While a turn is
 *  streaming the reset goes through the danger confirm, since resetting provider
 *  state mid-turn can fail the running turn. */
function freshSession(): void {
	void call("freshSession")
		.then(() => pushNotice("info", "Fresh session; provider state reset, transcript kept."))
		.catch(showError);
}

/** `/dump`: transcript downloads client-side; the LLM-request JSON is written
 *  to a temp file on the machine running the session daemon, and the notice
 *  names that path. */
function dumpSession(): void {
	void (async () => {
		try {
			const [text, dumpPath] = await Promise.all([
				call("formatSessionAsText"),
				call("dumpLlmRequestToTmpDir"),
			]);
			if (typeof text === "string" && text) {
				const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
				const a = document.createElement("a");
				a.href = url;
				a.download = "transcript.txt";
				a.click();
				URL.revokeObjectURL(url);
			} else {
				pushNotice("info", "Transcript is empty, nothing to download.");
			}
			if (typeof dumpPath === "string" && dumpPath) {
				pushNotice("info", `LLM request dump written to ${dumpPath}`);
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
 * verbatim; server-side interception runs builtins/skills/extensions.
 */
export const LOCAL_COMMANDS: Record<string, (args: string) => void> = {
	new: (args) => {
		if (args.trim()) return pushNotice("error", "Usage: /new takes no arguments.");
		void call("newSession").catch(showError);
	},
	clear: (args) => {
		if (args.trim()) return pushNotice("error", "Usage: /clear takes no arguments.");
		void call("clearSession").catch(showError);
	},
	resume: resumeRoute,
	tree: () => setState("modal", "branch"),
	branch: () => setState("modal", "branch"),
	// Phase 11: /btw <question> asks a side-channel question in the panel
	// (never the transcript); bare /btw opens the panel empty.
	btw: (args) => {
		const d = btwDispatch(args);
		if (d.kind === "panel") askBtw("");
		else askBtw(d.question);
	},
	export: exportRoute,
	retry: (args) => {
		if (args.trim()) {
			pushNotice("error", "Usage: /retry takes no arguments — it reruns the last failed turn.");
			return;
		}
		void call("retry")
			.then((ok) => {
				if (ok === false)
					pushNotice("error", "Nothing to retry; no failed turn or the session is busy.");
			})
			.catch(showError);
	},
	fork: (args) => {
		if (args.trim()) {
			pushNotice(
				"error",
				"Usage: /fork takes no arguments — it copies the whole session into a new file.",
			);
			return;
		}
		void call("fork")
			.then((ok) => {
				// HISTORY_RELOAD resync replaces the transcript; this is just the outcome.
				if (ok === false) pushNotice("error", "Fork failed.");
				else pushNotice("info", "Forked session.");
			})
			.catch(showError);
	},
	fresh: (args) => {
		if (args.trim()) {
			pushNotice(
				"error",
				"Usage: /fresh takes no arguments — it resets provider state and keeps the transcript.",
			);
			return;
		}
		if (state.streaming) {
			requestDangerConfirm({
				title: "Reset provider state",
				body: "A turn is in flight; the transcript is kept, but resetting provider state mid-turn can fail the running turn.",
				confirmLabel: "Reset state",
				onConfirm: freshSession,
			});
			return;
		}
		freshSession();
	},
	// Handoff compacts IN PLACE (session-maintenance.ts handoff commits a
	// compaction entry; no new session file, same identity). The prose below
	// reports the in-place outcome, not a new session.
	handoff: (args) =>
		void call("handoff", handoffArgs(args))
			.then((result) => {
				const r = result as { document?: string; savedPath?: string } | null | undefined;
				if (r?.document) {
					pushCompaction({
						action: "handoff",
						summary: r.document,
						skipped: false,
						aborted: false,
						willRetry: false,
					});
					pushNotice("info", "Handoff complete. Context compacted in place.");
				} else {
					pushNotice("info", "Handoff cancelled.");
				}
				if (r?.savedPath) pushNotice("info", `Handoff document written to ${r.savedPath}`);
			})
			.catch(showError),
	delete: (args) => {
		if (args.trim()) return pushNotice("error", "Usage: /delete takes no arguments.");
		void call("deleteSession").catch(showError);
	},
	dump: dumpRoute,
	rename: (args) => {
		const d = renameDispatch(args);
		void (
			d.method === "setSessionName" ? call("setSessionName", [d.title]) : call("prompt", [d.text])
		).catch(showError);
	},
	// TUI-only in the SDK registry, so web-local, never prompt passthrough
	// (see goalDispatch/planDispatch).
	goal: goalRouteArgs,
	plan: planToggle,
	queue: (args) => {
		const msg = args.trim();
		if (!msg) return;
		void call("followUp", [msg]).catch(showError);
	},
	compact: compactRoute,
	model: modelRoute,
	move: () => refuseWorkspaceRoot("move"),
	wt: () => refuseWorkspaceRoot("wt"),
	worktree: () => refuseWorkspaceRoot("wt"),
	usage: () => setState("modal", "stats"),
	context: () => setState("modal", "stats"),
	tools: () => setState("modal", "stats"),
	help: () => setState("modal", "help"),
	hotkeys: () => setState("modal", "help"),
	exit: () => pushNotice("info", "Session persists, close this browser tab to exit."),
	quit: () => pushNotice("info", "Session persists, close this browser tab to exit."),
};

/**
 * Queue-shorthand method selection: `->` steer-queues while streaming but
 * falls back to prompt when idle (steer errors on an idle session);
 * `=>` follow-up queues regardless of streaming state.
 */
export function queueMethod(
	steering: boolean,
	streaming: boolean,
): "prompt" | "steer" | "followUp" {
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
			// No timeout (0): bash_chunk frames provide liveness while the
			// server-side command runs; abortBash is the cancellation path.
			call("bash", [parsed.command, parsed.dimmed], 0, id)
				.then((result) => resolveBashItem(id, result as BashResultLike))
				.catch((err) => resolveBashItem(id, { error: String(err) }));
			return;
		}
		case "python": {
			if (!parsed.code) return;
			const id = addBashItem(parsed.code, parsed.dimmed, "python");
			// No timeout (0): python_chunk frames provide liveness while the
			// server-side command runs; abortEval is the cancellation path.
			call("python", [parsed.code, parsed.dimmed], 0, id)
				.then((result) => resolveBashItem(id, result as BashResultLike))
				.catch((err) => resolveBashItem(id, { error: String(err) }));
			return;
		}
		case "slash": {
			const handler = LOCAL_COMMANDS[parsed.name];
			if (handler) {
				handler(parsed.args);
				return;
			}
			// Agent-side builtin/skill/extension/file commands handle it. Their
			// command_output frames don't arrive over the SSE/POST transport (documented tradeoff).
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
			void call(method, [trimmed, images && images.length > 0 ? images : undefined]).catch(
				showError,
			);
		}
	}
}
