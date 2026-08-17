import { Show, createEffect, createResource, createSignal, onCleanup } from "solid-js";
import { api, type Health } from "./api";
import { SessionDetail } from "./components/SessionDetail";
import { SessionList } from "./components/SessionList";
import { decodeFileFromHash, encodePathSegments } from "./util/format";

type Route = { view: "list" } | { view: "session"; file: string };

/** Parse `#/s/<encoded-file>` (segments individually encoded, `/` separators literal). */
function parseHash(): Route {
	const raw = window.location.hash.replace(/^#\/?/, "");
	if (raw === "" || raw === "/") return { view: "list" };
	const parts = raw.split("/");
	if (parts[0] !== "s") return { view: "list" };
	const encoded = parts.slice(1).join("/");
	if (encoded === "") return { view: "list" };
	const file = decodeFileFromHash(encoded);
	return file !== null ? { view: "session", file } : { view: "list" };
}

/**
 * Historical transcripts/stats browser, mounted as the "transcripts" top-level
 * view (src/App.tsx). Keeps its internal hash routing + syncTick pattern.
 */
export function TxBrowser() {
	const [route, setRoute] = createSignal<Route>(parseHash());

	createEffect(() => {
		const onChange = () => setRoute(parseHash());
		window.addEventListener("hashchange", onChange);
		onCleanup(() => window.removeEventListener("hashchange", onChange));
	});

	/** Bumped after a successful stats sync; keyed resources refetch on change. */
	const [syncTick, setSyncTick] = createSignal(0);
	const bumpSync = () => setSyncTick((t) => t + 1);

	const [health] = createResource(
		() => syncTick(),
		() => api.health(),
	);
	/** An errored Solid resource throws when read — check .error first. */
	const healthSafe = () => (health.error ? undefined : health());

	const file = () => {
		const r = route();
		return r.view === "session" ? r.file : null;
	};

	const navigate = (f: string) => {
		window.location.hash = `#/s/${encodePathSegments(f)}`;
	};

	return (
		<div class="tx-app">
			<aside class="tx-sidebar">
				<SessionList
					selectedFile={file()}
					onOpen={navigate}
					health={healthSafe}
					syncTick={syncTick}
					onSynced={bumpSync}
				/>
			</aside>
			<main class="tx-main">
				<HealthBanner health={healthSafe} onSynced={bumpSync} />
				<Show when={file()} keyed>
					{(f) => <SessionDetail file={f} syncTick={syncTick} onSynced={bumpSync} />}
				</Show>
				<Show when={!file()}>
					<div class="tx-empty-state">
						<h2>Session Viewer</h2>
						<p>Browse every omp agent session: analytics, transcripts, and subagents.</p>
						<p class="muted">Select a session from the sidebar to begin.</p>
					</div>
				</Show>
			</main>
		</div>
	);
}

function HealthBanner(props: { health: () => Health | undefined; onSynced: () => void }) {
	const [syncing, setSyncing] = createSignal(false);
	const [syncError, setSyncError] = createSignal<string | null>(null);

	const runSync = async () => {
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

	return (
		<Show when={props.health()} fallback={null}>
			{(h) =>
				h().statsDb !== "ok" ? (
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
								stats.db not found — run <code>omp stats</code> once to build the index
							</span>
						</Show>
						<button
							type="button"
							class="btn btn-small"
							disabled={syncing()}
							onClick={() => void runSync()}
						>
							{syncing() ? "Syncing…" : "Sync now"}
						</button>
						<Show when={syncError()}>
							{(e) => (
								<span class="banner-error" role="alert">
									Sync failed: {e()}
								</span>
							)}
						</Show>
					</div>
				) : null
			}
		</Show>
	);
}
