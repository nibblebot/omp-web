import { createSignal, For, onMount, Show, type Component } from "solid-js";
import { call, listSessions, setState } from "../state";
import { Modal } from "./Modal";
import { PickerRow } from "./PickerRow";
import type { SessionListEntry } from "../../shared/protocol";

/**
 * `/resume` and the header button: on-disk session files, click to
 * switchSession. (The mux live-session roster is gone — a standalone
 * omp-session has one live session, and the fleet edge's session list lives
 * in the DaemonSidebar.)
 */
export const SessionPicker: Component<{ onClose: () => void }> = props => {
	const [filter, setFilter] = createSignal("");
	const [sessions, setSessions] = createSignal<SessionListEntry[]>([]);
	const [error, setError] = createSignal<string | null>(null);

	onMount(() => {
		listSessions()
			.then(setSessions)
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

	return (
		<Modal title="History" onClose={props.onClose}>
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
						<PickerRow class="picker-row" onClick={() => choose(s)}>
							<span class="picker-label">{s.name ?? s.id.slice(0, 8)}</span>
							<span class="picker-detail">
								{s.cwd || "(no cwd)"} · {s.messageCount} msgs · {new Date(s.modifiedAt).toLocaleString()}
							</span>
						</PickerRow>
					)}
				</For>
				{filtered().length === 0 && !error() && <div class="tool-collapsed-note">no sessions</div>}
			</div>
		</Modal>
	);
};
