import type {
	McpInspection,
	McpServerSummary,
	McpTestResult,
	SkillSummary,
} from "#lib/wire/protocol";

export type IntegrationTab = "mcp" | "skills" | "plugins";

export interface IntegrationState {
	tab: IntegrationTab;
	mcpServers: McpServerSummary[];
	mcpPaths: { user: string; project: string } | null;
	mcpProjectConfigEnabled: boolean;
	mcpLoading: boolean;
	mcpError: string | null;
	mcpTestResult: { server: string; result: McpTestResult } | null;
	mcpInspection: { server: string; inspection: McpInspection } | null;
	mcpInspecting: boolean;
	skills: SkillSummary[];
	skillWarnings: string[];
	skillsLoading: boolean;
	skillsError: string | null;
}

export function createIntegrationState(): IntegrationState {
	return {
		tab: "mcp" as IntegrationTab,
		mcpServers: [] as McpServerSummary[],
		mcpPaths: null as { user: string; project: string } | null,
		mcpProjectConfigEnabled: false,
		mcpLoading: false,
		mcpError: null as string | null,
		mcpTestResult: null as { server: string; result: McpTestResult } | null,
		mcpInspection: null as { server: string; inspection: McpInspection } | null,
		mcpInspecting: false,
		skills: [] as SkillSummary[],
		skillWarnings: [] as string[],
		skillsLoading: false,
		skillsError: null as string | null,
	};
}
