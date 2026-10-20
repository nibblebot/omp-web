import { Show, type Component } from "solid-js";
import { characterForModel } from "../../../sprites/characters";
import { state } from "../../../state";
import { CharacterAvatar } from "../../models/CharacterAvatar";
import { TranscriptStream } from "./TranscriptStream";

/** Empty-transcript state: large character sprite and a one-line greeting.
 *  Held blank until the loaded transcript's state frame lands (modelSynced):
 *  history primes before state, so rendering earlier would flash the
 *  previous session's (or the fallback) character. */
const EmptyState: Component = () => (
	<div class="chat-transcript-empty">
		<Show when={state.modelSynced}>
			<CharacterAvatar
				provider={state.model?.provider}
				id={state.model?.id}
				pose="happy"
				size={96}
			/>
			<p class="chat-transcript-empty-greeting">
				{characterForModel(state.model?.provider, state.model?.id).name} is ready. What should we
				work on?
			</p>
		</Show>
	</div>
);

/**
 * The session transcript: the sticky-scrolling message stream over the main
 * items. Shows the greeting empty state while there are no items and no live
 * turn.
 */
export const Transcript: Component = () => (
	<Show when={state.items.length > 0 || state.live.active} fallback={<EmptyState />}>
		<TranscriptStream items={state.items} variant="session" />
	</Show>
);
