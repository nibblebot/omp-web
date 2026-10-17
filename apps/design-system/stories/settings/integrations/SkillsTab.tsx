import { SkillsTab } from "../../../../web/components/settings/integrations/SkillsTab";
import { skillEntries } from "../../../fixtures/overlays";
import { answerCalls } from "../../../daemon";
import { defineStory } from "../../../registry";

const skillsState = { skills: skillEntries, warnings: [] };

export default [
	defineStory({
		id: "settings-integrations-skills-tab",
		title: "SkillsTab",
		component: {
			file: "apps/web/components/settings/integrations/SkillsTab.tsx",
			export: "SkillsTab",
		},
		seed: { currentSessionId: "sess_09a41c" },
		variants: [
			{
				name: "Skills",
				description:
					"One enabled skill with Invoke, one disabled and hidden skill with Invoke disabled.",
				seed: () => answerCalls({ getSkillsState: () => skillsState }),
				render: () => <SkillsTab />,
			},
			{
				name: "No skills",
				seed: () => answerCalls({ getSkillsState: () => ({ skills: [], warnings: [] }) }),
				render: () => <SkillsTab />,
			},
			{
				name: "Loading",
				seed: () => answerCalls({ getSkillsState: () => Promise.withResolvers<unknown>().promise }),
				render: () => <SkillsTab />,
			},
			{
				name: "Load failed",
				seed: () =>
					answerCalls({
						getSkillsState: () => Promise.reject(new Error("Skill index could not be read.")),
					}),
				render: () => <SkillsTab />,
			},
		],
	}),
];
