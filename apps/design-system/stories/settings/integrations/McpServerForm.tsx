import { McpServerForm } from "../../../../web/components/settings/integrations/McpServerForm";
import {
	EMPTY_MCP_FORM,
	formFromServer,
} from "../../../../web/components/settings/integrations/mcp-form";
import { mcpServers } from "../../../fixtures/overlays";
import { defineStory } from "../../../registry";

export default [
	defineStory({
		id: "settings-integrations-mcp-form",
		title: "McpServerForm",
		component: {
			file: "apps/web/components/settings/integrations/McpServerForm.tsx",
			export: "McpServerForm",
		},
		variants: [
			{
				name: "Add server",
				description: "Empty form; submitting opens the trust review before anything is written.",
				render: (ctx) => <McpServerForm mode="add" initial={EMPTY_MCP_FORM} onDone={ctx.close} />,
			},
			{
				name: "Edit HTTP server",
				description:
					"Key names are prefilled; header values stay hidden and keep their stored value.",
				render: (ctx) => (
					<McpServerForm mode="edit" initial={formFromServer(mcpServers[1])} onDone={ctx.close} />
				),
			},
		],
	}),
];
