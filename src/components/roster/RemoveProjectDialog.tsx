import { createEffect, createSignal, For, Show, type Component } from "solid-js";
import { sendRemoveProject, setState, state } from "../../state";
import { Modal } from "../shared/Modal";

// Remove-project confirm (Phase 5 close-out): deregister a first-class
// project — never touches disk. Self-mounts (rendered once from App.tsx
// like DangerConfirmDialog) and renders nothing while no target is set.
// A removal refused by the server (any roster entry still references the
// project) lands as a global error frame naming the blockers; the dialog
// keeps the referencing-daemon list on screen and stays open so the user
// can stop/remove them first. A successful removal drops the project from
// the registry, which closes the dialog.

export const RemoveProjectDialog: Component = () => {
	const [refusal, setRefusal] = createSignal<string | null>(null);
	// Baseline error at open/confirm: a LATER error frame is the refusal.
	let errorAtOpen: string | null | undefined;
	let lastTarget: string | null = null;

	const target = () => state.removeProjectTarget;
	const project = () => state.registeredProjects.find((p) => p.projectId === target());
	/** Referencing daemons — the removal blockers (server names these in its refusal). */
	const blockers = () => state.daemonRoster.filter((d) => d.projectId === target());

	createEffect(() => {
		const id = target();
		if (id === null) {
			lastTarget = null;
			return;
		}
		// Fresh baseline per open: only errors AFTER the dialog opened (or a
		// retry was sent) count as the refusal.
		if (lastTarget !== id) {
			lastTarget = id;
			errorAtOpen = state.error;
			setRefusal(null);
		}
		// Success path: the project left the registry — dismiss.
		if (project() === undefined) {
			setState("removeProjectTarget", null);
			return;
		}
		const err = state.error;
		if (err !== null && err !== errorAtOpen) {
			errorAtOpen = err;
			setRefusal(err);
		}
	});

	const confirmRemove = () => {
		const id = target();
		if (id === null) return;
		errorAtOpen = state.error;
		setRefusal(null);
		sendRemoveProject(id);
	};

	const close = () => {
		setState("removeProjectTarget", null);
	};

	return (
		<Show when={target() !== null && project() !== undefined}>
			<Modal title="Remove project" onClose={close}>
				<p class="danger-confirm-body">
					Remove <span class="worktree-evidence-path">{project()!.name}</span> from the fleet
					roster? Disk contents stay untouched — this only deregisters the project.
				</p>
				<Show when={blockers().length > 0}>
					<div class="worktree-blockers">
						<span class="daemon-detail-label">referenced by</span>
						<For each={blockers()}>
							{(d) => (
								<span class="daemon-chip" title={d.cwd}>
									{d.name} ({d.status})
								</span>
							)}
						</For>
					</div>
				</Show>
				<Show when={refusal() !== null}>
					<div class="msg-notice worktree-error">{refusal()}</div>
				</Show>
				<div class="ask-actions">
					<button type="button" onClick={close}>
						Cancel
					</button>
					<button type="button" class="danger-confirm-btn" onClick={confirmRemove}>
						Remove project
					</button>
				</div>
			</Modal>
		</Show>
	);
};
