import { Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { DaemonInfo } from "#lib/wire/protocol";
import { createDaemonControl, createDaemonUptime, daemonEndpoint } from "../../activities/daemons";
import { ChevronDownIcon, ChevronRightIcon, LoaderIcon } from "../ui/icons";
import { DAEMON_ICON } from "./daemon-icons";

/**
 * One live daemon: state glyph, name, state, ready endpoint (if declared), uptime, and restart /
 * kill that act in place. In the Activities panel the summary is a toggle that expands the row
 * to its log (`onToggle`); `compact` drops the uptime and the toggle for the activity bar's
 * popover, where the row is a plain status line.
 */
export const DaemonRow: Component<{
	daemon: DaemonInfo;
	compact?: boolean;
	expanded?: boolean;
	onToggle?: () => void;
	/** Id of the region this row's toggle expands, when it is open. */
	bodyId?: string;
}> = (props) => {
	const control = createDaemonControl(() => props.daemon);
	const uptime = createDaemonUptime(() => props.daemon);
	const endpoint = () => daemonEndpoint(props.daemon);
	const summary = () => (
		<>
			<span class="daemon-glyph" data-state={props.daemon.state}>
				<Dynamic component={DAEMON_ICON[props.daemon.state] ?? LoaderIcon} />
			</span>
			<span class="daemon-name">{props.daemon.name}</span>
			<span class="daemon-state">{props.daemon.state}</span>
			<Show when={endpoint()}>
				{(text) => (
					<span class="daemon-port" title="Ready endpoint">
						{text()}
					</span>
				)}
			</Show>
			<Show when={!props.compact}>
				<span class="daemon-uptime" title="Uptime">
					{uptime()}
				</span>
			</Show>
		</>
	);
	return (
		<div class="daemon-row" classList={{ "daemon-row--open": props.expanded === true }}>
			<Show
				when={!props.compact && props.onToggle}
				fallback={<div class="daemon-summary">{summary()}</div>}
			>
				{(toggle) => (
					<button
						type="button"
						class="daemon-summary daemon-toggle"
						aria-expanded={props.expanded === true}
						aria-controls={props.expanded === true ? props.bodyId : undefined}
						onClick={() => toggle()()}
					>
						<span class="daemon-chevron" aria-hidden="true">
							{props.expanded === true ? <ChevronDownIcon /> : <ChevronRightIcon />}
						</span>
						{summary()}
					</button>
				)}
			</Show>
			<div class="daemon-actions">
				<button
					class="daemon-btn"
					type="button"
					title="Restart daemon"
					aria-label={`Restart ${props.daemon.name}`}
					disabled={control.busy()}
					onClick={control.restart}
				>
					restart
				</button>
				<button
					class="daemon-btn daemon-btn--kill"
					type="button"
					title="Stop daemon"
					aria-label={`Stop ${props.daemon.name}`}
					disabled={control.busy()}
					onClick={control.stop}
				>
					kill
				</button>
			</div>
		</div>
	);
};
