import {
	For,
	Show,
	createEffect,
	createMemo,
	createResource,
	createSignal,
	on,
	onCleanup,
} from "solid-js";
import { api, ApiError, type Health, type SessionSummary } from "../api";
import { basename, formatCompact, formatCost, timeAgo } from "../util/format";
import { shouldFallbackMissingFile } from "../util/missing-file";
import { groupSessionsByProject } from "../util/project-groups";

interface TranscriptListProps {
	selectedFile: string | null;
	onOpen: (file: string) => void;
	/** Deep-linked selected file is missing: clear the route back to the list. */
	onMissingFile?: (file: string) => void;
	health: () => Health | undefined;
	/** bumped after a stats sync so the session list refetches */
	syncTick: () => number;
	/** called after a successful stats sync so health/sessions refetch */
	onSynced: () => void;
}

export function TranscriptList(props: TranscriptListProps) {
	// Debounced search input → server-side `q` filter.
	const [qInput, setQInput] = createSignal("");
	const [q, setQ] = createSignal("");

	let timer: ReturnType<typeof setTimeout> | undefined;
	createEffect(
		on(qInput, (v) => {
			clearTimeout(timer);
			timer = setTimeout(() => setQ(v.trim()), 250);
		}),
	);
	onCleanup(() => clearTimeout(timer));

	const [sessionsRes, { refetch: refetchSessions }] = createResource(
		() => `${q()}\u0000${props.syncTick()}`,
		async (key) => api.sessions(key.split("\u0000")[0]),
	);

	// Render from .latest (the last SUCCESSFUL response). A refetch, sync
	// tick or search, keeps the previous list on screen and updates it in
	// place when the new data lands, instead of wiping to a loading state.
	const sessions = () => sessionsRes.latest?.sessions ?? [];

	const [syncing, setSyncing] = createSignal(false);
	const [syncError, setSyncError] = createSignal<string | null>(null);

	// Project groups: sessions keep the server's recent-first order inside
	// their group; group order follows each group's most-recent member
	// (earliest position in the server list wins).
	const groups = createMemo(() => groupSessionsByProject(sessions()));
	const [project, setProject] = createSignal("");
	/** Groups after the client-side project filter (composes with search). */
	const visibleGroups = () => {
		const selected = project();
		return selected === "" ? groups() : groups().filter((g) => g.key === selected);
	};
	/** Search or project filter active: an empty list means "no match", not "none yet". */
	const narrowed = () => q() !== "" || project() !== "";
	/** Count badge mirrors the rendered rows (group totals after the filter). */
	const visibleTotal = () => visibleGroups().reduce((n, g) => n + g.sessions.length, 0);

	// Deep-link fallback: when the loaded, untruncated, unfiltered sessions
	// response proves the selected file is missing, route back to the list.
	createEffect(() => {
		const file = props.selectedFile;
		if (file === null) return;
		if (
			shouldFallbackMissingFile({
				selectedFile: file,
				sessions: sessions(),
				loading: sessionsRes.loading,
				errored: !!sessionsRes.error,
				truncated: sessionsRes.latest?.truncated ?? false,
				hasQuery: q() !== "",
			})
		) {
			props.onMissingFile?.(file);
		}
	});

	const runSync = async () => {
		if (syncing()) return;
		setSyncing(true);
		setSyncError(null);
		try {
			await api.sync();
			props.onSynced();
		} catch (e) {
			setSyncError(e instanceof Error ? e.message : String(e));
		} finally {
			setSyncing(false);
		}
	};

	const health = () => props.health();

	return (
		<div class="sidebar-inner">
			<header class="tx-sidebar-header">
				<span class="brand">Transcripts</span>
				<div class="header-right">
					<span class="count">
						{sessionsRes.loading && visibleGroups().length === 0 ? "…" : visibleTotal()}
					</span>
				</div>
			</header>

			<div class="project-filter-wrap">
				<select
					class="project-filter"
					value={project()}
					onChange={(e) => setProject(e.currentTarget.value)}
					aria-label="Filter by project"
				>
					<option value="">All projects</option>
					<For each={groups()}>{(g) => <option value={g.key}>{g.label}</option>}</For>
				</select>
			</div>

			<div class="search-wrap">
				<input
					class="search"
					type="search"
					placeholder="Search title, cwd…"
					value={qInput()}
					onInput={(e) => setQInput(e.currentTarget.value)}
				/>
			</div>

			<div class="session-list">
				<Show
					when={sessions().length === 0 ? sessionsRes.error : undefined}
					keyed
					fallback={
						<Show
							when={sessionsRes.loading && sessions().length === 0}
							fallback={
								<Show
									when={visibleGroups().length > 0}
									fallback={
										<div class="list-hint">
											{narrowed() ? "No sessions match." : "No sessions yet"}
										</div>
									}
								>
									<For each={visibleGroups()}>
										{(group) => (
											<div class="session-group">
												{/* Per-group sticky header: sticks while this group
												    scrolls, releases at its own bottom edge. Rendered
												    even for a single group (uniform look). */}
												<div class="session-group-head">{group.label}</div>
												<For each={group.sessions}>
													{(s) => (
														<TranscriptRow
															session={s}
															selected={s.file === props.selectedFile}
															onOpen={props.onOpen}
														/>
													)}
												</For>
											</div>
										)}
									</For>
								</Show>
							}
						>
							<div class="list-hint">Loading sessions…</div>
						</Show>
					}
				>
					{(err) => (
						<div class="list-error">
							<div class="list-error-title">Failed to load sessions</div>
							{err instanceof ApiError && <div class="list-error-detail">{err.message}</div>}
							<button type="button" class="btn btn-small" onClick={() => refetchSessions()}>
								Retry
							</button>
						</div>
					)}
				</Show>
			</div>

			<Show when={sessionsRes.latest?.truncated}>
				<div class="list-hint truncate-note">
					showing first {sessions().length} of {sessionsRes.latest?.total ?? 0} sessions
				</div>
			</Show>
			{/* A failed refetch (sync or search) with data on screen keeps the
			    previous list; the failure is a note, not a panel swap. */}
			<Show when={sessionsRes.error && sessions().length > 0}>
				<div class="list-hint">Refresh failed. Showing the previous list.</div>
			</Show>
			<footer class="sidebar-footer">
				<div class="foot-line foot-sync">
					<button
						type="button"
						class="btn btn-small"
						disabled={syncing()}
						onClick={() => void runSync()}
						title="Run `omp stats --summary` on the server and refresh the stats.db index"
					>
						<Show when={syncing()} fallback="Sync now">
							<span class="spin" aria-hidden="true" />
							Syncing…
						</Show>
					</button>
					<Show when={syncError()}>
						{(e) => (
							<span class="foot-sync-error" role="alert" title={e()}>
								{e()}
							</span>
						)}
					</Show>
				</div>
				<Show when={health()}>
					{(h) => (
						<>
							<div class="foot-line" title={h().sessionsDir}>
								<span class="foot-label">dir</span>
								<span class="foot-value">{h().sessionsDir}</span>
							</div>
							<div class="foot-line">
								<span class="foot-label">db</span>
								<span class={`foot-value db-${h().statsDb}`}>{h().statsDb}</span>
							</div>
							<div class="foot-line">
								<span class="foot-label">sessions</span>
								<span class="foot-value">{h().sessionsCount}</span>
							</div>
						</>
					)}
				</Show>
			</footer>
		</div>
	);
}

function TranscriptRow(props: {
	session: SessionSummary;
	selected: boolean;
	onOpen: (file: string) => void;
}) {
	const s = () => props.session;
	return (
		<button
			type="button"
			classList={{
				"session-row": true,
				selected: props.selected,
				unsynced: !s().synced,
				missing: !s().onDisk,
			}}
			aria-current={props.selected ? "true" : undefined}
			onClick={() => props.onOpen(s().file)}
			title={s().file}
		>
			<div class="row-top">
				<span class="row-title">{s().title ?? basename(s().file)}</span>
				<span class="row-time">
					{s().synced ? timeAgo(s().lastTs ?? s().firstTs) : "not synced"}
				</span>
			</div>
			<div class="row-folder">{s().folder}</div>
			<div class="row-metrics">
				<span>
					{formatCompact(s().turns)} {s().turns === 1 ? "turn" : "turns"}
				</span>
				<span class="dot">·</span>
				<span>{formatCompact(s().toolCalls)} calls</span>
				<span class="dot">·</span>
				<span>{formatCompact(s().totalTokens)} tok</span>
				<span class="dot">·</span>
				<span>{formatCost(s().totalCost)}</span>
			</div>
			<div class="row-tags">
				<Show when={s().errorTurns > 0}>
					<span class="tag tag-err">{s().errorTurns} err</span>
				</Show>
				<Show when={!s().synced}>
					<span class="tag tag-warn">not indexed</span>
				</Show>
				<Show when={!s().onDisk}>
					<span class="tag tag-muted">missing</span>
				</Show>
			</div>
		</button>
	);
}
