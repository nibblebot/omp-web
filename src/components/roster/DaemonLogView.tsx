import { createEffect, createSignal, Show, type JSX } from "solid-js";
import { fetchDaemonStderr } from "../../state";

/** Fetch/loading/error/tail/refresh lifecycle for a daemon's captured stderr,
 *  extracted verbatim from DaemonSidebar's DaemonDetail. Refetches when
 *  `daemonId` changes (the id is stable across roster broadcasts even though
 *  the daemon entry object is replaced); the header row carries a refresh
 *  button that is disabled while a fetch is in flight. */
export function DaemonLogView(props: {
	daemonId: string;
	/** Header label; default "stderr". */
	label?: string;
	/** Text shown when the log tail is empty; default "(no stderr output yet)". */
	empty?: string;
}): JSX.Element {
	const [text, setText] = createSignal<string | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	const [loading, setLoading] = createSignal(false);

	const load = () => {
		setLoading(true);
		setError(null);
		setText(null);
		fetchDaemonStderr(props.daemonId)
			.then((data) => setText(data.text))
			.catch((err) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
	};

	// Reload only when the SHOWN daemon changes (daemonId is stable across
	// roster broadcasts, unlike the entry object itself).
	createEffect(() => {
		void props.daemonId;
		load();
	});

	return (
		<>
			<div class="daemon-stderr-head">
				<span class="daemon-detail-label">{props.label ?? "stderr"}</span>
				<button
					type="button"
					class="daemon-row-btn"
					disabled={loading()}
					onClick={() => void load()}
				>
					{loading() ? "loading…" : "refresh"}
				</button>
			</div>
			<Show when={loading()}>
				<div class="daemon-stderr-empty">loading stderr…</div>
			</Show>
			<Show when={!loading() && text() !== null}>
				<pre class="daemon-stderr">
					{text() === "" ? (props.empty ?? "(no stderr output yet)") : text()}
				</pre>
			</Show>
			<Show when={error()}>
				{(err) => <div class="msg-notice daemon-stderr-error">{err()}</div>}
			</Show>
		</>
	);
}
