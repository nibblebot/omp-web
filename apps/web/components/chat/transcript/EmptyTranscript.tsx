import {
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	Show,
	type Component,
} from "solid-js";
import type { SessionListEntry } from "#lib/wire/protocol";
import { requestDaemonSessions, resumeDaemonSession, state } from "../../../state";
import { openResumePicker } from "../../../store/resume";
import { sessionRowFromListEntry } from "../../../store/session-list";
import { reportError } from "../../../store/toasts";
import { SessionPickerRow } from "../../sessions/SessionPickerRow";
import { PackageIcon, WorktreeIcon } from "../../ui/icons";

/** Most recent sessions listed under "Recent in this workspace". */
const RECENT_LIMIT = 5;

/**
 * Empty-transcript orientation for a loaded session with no messages: where
 * you are (project, branch, model), how to drive the composer, and the last
 * sessions in this workspace to jump back into. The recent list stays hidden
 * until it has rows, so nothing flashes while it loads.
 */
export const EmptyTranscript: Component = () => {
	const daemon = createMemo(() =>
		state.daemonRoster.find((d) => d.daemonId === state.currentSessionId),
	);

	// The default fleet page (10) leaves headroom for the current session and
	// empty ones filtered out below. A superseded request resolves empty, which
	// hides the list.
	const [sessions, setSessions] = createSignal<SessionListEntry[]>([]);
	createEffect(
		on(
			() => state.currentSessionId,
			(daemonId) => {
				setSessions([]);
				if (daemonId === "") return;
				let stale = false;
				onCleanup(() => {
					stale = true;
				});
				requestDaemonSessions(daemonId).then(
					(list) => {
						if (stale) return;
						setNowMs(Date.now());
						setSessions(list);
					},
					() => {},
				);
			},
		),
	);
	const recent = createMemo(() =>
		sessions()
			.filter((s) => s.path !== state.sessionFile && s.messageCount > 0)
			.slice(0, RECENT_LIMIT)
			.map((s) => sessionRowFromListEntry(s, state.sessionFile)),
	);
	// Ages are relative to when the list landed; the empty screen is short-lived.
	const [nowMs, setNowMs] = createSignal(Date.now());

	return (
		<div class="chat-transcript-empty">
			<div class="chat-transcript-empty-body">
				<Show when={daemon()}>
					{(d) => (
						<>
							<h2 class="chat-transcript-empty-title">{d().project}</h2>
							<p class="chat-transcript-empty-meta">
								<Show
									when={d().detachedAt !== undefined ? `detached @ ${d().detachedAt}` : d().branch}
								>
									{(name) => (
										<span class="chat-transcript-empty-branch">
											<Show when={d().workspaceKind === "clone"}>
												<PackageIcon />
											</Show>
											<Show when={d().workspaceKind !== "clone"}>
												<WorktreeIcon />
											</Show>
											{name()}
										</span>
									)}
								</Show>
								<Show when={state.modelSynced && state.model}>
									{(model) => <span>{model().name || model().id}</span>}
								</Show>
							</p>
						</>
					)}
				</Show>
				<p class="chat-transcript-empty-new">New session</p>
				<p class="chat-transcript-empty-hints">
					<span>
						<kbd>/</kbd> commands
					</span>
					<span>
						<kbd>@</kbd> files
					</span>
					<span>
						<kbd>Enter</kbd> send
					</span>
					<span>
						<kbd>Shift</kbd>+<kbd>Enter</kbd> new line
					</span>
				</p>
				<Show when={recent().length > 0}>
					<section class="chat-transcript-empty-recent" aria-labelledby="chat-empty-recent-title">
						<h3 class="chat-transcript-empty-recent-title" id="chat-empty-recent-title">
							Recent in this workspace
						</h3>
						<ul class="chat-transcript-empty-recent-list">
							<For each={recent()}>
								{(row) => (
									<li>
										<SessionPickerRow
											row={row}
											size="compact"
											nowMs={nowMs()}
											onChoose={() =>
												resumeDaemonSession(state.currentSessionId, row.file).catch(reportError)
											}
										/>
									</li>
								)}
							</For>
						</ul>
						<button
							type="button"
							class="chat-transcript-empty-recent-all"
							onClick={() => openResumePicker()}
						>
							All sessions…
						</button>
					</section>
				</Show>
			</div>
		</div>
	);
};
