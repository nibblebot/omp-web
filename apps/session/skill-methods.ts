import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { cfgDisabledExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { makeExtensionId } from "@oh-my-pi/pi-tui/overlays/extensions/types";
import type { SkillDetail, SkillsState, SkillSummary, WebMethodName } from "#lib/wire/protocol";
import type { SessionEntry } from "./session-entry";

// Skill inventory and enable/disable. Enabled state is the TUI's
// `disabledExtensions` setting keyed `skill:<name>`, so both UIs agree.
// Invocation stays `/skill:<name>` in the composer. Every change to that
// setting (this module's write, a TUI write, an on-disk edit) is observed by
// `watchSkills`, the single owner of refresh + broadcast.

export interface SkillMethodsDeps {
	broadcastAvailableCommands(entry: SessionEntry): Promise<void>;
	broadcastSkillsChanged(entry: SessionEntry, state: SkillsState): void;
}

type Handler = (entry: SessionEntry, args: unknown[]) => Promise<unknown>;
type SkillMethodName = Extract<
	WebMethodName,
	"getSkillsState" | "getSkillDetail" | "setSkillEnabled"
>;

function skillName(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("skill name is required");
	return value.trim();
}

/** Every discovered skill, including disabled ones, so the dialog can re-enable them. */
async function discoverSkills(entry: SessionEntry) {
	const result = await loadSkills({
		...entry.session.skillsSettings,
		cwd: entry.cwd,
		disabledExtensions: [],
		extensionRoots: entry.session.effectiveExtensionRoots,
	});
	const disabled = new Set(cfgDisabledExtensions.get(entry.session.settings));
	const summarize = (skill: (typeof result.skills)[number]): SkillSummary => ({
		name: skill.name,
		description: skill.description,
		source: skill.source,
		path: skill.filePath,
		enabled: !disabled.has(makeExtensionId("skill", skill.name)),
		hidden: Boolean(skill.hide),
	});
	return { result, summarize };
}

export async function readSkillsState(entry: SessionEntry): Promise<SkillsState> {
	const { result, summarize } = await discoverSkills(entry);
	return {
		skills: result.skills.map(summarize),
		warnings: result.warnings.map((warning) => `${warning.skillPath}: ${warning.message}`),
	};
}

/** A frontmatter string or string array as a non-empty string list (the TUI inspector's `stringArray`). */
function stringList(value: unknown): string[] {
	const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
	return items
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

/** One skill with what the TUI inspector shows: the SKILL.md body without frontmatter, alwaysApply and globs. */
export async function readSkillDetail(entry: SessionEntry, name: string): Promise<SkillDetail> {
	const { result, summarize } = await discoverSkills(entry);
	const skill = result.skills.find((candidate) => candidate.name === name);
	if (!skill) throw new Error(`Unknown skill: ${name}`);
	const { frontmatter, body } = parseFrontmatter(await Bun.file(skill.filePath).text(), {
		source: skill.filePath,
		level: "off",
	});
	return {
		...summarize(skill),
		body,
		alwaysApply: frontmatter.alwaysApply === true,
		globs: stringList(frontmatter.globs),
	};
}

/**
 * Observes `disabledExtensions` for the entry's session. A change, from any
 * writer, refreshes the SDK's skills and commands (serialized there), then
 * advertises the new command list and skill inventory. The setting's `listen`
 * fires after the value is already committed and coalesces per microtask, so
 * the broadcast never carries pre-refresh state. Re-registering replaces the
 * previous listener, so an entry never holds more than one.
 */
export function watchSkills(entry: SessionEntry, deps: SkillMethodsDeps): void {
	entry.skillsUnlisten?.();
	entry.skillsUnlisten = cfgDisabledExtensions.listen(entry.session, async () => {
		await entry.session.refreshSkillsAndCommands();
		await deps.broadcastAvailableCommands(entry);
		deps.broadcastSkillsChanged(entry, await readSkillsState(entry));
	});
}

/** Removes the entry's `disabledExtensions` listener; safe to call twice. */
export function unwatchSkills(entry: SessionEntry): void {
	entry.skillsUnlisten?.();
	entry.skillsUnlisten = undefined;
}

export function createSkillMethods(): Record<SkillMethodName, Handler> {
	return {
		getSkillsState: (entry) => readSkillsState(entry),
		getSkillDetail: async (entry, args) => readSkillDetail(entry, skillName(args[0])),
		// Only validates and writes: the `watchSkills` listener refreshes and broadcasts.
		setSkillEnabled: async (entry, args) => {
			const name = skillName(args[0]);
			const enabled = args[1];
			if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
			const state = await readSkillsState(entry);
			if (!state.skills.some((skill) => skill.name === name))
				throw new Error(`Unknown skill: ${name}`);
			const id = makeExtensionId("skill", name);
			const current = cfgDisabledExtensions.get(entry.session.settings);
			const next = enabled ? current.filter((item) => item !== id) : [...new Set([...current, id])];
			cfgDisabledExtensions.set(entry.session.settings, next);
			return readSkillsState(entry);
		},
	};
}
