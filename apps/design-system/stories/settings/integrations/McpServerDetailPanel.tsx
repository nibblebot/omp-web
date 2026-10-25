import { createSignal, type Component } from "solid-js";
import type { McpServerSummary } from "#lib/wire/protocol";
import { McpServerDetailPanel } from "../../../../web/components/settings/integrations/McpServerDetailPanel";
import { setState, state } from "../../../../web/state";
import { inspectMcp } from "../../../../web/store/integrations";
import { answerCalls } from "../../../session";
import { extensionCalls, mcpStateFixture } from "../../../fixtures/extensions";
import { mcpTestFailed, mcpTestPassed } from "../../../fixtures/overlays";
import { defineStory } from "../../../registry";
import type { CallHandlers } from "../../../session";

/** The panel shows the store's row for `name`; Edit echoes the server the panel asked to edit. */
const Panel: Component<{ name: string }> = (props) => {
	const [edit, setEdit] = createSignal<string | null>(null);
	const server = (): McpServerSummary | undefined =>
		state.integrations.mcpServers.find((s) => s.name === props.name);
	return (
		<div class="ds-frame ds-frame-column ds-frame-panel">
			{server() && <McpServerDetailPanel server={server()!} onEdit={(s) => setEdit(s.name)} />}
			{edit() && <p class="integrations-hint">Edit requested for {edit()}.</p>}
		</div>
	);
};

function open(name: string, overrides: CallHandlers = {}, inspect = true): void {
	answerCalls(extensionCalls(overrides));
	setState("integrations", "mcpServers", mcpStateFixture.servers);
	if (inspect) inspectMcp(name);
}

export default defineStory({
	id: "settings-integrations-mcp-server-detail-panel",
	title: "McpServerDetailPanel",
	component: {
		file: "apps/web/components/settings/integrations/McpServerDetailPanel.tsx",
		export: "McpServerDetailPanel",
	},
	seed: { currentWorkspaceId: "sess_09a41c" },
	variants: [
		{
			name: "Connected, many tools",
			description:
				"Server name and version, config file the switch writes, ten tools with parameters, then Show all.",
			seed: () => open("filesystem"),
			render: () => <Panel name="filesystem" />,
		},
		{
			name: "Discovered, read-only",
			description: "Declared by another tool: no Edit or Remove, and a three-tool list.",
			seed: () => open("github"),
			render: () => <Panel name="github" />,
		},
		{
			name: "OAuth server with an error",
			description: "The error line and Revoke OAuth.",
			seed: () => open("linear"),
			render: () => <Panel name="linear" />,
		},
		{
			name: "Disabled",
			description: "Tools wait for the switch; the environment key names still show.",
			seed: () => open("postgres", {}, false),
			render: () => <Panel name="postgres" />,
		},
		{
			name: "Test passed",
			seed: () => {
				open("filesystem");
				setState("integrations", "mcpTestResult", mcpTestPassed);
			},
			render: () => <Panel name="filesystem" />,
		},
		{
			name: "Test failed",
			seed: () => {
				open("linear");
				setState("integrations", "mcpTestResult", mcpTestFailed);
			},
			render: () => <Panel name="linear" />,
		},
		{
			name: "Loading tools",
			seed: () =>
				open("filesystem", { mcpInspect: () => Promise.withResolvers<unknown>().promise }),
			render: () => <Panel name="filesystem" />,
		},
		{
			name: "Inspection failed",
			seed: () =>
				open("filesystem", {
					mcpInspect: () => Promise.reject(new Error("Server did not answer tools/list.")),
				}),
			render: () => <Panel name="filesystem" />,
		},
	],
});
