import { createMemo, onCleanup, onMount, Show, type Component } from "solid-js";
import { setState, state } from "../../state";
import { openAddProject } from "../../store/projects";
import {
	cancelTypedResumeSearch,
	chooseResumeTarget,
	closeResumePicker,
	deleteResumeSession,
	refreshResumeCapabilities,
	renameResumeSession,
	resumeAllProjects,
	resumeAmbiguous,
	resumeCandidates,
	resumeCapabilities,
	resumeError,
	resumeLoading,
	resumeNotice,
	resumePartial,
	resumeQuery,
	resumeTotal,
	searchResume,
	setResumeAllProjects,
	sessionRowsFromResume,
	typeResumeQuery,
} from "../../store/resume";
import type { SessionRow } from "../../store/session-list";
import { Modal } from "../ui/Modal";
import { SessionListPicker } from "./SessionListPicker";

/**
 * The one session list: `/resume`, ambiguous `/resume <id>` matches, and the empty
 * screen's "All sessions…" link. The list itself is SessionListPicker; this component
 * wires the resume store into it.
 */
export const SessionPicker: Component<{ onClose: () => void }> = (props) => {
	const rows = createMemo(() =>
		sessionRowsFromResume(resumeAmbiguous() ?? resumeCandidates(), state.sessionFile),
	);
	/** The attached session's folder: an expanded row shows its own folder only when it differs. */
	const currentCwd = () =>
		state.sessionRoster.find((session) => session.workspaceId === state.currentWorkspaceId)?.cwd;

	onMount(() => {
		// Ambiguous matches are already the list; do not replace them with a fresh search.
		// Every entry path (composer /resume, sidebar, empty screen) lands here: probe the manage cap.
		refreshResumeCapabilities();
		if (resumeAmbiguous() === null) void searchResume(resumeQuery());
	});
	onCleanup(cancelTypedResumeSearch);

	const close = () => {
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

	return (
		<Modal title="Resume session" class="session-list-dialog" onClose={close}>
			<Show when={resumeAmbiguous()}>
				<div class="msg-notice">
					Several sessions match this search. Choose one below, or{" "}
					<button type="button" onClick={() => void searchResume(resumeQuery())}>
						show all matches
					</button>
					.
				</div>
			</Show>
			<Show when={resumeError()}>{(message) => <div class="msg-notice">{message()}</div>}</Show>
			<Show when={resumeNotice()}>{(message) => <div class="msg-notice">{message()}</div>}</Show>
			<SessionListPicker
				rows={rows()}
				total={resumeTotal()}
				query={resumeQuery()}
				onQuery={typeResumeQuery}
				loading={resumeLoading()}
				allProjects={resumeAllProjects()}
				onAllProjects={(on) => void setResumeAllProjects(on)}
				currentCwd={currentCwd()}
				canManage={resumeCapabilities()?.manage === true}
				emptyText={
					resumePartial()
						? "No titled session matches yet; still reading the rest."
						: resumeQuery()
							? "No sessions match this search."
							: "No resumable sessions in this project."
				}
				note={resumePartial() ? "Reading the rest of your sessions…" : undefined}
				onChoose={choose}
				onAddProject={addProject}
				onRename={renameResumeSession}
				onDelete={deleteResumeSession}
				autoFocus
			/>
		</Modal>
	);
};
