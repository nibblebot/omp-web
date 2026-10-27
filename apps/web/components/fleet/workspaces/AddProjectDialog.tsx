import {
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	onMount,
	Show,
	type Component,
} from "solid-js";
import { addTarget, createDirPicker, pathCrumbs } from "../../../fleet-ui/dir-picker";
import { setState, state } from "../../../state";
import { addProject, fetchRecentRoots, highlightProject } from "../../../store/projects";
import { DialogActions } from "../../ui/DialogActions";
import { ArrowUpIcon, FolderIcon, HomeIcon } from "../../ui/icons";
import { Modal } from "../../ui/Modal";
import { moveRovingFocus, setRovingTabStop } from "../../ui/roving";

/** Folder the chooser opens at: the prefilled path, else the parent of the newest registered project, else home. */
function openingPath(): string {
	if (state.addProjectPath) return state.addProjectPath;
	const newest = [...state.registeredProjects].sort((a, b) => b.addedAt - a.addedAt)[0];
	if (newest !== undefined) return newest.path.replace(/\/[^/]*\/?$/, "") || "/";
	return "~";
}

function basename(path: string): string {
	return path.split("/").filter(Boolean).pop() ?? path;
}

/** Folder chooser for adding a project: the main checkout is resolved server-side from the chosen folder. */
export const AddProjectDialog: Component<{ onClose: () => void }> = (props) => {
	const picker = createDirPicker();
	const [snap, setSnap] = createSignal(picker.state());
	const unsubscribe = picker.subscribe(() => setSnap(picker.state()));
	const [recent, setRecent] = createSignal<string[]>([]);
	const [editing, setEditing] = createSignal(false);
	const [draft, setDraft] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const [submitError, setSubmitError] = createSignal<string | null>(null);
	let pathInput!: HTMLInputElement;
	let listEl!: HTMLDivElement;

	const crumbs = createMemo(() => pathCrumbs(snap().currentPath));
	const target = () => addTarget(snap());
	const canSubmit = () => target() !== null && !snap().loading && !busy();

	const close = () => {
		setState("modal", null);
		props.onClose();
	};

	onCleanup(unsubscribe);
	onCleanup(() => setState("addProjectPath", null));

	onMount(() => {
		void picker.navigate(openingPath());
		// Recent repos are a shortcut only: when the edge is unreachable the
		// listing already shows the fleet error, so the shortcut list stays empty.
		fetchRecentRoots()
			.then((res) => setRecent(res.roots.filter((r) => !r.registered).map((r) => r.path)))
			.catch(() => setRecent([]));
	});

	// Keep exactly one tab stop in the list: the selected folder, else the first row.
	createEffect(
		on(
			() => snap().dirs,
			() => {
				const rows = Array.from(listEl.querySelectorAll<HTMLElement>(".add-project-row"));
				const active = rows.findIndex((el) => el.getAttribute("aria-pressed") === "true");
				setRovingTabStop(rows, Math.max(0, active));
			},
		),
	);

	const startEdit = () => {
		setDraft(snap().currentPath);
		setEditing(true);
		queueMicrotask(() => {
			pathInput.focus();
			pathInput.select();
		});
	};

	const commitPath = () => {
		const next = draft().trim();
		setEditing(false);
		if (next !== "") void picker.navigate(next);
	};

	const onListKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Backspace") {
			e.preventDefault();
			void picker.up();
			return;
		}
		const row = e.target instanceof HTMLElement ? e.target : null;
		if (e.key === "Enter" && row?.dataset.path) {
			e.preventDefault();
			void picker.navigate(row.dataset.path);
			return;
		}
		const rows = Array.from(listEl.querySelectorAll<HTMLElement>(".add-project-row"));
		moveRovingFocus(e, rows, rows.indexOf(row as HTMLElement), "vertical");
	};

	const submit = async () => {
		const t = target();
		if (t === null || !canSubmit()) return;
		setBusy(true);
		setSubmitError(null);
		try {
			const { projectId } = await addProject(t.path);
			highlightProject(projectId);
			close();
		} catch (err) {
			setSubmitError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal title="Add project" class="add-project-modal" onClose={close}>
			<div class="add-project-bar">
				<button
					type="button"
					class="add-project-icon-btn"
					title="Parent folder"
					aria-label="Parent folder"
					disabled={snap().parent === null || snap().loading}
					onClick={() => void picker.up()}
				>
					<ArrowUpIcon />
				</button>
				<Show
					when={editing()}
					fallback={
						<div class="add-project-path" title="Click to type a path" onClick={startEdit}>
							<For each={crumbs()}>
								{(c, i) => (
									<>
										<Show when={i() > 1}>
											<span class="add-project-sep">/</span>
										</Show>
										<button
											type="button"
											class="add-project-crumb"
											classList={{ current: i() === crumbs().length - 1 }}
											disabled={i() === crumbs().length - 1}
											onClick={(e) => {
												e.stopPropagation();
												void picker.navigate(c.path);
											}}
										>
											{c.label}
										</button>
									</>
								)}
							</For>
						</div>
					}
				>
					<form
						class="add-project-path-form"
						onSubmit={(e) => {
							e.preventDefault();
							commitPath();
						}}
					>
						<input
							ref={pathInput}
							class="picker-filter add-project-path-input"
							data-inline-escape
							aria-label="Folder path"
							placeholder="/path/to/folder or ~/folder"
							value={draft()}
							onInput={(e) => setDraft(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key !== "Escape") return;
								e.stopPropagation();
								setEditing(false);
							}}
							onBlur={() => setEditing(false)}
						/>
					</form>
				</Show>
				<button type="button" class="add-project-type-btn" disabled={editing()} onClick={startEdit}>
					Type path
				</button>
			</div>
			<div class="add-project-body">
				<nav class="add-project-shortcuts" aria-label="Shortcuts">
					<button
						type="button"
						class="picker-row add-project-shortcut"
						onClick={() => void picker.navigate()}
					>
						<HomeIcon class="add-project-folder" />
						<span>Home</span>
					</button>
					<Show when={recent().length > 0}>
						<div class="add-project-shortcuts-head">Recent repos</div>
						<For each={recent()}>
							{(p) => (
								<button
									type="button"
									class="picker-row add-project-shortcut"
									title={p}
									onClick={() => void picker.navigate(p)}
								>
									<FolderIcon class="add-project-folder" />
									<span>{basename(p)}</span>
								</button>
							)}
						</For>
					</Show>
				</nav>
				<div class="add-project-listing">
					<Show when={snap().error}>
						{(err) => (
							<div class="msg-notice add-project-error" role="alert">
								{err()}
							</div>
						)}
					</Show>
					<Show when={snap().loading}>
						<div class="add-project-status">Loading…</div>
					</Show>
					<div
						class="add-project-list"
						role="group"
						aria-label="Folders"
						ref={listEl}
						onKeyDown={onListKeyDown}
					>
						<Show when={snap().parent}>
							{(p) => (
								<button
									type="button"
									class="picker-row add-project-row add-project-up"
									title={p()}
									onClick={() => void picker.up()}
								>
									<span class="add-project-name">..</span>
								</button>
							)}
						</Show>
						<For each={snap().dirs}>
							{(d) => (
								<button
									type="button"
									class="picker-row add-project-row"
									classList={{ selected: d.path === snap().selected }}
									aria-pressed={d.path === snap().selected ? "true" : "false"}
									data-path={d.path}
									title={d.path}
									onClick={() => picker.select(d.path)}
									onDblClick={() => void picker.navigate(d.path)}
								>
									<FolderIcon class="add-project-folder" />
									<span class="add-project-name">{d.name}</span>
									<Show when={d.hasGit}>
										<span class="picker-chip add-project-git">git</span>
									</Show>
								</button>
							)}
						</For>
					</div>
					<Show
						when={
							!snap().loading &&
							snap().error === null &&
							snap().currentPath !== "" &&
							snap().dirs.length === 0
						}
					>
						<div class="add-project-status">No subfolders</div>
					</Show>
					<Show when={snap().truncated && !snap().loading}>
						<div class="tool-collapsed-note">listing truncated, showing first 500 entries</div>
					</Show>
				</div>
			</div>
			<div class="add-project-footer">
				<div class="add-project-target">
					<Show
						when={target()}
						fallback={<span class="add-project-status">No folder selected</span>}
					>
						{(t) => (
							<span class="add-project-target-path" title={t().path}>
								{t().path}
							</span>
						)}
					</Show>
					<Show when={submitError()}>
						{(err) => (
							<div class="msg-notice add-project-error" role="alert">
								{err()}
							</div>
						)}
					</Show>
				</div>
				<DialogActions
					onCancel={close}
					onPrimary={() => void submit()}
					primaryLabel="Add project"
					primaryDisabled={!canSubmit()}
					busy={busy()}
				/>
			</div>
		</Modal>
	);
};
