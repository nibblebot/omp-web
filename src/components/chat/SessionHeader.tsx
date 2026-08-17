import { createSignal, Show, type Component } from "solid-js";
import { call, setState, state } from "../../state";

/** Session identity — the name (click to rename) pinned to the left edge
 *  directly above the session stream. Chrome and live state stay in
 *  StatusBar; send configuration sits in SessionBar by the composer. */
export const SessionHeader: Component = () => {
	const [editingName, setEditingName] = createSignal(false);
	// Enter commits and closes first, so the trailing blur is a harmless no-op.
	const commitName = (el: HTMLInputElement) => {
		const title = el.value.trim();
		setEditingName(false);
		if (title && title !== state.sessionName) {
			void call("setSessionName", [title]).catch((err) => setState("error", String(err)));
		}
	};

	return (
		<div class="session-header">
			<Show
				when={editingName()}
				fallback={
					<h1
						class="segment segment-button session-name"
						style={{ margin: "0" }}
						title="Rename session"
						tabindex="0"
						onClick={() => setEditingName(true)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								setEditingName(true);
							}
						}}
					>
						{state.sessionName ?? state.sessionId.slice(0, 8)}
					</h1>
				}
			>
				<input
					ref={(el) =>
						queueMicrotask(() => {
							el.focus();
							el.select();
						})
					}
					class="segment session-name-input"
					aria-label="Session name"
					value={state.sessionName ?? ""}
					onKeyDown={(e) => {
						if (e.key === "Enter") commitName(e.currentTarget);
						else if (e.key === "Escape") setEditingName(false);
					}}
					onBlur={() => setEditingName(false)}
				/>
			</Show>
		</div>
	);
};
