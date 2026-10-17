import { OnboardingProgress } from "../../../../web/components/fleet/workspaces/onboarding";
import { rosterDaemon } from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

const projectLabels = ["Register project", "Start session process", "Attach session"];
const worktreeLabels = ["Create worktree", "Start session process", "Attach session"];

export default defineStory({
	id: "fleet-workspaces-onboarding-progress",
	title: "OnboardingProgress",
	component: {
		file: "apps/web/components/fleet/workspaces/onboarding.tsx",
		export: "OnboardingProgress",
	},
	seed: () => seedRosterFleet(),
	variants: [
		{
			name: "Registering project",
			render: () => (
				<OnboardingProgress
					stage={() => ({ kind: "creating" })}
					labels={projectLabels}
					note="Registering omp-web with the fleet"
					prefix="project"
				/>
			),
		},
		{
			name: "Starting session process",
			render: () => (
				<OnboardingProgress
					stage={() => ({ kind: "spawning", daemonId: rosterDaemon.starting.daemonId })}
					labels={projectLabels}
					note={`Starting ${rosterDaemon.starting.daemonId}`}
					prefix="project"
				/>
			),
		},
		{
			name: "Attaching session",
			render: () => (
				<OnboardingProgress
					stage={() => ({ kind: "attaching", daemonId: rosterDaemon.worktree.daemonId })}
					labels={worktreeLabels}
					note={`Attaching to ${rosterDaemon.worktree.daemonId}`}
					prefix="worktree"
				/>
			),
		},
	],
});
