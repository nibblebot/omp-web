import { For, type Component } from "solid-js";
import { dismissToast, state } from "../../state";
import { XIcon } from "../shared/icons";

/**
 * Fleet/app-scoped ephemeral notification stack (worktree_removed on-disk
 * eviction toasts). Always mounted; reads state.toasts reactively and
 * mutates only through dismissToast (no per-component state for shared
 * data). Each toast carries its own role="status" live region, so the
 * container needs no extra aria-live; the frame handler's announce() covers
 * the screen-reader announcement text.
 */
export const Toasts: Component = () => (
	<div class="toast-list">
		<For each={state.toasts}>
			{(toast) => (
				<div class="toast" role="status">
					<span class="toast-text">{toast.text}</span>
					<button
						type="button"
						class="toast-dismiss"
						aria-label="Dismiss"
						onClick={() => dismissToast(toast.id)}
					>
						<XIcon />
					</button>
				</div>
			)}
		</For>
	</div>
);
