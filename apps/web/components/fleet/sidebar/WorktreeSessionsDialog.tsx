import { createMemo, createSignal, onMount, Show, type Component } from "solid-js";
import {
	WORKSPACE_SESSIONS_MAX_LIMIT as LIST_LIMIT,
	type RosterEntry,
	type SessionListEntry,
} from "#lib/wire/protocol";
import { requestWorkspaceSessions, state } from "../../../state";
import {
	matchSessionRow,
	sessionRowFromListEntry,
	type SessionRow,
} from "../../../store/session-list";
import { resumeWorktreeSession } from "../../../store/worktree-sessions";
import { SessionListPicker } from "../../sessions/SessionListPicker";
import { Modal } from "../../ui/Modal";
import type { DetailedRosterEntry } from "./WorkspaceRow";

// ---------------------------------------------------------------------------
// Dialog variant of a roster row's session list: every recent session of one
// worktree (the latest 200) as a searchable list, titled with the worktree's
// branch. Mounted by ModalHost for `state.modal === "worktree-sessions"`. The
// fleet edge answers from disk, so asleep and never-started sessions list too.
// Search filters the loaded rows on the client; Resume is the only action
// (no scope switch, no rename, pin or delete) and goes through
// resumeWorktreeSession.
// ---------------------------------------------------------------------------

export const WorktreeSessionsDialog: Component<{
	session: RosterEntry;
	onClose: () => void;
}> = (props) => {
	const [sessions, setSessions] = createSignal<SessionListEntry[]>([]);
	const [loading, setLoading] = createSignal(true);
	const [error, setError] = createSignal<string | null>(null);
	const [query, setQuery] = createSignal("");

	onMount(() => {
		requestWorkspaceSessions(props.session.workspaceId, LIST_LIMIT)
			.then((list) => setSessions(list))
			.catch((err) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
	});

	/** Same naming as the roster row: clone name, detached sha, else branch. */
	const title = (): string => {
		const session = props.session as DetailedRosterEntry;
		if (session.workspaceKind === "clone") return session.name;
		if (session.detachedAt !== undefined) return `detached @ ${session.detachedAt}`;
		return session.branch ?? session.name;
	};

	/** The worktree's current session file (live file for the attached row). */
	const currentFile = () =>
		props.session.workspaceId === state.currentWorkspaceId
			? state.sessionFile
			: props.session.lastSessionFile;

	const rows = createMemo((): SessionRow[] =>
		sessions()
			.map((entry) => sessionRowFromListEntry(entry, currentFile()))
			.filter((row) => matchSessionRow(row, query())),
	);

	const choose = (row: SessionRow) => {
		resumeWorktreeSession(props.session.workspaceId, row.file);
		props.onClose();
	};

	return (
		<Modal title={title()} class="session-list-dialog" onClose={props.onClose}>
			<Show when={error()}>{(message) => <div class="msg-notice">{message()}</div>}</Show>
			<SessionListPicker
				rows={rows()}
				total={rows().length}
				note={sessions().length === LIST_LIMIT ? `Showing the latest ${LIST_LIMIT}` : undefined}
				query={query()}
				onQuery={setQuery}
				loading={loading()}
				actions="resume"
				currentCwd={props.session.cwd}
				canManage={false}
				emptyText={query() ? "No sessions match this search." : "No sessions in this worktree yet."}
				onChoose={choose}
				autoFocus
			/>
		</Modal>
	);
};
