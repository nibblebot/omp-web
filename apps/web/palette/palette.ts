import type { RosterEntry, ModelBrowserEntry, SettingsModel } from "#lib/wire/protocol";
import { fuzzyRank } from "../prompt/autocomplete";
import {
	commandLiveState,
	findCommand,
	isAvailable,
	rankCommands,
	type CommandEntry,
	type CommandLiveSource,
} from "../prompt/command-registry";
import type { WebUiSearchRow } from "../prefs/settings";
import type { SettingsTabMeta } from "../prefs/settings-tabs";
import { formatSessionAge, sessionDisplayTitle, type SessionRow } from "../store/session-list";

/**
 * Command palette (Ctrl+K) logic: what the palette can reach, how a query
 * ranks it, and how the results group. Pure: callers pass every source in
 * (registry, roster, settings model, model catalog, recents), so ranking and
 * grouping stay deterministic and unit-testable. `store/palette.ts` gathers
 * the live sources and runs the chosen action.
 */

export type PaletteGroup = "Recent" | "Open" | "Commands" | "Sessions" | "Models" | "Settings";

/** Display order; with a query, groups are re-ordered by their best match, ties keep this order. */
export const PALETTE_GROUP_ORDER: readonly PaletteGroup[] = [
	"Recent",
	"Open",
	"Commands",
	"Sessions",
	"Models",
	"Settings",
];

/** Overlays that have no slash command of their own. */
export type PaletteOpenTarget =
	| "settings"
	| "activities"
	| "debug"
	| "add-project"
	| "sign-in"
	| "login"
	/** Extensions dialog on that group's first item. */
	| "skills"
	| "mcp"
	/** Extensions dialog on the Plugins tab. */
	| "plugins";

/** What choosing an item does. Plain data: `store/palette.ts` executes it. */
export type PaletteAction =
	/** `fill`: put `text` in the composer for the user to finish; otherwise run it as if typed. */
	| { kind: "command"; text: string; fill: boolean }
	| { kind: "workspace-session"; workspaceId: string }
	| { kind: "stored-session"; sessionId: string }
	/** Open Settings on `tabId`; `query` (a row label) pre-fills its search so the row shows. */
	| { kind: "setting"; tabId: string; query?: string }
	| { kind: "model"; selector: string }
	| { kind: "model-picker" }
	| { kind: "open"; target: PaletteOpenTarget }
	/** Open the New workspace popover for a project's header; ProjectGroups mounts it. */
	| { kind: "new-workspace"; projectId: string };

export interface PaletteItem {
	/** Stable across sessions: the recents list stores it. */
	id: string;
	group: PaletteGroup;
	label: string;
	detail?: string;
	/** Argument hint shown after a command name, or a keyboard shortcut for an overlay. */
	hint?: string;
	/** Current value (the model a command shows, for example). */
	live?: string;
	chip?: string;
	action: PaletteAction;
	/** Extra words a query may hit besides the label. */
	keywords: readonly string[];
	/** The source already matched this item (server-side search): keep it, ranked after local matches. */
	prematched?: true;
}

export interface PaletteSection {
	group: PaletteGroup;
	items: PaletteItem[];
}

/** Everything the palette can offer, already built from the live store. */
export interface PaletteSources {
	/** Null hides the Commands group (no session to run them against). */
	commands: {
		registry: readonly CommandEntry[];
		usage: ReadonlyMap<string, number>;
		live?: CommandLiveSource;
	} | null;
	open: readonly PaletteItem[];
	sessions: readonly PaletteItem[];
	settings: readonly PaletteItem[];
	models: readonly PaletteItem[];
	/** Item ids the user picked before, newest first. */
	recents: readonly string[];
}

const CAPS_EMPTY: Partial<Record<PaletteGroup, number>> = {
	Recent: 6,
	Open: 12,
	Commands: 6,
	Sessions: 5,
	Models: 4,
};
const CAPS_QUERY: Partial<Record<PaletteGroup, number>> = {
	Open: 8,
	Commands: 8,
	Sessions: 6,
	Models: 6,
	Settings: 8,
};

/**
 * Groups that match by prefix or substring only. A subsequence match would
 * let a short query hit nearly every long command or overlay label.
 */
const SUBSEQUENCE_OK: Record<PaletteGroup, boolean> = {
	Recent: true,
	Open: false,
	Commands: false,
	Sessions: true,
	Models: true,
	Settings: true,
};

/**
 * True when running the command needs an argument: a `<required>` token in its
 * hint outside any `[optional]` group (`/rename [title]` runs bare, `/join <link>` does not).
 */
export function requiresArgument(hint: string | undefined): boolean {
	if (hint === undefined) return false;
	let depth = 0;
	for (const ch of hint) {
		if (ch === "[") depth++;
		else if (ch === "]") depth = Math.max(0, depth - 1);
		else if (ch === "<" && depth === 0) return true;
	}
	return false;
}

function textTier(token: string, text: string, subsequence: boolean): number | null {
	const t = text.toLowerCase();
	if (t === token) return 0;
	if (t.startsWith(token)) return 1 + (t.length - token.length) / 1000;
	const at = t.indexOf(token);
	if (at >= 0) return 2 + at / 1000;
	if (!subsequence) return null;
	const r = fuzzyRank(token, t);
	return r === null ? null : 3 + (r - 2) / 100;
}

/**
 * Lower is better; null = no match. Each whitespace-separated token must hit
 * the label (exact < prefix < substring < subsequence where allowed) or, for
 * tokens of two or more characters, a keyword (tier 2.5). The whole query may
 * also hit the label directly; the better of the two wins.
 */
export function matchTier(
	query: string,
	label: string,
	keywords: readonly string[],
	subsequence: boolean,
): number | null {
	const q = query.trim().toLowerCase();
	if (q === "") return 0;
	const whole = textTier(q, label, subsequence);
	let tokens: number | null = 0;
	for (const token of q.split(/\s+/)) {
		let best = textTier(token, label, subsequence);
		if (best === null && token.length >= 2) {
			for (const keyword of keywords) {
				if (keyword.toLowerCase().includes(token)) {
					best = 2.5;
					break;
				}
			}
		}
		if (best === null) {
			tokens = null;
			break;
		}
		tokens = Math.max(tokens, best);
	}
	if (whole === null) return tokens;
	return tokens === null ? whole : Math.min(whole, tokens);
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

/** One command as a palette row. Commands that need an argument fill the composer; the rest run. */
export function commandItem(entry: CommandEntry, live?: CommandLiveSource): PaletteItem {
	const state = live === undefined ? undefined : commandLiveState(entry.name, live);
	const fill = requiresArgument(entry.hint);
	return {
		id: `cmd:${entry.name}`,
		group: "Commands",
		label: `/${entry.name}`,
		detail: entry.description,
		...(entry.hint === undefined ? {} : { hint: entry.hint }),
		...(state === undefined ? {} : { live: state }),
		action: { kind: "command", text: `/${entry.name}${fill ? " " : ""}`, fill },
		keywords: [entry.description, ...entry.aliases],
	};
}

export interface PaletteContext {
	debugEnabled: boolean;
	/** The `plugins` feature is on: Plugins opens the Extensions dialog on its Plugins tab. */
	pluginsEnabled: boolean;
	projects: readonly { projectId: string; name: string }[];
}

function openItem(
	target: PaletteOpenTarget,
	label: string,
	detail: string,
	keywords: readonly string[],
	extra: { hint?: string } = {},
): PaletteItem {
	return {
		id: `open:${target}`,
		group: "Open",
		label,
		detail,
		...(extra.hint === undefined ? {} : { hint: extra.hint }),
		action: { kind: "open", target },
		keywords,
	};
}

/** The overlays that have no slash command, available in `context`. */
export function openItems(context: PaletteContext): PaletteItem[] {
	const items: PaletteItem[] = [
		openItem(
			"settings",
			"Settings",
			"Preferences and omp config",
			["preferences", "options", "config"],
			{
				hint: "Ctrl+,",
			},
		),
		openItem(
			"activities",
			"Activities",
			"Subagents, jobs, daemons and todos",
			["agents", "tasks", "workers", "jobs", "daemons", "todos"],
			{
				hint: "Alt+A",
			},
		),
	];
	if (context.debugEnabled)
		items.push(
			openItem("debug", "Debug", "Fleet and session diagnostics", ["logs", "diagnostics"]),
		);
	items.push(
		openItem("skills", "Skills", "Turn skills on or off and read their instructions", [
			"extensions",
			"integrations",
		]),
		openItem("mcp", "MCP servers", "Manage MCP servers and see their tools", [
			"extensions",
			"integrations",
			"tools",
		]),
	);
	if (context.pluginsEnabled)
		items.push(
			openItem("plugins", "Plugins", "Enable, disable, and configure installed plugins", [
				"plugin",
				"extensions",
				"integrations",
			]),
		);
	items.push(
		openItem("add-project", "Add project", "Register a folder as a project", [
			"folder",
			"directory",
			"repo",
		]),
	);
	for (const project of context.projects)
		items.push({
			id: `new-workspace:${project.projectId}`,
			group: "Open",
			label: context.projects.length === 1 ? "New workspace" : `New workspace: ${project.name}`,
			detail: `Worktree, clone, or checkout in ${project.name}`,
			action: { kind: "new-workspace", projectId: project.projectId },
			keywords: ["worktree", "clone", "branch", "session", project.name],
		});
	items.push(openItem("sign-in", "Sign in", "Sign in to this fleet", ["auth", "token", "login"]));
	items.push(
		openItem("login", "Provider login", "Log in to a model provider", [
			"credentials",
			"oauth",
			"api key",
		]),
	);
	return items;
}

/** One row per fleet session that can be attached (ready or asleep), across every project. */
export function rosterSessionItems(
	roster: readonly RosterEntry[],
	currentWorkspaceId: string,
): PaletteItem[] {
	const rows: PaletteItem[] = [];
	for (const d of roster) {
		if (d.status !== "ready" && d.status !== "asleep") continue;
		const title = d.sessionTitle?.trim() || (d.sessionEmpty === true ? "New session" : d.name);
		const where = d.branch ? `${d.project} · ${d.branch}` : d.project;
		const current = d.workspaceId === currentWorkspaceId;
		rows.push({
			id: `session:d:${d.workspaceId}`,
			group: "Sessions",
			label: title,
			detail: where,
			...(current ? { chip: "current" } : d.status === "asleep" ? { chip: "asleep" } : {}),
			action: { kind: "workspace-session", workspaceId: d.workspaceId },
			keywords: [d.project, d.name, d.branch ?? "", d.cwd],
		});
	}
	// The attached session sorts last: the palette is for going somewhere else.
	return rows.sort((a, b) => Number(a.chip === "current") - Number(b.chip === "current"));
}

/**
 * Stored sessions (any project) found by the server-side session search.
 * Rows a roster session already covers (`covered` holds their files), and rows
 * no registered project owns (they cannot resume), are left out.
 */
export function storedSessionItems(
	rows: readonly SessionRow[],
	nowMs: number,
	covered: ReadonlySet<string>,
): PaletteItem[] {
	const items: PaletteItem[] = [];
	for (const row of rows) {
		if (row.current === true || row.blocked !== undefined || covered.has(row.file)) continue;
		items.push({
			id: `session:f:${row.file}`,
			group: "Sessions",
			label: sessionDisplayTitle(row),
			detail: `${row.projectLabel} · ${formatSessionAge(row.modifiedMs, nowMs)}`,
			chip: "stored",
			action: { kind: "stored-session", sessionId: row.id },
			keywords: [],
			prematched: true,
		});
	}
	return items;
}

/**
 * Settings tabs, sections and rows. SDK rows come from the model; `webRows`
 * are the rows outside it (browser-local and session toggles) that the caller
 * already matched, each with the tab that renders it.
 */
export function settingItems(
	model: SettingsModel | null,
	tabs: readonly SettingsTabMeta[],
	webRows: readonly WebUiSearchRow[],
): PaletteItem[] {
	const items: PaletteItem[] = [];
	for (const tab of tabs) {
		items.push({
			id: `setting:tab:${tab.id}`,
			group: "Settings",
			label: `${tab.label} settings`,
			detail: tab.section,
			action: { kind: "setting", tabId: tab.id },
			keywords: [tab.label],
		});
	}
	for (const tab of model?.tabs ?? []) {
		// The sheet's labels win over the SDK's (it names the Display tab "Appearance").
		const tabLabel = tabs.find((meta) => meta.id === tab.id)?.label ?? tab.label;
		for (const group of tab.groups) {
			for (const row of group.items) {
				items.push({
					id: `setting:row:${row.path}`,
					group: "Settings",
					label: row.label,
					detail: `${tabLabel}${group.name ? ` · ${group.name}` : ""}`,
					action: { kind: "setting", tabId: tab.id, query: row.label },
					keywords: [row.description, row.path, group.name],
				});
			}
		}
	}
	for (const { label, tabId } of webRows) {
		items.push({
			id: `setting:web:${label}`,
			group: "Settings",
			label,
			detail: tabs.find((tab) => tab.id === tabId)?.label ?? tabId,
			action: { kind: "setting", tabId, query: label },
			keywords: [],
		});
	}
	return items;
}

/**
 * "Switch model…" plus model rows: recents always, the whole usable catalog
 * when `all` (a query is typed). The current model is never offered; locked
 * models are offered only when they are in the recents list and the catalog
 * is unknown (`catalog` null).
 */
export function modelItems(
	catalog: readonly ModelBrowserEntry[] | null,
	recent: readonly string[],
	current: string | undefined,
	all: boolean,
): PaletteItem[] {
	const items: PaletteItem[] = [
		{
			id: "model:picker",
			group: "Models",
			label: "Switch model…",
			detail: "Pick from every available model",
			hint: "Alt+P",
			action: { kind: "model-picker" },
			keywords: ["change", "llm", "provider"],
		},
	];
	const usable = new Set<string>();
	for (const entry of catalog ?? [])
		if (entry.locked === undefined) usable.add(`${entry.provider}/${entry.id}`);
	const seen = new Set<string>();
	const push = (selector: string, isRecent: boolean): void => {
		if (selector === current || seen.has(selector)) return;
		seen.add(selector);
		items.push({
			id: `model:${selector}`,
			group: "Models",
			label: `Switch to ${selector}`,
			...(isRecent ? { chip: "recent" } : {}),
			action: { kind: "model", selector },
			keywords: [selector],
		});
	};
	for (const selector of recent) if (catalog === null || usable.has(selector)) push(selector, true);
	if (all) for (const selector of usable) push(selector, false);
	return items;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** `/name args` typed in full: one row that runs exactly that text. */
function typedCommand(query: string, registry: readonly CommandEntry[]): PaletteItem | undefined {
	const m = /^\/(\S+)\s+(\S[\s\S]*)$/.exec(query);
	if (m === null) return undefined;
	const entry = findCommand(registry, m[1].toLowerCase());
	if (entry === undefined || !isAvailable(entry)) return undefined;
	const text = `/${entry.name} ${m[2].trim()}`;
	return {
		id: `run:${text}`,
		group: "Commands",
		label: text,
		detail: "Run this command",
		action: { kind: "command", text, fill: false },
		keywords: [],
	};
}

interface Ranked {
	items: PaletteItem[];
	best: number;
}

function rankGroup(group: PaletteGroup, items: readonly PaletteItem[], query: string): Ranked {
	const scored: { item: PaletteItem; tier: number }[] = [];
	for (const item of items) {
		const tier = item.prematched
			? 2.9
			: matchTier(query, item.label, item.keywords, SUBSEQUENCE_OK[group]);
		if (tier !== null) scored.push({ item, tier });
	}
	scored.sort((a, b) => a.tier - b.tier);
	return { items: scored.map((s) => s.item), best: scored[0]?.tier ?? Infinity };
}

/**
 * Grouped, ranked results for `query`.
 *
 * Empty query: Recent (the user's last picks, resolved against the current
 * sources), then the default set of each group. Items shown under Recent do
 * not repeat in their own group. A query ranks each group (commands through
 * the registry's ranking: availability, usage, pinned names) and orders groups
 * by their best match, ties keeping the fixed group order. Empty groups are
 * omitted.
 */
export function searchPalette(query: string, sources: PaletteSources): PaletteSection[] {
	const q = query.trim();
	const empty = q === "";
	const caps = empty ? CAPS_EMPTY : CAPS_QUERY;
	const ranked: Partial<Record<PaletteGroup, Ranked>> = {};

	if (sources.commands !== null) {
		const c = sources.commands;
		const typed = empty ? undefined : typedCommand(q, c.registry);
		if (typed !== undefined) ranked.Commands = { items: [typed], best: 0 };
		else {
			const hits = rankCommands(c.registry, q.replace(/^\//, ""), c.usage, fuzzyRank);
			ranked.Commands = {
				items: hits.map((h) => commandItem(h.entry, c.live)),
				best: hits[0]?.tier ?? Infinity,
			};
		}
	}
	ranked.Open = rankGroup("Open", sources.open, q);
	ranked.Sessions = rankGroup("Sessions", sources.sessions, q);
	ranked.Models = rankGroup("Models", sources.models, q);
	ranked.Settings = empty
		? { items: [], best: Infinity }
		: rankGroup("Settings", sources.settings, q);

	if (empty) {
		const byId = new Map<string, PaletteItem>();
		for (const item of [
			...sources.open,
			...sources.sessions,
			...sources.models,
			...sources.settings,
		])
			byId.set(item.id, item);
		for (const entry of sources.commands?.registry ?? [])
			if (isAvailable(entry))
				byId.set(`cmd:${entry.name}`, commandItem(entry, sources.commands?.live));
		const recent: PaletteItem[] = [];
		for (const id of sources.recents) {
			const item = byId.get(id);
			if (item !== undefined) recent.push({ ...item, group: "Recent" });
		}
		const shown = new Set(recent.slice(0, CAPS_EMPTY.Recent).map((item) => item.id));
		ranked.Recent = { items: recent, best: 0 };
		for (const group of ["Open", "Commands", "Sessions", "Models"] as const) {
			const r = ranked[group];
			if (r !== undefined) r.items = r.items.filter((item) => !shown.has(item.id));
		}
	}

	const sections: { section: PaletteSection; best: number }[] = [];
	for (const group of PALETTE_GROUP_ORDER) {
		const r = ranked[group];
		if (r === undefined) continue;
		const cap = caps[group];
		const items = cap === undefined ? r.items : r.items.slice(0, cap);
		if (items.length > 0) sections.push({ section: { group, items }, best: r.best });
	}
	if (!empty) sections.sort((a, b) => Math.floor(a.best) - Math.floor(b.best));
	return sections.map((s) => s.section);
}

/** Result rows in display order: the keyboard cursor walks this list. */
export function flattenPalette(sections: readonly PaletteSection[]): PaletteItem[] {
	return sections.flatMap((section) => section.items);
}
