import { createSignal, For, Show, type Component } from "solid-js";
import type { McpServerSummary } from "#lib/wire/protocol";
import { McpServerRow } from "../../../../web/components/settings/integrations/McpServerRow";
import { mcpServers } from "../../../fixtures/overlays";
import { defineStory } from "../../../registry";

/** One row per server in a plain list; Edit echoes the server name the row asked to edit. */
const RowList: Component<{ servers: McpServerSummary[] }> = (props) => {
	const [edit, setEdit] = createSignal<string | null>(null);
	return (
		<>
			<ul class="integrations-list" aria-label="MCP servers">
				<For each={props.servers}>
					{(server) => <McpServerRow server={server} onEdit={(s) => setEdit(s.name)} />}
				</For>
			</ul>
			<Show when={edit()}>
				{(name) => <p class="integrations-hint">Edit requested for {name()}.</p>}
			</Show>
		</>
	);
};

export default [
	defineStory({
		id: "settings-integrations-mcp-row",
		title: "McpServerRow",
		component: {
			file: "apps/web/components/settings/integrations/McpServerRow.tsx",
			export: "McpServerRow",
		},
		variants: [
			{
				name: "Connected stdio server",
				description:
					"Shows the command, tool count, and Test, Inspect, Reconnect, Edit, Disable, Remove.",
				render: () => <RowList servers={[mcpServers[0]]} />,
			},
			{
				name: "OAuth server with an error",
				description: "Shows the error line and the revoke-OAuth action.",
				render: () => <RowList servers={[mcpServers[1]]} />,
			},
			{
				name: "Disabled server",
				description: "Shows Enable in place of Disable and the key names of its environment.",
				render: () => <RowList servers={[mcpServers[2]]} />,
			},
		],
	}),
];
