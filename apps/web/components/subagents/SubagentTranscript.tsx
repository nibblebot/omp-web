import { createEffect, Show, type Component } from "solid-js";
import { subagentTranscript, syncSubagentTranscript } from "../../store/subagents";
import { TranscriptStream } from "../chat/transcript/TranscriptStream";

/**
 * Live transcript of one agent, drawn with the main chat's own cards. Fills
 * its parent and holds the scroller: it pins to the live edge, with a
 * jump-to-live control once the user scrolls away.
 */
export const SubagentTranscript: Component<{ id: string }> = (props) => {
	createEffect(() => syncSubagentTranscript(props.id));
	const transcript = () => subagentTranscript(props.id);
	return (
		<TranscriptStream items={transcript().items} variant="agent" class="subagent-transcript">
			<Show when={transcript().loading}>
				<p class="subagent-transcript-status">Loading transcript…</p>
			</Show>
			<Show when={transcript().error}>
				{(error) => (
					<p class="subagent-transcript-error" role="alert">
						{error()}
					</p>
				)}
			</Show>
		</TranscriptStream>
	);
};
