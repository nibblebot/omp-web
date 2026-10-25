import { For, type Component } from "solid-js";
import { jobCancelError, jobsError } from "../../store/jobs";

/** Why the job list or an open job could not load, and why the last Cancel was refused; nothing while there is no error. */
export const JobErrors: Component = () => {
	const messages = () =>
		[jobsError(), jobCancelError()].filter((message): message is string => message !== null);
	return (
		<For each={messages()}>
			{(message) => (
				<div class="jobs-error" role="alert">
					{message}
				</div>
			)}
		</For>
	);
};
