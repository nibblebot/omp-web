import { For, Show, type Component } from "solid-js";
import type { JobDetailDto, JobDto } from "#lib/wire/protocol";
import { JOB_STATUS_LABEL, jobElapsedMs } from "../../store/jobs";
import { formatDuration } from "../../subagents/format";

/** What the sheet shows about the selected job beyond its row: facts, the full command and the output tail. */
export const JobDetail: Component<{
	job: JobDto;
	/** Undefined while the inspection loads, null once the daemon no longer lists the job. */
	detail: JobDetailDto | null | undefined;
	/** Epoch ms a running job counts its run time up to. */
	now: number;
}> = (props) => {
	const facts = (): Array<[string, string]> => {
		const elapsed = jobElapsedMs(props.job, props.now);
		const rows: Array<[string, string | undefined]> = [
			["id", props.job.id],
			["type", props.job.type],
			["owner", props.job.ownerId],
			["runs", props.job.agentId],
			["run time", elapsed === undefined ? undefined : formatDuration(elapsed)],
			["directory", props.detail?.cwd],
			["pids", props.detail?.pids.length ? props.detail.pids.join(", ") : undefined],
			[
				"exit code",
				props.detail?.exitCode === undefined ? undefined : String(props.detail.exitCode),
			],
			["artifact", props.detail?.artifactId],
		];
		return rows.filter((row): row is [string, string] => row[1] !== undefined);
	};
	return (
		<section class="job-detail" aria-label={`Details of ${props.job.label}`}>
			<header class="job-detail-head">
				<span class="job-status" data-status={props.job.status}>
					{JOB_STATUS_LABEL[props.job.status]}
				</span>
				<h3 class="job-detail-title" title={props.job.label}>
					{props.job.label}
				</h3>
			</header>
			<Show
				when={props.detail !== undefined}
				fallback={<p class="job-detail-note">loading details…</p>}
			>
				<Show
					when={props.detail}
					fallback={<p class="job-detail-note">This job is no longer listed.</p>}
				>
					{(detail) => (
						<>
							<dl class="job-facts">
								<For each={facts()}>
									{([name, value]) => (
										<div class="job-fact">
											<dt>{name}</dt>
											<dd title={value}>{value}</dd>
										</div>
									)}
								</For>
							</dl>
							<Show when={detail().command}>
								{(command) => (
									<>
										<h4 class="job-detail-section">Command</h4>
										<pre class="job-command">{command()}</pre>
									</>
								)}
							</Show>
							<Show when={detail().output}>
								{(output) => (
									<>
										<h4 class="job-detail-section">
											{props.job.status === "running" ? "Output so far" : "Result"}
										</h4>
										<Show when={detail().outputTruncated}>
											<p class="job-detail-note">Showing the end of the output.</p>
										</Show>
										<pre class="job-output">{output()}</pre>
									</>
								)}
							</Show>
						</>
					)}
				</Show>
			</Show>
		</section>
	);
};
