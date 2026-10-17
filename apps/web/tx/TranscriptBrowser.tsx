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
import { decodeFileFromHash, formatBytes } from "./util/format";
type Route =
	| { view: "list" }
	| { view: "session"; file: string }
	| { view: "stored"; workspaceId: string; sessionId: string };

/** Debounce for stats auto-sync: coalesces bursts of turn ends and session opens. */
const AUTO_SYNC_DEBOUNCE_MS = 1_500;

/** Decode a single individually-encoded path segment; null on malformed input. */
function decodeSegment(encoded: string): string | null {
	try {
		return decodeURIComponent(encoded);
	} catch {
		return null;
	}
}

/** Parse `#/s/<encoded-file>` (segments individually encoded, `/` separators literal). */
function parseHash(): Route {
	const raw = window.location.hash.replace(/^#\/?/, "");
	if (raw === "" || raw === "/") return { view: "list" };
	const parts = raw.split("/");
	if (parts[0] === "s") {
		const encoded = parts.slice(1).join("/");
		if (encoded === "") return { view: "list" };
		const file = decodeFileFromHash(encoded);
		return file !== null ? { view: "session", file } : { view: "list" };
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

	const navigateStored = (workspaceId: string, sessionId: string) => {
		window.location.hash = `#/stored/${encodePathSegments(workspaceId)}/${encodePathSegments(
			sessionId,
		)}`;
	};

	// Missing-file fallback (TranscriptList observes the loaded sessions):
	// clearing the hash fires hashchange, the route becomes the list, and
	// nothing stays selected.
	const handleMissingFile = () => {
		if (window.location.hash !== "") window.location.hash = "";
	};

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
					<Show when={file()} keyed>
						{(f) => <TranscriptDetail file={f} syncTick={syncTick} />}
					</Show>
					<Show when={!file() && !storedRoute()}>
						<div class="tx-empty-state">
							<h2>Transcripts</h2>
							<p>Browse every omp agent session: analytics, transcripts, and subagents.</p>
							<p class="muted">Select a session from the sidebar to begin.</p>
						</div>
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
