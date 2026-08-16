import { createEffect, createSignal, For, Show, type Component } from "solid-js";
import { sendDeleteWorktree, setState, state } from "../state";
import { Modal } from "./Modal";

// Delete-worktree confirm (Phase 5 close-out): the guard-evidence dialog
// for managed worktrees. Self-mounts (rendered once from App.tsx like
// DangerConfirmDialog) and renders nothing while no target is set. The
// sidebar sets deleteWorktreeTarget; this dialog asks for the guard
// evidence on open (fresh every time), then shows dirty counts and branch
// merge/push state with an "also delete branch" checkbox (default from
// server evidence: merged && pushed). A dirty or unowned worktree is
// refused outright — no --force in v1.

/** One dirty-count span (glyph + count), fixed order like the roster rows. */
type DirtyKind = "added" | "modified" | "deleted" | "untracked";

const DIRTY_GLYPHS: Record<DirtyKind, string> = {
	added: "+",
	modified: "~",
	deleted: "-",
	untracked: "?",
};

export const DeleteWorktreeDialog: Component = () => {
	const [deleteBranch, setDeleteBranch] = createSignal<boolean | null>(null);

	const target = () => state.deleteWorktreeTarget;
	const info = () => (target() !== null ? state.worktreeDeleteInfo[target()!] : undefined);
	const daemon = () => (target() !== null ? state.daemonRoster.find(d => d.daemonId === target()!) : undefined);

	// Fresh checkbox default per open (the sidebar row already asked for the
	// guard evidence when it opened this dialog).
	createEffect(() => {
		void target();
		setDeleteBranch(null);
	});

	/** Evidence-backed checkbox default: delete the branch only when merged
	 *  and (pushed or no upstream) — server refuses `-d` on unmerged anyway. */
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
		return kinds.filter(k => k.n > 0);
	};

	const dirtyTotal = () => dirtyKinds().reduce((sum, k) => sum + k.n, 0);

	/** Confirm allowed only once evidence is in AND the worktree is owned + clean. */
	const confirmable = () => {
		const i = info();
		return i !== undefined && i.owned && !i.dirty;
	};

	const close = () => {
		setState("deleteWorktreeTarget", null);
	};

	const confirmDelete = () => {
		if (!confirmable()) return;
		sendDeleteWorktree(target()!, effectiveDeleteBranch() ? { deleteBranch: true } : {});
		close();
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
			<Modal title="Delete worktree" onClose={close}>
				<Show when={info() === undefined}>
					<p class="danger-confirm-body">checking worktree state…</p>
				</Show>
				<Show when={info() !== undefined && !info()!.owned}>
					<p class="danger-confirm-body">
						{info()!.reason ?? "This directory is not a fleet-managed worktree — nothing to delete."}
					</p>
				</Show>
				<Show when={info() !== undefined && info()!.owned && info()!.dirty}>
					<p class="danger-confirm-body">
						This worktree has {dirtyTotal()} uncommitted change{dirtyTotal() === 1 ? "" : "s"}
						<Show when={dirtyKinds().length > 0}>
							<span class="worktree-evidence">
								<For each={dirtyKinds()}>
									{k => (
										<span class="daemon-git-dirty" data-kind={k.kind}>
											{DIRTY_GLYPHS[k.kind]}
											{k.n}
										</span>
									)}
								</For>
							</span>
						</Show>
						. Deleting is refused while the worktree is dirty{info()!.reason ? ` — ${info()!.reason}` : ""}.
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
						? This stops the daemon and removes it from the roster; session transcripts survive (they live under
						the agent dir, not the worktree).
					</p>
					<Show when={info()!.branch}>
						{branch => (
							<label class="worktree-branch-check">
								<input
									type="checkbox"
									checked={effectiveDeleteBranch()}
									onChange={e => setDeleteBranch(e.currentTarget.checked)}
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
					<button type="button" class="danger-confirm-btn" disabled={!confirmable()} onClick={confirmDelete}>
						Delete worktree
					</button>
				</div>
			</Modal>
		</Show>
	);
};
