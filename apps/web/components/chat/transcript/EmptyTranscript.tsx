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
import { reportError } from "../../../store/toasts";
import { formatTimeAgo } from "../../../text/time-ago";
import { PackageIcon, RootIcon, WorktreeIcon } from "../../ui/icons";
import { displayTitle } from "../../ui/title-icons";

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

	// requestDaemonSessions is latest-wins per daemon: a request superseded by
	// another one (e.g. the row dropdown's) resolves empty, which hides the list.
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
						if (!stale) setSessions(list);
					},
					() => {},
				);
			},
		),
	);
	const recent = createMemo(() =>
		sessions()
			.filter((s) => s.path !== state.sessionFile && s.messageCount > 0)
			.slice(0, RECENT_LIMIT),
	);

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
											<Show when={d().workspaceKind !== "clone" && d().worktreeOf !== undefined}>
												<WorktreeIcon />
											</Show>
											<Show when={d().workspaceKind !== "clone" && d().worktreeOf === undefined}>
												<RootIcon />
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
								{(entry) => (
									<li>
										<button
											type="button"
											class="chat-transcript-empty-recent-item"
											onClick={() =>
												resumeDaemonSession(state.currentSessionId, entry.path).catch(reportError)
											}
										>
											<span class="chat-transcript-empty-recent-name">
												{displayTitle(entry.name?.trim()) ||
													entry.firstMessage?.trim().slice(0, 120) ||
													"Untitled session"}
											</span>
											<span class="chat-transcript-empty-recent-age">
												{formatTimeAgo(entry.modifiedAt)}
											</span>
										</button>
									</li>
								)}
							</For>
						</ul>
					</section>
				</Show>
			</div>
		</div>
	);
};
