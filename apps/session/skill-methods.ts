import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { cfgDisabledExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { makeExtensionId } from "@oh-my-pi/pi-tui/overlays/extensions/types";
import type { SkillsState, SkillSummary, WebMethodName } from "#lib/wire/protocol";
import type { SessionEntry } from "./session-entry";

// Skill inventory and enable/disable. Enabled state is the TUI's
// `disabledExtensions` setting keyed `skill:<name>`, so both UIs agree.
// Invocation stays `/skill:<name>` in the composer.

export interface SkillMethodsDeps {
	broadcastAvailableCommands(entry: SessionEntry): Promise<void>;
}

type Handler = (entry: SessionEntry, args: unknown[]) => Promise<unknown>;
type SkillMethodName = Extract<WebMethodName, "getSkillsState" | "setSkillEnabled">;

function skillName(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("skill name is required");
	return value.trim();
}

/** Lists every discovered skill, including disabled ones, so the sheet can re-enable them. */
export async function readSkillsState(entry: SessionEntry): Promise<SkillsState> {
	const disabled = new Set(cfgDisabledExtensions.get(entry.session.settings));
	const result = await loadSkills({
		...entry.session.skillsSettings,
		cwd: entry.cwd,
		disabledExtensions: [],
		extensionRoots: entry.session.effectiveExtensionRoots,
	});
	const skills: SkillSummary[] = result.skills.map((skill) => ({
		name: skill.name,
		description: skill.description,
		source: skill.source,
		path: skill.filePath,
		enabled: !disabled.has(makeExtensionId("skill", skill.name)),
		hidden: Boolean(skill.hide),
	}));
	return {
		skills,
		warnings: result.warnings.map((warning) => `${warning.skillPath}: ${warning.message}`),
	};
}

export function createSkillMethods(deps: SkillMethodsDeps): Record<SkillMethodName, Handler> {
	return {
		getSkillsState: (entry) => readSkillsState(entry),
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
			await entry.session.refreshSkillsAndCommands();
			await deps.broadcastAvailableCommands(entry);
			return readSkillsState(entry);
		},
	};
}
