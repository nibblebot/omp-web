import { createMemo, createSignal, onMount, Show, type Component } from "solid-js";
import {
	DAEMON_SESSIONS_MAX_LIMIT as LIST_LIMIT,
	type DaemonEntry,
	type SessionListEntry,
} from "#lib/wire/protocol";
import { requestDaemonSessions, state } from "../../../state";
import {
	matchSessionRow,
	sessionRowFromListEntry,
	type SessionRow,
} from "../../../store/session-list";
import { resumeWorktreeSession } from "../../../store/worktree-sessions";
import { SessionListPicker } from "../../sessions/SessionListPicker";
import { Modal } from "../../ui/Modal";
import type { RosterEntry } from "./WorkspaceRow";

// ---------------------------------------------------------------------------
// Dialog variant of a roster row's session list: every recent session of one
// worktree (the latest 200) as a searchable list, titled with the worktree's
// branch. Mounted by ModalHost for `state.modal === "worktree-sessions"`. The
// fleet edge answers from disk, so asleep and never-started daemons list too.
// Search filters the loaded rows on the client; Resume is the only action
// (no scope switch, no rename, pin or delete) and goes through
// resumeWorktreeSession.
// ---------------------------------------------------------------------------

export const WorktreeSessionsDialog: Component<{
	daemon: DaemonEntry;
	onClose: () => void;
}> = (props) => {
	const [sessions, setSessions] = createSignal<SessionListEntry[]>([]);
	const [loading, setLoading] = createSignal(true);
	const [error, setError] = createSignal<string | null>(null);
	const [query, setQuery] = createSignal("");

	onMount(() => {
		requestDaemonSessions(props.daemon.daemonId, LIST_LIMIT)
			.then((list) => setSessions(list))
			.catch((err) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
	});

	/** Same naming as the roster row: clone name, detached sha, else branch. */
	const title = (): string => {
		const daemon = props.daemon as RosterEntry;
		if (daemon.workspaceKind === "clone") return daemon.name;
		if (daemon.detachedAt !== undefined) return `detached @ ${daemon.detachedAt}`;
		return daemon.branch ?? daemon.name;
	};

	/** The worktree's current session file (live file for the attached row). */
	const currentFile = () =>
		props.daemon.daemonId === state.currentSessionId
			? state.sessionFile
			: props.daemon.lastSessionFile;

	const rows = createMemo((): SessionRow[] =>
		sessions()
			.map((entry) => sessionRowFromListEntry(entry, currentFile()))
			.filter((row) => matchSessionRow(row, query())),
	);

	const choose = (row: SessionRow) => {
		resumeWorktreeSession(props.daemon.daemonId, row.file);
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
				currentCwd={props.daemon.cwd}
				canManage={false}
				emptyText={query() ? "No sessions match this search." : "No sessions in this worktree yet."}
				onChoose={choose}
				autoFocus
			/>
		</Modal>
	);
};
