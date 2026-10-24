import type { AvailableSlashCommand } from "#lib/wire/protocol";
import type { SlashCommandSource } from "#lib/wire/slash-busy";
import type { FeatureStatus } from "../features/manifest";
import { SDK_BUILTINS, type SdkBuiltin } from "./sdk-builtins";

/**
 * The one web slash-command registry. The composer's `/` popup, `/help`, the
 * "did you mean" check in `dispatchInput`, and the later command palette
 * (Ctrl+K) all read `buildCommandRegistry()`; nothing else keeps its own list.
 *
 * Every entry is classified:
 * - `local`: the browser handles it (a `LOCAL_COMMANDS` handler or a feature
 *   route); it is never sent to the agent as text.
 * - `forwarded`: the daemon runs it through `prompt` (SDK builtin with a
 *   headless handler, skill, extension, custom or file command).
 * - `tui-only`: only the terminal UI implements it; the browser shows a local
 *   notice and never sends it to the model.
 */
export type CommandKind = "local" | "forwarded" | "tui-only";

export type CommandGroup = "Session" | "Model" | "Context" | "Panels" | "Agent" | "More";

export const COMMAND_GROUP_ORDER: readonly CommandGroup[] = [
	"Session",
	"Model",
	"Context",
	"Panels",
	"Agent",
	"More",
];

export interface CommandFeature {
	id: string;
	label: string;
	status: FeatureStatus;
	enabled: boolean;
}

export interface CommandEntry {
	name: string;
	aliases: readonly string[];
	description: string;
	/** Argument hint such as `[soft|remote|snapcompact] [focus]`. */
	hint?: string;
	subcommands: readonly string[];
	kind: CommandKind;
	group: CommandGroup;
	/** Refused by design (cwd moves, voice, closing the session): local notice, never offered. */
	refusal?: string;
	/** Local notice for a `tui-only` command, naming the web alternative when there is one. */
	notice?: string;
	/** Owning optional feature; a disabled owner makes the command unavailable. */
	feature?: CommandFeature;
	/** Where a forwarded command comes from; its busy policy keys on this (jx0b). Unset on local rows. */
	source?: SlashCommandSource;
}

export interface CommandRegistryInput {
	/** Names handled by `LOCAL_COMMANDS` (the browser-local handler table). */
	localNames: Iterable<string>;
	/** The daemon's advertised list (`available_commands` frame). */
	remote: readonly AvailableSlashCommand[];
	/** Owning feature of a slash name, with its live enabled flag. */
	featureOf: (name: string) => CommandFeature | undefined;
	/** Descriptions contributed by active features, by name. */
	featureDetails?: ReadonlyMap<string, string>;
}

/** Web-owned descriptions, overriding the SDK text where the browser behaves differently. */
const WEB_DESCRIPTIONS: Readonly<Record<string, string>> = {
	new: "Start a new session",
	resume: "Resume a previous session",
	tree: "Browse the session tree and jump to an earlier message",
	branch: "Branch from an earlier message",
	export: "Export the session as HTML",
	fork: "Branch the conversation from an earlier turn",
	fresh: "Reset provider state, keep the transcript",
	handoff: "Summarize into a handoff document and compact in place",
	delete: "Delete this session permanently",
	dump: "Download the transcript",
	rename: "Rename this session (bare: the agent picks a title)",
	compact: "Summarize the transcript to free context",
	model: "Switch the active model",
	queue: "Queue a follow-up message for after the turn",
	btw: "Side question (/btw [question])",
	goal: "Goal controls (/goal set|show|pause|resume|drop|budget)",
	mcp: "MCP servers (/mcp [add|list|remove|test])",
	skills: "Skills (/skills [installed])",
	compaction: "Open the context compaction controls",
	usage: "Show token usage and cost",
	context: "Open the context usage breakdown",
	tools: "Open the active tools list",
	help: "Show the command list and keyboard shortcuts",
	hotkeys: "Show keyboard shortcuts",
};

/** Argument hints the browser adds where its shape differs from the pinned SDK row. */
const WEB_HINTS: Readonly<Record<string, string>> = { model: "[model]" };

/** Web-only names with no SDK builtin of their own. */
const WEB_ONLY: readonly string[] = ["help", "compaction", "annotations"];

/**
 * Local handlers that refuse by design: the session is bound to its project
 * directory and the browser has no terminal or voice device.
 */
const REFUSALS: Readonly<Record<string, string>> = {
	live: "Realtime voice runs in the omp terminal UI.",
	move: "Attached sessions cannot change their project directory.",
	wt: "Attached sessions cannot create worktrees from the browser.",
	worktree: "Attached sessions cannot create worktrees from the browser.",
	exit: "Close this browser tab; the session persists.",
	quit: "Close this browser tab; the session persists.",
};

/**
 * SDK builtins with a headless handler that the web UI cannot show: both drive
 * the host's stats dashboard server, which the browser does not expose (CMD-23).
 */
const BROWSER_UNSUPPORTED: Readonly<Record<string, true>> = { stats: true, trace: true };

/** Web alternative named in the notice of a terminal-only command. */
const TUI_ONLY_HINTS: Readonly<Record<string, string>> = {
	setup: "Use the Settings button.",
	copy: "Select text in the transcript and copy it.",
	agents: "Use the Agents dock (Alt+A).",
	hub: "Use the Agents dock (Alt+A).",
	debug: "Open the Debug sheet from Settings > Features.",
	extensions: "Use the MCP and Skills dialogs.",
	collab: "Start or join collaboration from the terminal.",
	join: "Join collaboration from the terminal.",
	leave: "Leave collaboration from the terminal.",
	stats: "Use /usage for session statistics.",
	trace: "Use /usage for session statistics.",
};

const GROUPS: Readonly<Record<CommandGroup, readonly string[]>> = {
	Session: [
		"new",
		"resume",
		"seance",
		"fork",
		"fresh",
		"delete",
		"rename",
		"retry",
		"handoff",
		"tree",
		"branch",
		"pin",
		"session",
		"export",
		"dump",
		"share",
		"queue",
		"dirs",
		"add-dir",
		"remove-dir",
	],
	Model: [
		"model",
		"switch",
		"modelpreset",
		"effort",
		"fast",
		"slow",
		"extended-context",
		"computer",
		"skillful",
		"plan",
		"vibe",
		"goal",
		"guided-goal",
		"loop",
		"prewalk",
		"ratchet",
		"force",
	],
	Context: ["compact", "compaction", "shake", "usage", "context", "tools", "memory", "changelog"],
	Panels: [
		"help",
		"hotkeys",
		"git",
		"todo",
		"plan-review",
		"annotations",
		"btw",
		"jobs",
		"mcp",
		"skills",
		"plugins",
		"marketplace",
		"reload-plugins",
	],
	Agent: ["tan", "omfg", "cleanse", "security", "advisor", "browser", "ssh"],
	More: [],
};

const GROUP_BY_NAME: Record<string, CommandGroup | undefined> = {};
for (const group of COMMAND_GROUP_ORDER) {
	for (const name of GROUPS[group]) GROUP_BY_NAME[name] = group;
}

/** Names pinned first in the empty list and as ranking tie-break (the most-used TUI commands). */
const PINNED: readonly string[] = [
	"model",
	"new",
	"resume",
	"compact",
	"modelpreset",
	"plan",
	"queue",
	"effort",
];

const SDK_BY_NAME: Record<string, SdkBuiltin | undefined> = {};
const ALIAS_TO_NAME: Record<string, string | undefined> = {};
for (const builtin of SDK_BUILTINS) {
	SDK_BY_NAME[builtin.name] = builtin;
	for (const alias of builtin.aliases ?? []) ALIAS_TO_NAME[alias] = builtin.name;
}

/** Canonical builtin name for a typed name or alias. */
function canonicalName(name: string): string {
	return ALIAS_TO_NAME[name] ?? name;
}

/** True when the SDK runs this builtin headlessly, so a `prompt` call executes it instead of reaching the model. */
export function isSdkHandled(name: string): boolean {
	const canonical = canonicalName(name);
	return SDK_BY_NAME[canonical]?.sdkHandled === true && BROWSER_UNSUPPORTED[canonical] !== true;
}

/** Every classified entry, built from the live inputs (about 100 rows; cheap). */
export function buildCommandRegistry(input: CommandRegistryInput): CommandEntry[] {
	const local = new Set(input.localNames);
	const entries = new Map<string, CommandEntry>();
	const add = (entry: CommandEntry): void => {
		if (!entries.has(entry.name)) entries.set(entry.name, entry);
	};

	for (const b of SDK_BUILTINS) {
		const feature = input.featureOf(b.name);
		const base = {
			name: b.name,
			aliases: b.aliases ?? [],
			description: WEB_DESCRIPTIONS[b.name] ?? b.description,
			hint: b.hint ?? WEB_HINTS[b.name],
			subcommands: b.subcommands ?? [],
			group: GROUP_BY_NAME[b.name] ?? "More",
			refusal: REFUSALS[b.name],
			feature,
		};
		if (local.has(b.name) || feature) {
			add({ ...base, kind: "local" });
		} else if (isSdkHandled(b.name)) {
			add({ ...base, kind: "forwarded", source: "builtin" });
		} else {
			const hint = TUI_ONLY_HINTS[b.name];
			const notice = `/${b.name} is terminal-only and is not available in the browser.${hint ? ` ${hint}` : ""}`;
			add({ ...base, kind: "tui-only", notice });
		}
	}

	for (const name of WEB_ONLY) {
		add({
			name,
			aliases: [],
			description: input.featureDetails?.get(name) ?? WEB_DESCRIPTIONS[name] ?? "",
			subcommands: [],
			kind: "local",
			group: GROUP_BY_NAME[name] ?? "More",
			feature: input.featureOf(name),
		});
	}

	// Local handlers the SDK registry does not list.
	for (const name of local) {
		if (entries.has(name) || ALIAS_TO_NAME[name] !== undefined) continue;
		add({
			name,
			aliases: [],
			description: WEB_DESCRIPTIONS[name] ?? "",
			subcommands: [],
			kind: "local",
			group: GROUP_BY_NAME[name] ?? "More",
			refusal: REFUSALS[name],
		});
	}

	// Feature descriptions fill in names the web does not describe itself.
	for (const [name, detail] of input.featureDetails ?? []) {
		const entry = entries.get(name);
		if (entry && !WEB_DESCRIPTIONS[name]) entries.set(name, { ...entry, description: detail });
	}

	for (const c of input.remote) {
		if (entries.has(c.name) || ALIAS_TO_NAME[c.name] !== undefined) continue;
		add({
			name: c.name,
			aliases: c.aliases ?? [],
			description: c.description ?? "",
			hint: c.input?.hint,
			subcommands: (c.subcommands ?? []).map((s) => s.name),
			kind: "forwarded",
			source: c.source,
			group: "More",
		});
	}

	return [...entries.values()];
}

/** Resolves a typed name or alias to its entry. */
export function findCommand(
	registry: readonly CommandEntry[],
	typed: string,
): CommandEntry | undefined {
	const name = typed.toLowerCase();
	const canonical = canonicalName(name);
	return (
		registry.find((c) => c.name === canonical) ??
		registry.find((c) => c.aliases.some((a) => a.toLowerCase() === name))
	);
}

/** Offered in the popup and suggestions: usable here and now. */
export function isAvailable(entry: CommandEntry): boolean {
	if (entry.kind === "tui-only" || entry.refusal) return false;
	return entry.feature ? entry.feature.enabled : true;
}

/** Levenshtein distance, bounded: returns `limit + 1` once the distance must exceed `limit`. */
function editDistance(a: string, b: string, limit: number): number {
	if (Math.abs(a.length - b.length) > limit) return limit + 1;
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
			cur[j] = v;
			if (v < rowMin) rowMin = v;
		}
		if (rowMin > limit) return limit + 1;
		prev = cur;
	}
	return prev[b.length];
}

/**
 * The available command a mistyped name most likely meant, or undefined.
 * Prefix matches first (`/comp` to `/compact`), then the nearest by edit
 * distance within a length-scaled bound. Frequent commands win ties.
 */
export function suggestCommand(
	registry: readonly CommandEntry[],
	typed: string,
	usage: ReadonlyMap<string, number>,
): CommandEntry | undefined {
	const name = typed.toLowerCase();
	const limit = Math.max(1, Math.min(3, Math.floor(name.length / 3)));
	let best: { entry: CommandEntry; score: number } | undefined;
	for (const entry of registry) {
		if (!isAvailable(entry)) continue;
		let score = Infinity;
		for (const candidate of [entry.name, ...entry.aliases]) {
			const c = candidate.toLowerCase();
			if (name.length >= 2 && c.startsWith(name)) {
				score = Math.min(score, 0.5 + (c.length - name.length) / 100);
			} else {
				const d = editDistance(name, c, limit);
				if (d <= limit) score = Math.min(score, d);
			}
		}
		if (!Number.isFinite(score)) continue;
		const adjusted = score - Math.min(0.4, (usage.get(entry.name) ?? 0) / 100);
		if (!best || adjusted < best.score) best = { entry, score: adjusted };
	}
	return best?.entry;
}

/** Local message for a command that is not sent to the agent; undefined for runnable entries. */
export function refusalNotice(entry: CommandEntry): string | undefined {
	if (entry.kind === "tui-only") return entry.notice;
	if (entry.feature && !entry.feature.enabled)
		return disabledFeatureNotice(entry.name, entry.feature);
	if (entry.refusal) return `/${entry.name}: ${entry.refusal}`;
	return undefined;
}

/** Local notice for a command whose owning feature is off; an in-development owner cannot be turned on, so no enable hint. */
export function disabledFeatureNotice(
	name: string,
	feature: { label: string; status: FeatureStatus },
): string {
	return feature.status === "in-development"
		? `/${name} is part of ${feature.label}, which is in development.`
		: `/${name} is part of ${feature.label}, which is disabled. Enable it in Settings > Features.`;
}

export function unknownCommandNotice(typed: string, suggestion: CommandEntry | undefined): string {
	return suggestion
		? `Unknown command /${typed}, did you mean /${suggestion.name}?`
		: `Unknown command /${typed}. Type /help to list commands.`;
}

/** Subset of the session store the live-state column reads. */
export interface CommandLiveSource {
	model?: { id: string } | undefined;
	thinkingLevel?: string | undefined;
	planModeEnabled?: boolean;
	fastModeEnabled?: boolean;
	computerToolEnabled?: boolean;
	queuedMessageCount?: number;
	contextUsage?: { percent: number } | undefined;
	sessionName?: string | undefined;
	modelPresets?: { names: string[]; active?: string } | undefined;
}

const onOff = (v: boolean | undefined): string => (v ? "on" : "off");

/** Current value shown beside a command in the popup (model name, plan on/off, ...); undefined when it has none. */
export function commandLiveState(name: string, s: CommandLiveSource): string | undefined {
	switch (name) {
		case "model":
		case "switch":
			return s.model?.id;
		case "effort":
			return s.thinkingLevel;
		case "plan":
			return onOff(s.planModeEnabled);
		case "fast":
			return onOff(s.fastModeEnabled);
		case "computer":
			return onOff(s.computerToolEnabled);
		case "queue":
			return s.queuedMessageCount ? `${s.queuedMessageCount} queued` : undefined;
		case "compact":
		case "context":
			return s.contextUsage ? `${Math.round(s.contextUsage.percent)}% used` : undefined;
		case "modelpreset":
			return s.modelPresets?.active;
		case "rename":
			return s.sessionName || undefined;
		default:
			return undefined;
	}
}

export interface RankedCommand {
	entry: CommandEntry;
	/** 0 exact, 1 prefix, 2 subsequence; empty query ranks every entry 0. */
	tier: number;
}

/**
 * Popup ranking: available entries only; match tier first (exact over prefix
 * over subsequence, over the name and its aliases), then local usage count,
 * then the pinned set, then shorter names. `fuzzy` is the tier function
 * (`fuzzyRank` from autocomplete.ts), injected to keep this module pure.
 */
export function rankCommands(
	registry: readonly CommandEntry[],
	query: string,
	usage: ReadonlyMap<string, number>,
	fuzzy: (query: string, candidate: string) => number | null,
): RankedCommand[] {
	const pin = (name: string): number => {
		const i = PINNED.indexOf(name);
		return i < 0 ? PINNED.length : i;
	};
	const ranked: RankedCommand[] = [];
	for (const entry of registry) {
		if (!isAvailable(entry)) continue;
		let tier: number | null = null;
		for (const candidate of [entry.name, ...entry.aliases]) {
			const r = fuzzy(query, candidate);
			if (r !== null) tier = Math.min(tier ?? Infinity, Math.floor(r));
		}
		if (tier !== null) ranked.push({ entry, tier });
	}
	return ranked.sort(
		(a, b) =>
			a.tier - b.tier ||
			(usage.get(b.entry.name) ?? 0) - (usage.get(a.entry.name) ?? 0) ||
			pin(a.entry.name) - pin(b.entry.name) ||
			a.entry.name.length - b.entry.name.length ||
			a.entry.name.localeCompare(b.entry.name),
	);
}
