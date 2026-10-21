import { createSignal, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { daemonsKey, type DaemonInfo } from "#lib/wire/protocol";
import { isLiveDaemon, restartDaemon, setState, state, stopDaemon } from "../../../state";
import { reportError } from "../../../store/toasts";
import { BackgroundBar } from "../../ui/BackgroundBar";
import { LoaderIcon } from "../../ui/icons";
import { formatDaemonUptime } from "../../../fleet-ui/daemon-ui";
import { DAEMON_ICON } from "./daemon-icons";

/** One live daemon in the strip: glyph, name, state, ready endpoint (if
    declared), meta, and kill/restart actions. Rendered inside a `.background-bar-row`. */
const BackgroundDaemonRow: Component<{ d: DaemonInfo }> = (props) => {
	const [busy, setBusy] = createSignal(false);
	const meta = [
		props.d.pid !== undefined ? `pid ${props.d.pid}` : "",
		props.d.restartCount > 0 ? `${props.d.restartCount} restarts` : "",
		formatDaemonUptime(Date.now() - props.d.startedAt),
	]
		.filter(Boolean)
		.join(" · ");
	const act = async (fn: () => Promise<DaemonInfo>) => {
		if (busy()) return;
		setBusy(true);
		try {
			const info = await fn();
			setState("daemons", (m) => new Map(m).set(daemonsKey(props.d), info));
		} catch (err) {
			reportError(err);
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<span class="daemon-glyph" data-state={props.d.state}>
				<Dynamic component={DAEMON_ICON[props.d.state] ?? LoaderIcon} />
			</span>
			<span class="daemon-name">{props.d.name}</span>
			<span class="daemon-state">{props.d.state}</span>
			<Show when={props.d.readyPort !== undefined}>
				<span class="daemon-port" title="Ready endpoint">
					{props.d.readyHost ?? "127.0.0.1"}:{props.d.readyPort}
				</span>
			</Show>
			<span class="daemon-meta">{meta}</span>
			<div class="daemon-actions">
				<button
					class="daemon-btn"
					type="button"
					title="Restart session process"
					disabled={busy()}
					onClick={() => void act(() => restartDaemon(props.d.projectDir, props.d.name))}
				>
					restart
				</button>
				<button
					class="daemon-btn daemon-btn--kill"
					type="button"
					title="Stop session process"
					disabled={busy()}
					onClick={() => void act(() => stopDaemon(props.d.projectDir, props.d.name))}
				>
					kill
				</button>
			</div>
		</>
	);
};

/** Background daemons strip above the prompt: one row per live supervised process
    of the selected session's workspace, i.e. reported by its broker (the fleet edge
    stamps `reportedBy`; an unattributed entry is never shown). Rows are not
    clickable; restart/kill act in place. Visible only while >=1 is alive. */
export const BackgroundDaemonsBar: Component = () => {
	const live = () =>
		[...state.daemons.values()]
			.filter((d) => isLiveDaemon(d) && d.reportedBy?.includes(state.currentSessionId) === true)
			.sort((a, b) => a.startedAt - b.startedAt);
	return (
		<BackgroundBar items={live()} label="Background session processes">
			{(d) => <BackgroundDaemonRow d={d} />}
		</BackgroundBar>
	);
};
