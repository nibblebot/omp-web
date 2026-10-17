import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from "solid-js";
import { filterStderr } from "../../../fleet-ui/daemon-log";
import { fetchDaemonStderr, state } from "../../../state";

/** Refresh cadence while the log is open for a live session process. */
const LIVE_POLL_MS = 2000;
/** Scrolled-up distance (px) that still counts as following the newest line. */
const FOLLOW_SLACK_PX = 8;

/** Fetch/loading/error/tail lifecycle for a session process's captured stderr.
 *  Opens scrolled to the newest line and follows the tail; scrolling up pauses
 *  following ("jump to latest" resumes it). Live processes re-poll the tail
 *  silently; asleep/errored ones show their last-run capture and do not poll.
 *  "errors only" narrows the tail to triage lines; copy takes the visible text.
 *  Refetches when `daemonId` changes (the id is stable across roster broadcasts
 *  even though the entry object is replaced). */
export function DaemonLog(props: {
	daemonId: string;
	/** Header label; default "stderr". */
	label?: string;
	/** Text shown when the log tail is empty; default "(no stderr output yet)". */
	empty?: string;
}): JSX.Element {
	const [text, setText] = createSignal<string | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	const [loading, setLoading] = createSignal(false);
	const [errorsOnly, setErrorsOnly] = createSignal(false);
	const [following, setFollowing] = createSignal(true);
	const [preEl, setPreEl] = createSignal<HTMLPreElement>();

	// The roster entry is the status source of truth; read it reactively so a
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
			? "session process errored, captured log from last run"
			: "session process asleep, captured log from last run";

	const shown = createMemo(() => filterStderr(text() ?? "", errorsOnly()));

	const load = () => {
		setLoading(true);
		setError(null);
		setText(null);
		fetchDaemonStderr(props.daemonId)
			.then((data) => setText(data.text))
			.catch((err) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setLoading(false));
	};

	// Silent live refresh: keeps the visible tail while the new one loads.
	const poll = () => {
		if (dead() || loading()) return;
		fetchDaemonStderr(props.daemonId)
			.then((data) => setText(data.text))
			.catch(() => {});
	};

	// Reload only when the SHOWN daemon changes (daemonId is stable across
	// roster broadcasts, unlike the entry object itself).
	createEffect(() => {
		void props.daemonId;
		load();
	});

	const timer = setInterval(poll, LIVE_POLL_MS);
	onCleanup(() => clearInterval(timer));

	// Tail-follow: stick to the newest line while following. Any new text, a
	// filter change, or "jump to latest" re-runs this and scrolls to the bottom.
	createEffect(() => {
		shown();
		const el = preEl();
		if (following() && el) el.scrollTop = el.scrollHeight;
	});

	const onScroll = (e: Event) => {
		const el = e.currentTarget as HTMLPreElement;
		setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX);
	};

	const copyTail = async () => {
		try {
			await navigator.clipboard.writeText(shown());
		} catch {
			setError("copy failed: the browser denied clipboard access");
		}
	};

	return (
		<>
			<div class="daemon-stderr-head">
				<span class="daemon-detail-label">{props.label ?? "stderr"}</span>
				<button
					type="button"
					class="daemon-row-btn"
					aria-pressed={errorsOnly()}
					onClick={() => setErrorsOnly(!errorsOnly())}
				>
					errors only
				</button>
				<button
					type="button"
					class="daemon-row-btn"
					disabled={text() === null || shown() === ""}
					onClick={() => void copyTail()}
				>
					copy
				</button>
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
				<div class="daemon-stderr-wrap">
					<pre
						class="daemon-stderr"
						ref={setPreEl}
						tabindex="0"
						aria-label={`${props.label ?? "stderr"} tail`}
						onScroll={onScroll}
					>
						{shown() !== ""
							? shown()
							: text() === ""
								? (props.empty ?? "(no stderr output yet)")
								: "(no error or warning lines)"}
					</pre>
					<Show when={!following()}>
						<button
							type="button"
							class="daemon-row-btn daemon-stderr-jump"
							onClick={() => setFollowing(true)}
						>
							jump to latest ↓
						</button>
					</Show>
				</div>
			</Show>
			<Show when={error()}>
				{(err) => <div class="msg-notice daemon-stderr-error">{err()}</div>}
			</Show>
		</>
	);
}
