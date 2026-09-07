/**
 * StoredList: fleet log-store browsing section for the tx sidebar (P8.5).
 *
 * Lists stored workspaces (GET /ctl/stored/workspaces); expanding one lists
 * its sessions (GET /ctl/stored/sessions?workspaceId=). Selecting a session
 * opens the stored detail route in the main pane.
 *
 * Coverage labels: every row carries the "fleet-stored" chip; an orphaned
 * workspace is additionally labeled "deleted workspace — view only". These
 * rows are read-only browsing — NEVER an inline Resume / wake affordance.
 * The ONLY resume action lives on orphaned workspaces via their server-issued
 * resumeClonePath, opening the confirm dialog (ResumeCloneDialog).
 */
import { Show, For, createResource, createSignal } from "solid-js";
import { api, ApiError, type StoredSessionSummary, type StoredWorkspaceSummary } from "../api";
import { formatBytes, formatCompact, timeAgo } from "../util/format";
import { openResumeClone } from "./ResumeCloneDialog";
import { kindsSummary, provenanceLabel } from "./stored";

interface StoredListProps {
	/** selected stored session (route), for row highlight */
	selectedWorkspaceId: string | null;
	selectedSessionId: string | null;
	onOpenSession: (workspaceId: string, sessionId: string) => void;
	/** bumped after a stats sync so the workspace list refetches */
	syncTick: () => number;
}

export function StoredList(props: StoredListProps) {
	const [workspacesRes, { refetch: refetchWorkspaces }] = createResource(
		() => `stored\u0000${props.syncTick()}`,
		() => api.storedWorkspaces(),
	);
	const workspaces = () => workspacesRes.latest?.workspaces ?? [];

	// One expanded workspace at a time (accordion).
	const [expanded, setExpanded] = createSignal<string | null>(null);
	// Sessions resource keyed by the expanded workspace id (null = none
	// expanded, no fetch). Rows filter by workspace id so a stale previous
	// response can never render under the wrong workspace while loading.
	const [sessionsRes, { refetch: refetchSessions }] = createResource(
		() => (expanded() !== null ? `stored-sessions\u0000${expanded()}` : null),
		(key) => (key !== null ? api.storedSessions(expanded() ?? undefined) : null),
	);
	/** Reactive per-workspace sessions read (createResource's .latest is
	 *  non-tracking — the accordion rows must re-render when the resource
	 *  resolves, so read the resource value through a memo). */
	const workspaceSessions = (workspaceId: string): StoredSessionSummary[] =>
		(sessionsRes()?.sessions ?? []).filter((s) => s.workspaceId === workspaceId);

	const toggle = (id: string) => setExpanded((prev) => (prev === id ? null : id));

	return (
		<div class="stored-list-wrap">
			<header class="tx-sidebar-header">
				<span class="brand">Fleet store</span>
				<span class="count">
					{workspacesRes.loading && workspaces().length === 0 ? "…" : workspaces().length}
				</span>
			</header>

			<div class="session-list stored-list">
				<Show
					when={workspaces().length === 0 ? workspacesRes.error : undefined}
					keyed
					fallback={
						<Show
							when={workspacesRes.loading && workspaces().length === 0}
							fallback={
								<Show
									when={workspaces().length > 0}
									fallback={<div class="list-hint">No stored workspaces.</div>}
								>
									<For each={workspaces()}>
										{(w) => {
											// Solid's <For> memoizes the row body per ITEM: reads of
											// expanded()/sessions here would go stale when the
											// accordion flips. Thread REACTIVE ACCESSORS into the row
											// component instead, so the reactivity lives inside it.
											const ownSessions = () => workspaceSessions(w.workspaceId);
											const ownLoading = () =>
												expanded() === w.workspaceId &&
												sessionsRes.loading &&
												workspaceSessions(w.workspaceId).length === 0;
											const ownError = () =>
												expanded() === w.workspaceId ? sessionsRes.error : undefined;
											return (
												<WorkspaceRow
													workspace={w}
													expanded={() => expanded() === w.workspaceId}
													onToggle={() => toggle(w.workspaceId)}
													sessions={ownSessions}
													sessionsLoading={ownLoading}
													sessionsError={ownError}
													onRetrySessions={() => refetchSessions()}
													selectedWorkspaceId={props.selectedWorkspaceId}
													selectedSessionId={props.selectedSessionId}
													onOpenSession={props.onOpenSession}
												/>
											);
										}}
									</For>
								</Show>
							}
						>
							<div class="list-hint">Loading stored workspaces…</div>
						</Show>
					}
				>
					{(err) => (
						<div class="list-error">
							<div class="list-error-title">Failed to load stored workspaces</div>
							{err instanceof ApiError && <div class="list-error-detail">{err.message}</div>}
							<button type="button" class="btn btn-small" onClick={() => refetchWorkspaces()}>
								Retry
							</button>
						</div>
					)}
				</Show>
				{/* A failed refetch with data on screen keeps the previous list; the
				    failure is a note, not a panel swap (TranscriptList idiom). */}
				<Show when={workspacesRes.error && workspaces().length > 0}>
					<div class="list-hint">Refresh failed. Showing the previous list.</div>
				</Show>
			</div>

			<footer class="sidebar-footer stored-foot">
				<div class="foot-line">
					<span class="foot-label">fleet store</span>
					<span class="foot-value">read-only browse</span>
				</div>
			</footer>
		</div>
	);
}

function WorkspaceRow(props: {
	workspace: StoredWorkspaceSummary;
	/** Reactive accessor (Solid's For memoizes the row body per ITEM — a
	 *  static boolean prop would go stale when the accordion flips). */
	expanded: () => boolean;
	onToggle: () => void;
	sessions: () => StoredSessionSummary[];
	sessionsLoading: () => boolean;
	sessionsError: () => Error | undefined;
	onRetrySessions: () => void;
	selectedWorkspaceId: string | null;
	selectedSessionId: string | null;
	onOpenSession: (workspaceId: string, sessionId: string) => void;
}) {
	const w = () => props.workspace;
	const prov = () => w().provenance;
	const expanded = () => props.expanded();
	const sessions = () => props.sessions();
	const sessionsLoading = () => props.sessionsLoading();
	const sessionsError = () => props.sessionsError();
	return (
		<div class="stored-workspace">
			<button
				type="button"
				class="session-row stored-workspace-head"
				classList={{
					selected:
						props.selectedWorkspaceId === w().workspaceId && props.selectedSessionId !== null,
				}}
				onClick={props.onToggle}
				aria-expanded={expanded()}
				title={w().workspaceId}
			>
				<div class="row-top">
					<span class="row-title">{w().workspaceId}</span>
					<span class="row-time">{expanded() ? "−" : "+"}</span>
				</div>
				<div class="row-folder">{prov() ? provenanceLabel(prov()) : ""}</div>
				<div class="row-metrics">
					<span>
						{w().sessions} {w().sessions === 1 ? "session" : "sessions"}
					</span>
					<span class="dot">·</span>
					<span>{formatBytes(w().bytes)}</span>
				</div>
				<div class="row-tags">
					<span class="tag tag-store">fleet-stored</span>
					<Show when={w().viewOnly}>
						<span class="tag tag-warn">deleted workspace — view only</span>
					</Show>
					<Show when={w().readOnly && !w().viewOnly}>
						<span class="tag tag-muted">read only</span>
					</Show>
				</div>
			</button>
			{/* Orphaned workspaces carry the ONLY resume affordance (the server
			    issues resumeClonePath only for them); fleet-stored browsing never
			    offers inline Resume. A sibling row keeps the head button atomic;
			    the dialog picks which session to resume. */}
			<Show when={w().orphaned && w().resumeClonePath !== undefined}>
				<div class="stored-resume-row">
					<span class="row-folder">deleted workspace</span>
					<button type="button" class="btn btn-small" onClick={() => openResumeClone(w())}>
						Resume onto fresh clone
					</button>
				</div>
			</Show>
			<Show when={expanded()}>
				<div class="stored-sessions">
					<Show
						when={sessionsError() === undefined}
						fallback={
							<div class="list-error">
								<div class="list-error-title">Failed to load sessions</div>
								{sessionsError() instanceof ApiError && (
									<div class="list-error-detail">{sessionsError()!.message}</div>
								)}
								<button type="button" class="btn btn-small" onClick={() => props.onRetrySessions()}>
									Retry
								</button>
							</div>
						}
					>
						<Show
							when={!sessionsLoading()}
							fallback={<div class="list-hint">Loading sessions…</div>}
						>
							<Show
								when={sessions().length > 0}
								fallback={<div class="list-hint">No stored sessions.</div>}
							>
								<For each={sessions()}>
									{(s) => (
										<StoredSessionRow
											session={s}
											selected={
												props.selectedWorkspaceId === s.workspaceId &&
												props.selectedSessionId === s.sessionId
											}
											onOpen={() => props.onOpenSession(s.workspaceId, s.sessionId)}
										/>
									)}
								</For>
							</Show>
						</Show>
					</Show>
				</div>
			</Show>
		</div>
	);
}

function StoredSessionRow(props: {
	session: StoredSessionSummary;
	selected: boolean;
	onOpen: () => void;
}) {
	const s = () => props.session;
	return (
		<button
			type="button"
			classList={{ "session-row": true, selected: props.selected }}
			aria-current={props.selected ? "true" : undefined}
			onClick={props.onOpen}
			title={s().sessionId}
		>
			<div class="row-top">
				<span class="row-title">{s().title ?? s().sessionId}</span>
				<span class="row-time">{timeAgo(s().lastTs ?? s().firstTs)}</span>
			</div>
			<div class="row-folder">{s().sessionId}</div>
			<div class="row-metrics">
				<span>{formatBytes(s().bytes)}</span>
				<span class="dot">·</span>
				<span>{s().fileCount} files</span>
				<For each={kindsSummary(s().kinds)}>
					{(k) => (
						<>
							<span class="dot">·</span>
							<span>
								{formatCompact(k.count)} {k.kind}
							</span>
						</>
					)}
				</For>
			</div>
			<Show when={s().missingAssets > 0}>
				<div class="row-tags">
					<span class="tag tag-warn">{s().missingAssets} assets unavailable</span>
				</div>
			</Show>
		</button>
	);
}
