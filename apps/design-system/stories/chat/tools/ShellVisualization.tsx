import { createSignal } from "solid-js";
import type { ShellVizMode } from "../../../../web/chat/shell-viz";
import { ShellVisualization } from "../../../../web/components/chat/tools/ShellVisualization";
import {
	shellVizBuild,
	shellVizReplayAt,
	shellVizRetry,
	shellVizRunning,
	shellVizTruncated,
	type ShellVizFixture,
} from "../../../fixtures/shell-viz";
import { defineStory } from "../../../registry";

/** The view with its tab and scrubber state, as `ShellVisualizer` drives it; the scrubber replays the fixture locally. */
function Interactive(props: { view: ShellVizFixture; mode?: ShellVizMode; idPrefix: string }) {
	const [mode, setMode] = createSignal<ShellVizMode>(props.mode ?? "pseudo");
	const [cursor, setCursor] = createSignal<number>(props.view.timeline.cursor);
	const view = () => shellVizReplayAt(props.view, cursor());
	return (
		<div class="ds-frame">
			<ShellVisualization
				view={view()}
				mode={mode()}
				onMode={setMode}
				cursor={cursor()}
				onCursor={setCursor}
				idPrefix={props.idPrefix}
			/>
		</div>
	);
}

export default defineStory({
	id: "chat-tools-shell-visualization",
	title: "ShellVisualization",
	component: {
		file: "apps/web/components/chat/tools/ShellVisualization.tsx",
		export: "ShellVisualization",
	},
	variants: [
		{
			name: "Pseudo",
			description:
				"The SDK's Python-like rendering of a finished loop: toned tokens, the loop's last variable values after the statement that set them, and a failed command marked in the error tone with its exit status.",
			render: () => <Interactive view={shellVizRetry} idPrefix="viz-pseudo" />,
		},
		{
			name: "Raw",
			description: "The script as written, with the same marks and notes.",
			render: () => <Interactive view={shellVizRetry} mode="raw" idPrefix="viz-raw" />,
		},
		{
			name: "Failure",
			description:
				"A build whose commands exit 1: each failed command carries a × mark before it and its exit status after.",
			render: () => <Interactive view={shellVizBuild} idPrefix="viz-failure" />,
		},
		{
			name: "Replay",
			description:
				"The scrubber steps through the retained history; rows the run had not reached yet draw faint and lose their notes. Jump to end returns to the final state.",
			render: () => (
				<Interactive view={shellVizReplayAt(shellVizRetry, 24)} idPrefix="viz-replay" />
			),
		},
		{
			name: "Running",
			description:
				"A call still executing: the running statement carries the ▶ gutter, every other row is faint, and there is no scrubber until the run ends.",
			render: () => <Interactive view={shellVizRunning} idPrefix="viz-running" />,
		},
		{
			name: "Truncated",
			description: "A huge script cut to the answer budget: a note counts the rows left out,.",
			render: () => <Interactive view={shellVizTruncated} idPrefix="viz-truncated" />,
		},
	],
});
