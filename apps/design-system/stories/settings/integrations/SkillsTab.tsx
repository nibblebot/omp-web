import type { JSX } from "solid-js";
import { SkillsTab } from "../../../../web/components/settings/integrations/SkillsTab";
import { setState } from "../../../../web/state";
import { selectExtension } from "../../../../web/store/integrations";
import { answerCalls } from "../../../session";
import { extensionCalls, skillsStateFixture } from "../../../fixtures/extensions";
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
	setState("integrations", "skills", skillsStateFixture.skills);
}

export default [
	defineStory({
		id: "settings-integrations-skills-tab",
		title: "SkillsTab",
		component: {
			file: "apps/web/components/settings/integrations/SkillsTab.tsx",
			export: "SkillsTab",
		},
		seed: { currentWorkspaceId: "sess_09a41c" },
		variants: [
			{
				name: "List",
				description: "The skill warning and a switch per row; nothing selected yet.",
				seed: () => answerCalls(extensionCalls()),
				render: () => (
					<Host>
						<SkillsTab />
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
						<SkillsTab />
					</Host>
				),
			},
			{
				name: "Narrow, list",
				description: "A narrow container shows the list alone; picking a row shows its detail.",
				seed: () => answerCalls(extensionCalls()),
				render: () => (
					<Host narrow>
						<SkillsTab />
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
						<SkillsTab />
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
						<SkillsTab />
					</Host>
				),
			},
			{
				name: "Empty",
				description: "No skills: the note says how to install one.",
				seed: () =>
					answerCalls(extensionCalls({ getSkillsState: () => ({ skills: [], warnings: [] }) })),
				render: () => (
					<Host>
						<SkillsTab />
					</Host>
				),
			},
			{
				name: "Load failed",
				seed: () =>
					answerCalls(
						extensionCalls({
							getSkillsState: () => Promise.reject(new Error("Skill index could not be read.")),
						}),
					),
				render: () => (
					<Host>
						<SkillsTab />
					</Host>
				),
			},
		],
	}),
];
