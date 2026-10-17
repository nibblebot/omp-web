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
import { api, ApiError, type Health, type SessionSummary } from "../../store/fleet-api";
import { basename, formatBytes, formatCompact, formatCost, timeAgo } from "../util/format";
import { shouldFallbackMissingFile } from "../util/missing-file";
import { groupSessionsByProject } from "../util/project-groups";
import { displayTitle } from "../../components/ui/title-icons";
import { moveRovingFocus } from "../../components/ui/roving";

interface TranscriptListProps {
	selectedFile: string | null;
	onOpen: (file: string) => void;
	/** Open a fleet-store-origin row in the stored detail route (P8.6). */
	onOpenStored: (workspaceId: string, sessionId: string) => void;
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
	/** The one row reachable with Tab: the selected session, else the first visible one. */
	const tabStopFile = () => props.selectedFile ?? visibleGroups()[0]?.sessions[0]?.file ?? null;

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

	/** Arrow keys move focus between session rows; only the tab-stop row is in the Tab order. */
	const onRowKeys = (e: KeyboardEvent) => {
		const items = Array.from(
			(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(".session-row"),
		);
		const current = items.indexOf(e.target as HTMLElement);
		if (current === -1) return;
		moveRovingFocus(e, items, current, "vertical");
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
					placeholder="Search title, folder, cwd, id…"
					value={qInput()}
					onInput={(e) => setQInput(e.currentTarget.value)}
				/>
			</div>

			<div class="session-list" onKeyDown={onRowKeys}>
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
											{narrowed()
												? "No sessions match."
												: "No sessions yet. Run Sync now to index transcripts."}
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
															tabStop={s.file === tabStopFile()}
															onOpen={props.onOpen}
															onOpenStored={props.onOpenStored}
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
						disabled={syncing() || health()?.syncing === true}
						onClick={() => void runSync()}
						title="Run `omp stats --summary` on the server and refresh the stats.db index"
					>
						<Show when={syncing() || health()?.syncing === true} fallback="Sync now">
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
						<div class="foot-line" title={`${h().sessionsDir} · ${h().sessionsCount} sessions`}>
							<span class="foot-value">
								{h().lastSyncedAt === null
									? "Not synced yet"
									: `Synced ${timeAgo(Date.parse(h().lastSyncedAt ?? ""))}`}
							</span>
							<Show when={h().statsDb !== "ok"}>
								<span class={`foot-value db-${h().statsDb}`}>stats.db {h().statsDb}</span>
							</Show>
						</div>
					)}
				</Show>
				<Show when={health()?.fleetStore}>
					{(fs) => (
						<div class="foot-line">
							<span class="foot-value">
								store {fs().workspaces} ws · {fs().sessions}{" "}
								{fs().sessions === 1 ? "session" : "sessions"} · {formatBytes(fs().bytes)}
							</span>
						</div>
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
	onOpenStored: (workspaceId: string, sessionId: string) => void;
	tabStop: boolean;
}) {
	const s = () => props.session;
	// A fleet-store row's `file` is a display key only; opening it goes to
	// the STORED detail route (the /ctl/stored read surface), never to the
	// /ctl/stats detail.
	const isStore = () => s().origin === "fleet-store";
	const open = () => {
		if (isStore()) {
			const st = s().stored;
			if (st) {
				props.onOpenStored(st.workspaceId, st.sessionId);
				return;
			}
		}
		props.onOpen(s().file);
	};
	return (
		<button
			type="button"
			classList={{
				"session-row": true,
				selected: props.selected,
				missing: !s().onDisk && !isStore(),
			}}
			tabIndex={props.tabStop ? 0 : -1}
			aria-current={props.selected ? "true" : undefined}
			onClick={open}
			title={s().file}
		>
			<div class="row-top">
				<span class="row-title">{displayTitle(s().title) ?? basename(s().file)}</span>
				<span class="row-time">{timeAgo(s().lastTs ?? s().firstTs)}</span>
			</div>
			<div class="row-folder">{s().folder}</div>
			<Show when={s().firstPrompt}>{(p) => <div class="row-prompt">{p()}</div>}</Show>
			<Show
				when={s().synced || isStore()}
				fallback={<div class="row-metrics row-muted">Stats appear after a sync</div>}
			>
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
			</Show>
			<div class="row-tags">
				{/* Coverage labels (P8.6). */}
				<Show when={isStore()}>
					<span class="tag tag-store">fleet-stored</span>
					<Show when={s().stored?.readOnly}>
						<span class="tag tag-muted">view only</span>
					</Show>
				</Show>
				<Show when={s().origin === "fleet-local" && s().stored !== undefined}>
					<span class="tag tag-store-subtle">also in store</span>
				</Show>
				<Show when={s().errorTurns > 0}>
					<span class="tag tag-err">{s().errorTurns} err</span>
				</Show>
				<Show when={!s().synced && !isStore()}>
					<span class="tag tag-warn">not synced</span>
				</Show>
				<Show when={!s().onDisk && !isStore()}>
					<span class="tag tag-muted">missing</span>
				</Show>
			</div>
		</button>
	);
}
