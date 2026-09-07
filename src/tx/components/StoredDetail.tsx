/**
 * StoredDetail: main-pane detail for a fleet-stored session (P8.5).
 *
 * Route #/stored/<workspaceId>/<sessionId>. Header + per-kind file list from
 * StoredSessionDetail.files; selecting a stored file shows its transcript
 * (parsed, via the shared TranscriptPage rendering) or, via the raw toggle,
 * the byte-identical JSONL. A file with status "missing" is rendered as an
 * explicit UNAVAILABLE — never a clickable download/transcript link.
 *
 * The resume-onto-fresh-clone action appears ONLY when the workspace summary
 * carries resumeClonePath (orphaned/deleted workspaces) — never for
 * fleet-stored browsing otherwise.
 */
import { Show, createEffect, createResource, createSignal, For } from "solid-js";
import { api, type StoredFileInfo } from "../api";
import { formatBytes, formatDateTime, timeAgo } from "../util/format";
import { StoredTranscriptPane } from "./StoredTranscriptView";
import { openResumeCloneSession } from "./ResumeCloneDialog";
import { groupFilesByKind } from "./stored";

const KIND_TITLES: Record<string, string> = {
	main: "Main session",
	subagent: "Subagents",
	advisor: "Advisor",
	metadata: "Metadata",
};

export function StoredDetail(props: { workspaceId: string; sessionId: string }) {
	const [detailRes, { refetch: refetchDetail }] = createResource(
		() => `${props.workspaceId}\u0000${props.sessionId}`,
		(key) => {
			const [ws, sid] = key.split("\u0000");
			return api.storedSessionDetail(ws!, sid!);
		},
	);

	/** An errored Solid resource throws when read — check .error first. */
	const detail = () => (detailRes.error ? undefined : detailRes());

	// Workspace summaries: provenance facts + the orphaned resume path live
	// on the workspace row, not the session detail. Fetched only while a
	// stored detail route is mounted (read-only, never wakes compute).
	const [workspacesRes] = createResource(
		() => `stored-ws-detail\u0000${props.workspaceId}`,
		() => api.storedWorkspaces(),
	);
	const workspace = () =>
		(workspacesRes.error ? [] : (workspacesRes()?.workspaces ?? [])).find(
			(w) => w.workspaceId === props.workspaceId,
		);

	const [selected, setSelected] = createSignal<StoredFileInfo | null>(null);
	createEffect(() => {
		void props.sessionId;
		void props.workspaceId;
		const d = detail();
		// Default to the main file (or the first stored one).
		const files = d?.files ?? [];
		const main = files.find((f) => f.kind === "main" && f.status === "stored");
		const first = files.find((f) => f.status === "stored");
		setSelected(main ?? first ?? null);
	});

	return (
		<div class="detail">
			<header class="detail-head">
				<div class="head-title-row">
					<h2>{detail()?.title ?? props.sessionId}</h2>
					<span class="head-file">{props.workspaceId}</span>
				</div>
				<div class="head-meta">
					<Show when={workspace()?.provenance} keyed>
						{(p) => (
							<>
								<span class="kv">
									project <b>{p.projectId}</b>
								</span>
								<span class="kv">
									kind <b>{p.kind}</b>
								</span>
								<Show when={p.profileId}>
									<span class="kv">
										profile <b>{p.profileId}</b>
									</span>
								</Show>
								<Show when={p.branch}>
									<span class="kv">
										branch <b>{p.branch}</b>
									</span>
								</Show>
								<Show when={p.pinnedRevision}>
									<span class="kv">
										pinned <b>{p.pinnedRevision}</b>
									</span>
								</Show>
								<Show when={p.sourceKind}>
									<span class="kv">
										source <b>{p.sourceKind}</b>
									</span>
								</Show>
							</>
						)}
					</Show>
					<Show when={detail()?.lastTs != null}>
						<span class="kv">
							last activity{" "}
							<b title={formatDateTime(detail()?.lastTs)}>{timeAgo(detail()?.lastTs)}</b>
						</span>
					</Show>
					<Show when={detail()?.bytes != null}>
						<span class="kv">
							bytes <b>{formatBytes(detail()?.bytes)}</b>
						</span>
					</Show>
				</div>
				<div class="head-tags">
					<span class="tag tag-store">fleet-stored</span>
					<Show when={detail()?.orphaned === true}>
						<span class="tag tag-warn">deleted workspace — view only</span>
					</Show>
					<Show when={detail()?.readOnly === true && detail()?.orphaned !== true}>
						<span class="tag tag-muted">read only</span>
					</Show>
				</div>
			</header>

			{/* Orphaned (deleted) workspace: the ONLY resume affordance. */}
			<Show when={workspace()} keyed>
				{(ws) => (
					<Show when={ws.orphaned === true && ws.resumeClonePath !== undefined}>
						<div class="stored-orphan-banner">
							<span>This workspace was deleted — sessions are stored view-only.</span>
							<button
								type="button"
								class="btn btn-small"
								onClick={() => openResumeCloneSession(ws, props.sessionId)}
							>
								Resume onto fresh clone
							</button>
						</div>
					</Show>
				)}
			</Show>

			<Show when={detailRes.error} keyed>
				{(err) => (
					<div class="tx-error-banner">
						<span>Failed to load this stored session: {String(err)}</span>
						<button type="button" class="btn btn-small" onClick={() => refetchDetail()}>
							Retry
						</button>
					</div>
				)}
			</Show>
			<Show when={detailRes.loading && !detail()}>
				<div class="hint">Loading stored session…</div>
			</Show>

			{/* File groups */}
			<Show when={detail()} keyed>
				{(d) => (
					<>
						<div class="stored-files">
							<For each={groupFilesByKind(d.files)}>
								{(group) => (
									<section class="stored-file-group">
										<h3 class="stored-group-title">{KIND_TITLES[group.kind] ?? group.label}</h3>
										<For each={group.files}>
											{(f) => (
												<FileRow
													file={f}
													selected={selected()?.relpath === f.relpath}
													onPick={() => {
														if (f.status === "stored") setSelected(f);
													}}
												/>
											)}
										</For>
									</section>
								)}
							</For>
						</div>

						{/* Transcript / raw pane for the selected stored file. */}
						<Show when={selected()} keyed>
							{(sel) => (
								<StoredTranscriptPane
									workspaceId={props.workspaceId}
									sessionId={props.sessionId}
									relpath={sel.relpath}
								/>
							)}
						</Show>
						<Show when={selected() === null && d.files.length === 0}>
							<div class="list-hint">No files stored for this session.</div>
						</Show>
					</>
				)}
			</Show>
		</div>
	);
}

function FileRow(props: { file: StoredFileInfo; selected: boolean; onPick: () => void }) {
	const f = () => props.file;
	const missing = () => f().status === "missing";
	return (
		<button
			type="button"
			classList={{
				"stored-file-row": true,
				selected: props.selected,
				unavailable: missing(),
			}}
			disabled={missing()}
			onClick={props.onPick}
			title={f().relpath}
		>
			<span class="stored-file-name">{f().relpath}</span>
			<span class="stored-file-meta">
				<Show when={!missing()}>
					<span>{formatBytes(f().bytes)}</span>
					<Show when={f().eof}>
						<span class="stored-file-eof">eof</span>
					</Show>
				</Show>
				<Show when={missing()}>
					<span class="tx-unavailable-inline">missing from fleet store — unavailable</span>
				</Show>
			</span>
		</button>
	);
}
