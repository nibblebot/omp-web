import { createEffect, createSignal, For, onMount, Show, untrack, type Component } from "solid-js";
import type { DaemonEntry, DaemonStatus, ProjectEntry } from "../protocol";
import { attachSession, listProjects, removeDaemonById, setSidebarVisible, setState, spawnDaemon, spawnResume, state, stopDaemonById } from "../state";
import { formatDaemonUptime } from "./ActiveDaemons";
import { Modal } from "./Modal";

// ---------------------------------------------------------------------------
// Fleet-edge roster sidebar (Phase 3). Rendered by App.tsx only in
// roster mode. Rows show the session
// status dot, project/label chips and cwd; ready rows attach on click, asleep
// rows wake-then-attach, stop and remove are two-click confirms (DaemonPanel
// pattern), and each row opens a detail popover (facts + stderr tail).
// ---------------------------------------------------------------------------

/** Roster entries may carry a template name (registry-only field the edge may
 *  serialize; protocol.ts DaemonEntry is frozen so read it tolerantly). */
type RosterEntry = DaemonEntry & { template?: string };

const STATUS_TITLE: Record<DaemonStatus, string> = {
	spawning: "starting the session process…",
	connecting: "connecting to the session…",
	session: "session created…",
	resolving: "resolving provider/model…",
	ready: "ready — click to attach",
	asleep: "asleep — click to wake and attach",
	reconnecting: "reconnecting…",
	error: "error — see details",
};

const DaemonRow: Component<{ daemon: DaemonEntry }> = props => {
	const [confirmStop, setConfirmStop] = createSignal(false);
	const [confirmRemove, setConfirmRemove] = createSignal(false);
	const [detailOpen, setDetailOpen] = createSignal(false);
	const d = () => props.daemon;
	const isAttached = () => d().daemonId === state.currentSessionId;
	const clickable = () => d().status === "ready" || d().status === "asleep";

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
				classList={{ active: isAttached(), clickable: clickable() }}
				onClick={clickable() ? rowClick : undefined}
				title={STATUS_TITLE[d().status] ?? d().status}
			>
				<span class="daemon-status-dot" data-status={d().status} title={d().status} />
				<div class="sidebar-row-main">
					<div class="sidebar-row-top">
						<span class="sidebar-row-title" title={d().name}>
							{d().name}
						</span>
						<span class="daemon-row-state" data-status={d().status}>
							{d().status}
						</span>
					</div>
					<div class="daemon-chips">
						<span class="daemon-chip" title={d().cwd}>
							{d().project}
						</span>
						<Show when={d().worktreeOf}>
							{wt => (
								<span class="daemon-chip daemon-chip--worktree" title={`worktree of ${wt()}`}>
									of {wt()}
								</span>
							)}
						</Show>
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
					<div class="daemon-row-actions">
						<Show when={clickable()}>
							<span class="daemon-row-hint">
								{isAttached() ? "attached" : d().status === "ready" ? "click to attach" : "click to wake + attach"}
							</span>
						</Show>
						<Show
							when={confirmStop()}
							fallback={
								<button
									type="button"
									class="daemon-row-btn"
									title="Stop this session"
									onClick={e => {
										e.stopPropagation();
										setConfirmStop(true);
										setConfirmRemove(false);
									}}
								>
									stop
								</button>
							}
						>
							<button
								type="button"
								class="daemon-row-btn danger"
								title="Stop this session (second click confirms)"
								onClick={e => {
									e.stopPropagation();
									doStop();
								}}
							>
								confirm?
							</button>
							<button
								type="button"
								class="daemon-row-btn"
								title="Keep the session running"
								onClick={e => {
									e.stopPropagation();
									setConfirmStop(false);
								}}
							>
								cancel
							</button>
						</Show>
						<Show
							when={confirmRemove()}
							fallback={
								<button
									type="button"
									class="daemon-row-btn"
									title="Remove this session from the roster (stops it first)"
									onClick={e => {
										e.stopPropagation();
										setConfirmRemove(true);
										setConfirmStop(false);
									}}
								>
									remove
								</button>
							}
						>
							<button
								type="button"
								class="daemon-row-btn danger"
								title="Remove this session (second click confirms)"
								onClick={e => {
									e.stopPropagation();
									doRemove();
								}}
							>
								confirm?
							</button>
							<button
								type="button"
								class="daemon-row-btn"
								title="Keep this session in the roster"
								onClick={e => {
									e.stopPropagation();
									setConfirmRemove(false);
								}}
							>
								cancel
							</button>
						</Show>
						<button
							type="button"
							class="daemon-row-btn daemon-detail-btn"
							title="Session details"
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
					throw new Error(r.status === 404 ? "not a spawned session — no stderr captured" : `stderr fetch failed (${r.status})`);
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
		<Modal class="daemon-detail" onClose={props.onClose}>
			<div class="daemon-detail-header">
				<span class="daemon-status-dot" data-status={d().status} title={d().status} />
				<span class="daemon-detail-name">{d().name}</span>
				<span class="daemon-row-state" data-status={d().status}>
					{d().status}
				</span>
				<button type="button" class="daemon-detail-close" aria-label="Close session details" onClick={props.onClose}>
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
		<Modal title="Spawn session" onClose={props.onClose}>
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
							<button
								type="button"
								class="picker-row spawn-project"
								classList={{ active: path() === p.path }}
								onClick={() => pick(p)}
								title={p.path}
							>
								<span class="picker-label spawn-project-name">{p.name}</span>
								<Show when={p.branch}>
									{b => <span class="picker-chip spawn-branch">{b()}</span>}
								</Show>
							</button>
							<For each={worktreesOf(p.name)}>
								{w => (
									<button
										type="button"
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
									</button>
								)}
							</For>
						</div>
					)}
				</For>
				<For each={orphans()}>
					{w => (
						<button
							type="button"
							class="picker-row spawn-project spawn-project--worktree"
							classList={{ active: path() === w.path }}
							onClick={() => pick(w)}
							title={w.path}
						>
							<span class="picker-label spawn-project-name">{w.name}</span>
							<Show when={w.branch}>
								{b => <span class="picker-chip spawn-branch">{b()}</span>}
							</Show>
						</button>
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

/** Right-side column: fleet session roster (click to attach/wake). */
export const DaemonSidebar: Component = () => {
	const [spawnOpen, setSpawnOpen] = createSignal(false);
	return (
		<aside class="sidebar">
			<div class="sidebar-header">
				<span class="sidebar-title">Sessions</span>
				<span class="sidebar-stats">
					{state.daemonRoster.length} session{state.daemonRoster.length === 1 ? "" : "s"}
				</span>
				<button class="sidebar-icon-btn" onClick={() => setSpawnOpen(true)} title="Spawn a session">
					+
				</button>
				<button class="sidebar-icon-btn" onClick={() => setSidebarVisible(false)} title="Hide sidebar">
					×
				</button>
			</div>
			<div class="sidebar-list">
				<For each={state.daemonRoster}>{d => <DaemonRow daemon={d} />}</For>
				<Show when={state.daemonRoster.length === 0}>
					<div class="sidebar-empty">no sessions — press + to spawn one</div>
				</Show>
			</div>
			<Show when={spawnOpen()}>
				<SpawnPicker onClose={() => setSpawnOpen(false)} />
			</Show>
		</aside>
	);
};
