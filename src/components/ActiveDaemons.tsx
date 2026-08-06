import { For, Show, type Component } from "solid-js";
import type { DaemonInfo } from "../protocol";
import { isLiveDaemon, state } from "../state";

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
					{d => {
						const meta = [
							d.pid !== undefined ? `pid ${d.pid}` : "",
							d.restartCount > 0 ? `${d.restartCount} restarts` : "",
							formatDaemonUptime(Date.now() - d.startedAt),
						].filter(Boolean).join(" · ");
						return (
							<div class="active-daemon-row">
								<span class="daemon-glyph" data-state={d.state}>
									{DAEMON_GLYPH[d.state] ?? "◐"}
								</span>
								<span class="daemon-name">{d.name}</span>
								<span class="daemon-state">{d.state}</span>
								<span class="daemon-meta">{meta}</span>
							</div>
						);
					}}
				</For>
			</div>
		</Show>
	);
};
