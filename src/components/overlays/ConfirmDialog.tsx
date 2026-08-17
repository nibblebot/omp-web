import { Show, type Component } from "solid-js";
import { cancelDangerConfirm, confirmDangerConfirm, dangerConfirm } from "../../danger-confirm";
import { Modal } from "../shared/Modal";

// Danger-confirm dialog (P1 hardening): replaces the native window.confirm
// guards on /new, /drop, and /fresh with the app's own Modal chrome. The
// dialog self-mounts (rendered once from App.tsx, like AskDialog/BtwPanel)
// and renders nothing while no confirm is pending. The confirm state and
// actions live in src/danger-confirm.ts (no solid-js/web) so pure modules
// like commands.ts can drive them; this file owns the Portal/rendering only.

export const DangerConfirmDialog: Component = () => (
	<Show when={dangerConfirm()} keyed>
		{(d) => (
			<Modal title={d.title} onClose={cancelDangerConfirm}>
				<p class="danger-confirm-body">{d.body}</p>
				<div class="ask-actions">
					<button type="button" onClick={cancelDangerConfirm}>
						Cancel
					</button>
					<button type="button" class="danger-confirm-btn" onClick={confirmDangerConfirm}>
						{d.confirmLabel}
					</button>
				</div>
			</Modal>
		)}
	</Show>
);
