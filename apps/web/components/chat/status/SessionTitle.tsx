import { createSignal, Show, type Component } from "solid-js";
import { call, state } from "../../../state";
import { activeWorkspace } from "../../../fleet-ui/workspace-status";
import { reportError } from "../../../store/toasts";
import { displayTitle } from "../../ui/title-icons";

/** The session identity is the name (click to rename). Sits in the MainHeader
 *  title slot (Shell), shrinking with ellipsis; send configuration sits in
 *  SessionConfigBar by the composer. */
export const SessionTitle: Component = () => {
	const [editingName, setEditingName] = createSignal(false);
	// Enter commits and closes first, so the trailing blur is a harmless no-op.
	const commitName = (el: HTMLInputElement) => {
		const title = el.value.trim();
		setEditingName(false);
		if (title && title !== state.sessionName) {
			void call("setSessionName", [title]).catch(reportError);
		}
	};

	return (
		<div class="session-header">
			<Show
				when={activeWorkspace(state.daemonRoster, state.registeredProjects, state.currentSessionId)}
				keyed
			>
				{(w) => (
					<span class="session-crumbs" title={w.cwd}>
						<span class="session-crumb" title={w.project}>
							{w.project}
						</span>
						<span aria-hidden="true">/</span>
						<span class="session-crumb" title={w.workspace}>
							{w.workspace}
						</span>
						<span aria-hidden="true">/</span>
					</span>
				)}
			</Show>
			<Show
				when={editingName()}
				fallback={
					<h1
						class="segment segment-button session-name"
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
						{displayTitle(state.sessionName) ??
							(state.messageCount === 0 ? "New session" : "Untitled session")}
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
