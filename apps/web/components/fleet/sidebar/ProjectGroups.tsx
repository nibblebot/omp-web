import {
	createComputed,
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onMount,
	Show,
	type Component,
} from "solid-js";
import type { RosterEntry, RegisteredProject } from "#lib/wire/protocol";
import {
	projectRollup,
	rollupSummary,
	shownWhenRunningOnly,
} from "../../../fleet-ui/workspace-status";
import { rowActivity } from "../../../fleet-ui/row-activity";
import { isFeatureEnabled } from "../../../features/registry";
import { afterMotion } from "../../../motion/presence";
import { setState, state } from "../../../state";
import {
	clearAllDeletePending,
	clearDeletePending,
	closeNewWorkspace,
	fetchOmpSetup,
	openNewWorkspace,
	syncProjects,
} from "../../../store/projects";
import { KebabMenu } from "../../ui/KebabMenu";
import { FolderClosedIcon, FolderOpenIcon, MoonIcon, PlusIcon, TrashIcon } from "../../ui/icons";
import { NewWorkspacePopover } from "./NewWorkspacePopover";
import { RowMotion } from "./RowMotion";
import { RowSignal } from "./RowSignal";
import {
	finishRowExit,
	initialRowSlots,
	reconcileRowSlots,
	type RowSlot,
} from "../../../fleet-ui/row-presence";
import { WorkspaceRow, menuOpenId, setMenuOpenId } from "./WorkspaceRow";

// ---------------------------------------------------------------------------
// Project-grouped roster rendering: one collapsible group per registered
// project, then an "Add project" row at the bottom of the list (opens the
// Add project dialog). The header carries the folder icon (open while the
// group is expanded, closed while collapsed) and the name, then a
// tail laid out like a row's right edge: while the group is collapsed, a
// muted summary (rail mark + live/total, or moon + asleep count) with the most urgent
// row signal in the corner column (fleet-ui/workspace-status.ts projectRollup,
// RowSignal); on header hover the summary gives way to the "+" that opens
// the New workspace popover (anchored to the "+") and the signal to the "⋯"
// menu with Remove project. Rows are one per checkout (main checkout,
// worktrees, clones). Per-group collapse state persists in localStorage. Row
// and project menus share the single module-level open-menu id
// (WorkspaceRow.tsx). Each group renders its rows through RowMotion: a row
// new to the roster enters, a row that left it stays rendered (inert) until
// its exit motion ends (fleet-ui/row-presence.ts derives that list).
// ---------------------------------------------------------------------------

/** localStorage key for the roster sidebar's collapsed group headers (the design
 *  system clears it between stories). */
export const GROUPS_KEY = "omp.sidebarGroupsCollapsed";

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

/** Project-first group list as derived by the shell (sessionsByProject). */
export type ProjectGroupsData = {
	project: RegisteredProject;
	sessions: RosterEntry[];
}[];

/** Empty roster: the add hint, plus a no-provider notice when no model provider
 *  is configured (with a sign-in button while Provider Login is on). A failed
 *  omp-setup probe shows only the add hint. */
const EmptyProjects: Component = () => {
	const [noProvider, setNoProvider] = createSignal(false);
	onMount(() => {
		fetchOmpSetup()
			.then((s) => setNoProvider(s.providers.length === 0))
			.catch(() => setNoProvider(false));
	});
	return (
		<div class="sidebar-empty">
			<p>No projects yet. Add one below.</p>
			<Show when={noProvider()}>
				<p>No model provider signed in.</p>
				<Show when={isFeatureEnabled("providers")}>
					<button
						type="button"
						class="sidebar-empty-action"
						onClick={() => setState("modal", "login")}
					>
						Sign in
					</button>
				</Show>
			</Show>
		</div>
	);
};

export const ProjectGroups: Component<{ groups: ProjectGroupsData }> = (props) => {
	// A delete refusal arrives as an uncorrelated error frame (state.error): the
	// pending-delete dims un-dim. A transport failure clears its own (store/projects.ts).
	createEffect(
		on(
			() => state.error,
			(err) => {
				if (err !== null) clearAllDeletePending();
			},
			{ defer: true },
		),
	);
	const [collapsedGroups, setCollapsedGroups] = createSignal<Set<string>>(readCollapsedGroups());

	/** Flip a group's collapse state and persist the updated key set.
	 *  Expanding a group re-syncs the project registry (throttled in the store). */
	const toggleGroup = (key: string) => {
		const expanding = collapsedGroups().has(key);
		const next = new Set(collapsedGroups());
		if (expanding) next.delete(key);
		else next.add(key);
		setCollapsedGroups(next);
		if (typeof localStorage !== "undefined")
			localStorage.setItem(GROUPS_KEY, JSON.stringify([...next]));
		if (expanding) syncProjects();
	};

	/** Rows the sidebar shows: all of them, or with "running only" on, those
	 *  that are not asleep plus the pinned ones (the attached session and the
	 *  target of a switch that is waking, attaching or failed, which the row's
	 *  `selected` highlight follows). */
	const shownRows = (sessions: RosterEntry[]): RosterEntry[] => {
		if (!state.sidebarRunningOnly) return sessions;
		const target = state.transcriptTarget;
		const switching =
			state.transcriptPhase === "waking" ||
			state.transcriptPhase === "attaching" ||
			state.transcriptPhase === "failed";
		return sessions.filter((d) =>
			shownWhenRunningOnly(
				d.status,
				d.workspaceId === state.currentWorkspaceId || (switching && d.workspaceId === target),
			),
		);
	};

	/** One registered-project group: collapsible header (folder icon, name, and a
	 *  right tail: roll-up summary and signal while collapsed, the "+" New
	 *  workspace trigger (git projects only) and the "⋯" menu carrying Remove
	 *  project on header hover), then one row per checkout in sessionsByProject
	 *  order. */
	const ProjectGroup: Component<{ project: RegisteredProject; sessions: RosterEntry[] }> = (
		props,
	) => {
		const gkey = `project:${props.project.projectId}`;
		const open = () => !collapsedGroups().has(gkey);
		/** One entry per checkout: its status and, for a ready one, its activity
		 *  (the same derivation the row uses, so group and rows always agree). */
		const rollup = createMemo(() =>
			projectRollup(props.sessions.map((d) => ({ status: d.status, activity: rowActivity(d) }))),
		);
		// Id-scoped read of the shared open-menu signal: the menu closes only
		// when THIS project's key changes, so other groups' toggles don't
		// re-render this header.
		const menuOpen = createMemo(() => menuOpenId() === gkey);
		const missing = () => props.project.missing === true;
		const popoverOpen = () => state.newWorkspaceProjectId === props.project.projectId;
		const highlighted = () => state.highlightProjectId === props.project.projectId;
		const [plusEl, setPlusEl] = createSignal<HTMLButtonElement>();
		let groupRef!: HTMLDivElement;

		// Palette or session-picker highlight: bring the group into view; the
		// flash class follows highlightProjectId, which is released when the
		// flash animation ends (the flash length lives only in CSS).
		createEffect(
			on(highlighted, (hit) => {
				if (!hit) return;
				groupRef.scrollIntoView({ block: "nearest", behavior: "smooth" });
				const projectId = props.project.projectId;
				void afterMotion(groupRef).then(() => {
					if (state.highlightProjectId === projectId) setState("highlightProjectId", null);
				});
			}),
		);

		// Rows the sidebar shows (shownRows). The roll-up above stays on every row.
		const visibleSessions = createMemo(() => shownRows(props.sessions));

		// Rendered rows: the live ones plus rows still playing their exit. Seeded
		// from the first render, so page load never animates; a row enters only
		// when its workspaceId was not rendered before. The roster counts as arrived
		// only after the first roster frame (`armed` trails state.rosterLoaded by
		// one run), so the frame that fills an initially empty list animates
		// nothing. A collapsed group animates nothing either: expanding it never
		// counts its rows as new. A row the filter hides exits like a removed one.
		const [slots, setSlots] = createSignal<RowSlot<RosterEntry>[]>(
			initialRowSlots(visibleSessions(), (d) => d.workspaceId),
		);
		let armed = state.rosterLoaded;
		createComputed(
			on(
				[visibleSessions, open, () => state.rosterLoaded],
				([sessions, isOpen, loaded]) => {
					// A pending delete clears only when the row left the roster, not
					// when the filter merely hides it.
					const inRoster = new Set(props.sessions.map((d) => d.workspaceId));
					for (const slot of slots()) if (!inRoster.has(slot.id)) clearDeletePending(slot.id);
					setSlots((prev) =>
						reconcileRowSlots(prev, sessions, (d) => d.workspaceId, isOpen && armed),
					);
					armed = loaded;
				},
				{ defer: true },
			),
		);
		const rowIds = createMemo(() => slots().map((s) => s.id), [], {
			equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
		});
		const slotsById = createMemo(() => new Map(slots().map((s) => [s.id, s])));

		const onPlus = () => {
			if (popoverOpen()) {
				closeNewWorkspace();
				return;
			}
			if (!open()) toggleGroup(gkey);
			openNewWorkspace(props.project.projectId);
		};

		// The "+" is gone once the project turns plain-folder: its popover would
		// stay anchored to a detached button and every submit would be refused.
		createEffect(() => {
			if (props.project.git === false && popoverOpen()) closeNewWorkspace();
		});

		return (
			<>
				<div
					ref={groupRef}
					class="sidebar-group project-group"
					classList={{
						"project-group--missing": missing(),
						"project-group--highlight": highlighted(),
					}}
				>
					<button
						type="button"
						class="project-group-toggle"
						data-roster-item
						aria-expanded={open()}
						data-open={open() ? "true" : "false"}
						onClick={() => toggleGroup(gkey)}
					>
						<Show when={open()} fallback={<FolderClosedIcon class="project-group-icon" />}>
							<FolderOpenIcon class="project-group-icon" />
						</Show>
						<span class="sidebar-group-label" title={props.project.path}>
							{props.project.name}
						</span>
						<Show when={missing()}>
							<span class="project-missing-chip" title="Project folder is missing on disk">
								missing
							</span>
						</Show>
					</button>
					{/* Right tail, laid out like a row's right edge. The first slot holds
					    the summary (collapsed, or open with every row filtered out) at rest
					    and the "+" on header hover (one grid cell: no layout shift); the
					    corner column holds the most urgent row signal at rest and the "⋯"
					    menu on hover, as a row's corner does. */}
					<span class="project-group-tail">
						<span class="project-group-slot">
							<Show when={(!open() || visibleSessions().length === 0) && rollupSummary(rollup())}>
								{(summary) => (
									<span
										class="project-group-summary"
										role="img"
										title={rollup().breakdown}
										aria-label={rollup().breakdown}
									>
										<Show when={summary().kind === "live"}>
											<span class="project-group-rail" />
										</Show>
										<Show when={summary().kind === "asleep"}>
											<MoonIcon class="project-group-moon" />
										</Show>
										{summary().text}
									</span>
								)}
							</Show>
							{/* A plain folder (no .git) has no worktrees or clones to create. */}
							<Show when={props.project.git !== false}>
								<button
									ref={setPlusEl}
									type="button"
									class="sidebar-icon-btn project-new-btn"
									aria-label={`New workspace in ${props.project.name}`}
									aria-expanded={popoverOpen()}
									title={
										missing()
											? "Project folder is missing; no workspace can start"
											: `New workspace in ${props.project.name}`
									}
									disabled={missing()}
									onClick={onPlus}
								>
									<PlusIcon />
								</button>
							</Show>
						</span>
						<span class="roster-row-corner project-group-corner">
							<Show when={!open() ? rollup().signal : null}>
								{(signal) => (
									<span class="roster-row-status" aria-hidden="true">
										<RowSignal status={signal().status} activity={signal().activity} />
									</span>
								)}
							</Show>
							<KebabMenu
								label={`Project actions for ${props.project.name}`}
								open={menuOpen()}
								onOpenChange={(v) => setMenuOpenId(v ? gkey : null)}
							>
								<button
									type="button"
									role="menuitem"
									class="sidebar-menu-item sidebar-menu-item--danger"
									title="Deregisters the project (never touches disk)"
									onClick={() => {
										setMenuOpenId(null);
										setState("removeProjectTarget", props.project.projectId);
									}}
								>
									<TrashIcon />
									Remove project…
								</button>
							</KebabMenu>
						</span>
					</span>
				</div>
				<Show when={popoverOpen() && props.project.git !== false ? plusEl() : undefined}>
					{(anchor) => (
						<NewWorkspacePopover
							projectId={props.project.projectId}
							anchor={anchor()}
							onClose={closeNewWorkspace}
						/>
					)}
				</Show>
				<Show when={open()}>
					{/* Keyed by workspaceId: slots are rebuilt on every roster change and a
					    row must keep its DOM (and any open menu) across them. */}
					<For each={rowIds()}>
						{(id) => {
							const first = slotsById().get(id)!;
							const slot = () => slotsById().get(id) ?? first;
							return (
								<RowMotion
									id={id}
									mode={slot().mode}
									onExited={(done) => {
										if (!props.sessions.some((d) => d.workspaceId === done))
											clearDeletePending(done);
										setSlots((prev) => finishRowExit(prev, done));
									}}
								>
									<WorkspaceRow
										session={slot().item}
										inProjectGroup
										projectMissing={missing()}
										projectGit={props.project.git !== false}
									/>
								</RowMotion>
							);
						}}
					</For>
				</Show>
			</>
		);
	};

	return (
		<>
			<Show when={props.groups.length === 0}>
				<EmptyProjects />
			</Show>
			{/* Keyed by projectId: sessionsByProject() rebuilds group objects on every
			    roster change, and keying by object would remount each group (and any
			    open New workspace popover with its in-flight create). With "running
			    only" on, a project with no shown row is hidden too, unless its New
			    workspace popover is open or the palette is pointing at it. */}
			<For each={props.groups.map((g) => g.project.projectId)}>
				{(projectId) => {
					const group = () => props.groups.find((g) => g.project.projectId === projectId);
					const shown = createMemo(() => {
						const g = group();
						if (!g) return false;
						return (
							!state.sidebarRunningOnly ||
							shownRows(g.sessions).length > 0 ||
							state.newWorkspaceProjectId === projectId ||
							state.highlightProjectId === projectId
						);
					});
					return (
						<Show when={shown() && group()}>
							{(g) => <ProjectGroup project={g().project} sessions={g().sessions} />}
						</Show>
					);
				}}
			</For>
			{/* Bottom of the project list: the only add-project entry point. */}
			<button
				type="button"
				class="sidebar-add-project"
				data-roster-item
				onClick={() => setState("modal", "add-project")}
			>
				<PlusIcon />
				Add project
			</button>
		</>
	);
};
