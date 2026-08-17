import { For, Show, createEffect, createResource, createSignal, on, onCleanup } from "solid-js";
import { api, ApiError, type Health, type SessionSummary } from "../api";
import { basename, formatCompact, formatCost, timeAgo } from "../util/format";

interface SessionListProps {
	selectedFile: string | null;
	onOpen: (file: string) => void;
	health: () => Health | undefined;
	/** bumped after a stats sync so the session list refetches */
	syncTick: () => number;
	/** called after a successful stats sync so health/sessions refetch */
	onSynced: () => void;
}

export function SessionList(props: SessionListProps) {
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

	const sessions = () => (sessionsRes.error ? [] : (sessionsRes()?.sessions ?? []));
	const listTotal = () => sessionsRes()?.total ?? 0;
	const listTruncated = () => sessionsRes()?.truncated ?? false;
	const [syncing, setSyncing] = createSignal(false);
	const [syncError, setSyncError] = createSignal<string | null>(null);

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
				<span class="brand">Session Viewer</span>
				<div class="header-right">
					<span class="count">
						{sessionsRes.loading && sessions().length === 0 ? "…" : sessions().length}
					</span>
				</div>
			</header>

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
					when={sessionsRes.error}
					keyed
					fallback={
						<Show
							when={sessionsRes.loading}
							fallback={
								<Show
									when={sessions().length > 0}
									fallback={<div class="list-hint">No sessions match.</div>}
								>
									<For each={sessions()}>
										{(s) => (
											<SessionRow
												session={s}
												selected={s.file === props.selectedFile}
												onOpen={props.onOpen}
											/>
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

			<Show when={listTruncated()}>
				<div class="list-hint truncate-note">
					showing first {sessions().length} of {listTotal()} sessions
				</div>
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

function SessionRow(props: {
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
