import { createEffect, createSignal, For, onMount, Show, type Component } from "solid-js";
import type { ProjectBranch, ProjectEntry } from "../../../shared/protocol";
import {
	listProjectBranches,
	listProjects,
	sendAddExistingWorktree,
	sendCreateWorktree,
	setState,
	state,
} from "../../state";
import { Modal } from "../shared/Modal";
import { PickerRow } from "../shared/PickerRow";
import { PipelineProgress, useOnboardingPipeline } from "./onboarding";

type Tab = "create" | "existing";

/** Progress labels per tab; rung index matches stageIndex. */
const STAGE_LABELS: Record<Tab, string[]> = {
	create: ["creating worktree", "spawning daemon", "attaching session"],
	existing: ["registering worktree", "spawning daemon", "attaching session"],
};

/**
 * Add-worktree modal (Phase 5): register a linked worktree of a registered
 * project. Two tabs — Create new (name input on top, a "+ New branch" row,
 * then an existing-branch dropdown — checked-out branches last and disabled;
 * no freeform ref entry, no advanced section) and Add existing (discovered-but-unregistered worktrees
 * of the project). "Start a session now" (default ON) spawns a daemon on
 * the worktree; the modal tracks register → spawn → attach so the
 * session-picker gate opens after attach settles. Failure at any rung
 * surfaces the stage's error and leaves prior artifacts in place.
 */
export const WorktreeModal: Component<{ onClose: () => void }> = (props) => {
	const [tab, setTab] = createSignal<Tab>("create");
	const [name, setName] = createSignal("");
	const [start, setStart] = createSignal(true);
	const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
	const [nameError, setNameError] = createSignal<string | null>(null);
	const [projects, setProjects] = createSignal<ProjectEntry[]>([]);
	const [projectsError, setProjectsError] = createSignal<string | null>(null);
	// Existing-branch picker data (create tab).
	const [branches, setBranches] = createSignal<ProjectBranch[]>([]);
	const [branchesLoading, setBranchesLoading] = createSignal(true);
	const [branchesError, setBranchesError] = createSignal<string | null>(null);
	const [selected, setSelected] = createSignal<{ kind: "new" } | { kind: "branch"; name: string }>({
		kind: "new",
	});
	let nameInput!: HTMLInputElement;

	const close = () => {
		setState("modal", null);
		props.onClose();
	};

	const { stage, begin, busy, errorInfo } = useOnboardingPipeline(close);

	const project = () =>
		state.registeredProjects.find((p) => p.projectId === state.worktreeModalProjectId) ?? null;

	/** True when an existing branch is selected (vs. creating a new one). */
	const branchSelected = () => selected().kind === "branch";

	/** Name of the selected existing branch, or "" in new-branch mode (the
	 *  dropdown's placeholder value). */
	const selectedBranch = () => {
		const sel = selected();
		return sel.kind === "branch" ? sel.name : "";
	};

	/** Name input value: the selected branch's name (shown read-only), or the
	 *  user's typed new-branch name. */
	const nameValue = () => {
		const sel = selected();
		return sel.kind === "branch" ? sel.name : name();
	};

	/** Branches for the dropdown: available first, checked-out (already in a
	 *  workspace — git refuses a second checkout) last and disabled;
	 *  alphabetical within each group. */
	const sortedBranches = () =>
		[...branches()].sort(
			(a, b) => Number(a.checkedOut) - Number(b.checkedOut) || a.name.localeCompare(b.name),
		);

	// Existing-branch picker data: fetched on open and whenever the targeted
	// project changes. Keyed on the projectId string, NOT the registry object
	// (registered_projects broadcasts replace the array wholesale and must not
	// refetch); a stale response for a superseded project is dropped.
	createEffect(() => {
		const projectId = state.worktreeModalProjectId;
		setSelected({ kind: "new" });
		if (projectId === null) {
			setBranches([]);
			setBranchesLoading(false);
			setBranchesError(null);
			return;
		}
		setBranchesLoading(true);
		setBranchesError(null);
		void listProjectBranches(projectId)
			.then((list) => {
				if (state.worktreeModalProjectId !== projectId) return;
				setBranches(list);
				setBranchesLoading(false);
			})
			.catch((err) => {
				if (state.worktreeModalProjectId !== projectId) return;
				setBranchesError(String(err));
				setBranchesLoading(false);
			});
	});

	onMount(() => {
		requestAnimationFrame(() => nameInput?.focus());
	});

	/** Discovery refresh for the Add-existing tab. */
	const refreshProjects = () => {
		void listProjects()
			.then((list) => {
				setProjects(list);
				setProjectsError(null);
				setSelectedPath(null);
			})
			.catch((err) => setProjectsError(String(err)));
	};

	/** Unregistered worktrees of the selected project: discovered linked
	 *  worktrees (`isWorktree` + worktreeOf = project name) whose path has
	 *  no roster daemon yet. */
	const unregistered = () => {
		const proj = project();
		if (!proj) return [];
		const rosterCwds = state.daemonRoster.map((d) => d.cwd);
		return projects().filter((p) => {
			if (!p.isWorktree || p.worktreeOf !== proj.name) return false;
			const wp = p.path.endsWith("/") ? p.path.slice(0, -1) : p.path;
			return !rosterCwds.some((c) => (c.endsWith("/") ? c.slice(0, -1) : c) === wp);
		});
	};

	const submitCreate = () => {
		const proj = project();
		if (!proj) return;
		const sel = selected();
		if (sel.kind === "new") {
			const n = name().trim();
			if (!n) {
				setNameError("Enter a worktree name");
				return;
			}
			begin(
				() =>
					sendCreateWorktree(proj.projectId, n, {
						...(start() ? { start: true } : {}),
					}),
				start(),
				close,
			);
			return;
		}
		begin(
			() =>
				sendCreateWorktree(proj.projectId, sel.name, {
					existingBranch: sel.name,
					...(start() ? { start: true } : {}),
				}),
			start(),
			close,
		);
	};

	const submitExisting = () => {
		const proj = project();
		if (!proj || selectedPath() === null) return;
		begin(
			() =>
				sendAddExistingWorktree(proj.projectId, selectedPath()!, {
					...(start() ? { start: true } : {}),
				}),
			start(),
			close,
		);
	};

	/** Progress note for the active rung. */
	const stageNote = () => {
		const st = stage();
		if (st.kind === "creating")
			return tab() === "create" ? "creating the worktree…" : "registering the worktree…";
		if (st.kind === "spawning") return "starting the daemon…";
		return "attaching to the session…";
	};

	return (
		<Modal title="Add worktree" onClose={close}>
			<Show when={errorInfo()}>
				{(err) => (
					<>
						<div class="msg-notice worktree-error">
							Failed while {err().stage}: {err().message}
						</div>
						<div class="worktree-actions">
							<button type="button" class="worktree-btn" onClick={close}>
								Close
							</button>
						</div>
					</>
				)}
			</Show>
			<Show when={project() === null}>
				<div class="msg-notice worktree-error">unknown project — reopen from the sidebar</div>
			</Show>
			<Show when={!busy() && project() !== null}>
				<div class="worktree-tabs" role="tablist" aria-label="Worktree mode">
					<button
						type="button"
						class="worktree-tab"
						classList={{ active: tab() === "create" }}
						role="tab"
						aria-selected={tab() === "create"}
						onClick={() => setTab("create")}
					>
						Create new
					</button>
					<button
						type="button"
						class="worktree-tab"
						classList={{ active: tab() === "existing" }}
						role="tab"
						aria-selected={tab() === "existing"}
						onClick={() => {
							setTab("existing");
							refreshProjects();
						}}
					>
						Add existing
					</button>
				</div>
				<Show when={tab() === "create"}>
					{/* <form> so Enter in any field submits (AskDialog convention). */}
					<form
						class="worktree-form"
						onSubmit={(e) => {
							e.preventDefault();
							void submitCreate();
						}}
					>
						<label class="daemon-detail-label" for="worktree-name">
							name
						</label>
						<input
							id="worktree-name"
							ref={nameInput}
							class="picker-filter worktree-name"
							placeholder="feature/…"
							value={nameValue()}
							onInput={(e) => {
								setName(e.currentTarget.value);
								setNameError(null);
							}}
							disabled={branchSelected()}
							spellcheck={false}
						/>
						<Show when={nameError()}>
							{(err) => <div class="msg-notice worktree-name-error">{err()}</div>}
						</Show>
						<div class="picker-group-name">Branch</div>
						<div class="worktree-list">
							<PickerRow
								class="picker-row worktree-row"
								classList={{ active: selected().kind === "new" }}
								onClick={() => setSelected({ kind: "new" })}
								title="Create a new branch"
							>
								<span class="picker-label worktree-row-name session-new-label">+ New branch</span>
							</PickerRow>
							<Show when={branchesLoading()}>
								<div class="tool-collapsed-note">loading branches…</div>
							</Show>
							<Show when={branchesError()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
							<Show when={!branchesLoading() && !branchesError() && branches().length === 0}>
								<div class="tool-collapsed-note">no branches in this repo yet</div>
							</Show>
							<Show when={!branchesLoading() && !branchesError() && branches().length > 0}>
								<select
									class="worktree-branch-select"
									aria-label="Existing branch"
									value={selectedBranch()}
									onChange={(e) => {
										const v = e.currentTarget.value;
										if (v !== "") setSelected({ kind: "branch", name: v });
									}}
								>
									<option value="" disabled>
										use an existing branch…
									</option>
									<For each={sortedBranches()}>
										{(b) => (
											<option value={b.name} disabled={b.checkedOut}>
												{b.checkedOut ? `${b.name} (checked out)` : b.name}
											</option>
										)}
									</For>
								</select>
							</Show>
						</div>
						<label class="worktree-start">
							<input
								type="checkbox"
								checked={start()}
								onChange={(e) => setStart(e.currentTarget.checked)}
							/>
							Start a session now
						</label>
						<div class="worktree-actions">
							<button type="submit" class="worktree-btn">
								Create worktree
							</button>
						</div>
					</form>
				</Show>
				<Show when={tab() === "existing"}>
					<div class="picker-group-name">Unregistered worktrees</div>
					<Show when={projectsError()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
					<div class="worktree-list">
						<For each={unregistered()}>
							{(p) => (
								<PickerRow
									class="picker-row worktree-row"
									classList={{ active: selectedPath() === p.path }}
									onClick={() => setSelectedPath(p.path)}
									title={p.path}
								>
									<span class="picker-label worktree-row-name">{p.name}</span>
									<Show when={p.branch}>
										{(b) => <span class="picker-chip worktree-row-branch">{b()}</span>}
									</Show>
								</PickerRow>
							)}
						</For>
						<Show when={unregistered().length === 0 && !projectsError()}>
							<div class="tool-collapsed-note">no unregistered worktrees</div>
						</Show>
					</div>
					<label class="worktree-start">
						<input
							type="checkbox"
							checked={start()}
							onChange={(e) => setStart(e.currentTarget.checked)}
						/>
						Start a session now
					</label>
					<div class="worktree-actions">
						<button
							type="button"
							class="worktree-btn"
							disabled={selectedPath() === null}
							onClick={() => void submitExisting()}
						>
							Add worktree
						</button>
						<button type="button" class="daemon-row-btn" onClick={refreshProjects}>
							refresh
						</button>
					</div>
				</Show>
			</Show>
			<PipelineProgress
				stage={stage}
				labels={STAGE_LABELS[tab()]}
				note={stageNote()}
				prefix="worktree"
			/>
		</Modal>
	);
};
