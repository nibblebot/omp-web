import { createSignal, For, onMount, Show, type Component } from "solid-js";
import type { ProjectEntry } from "../../../shared/protocol";
import { fetchCtlTemplates, listProjects, sendAddProject, setState, state } from "../../state";
import { Modal } from "../shared/Modal";
import { PickerRow } from "../shared/PickerRow";
import { PipelineProgress, useOnboardingPipeline } from "./onboarding";

/** Progress labels, index-aligned with the stage rungs. */
const STAGES = ["registering project", "spawning daemon", "attaching session"];

/**
 * Add-repo modal (Phase 5): register a first-class project with the fleet.
 * The path comes from a freeform input or the discovery-fed project list
 * (main checkouts only — worktrees belong to the worktree modal); the
 * retired SpawnPicker's template/labels fields live in the collapsed
 * advanced section here. "Start a session now" (default off) spawns a
 * daemon on the main checkout; the modal then tracks the pipeline
 * (register → spawn → attach) so the session-picker gate can open after
 * attach settles.
 */
export const AddProjectModal: Component<{ onClose: () => void }> = (props) => {
	const [projects, setProjects] = createSignal<ProjectEntry[]>([]);
	const [projectsError, setProjectsError] = createSignal<string | null>(null);
	const [templates, setTemplates] = createSignal<string[]>([]);
	const [templatesError, setTemplatesError] = createSignal<string | null>(null);
	const [path, setPath] = createSignal("");
	const [template, setTemplate] = createSignal("local");
	const [labels, setLabels] = createSignal("");
	const [start, setStart] = createSignal(false);
	const [pathError, setPathError] = createSignal<string | null>(null);
	let pathInput!: HTMLInputElement;

	const close = () => {
		setState("modal", null);
		props.onClose();
	};

	const { stage, begin, busy, errorInfo } = useOnboardingPipeline(close);

	onMount(() => {
		void listProjects()
			.then(setProjects)
			.catch((err) => setProjectsError(String(err)));
		void fetchCtlTemplates()
			.then((list) => {
				setTemplates(list);
				if (list.length > 0 && !list.includes(template())) setTemplate(list[0]);
			})
			.catch((err) => setTemplatesError(err instanceof Error ? err.message : String(err)));
		requestAnimationFrame(() => pathInput?.focus());
	});

	/** Main checkouts only — adding a project registers a repo, not a worktree. */
	const mains = () => projects().filter((p) => !p.isWorktree);
	const registeredPaths = () => new Set(state.registeredProjects.map((p) => p.path));

	const pick = (p: ProjectEntry) => {
		setPath(p.path);
		setPathError(null);
	};

	const submit = () => {
		const cwd = path().trim();
		if (!cwd) {
			setPathError("Enter a project path (or pick one below)");
			return;
		}
		// Comma-separated k=v list; the edge validates each label's shape and
		// answers an error frame on a bad one.
		const parsedLabels = labels()
			.split(",")
			.map((l) => l.trim())
			.filter((l) => l !== "");
		const wantStart = start();
		begin(
			() =>
				sendAddProject(cwd, {
					...(wantStart ? { start: true } : {}),
					template: template(),
					...(parsedLabels.length > 0 ? { labels: parsedLabels } : {}),
				}),
			wantStart,
			close,
		);
	};

	/** Progress note for the active rung. */
	const stageNote = () => {
		const st = stage();
		if (st.kind === "creating") return "registering the project…";
		if (st.kind === "spawning") return "starting the daemon…";
		return "attaching to the session…";
	};

	return (
		<Modal title="Add repo" onClose={close}>
			<Show when={errorInfo()}>
				{(err) => (
					<>
						<div class="msg-notice project-error">
							Failed while {err().stage}: {err().message}
						</div>
						<div class="project-actions">
							<button type="button" class="project-btn" onClick={close}>
								Close
							</button>
						</div>
					</>
				)}
			</Show>
			<Show when={!busy()}>
				<div class="project-form">
					<label class="daemon-detail-label" for="project-path">
						path
					</label>
					<input
						id="project-path"
						ref={pathInput}
						class="picker-filter project-path"
						placeholder="~/repos/… or absolute path"
						value={path()}
						onInput={(e) => {
							setPath(e.currentTarget.value);
							setPathError(null);
						}}
						spellcheck={false}
					/>
					<Show when={pathError()}>
						{(err) => <div class="msg-notice project-path-error">{err()}</div>}
					</Show>
					<details class="project-advanced">
						<summary>Advanced</summary>
						<label class="daemon-detail-label" for="project-template">
							template
						</label>
						<select
							id="project-template"
							class="project-template"
							value={template()}
							onChange={(e) => setTemplate(e.currentTarget.value)}
						>
							<Show when={templates().length === 0 && templatesError() === null}>
								<option value="local">local</option>
							</Show>
							<For each={templates()}>{(t) => <option value={t}>{t}</option>}</For>
						</select>
						<Show when={templatesError()}>
							{(err) => <div class="msg-notice project-template-error">{err()}</div>}
						</Show>
						<label class="daemon-detail-label" for="project-labels">
							labels
						</label>
						<input
							id="project-labels"
							class="picker-filter project-labels"
							placeholder="tag=api, env=prod"
							value={labels()}
							onInput={(e) => setLabels(e.currentTarget.value)}
							spellcheck={false}
						/>
					</details>
					<label class="project-start">
						<input
							type="checkbox"
							checked={start()}
							onChange={(e) => setStart(e.currentTarget.checked)}
						/>
						Start a session now
					</label>
				</div>
				<div class="picker-group-name">Discovered projects</div>
				<Show when={projectsError()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
				<div class="project-list">
					<For each={mains()}>
						{(p) => (
							<PickerRow
								class="picker-row project-row"
								classList={{ active: path() === p.path }}
								onClick={() => pick(p)}
								title={p.path}
							>
								<span class="picker-label project-row-name">{p.name}</span>
								<Show when={p.branch}>
									{(b) => <span class="picker-chip project-row-branch">{b()}</span>}
								</Show>
								<Show when={registeredPaths().has(p.path)}>
									<span class="project-row-registered">registered</span>
								</Show>
							</PickerRow>
						)}
					</For>
					<Show when={projects().length === 0 && !projectsError()}>
						<div class="tool-collapsed-note">no projects discovered</div>
					</Show>
				</div>
				<div class="project-actions">
					<button type="button" class="project-btn" onClick={() => void submit()}>
						Add repo
					</button>
				</div>
			</Show>
			<PipelineProgress stage={stage} labels={STAGES} note={stageNote()} prefix="project" />
		</Modal>
	);
};
