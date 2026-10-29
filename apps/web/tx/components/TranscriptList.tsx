import {
	For,
	Show,
	createComputed,
	createEffect,
	createMemo,
	createResource,
	createSignal,
	on,
	onCleanup,
	onMount,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { api, ApiError, type Health, type SessionSummary } from "../../store/fleet-api";
import { basename, formatBytes, formatCompact, formatCost, timeAgo } from "../util/format";
import { shouldFallbackMissingFile } from "../util/missing-file";
import { groupSessionsByProject } from "../util/project-groups";
import { groupSpans } from "../util/session-window";
import { displayTitle } from "../../components/ui/title-icons";
import { moveRovingFocus } from "../../components/ui/roving";

interface TranscriptListProps {
	selectedFile: string | null;
	onOpen: (file: string) => void;
	/** Open a fleet-store-origin row in the stored detail route. */
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
	// Every response carries fresh objects, so it is reconciled into a store by
	// `file`: a session that is still listed keeps its object (and its row), and
	// only the fields that changed notify.
	const [sessionStore, setSessionStore] = createStore<{ list: SessionSummary[] }>({ list: [] });
	createComputed(() => {
		const latest = sessionsRes.latest;
		if (latest !== undefined) setSessionStore("list", reconcile(latest.sessions, { key: "file" }));
	});
	const sessions = () => sessionStore.list;

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
	/** Group keys; a re-grouped list with the same groups keeps their DOM. */
	const groupKeys = createMemo(() => visibleGroups().map((g) => g.key), [], {
		equals: (a, b) => a.length === b.length && a.every((k, i) => k === b[i]),
	});
	const groupByKey = createMemo(() => new Map(visibleGroups().map((g) => [g.key, g] as const)));

	// Windowing: rows have a fixed height (tx.css), so only the rows near the viewport mount.
	let listEl: HTMLDivElement | undefined;
	const [scrollTop, setScrollTop] = createSignal(0);
	const [viewportHeight, setViewportHeight] = createSignal(600);
	const [rowPitch, setRowPitch] = createSignal(144);
	const [headHeight, setHeadHeight] = createSignal(32);
	const readSize = () => {
		if (!listEl) return;
		setViewportHeight(listEl.clientHeight);
		const style = getComputedStyle(listEl);
		const row = Number.parseFloat(style.getPropertyValue("--tx-session-row-h"));
		const head = Number.parseFloat(style.getPropertyValue("--tx-session-head-h"));
		if (row > 0) setRowPitch(row);
		if (head > 0) setHeadHeight(head);
	};
	onMount(() => {
		readSize();
		if (typeof ResizeObserver !== "function" || !listEl) return;
		const ro = new ResizeObserver(readSize);
		ro.observe(listEl);
		onCleanup(() => ro.disconnect());
	});
	const spans = createMemo(() => {
		const groups = visibleGroups();
		const laid = groupSpans(
			groups.map((g) => g.sessions.length),
			scrollTop(),
			viewportHeight(),
			rowPitch(),
			headHeight(),
		);
		return new Map(groups.map((g, i) => [g.key, laid[i]!] as const));
	});
	/** Where each listed session sits, to tell whether it is currently mounted. */
	const locate = createMemo(() => {
		const at = new Map<string, { key: string; index: number }>();
		for (const g of visibleGroups())
			g.sessions.forEach((s, index) => at.set(s.file, { key: g.key, index }));
		return at;
	});
	/** The one row reachable with Tab: the selected session while mounted, else the first mounted one. */
	const tabStopFile = createMemo(() => {
		const sel = props.selectedFile;
		const at = sel === null ? undefined : locate().get(sel);
		const span = at === undefined ? undefined : spans().get(at.key);
		if (sel !== null && span !== undefined && at!.index >= span.start && at!.index < span.end)
			return sel;
		for (const g of visibleGroups()) {
			const s = spans().get(g.key);
			if (s !== undefined && s.end > s.start) return g.sessions[s.start]?.file ?? null;
		}
		return null;
	});

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

	/**
	 * Arrow keys move focus between session rows; only the tab-stop row is in the Tab order. Only
	 * the rows near the viewport are mounted, so Home/End first move the window to the list's
	 * ends and then focus the first/last mounted row. The list itself takes focus when the
	 * focused row scrolls out of the window (see `onListScroll`); a key there acts like no row
	 * being focused.
	 */
	const onRowKeys = (e: KeyboardEvent) => {
		const list = e.currentTarget as HTMLElement;
		if (e.key === "Home" || e.key === "End") {
			const onRow = (e.target as HTMLElement).classList.contains("session-row");
			if (!onRow && e.target !== list) return;
			list.scrollTop = e.key === "Home" ? 0 : list.scrollHeight;
			setScrollTop(list.scrollTop);
		}
		const items = Array.from(list.querySelectorAll<HTMLElement>(".session-row"));
		const current = items.indexOf(e.target as HTMLElement);
		if (current === -1 && e.target !== list) return;
		moveRovingFocus(e, items, current, "vertical");
	};
	/** Scrolling moves the window; a focused row that leaves it unmounts, so keep focus in the list. */
	const onListScroll = (e: Event & { currentTarget: HTMLDivElement }) => {
		const list = e.currentTarget;
		const hadFocus = list.contains(document.activeElement);
		setScrollTop(list.scrollTop);
		if (hadFocus && !list.contains(document.activeElement)) list.focus({ preventScroll: true });
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

			<div
				class="session-list"
				ref={listEl}
				tabIndex={-1}
				onKeyDown={onRowKeys}
				onScroll={onListScroll}
			>
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
									<For each={groupKeys()}>
										{(key) => {
											const group = () => groupByKey().get(key);
											const range = createMemo(
												() => {
													const s = spans().get(key);
													return { start: s?.start ?? 0, end: s?.end ?? 0 };
												},
												undefined,
												{ equals: (a, b) => a.start === b.start && a.end === b.end },
											);
											const count = () => group()?.sessions.length ?? 0;
											const mounted = createMemo(
												() => group()?.sessions.slice(range().start, range().end) ?? [],
											);
											return (
												<div class="session-group">
													{/* Per-group sticky header: sticks while this group
													    scrolls, releases at its own bottom edge. Rendered
													    even for a single group (uniform look). */}
													<div class="session-group-head">{group()?.label}</div>
													{/* Rows outside the window are spacers of the same total height. */}
													<div
														style={{
															"padding-top": `${range().start * rowPitch()}px`,
															"padding-bottom": `${(count() - range().end) * rowPitch()}px`,
														}}
													>
														<For each={mounted()}>
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
												</div>
											);
										}}
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
				"session-row-fixed": true,
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
				{/* Coverage labels. */}
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
