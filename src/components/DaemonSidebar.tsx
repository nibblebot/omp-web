import {
	createEffect,
	createSignal,
	For,
	onCleanup,
	Show,
	untrack,
	type Component,
} from "solid-js";
import type { DaemonEntry, DaemonStatus, RegisteredProject } from "../../shared/protocol";
import {
	attachSession,
	daemonsByProject,
	removeDaemonById,
	sendWorktreeDeleteInfo,
	setSidebarVisible,
	setState,
	spawnResume,
	state,
	stopDaemonById,
	togglePetVisible,
} from "../state";
import { formatDaemonUptime } from "./ActiveDaemons";
import { Modal } from "./Modal";
import { useClickableRow } from "./PickerRow";
import {
	ChevronDownIcon,
	DotsIcon,
	FileIcon,
	InfoIcon,
	PanelLeftIcon,
	PlusIcon,
	SettingsIcon,
	StopIcon,
	TrashIcon,
	XIcon,
} from "../icons";

// ---------------------------------------------------------------------------
// Fleet-edge roster sidebar (Phase 5). Rendered by App.tsx only in
// roster mode. Project-first: registered projects (registered_projects
// frame) group their daemons — main-checkout row first, then worktrees —
// each group carrying "+ Add worktree" (opens the worktree modal) and a
// remove-project action. Entries WITHOUT a projectId (remote/unregistered)
// fall back to today's string-grouping in one trailing group. The header
// "+" opens the Add-repo modal (the retired SpawnPicker's template/labels
// fields live in its advanced section). Rows show the session status dot,
// the branch as the title for worktrees, project/label chips and a
//  git-dirty line; ready rows attach on click, asleep rows wake-then-attach,
//  row actions (daemon details, stop/remove as two-click confirms, plus
//  "Delete worktree…" on managed worktree rows) live in a hover-revealed
//  "⋯" menu at the row's top-right, and the detail popover shows roster
//  facts + stderr tail. Collapse
//  state persists per project in localStorage.
// ---------------------------------------------------------------------------

/** Roster entries may carry a template name plus per-repo git facts
 *  (branch + porcelain counts + numstat line counts) that the fleet edge
 *  may serialize; protocol.ts DaemonEntry is frozen so read all of them
 *  tolerantly. */
type RosterEntry = DaemonEntry & {
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

const DaemonRow: Component<{ daemon: DaemonEntry; nested?: boolean }> = (props) => {
	const [detailOpen, setDetailOpen] = createSignal(false);
	// Activating = wake-attach in flight for this row's daemon. Read from the
	// module-level set, NOT a component signal: daemon_status/roster frames
	// rebuild rows (fresh entry objects → <For> remounts), so component-local
	// state would be dropped mid-wake and the highlight would vanish until
	// the attached frame lands. Cleared when the attach settles — the edge
	// answers attach only once the woken daemon is ready, so this spans the
	// whole wake and drives the instant active highlight + waking indicator.
	const activating = () => activatingIds().has(d().daemonId);
	const d = () => props.daemon as RosterEntry;
	// Stop/remove arm state, read from the module-level set (see armedRow):
	// roster broadcasts remount rows, so per-row signals would drop a
	// half-armed confirm between clicks.
	const armedStop = () => armedRow()?.id === d().daemonId && armedRow()?.kind === "stop";
	const armedRemove = () => armedRow()?.id === d().daemonId && armedRow()?.kind === "remove";
	// "⋯" actions-menu open state, read from the module-level signal (same
	// remount-survival rationale as armedRow).
	const menuOpen = () => menuOpenId() === d().daemonId;
	bindMenuDismiss(menuOpen);
	// Worktree sessions belong to a main checkout and read as branches, not
	// dirs — the branch (or name fallback) becomes the title and the project
	// chip + cwd path are dropped so the row never shows the directory.
	const isWorktree = () => d().worktreeOf !== undefined;
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
		disarmDaemon();
		setMenuOpenId(null);
	};

	const doRemove = () => {
		removeDaemonById(d().daemonId);
		disarmDaemon();
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
							title={isWorktree() ? (d().branch ?? d().name) : d().name}
						>
							{isWorktree() ? (d().branch ?? d().name) : d().name}
						</span>
						{/* Row actions collapsed into a "⋯" menu at the top row's
						    right end: hidden until row hover/focus (always visible on
						    touch, see the pointer:coarse block in styles.css). Stop/remove
						    keep the two-click confirm inside the menu — the first click
						    arms (menu stays open), the second executes and closes. */}
						<div class="sidebar-menu-wrap">
							<button
								type="button"
								class="daemon-icon-btn sidebar-menu-btn"
								title="Row actions"
								aria-label="Row actions"
								aria-haspopup="menu"
								aria-expanded={menuOpen()}
								onClick={(e) => {
									e.stopPropagation();
									setMenuOpenId(menuOpen() ? null : d().daemonId);
								}}
							>
								<DotsIcon />
							</button>
							<Show when={menuOpen()}>
								<div class="sidebar-menu" role="menu">
									<button
										type="button"
										role="menuitem"
										class="sidebar-menu-item"
										classList={{ armed: armedStop() }}
										title={armedStop() ? "Second click confirms" : undefined}
										onClick={(e) => {
											e.stopPropagation();
											if (armedStop()) doStop();
											else armDaemon(d().daemonId, "stop");
										}}
									>
										<StopIcon />
										{armedStop() ? "Confirm stop" : "Stop daemon"}
									</button>
									<button
										type="button"
										role="menuitem"
										class="sidebar-menu-item"
										classList={{ armed: armedRemove() }}
										title={
											armedRemove()
												? "Second click confirms"
												: "Removes the daemon from the roster (stops it first)"
										}
										onClick={(e) => {
											e.stopPropagation();
											if (armedRemove()) doRemove();
											else armDaemon(d().daemonId, "remove");
										}}
									>
										<XIcon />
										{armedRemove() ? "Confirm remove" : "Remove daemon"}
									</button>
									<button
										type="button"
										role="menuitem"
										class="sidebar-menu-item"
										onClick={(e) => {
											e.stopPropagation();
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
											onClick={(e) => {
												e.stopPropagation();
												setMenuOpenId(null);
												sendWorktreeDeleteInfo(d().daemonId);
												setState("deleteWorktreeTarget", d().daemonId);
											}}
										>
											<TrashIcon />
											Delete worktree…
										</button>
									</Show>
								</div>
							</Show>
						</div>
					</div>
					<Show when={!isWorktree()}>
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
					{/* Bottom meta row: branch (non-worktree rows only — worktree
					    rows already show it as the title) and the diffstat cluster
					    (changed-file count + numstat +/- line counts when probed).
					    Row actions live in the "⋯" menu on the top row. Rendered
					    only when there is git info to show. */}
					<Show when={(!isWorktree() && d().branch !== undefined) || hasGitStats()}>
						<div class="daemon-git">
							<Show when={!isWorktree() && d().branch !== undefined}>
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
				<DaemonDetail daemon={d()} onClose={() => setDetailOpen(false)} />
			</Show>
		</>
	);
};

/** Detail popover: roster facts + live stderr tail from /ctl/sessions/{id}/stderr. */
const DaemonDetail: Component<{ daemon: DaemonEntry; onClose: () => void }> = (props) => {
	const [stderrText, setStderrText] = createSignal<string | null>(null);
	const [stderrError, setStderrError] = createSignal<string | null>(null);
	const [stderrLoading, setStderrLoading] = createSignal(false);
	const d = () => props.daemon;

	const loadStderr = () => {
		setStderrLoading(true);
		setStderrError(null);
		setStderrText(null);
		// untrack: the daemon object is replaced on every roster broadcast;
		// reading it here must not turn broadcasts into refetch triggers.
		const daemonId = untrack(d).daemonId;
		fetch(`/ctl/sessions/${encodeURIComponent(daemonId)}/stderr`)
			.then((r) => {
				if (!r.ok) {
					throw new Error(
						r.status === 404
							? "not a spawned daemon — no stderr captured"
							: `stderr fetch failed (${r.status})`,
					);
				}
				return r.json() as Promise<{ text: string }>;
			})
			.then((data) => setStderrText(data.text))
			.catch((err) => setStderrError(err instanceof Error ? err.message : String(err)))
			.finally(() => setStderrLoading(false));
	};

	// Reload only when the SHOWN daemon changes (daemonId is stable across
	// roster broadcasts, unlike the entry object itself).
	createEffect(() => {
		void props.daemon.daemonId;
		loadStderr();
	});

	return (
		<Modal class="daemon-detail" aria-label={`Daemon ${d().name}`} onClose={props.onClose}>
			<div class="daemon-detail-header">
				<span class="daemon-status-dot" data-status={d().status} title={d().status} />
				<span class="daemon-detail-name">{d().name}</span>
				<button
					type="button"
					class="daemon-detail-close"
					aria-label="Close daemon details"
					onClick={props.onClose}
				>
					<XIcon />
				</button>
			</div>
			<div class="daemon-detail-facts">
				<div class="daemon-detail-fact">
					<span class="daemon-detail-label">cwd</span>
					<span class="daemon-detail-value" title={d().cwd}>
						{d().cwd}
					</span>
				</div>
				<div class="daemon-detail-fact">
					<span class="daemon-detail-label">mode</span>
					<span class="daemon-detail-value">{d().mode}</span>
				</div>
				<Show when={(d() as RosterEntry).template}>
					{(name) => (
						<div class="daemon-detail-fact">
							<span class="daemon-detail-label">template</span>
							<span class="daemon-detail-value">{name()}</span>
						</div>
					)}
				</Show>
				<Show when={d().uptime !== undefined}>
					<div class="daemon-detail-fact">
						<span class="daemon-detail-label">uptime</span>
						<span class="daemon-detail-value">{formatDaemonUptime((d().uptime ?? 0) * 1000)}</span>
					</div>
				</Show>
				<Show when={d().pid !== undefined}>
					<div class="daemon-detail-fact">
						<span class="daemon-detail-label">pid</span>
						<span class="daemon-detail-value">{d().pid}</span>
					</div>
				</Show>
				<Show when={d().lastSessionFile}>
					{(file) => (
						<div class="daemon-detail-fact">
							<span class="daemon-detail-label">session</span>
							<span class="daemon-detail-value" title={file()}>
								{file()}
							</span>
						</div>
					)}
				</Show>
				<Show when={d().labels.length > 0}>
					<div class="daemon-detail-fact">
						<span class="daemon-detail-label">labels</span>
						<span class="daemon-detail-value daemon-detail-labels">
							<For each={d().labels}>
								{(l) => <span class="daemon-chip daemon-chip--label">{l}</span>}
							</For>
						</span>
					</div>
				</Show>
				<Show when={d().error}>
					{(err) => (
						<div class="daemon-detail-fact daemon-detail-fact--error">
							<span class="daemon-detail-label">error</span>
							<span class="daemon-detail-value">{err()}</span>
						</div>
					)}
				</Show>
			</div>
			<div class="daemon-stderr-head">
				<span class="daemon-detail-label">stderr</span>
				<button
					type="button"
					class="daemon-row-btn"
					disabled={stderrLoading()}
					onClick={() => void loadStderr()}
				>
					{stderrLoading() ? "loading…" : "refresh"}
				</button>
			</div>
			<Show when={stderrLoading()}>
				<div class="daemon-stderr-empty">loading stderr…</div>
			</Show>
			<Show when={!stderrLoading() && stderrText() !== null}>
				<pre class="daemon-stderr">
					{stderrText() === "" ? "(no stderr output yet)" : stderrText()}
				</pre>
			</Show>
			<Show when={stderrError()}>
				{(err) => <div class="msg-notice daemon-stderr-error">{err()}</div>}
			</Show>
		</Modal>
	);
};

/** Left overlay: fleet session roster (click to attach/wake). Fixed to the
 *  viewport's left edge; slides in/out via the `.open` class.
 *  Registered projects render as project groups (project.name header,
 *  main-checkout rows first, then worktrees, "+ Add worktree" action,
 *  remove-project action). Entries without a projectId (remote/unregistered)
 *  fall back to today's string-grouping in one trailing group.
 *  Per-project collapse state persists in localStorage. */

/** localStorage key for the roster sidebar's collapsed group headers. */
const GROUPS_KEY = "omp.sidebarGroupsCollapsed";

/** DaemonIds with a wake-attach in flight (asleep-row click → attach
 *  settles). Module-level because roster/daemon_status frames remount rows
 *  mid-wake; per-row component signals would not survive. */
const [activatingIds, setActivatingIds] = createSignal<ReadonlySet<string>>(new Set());

/** Stop/remove two-click arm: the one row action currently armed, if any.
 *  Module-level for the same reason as activatingIds — roster broadcasts
 *  rebuild rows (fresh entry objects → <For> remounts), so per-row component
 *  signals would silently drop a half-armed confirm between clicks. Arming
 *  anything disarms everything else (one armed action across the whole
 *  sidebar, extending the old per-row mutual exclusion) and auto-disarms
 *  after ARM_DISARM_MS. */
const ARM_DISARM_MS = 4000;
const [armedRow, setArmedRow] = createSignal<{ id: string; kind: "stop" | "remove" } | null>(null);
let armTimer: ReturnType<typeof setTimeout> | undefined;

/** Which row's "⋯" actions menu is open, if any. Module-level for the same
 *  reason as armedRow: roster broadcasts remount rows, so per-row signals
 *  would silently close an open menu mid-interaction. Daemon rows key on the
 *  daemonId, project-group headers on `project:<id>` — one open menu total. */
const [menuOpenId, setMenuOpenId] = createSignal<string | null>(null);

/** Close-on-outside-pointerdown / Escape wiring shared by daemon-row and
 *  project-group "⋯" menus. Listeners re-register after roster-broadcast
 *  remounts because the open state itself is module-level. */
function bindMenuDismiss(open: () => boolean): void {
	createEffect(() => {
		if (!open()) return;
		const close = () => setMenuOpenId(null);
		const onPointerDown = (e: PointerEvent) => {
			if (!(e.target instanceof Element) || !e.target.closest(".sidebar-menu-wrap")) close();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		onCleanup(() => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		});
	});
}

/** Arm a row action, replacing any other armed action (and its timer). */
function armDaemon(id: string, kind: "stop" | "remove"): void {
	if (armTimer !== undefined) clearTimeout(armTimer);
	setArmedRow({ id, kind });
	armTimer = setTimeout(() => {
		armTimer = undefined;
		setArmedRow(null);
	}, ARM_DISARM_MS);
}

/** Disarm the armed row action (and its timer). */
function disarmDaemon(): void {
	if (armTimer !== undefined) {
		clearTimeout(armTimer);
		armTimer = undefined;
	}
	setArmedRow(null);
}

/** One repo group in the fallback (project-less) roster: its entries and
 *  whether it contains worktree sessions (which changes how it renders). */
type SidebarGroup = {
	name: string;
	entries: DaemonEntry[];
	hasWorktrees: boolean;
};

/** Fallback grouping for roster entries WITHOUT a projectId (remote/
 *  unregistered): group by repo (`worktreeOf ?? project`), sorted by group
 *  name via localeCompare — the pre-project roster's exact behavior. */
function buildGroups(entries: DaemonEntry[]): SidebarGroup[] {
	const byRepo = new Map<string, DaemonEntry[]>();
	for (const d of entries) {
		const key = d.worktreeOf ?? d.project;
		const list = byRepo.get(key) ?? [];
		list.push(d);
		byRepo.set(key, list);
	}
	return [...byRepo.keys()]
		.sort((a, b) => a.localeCompare(b))
		.map((name) => {
			const all = byRepo.get(name)!;
			const hasWorktrees = all.some((d) => d.worktreeOf !== undefined);
			return {
				name,
				hasWorktrees,
				entries: hasWorktrees
					? [
							...all.filter((d) => d.worktreeOf === undefined),
							...all.filter((d) => d.worktreeOf !== undefined),
						]
					: all,
			};
		});
}

/** Read the collapsed group-key set from localStorage; malformed or
 *  unavailable storage yields an empty set (all groups default open). */
function readCollapsedGroups(): Set<string> {
	if (typeof localStorage === "undefined") return new Set();
	try {
		const raw = localStorage.getItem(GROUPS_KEY);
		if (raw === null) return new Set();
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((k): k is string => typeof k === "string"));
	} catch {
		return new Set();
	}
}

export const DaemonSidebar: Component = () => {
	const [collapsedGroups, setCollapsedGroups] = createSignal<Set<string>>(readCollapsedGroups());

	/** Flip a group's collapse state and persist the updated key set. */
	const toggleGroup = (key: string) => {
		const next = new Set(collapsedGroups());
		if (next.has(key)) next.delete(key);
		else next.add(key);
		setCollapsedGroups(next);
		if (typeof localStorage !== "undefined")
			localStorage.setItem(GROUPS_KEY, JSON.stringify([...next]));
	};

	/** Project-first grouping: registered projects in registry order (zero-
	 *  daemon projects included) + one trailing fallback group for entries
	 *  without a projectId. */
	const groups = () => daemonsByProject();

	/** Narrow viewports (<1100px): the sidebar is a transient drawer — any
	 *  blur or click outside slides it back shut. Desktop keeps it open
	 *  until toggled. */
	// The sidebar is docked layout (no slide-over, no click-away dismiss);
	// the toggle opens it and its own close button (top-right) closes it.

	/** Collapsible caret group header; the caret glyph and its rotation come
	 *  from CSS via the data-open attribute. gkey names the collapse slot. */
	const GroupHeader: Component<{ label: string; gkey: string; count: number; class?: string }> = (
		props,
	) => {
		const open = () => !collapsedGroups().has(props.gkey);
		return (
			<button
				type="button"
				class={`sidebar-group${props.class ? ` ${props.class}` : ""}`}
				aria-expanded={open()}
				data-open={open() ? "true" : "false"}
				onClick={() => toggleGroup(props.gkey)}
			>
				<ChevronDownIcon class="sidebar-caret" />
				<span class="sidebar-group-label">{props.label}</span>
				<span class="sidebar-group-count">{props.count}</span>
			</button>
		);
	};

	/** One registered-project group: collapsible header (caret + name, plus a
	 *  hover-revealed "⋯" menu carrying Delete project), main-checkout row
	 *  first then worktree rows (daemonsByProject order), and a "+ Add
	 *  worktree" action. */
	const ProjectGroup: Component<{ project: RegisteredProject; daemons: DaemonEntry[] }> = (
		props,
	) => {
		const gkey = `project:${props.project.projectId}`;
		const open = () => !collapsedGroups().has(gkey);
		const menuOpen = () => menuOpenId() === gkey;
		bindMenuDismiss(menuOpen);
		return (
			<>
				<div class="sidebar-group project-group">
					<button
						type="button"
						class="project-group-toggle"
						aria-expanded={open()}
						data-open={open() ? "true" : "false"}
						onClick={() => toggleGroup(gkey)}
					>
						<ChevronDownIcon class="sidebar-caret" />
						<span class="sidebar-group-label" title={props.project.path}>
							{props.project.name}
						</span>
					</button>
					<div class="sidebar-menu-wrap">
						<button
							type="button"
							class="daemon-icon-btn sidebar-menu-btn"
							title="Project actions"
							aria-label={`Project actions for ${props.project.name}`}
							aria-haspopup="menu"
							aria-expanded={menuOpen()}
							onClick={(e) => {
								e.stopPropagation();
								setMenuOpenId(menuOpen() ? null : gkey);
							}}
						>
							<DotsIcon />
						</button>
						<Show when={menuOpen()}>
							<div class="sidebar-menu" role="menu">
								<button
									type="button"
									role="menuitem"
									class="sidebar-menu-item sidebar-menu-item--danger"
									title="Deregisters the project (never touches disk)"
									onClick={(e) => {
										e.stopPropagation();
										setMenuOpenId(null);
										setState("removeProjectTarget", props.project.projectId);
									}}
								>
									<TrashIcon />
									Delete project…
								</button>
							</div>
						</Show>
					</div>
				</div>
				<Show when={open()}>
					<For each={props.daemons}>
						{(d) => <DaemonRow daemon={d} nested={d.worktreeOf !== undefined} />}
					</For>
					<button
						type="button"
						class="project-add-worktree"
						onClick={() => {
							setState("worktreeModalProjectId", props.project.projectId);
							setState("modal", "worktree");
						}}
					>
						+ Add worktree
					</button>
				</Show>
			</>
		);
	};

	/** Trailing fallback group: entries without a projectId keep today's
	 *  string-grouping (collapsible repo headers for worktree-holding repos). */
	const FallbackGroup: Component<{ daemons: DaemonEntry[] }> = (props) => (
		<For each={buildGroups(props.daemons)}>
			{(g) =>
				g.hasWorktrees ? (
					<>
						<GroupHeader
							label={g.name}
							gkey={`repo:${g.name}`}
							count={g.entries.length}
							class="sidebar-group--repo"
						/>
						<Show when={!collapsedGroups().has(`repo:${g.name}`)}>
							<For each={g.entries}>{(d) => <DaemonRow daemon={d} nested />}</For>
						</Show>
					</>
				) : (
					<For each={g.entries}>{(d) => <DaemonRow daemon={d} />}</For>
				)
			}
		</For>
	);

	return (
		<aside class="sidebar" classList={{ open: state.sidebarVisible }}>
			<div class="sidebar-list">
				{/* Static top-level header: single grouping for the whole roster,
				    no caret (not collapsible), no indent; carries the add-project
				    action and the sidebar close button (top-right). Always rendered
				    so the empty-state hint has a referent. */}
				<div class="picker-group-name sidebar-subgroup sidebar-projects-head">
					Projects
					<span class="sidebar-projects-actions">
						<button
							class="sidebar-icon-btn"
							onClick={() => setState("modal", "add-project")}
							title="Add a project"
							aria-label="Add a project"
						>
							<PlusIcon />
						</button>
						<button
							class="sidebar-icon-btn"
							onClick={() => setSidebarVisible(false)}
							title="Close sidebar"
							aria-label="Close sidebar"
						>
							<XIcon />
						</button>
					</span>
				</div>
				<Show when={groups().length === 0}>
					<div class="sidebar-empty">no projects — press + to add one</div>
				</Show>
				<Show when={groups().length > 0}>
					<For each={groups()}>
						{(g) =>
							g.project === null ? (
								g.daemons.length > 0 ? (
									<FallbackGroup daemons={g.daemons} />
								) : null
							) : (
								<ProjectGroup project={g.project} daemons={g.daemons} />
							)
						}
					</For>
				</Show>
			</div>
			{/* Global chrome moved out of the StatusBar: transcripts browser, pet
			    roster, debug panel, settings. */}
			<div class="sidebar-foot">
				<button
					class="sidebar-icon-btn"
					classList={{ active: state.view === "transcripts" }}
					onClick={() => setState("view", (v) => (v === "transcripts" ? "chat" : "transcripts"))}
					title="Transcripts"
					aria-label="Transcripts"
				>
					<PanelLeftIcon /> tx
				</button>
				<button
					class="sidebar-icon-btn"
					classList={{ active: state.petVisible }}
					onClick={togglePetVisible}
					title="Show/hide pet roster"
					aria-label="Show/hide pet roster"
				>
					pet
				</button>
				<button
					class="sidebar-icon-btn"
					classList={{ active: state.modal === "debug" }}
					onClick={() => setState("modal", state.modal === "debug" ? null : "debug")}
					title="Debug — transport and fleet visibility"
					aria-label="Debug — transport and fleet visibility"
				>
					<InfoIcon />
				</button>
				<button
					class="sidebar-icon-btn"
					onClick={() => setState("modal", "settings")}
					title="Settings"
					aria-label="Settings"
				>
					<SettingsIcon />
				</button>
			</div>
		</aside>
	);
};
