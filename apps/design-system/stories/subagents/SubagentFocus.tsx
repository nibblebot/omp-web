import { createSignal, type JSX } from "solid-js";
import { SubagentFocus } from "../../../web/components/subagents/SubagentFocus";
import { setWorkerPin } from "../../../web/subagents/worker-scope";
import type { SubagentInfo } from "../../../web/state";
import { SESSION_ID, seedSubagents, subagentById } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

/** Holds the follow flag in a signal so the real follow toggle behaves as it does in the app. */
function FocusHarness(props: { sub: SubagentInfo; initialFollow: boolean }): JSX.Element {
	const [follow, setFollow] = createSignal(props.initialFollow);
	return (
		<SubagentFocus
			sub={props.sub}
			sessionId={SESSION_ID}
			follow={follow()}
			onFollowChange={setFollow}
			onBack={() => undefined}
		/>
	);
}

export default defineStory({
	id: "subagents-subagent-focus",
	title: "SubagentFocus",
	component: { file: "apps/web/components/subagents/SubagentFocus.tsx", export: "SubagentFocus" },
	variants: [
		{
			name: "Running builder, following",
			seed: () => {
				setWorkerPin("1-FixtureBuilder", "full");
				seedSubagents();
			},
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<FocusHarness sub={subagentById("1-FixtureBuilder")} initialFollow />
				</div>
			),
		},
		{
			name: "Completed explore, read-only tail",
			seed: () => {
				setWorkerPin("0-ChatMap", "full");
				seedSubagents();
			},
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<FocusHarness sub={subagentById("0-ChatMap")} initialFollow={false} />
				</div>
			),
		},
		{
			name: "Advisor, read-only",
			seed: () => {
				setWorkerPin("3-AdvisorA", "full");
				seedSubagents();
			},
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<FocusHarness sub={subagentById("3-AdvisorA")} initialFollow />
				</div>
			),
		},
		{
			name: "Artifact missing",
			description: "The reviewer failed without an artifact, so its transcript cannot load.",
			seed: () => {
				setWorkerPin("2-ReviewPass", "full");
				seedSubagents();
			},
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<FocusHarness sub={subagentById("2-ReviewPass")} initialFollow={false} />
				</div>
			),
		},
		{
			name: "Collapsed pin",
			seed: () => {
				setWorkerPin("1-FixtureBuilder", "collapsed");
				seedSubagents();
			},
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<FocusHarness sub={subagentById("1-FixtureBuilder")} initialFollow />
				</div>
			),
		},
	],
});
