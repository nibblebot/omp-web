import { McpTab } from "../../../../web/components/settings/integrations/McpTab";
import { mcpServers } from "../../../fixtures/overlays";
import { answerCalls } from "../../../daemon";
import { defineStory } from "../../../registry";

const mcpState = {
	servers: mcpServers,
	paths: { user: "/home/dev/.config/omp/mcp.json", project: "/repo/.omp/mcp.json" },
	projectConfigEnabled: true,
};

export default [
	defineStory({
		id: "settings-integrations-mcp-tab",
		title: "McpTab",
		component: {
			file: "apps/web/components/settings/integrations/McpTab.tsx",
			export: "McpTab",
		},
		seed: { currentSessionId: "sess_09a41c" },
		variants: [
			{
				name: "Servers",
				description: "Connected, errored, and disabled servers with the filter and add form entry.",
				seed: () => answerCalls({ getMcpState: () => mcpState }),
				render: () => <McpTab />,
			},
			{
				name: "Loading",
				seed: () => answerCalls({ getMcpState: () => Promise.withResolvers<unknown>().promise }),
				render: () => <McpTab />,
			},
			{
				name: "Load failed",
				seed: () =>
					answerCalls({
						getMcpState: () =>
							Promise.reject(new Error("Could not read the MCP inventory from the daemon.")),
					}),
				render: () => <McpTab />,
			},
		],
	}),
];
