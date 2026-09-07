/**
 * ResumeCloneDialog: resume an orphaned (deleted) stored workspace onto a
 * fresh clone. The ONLY resume affordance in the fleet-store surface —
 * resumeClonePath is server-issued and present only on orphaned workspaces;
 * the dialog never renders for fleet-stored browsing otherwise.
 *
 * The warning is explicit: session logs are not the workspace, and
 * transcripts never contain working-tree files — uncommitted working-tree
 * state is unrecoverable once the workspace is gone.
 *
 * The dialog picks which stored session to resume (POST body requires
 * sessionId). Entry from the sidebar workspace row leaves the choice open
 * (default = the workspace's most recent session); entry from a stored
 * session's detail preselected that session.
 */
import { Show, createEffect, createResource, createSignal, For } from "solid-js";
import { Modal } from "../../components/shared/Modal";
import { api, ApiError, type StoredSessionSummary, type StoredWorkspaceSummary } from "../api";
import { state, setView } from "../../state";

// ---------------------------------------------------------------------------
// Module-level open state (self-mounting dialog, rendered from TxBrowser).
// ---------------------------------------------------------------------------

interface ResumeTarget {
	workspace: StoredWorkspaceSummary;
	/** Preselect this session when given (detail entry); null = picker open. */
	sessionId: string | null;
}

let target: ResumeTarget | null = null;
const listeners = new Set<() => void>();

function announce(): void {
	for (const l of listeners) l();
}

/** Open the dialog for an orphaned workspace (sidebar workspace row). */
export function openResumeClone(workspace: StoredWorkspaceSummary): void {
	target = { workspace, sessionId: null };
	announce();
}

/** Open the dialog for a specific stored session (detail header). */
export function openResumeCloneSession(workspace: StoredWorkspaceSummary, sessionId: string): void {
	target = { workspace, sessionId };
	announce();
}

export function closeResumeClone(): void {
	target = null;
	announce();
}

/** Dialog reads the current target reactively. */
export function subscribeResumeClone(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

function resumeCloneTarget(): ResumeTarget | null {
	return target;
}

// ---------------------------------------------------------------------------
// Dialog component
// ---------------------------------------------------------------------------

export function ResumeCloneDialog() {
	const [open, setOpen] = createSignal<ResumeTarget | null>(resumeCloneTarget());
	// Re-render on module announce (open/close from anywhere).
	createEffect(() => subscribeResumeClone(() => setOpen(resumeCloneTarget())));
	return (
		<Show when={open()} keyed>
			{(t) => <ResumeDialogBody target={t} onClose={() => closeResumeClone()} />}
		</Show>
	);
}

function ResumeDialogBody(props: { target: ResumeTarget; onClose: () => void }) {
	const [profileId, setProfileId] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [done, setDone] = createSignal(false);

	const workspace = () => props.target.workspace;
	const wsId = () => workspace().workspaceId;

	// Session picker: fetch the workspace's stored sessions (read-only GET).
	// Default selection = the given sessionId (detail entry) or the most
	// recent session by lastTs.
	const [sessionsRes] = createResource(wsId, (id) => api.storedSessions(id));
	const sessions = (): StoredSessionSummary[] => sessionsRes.latest?.sessions ?? [];
	const sortedByRecent = (list: StoredSessionSummary[]): StoredSessionSummary[] =>
		[...list].sort((a, b) => (b.lastTs ?? b.firstTs ?? 0) - (a.lastTs ?? a.firstTs ?? 0));

	const [sessionId, setSessionId] = createSignal<string | null>(
		props.target.sessionId !== null ? props.target.sessionId : null,
	);

	// Once sessions land and no session was preselected, default to the most
	// recent stored session.
	createEffect(() => {
		const chosen = sessionId();
		if (chosen !== null) return;
		const list = sortedByRecent(sessions());
		if (list.length > 0) setSessionId(list[0]!.sessionId);
	});

	// A target switch (reopen) resets the transient state.
	createEffect(() => {
		void wsId();
		setProfileId("");
		setBusy(false);
		setError(null);
		setDone(false);
		setSessionId(props.target.sessionId);
	});

	const canSubmit = () =>
		!busy() && !done() && sessionId() !== null && sessionsRes.error === undefined;

	const submit = async () => {
		const ws = workspace();
		if (!ws.resumeClonePath || sessionId() === null) return;
		if (busy()) return;
		setBusy(true);
		setError(null);
		try {
			await api.resumeClone(
				ws.resumeClonePath,
				sessionId()!,
				profileId() !== "" ? profileId() : undefined,
			);
			setDone(true);
			// Back to the Work roster where the new clone will appear.
			setView("work");
		} catch (e) {
			// Typed failures surface verbatim in-dialog (no upstream
			// substitution): the fleet's {error:{code,message}} answer.
			if (e instanceof ApiError) {
				setError(e.code !== null ? `${e.code}: ${e.message}` : e.message);
			} else {
				setError(e instanceof Error ? e.message : String(e));
			}
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			title="Resume onto fresh clone"
			onClose={() => {
				if (!busy()) props.onClose();
			}}
		>
			<div class="resume-dialog">
				<p class="resume-warn">
					This provisions a fresh clone at the pinned commit and resumes the selected session there.{" "}
					<strong>
						UNCOMMITTED WORKING-TREE FILE STATE IS UNRECOVERABLE — session logs are not the
						workspace, and transcripts do not contain working-tree files.
					</strong>
				</p>
				<div class="resume-facts">
					<div class="kv">
						workspace <b>{wsId()}</b>
					</div>
					<Show when={workspace().provenance}>
						{(p) => (
							<div class="kv">
								project <b>{p().projectId}</b>
							</div>
						)}
					</Show>
					<Show when={workspace().provenance?.branch}>
						{(b) => (
							<div class="kv">
								branch <b>{b()}</b>
							</div>
						)}
					</Show>
				</div>

				{/* Session to resume. */}
				<div class="resume-field">
					<span>Session to resume</span>
					<Show
						when={sessionsRes.error === undefined}
						fallback={
							<div class="tx-unavailable" role="alert">
								Could not load this workspace's sessions:{" "}
								{sessionsRes.error instanceof Error
									? sessionsRes.error.message
									: String(sessionsRes.error)}
							</div>
						}
					>
						<Show
							when={!sessionsRes.loading || sessions().length > 0}
							fallback={<div class="hint">Loading sessions…</div>}
						>
							<Show
								when={sessions().length > 0}
								fallback={<div class="hint">No stored sessions to resume.</div>}
							>
								<select
									value={sessionId() ?? ""}
									disabled={busy()}
									onChange={(e) => setSessionId(e.currentTarget.value || null)}
								>
									<For each={sortedByRecent(sessions())}>
										{(s) => (
											<option value={s.sessionId}>
												{s.title ?? s.sessionId}
												{s.title ? ` — ${s.sessionId}` : ""}
											</option>
										)}
									</For>
								</select>
							</Show>
						</Show>
					</Show>
				</div>

				<Show when={state.providerProfiles.length > 0}>
					<label class="resume-field">
						<span>Provider profile</span>
						<select
							value={profileId()}
							disabled={busy()}
							onChange={(e) => setProfileId(e.currentTarget.value)}
						>
							<option value="">Fleet default</option>
							<For each={state.providerProfiles}>{(p) => <option value={p.id}>{p.id}</option>}</For>
						</select>
					</label>
				</Show>

				<Show when={error()}>
					{(err) => (
						<div class="tx-unavailable" role="alert">
							{err()}
						</div>
					)}
				</Show>
				<Show when={done()}>
					<div class="resume-ok" role="status">
						Resume request accepted — provisioning a fresh clone.
					</div>
				</Show>

				<div class="resume-actions">
					<button type="button" class="btn" disabled={!canSubmit()} onClick={() => void submit()}>
						{busy()
							? "Provisioning…"
							: done()
								? "Resumed"
								: sessionId() === null
									? "Choose a session"
									: "Resume session"}
					</button>
					<button type="button" class="btn" disabled={busy()} onClick={() => props.onClose()}>
						Cancel
					</button>
				</div>
			</div>
		</Modal>
	);
}
