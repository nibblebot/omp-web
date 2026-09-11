/**
 * Pure roster projection: registry entry → wire row (DaemonEntry) and the
 * fleet-private workspace record → its public route projection.
 *
 * No fleet state beyond the injected clock and the caller-supplied worktree
 * root: the edge composes the live roster from these functions, `/ctl/sessions`
 * reuses the workspace projection, and both stay testable without a store or a
 * running fleet. (`managed` realpaths the entry cwd against that root; nothing
 * here reads the log store or dials a daemon.) This is also the single place
 * the privacy boundary is drawn — every wire field is mapped explicitly, so a
 * new private record field can never ride a route by accident.
 */
import type { DaemonEntry } from "../shared/protocol";
import type { RegistryEntry, WorkspaceRecord } from "./registry";
import { isPathUnder, realpathOf } from "./worktrees";

/**
 * Roster-facing clone stored-history summary: the title shown on the row and
 * whether the row must read as empty.
 */
export interface CloneHistoryInfo {
	/** Stored-history session title; undefined when none is derivable. */
	title?: string;
	/** True when the row must read as empty ("New session") — no title. */
	empty: boolean;
}

/**
 * Public projection of the fleet-private {@link WorkspaceRecord} for the
 * /ctl roster: only the fields the CLI/UI/acceptance scripts rely on
 * (kind, projectId, profileId, desiredState, pinned revision, branch). The
 * private remainder — the Kubernetes binding, clone source, provider handle,
 * enrollment credential digest, deletion receipts, source pin digest, and
 * attempted generation — never crosses a route boundary.
 */
export function toPublicWorkspaceRecord(record: WorkspaceRecord): WorkspaceRecord {
	return {
		kind: record.kind,
		projectId: record.projectId,
		desiredState: record.desiredState,
		...(record.profileId !== undefined ? { profileId: record.profileId } : {}),
		...(record.pinnedRevision !== undefined ? { pinnedRevision: record.pinnedRevision } : {}),
		...(record.branch !== undefined ? { branch: record.branch } : {}),
	};
}

/**
 * Roster serialization: the DaemonEntry fields of a registry entry (never
 * token/endpoint/template/registeredAt) plus a live uptime in seconds since
 * readyAt (or registeredAt when never ready) and pid. `workspaceDir` (the
 * fleet managed-worktree root) computes `managed`: true when the entry's cwd
 * realpath is under it — the roster signal the close-out UI uses to offer
 * worktree deletion.
 *
 * P1.4 clone-workspace projection: the roster surfaces the PUBLIC subset of
 * the fleet-private WorkspaceRecord — kind→workspaceKind,
 * desiredState→desiredState, profileId→providerProfileId — plus the
 * ephemeral lifecycle liveness facts (lifecycleStage/lifecycleError, the
 * same liveness class as status/pid/readyAt). The record's private
 * remainder (providerHandle, cleanup/archive state, clone sources) NEVER
 * crosses this boundary, exactly as RegistryEntry's token/endpoint/template
 * never do: roster frames and registered_projects frames stay free of
 * tokens, private endpoints, provider handles, and secret material. Any
 * future workspace field must be mapped here explicitly (or added to the
 * RegisteredProject shape) before it can appear on the wire.
 *
 * S2: clone rows carry no probed `lastSessionFile` (its absence is
 * load-bearing elsewhere), so their sessionTitle/sessionEmpty cannot come from
 * the supervisor probe. `cloneHistory` (when resolved by the caller from the
 * fleet log store) overrides them for clone entries: a resolved title replaces
 * the row and a resolved empty flag keeps the client's "New session"
 * affordance. No new wire field is introduced — the existing
 * sessionTitle/sessionEmpty fields are reused.
 *
 * `now` is the clock for the live-uptime field; projecting a whole frame with
 * one timestamp keeps its rows internally consistent.
 */
export function toRosterEntry(
	entry: RegistryEntry,
	workspaceDir?: string,
	cloneHistory?: CloneHistoryInfo,
	now: number = Date.now(),
): DaemonEntry {
	const roster: DaemonEntry = {
		daemonId: entry.daemonId,
		name: entry.name,
		cwd: entry.cwd,
		project: entry.project,
		labels: [...entry.labels],
		mode: entry.mode,
		status: entry.status,
		// An asleep daemon has no live process: omit the uptime rather than let
		// the registeredAt fallback show a growing uptime for a dead daemon.
		...(entry.status === "asleep"
			? {}
			: {
					uptime: Math.max(0, Math.floor((now - (entry.readyAt ?? entry.registeredAt)) / 1000)),
				}),
	};
	if (entry.worktreeOf !== undefined) roster.worktreeOf = entry.worktreeOf;
	if (entry.projectId !== undefined) roster.projectId = entry.projectId;
	if (workspaceDir !== undefined && workspaceDir !== "" && entry.cwd !== "") {
		if (isPathUnder(realpathOf(entry.cwd), realpathOf(workspaceDir))) roster.managed = true;
	}
	if (entry.branch !== undefined) roster.branch = entry.branch;
	if (entry.git !== undefined) roster.git = { ...entry.git };
	if (entry.lastSessionFile !== undefined) roster.lastSessionFile = entry.lastSessionFile;
	if (entry.sessionTitle !== undefined) roster.sessionTitle = entry.sessionTitle;
	// The empty flag is meaningful only when true; a false/undefined is the same,
	// so it stays off the wire (mirrors the title-cleared rule above).
	if (entry.sessionEmpty === true) roster.sessionEmpty = true;
	// Liveness facts are meaningless for an asleep daemon; keep them off the
	// roster even if the registry entry transiently carries stale ones (e.g.
	// mid-respawn, when the supervisor writes the pid before the child readies).
	if (entry.status !== "asleep") {
		if (entry.readyAt !== undefined) roster.readyAt = entry.readyAt;
		if (entry.pid !== undefined) roster.pid = entry.pid;
	}
	if (entry.error !== undefined) roster.error = entry.error;
	// Clone workspace projection (P1.4): pass through the PUBLIC workspace
	// fields only — kind/desiredState/profileId from the fleet-private record
	// (legacy entries carry an in-memory inferred workspace after load), and
	// the ephemeral lifecycle liveness facts straight off the entry. The
	// record's providerHandle and everything else private stays off the wire.
	const workspace = entry.workspace;
	if (workspace !== undefined) {
		roster.workspaceKind = workspace.kind;
		roster.desiredState = workspace.desiredState;
		if (workspace.profileId !== undefined) roster.providerProfileId = workspace.profileId;
	}
	// S2: a clone's title/emptiness come from its fleet-stored history, not
	// from a probed lastSessionFile (which clones never persist). A resolved
	// history is authoritative for the clone row: a title/empty clears the
	// entry's stale probed fields, so a new untitled session replaces an old
	// title instead of leaving it on the row.
	if (workspace?.kind === "clone" && cloneHistory !== undefined) {
		if (cloneHistory.title !== undefined) roster.sessionTitle = cloneHistory.title;
		else delete roster.sessionTitle;
		if (cloneHistory.empty) roster.sessionEmpty = true;
		else delete roster.sessionEmpty;
	}
	if (entry.lifecycleStage !== undefined) roster.lifecycleStage = entry.lifecycleStage;
	if (entry.lifecycleError !== undefined) roster.lifecycleError = entry.lifecycleError;
	return roster;
}
