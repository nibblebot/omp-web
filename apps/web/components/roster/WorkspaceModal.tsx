import { createEffect, createSignal, For, onMount, Show, type Component } from "solid-js";
import type { ProjectBranch, ProjectEntry } from "#lib/wire/protocol";
import {
	currentWorkspaceCreationPrefs,
	rememberWorkspaceCreationPrefs,
	type WorkspaceKindChoice,
} from "../../prefs/workspace-creation";
import {
	listProjectBranches,
	listProjects,
	sendAddExistingWorktree,
	sendCreateClone,
	sendCreateWorktree,
	setState,
	state,
} from "../../state";
import { Modal } from "../shared/Modal";
import { PickerRow } from "../shared/PickerRow";
import { DirPicker } from "./DirPicker";
import { PipelineProgress, useOnboardingPipeline } from "./onboarding";

/** Workspace modes: a NEW managed worktree, an independent CLONE workspace,
 *  or registration of an EXISTING worktree. */
type Tab = "worktree" | "clone" | "existing";

/** Progress labels per tab; rung index matches stageIndex. Clone creation
 *  runs the fleet lifecycle (prepare → runtime → callback → ready), whose
 *  first two rungs replace the worktree's creating/spawning wording. */
const STAGE_LABELS: Record<Tab, string[]> = {
	worktree: ["creating worktree", "spawning daemon", "attaching session"],
	clone: ["preparing workspace", "starting runtime", "attaching session"],
	existing: ["registering worktree", "spawning daemon", "attaching session"],
};

/** Clone source modes: default project checkout, an explicit local path, or
 *  a remote URL. At most one of local/remote rides the command. */
type SourceMode = "default" | "local" | "remote";

/**
 * Add-workspace modal (P8.1): the unified replacement for the worktree-only
 * dialog. Three modes: Worktree (register a linked worktree of a registered
 * project: "+ New branch" or an existing-branch dropdown), Clone (an
 * independent provider-run clone workspace: name, provider profile, optional
 * source/revision/branch, start-now), and Add existing (discovered-but-
 * unregistered worktrees plus an "or pick a directory" affordance).
 *
 * Preferences (P8.2): the opened mode honors the remembered kind (never
 * force Worktree), the start checkbox defaults from the remembered value and
 * only defaults ON without any prior preference, and a remembered clone
 * profile pre-selects ONLY while it still exists in the fleet's catalog;
 * missing or never-saved profiles force a deliberate selection. Nothing
 * except kind/profile/start is ever persisted (never names, branches,
 * sources, revisions).
 *
 * "Start a session now" arms the session-picker gate like the old modal; the
 * modal tracks register/prepare → spawn → attach so the gate opens after
 * attach settles. Failure at any rung surfaces the stage's error.
 */
export const WorkspaceModal: Component<{ onClose: () => void }> = (props) => {
	const remembered = currentWorkspaceCreationPrefs();
	/** Opened mode: the remembered kind when there is one, else Worktree. */
	const [tab, setTab] = createSignal<Tab>(remembered.kind === "clone" ? "clone" : "worktree");
	const [name, setName] = createSignal("");
	/** Start-now: enabled by default only WITHOUT a prior preference. */
	const [start, setStart] = createSignal(remembered.start ?? true);
	// Clone tab fields.
	const [profileId, setProfileId] = createSignal(
		remembered.profileId !== undefined &&
			state.providerProfiles.some((p) => p.id === remembered.profileId)
			? remembered.profileId
			: "",
	);
	const [sourceMode, setSourceMode] = createSignal<SourceMode>("default");
	const [sourceValue, setSourceValue] = createSignal("");
	const [revision, setRevision] = createSignal("");
	const [branch, setBranch] = createSignal("");
	const [fieldError, setFieldError] = createSignal<string | null>(null);
	const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
	/** Add-existing tab: the embedded DirPicker is hidden behind an "or pick a
	 *  directory" affordance until asked for. */
	const [browsing, setBrowsing] = createSignal(false);
	const [projects, setProjects] = createSignal<ProjectEntry[]>([]);
	const [projectsError, setProjectsError] = createSignal<string | null>(null);
	// Worktree tab branch-picker data.
	const [branches, setBranches] = createSignal<ProjectBranch[]>([]);
	const [branchesLoading, setBranchesLoading] = createSignal(true);
	const [branchesError, setBranchesError] = createSignal<string | null>(null);
	const [selected, setSelected] = createSignal<{ kind: "new" } | { kind: "branch"; name: string }>({
		kind: "new",
	});
	let nameInput!: HTMLInputElement;
	/** The tab an error rung originated from; retry/back-to-edit return
	 *  there (the tab may still read as the error-rung's tab otherwise). */
	const [tabAtSubmit, setTabAtSubmit] = createSignal<Tab>("worktree");

	const close = () => {
		setState("modal", null);
		props.onClose();
	};

	const { stage, begin, busy, errorInfo, reset } = useOnboardingPipeline(close);

	const project = () =>
		state.registeredProjects.find((p) => p.projectId === state.workspaceModalProjectId) ?? null;

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
	 *  workspace, git refuses a second checkout) last and disabled;
	 *  alphabetical within each group. */
	const sortedBranches = () =>
		[...branches()].sort(
			(a, b) => Number(a.checkedOut) - Number(b.checkedOut) || a.name.localeCompare(b.name),
		);

	// The fleet's secret-free provider profile catalog (P8.1; rides the
	// registered_projects frame, boot-static, [] on older fleets).
	const profiles = () => state.providerProfiles;
	/** A real profile is selected AND still present in the catalog. */
	const profileChosen = () => profiles().some((p) => p.id === profileId());

	// Worktree-tab branch data: fetched on open and whenever the targeted
	// project changes. Keyed on the projectId string, NOT the registry object
	// (registered_projects broadcasts replace the array wholesale and must not
	// refetch); a stale response for a superseded project is dropped.
	createEffect(() => {
		const projectId = state.workspaceModalProjectId;
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
				if (state.workspaceModalProjectId !== projectId) return;
				setBranches(list);
				setBranchesLoading(false);
			})
			.catch((err) => {
				if (state.workspaceModalProjectId !== projectId) return;
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

	/** Remember the mode's choices (kind + start always; profileId with
	 *  clones only, see the prefs module). */
	const remember = (kind: WorkspaceKindChoice, profile?: string) => {
		rememberWorkspaceCreationPrefs(
			profile !== undefined
				? { kind, start: start(), profileId: profile }
				: { kind, start: start() },
		);
	};

	const submitWorktree = () => {
		const proj = project();
		if (!proj) return;
		setTabAtSubmit("worktree");
		const sel = selected();
		if (sel.kind === "new") {
			const n = name().trim();
			if (!n) {
				setFieldError("Enter a worktree name");
				return;
			}
			remember("worktree");
			begin(
				() => sendCreateWorktree(proj.projectId, n, start() ? { start: true } : {}),
				start(),
				close,
			);
			return;
		}
		remember("worktree");
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

	const submitClone = () => {
		const proj = project();
		if (!proj) return;
		setTabAtSubmit("clone");
		const n = name().trim();
		if (!n) {
			setFieldError("Enter a workspace name");
			return;
		}
		if (!profileChosen()) {
			setFieldError("Choose a provider profile");
			return;
		}
		const mode = sourceMode();
		const src = sourceValue().trim();
		if (mode !== "default" && src === "") {
			setFieldError(mode === "local" ? "Enter a local source path" : "Enter a remote source URL");
			return;
		}
		const source =
			mode === "local" ? { local: src } : mode === "remote" ? { remote: src } : undefined;
		const rev = revision().trim();
		const br = branch().trim();
		remember("clone", profileId());
		begin(
			() =>
				sendCreateClone(proj.projectId, n, {
					profileId: profileId(),
					...(source !== undefined ? { source } : {}),
					...(rev !== "" ? { revision: rev } : {}),
					...(br !== "" ? { branch: br } : {}),
					...(start() ? { start: true } : {}),
				}),
			start(),
			close,
		);
	};

	const submitExisting = () => {
		const proj = project();
		if (!proj || selectedPath() === null) return;
		setTabAtSubmit("existing");
		remember("worktree");
		begin(
			() =>
				sendAddExistingWorktree(proj.projectId, selectedPath()!, {
					...(start() ? { start: true } : {}),
				}),
			start(),
			close,
		);
	};

	/** Error-rung "Edit and retry": back to the form, then re-run the SAME
	 *  submission (the submit buttons on the form re-trigger their tab's
	 *  submit; re-Enter submits the active form naturally). */
	const submitAgain = () => {
		const st = stage();
		if (st.kind !== "error") return;
		setTabAtSubmit((t) => {
			reset();
			setTab(t);
			return t;
		});
		requestAnimationFrame(() => {
			const cur = tab();
			if (stage().kind === "form") {
				if (cur === "worktree") void submitWorktree();
				else if (cur === "clone") void submitClone();
				else if (cur === "existing") void submitExisting();
			}
		});
	};

	/** Progress note for the active rung. */
	const stageNote = () => {
		const st = stage();
		if (st.kind === "creating")
			return tab() === "clone"
				? "preparing the clone workspace…"
				: tab() === "worktree"
					? "creating the worktree…"
					: "registering the worktree…";
		if (st.kind === "spawning") return "starting the daemon…";
		return "attaching to the session…";
	};

	/** Clone tab submit gating: a name and a DELIBERATE profile choice are
	 *  required (a missing/stale remembered profile never silently falls back
	 *  to the first catalog entry). */
	const cloneReady = () =>
		name().trim() !== "" &&
		profileChosen() &&
		(sourceMode() === "default" || sourceValue().trim() !== "");

	return (
		<Modal title="Add workspace" onClose={close}>
			<Show when={errorInfo()}>
				{(err) => (
					<>
						<div class="msg-notice worktree-error" role="alert">
							Failed while {err().stage}: {err().message}
						</div>
						{/* P8.3 failure state: a clear way back to the form. The
						    submit buttons offer edit-and-retry (re-running the same
						    submission with the current field values); Back to edit
						    returns to the form to change fields first. The pipeline
						    is fully reset in both cases (the failed roster entry is
						    left in place, e.g. a failed preparation keeps its
						    prepared volume for the retry). */}
						<div class="worktree-actions">
							<button
								type="button"
								class="worktree-btn"
								onClick={() => {
									reset();
									setTab(tabAtSubmit());
								}}
							>
								Back to edit
							</button>
							<button type="button" class="worktree-btn" onClick={() => void submitAgain()}>
								Edit and retry
							</button>
						</div>
					</>
				)}
			</Show>
			<Show when={project() === null}>
				<div class="msg-notice worktree-error">unknown project: reopen from the sidebar</div>
			</Show>
			<Show when={!busy() && project() !== null}>
				<div class="worktree-tabs" role="tablist" aria-label="Workspace mode">
					<button
						type="button"
						class="worktree-tab"
						classList={{ active: tab() === "worktree" }}
						role="tab"
						aria-selected={tab() === "worktree"}
						onClick={() => {
							setTab("worktree");
							setFieldError(null);
						}}
					>
						Worktree
					</button>
					<button
						type="button"
						class="worktree-tab"
						classList={{ active: tab() === "clone" }}
						role="tab"
						aria-selected={tab() === "clone"}
						onClick={() => {
							setTab("clone");
							setFieldError(null);
						}}
					>
						Clone
					</button>
					<button
						type="button"
						class="worktree-tab"
						classList={{ active: tab() === "existing" }}
						role="tab"
						aria-selected={tab() === "existing"}
						onClick={() => {
							setTab("existing");
							setFieldError(null);
							refreshProjects();
						}}
					>
						Add existing
					</button>
				</div>
				<Show when={tab() === "worktree"}>
					<form
						class="worktree-form"
						onSubmit={(e) => {
							e.preventDefault();
							void submitWorktree();
						}}
					>
						<label class="daemon-detail-label" for="workspace-name">
							name
						</label>
						<input
							id="workspace-name"
							ref={nameInput}
							class="picker-filter worktree-name"
							placeholder="feature/…"
							value={nameValue()}
							onInput={(e) => {
								setName(e.currentTarget.value);
								setFieldError(null);
							}}
							disabled={branchSelected()}
							spellcheck={false}
						/>
						<Show when={fieldError()}>
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
				<Show when={tab() === "clone"}>
					<form
						class="worktree-form"
						onSubmit={(e) => {
							e.preventDefault();
							void submitClone();
						}}
					>
						<label class="daemon-detail-label" for="workspace-name">
							name
						</label>
						<input
							id="workspace-name"
							ref={nameInput}
							class="picker-filter worktree-name"
							placeholder="e.g. experiment-spike"
							value={name()}
							onInput={(e) => {
								setName(e.currentTarget.value);
								setFieldError(null);
							}}
							spellcheck={false}
						/>
						<Show when={fieldError()}>
							{(err) => <div class="msg-notice worktree-name-error">{err()}</div>}
						</Show>
						<div class="picker-group-name">Provider profile</div>
						<Show when={profiles().length === 0}>
							<div class="tool-collapsed-note">
								this fleet has no provider profiles configured; clones are unavailable
							</div>
						</Show>
						<Show when={profiles().length > 0}>
							<select
								class="worktree-branch-select workspace-profile-select"
								aria-label="Provider profile"
								value={profileId()}
								onChange={(e) => {
									setProfileId(e.currentTarget.value);
									setFieldError(null);
								}}
							>
								{/* No silent default: a missing/never-saved profile keeps
								    the placeholder selected until a real choice lands. */}
								<option value="" disabled>
									choose a profile…
								</option>
								<For each={profiles()}>
									{(p) => (
										<option value={p.id}>
											{p.id} ({p.provider}
											{p.secretRefNames !== undefined && p.secretRefNames.length > 0
												? ", secrets"
												: ""}
											)
										</option>
									)}
								</For>
							</select>
						</Show>
						<div class="picker-group-name">Source</div>
						<div class="workspace-source-modes" role="radiogroup" aria-label="Clone source">
							<button
								type="button"
								class="workspace-source-mode"
								classList={{ active: sourceMode() === "default" }}
								role="radio"
								aria-checked={sourceMode() === "default"}
								onClick={() => {
									setSourceMode("default");
									setFieldError(null);
								}}
							>
								Project checkout
							</button>
							<button
								type="button"
								class="workspace-source-mode"
								classList={{ active: sourceMode() === "local" }}
								role="radio"
								aria-checked={sourceMode() === "local"}
								onClick={() => {
									setSourceMode("local");
									setFieldError(null);
								}}
							>
								Local path…
							</button>
							<button
								type="button"
								class="workspace-source-mode"
								classList={{ active: sourceMode() === "remote" }}
								role="radio"
								aria-checked={sourceMode() === "remote"}
								onClick={() => {
									setSourceMode("remote");
									setFieldError(null);
								}}
							>
								Remote URL…
							</button>
						</div>
						<Show when={sourceMode() === "local"}>
							<input
								class="picker-filter worktree-name workspace-source-input"
								placeholder="absolute path or ~/… on the fleet host"
								value={sourceValue()}
								onInput={(e) => {
									setSourceValue(e.currentTarget.value);
									setFieldError(null);
								}}
								spellcheck={false}
							/>
						</Show>
						<Show when={sourceMode() === "remote"}>
							<input
								class="picker-filter worktree-name workspace-source-input"
								placeholder="https://… or git@host:…"
								value={sourceValue()}
								onInput={(e) => {
									setSourceValue(e.currentTarget.value);
									setFieldError(null);
								}}
								spellcheck={false}
							/>
						</Show>
						<div class="picker-group-name">Revision</div>
						<input
							class="picker-filter worktree-name"
							placeholder="commit SHA or ref (default: project HEAD)"
							value={revision()}
							onInput={(e) => {
								setRevision(e.currentTarget.value);
								setFieldError(null);
							}}
							spellcheck={false}
						/>
						<div class="picker-group-name">Branch</div>
						<input
							class="picker-filter worktree-name"
							placeholder="branch name (default: derived from name)"
							value={branch()}
							onInput={(e) => {
								setBranch(e.currentTarget.value);
								setFieldError(null);
							}}
							spellcheck={false}
						/>
						<label class="worktree-start">
							<input
								type="checkbox"
								checked={start()}
								onChange={(e) => setStart(e.currentTarget.checked)}
							/>
							Start a session now
						</label>
						<div class="worktree-actions">
							<button type="submit" class="worktree-btn" disabled={!cloneReady()}>
								Create clone
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
					<Show
						when={browsing()}
						fallback={
							<button
								type="button"
								class="daemon-row-btn dirpick-toggle"
								onClick={() => setBrowsing(true)}
							>
								or pick a directory…
							</button>
						}
					>
						<DirPicker
							onSelect={(p) => {
								// Same submit path as a listed entry: sendAddExistingWorktree
								// with the picked path.
								setSelectedPath(p);
								setBrowsing(false);
							}}
						/>
					</Show>
					{/* A picker-chosen path matches no listed row; echo it so the
					    selection stays visible once the picker folds away. */}
					<Show
						when={selectedPath() !== null && !unregistered().some((p) => p.path === selectedPath())}
					>
						<div class="dirpick-chosen">Selected: {selectedPath()}</div>
					</Show>
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
