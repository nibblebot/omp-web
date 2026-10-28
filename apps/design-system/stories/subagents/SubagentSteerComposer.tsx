import { SubagentSteerComposer } from "../../../web/components/subagents/SubagentSteerComposer";
import { setFocusDraft } from "../../../web/subagents/worker-scope";
import { defineStory } from "../../registry";

const noop = () => {};
const delivered = () => Promise.resolve(true);

export default defineStory({
	id: "subagents-steer-composer",
	title: "SubagentSteerComposer",
	component: {
		file: "apps/web/components/subagents/SubagentSteerComposer.tsx",
		export: "SubagentSteerComposer",
	},
	variants: [
		{
			name: "Empty",
			description:
				"Text only: Enter sends and Shift+Enter adds a line (on a touch screen Enter adds the line and Send sends; the Enter Key preference in Appearance overrides). Send is disabled until there is text; Stop asks for a second click to confirm.",
			render: () => (
				<SubagentSteerComposer
					id="FixtureBuilder"
					canAbort
					pending={false}
					onSend={delivered}
					onAbort={noop}
				/>
			),
		},
		{
			name: "Restored draft",
			description: "The per-agent draft (key `agent:<id>`) survives switching away and back.",
			seed: () => setFocusDraft("agent:FixtureBuilder", "Skip the lint pass, it is covered by CI."),
			render: () => (
				<SubagentSteerComposer
					id="FixtureBuilder"
					canAbort
					pending={false}
					onSend={delivered}
					onAbort={noop}
				/>
			),
		},
		{
			name: "No abort offered",
			description: "When the agent does not offer abort, the Stop button is hidden.",
			seed: () => setFocusDraft("agent:FixtureBuilder", "Use the existing badge style."),
			render: () => (
				<SubagentSteerComposer
					id="FixtureBuilder"
					canAbort={false}
					pending={false}
					onSend={delivered}
					onAbort={noop}
				/>
			),
		},
		{
			name: "Action in flight",
			description: "While a lifecycle action runs, send and Stop are disabled.",
			seed: () => setFocusDraft("agent:FixtureBuilder", "Use the existing badge style."),
			render: () => (
				<SubagentSteerComposer
					id="FixtureBuilder"
					canAbort
					pending
					onSend={delivered}
					onAbort={noop}
				/>
			),
		},
	],
});
