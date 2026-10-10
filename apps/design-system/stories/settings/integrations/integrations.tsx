import { McpManager } from "../../../../web/components/settings/integrations/McpManager";
import { SkillsManager } from "../../../../web/components/settings/integrations/SkillsManager";
import { setState } from "../../../../web/state";
import {
	mcpInspectionTools,
	mcpServers,
	mcpTestFailed,
	mcpTestPassed,
	pluginEntries,
	skillEntries,
} from "../../../fixtures/overlays";
import { answerCalls } from "../../../daemon";
import { defineStory } from "../../../registry";

export default [
	defineStory({
		id: "settings-integrations-mcp-manager",
		title: "McpManager",
		component: {
			file: "apps/web/components/settings/integrations/McpManager.tsx",
			export: "McpManager",
		},
		tabs: true,
		seed: { currentSessionId: "sess_09a41c" },
		variants: [
			{
				name: "Servers connected",
				description:
					"Project and profile servers: one connected, one with an expired token, one disabled.",
				seed: () => answerCalls({ getMcpState: () => ({ servers: mcpServers }) }),
				render: () => <McpManager onClose={() => undefined} />,
			},
			{
				name: "Test passed",
				seed: () => {
					answerCalls({ getMcpState: () => ({ servers: mcpServers }) });
					setState("integrations", "mcpTestResult", mcpTestPassed);
				},
				render: () => <McpManager onClose={() => undefined} />,
			},
			{
				name: "Test failed",
				seed: () => {
					answerCalls({ getMcpState: () => ({ servers: mcpServers }) });
					setState("integrations", "mcpTestResult", mcpTestFailed);
				},
				render: () => <McpManager onClose={() => undefined} />,
			},
			{
				name: "Inspection result",
				description: "Tool list returned after inspecting a connected server.",
				seed: () => {
					answerCalls({ getMcpState: () => ({ servers: mcpServers }) });
					setState("integrations", "mcpInspection", mcpInspectionTools);
				},
				render: () => <McpManager onClose={() => undefined} />,
			},
			{
				name: "Loading",
				seed: () => answerCalls({ getMcpState: () => Promise.withResolvers<unknown>().promise }),
				render: () => <McpManager onClose={() => undefined} />,
			},
			{
				name: "Load failed",
				seed: () =>
					answerCalls({
						getMcpState: () =>
							Promise.reject(new Error("Could not read the MCP inventory from the daemon.")),
					}),
				render: () => <McpManager onClose={() => undefined} />,
			},
		],
	}),
	defineStory({
		id: "settings-integrations-skills-manager",
		title: "SkillsManager",
		component: {
			file: "apps/web/components/settings/integrations/SkillsManager.tsx",
			export: "SkillsManager",
		},
		tabs: true,
		variants: [
			{
				name: "Skills and plugins",
				description: "Project skills and a profile plugin, with the Smithery registry reachable.",
				seed: () =>
					answerCalls({
						getSkillsState: () => ({
							skills: skillEntries,
							plugins: pluginEntries,
							smitheryAvailable: true,
						}),
					}),
				render: () => <SkillsManager onClose={() => undefined} />,
			},
			{
				name: "Smithery unavailable",
				description: "Installed skills stay visible while registry search is offline.",
				seed: () =>
					answerCalls({
						getSkillsState: () => ({
							skills: skillEntries,
							plugins: pluginEntries,
							smitheryAvailable: false,
						}),
					}),
				render: () => <SkillsManager onClose={() => undefined} />,
			},
			{
				name: "Loading",
				seed: () => answerCalls({ getSkillsState: () => Promise.withResolvers<unknown>().promise }),
				render: () => <SkillsManager onClose={() => undefined} />,
			},
			{
				name: "Load failed",
				seed: () =>
					answerCalls({
						getSkillsState: () =>
							Promise.reject(new Error("Skill registry index could not be read.")),
					}),
				render: () => <SkillsManager onClose={() => undefined} />,
			},
		],
	}),
];
