import type { JSX } from "solid-js";
import { McpTab } from "../../../../web/components/settings/integrations/McpTab";
import { setState } from "../../../../web/state";
import { selectExtension } from "../../../../web/store/integrations";
import { answerCalls } from "../../../session";
import { extensionCalls, mcpStateFixture } from "../../../fixtures/extensions";
import { defineStory } from "../../../registry";

/** The tab fills a column host like the dialog's body; `narrow` squeezes the host so the tab drills. */
const Host = (props: { narrow?: boolean; children: JSX.Element }) => (
	<div
		class="ds-frame ds-frame-column ds-frame-panel"
		classList={{ "ds-frame-narrow": props.narrow }}
	>
		{props.children}
	</div>
);

/** Preloads the inventory, so a selection made in a seed resolves like a click on a loaded list. */
function preload(): void {
	setState("integrations", {
		mcpServers: mcpStateFixture.servers,
		mcpPaths: mcpStateFixture.paths,
		mcpProjectConfigEnabled: true,
	});
}

export default [
	defineStory({
		id: "settings-integrations-mcp-tab",
		title: "McpTab",
		component: {
			file: "apps/web/components/settings/integrations/McpTab.tsx",
			export: "McpTab",
		},
		seed: { currentWorkspaceId: "sess_09a41c" },
		variants: [
			{
				name: "List",
				description:
					"Add server beside the search, the config paths, and a status and switch per row; nothing selected yet.",
				seed: () => answerCalls(extensionCalls()),
				render: () => (
					<Host>
						<McpTab />
					</Host>
				),
			},
			{
				name: "Server detail",
				description: "A connected server's tools load on select.",
				seed: () => {
					answerCalls(extensionCalls());
					preload();
					selectExtension({ kind: "mcp", name: "filesystem" });
				},
				render: () => (
					<Host>
						<McpTab />
					</Host>
				),
			},
			{
				name: "Narrow, detail",
				description: "The detail replaces the list, with Back above it.",
				seed: () => {
					answerCalls(extensionCalls());
					preload();
					selectExtension({ kind: "mcp", name: "filesystem" });
				},
				render: () => (
					<Host narrow>
						<McpTab />
					</Host>
				),
			},
			{
				name: "Nothing matches",
				seed: () => {
					answerCalls(extensionCalls());
					setState("integrations", "extensionsQuery", "zzz");
				},
				render: () => (
					<Host>
						<McpTab />
					</Host>
				),
			},
			{
				name: "Empty",
				description: "No servers: the note points at Add server.",
				seed: () =>
					answerCalls(extensionCalls({ getMcpState: () => ({ ...mcpStateFixture, servers: [] }) })),
				render: () => (
					<Host>
						<McpTab />
					</Host>
				),
			},
			{
				name: "Load failed",
				seed: () =>
					answerCalls(
						extensionCalls({
							getMcpState: () =>
								Promise.reject(
									new Error("Could not read the MCP inventory from the session process."),
								),
						}),
					),
				render: () => (
					<Host>
						<McpTab />
					</Host>
				),
			},
		],
	}),
];
