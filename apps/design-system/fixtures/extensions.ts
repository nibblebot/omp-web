import type { McpInspection, SkillsState } from "#lib/wire/protocol";
import type { CallHandlers } from "../session";
import {
	mcpInspectionFewTools,
	mcpInspectionTools,
	mcpServers,
	skillDetails,
	skillEntries,
} from "./overlays";

/** getMcpState answer: the four fixture servers and both config paths. */
export const mcpStateFixture = {
	servers: mcpServers,
	paths: { user: "/home/dev/.config/omp/mcp.json", project: "/repo/.omp/mcp.json" },
	projectConfigEnabled: true,
};

/** getSkillsState answer: the two fixture skills with one warning. */
export const skillsStateFixture: SkillsState = {
	skills: skillEntries,
	warnings: ["Skipped /repo/.omp/skills/broken/SKILL.md: missing description."],
};

/** The inspection `mcpInspect` answers per server name; any other server reports nothing. */
const inspections: Record<string, McpInspection> = {
	filesystem: mcpInspectionTools.inspection,
	github: mcpInspectionFewTools.inspection,
};

/**
 * `answerCalls` handlers for the Extensions dialog: both inventories, skill detail by name, and
 * MCP inspection by server. Pass overrides to make one of them slow or fail.
 */
export function extensionCalls(overrides: CallHandlers = {}): CallHandlers {
	return {
		getMcpState: () => mcpStateFixture,
		getSkillsState: () => skillsStateFixture,
		getSkillDetail: (args) => {
			const detail = skillDetails[String(args[0])];
			if (!detail) throw new Error(`Unknown skill: ${String(args[0])}`);
			return detail;
		},
		mcpInspect: (args) => inspections[String(args[0])] ?? { tools: [], resources: [], prompts: [] },
		...overrides,
	};
}
