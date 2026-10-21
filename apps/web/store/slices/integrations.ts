import type {
	McpInspection,
	McpServerSummary,
	McpTestResult,
	SkillDetail,
	SkillSummary,
	SkillsState,
} from "#lib/wire/protocol";

export type IntegrationTab = "extensions" | "plugins";

/** The two groups of the Extensions tab. */
export type ExtensionKind = "skill" | "mcp";

/** One selected row of the Extensions tab. */
export interface ExtensionRef {
	kind: ExtensionKind;
	name: string;
}

export interface IntegrationState {
	tab: IntegrationTab;
	/** Extensions search text; filters name, description, and source across both groups. */
	extensionsQuery: string;
	extensionsSelected: ExtensionRef | null;
	/** Group whose first item is selected once its list arrives (set by `/skills`, `/mcp`, the palette). */
	extensionsFocus: ExtensionKind | null;
	/** Narrow layout only: true shows the detail instead of the list. */
	extensionsDrill: boolean;
	/** `kind:name` of every switch with a write in flight. */
	extensionsBusy: string[];
	mcpServers: McpServerSummary[];
	mcpPaths: { user: string; project: string } | null;
	mcpProjectConfigEnabled: boolean;
	mcpLoading: boolean;
	mcpError: string | null;
	mcpTestResult: { server: string; result: McpTestResult } | null;
	mcpInspection: { server: string; inspection: McpInspection } | null;
	/** Name of the server whose inspection is in flight. */
	mcpInspecting: string | null;
	mcpInspectError: { server: string; message: string } | null;
	skills: SkillSummary[];
	skillWarnings: string[];
	/** Bumped whenever a skills state is applied (reply or `skills_changed`); the open detail reloads on it. */
	skillsRevision: number;
	skillsLoading: boolean;
	skillsError: string | null;
	skillDetail: {
		name: string;
		detail: SkillDetail | null;
		loading: boolean;
		error: string | null;
	} | null;
}

export function createIntegrationState(): IntegrationState {
	return {
		tab: "extensions" as IntegrationTab,
		extensionsQuery: "",
		extensionsSelected: null as ExtensionRef | null,
		extensionsFocus: null as ExtensionKind | null,
		extensionsDrill: false,
		extensionsBusy: [] as string[],
		mcpServers: [] as McpServerSummary[],
		mcpPaths: null as { user: string; project: string } | null,
		mcpProjectConfigEnabled: false,
		mcpLoading: false,
		mcpError: null as string | null,
		mcpTestResult: null as { server: string; result: McpTestResult } | null,
		mcpInspection: null as { server: string; inspection: McpInspection } | null,
		mcpInspecting: null as string | null,
		mcpInspectError: null as { server: string; message: string } | null,
		skills: [] as SkillSummary[],
		skillWarnings: [] as string[],
		skillsRevision: 0,
		skillsLoading: false,
		skillsError: null as string | null,
		skillDetail: null as IntegrationState["skillDetail"],
	};
}

/**
 * Store patch that opens the dialog fresh: `tab`, an empty search, no selection, the list showing,
 * and (for the Extensions tab) `group`'s first item to be selected once its list loads. Core
 * openers (the command palette) apply it without importing the feature's store module.
 */
export function integrationsOpenPatch(
	tab: IntegrationTab,
	group: ExtensionKind | null = null,
): Partial<IntegrationState> {
	return {
		tab,
		extensionsQuery: "",
		extensionsSelected: null,
		extensionsFocus: group,
		extensionsDrill: false,
		skillDetail: null,
	};
}

/** Store patch that applies a skills inventory (a `getSkillsState` reply or a `skills_changed` frame). */
export function skillsPatch(
	current: IntegrationState,
	next: SkillsState,
): Partial<IntegrationState> {
	return {
		skills: next.skills,
		skillWarnings: next.warnings,
		skillsRevision: current.skillsRevision + 1,
	};
}
