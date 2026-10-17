import type { DaemonEntry, DaemonStatus, RegisteredProject } from "#lib/wire/protocol";

// ---------------------------------------------------------------------------
// Pure derivations behind the sidebar rows: the text status chip, the always-
// visible Start/Restart action, the collapsed-project roll-up and the active
// workspace names shown in the main header. No store reads here, so every
// state is unit-testable without a fleet.
// ---------------------------------------------------------------------------

/** Statuses of a session process that is on its way up. */
const STARTING_STATUSES: Partial<Record<DaemonStatus, true>> = {
	spawning: true,
	connecting: true,
	session: true,
	resolving: true,
};

export type SessionChipKind =
	| "running"
	| "starting"
	| "asleep"
	| "stopped"
	| "reconnecting"
	| "crashed";

export interface SessionChip {
	kind: SessionChipKind;
	/** Text shown in the row chip. */
	label: string;
	/** Tooltip copy that explains the state and the next step. */
	title: string;
}

const CHIPS: Record<SessionChipKind, SessionChip> = {
	running: { kind: "running", label: "Running", title: "Session process is running" },
	starting: { kind: "starting", label: "Starting", title: "Session process is starting" },
	asleep: {
		kind: "asleep",
		label: "Asleep",
		title: "Session process is not running; Start wakes it",
	},
	stopped: {
		kind: "stopped",
		label: "Stopped",
		title: "You stopped this session process; Restart brings it back",
	},
	reconnecting: {
		kind: "reconnecting",
		label: "Reconnecting",
		title: "Lost the session process, reconnecting",
	},
	crashed: {
		kind: "crashed",
		label: "Crashed",
		title: "Session process exited unexpectedly; Restart brings it back",
	},
};

export interface ChipContext {
	/** A wake-attach is in flight for this row (shows Starting while the roster lags). */
	waking?: boolean;
	/** This tab stopped the session process from the UI (asleep reads Stopped, not Asleep). */
	stoppedByUser?: boolean;
}

/** The text status chip for a roster status. */
export function sessionChip(status: DaemonStatus, ctx: ChipContext = {}): SessionChip {
	if (ctx.waking === true && status !== "ready") return CHIPS.starting;
	switch (status) {
		case "ready":
			return CHIPS.running;
		case "asleep":
			return ctx.stoppedByUser === true ? CHIPS.stopped : CHIPS.asleep;
		case "reconnecting":
			return CHIPS.reconnecting;
		case "error":
			return CHIPS.crashed;
		default:
			return CHIPS.starting;
	}
}

export type RowActionKind = "start" | "restart";

export interface RowAction {
	kind: RowActionKind;
	label: "Start" | "Restart";
}

/**
 * The row's always-visible primary action: a running or crashed process
 * restarts, a never-started (asleep) one starts, a user-stopped one restarts.
 * In-between states (starting, reconnecting) offer nothing: acting on a
 * process mid-transition races the supervisor.
 */
export function rowAction(status: DaemonStatus, ctx: ChipContext = {}): RowAction | null {
	if (ctx.waking === true && status !== "ready") return null;
	if (status === "ready" || status === "error") return { kind: "restart", label: "Restart" };
	if (status === "asleep") {
		return ctx.stoppedByUser === true
			? { kind: "restart", label: "Restart" }
			: { kind: "start", label: "Start" };
	}
	return null;
}

/** Display name of a workspace, identical in rows, dialogs and the header. */
export function workspaceName(d: Pick<DaemonEntry, "branch" | "name">): string {
	return d.branch ?? d.name;
}

/**
 * Collapsed-project roll-up ("2 running", "1 running · 1 crashed"). Empty
 * string when the project has no workspaces; "N asleep" when none is up.
 */
export function projectRollup(daemons: ReadonlyArray<Pick<DaemonEntry, "status">>): string {
	let running = 0;
	let starting = 0;
	let reconnecting = 0;
	let crashed = 0;
	let asleep = 0;
	for (const d of daemons) {
		if (d.status === "ready") running++;
		else if (STARTING_STATUSES[d.status] === true) starting++;
		else if (d.status === "reconnecting") reconnecting++;
		else if (d.status === "error") crashed++;
		else asleep++;
	}
	const parts: string[] = [];
	if (running > 0) parts.push(`${running} running`);
	if (starting > 0) parts.push(`${starting} starting`);
	if (reconnecting > 0) parts.push(`${reconnecting} reconnecting`);
	if (crashed > 0) parts.push(`${crashed} crashed`);
	if (parts.length === 0 && asleep > 0) parts.push(`${asleep} asleep`);
	return parts.join(" · ");
}

export interface ActiveWorkspace {
	/** Registered project name (or the entry's own project string for unregistered entries). */
	project: string;
	/** Branch, else the workspace name. */
	workspace: string;
	/** Working directory, for the tooltip. */
	cwd: string;
}

/**
 * Names for the main header: which project and workspace the attached
 * session belongs to, so two projects that both have a "main" stay apart.
 */
export function activeWorkspace(
	roster: ReadonlyArray<DaemonEntry>,
	projects: ReadonlyArray<RegisteredProject>,
	sessionId: string,
): ActiveWorkspace | null {
	if (sessionId === "") return null;
	const entry = roster.find((d) => d.daemonId === sessionId);
	if (entry === undefined) return null;
	const project =
		entry.projectId !== undefined
			? projects.find((p) => p.projectId === entry.projectId)?.name
			: undefined;
	return {
		project: project ?? entry.project,
		workspace: workspaceName(entry),
		cwd: entry.cwd,
	};
}
