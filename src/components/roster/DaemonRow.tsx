import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import type { DaemonEntry, DaemonStatus } from "../../../shared/protocol";
import {
	attachSession,
	removeDaemonById,
	sendWorktreeDeleteInfo,
	setState,
	spawnResume,
	state,
	stopDaemonById,
} from "../../state";
import { ConfirmButton } from "../shared/ConfirmButton";
import { KebabMenu } from "../shared/KebabMenu";
import { useClickableRow } from "../shared/PickerRow";
import { FileIcon, InfoIcon, RootIcon, StopIcon, TrashIcon, XIcon } from "../shared/icons";
import { DaemonDetailView } from "./DaemonDetailView";

// ---------------------------------------------------------------------------
// One fleet-roster row: status dot, branch/project chips, git diffstat, and a
// hover-revealed "⋯" actions menu (details, two-click stop/remove, delete
// worktree). Ready rows attach on click, asleep rows wake-then-attach.
// Two distilled profiles exist beside the full one: worktree rows (nested,
// branch as title) and root rows (a project group's main checkout — root
// glyph + branch as title, no project chip or cwd line; the group header
// already names the project and the path lives in the tooltip/details).
// ---------------------------------------------------------------------------

/** Roster entries may carry a template name plus per-repo git facts
 *  (branch + porcelain counts + numstat line counts) that the fleet edge
 *  may serialize; protocol.ts DaemonEntry is frozen so read all of them
 *  tolerantly. */
export type RosterEntry = DaemonEntry & {
	template?: string;
	/** Current branch of the session cwd; absent for detached/non-git/remote/unprobed. */
	branch?: string;
	/** Porcelain file counts, plus numstat line counts when the edge probed
	 *  them (`git diff --numstat HEAD --`); absent when unknown. */
	git?: {
		added: number;
		modified: number;
		deleted: number;
		untracked: number;
		linesAdded?: number;
		linesDeleted?: number;
	};
};

const STATUS_TITLE: Record<DaemonStatus, string> = {
	spawning: "starting the daemon…",
	connecting: "connecting to the daemon…",
	session: "session created…",
	resolving: "resolving provider/model…",
	ready: "ready — click to attach",
	asleep: "asleep — click to wake and attach",
	reconnecting: "reconnecting…",
	error: "error — see details",
};

/** Which row's "⋯" actions menu is open, if any. Module-level for the same
 *  reason as activatingIds: roster broadcasts remount rows, so per-row
 *  signals would silently close an open menu mid-interaction. Daemon rows
 *  key on the daemonId, project-group headers (SidebarGroups) on
 *  `project:<id>` — one open menu total. */
export const [menuOpenId, setMenuOpenId] = createSignal<string | null>(null);

/** DaemonIds with a wake-attach in flight (asleep-row click → attach
 *  settles). Module-level because roster/daemon_status frames remount rows
 *  mid-wake; per-row component signals would not survive. */
const [activatingIds, setActivatingIds] = createSignal<ReadonlySet<string>>(new Set());

export const DaemonRow: Component<{
	daemon: DaemonEntry;
	nested?: boolean;
	/** Rendered inside a registered-project group (SidebarGroups ProjectGroup):
	 *  the group header carries the project name, so an untagged row here is
	 *  the main worktree and distills to the root profile. */
	inProjectGroup?: boolean;
}> = (props) => {
	const [detailOpen, setDetailOpen] = createSignal(false);
	const d = () => props.daemon as RosterEntry;

	// Per-row id-scoped reads: the module signals (menuOpenId/activatingIds)
	// change on ANY row's interaction, so a plain read would re-render every
	// row. Each derived memo re-runs when the module signal changes but only
	// notifies the row when ITS OWN membership flips — one row's menu-open or
	// wake no longer re-renders the whole roster.
	const activating = createMemo(() => activatingIds().has(d().daemonId));
	const menuOpen = createMemo(() => menuOpenId() === d().daemonId);

	// Worktree sessions belong to a main checkout and read as branches, not
	// dirs — the branch (or name fallback) becomes the title and the project
	// chip + cwd path are dropped so the row never shows the directory.
	const isWorktree = () => d().worktreeOf !== undefined;
	// Root rows are a project group's MAIN worktree: the header already names
	// the project, so the row distills to a root glyph + branch-as-title (the
	// worktree profile, unindented) and drops the project chip + cwd line.
	const isRoot = () => props.inProjectGroup === true && !isWorktree();
	const isAttached = () => d().daemonId === state.currentSessionId;
	const clickable = () => d().status === "ready" || d().status === "asleep";
	/** Loading phase: activating but the daemon isn't ready yet. Renders with
	 *  the pulsing transitional ("resolving") visual vocabulary. */
	const waking = () => activating() && d().status !== "ready";
	/** Total files with uncommitted changes (nonzero porcelain counts),
	 *  or 0 when git facts are absent. */
	const filesChanged = (): number => {
		const g = d().git;
		if (!g) return 0;
		return g.added + g.modified + g.deleted + g.untracked;
	};
	/** Lines added/deleted per `git diff --numstat HEAD --`; undefined when
	 *  the edge did not probe numstat (fresh repo, spawn error, binary-only). */
	const linesAdded = (): number | undefined => d().git?.linesAdded;
	const linesDeleted = (): number | undefined => d().git?.linesDeleted;
	/** True when any diffstat group will render. */
	const hasGitStats = () =>
		filesChanged() > 0 || (linesAdded() ?? 0) > 0 || (linesDeleted() ?? 0) > 0;
	/** "1 file" / "3 files" — English plural for the diffstat titles. */
	const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

	const rowClick = () => {
		if (activating()) return;
		const daemon = d();
		if (daemon.status === "ready") {
			void attachSession(daemon.daemonId).catch((err) => setState("error", String(err)));
		} else if (daemon.status === "asleep") {
			// Wake then attach: the edge wakes first and answers the attach
			// once the session is ready — send both immediately, the edge
			// serializes them. Activate the row NOW (active highlight + waking
			// pulse) rather than when the proxied attached frame lands.
			const id = daemon.daemonId;
			setActivatingIds((prev) => new Set(prev).add(id));
			spawnResume(id);
			attachSession(id)
				.catch((err) => setState("error", String(err)))
				.finally(() =>
					setActivatingIds((prev) => {
						const next = new Set(prev);
						next.delete(id);
						return next;
					}),
				);
		}
	};

	const doStop = () => {
		stopDaemonById(d().daemonId);
		setMenuOpenId(null);
	};

	const doRemove = () => {
		removeDaemonById(d().daemonId);
		setMenuOpenId(null);
	};

	return (
		<>
			<div
				class="sidebar-row daemon-row"
				classList={{
					active: isAttached() || activating(),
					clickable: clickable() && !activating(),
					"daemon-row--nested": props.nested === true,
					"daemon-row--worktree": isWorktree(),
					"daemon-row--root": isRoot(),
				}}
				{...useClickableRow(rowClick, clickable())}
				title={waking() ? "waking — session starting…" : (STATUS_TITLE[d().status] ?? d().status)}
			>
				<span
					class="daemon-status-dot"
					data-status={waking() ? "resolving" : d().status}
					title={d().status}
				/>
				<div class="sidebar-row-main">
					<div class="sidebar-row-top">
						<span
							class="sidebar-row-title daemon-row-title"
							title={
								isRoot()
									? `main worktree — ${d().cwd}`
									: isWorktree()
										? (d().branch ?? d().name)
										: d().name
							}
						>
							{/* Root glyph marks the group's main worktree; the title
						    stays the branch so a main checkout on a feature branch
						    reads correctly. */}
							<Show when={isRoot()}>
								<RootIcon class="daemon-root-icon" />
							</Show>
							{isWorktree() || isRoot() ? (d().branch ?? d().name) : d().name}
						</span>
						{/* Row actions collapsed into a "⋯" menu at the top row's
						    right end: hidden until row hover/focus (always visible on
						    touch, see the pointer:coarse block in src/styles/base.css). Stop/remove
						    keep the two-click confirm inside the menu — the first click
						    arms (menu stays open), the second executes and closes. */}
						<KebabMenu
							label="Row actions"
							open={menuOpen()}
							onOpenChange={(v) => setMenuOpenId(v ? d().daemonId : null)}
						>
							{/* An asleep daemon has no live process — "Stop" is
							    meaningless there; Remove covers roster cleanup. */}
							<Show when={d().status !== "asleep"}>
								<ConfirmButton
									role="menuitem"
									class="sidebar-menu-item"
									label="Stop daemon"
									confirmLabel="Confirm stop"
									onConfirm={() => doStop()}
								>
									<StopIcon />
								</ConfirmButton>
							</Show>
							<ConfirmButton
								role="menuitem"
								class="sidebar-menu-item"
								label="Remove daemon"
								confirmLabel="Confirm remove"
								title="Removes the daemon from the roster (stops it first)"
								onConfirm={() => doRemove()}
							>
								<XIcon />
							</ConfirmButton>
							<button
								type="button"
								role="menuitem"
								class="sidebar-menu-item"
								onClick={() => {
									setMenuOpenId(null);
									setDetailOpen(true);
								}}
							>
								<InfoIcon />
								Daemon details
							</button>
							{/* Delete is offered on every worktree row — the
							    dialog's guard evidence (managed-root ownership +
							    clean tree) decides whether it can proceed. */}
							<Show when={isWorktree()}>
								<button
									type="button"
									role="menuitem"
									class="sidebar-menu-item sidebar-menu-item--danger"
									title="Stops the daemon and removes the worktree (guard checks first)"
									onClick={() => {
										setMenuOpenId(null);
										sendWorktreeDeleteInfo(d().daemonId);
										setState("deleteWorktreeTarget", d().daemonId);
									}}
								>
									<TrashIcon />
									Delete worktree…
								</button>
							</Show>
						</KebabMenu>
					</div>
					<Show when={!isWorktree() && !isRoot()}>
						<div class="daemon-chips">
							<span class="daemon-chip" title={d().cwd}>
								{d().project}
							</span>
							<For each={d().labels}>
								{(l) => (
									<span class="daemon-chip daemon-chip--label" title={`label ${l}`}>
										{l}
									</span>
								)}
							</For>
						</div>
						<div class="daemon-cwd" title={d().cwd}>
							{d().cwd}
						</div>
					</Show>
					{/* Root rows drop the project chip + cwd (the group header and
					    title tooltip carry them) but keep label chips — labels are
					    fleet-selector state the header knows nothing about. */}
					<Show when={isRoot() && d().labels.length > 0}>
						<div class="daemon-chips">
							<For each={d().labels}>
								{(l) => (
									<span class="daemon-chip daemon-chip--label" title={`label ${l}`}>
										{l}
									</span>
								)}
							</For>
						</div>
					</Show>
					{/* Bottom meta row: branch (full-profile rows only — worktree
					    and root rows already show it as the title) and the diffstat
					    cluster (changed-file count + numstat +/- line counts when
					    probed). Row actions live in the "⋯" menu on the top row.
					    Rendered only when there is git info to show. */}
					<Show when={(!isWorktree() && !isRoot() && d().branch !== undefined) || hasGitStats()}>
						<div class="daemon-git">
							<Show when={!isWorktree() && !isRoot() && d().branch !== undefined}>
								<span class="daemon-git-branch" title={d().cwd}>
									{d().branch}
								</span>
							</Show>
							<Show when={filesChanged()}>
								{(n) => (
									<span
										class="daemon-git-dirty"
										data-kind="files"
										title={`${plural(n(), "file")} changed`}
									>
										<FileIcon />
										{n()}
									</span>
								)}
							</Show>
							<Show when={linesAdded()}>
								{(n) => (
									<span
										class="daemon-git-dirty"
										data-kind="added"
										title={`${plural(n(), "line")} added`}
									>
										+{n()}
									</span>
								)}
							</Show>
							<Show when={linesDeleted()}>
								{(n) => (
									<span
										class="daemon-git-dirty"
										data-kind="deleted"
										title={`${plural(n(), "line")} deleted`}
									>
										-{n()}
									</span>
								)}
							</Show>
						</div>
					</Show>
				</div>
			</div>
			<Show when={detailOpen()}>
				<DaemonDetailView daemon={d()} onClose={() => setDetailOpen(false)} />
			</Show>
		</>
	);
};
