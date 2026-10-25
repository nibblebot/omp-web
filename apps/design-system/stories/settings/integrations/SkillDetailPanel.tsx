import type { Component } from "solid-js";
import { SkillDetailPanel } from "../../../../web/components/settings/integrations/SkillDetailPanel";
import { setState, state } from "../../../../web/state";
import { loadSkillDetail } from "../../../../web/store/integrations";
import { answerCalls } from "../../../session";
import { extensionCalls, skillsStateFixture } from "../../../fixtures/extensions";
import { defineStory } from "../../../registry";
import type { CallHandlers } from "../../../session";

/** The panel shows the store's row for `name`, as the tab passes it. */
const Panel: Component<{ name: string }> = (props) => {
	const skill = () => state.integrations.skills.find((s) => s.name === props.name);
	return (
		<div class="ds-frame ds-frame-column ds-frame-panel">
			{skill() && <SkillDetailPanel skill={skill()!} />}
		</div>
	);
};

function open(name: string, overrides: CallHandlers = {}): void {
	answerCalls(extensionCalls(overrides));
	setState("integrations", "skills", skillsStateFixture.skills);
	loadSkillDetail(name);
}

export default defineStory({
	id: "settings-integrations-skill-detail-panel",
	title: "SkillDetailPanel",
	component: {
		file: "apps/web/components/settings/integrations/SkillDetailPanel.tsx",
		export: "SkillDetailPanel",
	},
	seed: { currentWorkspaceId: "sess_09a41c" },
	variants: [
		{
			name: "Enabled skill",
			description:
				"Origin, glob, and the SKILL.md body as sanitized markdown (the script tag does not run).",
			seed: () => open("pdf-extract"),
			render: () => <Panel name="pdf-extract" />,
		},
		{
			name: "Disabled, hidden, always applied",
			seed: () => open("changelog"),
			render: () => <Panel name="changelog" />,
		},
		{
			name: "Loading",
			seed: () =>
				open("pdf-extract", { getSkillDetail: () => Promise.withResolvers<unknown>().promise }),
			render: () => <Panel name="pdf-extract" />,
		},
		{
			name: "Load failed",
			seed: () =>
				open("pdf-extract", {
					getSkillDetail: () => Promise.reject(new Error("Unknown skill: pdf-extract")),
				}),
			render: () => <Panel name="pdf-extract" />,
		},
	],
});
