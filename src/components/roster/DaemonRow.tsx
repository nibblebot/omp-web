import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
	type Component,
} from "solid-js";
import type { DaemonEntry, DaemonStatus, SessionListEntry } from "../../../shared/protocol";
import { sessionActivity, type SessionActivity } from "../../fleet-ui/session-activity";
import { unreadIds } from "../../fleet-ui/unread";
import {
	attachSession,
	removeDaemonById,
	requestDaemonSessions,
	resumeDaemonSession,
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

/** Roster entries may carry a template name, the last-session title, and
 *  per-repo git facts (branch + porcelain counts + numstat line counts)
 *  that the fleet edge may serialize; protocol.ts DaemonEntry is frozen so
 *  read all of them tolerantly. */
export type RosterEntry = DaemonEntry & {
	template?: string;
	/** Title of the daemon's last session file (probed by the fleet edge's
	 *  git-state poll from the lastSessionFile JSONL title slot; absent for
	 *  remote entries and older edges). */
	sessionTitle?: string;
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

/** Activity-dot tooltips (sessionActivity state → copy). Only the four
 *  non-idle states render a dot: blocked → red, in_progress → spinning
 *  green, unreviewed → yellow, unread → light blue. Idle renders nothing. */
const ACTIVITY_TITLE: Record<SessionActivity, string> = {
	in_progress: "in progress",
	blocked: "blocked — waiting for your input",
	unread: "unread — finished while viewing another session",
	unreviewed: "done — not reviewed yet",
	idle: "idle",
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

/** Which row's session dropdown (the last-10-sessions resume picker) is
 *  open, if any. Module-level for the same remount-safety reason as
 *  menuOpenId: roster broadcasts remount rows mid-interaction, and per-row
 *  signals would silently close the dropdown while it is open. */
export const [sessionsOpenId, setSessionsOpenId] = createSignal<string | null>(null);

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
	/** Whether THIS row's session dropdown is open (module-level open id). */
	const sessionsOpen = createMemo(() => sessionsOpenId() === d().daemonId);
	/** The session-title row text: the last session's title, else "New session"
	 *  for an empty/new untitled session (probed sessionEmpty), else nothing. */
	const sessionTitleText = createMemo(
		() => d().sessionTitle ?? (d().sessionEmpty === true ? "New session" : undefined),
	);
	/** Row ref anchors the dropdown's outside-pointerdown dismissal. */
	let rowRef!: HTMLDivElement;
	// Dismiss the dropdown on outside pointerdown or Escape (KebabMenu's
	// dismissal pattern, anchored to the whole row so clicks inside the
	// dropdown stay open).
	createEffect(() => {
		if (!sessionsOpen()) return;
		const close = () => setSessionsOpenId(null);
		const onPointerDown = (e: PointerEvent) => {
			if (!(e.target instanceof Element) || !rowRef.contains(e.target)) close();
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

	// Worktree sessions belong to a main checkout and read as branches, not
	// dirs — the branch (or name fallback) becomes the title and the project
	// chip + cwd path are dropped so the row never shows the directory.
	const isWorktree = () => d().worktreeOf !== undefined;
	// Root rows are a project group's MAIN worktree: the header already names
	// the project, so the row distills to a root glyph + branch-as-title (the
	// worktree profile, unindented) and drops the project chip + cwd line.
	const isRoot = () => props.inProjectGroup === true && !isWorktree();
	const isAttached = () => d().daemonId === state.currentSessionId;
	/** Activity dot for THIS row, derived from the attached session's live
	 *  signals (state.streaming / state.uiRequest / state.answerUnviewed —
	 *  the finished answer sitting below the scrolled-up viewport) plus the
	 *  edge's per-daemon realtime activity (state.daemonActivity — detached
	 *  rows get live blocked/in-progress via daemon_activity frames when the
	 *  edge broadcasts them) and the client-side unread set (detached rows
	 *  marked when a turn's end is observed or the user switches away — see
	 *  src/fleet-ui/unread.ts). Git dirtiness deliberately does NOT feed the
	 *  dot — uncommitted changes are the diffstat chips, a separate display.
	 *  Memoized so only signal flips re-render the row — the store reads
	 *  inside track state.streaming/state.uiRequest/state.answerUnviewed/
	 *  state.daemonActivity individually, and a roster broadcast replacing
	 *  the entry refires the memo. Only ready rows get a dot (sessionActivity
	 *  returns null otherwise). */
	const activity = createMemo(() =>
		sessionActivity(d(), {
			attached: isAttached(),
			streaming: state.streaming,
			uiPending: state.uiRequest !== null,
			unreviewed: state.answerUnviewed,
			// Signal read inside the memo: per-row reactivity off the unread set.
			unread: unreadIds().has(d().daemonId),
			// Store read inside the memo = per-row reactivity: undefined for the
			// attached row, old edges, and daemons whose stream is down.
			remote: state.daemonActivity[d().daemonId],
		}),
	);
	/** Only the non-idle activity states repaint the LEFT status dot. Idle
	 *  keeps the plain status dot (green for a live ready row). */
	const activityDot = createMemo(() => {
		const a = activity();
		return a && a !== "idle" ? a : undefined;
	});
	/** Copy for the active dot (undefined when idle — the dot keeps the plain
	 *  status color then). A separate memo so TS narrows the non-idle value
	 *  for the ACTIVITY_TITLE index instead of re-calling the getter in JSX. */
	const activityTitle = createMemo(() => {
		const a = activityDot();
		return a ? ACTIVITY_TITLE[a] : undefined;
	});

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

	// Clicking the row CARD (anything but the session-title line) resumes the
	// daemon's current session: ready rows attach; stopped (asleep) rows wake
	// (respawn --resume lastSessionFile) then attach — no dead space, the whole
	// card is the resume target. The session-title line is the dropdown trigger
	// (sessionTitleClick below); clicking an open dropdown's own entry resumes
	// that session.
	const rowClick = () => {
		if (activating()) return;
		// Clicking the card is a resume action — close any open dropdown (the
		// title click stops propagation, so this never fights the trigger).
		setSessionsOpenId(null);
		const daemon = d();
		if (daemon.status === "ready") {
			// Already the attached session: clicking its card is a no-op (a
			// redundant attach round-trip would also reset the chat view).
			if (daemon.daemonId === state.currentSessionId) return;
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

	/** Toggle this row's session dropdown (the session-title line only). */
	const sessionTitleClick = () => {
		if (activating()) return;
		const daemon = d();
		if (daemon.status !== "ready" && daemon.status !== "asleep") return;
		// The kebab menu closes so the two popups never stack; the card's
		// resume handler is suppressed by the title's stopPropagation.
		setMenuOpenId(null);
		setSessionsOpenId(sessionsOpenId() === daemon.daemonId ? null : daemon.daemonId);
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
				ref={rowRef}
				class="sidebar-row daemon-row"
				classList={{
					active: isAttached() || activating(),
					clickable: clickable() && !activating(),
					"daemon-row--nested": props.nested === true,
					"daemon-row--worktree": isWorktree(),
					"daemon-row--root": isRoot(),
				}}
				{...useClickableRow(rowClick, clickable())}
				title={
					waking()
						? "waking — session starting…"
						: isAttached()
							? "active session"
							: (STATUS_TITLE[d().status] ?? d().status)
				}
			>
				<span
					class="daemon-status-dot"
					data-status={waking() ? "resolving" : d().status}
					data-activity={activityDot()}
					role="status"
					aria-label={activityTitle() ?? d().status}
					title={activityTitle() ?? d().status}
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
							onOpenChange={(v) => {
								setMenuOpenId(v ? d().daemonId : null);
								// The two popups never stack: opening the kebab closes
								// the session dropdown.
								if (v) setSessionsOpenId(null);
							}}
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
					{/* Last-session title (probed by the fleet edge from the session
					    file's JSONL title slot; the worktree row is the motivating
					    case). An empty/new session has no title and renders "New
					    session" instead. The line is also the row's dropdown trigger:
					    clicking it opens the last-10-sessions resume picker (ready/
					    asleep rows only). Shows on every profile that carries it; the
					    line truncates and the tooltip exposes the full string. */}
					<Show when={sessionTitleText()}>
						{(title) => (
							<div
								class="daemon-session-title"
								classList={{ "daemon-session-title--clickable": clickable() }}
								title={clickable() ? `${title()} — click to view sessions` : title()}
								{...useClickableRow(sessionTitleClick, clickable())}
								onClick={(e) => {
									// The card's resume must NOT fire when opening the
									// dropdown from the title line.
									e.stopPropagation();
									if (clickable()) sessionTitleClick();
								}}
							>
								{title()}
							</div>
						)}
					</Show>
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
				{/* Session dropdown (last-10 in this worktree, newest-first); opens on
				    row click and is anchored to the row. Clicking an entry resumes
				    that session. Absent for non-clickable (transitional/error) rows. */}
				<Show when={sessionsOpen()}>
					<DaemonSessionsDropdown daemon={d()} onClose={() => setSessionsOpenId(null)} />
				</Show>
			</div>
			<Show when={detailOpen()}>
				<DaemonDetailView daemon={d()} onClose={() => setDetailOpen(false)} />
			</Show>
		</>
	);
};

// ---------------------------------------------------------------------------
// Session dropdown (DaemonSessionsDropdown): the worktree's last-10 sessions,
// newest-first, anchored to the row. Fetch happens on mount through the fleet
// edge (list_daemon_sessions) — asleep/never-started daemons answer from disk
// too, no live process needed. Clicking an entry resumes that session: asleep
// rows wake with spawn_resume carrying the file, ready rows attach (if not
// already) and switchSession to it.
// ---------------------------------------------------------------------------

/** Relative time ("2m ago") for the dropdown rows — SessionModal-style. */
function formatTimeAgo(ts: number): string {
	const diff = Date.now() - ts;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return new Date(ts).toLocaleDateString();
}

const DaemonSessionsDropdown: Component<{
	daemon: RosterEntry;
	onClose: () => void;
}> = (props) => {
	const [sessions, setSessions] = createSignal<SessionListEntry[]>([]);
	const [loading, setLoading] = createSignal(true);
	const [error, setError] = createSignal<string | null>(null);

	onMount(() => {
		requestDaemonSessions(props.daemon.daemonId)
			.then((list) => setSessions(list))
			.catch((err) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
	});

	/** The worktree's current session file (live file for the attached row). */
	const currentFile =
		props.daemon.daemonId === state.currentSessionId
			? state.sessionFile
			: props.daemon.lastSessionFile;

	const resume = (path: string) => {
		const id = props.daemon.daemonId;
		const wasAsleep = props.daemon.status === "asleep";
		// Wake pulse for an asleep row (mirrors the old row-click wake): set
		// the activating id before the resume, clear when the attach settles.
		if (wasAsleep) setActivatingIds((prev) => new Set(prev).add(id));
		const pending = resumeDaemonSession(id, path);
		props.onClose();
		if (wasAsleep) {
			Promise.resolve(pending)
				.catch(() => {})
				.finally(() =>
					setActivatingIds((prev) => {
						const next = new Set(prev);
						next.delete(id);
						return next;
					}),
				);
		}
	};

	return (
		<div class="daemon-session-menu" role="menu" onClick={(e) => e.stopPropagation()}>
			{loading() ? (
				<div class="daemon-session-note">loading sessions…</div>
			) : error() !== null ? (
				<div class="daemon-session-note">{error()}</div>
			) : sessions().length === 0 ? (
				<div class="daemon-session-note">no sessions yet</div>
			) : (
				<>
					<div class="daemon-session-menu-hint">resume a session</div>
					<For each={sessions()}>
						{(s) => (
							<button
								type="button"
								role="menuitem"
								class="sidebar-menu-item daemon-session-item"
								classList={{ active: currentFile === s.path }}
								title={s.cwd}
								onClick={() => resume(s.path)}
							>
								<span class="daemon-session-item-name">{s.name ?? s.id.slice(0, 8)}</span>
								<span class="daemon-session-item-time">{formatTimeAgo(s.modifiedAt)}</span>
							</button>
						)}
					</For>
				</>
			)}
		</div>
	);
};
