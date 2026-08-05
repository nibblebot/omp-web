import { createSignal, For, onMount, Show, type Component } from "solid-js";
import { attachSession, call, closeSession, createSession, listLiveSessions, listSessions, setState, state } from "../state";
import { Modal } from "./Modal";
import type { LiveSessionEntry, SessionListEntry } from "../protocol";

/**
 * `/resume` and the header button. Top section: live in-process sessions —
 * click to attach, × to close, "New session" to create. Below it, unchanged:
 * on-disk session files, click to switchSession.
 */
export const SessionPicker: Component<{ onClose: () => void }> = props => {
	const [filter, setFilter] = createSignal("");
	const [sessions, setSessions] = createSignal<SessionListEntry[]>([]);
	const [live, setLive] = createSignal<LiveSessionEntry[]>([]);
	const [error, setError] = createSignal<string | null>(null);

	onMount(() => {
		listSessions()
			.then(setSessions)
			.catch(err => setError(String(err)));
		listLiveSessions()
			.then(r => setLive(r.sessions))
			.catch(err => setError(String(err)));
	});

	const filtered = () => {
		const q = filter().toLowerCase();
		const list = sessions();
		return q ? list.filter(s => (s.name ?? s.id).toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q)) : list;
	};

	const close = () => {
		setState("modal", null);
		props.onClose();
	};

	const choose = (s: SessionListEntry) => {
		void call("switchSession", [s.path])
			.then(result => {
				if ((result as { cancelled?: boolean } | null)?.cancelled) {
					setError("Session switch cancelled by extension");
					return;
				}
				close();
			})
			.catch(err => setError(String(err)));
	};

	const attach = (s: LiveSessionEntry) => {
		if (s.sessionId === state.currentSessionId) {
			close();
			return;
		}
		void attachSession(s.sessionId)
			.then(close)
			.catch(err => setError(String(err)));
	};

	const newSession = () => {
		void createSession()
			.then(close)
			.catch(err => setError(String(err)));
	};

	const closeLive = (s: LiveSessionEntry, ev: MouseEvent) => {
		ev.stopPropagation();
		closeSession(s.sessionId);
		setLive(list => list.filter(x => x.sessionId !== s.sessionId));
	};

	return (
		<Modal title="Sessions" onClose={props.onClose}>
			<div class="picker-group-name picker-group-head">
				<span>Live sessions</span>
				<button onClick={newSession}>New session</button>
			</div>
			<div class="picker-list">
				<For each={live()}>
					{s => (
						<div class={`picker-row${s.sessionId === state.currentSessionId ? " active" : ""}`} onClick={() => attach(s)}>
							<span class="picker-label">{s.name ?? s.sessionId}</span>
							<span class="picker-detail">
								{s.cwd || "(no cwd)"} · {s.messageCount} msgs{s.isStreaming ? " · streaming" : ""}
							</span>
							<button class="picker-row-close" title="Close session" onClick={ev => closeLive(s, ev)}>
								×
							</button>
						</div>
					)}
				</For>
				{live().length === 0 && <div class="tool-collapsed-note">no live sessions</div>}
			</div>
			<div class="picker-group-name">Resume from disk</div>
			<input
				class="picker-filter"
				placeholder="Filter by name or cwd…"
				value={filter()}
				onInput={e => setFilter(e.currentTarget.value)}
			/>
			<Show when={error()}>{err => <div class="msg-notice">{err()}</div>}</Show>
			<div class="picker-list">
				<For each={filtered()}>
					{s => (
						<div class="picker-row" onClick={() => choose(s)}>
							<span class="picker-label">{s.name ?? s.id.slice(0, 8)}</span>
							<span class="picker-detail">
								{s.cwd || "(no cwd)"} · {s.messageCount} msgs · {new Date(s.modifiedAt).toLocaleString()}
							</span>
						</div>
					)}
				</For>
				{filtered().length === 0 && !error() && <div class="tool-collapsed-note">no sessions</div>}
			</div>
		</Modal>
	);
};
