import { produce } from "solid-js/store";
import type { JobTreeDto } from "#lib/wire/protocol";
import {
	reconcileBackgroundJobs,
	runningBackgroundCards,
	type ListedJob,
} from "../chat/background-job";
import { setState, state, type ToolItem } from "../state";
import { drainParkedToolUpdates } from "./chat";
import { call } from "./transport";

/**
 * The cards a reloaded transcript still shows parked on a running job (chat/history-items.ts
 * leaves a call's job running until a delivery says otherwise) are looked up in the session's
 * job list once: a settled job settles its card, a running one keeps it, a job the list no
 * longer has leaves the call a plain done card. Live frames take over from there.
 */

/** The jobs of the session's job tree; undefined when the list cannot be read (no job manager, a failed call). */
async function listedJobs(): Promise<ListedJob[] | undefined> {
	try {
		const tree = (await call("getJobTree", [])) as JobTreeDto | null;
		if (tree === null) return undefined;
		return tree.rows.flatMap((row) =>
			row.kind === "job"
				? [
						{
							id: row.job.id,
							...(row.job.agentId !== undefined ? { agentId: row.job.agentId } : {}),
							status: row.job.status,
							startTime: row.job.startTime,
							...(row.job.endTime !== undefined ? { endTime: row.job.endTime } : {}),
						},
					]
				: [],
		);
	} catch {
		return undefined;
	}
}

/** Settle the transcript's parked cards against the session's job list; an answer for a session left behind is dropped. */
export async function reconcileBackgroundCards(): Promise<void> {
	if (runningBackgroundCards(state.items).length === 0) return;
	const workspaceId = state.currentWorkspaceId;
	const jobs = await listedJobs();
	if (workspaceId !== state.currentWorkspaceId) return;
	drainParkedToolUpdates();
	setState(
		"items",
		produce((items) => {
			reconcileBackgroundJobs(
				items.filter((item): item is ToolItem => item.kind === "tool"),
				jobs,
			);
		}),
	);
}
