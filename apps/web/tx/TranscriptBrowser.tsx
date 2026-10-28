import {
	Show,
	createEffect,
	createMemo,
	createResource,
	createSignal,
	on,
	onCleanup,
} from "solid-js";
import { api, ApiError, type Health } from "../store/fleet-api";
import { MainHeader } from "../components/app/MainHeader";
import { SidebarHeader } from "../components/app/SidebarHeader";
import { closeDrawers, setTxSidebarVisible, state } from "../state";
import { TranscriptDetail } from "./components/TranscriptDetail";
import { TranscriptList } from "./components/TranscriptList";
import { StoredSessionList } from "./components/StoredSessionList";
import { StoredSessionPage } from "./components/StoredSessionPage";
import { SpendPanel } from "./components/SpendPanel";
import { formatBytes } from "./util/format";
import { parseTxHash, storedHash, type TxRoute } from "./util/route";
import { sessionHash } from "../store/slices/analysis";

/** Debounce for stats auto-sync: coalesces bursts of turn ends and session opens. */
const AUTO_SYNC_DEBOUNCE_MS = 1_500;

/** Live tail: while a turn streams, the open transcript refetches on this cadence. */
const LIVE_TAIL_INTERVAL_MS = 4_000;

/**
 * Historical transcripts/stats browser, mounted as the "transcripts" top-level
 * view (src/App.tsx). Keeps its internal hash routing + syncTick pattern.
 *
 * App keeps the view mounted while Chat shows, so everything that polls or
 * syncs (stats auto-sync, the live tail) runs only while Analysis is the visible
 * view of a visible tab. Work that falls due meanwhile is remembered and runs
 * once on return.
 */
export function TranscriptBrowser() {
	const [route, setRoute] = createSignal<TxRoute>(parseTxHash(window.location.hash));

	createEffect(() => {
		const onChange = () => setRoute(parseTxHash(window.location.hash));
		window.addEventListener("hashchange", onChange);
		onCleanup(() => window.removeEventListener("hashchange", onChange));
	});
	// Opening a transcript changes the detail pane: a drawer sidebar closes.
	createEffect(on(route, () => closeDrawers(), { defer: true }));

	/** Analysis is on screen: it is the current view and the browser tab is visible. */
	const [tabVisible, setTabVisible] = createSignal(document.visibilityState !== "hidden");
	createEffect(() => {
		const onVisibility = () => setTabVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", onVisibility);
		onCleanup(() => document.removeEventListener("visibilitychange", onVisibility));
	});
	const active = createMemo(() => state.view === "analysis" && tabVisible());
	/** Work that fell due while inactive; one catch-up runs on return. */
	let missedSync = false;
	let missedTail = false;

	/** Bumped after a successful stats sync; keyed resources refetch on change. */
	const [syncTick, setSyncTick] = createSignal(0);
	const bumpSync = () => setSyncTick((t) => t + 1);

	const [health] = createResource(
		() => syncTick(),
		() => api.health(),
	);
	/** An errored Solid resource throws when read; check .error first. */
	const healthSafe = () => (health.error ? undefined : health());

	const storedRoute = () => {
		const r = route();
		return r.view === "stored" ? r : null;
	};
	const file = () => {
		const r = route();
		return r.view === "session" ? r.file : null;
	};
	const sub = () => {
		const r = route();
		return r.view === "session" ? r.sub : null;
	};
	/** Stats auto-sync: opening a session or the overview, or ending a turn, refreshes stats.db (debounced). */
	let autoSyncTimer: number | undefined;
	const scheduleAutoSync = () => {
		if (!active()) {
			missedSync = true;
			return;
		}
		clearTimeout(autoSyncTimer);
		autoSyncTimer = window.setTimeout(() => {
			api.sync().then(bumpSync, (e: unknown) => {
				// 409: a sync already runs on the server and its completion refreshes the views.
				if (!(e instanceof ApiError && e.status === 409)) console.warn("stats auto-sync failed", e);
			});
		}, AUTO_SYNC_DEBOUNCE_MS);
	};
	onCleanup(() => clearTimeout(autoSyncTimer));
	// Opening a session or the spend overview (including on load) and a turn ending both refresh stats.db.
	createEffect(
		on(file, () => {
			scheduleAutoSync();
		}),
	);
	createEffect(
		on(
			() => state.streaming,
			(now, prev) => {
				if (prev === true && now === false) scheduleAutoSync();
			},
			{ defer: true },
		),
	);

	const navigate = (f: string) => {
		window.location.hash = sessionHash(f, null);
	};

	/** Open a subagent transcript inside the current session route (null returns to main). */
	const navigateSub = (sf: string | null) => {
		const f = file();
		if (f === null) return;
		window.location.hash = sessionHash(f, sf);
	};

	const navigateStored = (workspaceId: string, sessionId: string) => {
		window.location.hash = storedHash(workspaceId, sessionId);
	};

	// Deep-linked file that is gone from disk: say so instead of silently listing.
	const [missingFile, setMissingFile] = createSignal<string | null>(null);
	const shownFile = () => {
		const f = file();
		return f !== null && f !== missingFile() ? f : null;
	};
	const backToSpend = () => {
		setMissingFile(null);
		if (window.location.hash !== "") window.location.hash = "";
	};
	const handleMissingFile = (f: string) => setMissingFile(f);

	/** Bumped every few seconds while a turn streams so the open transcript tails. */
	const [liveTick, setLiveTick] = createSignal(0);
	createEffect(() => {
		if (!state.streaming) return;
		if (!active()) {
			missedTail = true;
			return;
		}
		const id = window.setInterval(() => setLiveTick((t) => t + 1), LIVE_TAIL_INTERVAL_MS);
		onCleanup(() => clearInterval(id));
	});

	createEffect(
		on(
			active,
			(now) => {
				if (!now) return;
				if (missedSync) {
					missedSync = false;
					scheduleAutoSync();
				}
				if (missedTail) {
					missedTail = false;
					setLiveTick((t) => t + 1);
				}
			},
			{ defer: true },
		),
	);

	return (
		<div class="tx-app">
			{/* Closed = inert: the clipped/hidden sidebar leaves tab order and the a11y tree. It stays mounted so its lists keep their state. */}
			<aside
				class="tx-sidebar"
				classList={{ open: state.txSidebarVisible }}
				inert={!state.txSidebarVisible}
			>
				{/* Fixed-width panel (fleet.css .sidebar-panel): the docked column's width animates, the content does not reflow. */}
				<div class="sidebar-panel">
					<SidebarHeader onCollapse={() => setTxSidebarVisible(false)} />
					<TranscriptList
						selectedFile={file()}
						onOpen={navigate}
						onOpenStored={navigateStored}
						onMissingFile={handleMissingFile}
						health={healthSafe}
						syncTick={syncTick}
						onSynced={bumpSync}
					/>
					{/* Fleet log-store browsing sits beneath the local
					    transcript list in the same scroll surface. */}
					<StoredSessionList
						selectedWorkspaceId={storedRoute()?.workspaceId ?? null}
						selectedSessionId={storedRoute()?.sessionId ?? null}
						onOpenSession={navigateStored}
						syncTick={syncTick}
					/>
				</div>
			</aside>
			{/* Below 1024px the sidebar is a drawer: tapping outside the
			    slide-out closes it. Same .sidebar-scrim pattern as the roster
			    (FleetSidebar); CSS shows it only below 1024px. */}
			<Show when={state.txSidebarVisible}>
				<button
					type="button"
					class="sidebar-scrim"
					tabindex={-1}
					onClick={() => setTxSidebarVisible(false)}
					aria-label="Close sidebar"
				/>
			</Show>
			<div class="main-pane">
				<MainHeader />
				<main class="tx-main">
					<HealthBanner health={healthSafe} />
					<Show when={storedRoute()} keyed>
						{(r) => <StoredSessionPage workspaceId={r.workspaceId} sessionId={r.sessionId} />}
					</Show>
					<Show when={missingFile() !== null && missingFile() === file()}>
						<div class="tx-empty-state">
							<h2>Session not found</h2>
							<p>
								This session file is no longer on disk: <code>{file()}</code>
							</p>
							<p>
								<button type="button" class="btn" onClick={backToSpend}>
									Back to spend overview
								</button>
							</p>
						</div>
					</Show>
					<Show when={shownFile()} keyed>
						{(f) => (
							<TranscriptDetail
								file={f}
								syncTick={syncTick}
								liveTick={liveTick}
								sub={sub()}
								onSub={navigateSub}
							/>
						)}
					</Show>
					<Show when={file() === null && !storedRoute()}>
						<SpendPanel health={healthSafe} syncTick={syncTick} />
					</Show>
				</main>
			</div>
		</div>
	);
}

function HealthBanner(props: { health: () => Health | undefined }) {
	return (
		<Show when={props.health()} fallback={null}>
			{(h) => {
				const fleetStore = () => {
					const hh = h();
					return hh.fleetStore !== undefined && hh.statsDb === "ok" ? hh.fleetStore : undefined;
				};
				return (
					<>
						<Show when={fleetStore()} keyed>
							{(fs) => (
								<div class="health-banner store-line">
									<span class="banner-msg">
										fleet store: {fs.workspaces} {fs.workspaces === 1 ? "workspace" : "workspaces"}{" "}
										· {fs.sessions} {fs.sessions === 1 ? "session" : "sessions"} ·{" "}
										{formatBytes(fs.bytes)}
									</span>
								</div>
							)}
						</Show>
						<Show when={h().statsDb !== "ok"} fallback={null}>
							<div
								classList={{
									"health-banner": true,
									warn: h().statsDb === "missing",
									error: h().statsDb === "error",
								}}
							>
								<Show
									when={h().statsDb === "missing"}
									fallback={
										<span class="banner-msg">
											stats.db could not be opened at <code>{h().statsDbPath}</code>
										</span>
									}
								>
									<span class="banner-msg">
										stats.db not found, run <code>omp stats</code> once to build the index
									</span>
								</Show>
							</div>
						</Show>
					</>
				);
			}}
		</Show>
	);
}
