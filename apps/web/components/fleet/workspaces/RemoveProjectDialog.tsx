import { createEffect, createMemo, createSignal, Show, type Component } from "solid-js";
import { setState, state } from "../../../state";
import { removeProjectAndStop } from "../../../store/projects";
import { Modal } from "../../ui/Modal";

// Remove-project confirm (Phase 5 close-out): deregister a first-class
// project. It never touches disk. Self-mounts (rendered once from App.tsx
// like DangerConfirmDialog) and renders nothing while no target is set.
// When session processes still reference the project, confirming stops and
// evicts them first (removeProjectAndStop), then deregisters the project. A
// refusal the server still sends lands as a global error frame and is shown
// inline while the dialog stays open. A successful removal drops the project
// from the registry, which closes the dialog.

export const RemoveProjectDialog: Component = () => {
	const [refusal, setRefusal] = createSignal<string | null>(null);
	// Baseline error at open/confirm: a LATER error frame is the refusal.
	let errorAtOpen: string | null | undefined;
	let lastTarget: string | null = null;

	const target = () => state.removeProjectTarget;
	const project = () => state.registeredProjects.find((p) => p.projectId === target());
	/** Session processes the removal stops: roster entries referencing the
	 *  project, minus provider-run clones (same filter as removeProjectAndStop). */
	const referencing = createMemo(() =>
		state.daemonRoster.filter((d) => d.projectId === target() && d.workspaceKind !== "clone"),
	);

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
		// Success path: the project left the registry, so dismiss.
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
		removeProjectAndStop(id);
	};

	const close = () => {
		setState("removeProjectTarget", null);
	};

	return (
		<Show when={target() !== null && project() !== undefined}>
			<Modal title="Remove project" onClose={close}>
				<p class="danger-confirm-body">
					Remove <span class="worktree-evidence-path">{project()!.name}</span> from the fleet
					roster?
					<Show
						when={referencing().length > 0}
						fallback={" Disk contents stay untouched; this only deregisters the project."}
					>
						{" "}
						These sessions will be stopped and removed from omp-web. Worktree files are kept.
					</Show>
				</p>
				<Show when={refusal() !== null}>
					<div class="msg-notice worktree-error">{refusal()}</div>
				</Show>
				<div class="ask-actions">
					<button type="button" onClick={close}>
						Cancel
					</button>
					<button type="button" class="danger-confirm-btn" onClick={confirmRemove}>
						{referencing().length === 0
							? "Remove project"
							: `Stop ${referencing().length} ${referencing().length === 1 ? "session" : "sessions"} & remove`}
					</button>
				</div>
			</Modal>
		</Show>
	);
};
