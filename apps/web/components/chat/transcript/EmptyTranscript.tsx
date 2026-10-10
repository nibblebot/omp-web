import { Show, type Component } from "solid-js";
import { characterForModel } from "../../../sprites/characters";
import { state } from "../../../state";
import { CharacterAvatar } from "../../models/CharacterAvatar";

/** Empty-transcript state: large character sprite and a one-line greeting.
 *  Held blank until the loaded transcript's state frame lands (modelSynced):
 *  history primes before state, so rendering earlier would flash the
 *  previous session's (or the fallback) character. */
export const EmptyTranscript: Component = () => (
	<div class="empty-state">
		<Show when={state.modelSynced}>
			<CharacterAvatar
				provider={state.model?.provider}
				id={state.model?.id}
				pose="happy"
				size={96}
			/>
			<p class="empty-greeting">
				{characterForModel(state.model?.provider, state.model?.id).name} is ready. What should we
				work on?
			</p>
		</Show>
	</div>
);
