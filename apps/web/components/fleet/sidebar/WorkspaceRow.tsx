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
import type {
	DaemonEntry,
	DaemonStatus,
	LifecycleStage,
	SessionListEntry,
} from "#lib/wire/protocol";
import { sessionActivity, type SessionActivity } from "../../../fleet-ui/session-activity";
import { unreadIds } from "../../../fleet-ui/unread";
import { canStartRow, sessionChip } from "../../../fleet-ui/workspace-status";
import {
	call,
	closeDrawers,
	fetchCloneIntoProject,
	openDaemonDetails,
	requestDaemonSessions,
	resumeDaemonSession,
	sendWorktreeDeleteInfo,
	setState,
	spawnResume,
	startDaemonNewSession,
	state,
	stopDaemonById,
	wakeAndAttach,
} from "../../../state";
import { deletePendingIds } from "../../../store/projects";
import { switchToDaemon } from "../../../store/roster";
import { formatTimeAgo } from "../../../text/time-ago";
import { PAUSED_TOOLTIP } from "../../app/ConnectionBar";
import { projectLabelFromCwd, sessionStatus, type SessionRow } from "../../../store/session-list";
import { pushToast, reportError } from "../../../store/toasts";
import { isUserStopped } from "../../../store/user-stopped";
import { SessionPickerRow } from "../../sessions/SessionPickerRow";
import { ConfirmButton } from "../../ui/ConfirmButton";
import { KebabMenu } from "../../ui/KebabMenu";
import { useClickableRow } from "../../ui/PickerRow";
import { displayTitle } from "../../ui/title-icons";
import {
	ArrowDownIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	FileIcon,
	InfoIcon,
	LockIcon,
	PackageIcon,
	PlusIcon,
	RootIcon,
	StopIcon,
	TrashIcon,
	WorktreeIcon,
} from "../../ui/icons";

// ---------------------------------------------------------------------------
// One fleet-roster row: title, a corner slot at the top-right showing the
// status dot, label chips, git diffstat, and hover-revealed controls in one
// right-hand column: the "⋯" actions menu (details, Start/Restart, two-click
// stop, delete worktree; it replaces the dot while shown and its
// tooltip names the state), the chevron that opens the session dropdown, and
// "+" for a new session. Ready rows attach on click, asleep rows wake-then-attach.
// Each row is one checkout: a kind icon (main checkout, worktree, clone) and the
// branch (or detached sha) as the primary text. The group header names the
// project; the full path lives in the hover tooltip.
// ---------------------------------------------------------------------------

/** Roster entries may carry a template name, the last-session title, and
 *  per-repo git facts (branch + porcelain counts + numstat line counts)
 *  that the fleet edge may serialize; protocol.ts DaemonEntry is frozen so
 *  read all of them tolerantly. */
export type RosterEntry = DaemonEntry & {
	template?: string;
	/** Title of the daemon's last session file (probed by the fleet edge's
	 *  git-state poll from the lastSessionFile JSONL title slot; absent until
	 *  there is a title to probe). */
	sessionTitle?: string;
	/** Current branch of the session cwd; absent for detached/non-git/unprobed. */
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
	blocked: "blocked, waiting for your input",
	unread: "unread, finished while viewing another session",
	unreviewed: "done, not reviewed yet",
	idle: "idle",
};

const STATUS_TITLE: Record<DaemonStatus, string> = {
	spawning: "starting the session process…",
	connecting: "connecting to the session process…",
	session: "session created…",
	resolving: "resolving provider/model…",
	ready: "ready, click to attach",
	asleep: "asleep, click to wake and attach",
	reconnecting: "reconnecting…",
	error: "error, see details",
};

/** Provider lifecycle stage copy for clone rows (only stages that need
 *  row presence render; "ready" is implied by the ready status dot). */
const LIFECYCLE_LABEL: Record<NonNullable<RosterEntry["lifecycleStage"]>, string> = {
	preparation: "preparing workspace",
	runtime: "starting runtime",
	callback: "connecting channel",
	ready: "ready",
	failed: "failed",
};

/** Which row's "⋯" actions menu is open, if any. Module-level so there is
 *  one open menu total across all rows (opening one closes another) and the
 *  state is readable outside a row (ProjectGroups headers share it). Rows no
 *  longer remount on roster frames (the roster reconciles by daemonId), but a
 *  row that leaves the roster still releases its menu through this one
 *  signal. Daemon rows key on the daemonId, project-group headers
 *  (ProjectGroups) on `project:<id>`. */
export const [menuOpenId, setMenuOpenId] = createSignal<string | null>(null);

/** Which row's session dropdown (the last-10-sessions resume picker) is
 *  open, if any. Module-level for the same one-open-total semantics as
 *  menuOpenId: opening one row's dropdown closes any other. */
export const [sessionsOpenId, setSessionsOpenId] = createSignal<string | null>(null);

/** DaemonIds with a wake-attach in flight (asleep-row click → attach
 *  settles). Module-level so it survives a row unmounting mid-wake (the row
 *  leaving the roster, or a reconnect resetting the sidebar); per-row
 *  component signals would not survive that. */
const [activatingIds, setActivatingIds] = createSignal<ReadonlySet<string>>(new Set());

/** Clear a row's activating mark once its wake/attach/new-session settles. */
function endActivating(id: string): void {
	setActivatingIds((prev) => {
		const next = new Set(prev);
		next.delete(id);
		return next;
	});
}

export const WorkspaceRow: Component<{
	daemon: DaemonEntry;
	nested?: boolean;
	/** Rendered inside a registered-project group (ProjectGroups ProjectGroup):
	 *  the group header carries the project name, so an untagged row here is
	 *  the main worktree and distills to the root profile. */
	inProjectGroup?: boolean;
	/** The project's main checkout is missing on disk: rows cannot start. */
	projectMissing?: boolean;
}> = (props) => {
	const d = () => props.daemon as RosterEntry;
	// Row actions go to the fleet, not to the attached session: only a dropped
	// browser socket pauses them. A dead attached session ("offline") must not,
	// since starting, stopping or switching rows is the way out of it.
	const paused = () => !state.connected;

	// Per-row id-scoped reads: the module signals (menuOpenId/activatingIds)
	// change on ANY row's interaction, so a plain read would re-render every
	// row. Each derived memo re-runs when the module signal changes but only
	// notifies the row when ITS OWN membership flips, so one row's menu-open
	// wake no longer re-renders the whole roster.
	const activating = createMemo(() => activatingIds().has(d().daemonId));
	/** The delete was submitted; the row dims now and collapses when the roster drops it. */
	const deleting = createMemo(() => deletePendingIds().has(d().daemonId));
	const menuOpen = createMemo(() => menuOpenId() === d().daemonId);
	/** Whether THIS row's session dropdown is open (module-level open id). */
	const sessionsOpen = createMemo(() => sessionsOpenId() === d().daemonId);
	/** The session-title row text: the last session's title, else "no session yet". */
	const sessionTitleText = createMemo(() => displayTitle(d().sessionTitle) ?? "no session yet");
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
	// dirs. The branch (or name fallback) becomes the title and the project
	// chip + cwd path are dropped so the row never shows the directory.
	const isWorktree = () => d().worktreeOf !== undefined;
	// Provider-run clone workspaces: independent checkouts that must
	// NOT read as the project's main checkout (which would put a root glyph
	// on them and hide the group's Start action).
	const isClone = () => d().workspaceKind === "clone";
	/** The clone's fleet profile record, when the catalog still has it. */
	const cloneProfile = () =>
		isClone() && d().providerProfileId !== undefined
			? state.providerProfiles.find((p) => p.id === d().providerProfileId)
			: undefined;
	// Root rows are a project group's MAIN worktree: the header already names
	// the project, so the row distills to a root glyph + branch-as-title (the
	// worktree profile, unindented) and drops the project chip + cwd line.
	// Clones are siblings of the main checkout, never root rows.
	const isRoot = () => props.inProjectGroup === true && !isWorktree() && !isClone();
	/** Project folder missing on disk: the group shows it, rows cannot start. */
	const blocked = () => props.projectMissing === true;
	/** Kind text for the left icon's aria-label and tooltip. */
	const kindLabel = (): string => {
		if (!isClone()) return isWorktree() ? "worktree" : "main checkout";
		const profile = d().providerProfileId;
		return profile !== undefined ? `clone · ${profile}` : "clone";
	};
	/** Primary row text: branch, detached sha for detached checkouts, clone name. */
	const primaryText = (): string => {
		if (isClone()) return d().name;
		if (d().detachedAt !== undefined) return `detached @ ${d().detachedAt}`;
		return d().branch ?? d().name;
	};
	/** Non-ready provider lifecycle stage for clone rows, else undefined;
	 *  Show narrows the child callback to the stage STRING (never `true`). */
	const activeStage = (): Exclude<LifecycleStage, "ready"> | undefined => {
		const st = d().lifecycleStage;
		return isClone() && st !== undefined && st !== "ready" ? st : undefined;
	};
	const isAttached = () => d().daemonId === state.currentSessionId;
	/** Selected row: the switch target while its switch is waking/attaching or failed (the
	 *  old session is still attached underneath a failed one, so currentSessionId alone
	 *  would snap the highlight back); otherwise the attached session. A superseded or
	 *  cancelled switch clears the target and the highlight returns to the attached row. */
	const selected = createMemo(() => {
		const phase = state.transcriptPhase;
		const target = state.transcriptTarget;
		if (target !== null && (phase === "waking" || phase === "attaching" || phase === "failed"))
			return target === d().daemonId;
		return isAttached();
	});
	/** Activity dot for THIS row, derived from the attached session's live
	 *  signals (state.streaming / state.uiRequest / state.answerUnviewed,
	 *  finished answer sitting below the scrolled-up viewport) plus the
	 *  edge's per-daemon realtime activity (state.daemonActivity, where detached
	 *  rows get live blocked/in-progress via daemon_activity frames when the
	 *  edge broadcasts them) and the client-side unread set (detached rows
	 *  marked when a turn's end is observed or the user switches away; see
	 *  src/fleet-ui/unread.ts). Git dirtiness deliberately does NOT feed the
	 *  dot; uncommitted changes are the diffstat chips, a separate display.
	 *  Memoized so only signal flips re-render the row; the store reads
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
			// attached row and any daemon with no reading yet (stream down or
			// activity still unknown).
			remote: state.daemonActivity[d().daemonId],
		}),
	);
	/** Only the non-idle activity states repaint the status dot. Idle keeps
	 *  the plain status dot (green for a live ready row). */
	const activityDot = createMemo(() => {
		const a = activity();
		return a && a !== "idle" ? a : undefined;
	});

	const clickable = () =>
		!blocked() && !deleting() && (d().status === "ready" || d().status === "asleep");
	/** Loading phase: activating but the daemon isn't ready yet. Renders with
	 *  the pulsing transitional ("resolving") visual vocabulary. */
	const waking = () => activating() && d().status !== "ready";
	/** Process state behind the status dot's tooltip and the kebab's
	 *  Start/Restart item. Both read the user-stopped mark so a stopped
	 *  process reads Stopped, not Asleep. */
	const chip = createMemo(() =>
		sessionChip(d().status, { waking: activating(), stoppedByUser: isUserStopped(d().daemonId) }),
	);
	/** Status dot label: the process state, plus the activity when non-idle. */
	const statusLabel = createMemo(() => {
		const a = activityDot();
		return a ? `${chip().label}, ${ACTIVITY_TITLE[a]}` : chip().label;
	});

	const startable = createMemo(() => canStartRow(d().status, { waking: activating() }));
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
	/** "1 file" / "3 files", English plural for the diffstat titles. */
	const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

	/** Start a row's session process, then attach so the pane follows it.
	 *  The row pulses until the attach settles. */
	const activateRow = (id: string, wake: () => Promise<boolean>) => {
		setActivatingIds((prev) => new Set(prev).add(id));
		// The attach is posted only once the wake command is acked (see wakeAndAttach).
		wakeAndAttach(id, wake())
			.catch(reportError)
			.finally(() => endActivating(id));
	};

	// Clicking the row CARD (anything but the chevron, "+" and kebab buttons,
	// title line included) resumes the daemon's current session: a ready session
	// process attaches; a stopped (asleep) one wakes then attaches (switchToDaemon
	// covers both, and owns the transcript phase). The whole card is the resume
	// target, leaving no dead space. The row highlights at once (switch-target.ts);
	// the pane follows when the switch settles. The chevron is the dropdown
	// trigger (sessionsToggleClick below); clicking an open dropdown's own entry
	// resumes that session.
	const rowClick = () => {
		if (activating() || deleting()) return;
		// A pick changes the main pane: a drawer sidebar gets out of the way now
		// instead of when the attach lands.
		closeDrawers();
		// Clicking the card is a resume action, so close any open dropdown (the
		// chevron click stops propagation, so this never fights the trigger).
		setSessionsOpenId(null);
		const daemon = d();
		if (paused()) {
			pushToast(PAUSED_TOOLTIP.reconnecting);
			return;
		}
		if (daemon.status !== "ready" && daemon.status !== "asleep") return;
		// Already the attached session: clicking its card is a no-op (a
		// redundant attach round-trip would also reset the chat view). A failed
		// switch to this row leaves the old session attached, so it still retries.
		if (
			daemon.status === "ready" &&
			daemon.daemonId === state.currentSessionId &&
			state.transcriptPhase === "loaded"
		)
			return;
		const id = daemon.daemonId;
		// Asleep rows keep the waking pulse until the switch settles.
		if (daemon.status === "asleep") setActivatingIds((prev) => new Set(prev).add(id));
		void switchToDaemon(id).finally(() => endActivating(id));
	};

	/** The kebab's Start item: spawn the session process, then attach so the
	 *  pane follows it. */
	const startRow = () => {
		if (activating() || blocked()) return;
		closeDrawers();
		setSessionsOpenId(null);
		setMenuOpenId(null);
		const id = d().daemonId;
		activateRow(id, () => spawnResume(id));
	};

	/** Toggle this row's session dropdown (the chevron only). */
	const sessionsToggleClick = () => {
		if (activating()) return;
		const daemon = d();
		if (daemon.status !== "ready" && daemon.status !== "asleep") return;
		// The kebab menu closes so the two popups never stack; the card's
		// resume handler is suppressed by the chevron's stopPropagation.
		setMenuOpenId(null);
		setSessionsOpenId(sessionsOpenId() === daemon.daemonId ? null : daemon.daemonId);
	};

	/** The "+" under the session chevron: start a fresh session in this
	 *  worktree (asleep rows wake first). The row pulses until it settles. */
	const newSessionClick = () => {
		if (activating()) return;
		if (paused()) {
			pushToast(PAUSED_TOOLTIP.reconnecting);
			return;
		}
		closeDrawers();
		setSessionsOpenId(null);
		setMenuOpenId(null);
		const id = d().daemonId;
		setActivatingIds((prev) => new Set(prev).add(id));
		void startDaemonNewSession(id).finally(() => endActivating(id));
	};

	const doStop = () => {
		stopDaemonById(d().daemonId);
		setMenuOpenId(null);
	};

	return (
		<>
			<div
				ref={rowRef}
				class="sidebar-row daemon-row"
				data-roster-item
				aria-busy={deleting() ? "true" : undefined}
				classList={{
					active: selected() || activating(),
					clickable: clickable() && !activating(),
					"daemon-row--deleting": deleting(),
					"daemon-row--nested": props.nested === true,
					"daemon-row--worktree": isWorktree(),
					"daemon-row--root": isRoot(),
					"daemon-row--clone": isClone(),
					"daemon-row--switcher": clickable(),
				}}
				{...useClickableRow(rowClick, clickable())}
				title={
					waking()
						? "waking, session starting…"
						: isAttached()
							? "active session"
							: (STATUS_TITLE[d().status] ?? d().status)
				}
			>
				<div class="sidebar-row-main">
					<div class="sidebar-row-top">
						<span class="sidebar-row-title daemon-row-title" title={d().cwd}>
							<span
								class="daemon-kind-icon"
								role="img"
								aria-label={kindLabel()}
								title={kindLabel()}
							>
								<Show when={isClone()}>
									<PackageIcon />
								</Show>
								<Show when={!isClone() && isWorktree()}>
									<WorktreeIcon />
								</Show>
								<Show when={!isClone() && !isWorktree()}>
									<RootIcon />
								</Show>
							</span>
							{primaryText()}
							<Show when={d().worktreeLocked === true}>
								<span
									class="daemon-lock-icon"
									role="img"
									aria-label="locked worktree"
									title="locked worktree"
								>
									<LockIcon />
								</span>
							</Show>
						</span>
						{/* Corner slot at the top-right, on the axis of the session
						    chevron and "+" below it. At rest it shows the status dot; on
						    row hover/focus (or an open menu/dropdown) the dot fades out
						    and the "⋯" row-actions menu fades in over the same spot, its
						    tooltip naming the state. On touch the menu is always shown and
						    the dot rides on it as a badge (fleet.css). Stop keeps the
						    two-click confirm inside the menu; the first click arms (menu
						    stays open), the second executes and closes. */}
						<span class="daemon-row-corner">
							<span
								class="daemon-row-status"
								role="status"
								aria-label={`${statusLabel()}. ${chip().title}`}
							>
								<span
									class="daemon-status-dot"
									data-status={waking() ? "resolving" : d().status}
									data-activity={activityDot()}
								/>
							</span>
							<KebabMenu
								label="Row actions"
								title={`Row actions\n${statusLabel()}\n${chip().title}`}
								open={menuOpen()}
								onOpenChange={(v) => {
									setMenuOpenId(v ? d().daemonId : null);
									// The two popups never stack: opening the kebab closes
									// the session dropdown.
									if (v) setSessionsOpenId(null);
								}}
							>
								{/* Lifecycle first (start, stop), then details, destructive
								    last. Stop keeps the two-click confirm inside the menu.
								    Asleep clones start through "Start workspace" below. */}
								<Show when={!(isClone() && d().status === "asleep") && startable()}>
									<button
										type="button"
										role="menuitem"
										class="sidebar-menu-item"
										disabled={paused() || blocked()}
										title={
											paused()
												? PAUSED_TOOLTIP.reconnecting
												: blocked()
													? "Project folder is missing; this checkout cannot start"
													: "Starts the session process and attaches to it"
										}
										onClick={startRow}
									>
										<ChevronRightIcon />
										Start {isClone() ? "workspace" : "session"}
									</button>
								</Show>
								<Show when={isClone() && d().status === "asleep"}>
									<button
										type="button"
										role="menuitem"
										class="sidebar-menu-item"
										title={
											paused()
												? PAUSED_TOOLTIP.reconnecting
												: "Starts the clone workspace (checkout and session logs are preserved)"
										}
										disabled={paused()}
										onClick={() => {
											setMenuOpenId(null);
											void spawnResume(d().daemonId);
										}}
									>
										<ChevronRightIcon />
										Start workspace
									</button>
								</Show>
								<Show when={d().status !== "asleep"}>
									<ConfirmButton
										role="menuitem"
										class="sidebar-menu-item"
										label={isClone() ? "Stop workspace" : "Stop session"}
										confirmLabel="Confirm stop"
										title={
											isClone()
												? "Stops the clone's compute; checkout and session logs are preserved"
												: "Stops the session process; the transcript is kept"
										}
										onConfirm={() => doStop()}
									>
										<StopIcon />
									</ConfirmButton>
								</Show>
								<Show when={isClone() && isAttached()}>
									<button
										type="button"
										role="menuitem"
										class="sidebar-menu-item"
										title={
											paused()
												? PAUSED_TOOLTIP.reconnecting
												: "Interrupts the running turn; the workspace keeps running"
										}
										disabled={paused()}
										onClick={() => {
											setMenuOpenId(null);
											void call("abort").catch(reportError);
										}}
									>
										<StopIcon />
										Stop current work
									</button>
								</Show>
								<button
									type="button"
									role="menuitem"
									class="sidebar-menu-item"
									onClick={() => {
										setMenuOpenId(null);
										openDaemonDetails(d().daemonId);
									}}
								>
									<InfoIcon />
									Process details
								</button>
								<Show when={isWorktree() && !isClone()}>
									<button
										type="button"
										role="menuitem"
										class="sidebar-menu-item sidebar-menu-item--danger"
										title="Stops the session process and removes the worktree (guard checks first)"
										disabled={deleting()}
										onClick={() => {
											setMenuOpenId(null);
											sendWorktreeDeleteInfo(d().daemonId);
											setState("deleteWorkspaceTarget", d().daemonId);
										}}
									>
										<TrashIcon />
										Delete worktree…
									</button>
								</Show>
								{/* Only a clone cut from the project's local path has a branch the
							    project lacks; a remote-source clone pushes upstream from inside. */}
								<Show when={isClone() && d().localSource === true}>
									<button
										type="button"
										role="menuitem"
										class="sidebar-menu-item"
										title={
											paused()
												? PAUSED_TOOLTIP.reconnecting
												: "Fetches the clone's committed branch into the project (creates it or fast-forwards; never overwrites)"
										}
										disabled={paused()}
										onClick={() => {
											setMenuOpenId(null);
											void fetchCloneIntoProject(d().daemonId);
										}}
									>
										<ArrowDownIcon />
										Fetch into project
									</button>
								</Show>
								<Show when={isClone()}>
									<button
										type="button"
										role="menuitem"
										class="sidebar-menu-item sidebar-menu-item--danger"
										title={
											paused()
												? PAUSED_TOOLTIP.reconnecting
												: "Verified delete: refuses active work, verifies the fleet transcript store, then removes compute, storage, and the checkout"
										}
										disabled={paused() || deleting()}
										onClick={() => {
											setMenuOpenId(null);
											setState("deleteWorkspaceTarget", d().daemonId);
										}}
									>
										<TrashIcon />
										Delete workspace…
									</button>
								</Show>
							</KebabMenu>
						</span>
					</div>
					{/* Session switcher: the last session's title (probed by the
					    fleet edge from the session file's JSONL title slot; "no
					    session yet" for an untitled one) plus a bare chevron in the
					    row's right gutter, on the corner slot's column. The title is
					    part of the card (click resumes); only the chevron opens the
					    last-10-sessions resume picker (ready/asleep rows only); other
					    rows show the bare title. The title wraps to at most two lines
					    and the tooltip exposes the full string. A "+" under the
					    chevron starts a fresh session in this worktree. Both show on
					    row hover/focus like the "⋯" menu (always on touch). */}
					<Show
						when={clickable()}
						fallback={
							<div class="daemon-session-title" title={sessionTitleText()}>
								{sessionTitleText()}
							</div>
						}
					>
						<div class="daemon-session-switcher">
							<div
								class="daemon-session-title daemon-session-title--switcher"
								title={sessionTitleText()}
							>
								{sessionTitleText()}
							</div>
							<button
								type="button"
								class="daemon-session-toggle"
								aria-expanded={sessionsOpen()}
								aria-label="Switch session"
								title="Switch session"
								onClick={(e) => {
									// The card's resume must NOT fire when opening the
									// dropdown.
									e.stopPropagation();
									sessionsToggleClick();
								}}
							>
								<ChevronDownIcon class="daemon-session-chevron" />
							</button>
							<button
								type="button"
								class="daemon-session-new"
								aria-label="New session in this worktree"
								title="New session in this worktree"
								onClick={(e) => {
									// The card's resume must NOT fire as well.
									e.stopPropagation();
									newSessionClick();
								}}
							>
								<PlusIcon class="daemon-session-new-icon" />
							</button>
						</div>
					</Show>
					<Show when={cloneProfile() !== undefined || d().labels.length > 0}>
						<div class="daemon-chips">
							<Show when={cloneProfile()}>
								{(p) => (
									<span
										class="daemon-chip daemon-chip--profile"
										title={`profile ${p().id} (${p().provider})`}
									>
										{p().id}
									</span>
								)}
							</Show>
							<For each={d().labels}>
								{(l) => (
									<span class="daemon-chip daemon-chip--label" title={`label ${l}`}>
										{l}
									</span>
								)}
							</For>
						</div>
					</Show>
					{/* Provider lifecycle progress: preparation → runtime →
					    callback → ready, shown while a clone workspace is being
					    created/recovered; "ready" renders nothing extra (the status
					    dot already says it). A failed stage is actionable: the
					    lifecycle error text plus a Retry that re-issues the wake
					    command the backend routes to the lifecycle service.
					    activeStage() gates the Show, so the callback narrows to
					    the stage string, not `true`. */}
					<Show when={activeStage()}>
						{(stage) => (
							<div
								class="daemon-stage"
								classList={{ "daemon-stage--failed": stage() === "failed" }}
								role="status"
							>
								<Show when={stage() === "failed"}>
									<span class="daemon-stage-error">
										{d().lifecycleError ?? "workspace lifecycle failed"}
									</span>
									<button
										type="button"
										class="daemon-stage-retry"
										title={
											paused()
												? PAUSED_TOOLTIP.reconnecting
												: "Retry the workspace start (backend admission applies)"
										}
										disabled={paused()}
										onClick={(e) => {
											e.stopPropagation();
											void spawnResume(d().daemonId);
										}}
									>
										Retry
									</button>
								</Show>
								<Show when={stage() !== "failed"}>
									<span class="daemon-stage-label">{LIFECYCLE_LABEL[stage()]}…</span>
								</Show>
							</div>
						)}
					</Show>
					{/* Bottom meta row: the diffstat cluster (changed-file count +
					    numstat +/- line counts when probed). Row actions live in the
					    "⋯" menu on the top row. Rendered only when there is git info
					    to show. */}
					<Show when={hasGitStats()}>
						<div class="daemon-git">
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
		</>
	);
};

// ---------------------------------------------------------------------------
// Session dropdown (DaemonSessionsDropdown): the worktree's last-10 sessions,
// newest-first, anchored to the row. Fetch happens on mount through the fleet
// edge (list_daemon_sessions); asleep/never-started daemons answer from disk
// too, no live process needed. Clicking an entry resumes that session: asleep
// rows wake with spawn_resume carrying the file, ready rows attach (if not
// already) and switchSession to it.
// ---------------------------------------------------------------------------

const DaemonSessionsDropdown: Component<{
	daemon: RosterEntry;
	onClose: () => void;
}> = (props) => {
	const [sessions, setSessions] = createSignal<SessionListEntry[]>([]);
	const [loading, setLoading] = createSignal(true);
	const [error, setError] = createSignal<string | null>(null);
	const nowMs = Date.now();

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

	/** Dropdown rows in the shared SessionRow shape; this path carries no pin state. */
	const rows = (): SessionRow[] =>
		sessions().map((s) => {
			const status = sessionStatus(s.status);
			return {
				id: s.id,
				file: s.path,
				...(s.name ? { title: s.name } : {}),
				...(s.firstMessage ? { firstMessage: s.firstMessage } : {}),
				...(status !== undefined ? { status } : {}),
				cwd: s.cwd,
				projectLabel: projectLabelFromCwd(s.cwd),
				modifiedMs: s.modifiedAt,
				messageCount: s.messageCount,
				pinned: false,
				scope: "local",
				current: s.path === currentFile,
			};
		});

	const resume = (path: string) => {
		const id = props.daemon.daemonId;
		const wasAsleep = props.daemon.status === "asleep";
		// Wake pulse for an asleep row (mirrors the row-click wake): set the
		// activating id before the resume, clear when the attach settles.
		if (wasAsleep) setActivatingIds((prev) => new Set(prev).add(id));
		const pending = resumeDaemonSession(id, path);
		props.onClose();
		closeDrawers();
		if (wasAsleep) {
			Promise.resolve(pending)
				.catch(() => {})
				.finally(() => endActivating(id));
		}
	};

	return (
		<div
			class="daemon-session-menu"
			role="group"
			aria-label="Sessions in this worktree"
			onClick={(e) => e.stopPropagation()}
		>
			{loading() ? (
				<div class="daemon-session-note">loading sessions…</div>
			) : error() !== null ? (
				<div class="daemon-session-note">{error()}</div>
			) : sessions().length === 0 ? (
				<div class="daemon-session-note">no sessions yet</div>
			) : (
				<>
					<div class="daemon-session-menu-hint">
						Sessions in this worktree · last 10 · click to resume
					</div>
					<For each={rows()}>
						{(row) => (
							<SessionPickerRow
								row={row}
								active={false}
								showProject={false}
								nowMs={nowMs}
								onChoose={() => resume(row.file)}
							/>
						)}
					</For>
				</>
			)}
		</div>
	);
};
