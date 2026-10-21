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
import type { DaemonEntry, RegisteredProject } from "#lib/wire/protocol";
import { projectRollup } from "../../../fleet-ui/workspace-status";
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
import { ChevronDownIcon, PlusIcon, TrashIcon } from "../../ui/icons";
import { NewWorkspacePopover } from "./NewWorkspacePopover";
import { RowMotion } from "./RowMotion";
import {
	finishRowExit,
	initialRowSlots,
	reconcileRowSlots,
	type RowSlot,
} from "../../../fleet-ui/row-presence";
import { WorkspaceRow, menuOpenId, setMenuOpenId } from "./WorkspaceRow";

// ---------------------------------------------------------------------------
// Project-grouped roster rendering: one collapsible group per registered
// project. The header carries the caret, the name, a "+" that opens the New
// workspace popover (anchored to the header), and a "⋯" menu with Remove
// project. Rows are one per checkout (main checkout, worktrees, clones).
// Per-group collapse state persists in localStorage. Row and project menus
// share the single module-level open-menu id (WorkspaceRow.tsx). Each group
// renders its rows through RowMotion: a row new to the roster enters, a row
// that left it stays rendered (inert) until its exit motion ends
// (fleet-ui/row-presence.ts derives that list).
// ---------------------------------------------------------------------------

/** localStorage key for the roster sidebar's collapsed group headers. */
const GROUPS_KEY = "omp.sidebarGroupsCollapsed";

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

/** Project-first group list as derived by the shell (daemonsByProject). */
export type ProjectGroupsData = {
	project: RegisteredProject;
	daemons: DaemonEntry[];
}[];

/** Empty roster: the add hint, plus a sign-in prompt when no model provider
 *  is configured. A failed omp-setup probe shows only the add hint. */
const EmptyProjects: Component = () => {
	const [noProvider, setNoProvider] = createSignal(false);
	onMount(() => {
		fetchOmpSetup()
			.then((s) => setNoProvider(s.providers.length === 0))
			.catch(() => setNoProvider(false));
	});
	return (
		<div class="sidebar-empty">
			<p>No projects yet. Press + to add one.</p>
			<Show when={noProvider()}>
				<p>No model provider signed in.</p>
				<button
					type="button"
					class="sidebar-empty-action"
					onClick={() => setState("modal", "login")}
				>
					Sign in
				</button>
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

	/** One registered-project group: collapsible header (caret, name, a
	 *  roll-up of its workspaces while collapsed, the "+" New workspace
	 *  trigger, and the "⋯" menu carrying Remove project), then one row per
	 *  checkout in daemonsByProject order. */
	const ProjectGroup: Component<{ project: RegisteredProject; daemons: DaemonEntry[] }> = (
		props,
	) => {
		const gkey = `project:${props.project.projectId}`;
		const open = () => !collapsedGroups().has(gkey);
		const rollup = () => projectRollup(props.daemons);
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

		// Rendered rows: the live ones plus rows still playing their exit. Seeded
		// from the first render, so page load never animates; a row enters only
		// when its daemonId was not rendered before. The roster counts as arrived
		// only after the first roster frame (`armed` trails state.rosterLoaded by
		// one run), so the frame that fills an initially empty list animates
		// nothing. A collapsed group animates nothing either: expanding it never
		// counts its rows as new.
		const [slots, setSlots] = createSignal<RowSlot<DaemonEntry>[]>(
			initialRowSlots(props.daemons, (d) => d.daemonId),
		);
		let armed = state.rosterLoaded;
		createComputed(
			on(
				[() => props.daemons, open, () => state.rosterLoaded],
				([daemons, isOpen, loaded]) => {
					const live = new Set(daemons.map((d) => d.daemonId));
					for (const slot of slots()) if (!live.has(slot.id)) clearDeletePending(slot.id);
					setSlots((prev) => reconcileRowSlots(prev, daemons, (d) => d.daemonId, isOpen && armed));
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
						<ChevronDownIcon class="sidebar-caret" />
						<span class="sidebar-group-label" title={props.project.path}>
							{props.project.name}
						</span>
						<Show when={missing()}>
							<span class="project-missing-chip" title="Project folder is missing on disk">
								missing
							</span>
						</Show>
						<Show when={!open() && rollup() !== ""}>
							<span class="project-rollup">{rollup()}</span>
						</Show>
					</button>
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
				</div>
				<Show when={popoverOpen() ? plusEl() : undefined}>
					{(anchor) => (
						<NewWorkspacePopover
							projectId={props.project.projectId}
							anchor={anchor()}
							onClose={closeNewWorkspace}
						/>
					)}
				</Show>
				<Show when={open()}>
					{/* Keyed by daemonId: slots are rebuilt on every roster change and a
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
										clearDeletePending(done);
										setSlots((prev) => finishRowExit(prev, done));
									}}
								>
									<WorkspaceRow
										daemon={slot().item}
										nested={slot().item.worktreeOf !== undefined}
										inProjectGroup
										projectMissing={missing()}
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
			{/* Keyed by projectId: daemonsByProject() rebuilds group objects on every
			    roster change, and keying by object would remount each group (and any
			    open New workspace popover with its in-flight create). */}
			<For each={props.groups.map((g) => g.project.projectId)}>
				{(projectId) => (
					<Show when={props.groups.find((g) => g.project.projectId === projectId)}>
						{(g) => <ProjectGroup project={g().project} daemons={g().daemons} />}
					</Show>
				)}
			</For>
		</>
	);
};
