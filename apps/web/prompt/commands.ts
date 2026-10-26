import type { ImageArg } from "#lib/wire/protocol";
import { slashBusyPolicy, type SlashCommandSource } from "#lib/wire/slash-busy";
import { requestDangerConfirm } from "./danger-confirm";
import { goalRouteArgs } from "./goal-dispatch";
import { featureCommand, featureCommandDetails, isFeatureEnabled } from "../features/registry";
import { featureForCommand } from "../features/manifest";
import {
	buildCommandRegistry,
	disabledFeatureNotice,
	findCommand,
	isSdkHandled,
	refusalNotice,
	suggestCommand,
	unknownCommandNotice,
	type CommandEntry,
} from "./command-registry";
import {
	addBashItem,
	call,
	pushNotice,
	resolveBashItem,
	setState,
	startNewSession,
	state,
	type BashResultLike,
	type ModalName,
} from "../state";
import {
	openModelDialog,
	runModelPresetCommand,
	switchSessionModel,
	type ModelPresetAction,
} from "../store/models";
import { humanizeCompactionError } from "../store/compaction-view";
import { runManualCompact } from "../store/compaction";
import { openDock } from "../store/dock";
import { openIntegrations } from "../store/integrations";
import { askBtw, btwDispatch } from "../store/btw";
import { downloadArchive, downloadHtml, downloadRequest, downloadText } from "../store/downloads";
import { queuedAnnotationIds, withQueuedAnnotations } from "../store/review";
import { MAINTENANCE_CALL_TIMEOUT_MS } from "../store/transport";

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
	// The SDK's error class name is noise in a toast (CMD-08).
	setState("error", String(err).replace(/^\w+Error: /, ""));
}

const USAGE_KEY = "omp-web:command-usage";

/** Per-browser run counts, the popup's frequency ranking (CMD-06). */
export function commandUsage(): Map<string, number> {
	try {
		const raw = localStorage.getItem(USAGE_KEY);
		return new Map(Object.entries(raw ? (JSON.parse(raw) as Record<string, number>) : {}));
	} catch {
		return new Map();
	}
}

function recordCommandUse(name: string): void {
	const usage = commandUsage();
	usage.set(name, (usage.get(name) ?? 0) + 1);
	try {
		localStorage.setItem(USAGE_KEY, JSON.stringify(Object.fromEntries(usage)));
	} catch {
		// Storage full or disabled: ranking falls back to the pinned order.
	}
}

/** Every name the composer can run now: local handlers, feature routes, and the session's advertised list. */
export function currentCommandRegistry(): CommandEntry[] {
	return buildCommandRegistry({
		localNames: Object.keys(LOCAL_COMMANDS),
		remote: state.availableCommands,
		featureOf: (name) => {
			const f = featureForCommand(name);
			return f
				? { id: f.id, label: f.label, status: f.status, enabled: isFeatureEnabled(f.id) }
				: undefined;
		},
		featureDetails: new Map(featureCommandDetails()),
	});
}

/**
 * Sends a session-run command after echoing it. While a turn streams, the busy
 * policy decides (jx0b, CMD-08): read-only builtins run now, `/session delete`
 * is refused with a notice, and everything else queues as a command chip.
 */
function forwardSlash(
	text: string,
	name: string,
	source: SlashCommandSource | undefined,
	args: string,
	images?: ImageArg[],
): void {
	recordCommandUse(name);
	const policy = state.streaming ? slashBusyPolicy({ source, name, args }) : "now";
	if (policy === "refuse") {
		pushNotice(
			"info",
			`/${name} ${args.trim()} is refused while a turn runs. Stop the turn first, then run it again.`,
		);
		return;
	}
	if (policy === "queue") {
		void call("queueCommand", commandArgs(text, images)).catch(showError);
		return;
	}
	pushNotice("echo", text);
	void call("prompt", commandArgs(text, images)).catch(showError);
}

/** Call args for a forwarded command: images ride along only when attached. */
function commandArgs(
	text: string,
	images: ImageArg[] | undefined,
): [string] | [string, ImageArg[]] {
	return images && images.length > 0 ? [text, images] : [text];
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
 * `/model [selector]`: bare opens the Models dialog on Roles; a selector
 * switches the session model (session-only, roles unchanged). The selector
 * grammar, fuzzy matching and `:level` suffix resolve server-side. Never
 * forwards to the agent as text.
 */
export function modelDispatch(
	args: string,
): { kind: "dialog" } | { kind: "select"; selector: string } {
	const selector = args.trim();
	return selector ? { kind: "select", selector } : { kind: "dialog" };
}

function modelRoute(args: string): void {
	const d = modelDispatch(args);
	if (d.kind === "dialog") openModelDialog("roles");
	else void switchSessionModel(d.selector);
}

const MODEL_PRESET_ACTIONS: readonly string[] = ["list", "save", "apply", "delete"];

/** `/modelpreset [list|save|switch|delete] [name]` (`apply` also accepted); bare lists presets. */
function modelPresetRoute(args: string): void {
	const words = args.trim() ? args.trim().split(/\s+/) : [];
	const word = words[0] ?? "list";
	const action = word === "switch" ? "apply" : word;
	if (!MODEL_PRESET_ACTIONS.includes(action)) {
		pushNotice("error", "Usage: /modelpreset [list|save|switch|delete] [name]");
		return;
	}
	void runModelPresetCommand(action as ModelPresetAction, words.slice(1).join(" ") || undefined);
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
	// The marker comes with the transcript resync that compaction triggers (HISTORY_RELOAD).
	void runManualCompact({ mode: d.mode, instructions: d.instructions });
}

/** `/export [--themes] [path]`: `--themes` carries the web theme; a path is parsed so exportRoute can refuse it. */
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
	if (path !== undefined) {
		pushNotice(
			"error",
			"/export saves through your browser, so a server path is not accepted. Use /export [--themes].",
		);
		return;
	}
	downloadHtml({ themed: useThemes });
}

/**
 * `/dump [all|request]`: bare downloads the transcript; `all` downloads the
 * session archive; `request` downloads the LLM-request JSON. Anything else is
 * a usage error, never a silent bare dump.
 */
export function dumpDispatch(
	args: string,
): { kind: "single" } | { kind: "all" } | { kind: "request" } | { kind: "usage"; message: string } {
	const verb = args.trim().toLowerCase();
	if (!verb) return { kind: "single" };
	if (verb === "all") return { kind: "all" };
	if (verb === "request") return { kind: "request" };
	return {
		kind: "usage",
		message:
			"Usage: /dump [all|request]. Bare /dump downloads the transcript; /dump all downloads the session archive; /dump request downloads the LLM request JSON.",
	};
}

function dumpRoute(args: string): void {
	const d = dumpDispatch(args);
	if (d.kind === "usage") {
		pushNotice("error", d.message);
		return;
	}
	if (d.kind === "all") downloadArchive();
	else if (d.kind === "request") downloadRequest();
	else downloadText();
}

/**
 * P0.4: cwd-mutating workspace commands are refused explicitly while the
 * session/fleet assumes an immutable checkout. `/move` and `/wt` would
 * desynchronize the roster, session files, and artifact roots; refusing with
 * a named alternative beats a silent desync. The ACP handlers stay reachable
 * via agent-side dispatch for non-attached contexts.
 */
function refuseWorkspaceRoot(op: "move" | "wt"): void {
	pushNotice(
		"error",
		op === "move"
			? "/move is unavailable for attached fleet sessions: the session's checkout is immutable while attached. Use the fleet sidebar to manage workspaces."
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

/** Bare `/name` opens its dialog. Arguments reach the agent only for SDK builtins with a headless handler (`/mcp list`); TUI-only ones such as `/skills installed` get a notice (INT-06). */
function openOrForward(modal: ModalName, name: string): (args: string) => void {
	return (args) => {
		const text = args.trim();
		if (!text) {
			setState("modal", modal);
			return;
		}
		if (isSdkHandled(name)) forwardSlash(`/${name} ${text}`, name, "builtin", text);
		else
			pushNotice(
				"info",
				`/${name} arguments are terminal-only; type /${name} alone to open it in the browser.`,
			);
	};
}

const forwardMcp = openOrForward("integrations", "mcp");

/** Bare `/name` opens its dialog. Arguments (e.g. the SDK's `/git [revision]`)
 *  belong to the terminal UI, whose output never reaches the browser. */
function openModal(modal: ModalName): (args: string) => void {
	return (args) => {
		if (args.trim())
			pushNotice(
				"error",
				`/${modal} arguments are terminal-only; type /${modal} alone to open it in the browser.`,
			);
		else setState("modal", modal);
	};
}

/**
 * Web-local slash commands: TUI-only commands that have session-method
 * equivalents (or web-native displays). Anything not in this table is sent to the agent
 * verbatim; server-side interception runs builtins/skills/extensions.
 */
export const LOCAL_COMMANDS: Record<string, (args: string) => void> = {
	new: (args) => {
		if (args.trim()) return pushNotice("error", "Usage: /new takes no arguments.");
		void startNewSession().catch(showError);
	},
	clear: (args) => {
		if (args.trim()) return pushNotice("error", "Usage: /clear takes no arguments.");
		void call("clearSession").catch(showError);
	},
	resume: resumeRoute,
	tree: () => openDock("tree"),
	branch: () => openDock("tree"),
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
	// reports the in-place outcome, not a new session. The call settles only after
	// a oneshot LLM request over the whole context writes the document, so it gets
	// the compaction modal's 5 minute deadline, not call()'s 30 second default
	// (which reported "did not answer in time" while the handoff still committed).
	handoff: (args) =>
		void call("handoff", handoffArgs(args), MAINTENANCE_CALL_TIMEOUT_MS)
			.then((result) => {
				const r = result as { document?: string; savedPath?: string } | null | undefined;
				if (r?.document) {
					pushNotice("info", "Handoff complete. Context compacted in place.");
				} else {
					pushNotice("info", "Handoff cancelled.");
				}
				if (r?.savedPath) pushNotice("info", `Handoff document written to ${r.savedPath}`);
			})
			.catch((err) => setState("error", humanizeCompactionError(err))),
	delete: (args) => {
		if (args.trim()) return pushNotice("error", "Usage: /delete takes no arguments.");
		if (state.streaming)
			return pushNotice(
				"info",
				"/delete is refused while a turn runs. Stop the turn first, then delete the session.",
			);
		requestDangerConfirm({
			title: "Delete this session?",
			body: "The attached session's transcript and its artifacts are deleted permanently, and the session process starts a new empty session in its place. This cannot be undone.",
			confirmLabel: "Delete session",
			onConfirm: () => {
				void call("deleteSession").catch(showError);
			},
		});
	},
	dump: dumpRoute,
	rename: (args) => {
		const d = renameDispatch(args);
		void (
			d.method === "setSessionName" ? call("setSessionName", [d.title]) : call("prompt", [d.text])
		).catch(showError);
	},
	// Modal openers: bare names open the dialog (see openOrForward/openModal).
	compaction: openModal("compaction"),
	queue: (args) => {
		const msg = args.trim();
		if (!msg) return pushNotice("error", "Usage: /queue <message>");
		void call("followUp", [msg]).catch(showError);
	},
	compact: compactRoute,
	model: modelRoute,
	modelpreset: modelPresetRoute,
	live: () =>
		pushNotice("error", "/live is terminal-only: realtime voice runs in the omp terminal UI."),
	move: () => refuseWorkspaceRoot("move"),
	wt: () => refuseWorkspaceRoot("wt"),
	worktree: () => refuseWorkspaceRoot("wt"),
	usage: () => setState("modal", "stats"),
	context: () => setState("modal", "stats"),
	tools: () => setState("modal", "stats"),
	settings: (args) => {
		setState("settingsQuery", args.trim());
		setState("modal", "settings");
	},
	help: () => setState("modal", "help"),
	hotkeys: () => setState("modal", "hotkeys"),
	exit: () => pushNotice("info", "Close this browser tab; the session persists."),
	quit: () => pushNotice("info", "Close this browser tab; the session persists."),
	// `/btw [question]`: a question starts a saved side turn and opens the sheet to
	// show it; bare `/btw` opens the sheet on its history. Arguments never reach the transcript.
	btw: (args) => {
		const d = btwDispatch(args);
		if (d.kind === "ask") askBtw(d.question);
		setState("modal", "btw");
	},
	goal: goalRouteArgs,
	// Bare `/mcp` opens the Extensions dialog on MCP servers; arguments follow the SDK's /mcp grammar and go to the agent.
	mcp: (args) => (args.trim() ? forwardMcp(args) : openIntegrations("extensions", "mcp")),
	// Skill install, update, and search are terminal commands (`omp skill ...`); the dialog covers listing and toggling.
	skills: (args) => {
		const sub = args.trim();
		if (sub === "" || sub === "installed") openIntegrations("extensions", "skill");
		else
			pushNotice(
				"error",
				`/skills ${sub} is terminal-only. Install or update skills with "omp skill ${sub}" in a terminal; turn skills on or off in the Extensions dialog.`,
			);
	},
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
				recordCommandUse(parsed.name);
				handler(parsed.args);
				return;
			}
			const owned = featureCommand(parsed.name);
			if (owned) {
				recordCommandUse(parsed.name);
				owned.command.run(parsed.args);
				return;
			}
			const off = featureForCommand(parsed.name);
			if (off) {
				pushNotice("info", disabledFeatureNotice(parsed.name, off));
				return;
			}
			// Names the browser cannot run never reach the model: unknown ones get a
			// suggestion, terminal-only ones a notice (CMD-07, COL-09).
			const registry = currentCommandRegistry();
			const entry = findCommand(registry, parsed.name);
			if (!entry) {
				pushNotice(
					"info",
					unknownCommandNotice(parsed.name, suggestCommand(registry, parsed.name, commandUsage())),
				);
				return;
			}
			const refused = refusalNotice(entry);
			if (refused) {
				pushNotice("info", refused);
				return;
			}
			if (entry.kind === "local") {
				const run = LOCAL_COMMANDS[entry.name];
				if (run) {
					recordCommandUse(entry.name);
					run(parsed.args);
				} else pushNotice("info", `/${entry.name} is not available in the browser.`);
				return;
			}
			// Agent-side builtin/skill/extension/file command. Its command_output frames
			// don't arrive over the browser socket transport (documented tradeoff).
			forwardSlash(trimmed, entry.name, entry.source, parsed.args, images);
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
			const payload = images && images.length > 0 ? images : undefined;
			if (queuedAnnotationIds().length)
				void withQueuedAnnotations(trimmed)
					.then((prompt) => call(method, [prompt, payload]))
					.catch(showError);
			else void call(method, [trimmed, payload]).catch(showError);
		}
	}
}
