#!/usr/bin/env bun
/**
 * Snapshots, and diffs, the SDK surface omp-web mirrors: settings rows, builtin
 * slash commands, and built-in tool names. Run it in the worktree after
 * `bun install --frozen-lockfile` before the bump and again after, then diff.
 *
 *   bun .omp/skills/sdk-reconcile/surface-snapshot.ts [--root <repo>] > before.json
 *   bun .omp/skills/sdk-reconcile/surface-snapshot.ts --diff before.json after.json
 *
 * Snapshot mode prints one JSON object:
 *   { sdkVersion, settings: [{ path, type, default, tab, group, hasUi, condition,
 *     hidden, advanced, webTrueCondition }], tabs, tabSectionOrder,
 *     builtins: [{ name, aliases, subcommands, sdkHandled }],
 *     tools: [{ name, hasCard }],
 *     layout: { hidden, advanced, webTrue } }
 * `layout` is the raw settings-layout manifest (HIDDEN/ADVANCED paths and
 * WEB_TRUE_CONDITIONS) so the diff can flag manifest entries for removed rows.
 *
 * Everything SDK- or repo-specific loads from --root (default cwd): SDK modules
 * resolve with Bun.resolveSync against it, the layout manifest is imported from
 * <root>/lib/sdk-settings/settings-layout.ts, and the RENDERERS keys are parsed from
 * <root>/apps/web/components/chat/tools/renderers.ts. The SDK exposes no tool
 * registry without a session, so tool names are the static `BUILTIN_TOOL_NAMES` +
 * `HIDDEN_TOOL_NAMES` lists (tools/builtin-names); tools contributed at runtime
 * (MCP, extensions, plan-mode helpers) are not enumerable here. Nothing is written:
 * the settings host is a pure schema adapter and no Settings instance is created.
 *
 * Diff mode prints markdown; sections with no content are omitted. Exit 0.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function arg(name: string): string | undefined {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? undefined : process.argv[index + 1];
}

interface SettingRow {
	path: string;
	type: string;
	default: unknown;
	tab: string;
	group: string | null;
	hasUi: boolean;
	condition: string | null;
	hidden: boolean;
	advanced: boolean;
	webTrueCondition: string | null;
}

interface BuiltinRow {
	name: string;
	aliases: string[];
	subcommands: string[];
	sdkHandled: boolean;
}

interface ToolRow {
	name: string;
	hasCard: boolean;
}

interface Snapshot {
	sdkVersion: string;
	settings: SettingRow[];
	tabs: string[];
	tabSectionOrder: Record<string, string[]>;
	builtins: BuiltinRow[];
	tools: ToolRow[];
	layout: { hidden: string[]; advanced: string[]; webTrue: Record<string, string> };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** JSON-safe copy: functions, symbols, and undefined become null; arrays and records are kept. */
function jsonSafe(value: unknown): unknown {
	if (value === undefined || typeof value === "function" || typeof value === "symbol") return null;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (Array.isArray(value)) return value.map(jsonSafe);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
	}
	return value;
}

/** Imports a module by specifier as resolved from the root checkout. */
// Dynamic import: the module path depends on --root, so no static import can name it.
async function importFromRoot(root: string, specifier: string): Promise<Record<string, any>> {
	return (await import(Bun.resolveSync(specifier, root))) as Record<string, any>;
}

/** Version of the package that owns a resolved file: the nearest package.json upward. */
function packageVersion(file: string): string {
	for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
		const manifest = join(dir, "package.json");
		if (!existsSync(manifest)) continue;
		const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			"version" in parsed &&
			typeof parsed.version === "string"
		) {
			return parsed.version;
		}
	}
	return "unknown";
}

/** Top-level keys of the `RENDERERS = { ... }` object literal, parsed from source text. */
function rendererKeys(root: string): Set<string> {
	const file = join(root, "apps/web/components/chat/tools/renderers.ts");
	const keys = new Set<string>();
	if (!existsSync(file)) return keys;
	const source = readFileSync(file, "utf8");
	const start = source.search(/\bRENDERERS\b[^=\n]*=\s*\{/);
	if (start === -1) return keys;
	const body = source.slice(source.indexOf("{", source.indexOf("=", start)) + 1);
	let depth = 1;
	let end = body.length;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) {
			end = i;
			break;
		}
	}
	for (const line of body.slice(0, end).split("\n")) {
		const match = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/.exec(line);
		if (match) keys.add(match[1] ?? match[2] ?? match[3] ?? "");
	}
	return keys;
}

async function snapshot(root: string): Promise<Snapshot> {
	const hostModulePath = Bun.resolveSync("@oh-my-pi/pi-coding-agent/config/settings-ui", root);
	const { createSettingsHost } = await importFromRoot(
		root,
		"@oh-my-pi/pi-coding-agent/config/settings-ui",
	);
	const { SETTING_TABS } = await importFromRoot(root, "@oh-my-pi/pi-tui/overlays/settings-defs");
	const { BUILTIN_SLASH_COMMANDS_INTERNAL } = await importFromRoot(
		root,
		"@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry",
	);
	const { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES } = await importFromRoot(
		root,
		"@oh-my-pi/pi-coding-agent/tools/builtin-names",
	);
	const layoutFile = join(root, "lib/sdk-settings/settings-layout.ts");
	const { HIDDEN_SETTING_PATHS, ADVANCED_SETTING_PATHS, WEB_TRUE_CONDITIONS, TAB_SECTION_ORDER } =
		(await import(layoutFile)) as {
			HIDDEN_SETTING_PATHS: Record<string, true>;
			ADVANCED_SETTING_PATHS: Record<string, true>;
			WEB_TRUE_CONDITIONS: Record<string, string>;
			TAB_SECTION_ORDER: Record<string, readonly string[]>;
		};

	const settings: SettingRow[] = createSettingsHost().entries.map(
		(entry: {
			path: string;
			type: string;
			defaultValue: unknown;
			ui?: { tab: string; group?: string; condition?: string };
		}) => ({
			path: entry.path,
			type: entry.type,
			default: jsonSafe(entry.defaultValue),
			tab: entry.ui?.tab ?? "",
			group: entry.ui?.group ?? null,
			hasUi: entry.ui !== undefined,
			condition: entry.ui?.condition ?? null,
			hidden: Object.hasOwn(HIDDEN_SETTING_PATHS, entry.path),
			advanced: Object.hasOwn(ADVANCED_SETTING_PATHS, entry.path),
			webTrueCondition: Object.hasOwn(WEB_TRUE_CONDITIONS, entry.path)
				? WEB_TRUE_CONDITIONS[entry.path]!
				: null,
		}),
	);

	const builtins: BuiltinRow[] = BUILTIN_SLASH_COMMANDS_INTERNAL.map(
		(spec: {
			name: string;
			aliases?: string[];
			subcommands?: { name: string }[];
			handle?: unknown;
		}) => ({
			name: spec.name,
			aliases: [...(spec.aliases ?? [])],
			subcommands: (spec.subcommands ?? []).map((sub) => sub.name),
			sdkHandled: spec.handle !== undefined,
		}),
	);

	const cards = rendererKeys(root);
	const tools: ToolRow[] = [...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES].map((name: string) => ({
		name,
		hasCard: cards.has(name),
	}));

	return {
		sdkVersion: packageVersion(hostModulePath),
		settings,
		tabs: [...SETTING_TABS],
		tabSectionOrder: Object.fromEntries(
			Object.entries(TAB_SECTION_ORDER).map(([tab, names]) => [tab, [...names]]),
		),
		builtins,
		tools,
		layout: {
			hidden: Object.keys(HIDDEN_SETTING_PATHS),
			advanced: Object.keys(ADVANCED_SETTING_PATHS),
			webTrue: { ...WEB_TRUE_CONDITIONS },
		},
	};
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function load(file: string): Snapshot {
	const parsed = JSON.parse(readFileSync(resolve(file), "utf8")) as Snapshot;
	return {
		...parsed,
		settings: parsed.settings ?? [],
		tabs: parsed.tabs ?? [],
		tabSectionOrder: parsed.tabSectionOrder ?? {},
		builtins: parsed.builtins ?? [],
		tools: parsed.tools ?? [],
		layout: parsed.layout ?? { hidden: [], advanced: [], webTrue: {} },
	};
}

function byKey<T>(rows: T[], key: (row: T) => string): Map<string, T> {
	return new Map(rows.map((row) => [key(row), row] as const));
}

function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Compact one-line JSON for a value, clipped. */
function show(value: unknown): string {
	const text = JSON.stringify(value) ?? "null";
	return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

const label = (value: string | null): string => (value === null || value === "" ? "(none)" : value);

function webPlacement(row: SettingRow, after: Snapshot): string {
	const notes: string[] = [];
	let placement: string;
	if (row.hidden) placement = "hidden";
	else if (row.advanced) placement = `advanced (${row.tab}/Advanced)`;
	else {
		placement = `visible in ${row.tab}/${row.group ?? "(ungrouped)"}`;
		const order = after.tabSectionOrder[row.tab];
		if (row.group !== null && row.group !== "" && !order?.includes(row.group)) {
			notes.push("group not in TAB_SECTION_ORDER");
		}
	}
	if (row.condition !== null && row.webTrueCondition !== row.condition) {
		notes.push(`gated by ${row.condition} (web may need WEB_TRUE_CONDITIONS)`);
	}
	return notes.length > 0 ? `${placement}; ${notes.join("; ")}` : placement;
}

const SETTING_FIELDS = ["type", "default", "tab", "group", "condition", "hasUi"] as const;

function diff(beforeFile: string, afterFile: string): string {
	const before = load(beforeFile);
	const after = load(afterFile);
	const out: string[] = [];

	// Settings
	const oldSettings = byKey(before.settings, (row) => row.path);
	const newSettings = byKey(after.settings, (row) => row.path);
	const settingsAdded = after.settings.filter((row) => !oldSettings.has(row.path));
	const settingsRemoved = before.settings.filter((row) => !newSettings.has(row.path));
	const settingsChanged: string[] = [];
	for (const row of after.settings) {
		const old = oldSettings.get(row.path);
		if (!old) continue;
		const fields = SETTING_FIELDS.filter((field) => !same(old[field], row[field])).map(
			(field) => `${field} ${show(old[field])} → ${show(row[field])}`,
		);
		if (fields.length > 0) settingsChanged.push(`- \`${row.path}\`: ${fields.join("; ")}`);
	}

	// Builtins
	const oldBuiltins = byKey(before.builtins, (row) => row.name);
	const newBuiltins = byKey(after.builtins, (row) => row.name);
	const builtinsAdded = after.builtins.filter((row) => !oldBuiltins.has(row.name));
	const builtinsRemoved = before.builtins.filter((row) => !newBuiltins.has(row.name));
	const builtinsChanged: string[] = [];
	for (const row of after.builtins) {
		const old = oldBuiltins.get(row.name);
		if (!old) continue;
		const fields: string[] = [];
		if (old.sdkHandled !== row.sdkHandled) {
			fields.push(
				`**sdkHandled flipped** ${old.sdkHandled} → ${row.sdkHandled} (update SDK_BUILTINS, and the web handler for this command)`,
			);
		}
		if (!same(old.aliases, row.aliases))
			fields.push(`aliases ${show(old.aliases)} → ${show(row.aliases)}`);
		if (!same(old.subcommands, row.subcommands)) {
			fields.push(`subcommands ${show(old.subcommands)} → ${show(row.subcommands)}`);
		}
		if (fields.length > 0) builtinsChanged.push(`- \`/${row.name}\`: ${fields.join("; ")}`);
	}

	// Tools
	const oldTools = byKey(before.tools, (row) => row.name);
	const newTools = byKey(after.tools, (row) => row.name);
	const toolsAdded = after.tools.filter((row) => !oldTools.has(row.name));
	const toolsRemoved = before.tools.filter((row) => !newTools.has(row.name));

	out.push(
		`Surface delta: settings +${settingsAdded.length} -${settingsRemoved.length} ~${settingsChanged.length}, ` +
			`builtins +${builtinsAdded.length} -${builtinsRemoved.length} ~${builtinsChanged.length}, ` +
			`tools +${toolsAdded.length} -${toolsRemoved.length}`,
	);
	out.push(`SDK ${before.sdkVersion} → ${after.sdkVersion}`);

	const section = (heading: string, lines: string[]): void => {
		if (lines.length > 0) out.push(`\n## ${heading}\n\n${lines.join("\n")}`);
	};

	section(
		"Settings added",
		settingsAdded.map(
			(row) =>
				`- \`${row.path}\`: type ${row.type}, default ${show(row.default)}, ${row.tab}/${label(row.group)}, ` +
				`condition ${label(row.condition)}, web: ${webPlacement(row, after)}`,
		),
	);

	const stale = {
		hidden: new Set(after.layout.hidden),
		advanced: new Set(after.layout.advanced),
		webTrue: new Set(Object.keys(after.layout.webTrue)),
	};
	section(
		"Settings removed",
		settingsRemoved.map((row) => {
			const flags = [
				stale.hidden.has(row.path) ? "HIDDEN" : "",
				stale.advanced.has(row.path) ? "ADVANCED" : "",
				stale.webTrue.has(row.path) ? "WEB_TRUE" : "",
			].filter(Boolean);
			return `- \`${row.path}\`${flags.map((flag) => `; stale manifest entry: ${flag}`).join("")}`;
		}),
	);
	section("Settings changed", settingsChanged);

	// Tabs
	const tabLines: string[] = [];
	for (const tab of after.tabs)
		if (!before.tabs.includes(tab)) tabLines.push(`- tab added: \`${tab}\``);
	for (const tab of before.tabs)
		if (!after.tabs.includes(tab)) tabLines.push(`- tab removed: \`${tab}\``);
	const sectionRows = new Map<string, number>();
	for (const row of after.settings) {
		if (row.hidden || row.advanced || row.group === null || row.group === "") continue;
		const key = `${row.tab}\t${row.group}`;
		sectionRows.set(key, (sectionRows.get(key) ?? 0) + 1);
	}
	for (const [key, count] of sectionRows) {
		const [tab = "", group = ""] = key.split("\t");
		const order = after.tabSectionOrder[tab];
		if (order === undefined) {
			tabLines.push(`- \`${tab}/${group}\` (${count} rows): tab has no TAB_SECTION_ORDER entry`);
		} else if (!order.includes(group)) {
			tabLines.push(
				`- \`${tab}/${group}\` (${count} rows): section missing from TAB_SECTION_ORDER`,
			);
		}
	}
	const anyRows = new Set(after.settings.map((row) => `${row.tab}\t${row.group ?? ""}`));
	for (const [tab, names] of Object.entries(after.tabSectionOrder)) {
		if (!after.tabs.includes(tab))
			tabLines.push(`- TAB_SECTION_ORDER lists \`${tab}\`, which is not an SDK tab`);
		for (const name of names) {
			if (!anyRows.has(`${tab}\t${name}`))
				tabLines.push(`- \`${tab}/${name}\`: in TAB_SECTION_ORDER but no SDK rows`);
		}
	}
	section("Tabs", tabLines);

	section("Builtins", [
		...builtinsAdded.map(
			(row) =>
				`- added \`/${row.name}\`: aliases ${show(row.aliases)}, subcommands ${show(row.subcommands)}, ` +
				`sdkHandled ${row.sdkHandled}`,
		),
		...builtinsRemoved.map((row) => `- removed \`/${row.name}\``),
		...builtinsChanged.map((line) => `- changed ${line.slice(2)}`),
	]);

	section("Tools", [
		...toolsAdded.map(
			(row) =>
				`- added \`${row.name}\`${row.hasCard ? " (has card)" : ": no dedicated card, GenericToolCard"}`,
		),
		...toolsRemoved.map(
			(row) => `- removed \`${row.name}\`${row.hasCard ? ": stale RENDERERS key" : ""}`,
		),
	]);

	return out.join("\n");
}

// ---------------------------------------------------------------------------

const diffIndex = process.argv.indexOf("--diff");
if (diffIndex !== -1) {
	const beforeFile = process.argv[diffIndex + 1];
	const afterFile = process.argv[diffIndex + 2];
	if (!beforeFile || !afterFile) {
		console.error("usage: surface-snapshot.ts --diff <before.json> <after.json>");
		process.exit(2);
	}
	console.log(diff(beforeFile, afterFile));
} else {
	const root = resolve(arg("root") ?? process.cwd());
	// Await the flush: console.log / Bun.write(Bun.stdout) delivered a truncated or duplicated stream past the 64 KiB pipe buffer (bun 1.4.2).
	const text = `${JSON.stringify(await snapshot(root), null, "\t")}\n`;
	await new Promise<void>((done, fail) =>
		process.stdout.write(text, (error) => (error ? fail(error) : done())),
	);
}
