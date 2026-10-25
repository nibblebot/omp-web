import { Show, type Component } from "solid-js";
import type { DaemonInfo } from "#lib/wire/protocol";
import { createDaemonLogs } from "../../activities/daemons";
import { RefreshIcon } from "../ui/icons";

/**
 * The log tail of one daemon, in the expanded row's body: fetched when the row opens, refreshed
 * on request. A failed fetch keeps the previous tail and says why.
 */
export const DaemonLog: Component<{ daemon: DaemonInfo; id: string }> = (props) => {
	const logs = createDaemonLogs(() => props.daemon);
	const view = logs.view;
	return (
		<div class="activity-item-body daemon-log" id={props.id}>
			<div class="daemon-log-bar">
				<span class="daemon-log-title">Log</span>
				<button
					type="button"
					class="daemon-btn daemon-log-refresh"
					aria-label={`Refresh ${props.daemon.name} log`}
					disabled={view().loading}
					onClick={logs.refresh}
				>
					<RefreshIcon />
					Refresh
				</button>
			</div>
			<Show when={view().error}>
				{(message) => (
					<p class="daemon-log-error" role="alert">
						{message()}
					</p>
				)}
			</Show>
			<Show
				when={view().text !== undefined}
				fallback={
					<Show when={!view().error}>
						<p class="daemon-log-note">Loading log…</p>
					</Show>
				}
			>
				<Show when={view().text !== ""} fallback={<p class="daemon-log-note">No output yet.</p>}>
					<pre class="daemon-log-text">{view().text}</pre>
				</Show>
			</Show>
		</div>
	);
};
