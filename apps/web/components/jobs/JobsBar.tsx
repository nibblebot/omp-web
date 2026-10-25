import { createMemo, Match, Show, Switch, type Component } from "solid-js";
import { isCountedJobWidget, latestJobWidget } from "../../chat/job-widget";
import { createPresence } from "../../motion/presence";
import { state } from "../../state";
import { openJobsSheet } from "../../store/jobs";
import { jobsBarView, type JobsBarView } from "../../store/jobs-bar";
import { LayersIcon } from "../ui/icons";
import { JobWidgetGlance } from "./JobWidget";

/**
 * Strip above the composer while background jobs run: how many run and the
 * glance of the widget that saw data last (the TUI status line's jobs segment).
 * Once the last one ends it stays as a quiet "N jobs finished" note for a short
 * while, so the sheet's recent jobs remain one click away (store/jobs-bar.ts).
 * It reads the daemon's live `job_widgets` snapshot, so it needs no polling, and
 * opens the jobs sheet, which ModalHost renders (a trigger only sets state).
 * The glance skips subagents' task widgets: the count leaves those jobs out.
 */
export const JobsBar: Component = () => {
	const presence = createPresence(() => jobsBarView() !== undefined);
	// The last view stays drawn through the exit motion.
	let last: JobsBarView | undefined;
	const shown = createMemo(() => (last = jobsBarView() ?? last));
	const running = () => {
		const view = shown();
		return view?.phase === "running" ? view.running : undefined;
	};
	const finished = () => {
		const view = shown();
		return view?.phase === "finished" ? view.finished : undefined;
	};
	const latest = () => latestJobWidget(state.jobWidgets.entries.filter(isCountedJobWidget));
	return (
		<Show when={presence.mounted() && shown() !== undefined}>
			<div
				class="composer-bar jobs-bar"
				data-motion={presence.phase()}
				data-phase={shown()?.phase}
				inert={presence.phase() === "exit"}
				ref={presence.ref}
			>
				<div class="jobs-bar-clip">
					<div class="jobs-bar-body">
						<button
							type="button"
							class="jobs-bar-open"
							title="Open background jobs"
							onClick={() => openJobsSheet()}
						>
							<LayersIcon class="jobs-bar-icon" />
							<Switch>
								<Match when={running()}>
									{(count) => (
										<>
											<span class="jobs-bar-count">
												{count()} {count() === 1 ? "job" : "jobs"} running
											</span>
											<Show when={latest()}>
												{(entry) => (
													<span class="jobs-bar-glance">
														<JobWidgetGlance view={entry().view} />
													</span>
												)}
											</Show>
										</>
									)}
								</Match>
								<Match when={finished()}>
									{(count) => (
										<>
											<span class="jobs-bar-count">
												{count()} {count() === 1 ? "job" : "jobs"} finished
											</span>
											<span class="jobs-bar-action">view</span>
										</>
									)}
								</Match>
							</Switch>
						</button>
					</div>
				</div>
			</div>
		</Show>
	);
};
