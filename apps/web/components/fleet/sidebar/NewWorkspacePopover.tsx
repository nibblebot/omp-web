import {
	createEffect,
	createMemo,
	createResource,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
	type Component,
	type JSX,
	type Resource,
} from "solid-js";
import { Portal } from "solid-js/web";
import type { ProjectBranch, PublicProviderProfile } from "#lib/wire/protocol";
import { slugifyWorktreeName, worktreeBranchName } from "#lib/wire/worktree-name";
import {
	currentWorkspaceCreationPrefs,
	rememberWorkspaceCreationPrefs,
	type WorkspaceCreationPrefs,
	type WorkspaceSourceChoice,
} from "../../../prefs/workspace-creation";
import { attachSession, state } from "../../../state";
import {
	createClone,
	createWorktree,
	listProjectBranches,
	type ProjectBranchesResult,
} from "../../../store/projects";
import { PickerRow } from "../../ui/PickerRow";
import { moveRovingFocus, setRovingTabStop } from "../../ui/roving";

export interface NewWorkspacePopoverProps {
	projectId: string;
	/** The "+" button that owns this popover; clicks on it are not "outside". */
	anchor: HTMLElement;
	onClose: () => void;
}

/** Submission in flight: the popover stays open until the row is ready and attached. */
type Phase =
	| { kind: "idle" }
	| { kind: "submitting"; label: string }
	| { kind: "starting"; daemonId: string }
	| { kind: "attaching"; daemonId: string };

/** One create request, built from a pick (existing branch or typed name). */
type Pick =
	| { kind: "worktree"; name: string; existingBranch?: string }
	| {
			kind: "clone";
			name: string;
			profileId: string;
			source?: { remoteName: string };
			branch: string;
			revision?: string;
	  };

const POPOVER_WIDTH = 320;
/** Gap between the anchor and the popover, and the minimum distance to the viewport edge. */
const GAP = 4;
const MARGIN = 8;
/** Below this much room under the anchor the popover opens upward when more room is above. */
const MIN_BELOW = 240;

/** The short kind name shown next to a profile id in the "Run on" switch. */
const PROVIDER_KIND_LABEL: Record<PublicProviderProfile["provider"], string> = {
	bwrap: "bwrap",
	kubernetes: "k8s",
	host: "host",
};

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A listing's value, or undefined while unresolved or errored (reading an errored resource throws). */
function listingOf(res: Resource<ProjectBranchesResult>): ProjectBranchesResult | undefined {
	return res.state === "errored" ? undefined : res();
}

/**
 * Anchored "New workspace" popover for one project (owned by the project
 * header "+"; never a ModalHost overlay). Chooses where the workspace runs
 * ("This machine" or a provider profile, plus clone source), then picks an
 * existing branch or types a new one.
 */
export const NewWorkspacePopover: Component<NewWorkspacePopoverProps> = (props) => {
	const remembered = currentWorkspaceCreationPrefs(props.projectId);
	let root: HTMLDivElement | undefined;
	let inputEl: HTMLInputElement | undefined;
	let listEl: HTMLDivElement | undefined;

	const project = () =>
		state.registeredProjects.find((p) => p.projectId === props.projectId) ?? null;
	const missing = () => project()?.missing === true;

	// "Run on": null = This machine; otherwise a provider profile id. A remembered
	// profile that no longer exists resolves to This machine (profile() is null).
	const [runOn, setRunOn] = createSignal<string | null>(
		remembered.kind === "clone" ? (remembered.profileId ?? null) : null,
	);
	const profile = () => state.providerProfiles.find((p) => p.id === runOn()) ?? null;
	const cloning = () => profile() !== null;

	// A profile whose provider prepares its own volume (kubernetes) never has a local
	// source; the switch is forced to Remote.
	const [sourceChoice, setSourceChoice] = createSignal<WorkspaceSourceChoice>(
		remembered.source ?? "local",
	);
	const source = (): WorkspaceSourceChoice =>
		profile()?.preparation === "provider" ? "remote" : sourceChoice();
	const remoteMode = () => cloning() && source() === "remote";

	// Local branches: This machine lists worktree checkouts; a clone lists the
	// main checkout's branches (a clone has its own .git). Also yields remotes.
	const [localListing, { refetch: refetchLocal }] = createResource(
		() => (missing() ? undefined : props.projectId),
		(projectId) => listProjectBranches(projectId),
	);
	const remotes = () => listingOf(localListing)?.remotes ?? [];

	const [remoteChoice, setRemoteChoice] = createSignal<string | undefined>(remembered.remote);
	// origin is listed first by the fleet; a stale remembered remote falls back to it.
	const activeRemote = (): string | undefined => {
		const names = remotes();
		const chosen = remoteChoice();
		if (chosen !== undefined && names.includes(chosen)) return chosen;
		return names[0];
	};
	const [remoteListing, { refetch: refetchRemote }] = createResource(
		() => {
			const remote = remoteMode() && !missing() ? activeRemote() : undefined;
			return remote === undefined ? undefined : { projectId: props.projectId, remote };
		},
		(key) => listProjectBranches(key.projectId, key.remote),
	);

	const listing = () => (remoteMode() ? listingOf(remoteListing) : listingOf(localListing));
	const listingFailure = (): string | null => {
		const res = remoteMode() ? remoteListing : localListing;
		return res.state === "errored" ? messageOf(res.error) : null;
	};
	const listingLoading = (): boolean => {
		if (localListing.state === "unresolved" || localListing.state === "pending") return true;
		return remoteMode() && remoteListing.state === "pending";
	};

	const [text, setText] = createSignal("");
	const query = () => text().trim();
	const slug = () => slugifyWorktreeName(query());
	/** The branch the fleet will create for the typed name (same function server-side). */
	const newBranch = () => worktreeBranchName(query());
	const createAvailable = createMemo(
		() => query() !== "" && !(listing()?.branches ?? []).some((b) => b.name === newBranch()),
	);

	const shownBranches = (): ProjectBranch[] => {
		const q = query().toLowerCase();
		const all = listing()?.branches ?? [];
		return q === "" ? all : all.filter((b) => b.name.toLowerCase().includes(q));
	};

	const createMeta = (): string => {
		if (!cloning()) {
			const head = `folder ${slug() || "needs a letter or digit"}`;
			const base = listing()?.defaultBase;
			return base === undefined ? head : `${head} · from ${base}`;
		}
		const head = `clone ${slug() || "needs a letter or digit"}`;
		if (remoteMode()) {
			const base =
				listing()?.defaultBase ?? (activeRemote() ? `${activeRemote()} default` : "remote default");
			return `${head} · from ${base}`;
		}
		return `${head} · from main checkout HEAD`;
	};

	const branchMeta = (b: ProjectBranch): string => {
		if (!cloning() && b.checkedOut) return "checked out";
		if (b.name === listing()?.defaultBase) return "default";
		return "";
	};

	const [phase, setPhase] = createSignal<Phase>({ kind: "idle" });
	const [error, setError] = createSignal<string | null>(null);
	const busy = () => phase().kind !== "idle";
	// Remote with no git remote would omit `source` and silently clone the local path.
	const canPick = () => !busy() && !missing() && !(remoteMode() && activeRemote() === undefined);

	const cloneSource = (): { remoteName: string } | undefined => {
		const remote = activeRemote();
		return remoteMode() && remote !== undefined ? { remoteName: remote } : undefined;
	};

	const prefsSnapshot = (): WorkspaceCreationPrefs => {
		const p = profile();
		if (p === null) return { kind: "worktree" };
		return {
			kind: "clone",
			profileId: p.id,
			source: source(),
			remote: remoteMode() ? activeRemote() : undefined,
		};
	};

	const submit = async (pick: Pick, label: string): Promise<void> => {
		if (!canPick()) return;
		setError(null);
		setPhase({ kind: "submitting", label });
		rememberWorkspaceCreationPrefs(props.projectId, prefsSnapshot());
		try {
			if (pick.kind === "clone") {
				await createClone(props.projectId, {
					name: pick.name,
					profileId: pick.profileId,
					source: pick.source,
					branch: pick.branch,
					revision: pick.revision,
				});
				// A clone's lifecycle stages ride its roster row; no auto-attach.
				props.onClose();
				return;
			}
			const { daemonId } = await createWorktree(props.projectId, {
				name: pick.name,
				existingBranch: pick.existingBranch,
			});
			setPhase({ kind: "starting", daemonId });
		} catch (err) {
			setPhase({ kind: "idle" });
			setError(messageOf(err));
		}
	};

	/** Pick an existing branch from the listing. */
	const pickExisting = (b: ProjectBranch) => {
		const p = profile();
		if (p === null) {
			return submit(
				{ kind: "worktree", name: b.name, existingBranch: b.name },
				"Creating worktree",
			);
		}
		return submit(
			{
				kind: "clone",
				name: slugifyWorktreeName(b.name),
				profileId: p.id,
				source: cloneSource(),
				branch: b.name,
				revision: b.name,
			},
			"Creating clone",
		);
	};

	/** Create a new branch named by the search field. */
	const pickNew = () => {
		const name = query();
		const p = profile();
		if (p === null) {
			return submit({ kind: "worktree", name }, "Creating worktree");
		}
		return submit(
			{
				kind: "clone",
				name: slugifyWorktreeName(name),
				profileId: p.id,
				source: cloneSource(),
				branch: newBranch(),
			},
			"Creating clone",
		);
	};

	/** Row becomes ready (attach, then close) or fails (inline error, input kept). */
	createEffect(() => {
		const p = phase();
		if (p.kind !== "starting") return;
		const row = state.daemonRoster.find((d) => d.daemonId === p.daemonId);
		if (!row) return;
		if (row.status === "error") {
			setPhase({ kind: "idle" });
			setError(row.error ?? "session process failed to start");
			return;
		}
		if (row.lifecycleStage === "failed") {
			setPhase({ kind: "idle" });
			setError(row.lifecycleError ?? row.error ?? "workspace failed to start");
			return;
		}
		if (row.status === "ready") {
			setPhase({ kind: "attaching", daemonId: p.daemonId });
			attachSession(p.daemonId).then(
				() => props.onClose(),
				(err: unknown) => {
					setPhase({ kind: "idle" });
					setError(messageOf(err));
				},
			);
		}
	});

	const progressText = (): string => {
		const p = phase();
		switch (p.kind) {
			case "submitting":
				return `${p.label}…`;
			case "starting":
				return "Starting session…";
			case "attaching":
				return "Attaching…";
			case "idle":
				return "";
		}
	};

	const rowItems = (): HTMLElement[] =>
		Array.from(listEl?.querySelectorAll<HTMLElement>(".new-workspace-row:not(:disabled)") ?? []);

	const onSearchKey = (e: KeyboardEvent) => {
		if (e.key === "ArrowDown") {
			const items = rowItems();
			if (items.length === 0) return;
			e.preventDefault();
			setRovingTabStop(items, 0);
			items[0]?.focus();
			return;
		}
		// Enter in the field only acts on a typed name (the Create branch row);
		// an existing branch needs an explicit pick (arrow down, then Enter).
		if (e.key === "Enter") {
			e.preventDefault();
			if (createAvailable() && canPick() && slug() !== "") void pickNew();
		}
	};

	const onListKey = (e: KeyboardEvent) => {
		const items = rowItems();
		const current = items.indexOf(document.activeElement as HTMLElement);
		if (current < 0) return;
		if (e.key === "ArrowUp" && current === 0) {
			e.preventDefault();
			inputEl?.focus();
			return;
		}
		moveRovingFocus(e, items, current, "vertical");
	};

	const [place, setPlace] = createSignal<JSX.CSSProperties>({});
	/** Anchored placement: below the anchor, flipped above when the room below is short. */
	const reposition = () => {
		const r = props.anchor.getBoundingClientRect();
		const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - POPOVER_WIDTH - MARGIN));
		const below = window.innerHeight - r.bottom - GAP - MARGIN;
		const above = r.top - GAP - MARGIN;
		setPlace(
			below < MIN_BELOW && above > below
				? {
						left: `${left}px`,
						bottom: `${window.innerHeight - r.top + GAP}px`,
						"max-height": `${above}px`,
					}
				: { left: `${left}px`, top: `${r.bottom + GAP}px`, "max-height": `${below}px` },
		);
	};

	onMount(() => {
		reposition();
		// Portal content mounts after this callback; focus once it exists.
		queueMicrotask(() => inputEl?.focus());
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node | null;
			if (target && (root?.contains(target) || props.anchor.contains(target))) return;
			props.onClose();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			// Restore focus to the owning "+" only when focus was inside the popover.
			const wasInside = root?.contains(document.activeElement) ?? false;
			props.onClose();
			if (wasInside) props.anchor.focus();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKey);
		window.addEventListener("resize", reposition);
		document.addEventListener("scroll", reposition, true);
		onCleanup(() => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("resize", reposition);
			document.removeEventListener("scroll", reposition, true);
		});
	});

	return (
		<Portal>
			<div
				ref={root}
				class="new-workspace"
				role="dialog"
				aria-label={`New workspace in ${project()?.name ?? "project"}`}
				style={place()}
			>
				<header class="new-workspace-head">
					<span class="new-workspace-title">New workspace</span>
					<Show when={project()}>
						{(p) => <span class="new-workspace-project">{p().name}</span>}
					</Show>
				</header>
				<Show
					when={!missing()}
					fallback={
						<p class="new-workspace-note" role="status">
							The main checkout is missing, so workspaces cannot start here.
						</p>
					}
				>
					<Show when={state.providerProfiles.length > 0}>
						<div class="new-workspace-field">
							<div class="new-workspace-segments" role="group" aria-label="Run on">
								<button
									type="button"
									class="new-workspace-segment"
									aria-pressed={runOn() === null}
									disabled={busy()}
									onClick={() => setRunOn(null)}
								>
									This machine
								</button>
								<For each={state.providerProfiles}>
									{(p) => (
										<button
											type="button"
											class="new-workspace-segment"
											aria-pressed={runOn() === p.id}
											disabled={busy()}
											onClick={() => setRunOn(p.id)}
										>
											{`${p.id} · ${PROVIDER_KIND_LABEL[p.provider]}`}
										</button>
									)}
								</For>
							</div>
						</div>
					</Show>
					<Show when={cloning()}>
						<div class="new-workspace-field">
							<div class="new-workspace-segments" role="group" aria-label="Source">
								<Show when={profile()?.preparation !== "provider"}>
									<button
										type="button"
										class="new-workspace-segment"
										aria-pressed={source() === "local"}
										disabled={busy()}
										onClick={() => setSourceChoice("local")}
									>
										Local
									</button>
								</Show>
								<button
									type="button"
									class="new-workspace-segment"
									aria-pressed={source() === "remote"}
									disabled={busy()}
									onClick={() => setSourceChoice("remote")}
								>
									Remote
								</button>
							</div>
							<Show when={remoteMode() && remotes().length > 1}>
								<select
									class="new-workspace-remote"
									aria-label="Remote"
									disabled={busy()}
									value={activeRemote()}
									onChange={(e) => setRemoteChoice(e.currentTarget.value)}
								>
									<For each={remotes()}>{(name) => <option value={name}>{name}</option>}</For>
								</select>
							</Show>
						</div>
					</Show>
					<input
						ref={inputEl}
						type="search"
						class="new-workspace-search"
						placeholder="Search branches or name a new one"
						aria-label="Branch or new workspace name"
						value={text()}
						onInput={(e) => setText(e.currentTarget.value)}
						onKeyDown={onSearchKey}
					/>
					<div
						class="new-workspace-list"
						role="group"
						aria-label="Branches"
						ref={listEl}
						onKeyDown={onListKey}
					>
						<Show when={createAvailable()}>
							<PickerRow
								class="new-workspace-row new-workspace-create"
								disabled={!canPick() || slug() === ""}
								onClick={() => void pickNew()}
							>
								<span class="new-workspace-row-name">{`Create branch "${newBranch()}"`}</span>
								<span class="new-workspace-row-meta">{createMeta()}</span>
							</PickerRow>
						</Show>
						<For each={shownBranches()}>
							{(b) => {
								const checkedOut = !cloning() && b.checkedOut;
								return (
									<PickerRow
										class="new-workspace-row"
										disabled={!canPick() || checkedOut}
										title={
											checkedOut
												? `checked out in ${b.worktreePath ?? "another worktree"}`
												: undefined
										}
										onClick={() => void pickExisting(b)}
									>
										<span class="new-workspace-row-name">{b.name}</span>
										<span class="new-workspace-row-meta">{branchMeta(b)}</span>
									</PickerRow>
								);
							}}
						</For>
						<Show
							when={
								!listingLoading() &&
								listingFailure() === null &&
								!createAvailable() &&
								shownBranches().length === 0
							}
						>
							<p class="new-workspace-note">
								{remoteMode() && remotes().length === 0
									? "This project has no git remotes."
									: "No branches to show."}
							</p>
						</Show>
					</div>
					<Show when={listingLoading()}>
						<p class="new-workspace-note" role="status">
							Loading branches…
						</p>
					</Show>
					<Show when={listingFailure()}>
						{(message) => (
							<div class="new-workspace-note new-workspace-failure" role="alert">
								<span>{message()}</span>
								<button
									type="button"
									class="new-workspace-retry"
									onClick={() => (remoteMode() ? refetchRemote() : refetchLocal())}
								>
									Retry
								</button>
							</div>
						)}
					</Show>
					<Show when={remoteMode() && listing()?.cached}>
						<p class="new-workspace-note">
							Remote unreachable: showing branches cached from its last fetch.
						</p>
					</Show>
					<Show when={busy()}>
						<p class="new-workspace-progress" role="status">
							{progressText()}
						</p>
					</Show>
					<Show when={error()}>
						{(message) => (
							<p class="new-workspace-error" role="alert">
								{message()}
							</p>
						)}
					</Show>
				</Show>
			</div>
		</Portal>
	);
};
