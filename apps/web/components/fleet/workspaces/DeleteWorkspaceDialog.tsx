import type { DaemonEntry } from "#lib/wire/protocol";
import { createEffect, createSignal, For, Show, type Component } from "solid-js";
import { sendDeleteWorktree, setState, state } from "../../../state";
import { Modal } from "../../ui/Modal";
import { gitReviewAvailable, gitReviewUnavailableReason } from "../../../store/review";
import { attachForPanel } from "../../../store/roster";
import { openDock } from "../../../store/dock";

// Delete-workspace confirm (Phase 5 close-out): one self-mounting
// dialog for BOTH workspace kinds, dispatched on the target daemon's kind.
//
// Worktree targets keep the guard-evidence flow: the sidebar row asked for
// the evidence on open, this dialog shows dirty counts and branch merge/push
// state with an "also delete branch" checkbox (default: merged with nothing unpushed;
// hidden, with the reason, when the server refuses branch deletion). A dirty or
// non-linked worktree is refused outright: no
// --force in v1. Evidence whose git probe failed (probeFailed) is refused the
// same way: the state is unproven, so no Delete control, only Cancel.
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

	/** Branch to delete with the worktree, or undefined to keep it. The checkbox
	 *  defaults to checked only when the branch is merged with nothing unpushed.
	 *  The server's `branchDeleteRefused` (protected or detached) always keeps it. */
	const branchToDelete = (): string | undefined => {
		const i = info();
		const branch = i?.branch;
		if (i === undefined || branch === undefined || i.branchDeleteRefused !== undefined)
			return undefined;
		const checked = deleteBranch() ?? (i.merged === true && i.unpushed !== true);
		return checked ? branch : undefined;
	};

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

	/** Guard evidence whose git probe failed: the state cannot be verified,
	 *  so deletion is refused outright (fail closed) and only Cancel is offered. */
	const unproven = () => info()?.probeFailed === true;

	/** Worktree confirm allowed only once evidence is in AND the worktree is
	 *  linked + clean. Clones have no guard-evidence rung; the fleet's
	 *  verified-delete gate admits/refuses at submit time. */
	const worktreeConfirmable = () => {
		const i = info();
		return i !== undefined && i.linked && !i.dirty && i.probeFailed !== true;
	};

	const close = () => {
		setState("deleteWorkspaceTarget", null);
	};

	/** Closes the delete dialog and opens the git review for this worktree.
	 *  Review reads the active session's repository, so attach it first. */
	const openReview = () => {
		const id = target();
		if (id === null) return;
		const attached = id === state.currentSessionId;
		close();
		if (attached) {
			openDock("review");
			return;
		}
		void attachForPanel(id).then((ok) => {
			if (ok) openDock("review");
		});
	};

	const confirmDelete = () => {
		const id = target();
		if (id === null) return;
		if (!isClone() && !worktreeConfirmable()) return;
		// Clone retry baseline: only refusals landing AFTER this submit count.
		errorAtOpen = state.error;
		setRefusal(null);
		const branch = isClone() ? undefined : branchToDelete();
		sendDeleteWorktree(id, branch === undefined ? {} : { deleteBranch: branch });
		if (!isClone()) close();
	};

	const branchHint = () => {
		const i = info();
		if (i?.merged === true) {
			if (i.unpushed === true) return "merged but unpushed";
			return i.hasUpstream === true ? "merged and pushed" : "merged, no upstream";
		}
		if (i?.hasUpstream === true && i.unpushed !== true) return "pushed but unmerged";
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
				{/* Worktree variant: guard-evidence flow; dirty, non-linked, and
				    unproven (failed git probe) evidence is refused outright. */}
				<Show when={target() !== null && !isClone()}>
					<Show when={info() === undefined}>
						<p class="danger-confirm-body">checking worktree state…</p>
					</Show>
					<Show when={info() !== undefined && !info()!.linked}>
						<p class="danger-confirm-body">
							{info()!.reason ??
								"This is not a linked Git worktree omp-web can delete; its files stay on disk."}
						</p>
					</Show>
					<Show when={info() !== undefined && info()!.linked && info()!.dirty}>
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
						<Show when={(info()!.files?.length ?? 0) > 0}>
							<ul class="worktree-dirty-files" aria-label="Changed files">
								<For each={info()!.files}>
									{(path) => (
										<li>
											<span class="worktree-evidence-path">{path}</span>
										</li>
									)}
								</For>
							</ul>
						</Show>
						<Show when={dirtyTotal() > (info()!.files?.length ?? 0)}>
							<p class="worktree-branch-hint">
								{dirtyTotal() - (info()!.files?.length ?? 0)} more not listed
							</p>
						</Show>
						<div class="ask-actions">
							<button type="button" disabled={!gitReviewAvailable()} onClick={openReview}>
								Open review
							</button>
						</div>
						<Show when={!gitReviewAvailable()}>
							<p class="danger-confirm-body">{gitReviewUnavailableReason()}</p>
						</Show>
					</Show>
					<Show when={info() !== undefined && info()!.linked && !info()!.dirty && unproven()}>
						<p class="danger-confirm-body">
							This worktree cannot be verified as safe to delete:{" "}
							{info()!.reason ?? "worktree git state could not be read; deleting is refused"}.
						</p>
					</Show>
					<Show when={info() !== undefined && info()!.linked && !info()!.dirty && !unproven()}>
						<p class="danger-confirm-body">
							Delete the worktree
							{daemon() ? (
								<>
									{" "}
									at <span class="worktree-evidence-path">{daemon()!.cwd}</span>
								</>
							) : null}
							? This stops the session process, removes it from the roster, and deletes its files
							from disk. Session transcripts survive (they live under the agent dir, not the
							worktree).
						</p>
						<Show when={info()!.branch}>
							{(branch) => (
								<Show
									when={info()!.branchDeleteRefused === undefined}
									fallback={
										<p class="worktree-branch-hint">
											Branch <span class="worktree-branch-name">{branch()}</span> is kept:{" "}
											{info()!.branchDeleteRefused}
										</p>
									}
								>
									<label class="worktree-branch-check">
										<input
											type="checkbox"
											checked={branchToDelete() !== undefined}
											onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
										/>
										<span>
											Also delete branch <span class="worktree-branch-name">{branch()}</span>
										</span>
										<span class="worktree-branch-hint">{branchHint()}</span>
									</label>
								</Show>
							)}
						</Show>
					</Show>
					<div class="ask-actions">
						<button type="button" onClick={close}>
							Cancel
						</button>
						{/* Unproven evidence (failed git probe) refuses outright:
						    no Delete control, only Cancel. */}
						<Show when={!unproven()}>
							<button
								type="button"
								class="danger-confirm-btn"
								disabled={!worktreeConfirmable()}
								onClick={confirmDelete}
							>
								Delete worktree
							</button>
						</Show>
					</div>
				</Show>
			</Modal>
		</Show>
	);
};
