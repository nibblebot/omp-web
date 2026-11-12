import { IntegrationsDialog } from "../../../../web/components/settings/integrations/IntegrationsDialog";
import { markFeaturesActive } from "../../../../web/features/preferences";
import { setState } from "../../../../web/state";
import { selectExtension, selectIntegrationsTab } from "../../../../web/store/integrations";
import { answerCalls } from "../../../session";
import { extensionCalls, mcpStateFixture, skillsStateFixture } from "../../../fixtures/extensions";
import { mcpTestFailed, mcpTestPassed } from "../../../fixtures/overlays";
import { defineStory } from "../../../registry";

/** Preloads both inventories, so a selection made in a seed resolves like a click on a loaded list. */
function preload(): void {
	setState("integrations", {
		skills: skillsStateFixture.skills,
		mcpServers: mcpStateFixture.servers,
		mcpPaths: mcpStateFixture.paths,
		mcpProjectConfigEnabled: true,
	});
}

export default [
	defineStory({
		id: "settings-integrations-dialog",
		title: "IntegrationsDialog",
		component: {
			file: "apps/web/components/settings/integrations/IntegrationsDialog.tsx",
			export: "IntegrationsDialog",
		},
		tabs: true,
		seed: { currentWorkspaceId: "sess_09a41c" },
		variants: [
			{
				name: "Skills",
				description: "The Skills tab, as the dialog opens by default; nothing selected yet.",
				seed: () => answerCalls(extensionCalls()),
				render: (ctx) => <IntegrationsDialog onClose={ctx.close} />,
			},
			{
				name: "MCP",
				description:
					"Opened on the MCP tab (/mcp): the first server is selected once the list loads.",
				seed: () => {
					answerCalls(extensionCalls());
					selectIntegrationsTab("mcp");
				},
				render: (ctx) => <IntegrationsDialog onClose={ctx.close} />,
			},
			{
				name: "Skill selected",
				description: "A skill's instructions render in the detail pane.",
				seed: () => {
					answerCalls(extensionCalls());
					preload();
					selectExtension({ kind: "skill", name: "pdf-extract" });
				},
				render: (ctx) => <IntegrationsDialog onClose={ctx.close} />,
			},
			{
				name: "MCP server selected",
				description: "A connected server's tools load on select; ten show before Show all.",
				seed: () => {
					answerCalls(extensionCalls());
					preload();
					selectIntegrationsTab("mcp");
					selectExtension({ kind: "mcp", name: "filesystem" });
				},
				render: (ctx) => <IntegrationsDialog onClose={ctx.close} />,
			},
			{
				name: "MCP test passed",
				seed: () => {
					answerCalls(extensionCalls());
					preload();
					selectIntegrationsTab("mcp");
					selectExtension({ kind: "mcp", name: "filesystem" });
					setState("integrations", "mcpTestResult", mcpTestPassed);
				},
				render: (ctx) => <IntegrationsDialog onClose={ctx.close} />,
			},
			{
				name: "MCP test failed",
				description: "The OAuth server with an expired token.",
				seed: () => {
					answerCalls(extensionCalls());
					preload();
					selectIntegrationsTab("mcp");
					selectExtension({ kind: "mcp", name: "linear" });
					setState("integrations", "mcpTestResult", mcpTestFailed);
				},
				render: (ctx) => <IntegrationsDialog onClose={ctx.close} />,
			},
			{
				name: "Search",
				description: "The search filters the visible tab's list.",
				seed: () => {
					answerCalls(extensionCalls());
					selectIntegrationsTab("mcp");
					setState("integrations", "extensionsQuery", "project");
				},
				render: (ctx) => <IntegrationsDialog onClose={ctx.close} />,
			},
			{
				name: "Loading",
				seed: () =>
					answerCalls(
						extensionCalls({
							getMcpState: () => Promise.withResolvers<unknown>().promise,
							getSkillsState: () => Promise.withResolvers<unknown>().promise,
						}),
					),
				render: (ctx) => <IntegrationsDialog onClose={ctx.close} />,
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
							getSkillsState: () => Promise.reject(new Error("Skill index could not be read.")),
						}),
					),
				render: (ctx) => <IntegrationsDialog onClose={ctx.close} />,
			},
			{
				name: "Switch fails",
				description:
					"The write is refused: the switch goes back and the error shows above the list.",
				seed: () =>
					answerCalls(
						extensionCalls({
							setSkillEnabled: () => Promise.reject(new Error("Settings file is read-only.")),
						}),
					),
				render: (ctx) => <IntegrationsDialog onClose={ctx.close} />,
			},
			{
				name: "Plugins",
				description:
					"The CLI install hint, the note on terminal-only plugin UI, and the plugin cards.",
				seed: () => {
					answerCalls({ ...extensionCalls(), listPlugins: () => [] });
					setState("integrations", "tab", "plugins");
				},
				render: (ctx) => <IntegrationsDialog onClose={ctx.close} />,
			},
			{
				name: "Plugins off",
				description:
					"The Plugins feature is off: only the Skills and MCP tabs, under the Extensions title with the reload button.",
				seed: () => {
					markFeaturesActive([]);
					answerCalls(extensionCalls());
				},
				render: (ctx) => <IntegrationsDialog onClose={ctx.close} />,
			},
		],
	}),
];
