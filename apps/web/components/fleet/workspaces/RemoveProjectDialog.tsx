import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js";
import { setState, state } from "../../../state";
import { sendRemoveProject } from "../../../store/projects";
import { Modal } from "../../ui/Modal";

// Remove-project confirm: deregister a project. The fleet stops the project's
// running sessions and drops all of its rows (transcripts kept, disk never
// touched); a project that still owns clone workspaces is refused. Self-mounts
// and renders nothing while no target is set. A refusal lands as a global
// error frame and is shown inline while the dialog stays open. A successful
// removal drops the project from the registry, which closes the dialog.

export const RemoveProjectDialog: Component = () => {
	const [refusal, setRefusal] = createSignal<string | null>(null);
	// Baseline error at open/confirm: a LATER error frame is the refusal.
	let errorAtOpen: string | null | undefined;
	let lastTarget: string | null = null;

	const target = () => state.removeProjectTarget;
	const project = () => state.registeredProjects.find((p) => p.projectId === target());
	/** Running session processes the removal stops (asleep rows are just dropped;
	 *  clones block the removal instead). */
	const running = createMemo(() =>
		state.daemonRoster.filter(
			(d) => d.projectId === target() && d.workspaceKind !== "clone" && d.status !== "asleep",
		),
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
		sendRemoveProject(id);
	};

	const close = () => {
		setState("removeProjectTarget", null);
	};

	return (
		<Show when={target() !== null && project() !== undefined}>
			<Modal title="Remove project" onClose={close}>
				<p class="danger-confirm-body">
					Remove <span class="worktree-evidence-path">{project()!.name}</span> and its workspace
					rows from omp-web? Files on disk and session transcripts are kept.
					<Show when={running().length > 0}> These sessions will be stopped:</Show>
				</p>
				<Show when={running().length > 0}>
					<ul class="worktree-dirty-files" aria-label="Sessions that will stop">
						<For each={running()}>
							{(d) => (
								<li>
									<span class="worktree-evidence-path">{d.branch ?? d.name}</span>
								</li>
							)}
						</For>
					</ul>
				</Show>
				<Show when={refusal() !== null}>
					<div class="msg-notice worktree-error">{refusal()}</div>
				</Show>
				<div class="ask-actions">
					<button type="button" onClick={close}>
						Cancel
					</button>
					<button type="button" class="danger-confirm-btn" onClick={confirmRemove}>
						{running().length === 0
							? "Remove project"
							: `Stop ${running().length} ${running().length === 1 ? "session" : "sessions"} & remove`}
					</button>
				</div>
			</Modal>
		</Show>
	);
};
