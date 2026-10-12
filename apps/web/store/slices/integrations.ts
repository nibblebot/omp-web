export interface McpServerEntry {
	name: string;
	transport?: string;
	enabled?: boolean;
	status?: string;
	error?: string | null;
	source?: string;
}
export interface SkillEntry {
	id: string;
	source?: string;
	version?: string;
	enabled?: boolean;
	description?: string;
}
export interface PluginEntry extends SkillEntry {}
export type IntegrationScope = "project" | "profile";
export interface IntegrationState {
	mcpServers: McpServerEntry[];
	mcpLoading: boolean;
	mcpError: string | null;
	mcpUnavailable: string | null;
	mcpTestResult: { server: string; text: string } | null;
	mcpInspection: { server: string; kind: string; text: string } | null;
	mcpInspecting: boolean;
	skills: SkillEntry[];
	plugins: PluginEntry[];
	skillsLoading: boolean;
	skillsError: string | null;
	skillsUnavailable: string | null;
	skillResults: SkillEntry[];
	skillSearching: boolean;
	smitheryAvailable: boolean;
	reloadStatus: string | null;
}
export function createIntegrationState(): IntegrationState {
	return {
		mcpServers: [] as McpServerEntry[],
		mcpLoading: false,
		mcpError: null as string | null,
		mcpUnavailable: null as string | null,
		mcpTestResult: null as { server: string; text: string } | null,
		mcpInspection: null as { server: string; kind: string; text: string } | null,
		mcpInspecting: false,
		skills: [] as SkillEntry[],
		plugins: [] as PluginEntry[],
		skillsLoading: false,
		skillsError: null as string | null,
		skillsUnavailable: null as string | null,
		skillResults: [] as SkillEntry[],
		skillSearching: false,
		smitheryAvailable: false,
		reloadStatus: null as string | null,
	};
}
