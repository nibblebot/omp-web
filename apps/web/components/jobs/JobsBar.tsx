import { Show, type Component } from "solid-js";
import { latestJobWidget } from "../../chat/job-widget";
import { setState, state } from "../../state";
import { LayersIcon } from "../ui/icons";
import { JobWidgetGlance } from "./JobWidget";

/**
 * Strip above the composer while background jobs run: how many run and the
 * glance of the widget that saw data last (the TUI status line's jobs segment).
 * It reads the daemon's live `job_widgets` snapshot, so it needs no polling, and
 * opens the jobs sheet; the sheet is the jobs feature's modal, so ModalHost
 * renders it (a trigger only sets state).
 */
export const JobsBar: Component = () => {
	const running = () => state.jobWidgets.running;
	const latest = () => latestJobWidget(state.jobWidgets.entries);
	return (
		<Show when={running() > 0}>
			<div class="composer-bar jobs-bar">
				<button
					type="button"
					class="jobs-bar-open"
					title="Open background jobs"
					onClick={() => setState("modal", "jobs")}
				>
					<LayersIcon class="jobs-bar-icon" />
					<span class="jobs-bar-count">
						{running()} {running() === 1 ? "job" : "jobs"} running
					</span>
					<Show when={latest()}>
						{(entry) => (
							<span class="jobs-bar-glance">
								<JobWidgetGlance view={entry().view} />
							</span>
						)}
					</Show>
				</button>
			</div>
		</Show>
	);
};
