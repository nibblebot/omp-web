import { createEffect, createSignal, For, onMount, Show, untrack, type Component } from "solid-js";
import type { DaemonEntry, DaemonStatus, ProjectEntry } from "../../shared/protocol";
import { attachSession, listProjects, removeDaemonById, setSidebarVisible, setState, spawnDaemon, spawnResume, state, stopDaemonById } from "../state";
import { formatDaemonUptime } from "./ActiveDaemons";
import { Modal } from "./Modal";
import { PickerRow, useClickableRow } from "./PickerRow";

// ---------------------------------------------------------------------------
// Fleet-edge roster sidebar (Phase 3). Rendered by App.tsx only in
// roster mode. ALL sessions (spawned, attached, remote alike) sit under a
// single static "REPOS" header, grouped by owning repo (`worktreeOf ??
// project`); a repo with worktree sessions becomes a label-only collapsible
// container (main checkouts first, then worktrees) with rows indented
// beneath, while repos without worktrees render their rows directly.
// Collapse state persists per repo in localStorage. Rows show the session
// status dot, a git-branch icon + branch for worktrees, project/label chips
// and a git-dirty line; ready rows attach on click, asleep rows
// wake-then-attach, stop and remove are bare-icon two-click confirms, and
// each row opens a detail popover (facts + stderr tail).
// ---------------------------------------------------------------------------

/** Roster entries may carry a template name plus per-repo git facts
 *  (branch + porcelain counts) that the fleet edge may serialize;
 *  protocol.ts DaemonEntry is frozen so read all of them tolerantly. */
type RosterEntry = DaemonEntry & {
	template?: string;
	/** Current branch of the session cwd; absent for detached/non-git/remote/unprobed. */
	branch?: string;
	/** Porcelain file counts; absent when unknown. */
	git?: { added: number; modified: number; deleted: number; untracked: number };
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

/** Porcelain dirty counts, in the order they render: added, modified,
 *  deleted, untracked — the `git status --porcelain` short-hand glyphs. */
type DirtyKind = "added" | "modified" | "deleted" | "untracked";

/** Simple 3-node git-branch glyph; strokes follow currentColor so it tints
 *  with the row title. Rendered inline (no icon font dependency). */
const WorktreeIcon = () => (
	<svg class="daemon-worktree-icon" viewBox="0 0 16 16" aria-hidden="true">
		<circle cx="4" cy="4" r="1.6" />
		<circle cx="4" cy="12" r="1.6" />
		<circle cx="12" cy="4" r="1.6" />
		<path d="M4 5.6v4.8M12 5.6c0 3-4 2.6-8 4.8" />
	</svg>
);

const DaemonRow: Component<{ daemon: DaemonEntry; nested?: boolean }> = props => {
	const [confirmStop, setConfirmStop] = createSignal(false);
	const [confirmRemove, setConfirmRemove] = createSignal(false);
	const [detailOpen, setDetailOpen] = createSignal(false);
	const d = () => props.daemon as RosterEntry;
	// Worktree sessions belong to a main checkout and read as branches, not
	// dirs — the branch (or name fallback) becomes the title and the project
	// chip + cwd path are dropped so the row never shows the directory.
	const isWorktree = () => d().worktreeOf !== undefined;
	const isAttached = () => d().daemonId === state.currentSessionId;
	const clickable = () => d().status === "ready" || d().status === "asleep";
	/** Dirty spans to render: nonzero counts only, kept in fixed order. */
	const gitKinds = (): Array<{ kind: DirtyKind; n: number; glyph: string }> => {
		const g = d().git;
		if (!g) return [];
		const kinds: Array<{ kind: DirtyKind; n: number; glyph: string }> = [
			{ kind: "added", n: g.added, glyph: "+" },
			{ kind: "modified", n: g.modified, glyph: "~" },
			{ kind: "deleted", n: g.deleted, glyph: "-" },
			{ kind: "untracked", n: g.untracked, glyph: "?" },
		];
		return kinds.filter(k => k.n > 0);
	};

	const rowClick = () => {
		const daemon = d();
		if (daemon.status === "ready") {
			void attachSession(daemon.daemonId).catch(err => setState("error", String(err)));
		} else if (daemon.status === "asleep") {
			// Wake then attach: the edge wakes first and answers the attach
			// once the session is ready — send both immediately, the edge
			// serializes them.
			spawnResume(daemon.daemonId);
			void attachSession(daemon.daemonId).catch(err => setState("error", String(err)));
		}
	};

	const doStop = () => {
		stopDaemonById(d().daemonId);
		setConfirmStop(false);
	};

	const doRemove = () => {
		removeDaemonById(d().daemonId);
		setConfirmRemove(false);
	};

	return (
		<>
			<div
				class="sidebar-row daemon-row"
				classList={{ active: isAttached(), clickable: clickable(), "daemon-row--nested": props.nested === true }}
				{...useClickableRow(rowClick, clickable())}
				title={STATUS_TITLE[d().status] ?? d().status}
			>
				<span class="daemon-status-dot" data-status={d().status} title={d().status} />
				<div class="sidebar-row-main">
					<div class="sidebar-row-top">
						<span class="sidebar-row-title daemon-row-title" title={isWorktree() ? (d().branch ?? d().name) : d().name}>
							<Show when={isWorktree()}>
								<WorktreeIcon />
							</Show>
							{isWorktree() ? (d().branch ?? d().name) : d().name}
						</span>
						<span class="daemon-row-state" data-status={d().status}>
							{d().status}
						</span>
					</div>
					<Show when={!isWorktree()}>
						<div class="daemon-chips">
							<span class="daemon-chip" title={d().cwd}>
								{d().project}
							</span>
							<For each={d().labels}>
								{l => (
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
					    rows already show it as the title), nonzero dirty counts, and
					    the stop/remove/info icons pushed right. Always rendered —
					    it carries the actions even with no git info to show. */}
					<div class="daemon-git">
						<Show when={!isWorktree() && d().branch !== undefined}>
							<span class="daemon-git-branch" title={d().cwd}>
								{d().branch}
							</span>
						</Show>
						<For each={gitKinds()}>
							{k => (
								<span
									class="daemon-git-dirty"
									data-kind={k.kind}
									title={`${k.n} ${k.kind}`}
								>
									{k.glyph}
									{k.n}
								</span>
							)}
						</For>
						<button
							type="button"
							class="daemon-icon-btn daemon-stop-btn"
							classList={{ armed: confirmStop() }}
							title={confirmStop() ? "Stop this daemon (second click confirms)" : "Stop this daemon"}
							onClick={e => {
								e.stopPropagation();
								if (confirmStop()) doStop();
								else {
									setConfirmStop(true);
									setConfirmRemove(false);
								}
							}}
						>
							■
						</button>
						<button
							type="button"
							class="daemon-icon-btn daemon-remove-btn"
							classList={{ armed: confirmRemove() }}
							title={
								confirmRemove()
									? "Remove this daemon (second click confirms)"
									: "Remove this daemon from the roster (stops it first)"
							}
							onClick={e => {
								e.stopPropagation();
								if (confirmRemove()) doRemove();
								else {
									setConfirmRemove(true);
									setConfirmStop(false);
								}
							}}
						>
							✕
						</button>
						<button
							type="button"
							class="daemon-icon-btn daemon-detail-btn"
							title="Daemon details"
							onClick={e => {
								e.stopPropagation();
								setDetailOpen(true);
							}}
						>
							ⓘ
						</button>
					</div>
				</div>
			</div>
			<Show when={detailOpen()}>
				<DaemonDetail daemon={d()} onClose={() => setDetailOpen(false)} />
			</Show>
		</>
	);
};

/** Detail popover: roster facts + live stderr tail from /ctl/sessions/{id}/stderr. */
const DaemonDetail: Component<{ daemon: DaemonEntry; onClose: () => void }> = props => {
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
			.then(r => {
				if (!r.ok) {
					throw new Error(r.status === 404 ? "not a spawned daemon — no stderr captured" : `stderr fetch failed (${r.status})`);
				}
				return r.json() as Promise<{ text: string }>;
			})
			.then(data => setStderrText(data.text))
			.catch(err => setStderrError(err instanceof Error ? err.message : String(err)))
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
				<span class="daemon-row-state" data-status={d().status}>
					{d().status}
				</span>
				<button type="button" class="daemon-detail-close" aria-label="Close daemon details" onClick={props.onClose}>
					×
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
					{name => (
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
					{file => (
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
								{l => <span class="daemon-chip daemon-chip--label">{l}</span>}
							</For>
						</span>
					</div>
				</Show>
				<Show when={d().error}>
					{err => (
						<div class="daemon-detail-fact daemon-detail-fact--error">
							<span class="daemon-detail-label">error</span>
							<span class="daemon-detail-value">{err()}</span>
						</div>
					)}
				</Show>
			</div>
			<div class="daemon-stderr-head">
				<span class="daemon-detail-label">stderr</span>
				<button type="button" class="daemon-row-btn" disabled={stderrLoading()} onClick={() => void loadStderr()}>
					{stderrLoading() ? "loading…" : "refresh"}
				</button>
			</div>
			<Show when={stderrLoading()}>
				<div class="daemon-stderr-empty">loading stderr…</div>
			</Show>
			<Show when={!stderrLoading() && stderrText() !== null}>
				<pre class="daemon-stderr">{stderrText() === "" ? "(no stderr output yet)" : stderrText()}</pre>
			</Show>
			<Show when={stderrError()}>
				{err => <div class="msg-notice daemon-stderr-error">{err()}</div>}
			</Show>
		</Modal>
	);
};

/** Spawn picker modal: discovered projects grouped repo → worktrees, a
 *  freeform path input, and a template dropdown from /ctl/templates. */
const SpawnPicker: Component<{ onClose: () => void }> = props => {
	const [projects, setProjects] = createSignal<ProjectEntry[]>([]);
	const [projectsError, setProjectsError] = createSignal<string | null>(null);
	const [templates, setTemplates] = createSignal<string[]>([]);
	const [templatesError, setTemplatesError] = createSignal<string | null>(null);
	const [path, setPath] = createSignal("");
	const [template, setTemplate] = createSignal("local");
	const [labels, setLabels] = createSignal("");
	const [pathError, setPathError] = createSignal<string | null>(null);
	let pathInput!: HTMLInputElement;

	onMount(() => {
		void listProjects()
			.then(setProjects)
			.catch(err => setProjectsError(String(err)));
		void fetch("/ctl/templates")
			.then(r => {
				if (!r.ok) throw new Error(`templates fetch failed (${r.status})`);
				return r.json() as Promise<string[]>;
			})
			.then(list => {
				setTemplates(list);
				if (list.length > 0 && !list.includes(template())) setTemplate(list[0]);
			})
			.catch(err => setTemplatesError(String(err)));
		// Keyboard-first: land focus in the path field once the Modal has
		// grabbed the dialog (child onMount runs before the Modal's).
		requestAnimationFrame(() => pathInput?.focus());
	});

	/** Main repos (isWorktree=false) with their worktrees nested beneath. */
	const mains = () => projects().filter(p => !p.isWorktree);
	const worktreesOf = (name: string) => projects().filter(p => p.isWorktree && p.worktreeOf === name);
	/** Worktrees whose main repo lives outside the discovery roots. */
	const orphans = () => {
		const claimed = new Set(mains().map(p => p.name));
		return projects().filter(p => p.isWorktree && !claimed.has(p.worktreeOf ?? ""));
	};

	const pick = (p: ProjectEntry) => {
		setPath(p.path);
		setPathError(null);
	};

	const spawn = () => {
		const cwd = path().trim();
		if (!cwd) {
			setPathError("Enter a project path (or pick one below)");
			return;
		}
		// Comma-separated k=v list; the edge validates each label's shape and
		// answers an error frame on a bad one. Fire-and-forget: the new
		// session appears in the roster as spawning → ready.
		const parsedLabels = labels()
			.split(",")
			.map(l => l.trim())
			.filter(l => l !== "");
		spawnDaemon(cwd, template(), parsedLabels.length > 0 ? parsedLabels : undefined);
		props.onClose();
	};

	return (
		<Modal title="Spawn daemon" onClose={props.onClose}>
			<div class="spawn-form">
				<label class="daemon-detail-label" for="spawn-path">
					path
				</label>
				<input
					id="spawn-path"
					ref={pathInput}
					class="picker-filter spawn-path"
					placeholder="~/repos/… or absolute path"
					value={path()}
					onInput={e => {
						setPath(e.currentTarget.value);
						setPathError(null);
					}}
					spellcheck={false}
				/>
				<Show when={pathError()}>{err => <div class="msg-notice spawn-path-error">{err()}</div>}</Show>
				<label class="daemon-detail-label" for="spawn-template">
					template
				</label>
				<select
					id="spawn-template"
					class="spawn-template"
					value={template()}
					onChange={e => setTemplate(e.currentTarget.value)}
				>
					<Show when={templates().length === 0 && templatesError() === null}>
						<option value="local">local</option>
					</Show>
					<For each={templates()}>
						{t => <option value={t}>{t}</option>}
					</For>
				</select>
				<Show when={templatesError()}>{err => <div class="msg-notice spawn-template-error">{err()}</div>}</Show>
				<label class="daemon-detail-label" for="spawn-labels">
					labels
				</label>
				<input
					id="spawn-labels"
					class="picker-filter spawn-labels"
					placeholder="tag=api, env=prod"
					value={labels()}
					onInput={e => setLabels(e.currentTarget.value)}
					spellcheck={false}
				/>
			</div>
			<div class="picker-group-name">Projects</div>
			<Show when={projectsError()}>
				{err => <div class="msg-notice">{err()}</div>}
			</Show>
			<div class="spawn-projects">
				<For each={mains()}>
					{p => (
						<div class="spawn-group">
							<PickerRow
								class="picker-row spawn-project"
								classList={{ active: path() === p.path }}
								onClick={() => pick(p)}
								title={p.path}
							>
								<span class="picker-label spawn-project-name">{p.name}</span>
								<Show when={p.branch}>
									{b => <span class="picker-chip spawn-branch">{b()}</span>}
								</Show>
							</PickerRow>
							<For each={worktreesOf(p.name)}>
								{w => (
									<PickerRow
										class="picker-row spawn-project spawn-project--worktree"
										classList={{ active: path() === w.path }}
										onClick={() => pick(w)}
										title={w.path}
									>
										<span class="picker-label spawn-project-name">{w.name}</span>
										<span class="spawn-of" title={`worktree of ${p.name}`}>
											of {p.name}
										</span>
										<Show when={w.branch}>
											{b => <span class="picker-chip spawn-branch">{b()}</span>}
										</Show>
									</PickerRow>
								)}
							</For>
						</div>
					)}
				</For>
				<For each={orphans()}>
					{w => (
						<PickerRow
							class="picker-row spawn-project spawn-project--worktree"
							classList={{ active: path() === w.path }}
							onClick={() => pick(w)}
							title={w.path}
						>
							<span class="picker-label spawn-project-name">{w.name}</span>
							<Show when={w.branch}>
								{b => <span class="picker-chip spawn-branch">{b()}</span>}
							</Show>
						</PickerRow>
					)}
				</For>
				<Show when={projects().length === 0 && !projectsError()}>
					<div class="tool-collapsed-note">no projects discovered</div>
				</Show>
			</div>
			<div class="spawn-actions">
				<button type="button" class="spawn-btn" onClick={() => void spawn()}>
					spawn
				</button>
			</div>
		</Modal>
	);
};

/** Right-side column: fleet session roster (click to attach/wake).
 *  ALL sessions — spawned, attached, and remote alike — group under a
 *  single static "REPOS" header by owning repo (`worktreeOf ?? project`,
 *  sorted); a repo with worktree sessions renders as a label-only
 *  collapsible container with its sessions indented beneath (main
 *  checkouts first, then worktrees, roster order preserved), while repos
 *  without worktree sessions render their rows directly. Per-repo collapse
 *  state persists in localStorage. */

/** localStorage key for the roster sidebar's collapsed group headers. */
const GROUPS_KEY = "omp.sidebarGroupsCollapsed";

/** One repo group in the roster: its entries and whether it contains
 *  worktree sessions (which changes how it renders). */
type SidebarGroup = {
	name: string;
	entries: DaemonEntry[];
	hasWorktrees: boolean;
};

/** Group roster entries by repo (`worktreeOf ?? project`), sorted by group
 *  name via localeCompare. Groups that contain worktree sessions
 *  stable-partition main checkouts first, then worktrees — roster order
 *  preserved within each partition. Entries without worktreeOf (plain
 *  checkouts, remote sessions) reduce to a plain per-project grouping. */
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
		.map(name => {
			const all = byRepo.get(name)!;
			const hasWorktrees = all.some(d => d.worktreeOf !== undefined);
			return {
				name,
				hasWorktrees,
				entries: hasWorktrees
					? [...all.filter(d => d.worktreeOf === undefined), ...all.filter(d => d.worktreeOf !== undefined)]
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
	const [spawnOpen, setSpawnOpen] = createSignal(false);
	const [collapsedGroups, setCollapsedGroups] = createSignal<Set<string>>(readCollapsedGroups());

	/** Flip a group's collapse state and persist the updated key set. */
	const toggleGroup = (key: string) => {
		const next = new Set(collapsedGroups());
		if (next.has(key)) next.delete(key);
		else next.add(key);
		setCollapsedGroups(next);
		if (typeof localStorage !== "undefined") localStorage.setItem(GROUPS_KEY, JSON.stringify([...next]));
	};

	/** The whole roster grouped per buildGroups; entries without worktreeOf
	 *  (plain checkouts, remote sessions) render as plain rows, repos with
	 *  worktrees as collapsible containers. */
	const groups = () => buildGroups(state.daemonRoster);

	/** Collapsible caret group header; the caret glyph and its rotation come
	 *  from CSS via the data-open attribute. gkey names the collapse slot. */
	const GroupHeader: Component<{ label: string; gkey: string; count: number; class?: string }> = props => {
		const open = () => !collapsedGroups().has(props.gkey);
		return (
			<button
				type="button"
				class={`sidebar-group${props.class ? ` ${props.class}` : ""}`}
				aria-expanded={open()}
				data-open={open() ? "true" : "false"}
				onClick={() => toggleGroup(props.gkey)}
			>
				<span class="sidebar-caret" data-open={open() ? "true" : "false"} />
				<span class="sidebar-group-label">{props.label}</span>
				<span class="sidebar-group-count">{props.count}</span>
			</button>
		);
	};

	return (
		<aside class="sidebar">
			<div class="sidebar-header">
				<span class="sidebar-title">Daemons</span>
				<span class="sidebar-stats">
					{state.daemonRoster.length} daemon{state.daemonRoster.length === 1 ? "" : "s"}
				</span>
				<button class="sidebar-icon-btn" onClick={() => setSpawnOpen(true)} title="Spawn a daemon">
					+
				</button>
				<button class="sidebar-icon-btn" onClick={() => setSidebarVisible(false)} title="Hide sidebar">
					×
				</button>
			</div>
			<div class="sidebar-list">
				<Show when={state.daemonRoster.length > 0}>
					{/* Static top-level header: single grouping for the whole
					    roster, no caret (not collapsible), no indent. */}
					<div class="picker-group-name sidebar-subgroup">Repos</div>
					<For each={groups()}>
						{g =>
							g.hasWorktrees ? (
								<>
									<GroupHeader
										label={g.name}
										gkey={`repo:${g.name}`}
										count={g.entries.length}
										class="sidebar-group--repo"
									/>
									<Show when={!collapsedGroups().has(`repo:${g.name}`)}>
										<For each={g.entries}>{d => <DaemonRow daemon={d} nested />}</For>
									</Show>
								</>
							) : (
								<For each={g.entries}>{d => <DaemonRow daemon={d} />}</For>
							)
						}
					</For>
				</Show>
				<Show when={state.daemonRoster.length === 0}>
					<div class="sidebar-empty">no daemons — press + to spawn one</div>
				</Show>
			</div>
			<Show when={spawnOpen()}>
				<SpawnPicker onClose={() => setSpawnOpen(false)} />
			</Show>
		</aside>
	);
};
