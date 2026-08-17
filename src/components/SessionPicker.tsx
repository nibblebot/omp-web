import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { call, listSessions, setState, state } from "../state";
import { Modal } from "./Modal";
import { PickerRow } from "./PickerRow";
import type { SessionListEntry } from "../../shared/protocol";

/**
 * Session picker: on-disk session files, click to switchSession.
 *
 * Two paths share this surface:
 * - `/resume` (gate null): plain history list, unchanged behavior.
 * - Onboarding gate (state.sessionPickerGate set): opened by state.ts after
 *   an add-repo/add-worktree attach settles with sessions on disk. The list
 *   renders most-recent-first with the newest session pre-highlighted and a
 *   "New session" top item; Esc selects "New session" (intercepted before
 *   the Modal's Esc-to-close, which still works outside gate mode).
 * The asleep-row wake path never opens this picker (silent --resume).
 */
export const SessionPicker: Component<{ onClose: () => void }> = (props) => {
	const [filter, setFilter] = createSignal("");
	const [sessions, setSessions] = createSignal<SessionListEntry[]>([]);
	const [error, setError] = createSignal<string | null>(null);

	const gate = () => state.sessionPickerGate;
	const gateMode = () => gate() !== null;

	// Gate-mode Esc = "New session". Registered in onMount — BEFORE the
	// Modal's own capture-phase Esc handler (child onMounts run after the
	// parent's) — so stopImmediatePropagation reliably swallows it. Outside
	// gate mode Esc closes via the Modal as usual.
	const onKeyDown = (e: KeyboardEvent) => {
		if (gateMode() && e.key === "Escape") {
			e.stopImmediatePropagation();
			e.preventDefault();
			startNewSession();
		}
	};

	onMount(() => {
		document.addEventListener("keydown", onKeyDown, true);
		onCleanup(() => document.removeEventListener("keydown", onKeyDown, true));
		listSessions()
			.then(setSessions)
			.catch((err) => setError(String(err)));
	});

	const filtered = () => {
		const q = filter().toLowerCase();
		const list = gateMode()
			? [...sessions()].sort((a, b) => b.modifiedAt - a.modifiedAt)
			: sessions();
		return q
			? list.filter(
					(s) => (s.name ?? s.id).toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q),
				)
			: list;
	};

	const close = () => {
		if (gateMode()) setState("sessionPickerGate", null);
		setState("modal", null);
		props.onClose();
	};

	const choose = (s: SessionListEntry) => {
		void call("switchSession", [s.path])
			.then((result) => {
				if ((result as { cancelled?: boolean } | null)?.cancelled) {
					setError("Session switch cancelled by extension");
					return;
				}
				close();
			})
			.catch((err) => setError(String(err)));
	};

	/** Gate-mode Esc/row action: start a fresh session on the attached daemon. */
	const startNewSession = () => {
		setState("sessionPickerGate", null);
		void call("newSession").catch((err) => setError(String(err)));
		close();
	};

	return (
		<Modal title="History" onClose={close}>
			<div class="picker-group-name">
				{gateMode() ? "New session or resume" : "Resume from disk"}
			</div>
			<input
				class="picker-filter"
				aria-label="Filter sessions"
				placeholder="Filter by name or cwd…"
				value={filter()}
				onInput={(e) => setFilter(e.currentTarget.value)}
			/>
			<Show when={error()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
			<div class="picker-list">
				<Show when={gateMode()}>
					<PickerRow
						class="picker-row session-new"
						onClick={startNewSession}
						title="Start a fresh session (no history)"
					>
						<span class="picker-label session-new-label">New session</span>
						<span class="picker-detail">start fresh — no history</span>
					</PickerRow>
				</Show>
				<For each={filtered()}>
					{(s, i) => (
						<PickerRow
							class="picker-row"
							classList={{ active: gateMode() && i() === 0 }}
							onClick={() => choose(s)}
						>
							<span class="picker-label">{s.name ?? s.id.slice(0, 8)}</span>
							<span class="picker-detail">
								{s.cwd || "(no cwd)"} · {s.messageCount} msgs ·{" "}
								{new Date(s.modifiedAt).toLocaleString()}
							</span>
						</PickerRow>
					)}
				</For>
				{filtered().length === 0 && !error() && <div class="tool-collapsed-note">no sessions</div>}
			</div>
		</Modal>
	);
};
