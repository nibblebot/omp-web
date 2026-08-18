import { createEffect, createMemo, createSignal, Show, type JSX } from "solid-js";
import { fetchDaemonStderr, state } from "../../state";

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

	// The roster entry is the status source of truth — read it reactively so a
	// stop/wake broadcast flips the "historical tail" note without a refetch
	// (the daemonId is stable across roster broadcasts, unlike the entry
	// object; an asleep/errored daemon's tail is the capture from its last
	// run, not a live stream).
	const entry = createMemo(() => state.daemonRoster.find((d) => d.daemonId === props.daemonId));
	const dead = () => {
		const status = entry()?.status;
		return status === "asleep" || status === "error";
	};
	const note = () =>
		entry()?.status === "error"
			? "daemon errored — captured log from last run"
			: "daemon asleep — captured log from last run";

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
			<Show when={dead()}>
				<div class="daemon-stderr-note">{note()}</div>
			</Show>
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
