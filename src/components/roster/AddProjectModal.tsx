import { createSignal, For, onMount, Show, type Component } from "solid-js";
import { createDirPicker } from "../../fleet-ui/dir-picker";
import { fetchCtlTemplates, sendAddProject, setState } from "../../state";
import { Modal } from "../shared/Modal";
import { DirPicker } from "./DirPicker";
import { PipelineProgress, useOnboardingPipeline } from "./onboarding";

/** Progress labels, index-aligned with the stage rungs. */
const STAGES = ["registering project", "spawning daemon", "attaching session"];

/**
 * Add-repo modal (Phase 6): register a first-class project with the fleet by
 * PICKING A DIRECTORY in the embedded DirPicker — no freeform path input and
 * no root-scanned discovery list (fleet roots are gone edge-side; the
 * `projects` frame now carries only unregistered worktrees, which belong to
 * the worktree modal). The retired SpawnPicker's template/labels fields live
 * in the collapsed advanced section here. "Start a session now" (default
 * off) spawns a daemon on the main checkout; the modal then tracks the
 * pipeline (register → spawn → attach) so the session-picker gate can open
 * after attach settles. Submit needs a picked directory whose git bit is not
 * known-false: a known non-git dir shows "not a git repository" and disables
 * submit (the server stays authoritative when the bit is unknown).
 */
export const AddProjectModal: Component<{ onClose: () => void }> = (props) => {
	const [templates, setTemplates] = createSignal<string[]>([]);
	const [templatesError, setTemplatesError] = createSignal<string | null>(null);
	const [template, setTemplate] = createSignal("local");
	const [labels, setLabels] = createSignal("");
	const [start, setStart] = createSignal(false);
	const [path, setPath] = createSignal<string | null>(null);
	const [pathGit, setPathGit] = createSignal<boolean | null>(null);
	const picker = createDirPicker();

	const close = () => {
		setState("modal", null);
		props.onClose();
	};

	const { stage, begin, busy, errorInfo } = useOnboardingPipeline(close);

	onMount(() => {
		void fetchCtlTemplates()
			.then((list) => {
				setTemplates(list);
				if (list.length > 0 && !list.includes(template())) setTemplate(list[0]);
			})
			.catch((err) => setTemplatesError(err instanceof Error ? err.message : String(err)));
	});

	/** DirPicker footer select: record the path plus its git bit as the picker
	 *  knows it (set when the dir was reached via a listing row, else null). */
	const pick = (p: string) => {
		setPath(p);
		setPathGit(picker.state().hasGit);
	};

	/** Known non-git selection: inline hint + disabled submit. An UNKNOWN git
	 *  bit (manual/breadcrumb/up navigation) does not gate — the edge's
	 *  validateProjectPath answers an error frame either way. */
	const notGit = () => path() !== null && pathGit() === false;
	const canSubmit = () => path() !== null && !notGit();

	const submit = () => {
		const cwd = path();
		if (cwd === null || !canSubmit()) return;
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
					<div class="picker-group-name">Project directory</div>
					<DirPicker picker={picker} onSelect={pick} />
					<Show when={path() !== null}>
						<div class="dirpick-chosen">Selected: {path()}</div>
					</Show>
					<Show when={notGit()}>
						<div class="msg-notice project-path-error">not a git repository</div>
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
				<div class="project-actions">
					<button
						type="button"
						class="project-btn"
						disabled={!canSubmit()}
						onClick={() => void submit()}
					>
						Add repo
					</button>
				</div>
			</Show>
			<PipelineProgress stage={stage} labels={STAGES} note={stageNote()} prefix="project" />
		</Modal>
	);
};
