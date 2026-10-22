import { IntegrationsDialog } from "../../../../web/components/settings/integrations/IntegrationsDialog";
import { markFeaturesActive } from "../../../../web/features/preferences";
import { setState } from "../../../../web/state";
import { selectExtension } from "../../../../web/store/integrations";
import { answerCalls } from "../../../daemon";
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
		seed: { currentSessionId: "sess_09a41c" },
		variants: [
			{
				name: "Extensions",
				description: "Skills and MCP servers in one list; nothing selected yet.",
				seed: () => answerCalls(extensionCalls()),
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
					selectExtension({ kind: "mcp", name: "filesystem" });
				},
				render: (ctx) => <IntegrationsDialog onClose={ctx.close} />,
			},
			{
				name: "MCP test passed",
				seed: () => {
					answerCalls(extensionCalls());
					preload();
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
					selectExtension({ kind: "mcp", name: "linear" });
					setState("integrations", "mcpTestResult", mcpTestFailed);
				},
				render: (ctx) => <IntegrationsDialog onClose={ctx.close} />,
			},
			{
				name: "Search",
				description: "The search filters both groups; a group with no match collapses.",
				seed: () => {
					answerCalls(extensionCalls());
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
								Promise.reject(new Error("Could not read the MCP inventory from the daemon.")),
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
				name: "Extensions only",
				description:
					"The Plugins feature is off: no tab list, the Extensions title, and the reload button stays.",
				seed: () => {
					markFeaturesActive(["integrations"]);
					answerCalls(extensionCalls());
				},
				render: (ctx) => <IntegrationsDialog onClose={ctx.close} />,
			},
			{
				name: "Plugins only",
				description:
					"The MCP & Skills feature is off: the Plugins list alone under a Plugins title, with no reload button.",
				seed: () => {
					markFeaturesActive(["plugins"]);
					answerCalls({ ...extensionCalls(), listPlugins: () => [] });
				},
				render: (ctx) => <IntegrationsDialog onClose={ctx.close} />,
			},
		],
	}),
];
