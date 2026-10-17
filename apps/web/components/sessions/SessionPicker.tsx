import { createMemo, createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import { setState, startNewSession, state } from "../../state";
import { openAddProject } from "../../store/projects";
import {
	chooseResumeTarget,
	closeResumePicker,
	deleteResumeSession,
	openResumeImport,
	refreshResumeCapabilities,
	renameResumeSession,
	resumeAllProjects,
	resumeAmbiguous,
	resumeCandidates,
	resumeCapabilities,
	resumeError,
	resumeLoading,
	resumeNotice,
	resumeQuery,
	resumeTotal,
	searchResume,
	setResumeAllProjects,
	sessionRowsFromResume,
	togglePin,
} from "../../store/resume";
import type { SessionRow } from "../../store/session-list";
import { Modal } from "../ui/Modal";
import { PickerRow } from "../ui/PickerRow";
import { SessionListPicker } from "./SessionListPicker";

/**
 * The one session list: `/resume`, ambiguous `/resume <id>` matches, and the
 * onboarding gate (state.sessionPickerGate set after an attach with sessions on
 * disk). Gate mode adds a "New session" top item; Esc selects it. The list itself
 * is SessionListPicker; this component wires the resume store into it.
 */
export const SessionPicker: Component<{ onClose: () => void }> = (props) => {
	const [error, setError] = createSignal<string | null>(null);
	const gateMode = () => state.sessionPickerGate !== null;
	const rows = createMemo(() =>
		sessionRowsFromResume(resumeAmbiguous() ?? resumeCandidates(), state.sessionFile),
	);

	// Gate-mode Esc = "New session". Registered in onMount BEFORE the Modal's
	// own capture-phase Esc handler, since the child's onMount runs after the
	// parent's; stopImmediatePropagation therefore reliably swallows it.
	// Outside gate mode Esc closes via the Modal as usual.
	const onKeyDown = (e: KeyboardEvent) => {
		if (gateMode() && e.key === "Escape") {
			e.stopImmediatePropagation();
			e.preventDefault();
			chooseNewSession();
		}
	};

	onMount(() => {
		document.addEventListener("keydown", onKeyDown, true);
		onCleanup(() => document.removeEventListener("keydown", onKeyDown, true));
		// Ambiguous matches are already the list; do not replace them with a fresh search.
		// Every entry path (composer /resume, sidebar, gate) lands here: probe manage/pins caps.
		refreshResumeCapabilities();
		if (resumeAmbiguous() === null) void searchResume(resumeQuery());
	});

	const close = () => {
		if (gateMode()) setState("sessionPickerGate", null);
		closeResumePicker();
		setState("modal", null);
		props.onClose();
	};

	const choose = (row: SessionRow) => {
		if (row.blocked) return;
		void chooseResumeTarget(row.id).then((outcome) => {
			if (outcome.kind === "unique") close();
		});
	};

	/** A row no registered project owns: close this list and open Add project prefilled. */
	const addProject = (row: SessionRow) => {
		closeResumePicker();
		openAddProject(row.blocked?.addProjectPath);
	};

	/** Gate-mode Esc/row action: start a fresh session on the attached daemon. */
	const chooseNewSession = () => {
		setState("sessionPickerGate", null);
		void startNewSession().catch((err) => setError(String(err)));
		close();
	};

	return (
		<Modal
			title={gateMode() ? "New session or resume" : "Resume session"}
			class="session-list-dialog"
			onClose={close}
		>
			<Show when={gateMode()}>
				<PickerRow
					class="session-new"
					onClick={chooseNewSession}
					title="Start a fresh session (no history)"
				>
					<span class="picker-label">New session</span>
					<span class="picker-detail">start fresh, no history</span>
				</PickerRow>
			</Show>
			<Show when={resumeAmbiguous()}>
				<div class="msg-notice">
					Several sessions match this search. Choose one below, or{" "}
					<button type="button" onClick={() => void searchResume(resumeQuery())}>
						show all matches
					</button>
					.
				</div>
			</Show>
			<Show when={error() ?? resumeError()}>
				{(message) => <div class="msg-notice">{message()}</div>}
			</Show>
			<Show when={resumeNotice()}>{(message) => <div class="msg-notice">{message()}</div>}</Show>
			<SessionListPicker
				rows={rows()}
				total={resumeTotal()}
				query={resumeQuery()}
				onQuery={(query) => void searchResume(query)}
				loading={resumeLoading()}
				allProjects={resumeAllProjects()}
				onAllProjects={(on) => void setResumeAllProjects(on)}
				canManage={resumeCapabilities()?.manage === true}
				emptyText={
					resumeQuery()
						? "No sessions match this search."
						: "No resumable sessions in this project."
				}
				onChoose={choose}
				onAddProject={addProject}
				onTogglePin={(row) => togglePin(row.id)}
				onRename={renameResumeSession}
				onDelete={deleteResumeSession}
			/>
			<div class="modal-actions">
				<button type="button" onClick={() => openResumeImport()}>
					Resume by ID or import…
				</button>
				<button type="button" onClick={close}>
					Close
				</button>
			</div>
		</Modal>
	);
};
