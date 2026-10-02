import type { DaemonEntry } from "#lib/wire/protocol";
import { createEffect, createSignal, For, Show, type Component } from "solid-js";
import { sendDeleteWorktree, setState, state } from "../../state";
import { Modal } from "../shared/Modal";

// Delete-workspace confirm (Phase 5 close-out + P8.3): one self-mounting
// dialog for BOTH workspace kinds, dispatched on the target daemon's kind.
//
// Worktree targets keep the guard-evidence flow: the sidebar row asked for
// the evidence on open, this dialog shows dirty counts and branch merge/push
// state with an "also delete branch" checkbox (default from server evidence:
// merged && pushed). A dirty or unowned worktree is refused outright: no
// --force in v1.
//
// Clone targets use the verified-delete flow: deletion is an explicit
// operation distinct from ordinary stop and from stopping the current work.
// The fleet refuses while work is active (the operator stops it first,
// "Stop current work" on the attached row / the chat Stop button), verifies
// the fleet transcript store for every session, and only then deletes
// provider compute/storage and the checkout. The same delete_worktree
// command rides through, routed to the verified gate by kind backend-side;
// typed refusals land as global error frames and are captured in-dialog.
// Success removes the roster entry, which closes the dialog.

/** One dirty-count span (glyph + count), fixed order like the roster rows. */
type DirtyKind = "added" | "modified" | "deleted" | "untracked";

const DIRTY_GLYPHS: Record<DirtyKind, string> = {
	added: "+",
	modified: "~",
	deleted: "-",
	untracked: "?",
};

export const DeleteWorkspaceDialog: Component = () => {
	const [deleteBranch, setDeleteBranch] = createSignal<boolean | null>(null);
	// Clone refusals (typed error frames landing after open/retry) show
	// in-dialog; baseline resets per open and per retry like
	// RemoveProjectDialog.
	const [refusal, setRefusal] = createSignal<string | null>(null);

	const target = () => state.deleteWorkspaceTarget;
	const info = () => (target() !== null ? state.worktreeDeleteInfo[target()!] : undefined);
	const daemon = () =>
		target() !== null ? state.daemonRoster.find((d) => d.daemonId === target()!) : undefined;
	const isClone = () => daemon()?.workspaceKind === "clone";
	/** The roster entry when the target is a clone, else undefined; Show
	 *  narrows the child callback to the entry (never to `true`). */
	const cloneDaemon = (): DaemonEntry | undefined =>
		isClone() && daemon() !== undefined ? daemon() : undefined;

	// Fresh checkbox default per open (the sidebar row already asked for the
	// guard evidence when it opened this dialog).
	createEffect(() => {
		void target();
		setDeleteBranch(null);
	});

	/** Watch the target's lifecycle: a roster eviction (successful delete) or
	 *  a project deregistration closes the dialog; for clone targets capture
	 *  error frames that land after open/retry as the in-dialog refusal. */
	let lastTarget: string | null = null;
	let errorAtOpen: string | null | undefined;
	createEffect(() => {
		const id = target();
		if (id === null) {
			lastTarget = null;
			return;
		}
		if (lastTarget !== id) {
			lastTarget = id;
			errorAtOpen = state.error;
			setRefusal(null);
		}
		// The entry left the roster; the delete finished (or the daemon was
		// evicted another way): dismiss.
		if (daemon() === undefined) {
			setState("deleteWorkspaceTarget", null);
			return;
		}
		if (isClone()) {
			const err = state.error;
			if (err !== null && err !== errorAtOpen) {
				errorAtOpen = err;
				setRefusal(err);
			}
		}
	});

	/** Evidence-backed checkbox default: delete the branch only when merged
	 *  and (pushed or no upstream); server refuses `-d` on unmerged anyway. */
	const effectiveDeleteBranch = () =>
		deleteBranch() ?? (info()?.merged === true && info()?.unpushed !== true);

	const dirtyKinds = () => {
		const g = info()?.git;
		if (!g) return [];
		const kinds: Array<{ kind: DirtyKind; n: number }> = [
			{ kind: "added", n: g.added },
			{ kind: "modified", n: g.modified },
			{ kind: "deleted", n: g.deleted },
			{ kind: "untracked", n: g.untracked },
		];
		return kinds.filter((k) => k.n > 0);
	};

	const dirtyTotal = () => dirtyKinds().reduce((sum, k) => sum + k.n, 0);

	/** Worktree confirm allowed only once evidence is in AND the worktree is
	 *  owned + clean. Clones have no guard-evidence rung; the fleet's
	 *  verified-delete gate admits/refuses at submit time. */
	const worktreeConfirmable = () => {
		const i = info();
		return i !== undefined && i.owned && !i.dirty;
	};

	const close = () => {
		setState("deleteWorkspaceTarget", null);
	};

	const confirmDelete = () => {
		const id = target();
		if (id === null) return;
		if (!isClone() && !worktreeConfirmable()) return;
		// Clone retry baseline: only refusals landing AFTER this submit count.
		errorAtOpen = state.error;
		setRefusal(null);
		sendDeleteWorktree(id, isClone() ? {} : effectiveDeleteBranch() ? { deleteBranch: true } : {});
		if (!isClone()) close();
	};

	const branchHint = () => {
		const i = info();
		if (i?.merged === true && i?.unpushed !== true) return "merged and pushed";
		if (i?.merged === true) return "merged but unpushed";
		if (i?.unpushed === false) return "pushed but unmerged";
		return "unmerged";
	};

	return (
		<Show when={target() !== null}>
			<Modal title={isClone() ? "Delete clone workspace" : "Delete worktree"} onClose={close}>
				{/* Clone variant: verified-delete copy + in-dialog typed refusals.
				    cloneDaemon() narrows the Show callback to the roster entry
				    (the gate is a value, so the child never sees `true`). */}
				<Show when={cloneDaemon()}>
					{(clone) => (
						<>
							<p class="danger-confirm-body">
								Delete the clone workspace{" "}
								<span class="worktree-evidence-path">{clone().name}</span>
								{clone().providerProfileId !== undefined ? (
									<>
										{" "}
										(running under profile{" "}
										<span class="worktree-evidence-path">{clone().providerProfileId}</span>)
									</>
								) : null}
								? This refuses while work is active; stop the current work first if a turn is
								running. It verifies every session transcript is safely stored in the fleet, then
								deletes the provider compute/storage and the local checkout. Uncommitted
								working-tree state is lost; session transcripts are not a source backup. This cannot
								be undone.
							</p>
							{/* A lifecycle failure already on the row (e.g. a failed
							    preparation) is context for why the delete may refuse. */}
							<Show when={clone().lifecycleError}>
								{(err) => <div class="msg-notice worktree-error">lifecycle: {err()}</div>}
							</Show>
							<Show when={refusal() !== null}>
								<div class="msg-notice worktree-error">{refusal()}</div>
							</Show>
							<div class="ask-actions">
								<button type="button" onClick={close}>
									Cancel
								</button>
								<button type="button" class="danger-confirm-btn" onClick={confirmDelete}>
									Delete clone
								</button>
							</div>
						</>
					)}
				</Show>
				{/* Worktree variant: guard-evidence flow (unchanged behavior). */}
				<Show when={target() !== null && !isClone()}>
					<Show when={info() === undefined}>
						<p class="danger-confirm-body">checking worktree state…</p>
					</Show>
					<Show when={info() !== undefined && !info()!.owned}>
						<p class="danger-confirm-body">
							{info()!.reason ??
								"This directory is not a fleet-managed worktree: nothing to delete."}
						</p>
					</Show>
					<Show when={info() !== undefined && info()!.owned && info()!.dirty}>
						<p class="danger-confirm-body">
							This worktree has {dirtyTotal()} uncommitted change
							{dirtyTotal() === 1 ? "" : "s"}
							<Show when={dirtyKinds().length > 0}>
								<span class="worktree-evidence">
									<For each={dirtyKinds()}>
										{(k) => (
											<span class="daemon-git-dirty" data-kind={k.kind}>
												{DIRTY_GLYPHS[k.kind]}
												{k.n}
											</span>
										)}
									</For>
								</span>
							</Show>
							. Deleting is refused while the worktree is dirty
							{info()!.reason ? `: ${info()!.reason}` : ""}.
						</p>
					</Show>
					<Show when={info() !== undefined && info()!.owned && !info()!.dirty}>
						<p class="danger-confirm-body">
							Delete the fleet-managed worktree
							{daemon() ? (
								<>
									{" "}
									at <span class="worktree-evidence-path">{daemon()!.cwd}</span>
								</>
							) : null}
							? This stops the daemon and removes it from the roster; session transcripts survive
							(they live under the agent dir, not the worktree).
						</p>
						<Show when={info()!.branch}>
							{(branch) => (
								<label class="worktree-branch-check">
									<input
										type="checkbox"
										checked={effectiveDeleteBranch()}
										onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
									/>
									<span>
										Also delete branch <span class="worktree-branch-name">{branch()}</span>
									</span>
									<span class="worktree-branch-hint">{branchHint()}</span>
								</label>
							)}
						</Show>
					</Show>
					<div class="ask-actions">
						<button type="button" onClick={close}>
							Cancel
						</button>
						<button
							type="button"
							class="danger-confirm-btn"
							disabled={!worktreeConfirmable()}
							onClick={confirmDelete}
						>
							Delete worktree
						</button>
					</div>
				</Show>
			</Modal>
		</Show>
	);
};
