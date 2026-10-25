import { createEffect, createSignal, onCleanup, Show, type Component } from "solid-js";
import type { BackgroundJob } from "../../../chat/background-job";
import { formatDuration } from "../../../subagents/format";

/**
 * Header badge of a call whose job runs in the background: how long it has run, counting up
 * while it does and frozen at the job's run time once it settled, plus a failed command's
 * exit code. The card's own status slot says how it ended.
 */
export const BackgroundBadge: Component<{ job: BackgroundJob }> = (props) => {
	const [now, setNow] = createSignal(Date.now());
	createEffect(() => {
		if (props.job.state !== "running") return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		onCleanup(() => clearInterval(timer));
	});
	const elapsed = () =>
		props.job.state === "running" ? Math.max(0, now() - props.job.startedAt) : props.job.durationMs;
	return (
		<span
			class="tool-background"
			data-state={props.job.state}
			title={`background job ${props.job.jobId}`}
		>
			<span class="tool-background-label">background</span>
			<Show when={elapsed()}>
				{(ms) => <span class="tool-background-clock">{formatDuration(ms())}</span>}
			</Show>
			<Show when={props.job.state === "failed" && props.job.exitCode}>
				{(code) => <span class="tool-background-exit">exit {code()}</span>}
			</Show>
		</span>
	);
};
