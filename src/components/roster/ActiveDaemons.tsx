import { createSignal, For, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { daemonsKey, type DaemonInfo } from "../../../shared/protocol";
import { isLiveDaemon, restartDaemon, setState, state, stopDaemon } from "../../state";
import { LoaderIcon } from "../shared/icons";
import { formatDaemonUptime } from "../../fleet-ui/daemon-ui";
import { DAEMON_ICON } from "./daemon-icons";

/** One live daemon in the strip: glyph, name, state, ready endpoint (if
    declared), meta, and kill/restart actions. */
const DaemonRow: Component<{ d: DaemonInfo }> = (props) => {
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
			setState("error", String(err));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div class="active-daemon-row">
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
					title="Restart daemon"
					disabled={busy()}
					onClick={() => void act(() => restartDaemon(props.d.projectDir, props.d.name))}
				>
					restart
				</button>
				<button
					class="daemon-btn daemon-btn--kill"
					type="button"
					title="Stop daemon"
					disabled={busy()}
					onClick={() => void act(() => stopDaemon(props.d.projectDir, props.d.name))}
				>
					kill
				</button>
			</div>
		</div>
	);
};

/** Live daemons strip above the prompt: visible only while >=1 supervised process is alive. */
export const ActiveDaemons: Component = () => {
	const live = () =>
		[...state.daemons.values()].filter(isLiveDaemon).sort((a, b) => a.startedAt - b.startedAt);
	return (
		<Show when={live().length > 0}>
			<div class="active-daemons">
				<For each={live()}>{(d) => <DaemonRow d={d} />}</For>
			</div>
		</Show>
	);
};
