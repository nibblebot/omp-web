import { createSignal, For, Show, type Component } from "solid-js";
import type { DaemonInfo } from "../protocol";
import { isLiveDaemon, restartDaemon, setState, state, stopDaemon } from "../state";

export const DAEMON_GLYPH: Record<string, string> = {
	starting: "◐",
	running: "◐",
	ready: "✓",
	restarting: "↻",
	stopping: "◇",
	exited: "✗",
	failed: "✗",
};

/** Compact uptime: "Ns", "Nm Ns", or "Nh Nm" (floor). */
export function formatDaemonUptime(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${sec}s`;
	return `${sec}s`;
}

/** One live daemon in the strip: glyph, name, state, ready endpoint (if
    declared), meta, and kill/restart actions. */
const DaemonRow: Component<{ d: DaemonInfo }> = props => {
	const [busy, setBusy] = createSignal(false);
	const meta = [
		props.d.pid !== undefined ? `pid ${props.d.pid}` : "",
		props.d.restartCount > 0 ? `${props.d.restartCount} restarts` : "",
		formatDaemonUptime(Date.now() - props.d.startedAt),
	].filter(Boolean).join(" · ");
	const act = async (fn: () => Promise<DaemonInfo>) => {
		if (busy()) return;
		setBusy(true);
		try {
			const info = await fn();
			setState("daemons", m => new Map(m).set(`${props.d.projectDir}\u0000${props.d.name}`, info));
		} catch (err) {
			setState("error", String(err));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div class="active-daemon-row">
			<span class="daemon-glyph" data-state={props.d.state}>
				{DAEMON_GLYPH[props.d.state] ?? "◐"}
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
		[...state.daemons.values()]
			.filter(isLiveDaemon)
			.sort((a, b) => a.startedAt - b.startedAt);
	return (
		<Show when={live().length > 0}>
			<div class="active-daemons">
				<For each={live()}>
					{d => <DaemonRow d={d} />}
				</For>
			</div>
		</Show>
	);
};
