import { createEffect, createSignal, For, onMount, Show, type Component } from "solid-js";
import type { ProjectBranch, ProjectEntry } from "#lib/wire/protocol";
import { slugifyWorktreeName } from "#lib/wire/worktree-name";
import {
	currentWorkspaceCreationPrefs,
	rememberWorkspaceCreationPrefs,
	type WorkspaceKindChoice,
} from "../../../prefs/workspace-creation";
import {
	listProjectBranches,
	listProjects,
	sendAddExistingWorktree,
	sendCreateClone,
	sendCreateWorktree,
	setState,
	state,
} from "../../../state";
import { Modal } from "../../ui/Modal";
import { PickerRow } from "../../ui/PickerRow";
import { moveRovingFocus } from "../../ui/roving";
import { DirectoryPicker } from "./DirectoryPicker";
import { OnboardingProgress, useOnboardingPipeline } from "./onboarding";

/** Worktrees share one creation/import view; clones remain independent. */
type Tab = "worktree" | "clone";
type WorktreeSelection =
	| { kind: "new" }
	| { kind: "branch"; name: string }
	| { kind: "existing"; path: string };

/** Worktree intent: a new branch, an existing branch, or an existing folder. */
type WorktreeMode = "new" | "branch" | "folder";

/** Progress labels track the operation, including imports within Worktree. */
const STAGE_LABELS = {
	worktree: ["creating worktree", "spawning daemon", "attaching session"],
	clone: ["preparing workspace", "starting runtime", "attaching session"],
	existing: ["registering worktree", "spawning daemon", "attaching session"],
} satisfies Record<Tab | "existing", string[]>;

/** Clone source modes: default project checkout, an explicit local path, or
 *  a remote URL. At most one of local/remote rides the command. */
type SourceMode = "default" | "local" | "remote";

/**
 * The Worktree view takes one of three intents: a new branch, an existing
 * branch, or an existing folder. Clone creates an independent provider-managed
 * workspace and is offered only when the fleet has provider profiles.
 * Every submission starts the runtime and attaches a session before closing.
 * Only workspace kind and clone profile are remembered.
 */
export const AddWorkspaceDialog: Component<{ onClose: () => void }> = (props) => {
	const remembered = currentWorkspaceCreationPrefs();
	/** Opened mode: the remembered kind when there is one, else Worktree. */
	const [tab, setTab] = createSignal<Tab>(
		remembered.kind === "clone" && state.providerProfiles.length > 0 ? "clone" : "worktree",
	);
	const [name, setName] = createSignal("");
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
	const [browsing, setBrowsing] = createSignal(false);
	const [projects, setProjects] = createSignal<ProjectEntry[]>([]);
	const [projectsError, setProjectsError] = createSignal<string | null>(null);
	const [projectsLoading, setProjectsLoading] = createSignal(true);
	// Branch checkout paths provide reliable project association for imports.
	const [branches, setBranches] = createSignal<ProjectBranch[]>([]);
	const [branchesLoading, setBranchesLoading] = createSignal(true);
	const [branchesError, setBranchesError] = createSignal<string | null>(null);
	const [selected, setSelected] = createSignal<WorktreeSelection>({ kind: "new" });
	const [mode, setMode] = createSignal<WorktreeMode>("new");
	let nameInput!: HTMLInputElement;
	const [tabAtSubmit, setTabAtSubmit] = createSignal<Tab>("worktree");
	const [importAtSubmit, setImportAtSubmit] = createSignal(false);
	/** "Start a session now" (default on); off = create the workspace and close. */
	const [startNow, setStartNow] = createSignal(true);

	const close = () => {
		setState("modal", null);
		props.onClose();
	};

	const { stage, begin, busy, errorInfo, reset } = useOnboardingPipeline(close);

	const project = () =>
		state.registeredProjects.find((p) => p.projectId === state.workspaceModalProjectId) ?? null;

	const normalizePath = (path: string) => path.replace(/\/+$/, "");
	const pathUnavailable = (path: string) => {
		const normalized = normalizePath(path);
		return (
			normalized === normalizePath(project()?.path ?? "") ||
			state.daemonRoster.some((daemon) => normalizePath(daemon.cwd) === normalized)
		);
	};
	const selectedPath = () => {
		const sel = selected();
		return sel.kind === "existing" ? sel.path : null;
	};
	const selectedBranch = () => {
		const sel = selected();
		if (sel.kind === "branch") return sel.name;
		if (sel.kind === "existing")
			return branches().find((b) => b.worktreePath === sel.path)?.name ?? "";
		return "";
	};
	const sortedBranches = () =>
		[...branches()].sort(
			(a, b) => Number(a.checkedOut) - Number(b.checkedOut) || a.name.localeCompare(b.name),
		);
	const branchUnavailable = (branch: ProjectBranch) =>
		branch.checkedOut && (!branch.worktreePath || pathUnavailable(branch.worktreePath));
	const branchLabel = (branch: ProjectBranch) => {
		if (!branch.checkedOut) return branch.name;
		if (!branch.worktreePath) return `${branch.name} (checked out; pick its directory)`;
		if (normalizePath(branch.worktreePath) === normalizePath(project()?.path ?? ""))
			return `${branch.name} (main checkout)`;
		return `${branch.name} (${pathUnavailable(branch.worktreePath) ? "already available" : "add existing worktree"})`;
	};
	/** Switching intent drops any prior pick so submit can only act on the new mode. */
	const chooseMode = (next: WorktreeMode) => {
		setMode(next);
		setSelected({ kind: "new" });
		setFieldError(null);
	};

	// The fleet's secret-free provider profile catalog (P8.1; rides the
	// registered_projects frame, boot-static, [] on older fleets).
	const profiles = () => state.providerProfiles;
	/** A real profile is selected AND still present in the catalog. */
	const profileChosen = () => profiles().some((p) => p.id === profileId());
	const cloneAvailable = () => profiles().length > 0;

	let discoveryRequest = 0;
	let branchRequest = 0;
	const refreshProjects = (projectId = state.workspaceModalProjectId) => {
		const request = ++discoveryRequest;
		setProjectsLoading(true);
		setProjectsError(null);
		void listProjects()
			.then((list) => {
				if (request !== discoveryRequest || state.workspaceModalProjectId !== projectId) return;
				setProjects(list);
				setProjectsLoading(false);
			})
			.catch((err) => {
				if (request !== discoveryRequest || state.workspaceModalProjectId !== projectId) return;
				setProjectsError(String(err));
				setProjectsLoading(false);
			});
	};

	// Key both requests on project ID, not replaced registry objects.
	createEffect(() => {
		const projectId = state.workspaceModalProjectId;
		const request = ++branchRequest;
		++discoveryRequest;
		setSelected({ kind: "new" });
		setMode("new");
		setBrowsing(false);
		setFieldError(null);
		setBranches([]);
		setProjects([]);
		setBranchesError(null);
		setProjectsError(null);
		setBranchesLoading(projectId !== null);
		setProjectsLoading(projectId !== null);
		if (projectId === null) return;
		refreshProjects(projectId);
		void listProjectBranches(projectId)
			.then((list) => {
				if (request !== branchRequest || state.workspaceModalProjectId !== projectId) return;
				setBranches(list);
				setBranchesLoading(false);
			})
			.catch((err) => {
				if (request !== branchRequest || state.workspaceModalProjectId !== projectId) return;
				setBranchesError(String(err));
				setBranchesLoading(false);
			});
	});

	onMount(() => {
		requestAnimationFrame(() => nameInput?.focus());
	});

	/** Discovery lacks parent identity. Branch paths are authoritative; retain
	 * detached entries only when the parent basename is unambiguous. */
	const unregistered = () => {
		const proj = project();
		if (!proj) return [];
		const uniqueParent = state.registeredProjects.filter((p) => p.name === proj.name).length === 1;
		const checkoutPaths = new Set(
			branches().flatMap((b) => (b.worktreePath ? [normalizePath(b.worktreePath)] : [])),
		);
		return projects().filter(
			(p) =>
				p.isWorktree &&
				!pathUnavailable(p.path) &&
				!checkoutPaths.has(normalizePath(p.path)) &&
				!p.branch &&
				uniqueParent &&
				p.worktreeOf === proj.name,
		);
	};

	const remember = (kind: WorkspaceKindChoice, profile?: string) => {
		rememberWorkspaceCreationPrefs(profile !== undefined ? { kind, profileId: profile } : { kind });
	};

	const submitWorktree = () => {
		const proj = project();
		if (!proj) return;
		setTabAtSubmit("worktree");
		const sel = selected();
		if (mode() === "new") {
			const n = name().trim();
			if (!n) {
				setFieldError("Enter a worktree name");
				return;
			}
			remember("worktree");
			setImportAtSubmit(false);
			begin(() => sendCreateWorktree(proj.projectId, n, { start: startNow() }), startNow(), close);
			return;
		}
		if (sel.kind === "new") {
			setFieldError(mode() === "folder" ? "Choose a folder" : "Choose an existing branch");
			return;
		}
		if (sel.kind === "existing") {
			if (pathUnavailable(sel.path)) {
				setFieldError("This checkout is already available");
				return;
			}
			remember("worktree");
			setImportAtSubmit(true);
			begin(
				() => sendAddExistingWorktree(proj.projectId, sel.path, { start: startNow() }),
				startNow(),
				close,
			);
			return;
		}
		remember("worktree");
		setImportAtSubmit(false);
		begin(
			() =>
				sendCreateWorktree(proj.projectId, sel.name, {
					existingBranch: sel.name,
					start: startNow(),
				}),
			startNow(),
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
					start: startNow(),
				}),
			startNow(),
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
			}
		});
	};

	/** Progress note for the active rung. */
	const stageNote = () => {
		const st = stage();
		if (st.kind === "creating")
			return tab() === "clone"
				? "preparing the clone workspace…"
				: importAtSubmit()
					? "registering the worktree…"
					: "creating the worktree…";
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
				<Show when={cloneAvailable()}>
					<div
						class="worktree-tabs"
						role="tablist"
						aria-label="Workspace mode"
						onKeyDown={(e) => {
							const tabs = Array.from(
								e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
							);
							const target = moveRovingFocus(
								e,
								tabs,
								tabs.indexOf(e.target as HTMLElement),
								"horizontal",
								true,
							);
							if (target !== null) tabs[target].click();
						}}
					>
						<button
							type="button"
							tabIndex={tab() === "worktree" ? 0 : -1}
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
							tabIndex={tab() === "clone" ? 0 : -1}
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
					</div>
				</Show>
				<Show when={tab() === "worktree" || !cloneAvailable()}>
					<form
						class="worktree-form"
						onSubmit={(e) => {
							e.preventDefault();
							void submitWorktree();
						}}
					>
						<div class="workspace-source-modes" role="radiogroup" aria-label="Workspace source">
							<button
								type="button"
								class="workspace-source-mode"
								classList={{ active: mode() === "new" }}
								role="radio"
								aria-checked={mode() === "new"}
								onClick={() => chooseMode("new")}
							>
								New branch
							</button>
							<button
								type="button"
								class="workspace-source-mode"
								classList={{ active: mode() === "branch" }}
								role="radio"
								aria-checked={mode() === "branch"}
								onClick={() => chooseMode("branch")}
							>
								Existing branch
							</button>
							<button
								type="button"
								class="workspace-source-mode"
								classList={{ active: mode() === "folder" }}
								role="radio"
								aria-checked={mode() === "folder"}
								onClick={() => chooseMode("folder")}
							>
								Existing folder
							</button>
						</div>
						<Show when={mode() === "new"}>
							<label class="daemon-detail-label" for="workspace-name">
								name
							</label>
							<input
								id="workspace-name"
								ref={nameInput}
								class="picker-filter worktree-name"
								placeholder="e.g. feature/login-fix"
								value={name()}
								onInput={(e) => {
									setName(e.currentTarget.value);
									setFieldError(null);
								}}
								spellcheck={false}
							/>
							<Show when={slugifyWorktreeName(name().trim()) !== ""}>
								<div class="tool-collapsed-note">
									Branch and folder: {slugifyWorktreeName(name().trim())}
								</div>
							</Show>
						</Show>
						<Show when={fieldError()}>
							{(err) => <div class="msg-notice worktree-name-error">{err()}</div>}
						</Show>
						<Show when={mode() === "branch"}>
							<div class="worktree-list">
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
											const choice = branches().find((b) => b.name === v);
											if (!choice || branchUnavailable(choice)) return;
											setSelected(
												choice.checkedOut && choice.worktreePath
													? { kind: "existing", path: choice.worktreePath }
													: { kind: "branch", name: choice.name },
											);
											setFieldError(null);
										}}
									>
										<option value="" disabled>
											use an existing branch…
										</option>
										<For each={sortedBranches()}>
											{(b) => (
												<option value={b.name} disabled={branchUnavailable(b)}>
													{branchLabel(b)}
												</option>
											)}
										</For>
									</select>
								</Show>
							</div>
						</Show>
						<Show when={mode() === "folder"}>
							<div class="picker-group-name">Detected worktrees</div>
							<Show when={projectsLoading()}>
								<div class="tool-collapsed-note">loading worktrees…</div>
							</Show>
							<Show when={projectsError()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
							<div class="worktree-list">
								<For each={unregistered()}>
									{(p) => (
										<PickerRow
											class="picker-row worktree-row"
											classList={{ active: selectedPath() === p.path }}
											onClick={() => {
												setSelected({ kind: "existing", path: p.path });
												setFieldError(null);
											}}
											title={p.path}
										>
											<span class="picker-label worktree-row-name">{p.name}</span>
											<span class="picker-chip worktree-row-branch">{p.branch || "detached"}</span>
										</PickerRow>
									)}
								</For>
								<Show when={!projectsLoading() && !projectsError() && unregistered().length === 0}>
									<div class="tool-collapsed-note">no additional detected worktrees</div>
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
								<DirectoryPicker
									onSelect={(path) => {
										setSelected({ kind: "existing", path });
										setFieldError(null);
										setBrowsing(false);
									}}
								/>
							</Show>
							<Show when={selectedPath()}>
								<div class="dirpick-chosen">Selected: {selectedPath()}</div>
							</Show>
						</Show>
						<label class="project-start-now">
							<input
								type="checkbox"
								checked={startNow()}
								onChange={(e) => setStartNow(e.currentTarget.checked)}
							/>
							Start a session now
						</label>
						<div class="worktree-actions">
							<button
								type="submit"
								class="worktree-btn"
								disabled={mode() === "new" ? name().trim() === "" : selected().kind === "new"}
							>
								{mode() === "folder"
									? "Add folder"
									: selected().kind === "existing"
										? "Add worktree"
										: "Create worktree"}
							</button>
							<Show when={!cloneAvailable()}>
								<button
									type="button"
									class="daemon-row-btn"
									onClick={() => {
										setState("settingsTab", "providers");
										setState("modal", "settings");
									}}
								>
									Configure providers
								</button>
							</Show>
							<button type="button" class="daemon-row-btn" onClick={() => refreshProjects()}>
								refresh
							</button>
						</div>
					</form>
				</Show>
				<Show when={tab() === "clone" && cloneAvailable()}>
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
						<label class="project-start-now">
							<input
								type="checkbox"
								checked={startNow()}
								onChange={(e) => setStartNow(e.currentTarget.checked)}
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
			</Show>
			<OnboardingProgress
				stage={stage}
				labels={
					STAGE_LABELS[tab() === "clone" ? "clone" : importAtSubmit() ? "existing" : "worktree"]
				}
				note={stageNote()}
				prefix="worktree"
			/>
		</Modal>
	);
};
