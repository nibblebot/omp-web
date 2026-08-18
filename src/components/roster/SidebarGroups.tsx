import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import type { DaemonEntry, RegisteredProject } from "../../../shared/protocol";
import { setState, state } from "../../state";
import { spawnDaemon } from "../../store/projects";
import { KebabMenu } from "../shared/KebabMenu";
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, TrashIcon } from "../shared/icons";
import { DaemonRow, menuOpenId, setMenuOpenId } from "./DaemonRow";

// ---------------------------------------------------------------------------
// Project-grouped roster rendering: registered projects render as collapsible
// groups (caret header + "⋯" project-actions menu, main-checkout rows first
// then worktrees, "+ Add worktree"), entries without a projectId fall into
// one trailing string-grouped set. Per-group collapse state persists in
// localStorage. Row and project menus share the single module-level open-menu
// id (DaemonRow.tsx) so an open menu survives roster-broadcast remounts.
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

/** Project-first group list as derived by the shell (daemonsByProject). */
export type SidebarGroupsData = {
	project: RegisteredProject | null;
	daemons: DaemonEntry[];
}[];

/** Phase 4 first-run empty state: replaces the one-line hint while the
 *  fleet has no config file, no registered projects, and no daemons.
 *  Step 1 is the primary add-project action (same modal the PROJECTS
 *  header "+" opens); steps 2-3 are short hints. */
const FirstRunPanel: Component = () => (
	<div class="firstrun">
		<p class="firstrun-title">Welcome to omp-web</p>
		<ol class="firstrun-steps">
			<li>
				<button type="button" class="firstrun-cta" onClick={() => setState("modal", "add-project")}>
					<PlusIcon />
					Add your first project
				</button>
			</li>
			<li>
				Prefer the terminal? Just run <code>omp-web</code> — it offers to configure the data home on
				first run.
			</li>
			<li>Sessions appear here once a project exists.</li>
		</ol>
	</div>
);

export const SidebarGroups: Component<{ groups: SidebarGroupsData }> = (props) => {
	const [collapsedGroups, setCollapsedGroups] = createSignal<Set<string>>(readCollapsedGroups());

	/** Phase 4 first-run gate: no fleet config file + no registered
	 *  projects + no daemons. While it holds, the roster renders the
	 *  first-run panel instead of the plain empty hint; any of the three
	 *  appearing flips back to the normal roster. */
	const firstRun = () =>
		state.fleetConfigPath === null &&
		state.registeredProjects.length === 0 &&
		state.daemons.size === 0;

	/** Flip a group's collapse state and persist the updated key set. */
	const toggleGroup = (key: string) => {
		const next = new Set(collapsedGroups());
		if (next.has(key)) next.delete(key);
		else next.add(key);
		setCollapsedGroups(next);
		if (typeof localStorage !== "undefined")
			localStorage.setItem(GROUPS_KEY, JSON.stringify([...next]));
	};

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
		// Id-scoped read of the shared open-menu signal: the menu closes only
		// when THIS project's key changes, so other groups' toggles don't
		// re-render this header.
		const menuOpen = createMemo(() => menuOpenId() === gkey);
		// A main-checkout daemon exists when any row is untagged (worktreeOf
		// is set only for linked-worktree cwds — supervisor resolveWorktreeOf;
		// main checkouts stay undefined). The start action spawns on the main
		// checkout, so it hides once a main daemon exists in ANY status
		// (spawning → … → asleep → ready).
		const hasMain = () => props.daemons.some((d) => d.worktreeOf === undefined);
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
					<Show when={!hasMain()}>
						<button
							type="button"
							class="sidebar-icon-btn project-start"
							title={`Start a session in ${props.project.name}`}
							aria-label={`Start a session in ${props.project.name}`}
							onClick={() => spawnDaemon(props.project.path)}
						>
							<ChevronRightIcon />
						</button>
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
							Delete project…
						</button>
					</KebabMenu>
				</div>
				<Show when={open()}>
					<For each={props.daemons}>
						{(d) => <DaemonRow daemon={d} nested={d.worktreeOf !== undefined} inProjectGroup />}
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
		<>
			<Show when={props.groups.length === 0}>
				<Show
					when={firstRun()}
					fallback={<div class="sidebar-empty">no projects — press + to add one</div>}
				>
					<FirstRunPanel />
				</Show>
			</Show>
			<Show when={props.groups.length > 0}>
				<For each={props.groups}>
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
		</>
	);
};
