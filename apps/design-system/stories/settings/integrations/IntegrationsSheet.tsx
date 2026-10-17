import { IntegrationsSheet } from "../../../../web/components/settings/integrations/IntegrationsSheet";
import { setState } from "../../../../web/state";
import {
	mcpInspectionTools,
	mcpServers,
	mcpTestFailed,
	mcpTestPassed,
	skillEntries,
} from "../../../fixtures/overlays";
import { answerCalls } from "../../../daemon";
import { defineStory } from "../../../registry";

const mcpState = {
	servers: mcpServers,
	paths: { user: "/home/dev/.config/omp/mcp.json", project: "/repo/.omp/mcp.json" },
	projectConfigEnabled: true,
};
const skillsState = { skills: skillEntries, warnings: [] };

export default [
	defineStory({
		id: "settings-integrations-sheet",
		title: "IntegrationsSheet",
		component: {
			file: "apps/web/components/settings/integrations/IntegrationsSheet.tsx",
			export: "IntegrationsSheet",
		},
		tabs: true,
		seed: { currentSessionId: "sess_09a41c" },
		variants: [
			{
				name: "MCP servers",
				description: "One connected, one errored with an expired OAuth token, one disabled.",
				seed: () => answerCalls({ getMcpState: () => mcpState, getSkillsState: () => skillsState }),
				render: (ctx) => <IntegrationsSheet onClose={ctx.close} />,
			},
			{
				name: "MCP test passed",
				seed: () => {
					answerCalls({ getMcpState: () => mcpState, getSkillsState: () => skillsState });
					setState("integrations", "mcpTestResult", mcpTestPassed);
				},
				render: (ctx) => <IntegrationsSheet onClose={ctx.close} />,
			},
			{
				name: "MCP test failed",
				seed: () => {
					answerCalls({ getMcpState: () => mcpState, getSkillsState: () => skillsState });
					setState("integrations", "mcpTestResult", mcpTestFailed);
				},
				render: (ctx) => <IntegrationsSheet onClose={ctx.close} />,
			},
			{
				name: "MCP inspection result",
				description: "Tool list returned after inspecting a connected server.",
				seed: () => {
					answerCalls({ getMcpState: () => mcpState, getSkillsState: () => skillsState });
					setState("integrations", "mcpInspection", mcpInspectionTools);
				},
				render: (ctx) => <IntegrationsSheet onClose={ctx.close} />,
			},
			{
				name: "MCP loading",
				seed: () =>
					answerCalls({
						getMcpState: () => Promise.withResolvers<unknown>().promise,
						getSkillsState: () => skillsState,
					}),
				render: (ctx) => <IntegrationsSheet onClose={ctx.close} />,
			},
			{
				name: "MCP load failed",
				seed: () =>
					answerCalls({
						getMcpState: () =>
							Promise.reject(new Error("Could not read the MCP inventory from the daemon.")),
						getSkillsState: () => skillsState,
					}),
				render: (ctx) => <IntegrationsSheet onClose={ctx.close} />,
			},
			{
				name: "Skills",
				description: "Project and user skills, one turned off and hidden from the listing.",
				seed: () => {
					answerCalls({ getMcpState: () => mcpState, getSkillsState: () => skillsState });
					setState("integrations", "tab", "skills");
				},
				render: (ctx) => <IntegrationsSheet onClose={ctx.close} />,
			},
			{
				name: "Skills loading",
				seed: () => {
					answerCalls({
						getMcpState: () => mcpState,
						getSkillsState: () => Promise.withResolvers<unknown>().promise,
					});
					setState("integrations", "tab", "skills");
				},
				render: (ctx) => <IntegrationsSheet onClose={ctx.close} />,
			},
			{
				name: "Skills load failed",
				seed: () => {
					answerCalls({
						getMcpState: () => mcpState,
						getSkillsState: () => Promise.reject(new Error("Skill index could not be read.")),
					});
					setState("integrations", "tab", "skills");
				},
				render: (ctx) => <IntegrationsSheet onClose={ctx.close} />,
			},
		],
	}),
];
