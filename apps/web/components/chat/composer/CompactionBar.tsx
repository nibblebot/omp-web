import { Show, type Component } from "solid-js";
import { state } from "../../../state";

/** Strip above the composer while the session compacts (`/compact`, Compact…,
 *  `/handoff`); `state.compacting` mirrors the session's own flag. */
export const CompactionBar: Component = () => (
	<Show when={state.compacting}>
		<div class="compaction-bar" role="status">
			<span class="shimmer-text">Compacting context…</span>
		</div>
	</Show>
);
