import { Show, type Component } from "solid-js";
import { state } from "../../../state";
import { EmptyTranscript } from "./EmptyTranscript";
import { TranscriptFailed, TranscriptSkeleton } from "./TranscriptStates";
import { TranscriptStream } from "./TranscriptStream";
import { useTranscriptTransition } from "./useTranscriptTransition";

/**
 * The session transcript: the sticky-scrolling message stream over the main
 * items plus the states around a session switch. The body (stream or empty
 * state) fades out when a switch starts and back in once loaded; the skeleton
 * and the failed panel overlay it (see useTranscriptTransition). A loaded
 * session with nothing in it shows EmptyTranscript; an idle one (no session)
 * shows nothing.
 */
export const Transcript: Component = () => {
	let view: HTMLDivElement | undefined;
	let body: HTMLDivElement | undefined;
	const { motion, skeletonOpen } = useTranscriptTransition({
		view: () => view,
		body: () => body,
	});

	return (
		<div class="chat-transcript-view" ref={view}>
			<div
				class="chat-transcript-body"
				ref={body}
				data-motion={motion()}
				inert={motion() === "enter"}
			>
				<Show
					when={state.items.length > 0 || state.live.active}
					fallback={
						<Show when={state.transcriptPhase === "loaded"}>
							<EmptyTranscript />
						</Show>
					}
				>
					<TranscriptStream items={state.items} variant="session" />
				</Show>
			</div>
			<TranscriptSkeleton open={skeletonOpen()} />
			<Show when={state.transcriptPhase === "failed"}>
				<TranscriptFailed />
			</Show>
		</div>
	);
};
