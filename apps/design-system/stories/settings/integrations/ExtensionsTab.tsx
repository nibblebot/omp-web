import type { JSX } from "solid-js";
import { ExtensionsTab } from "../../../../web/components/settings/integrations/ExtensionsTab";
import { setState } from "../../../../web/state";
import { selectExtension } from "../../../../web/store/integrations";
import { answerCalls } from "../../../daemon";
import { extensionCalls, mcpStateFixture, skillsStateFixture } from "../../../fixtures/extensions";
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
		id: "settings-integrations-extensions-tab",
		title: "ExtensionsTab",
		component: {
			file: "apps/web/components/settings/integrations/ExtensionsTab.tsx",
			export: "ExtensionsTab",
		},
		seed: { currentSessionId: "sess_09a41c" },
		variants: [
			{
				name: "List",
				description: "Both groups with their counts, the skill warning, and a switch per row.",
				seed: () => answerCalls(extensionCalls()),
				render: () => (
					<Host>
						<ExtensionsTab />
					</Host>
				),
			},
			{
				name: "Skill detail",
				seed: () => {
					answerCalls(extensionCalls());
					preload();
					selectExtension({ kind: "skill", name: "pdf-extract" });
				},
				render: () => (
					<Host>
						<ExtensionsTab />
					</Host>
				),
			},
			{
				name: "MCP server detail",
				seed: () => {
					answerCalls(extensionCalls());
					preload();
					selectExtension({ kind: "mcp", name: "filesystem" });
				},
				render: () => (
					<Host>
						<ExtensionsTab />
					</Host>
				),
			},
			{
				name: "Narrow, list",
				description: "A narrow container shows the list alone; picking a row shows its detail.",
				seed: () => answerCalls(extensionCalls()),
				render: () => (
					<Host narrow>
						<ExtensionsTab />
					</Host>
				),
			},
			{
				name: "Narrow, detail",
				description: "The detail replaces the list, with Back above it.",
				seed: () => {
					answerCalls(extensionCalls());
					preload();
					selectExtension({ kind: "skill", name: "pdf-extract" });
				},
				render: () => (
					<Host narrow>
						<ExtensionsTab />
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
						<ExtensionsTab />
					</Host>
				),
			},
			{
				name: "Empty",
				description: "No skills and no servers: each group says how to add one.",
				seed: () =>
					answerCalls(
						extensionCalls({
							getSkillsState: () => ({ skills: [], warnings: [] }),
							getMcpState: () => ({ ...mcpStateFixture, servers: [] }),
						}),
					),
				render: () => (
					<Host>
						<ExtensionsTab />
					</Host>
				),
			},
		],
	}),
];
