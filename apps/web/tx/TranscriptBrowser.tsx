import { Show, createEffect, createResource, createSignal, on, onCleanup } from "solid-js";
import { api, ApiError, encodePathSegments, type Health } from "../store/fleet-api";
import { MainHeader } from "../components/app/MainHeader";
import { SidebarHeader } from "../components/app/SidebarHeader";
import { closeDrawers, setTxSidebarVisible, state } from "../state";
import { TranscriptDetail } from "./components/TranscriptDetail";
import { TranscriptList } from "./components/TranscriptList";
import { StoredSessionList } from "./components/StoredSessionList";
import { StoredSessionPage } from "./components/StoredSessionPage";
import { ResumeCloneDialog } from "./components/ResumeCloneDialog";
import { SpendPanel } from "./components/SpendPanel";
import { decodeFileFromHash, formatBytes } from "./util/format";
type Route =
	| { view: "list" }
	| { view: "session"; file: string; sub: string | null }
	| { view: "stored"; workspaceId: string; sessionId: string };

/** Debounce for stats auto-sync: coalesces bursts of turn ends and session opens. */
const AUTO_SYNC_DEBOUNCE_MS = 1_500;

/** Live tail: while a turn streams, the open transcript refetches on this cadence. */
const LIVE_TAIL_INTERVAL_MS = 4_000;

/** Decode a single individually-encoded path segment; null on malformed input. */
function decodeSegment(encoded: string): string | null {
	try {
		return decodeURIComponent(encoded);
	} catch {
		return null;
	}
}

/** Parse `#/s/<encoded-file>[?sub=<encoded-subagent-file>]`; segments individually encoded. */
function parseHash(): Route {
	const hash = window.location.hash.replace(/^#\/?/, "");
	const qAt = hash.indexOf("?");
	const raw = qAt === -1 ? hash : hash.slice(0, qAt);
	if (raw === "" || raw === "/") return { view: "list" };
	const parts = raw.split("/");
	if (parts[0] === "s") {
		const encoded = parts.slice(1).join("/");
		if (encoded === "") return { view: "list" };
		const file = decodeFileFromHash(encoded);
		if (file === null) return { view: "list" };
		const sub = qAt === -1 ? null : new URLSearchParams(hash.slice(qAt + 1)).get("sub");
		return { view: "session", file, sub: sub || null };
	}
	// #/stored/<workspaceId>/<sessionId>, each exactly one safe segment.
	if (parts[0] === "stored") {
		if (parts.length !== 3) return { view: "list" };
		const wsEncoded = parts[1];
		const sidEncoded = parts[2];
		if (wsEncoded === "" || sidEncoded === "") return { view: "list" };
		const workspaceId = decodeSegment(wsEncoded);
		const sessionId = decodeSegment(sidEncoded);
		if (workspaceId === null || sessionId === null) return { view: "list" };
		return { view: "stored", workspaceId, sessionId };
	}
	return { view: "list" };
}

/**
 * Historical transcripts/stats browser, mounted as the "transcripts" top-level
 * view (src/App.tsx). Keeps its internal hash routing + syncTick pattern.
 */
export function TranscriptBrowser() {
	const [route, setRoute] = createSignal<Route>(parseHash());

	createEffect(() => {
		const onChange = () => setRoute(parseHash());
		window.addEventListener("hashchange", onChange);
		onCleanup(() => window.removeEventListener("hashchange", onChange));
	});
	// Opening a transcript changes the detail pane: a drawer sidebar closes.
	createEffect(on(route, () => closeDrawers(), { defer: true }));

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
	/** Stats auto-sync: opening a session or ending a turn refreshes stats.db (debounced). */
	let autoSyncTimer: number | undefined;
	const scheduleAutoSync = () => {
		clearTimeout(autoSyncTimer);
		autoSyncTimer = window.setTimeout(() => {
			api.sync().then(bumpSync, (e: unknown) => {
				// 409: a sync already runs on the server and its completion refreshes the views.
				if (!(e instanceof ApiError && e.status === 409)) console.warn("stats auto-sync failed", e);
			});
		}, AUTO_SYNC_DEBOUNCE_MS);
	};
	onCleanup(() => clearTimeout(autoSyncTimer));
	// Opening a session (including a deep link on load) and a turn ending both refresh stats.db.
	createEffect(
		on(file, (f) => {
			if (f !== null) scheduleAutoSync();
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
		window.location.hash = `#/s/${encodePathSegments(f)}`;
	};

	/** Open a subagent transcript inside the current session route (null returns to main). */
	const navigateSub = (sf: string | null) => {
		const f = file();
		if (f === null) return;
		const base = `#/s/${encodePathSegments(f)}`;
		window.location.hash = sf === null ? base : `${base}?sub=${encodeURIComponent(sf)}`;
	};

	const navigateStored = (workspaceId: string, sessionId: string) => {
		window.location.hash = `#/stored/${encodePathSegments(workspaceId)}/${encodePathSegments(
			sessionId,
		)}`;
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
		const id = window.setInterval(() => setLiveTick((t) => t + 1), LIVE_TAIL_INTERVAL_MS);
		onCleanup(() => clearInterval(id));
	});

	return (
		<div class="tx-app">
			<aside class="tx-sidebar" classList={{ open: state.txSidebarVisible }}>
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
				{/* Fleet log-store browsing (P8.5) sits beneath the local
				    transcript list in the same scroll surface. */}
				<StoredSessionList
					selectedWorkspaceId={storedRoute()?.workspaceId ?? null}
					selectedSessionId={storedRoute()?.sessionId ?? null}
					onOpenSession={navigateStored}
					syncTick={syncTick}
				/>
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
			<ResumeCloneDialog />
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
