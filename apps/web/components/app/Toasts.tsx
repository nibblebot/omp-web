import { For, Show, type Component } from "solid-js";
import { dismissToast, setState, state } from "../../state";
import { XIcon } from "../ui/icons";

/**
 * App-scoped notification stack: ephemeral notices from state.toasts
 * (auto-dismissing, role="status") plus the current state.error as a sticky
 * error toast (role="alert") that stays until dismissed or replaced by the
 * next error. Always mounted; reads state reactively and holds no shared
 * data of its own. Each toast is its own live region, so the container needs
 * no extra aria-live.
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
		<Show when={state.error}>
			{(error) => (
				<div class="toast toast-error" role="alert">
					<span class="toast-text">{error()}</span>
					<button
						type="button"
						class="toast-dismiss"
						aria-label="Dismiss error"
						onClick={() => setState("error", null)}
					>
						<XIcon />
					</button>
				</div>
			)}
		</Show>
	</div>
);
