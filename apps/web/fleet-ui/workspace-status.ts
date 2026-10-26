import type { RosterEntry, SessionStatus, RegisteredProject } from "#lib/wire/protocol";
import type { SessionActivity } from "./session-activity";

// ---------------------------------------------------------------------------
// Pure derivations behind the sidebar rows: the process state behind the
// status dot's tooltip, the kebab's Start/Restart item, the collapsed-project
// roll-up (counts, most urgent signal, breakdown) and the active workspace
// names shown in the main header. No store reads here, so every state is
// unit-testable without a fleet.
// ---------------------------------------------------------------------------

/** Statuses of a session process that is on its way up. */
const STARTING_STATUSES: Partial<Record<SessionStatus, true>> = {
	spawning: true,
	connecting: true,
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

/** The process state for a roster status (label + explanatory tooltip). */
export function sessionChip(status: SessionStatus, ctx: ChipContext = {}): SessionChip {
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

/**
 * Whether the row's kebab offers Start: an asleep process (never started or
 * stopped by the user) or a crashed one starts fresh; a running one offers
 * only Stop (stop, then start, replaces a restart). In-between states
 * (starting, reconnecting, waking) offer nothing: acting on a process
 * mid-transition races the supervisor.
 */
export function canStartRow(status: SessionStatus, ctx: ChipContext = {}): boolean {
	if (ctx.waking === true) return false;
	return status === "asleep" || status === "error";
}

/**
 * Whether a row stays in the sidebar while the "running only" filter is on:
 * every row whose process is not asleep (ready, starting, reconnecting,
 * crashed) stays, and so does a `pinned` asleep row. A row is pinned when it
 * is the attached session or the target of a switch that is waking,
 * attaching or has failed, so the selected row never vanishes under the user.
 */
export function shownWhenRunningOnly(status: SessionStatus, pinned: boolean): boolean {
	return status !== "asleep" || pinned;
}

/** Display name of a workspace, identical in rows, dialogs and the header. */
export function workspaceName(d: Pick<RosterEntry, "branch" | "name">): string {
	return d.branch ?? d.name;
}

/** What one row contributes to a project roll-up: its roster status and, for a
 *  ready row, its session activity (`rowActivity`). */
export interface RollupRow {
	status: SessionStatus;
	activity?: SessionActivity | null;
}

/** The single row signal a collapsed project shows in the row-corner column
 *  (the props of RowSignal): a status, plus the activity for a ready row. */
export interface RollupSignal {
	status: SessionStatus;
	activity?: SessionActivity;
}

export interface ProjectRollup {
	/** Ready workspaces (the ones carrying the ready rail). Reconnecting rows
	 *  are NOT live: they are on their way back and surface as the amber signal. */
	live: number;
	/** Every workspace of the project. */
	total: number;
	/** Asleep workspaces (the "N asleep" summary when nothing is live). */
	asleep: number;
	/** Most urgent row signal across the project, or null when every row is
	 *  ready+idle or asleep. */
	signal: RollupSignal | null;
	/** Full per-state counts for the tooltip and aria-label. */
	breakdown: string;
}

/** Signal urgency, most urgent first: blocked > error > reconnecting >
 *  unreviewed > unread > working or starting. */
const SIGNAL_ORDER = [
	"blocked",
	"error",
	"reconnecting",
	"unreviewed",
	"unread",
	"working",
] as const;
type SignalKind = (typeof SIGNAL_ORDER)[number];

/** The signal kind a row shows, or null when it shows none (ready+idle, asleep). */
function signalKind(row: RollupRow): SignalKind | null {
	if (STARTING_STATUSES[row.status] === true) return "working";
	if (row.status === "error") return "error";
	if (row.status === "reconnecting") return "reconnecting";
	if (row.status !== "ready") return null;
	switch (row.activity) {
		case "blocked":
			return "blocked";
		case "unreviewed":
			return "unreviewed";
		case "unread":
			return "unread";
		case "in_progress":
			return "working";
		default:
			return null;
	}
}

/**
 * Collapsed-project roll-up: the live/total counts, the single most urgent row
 * signal (SIGNAL_ORDER) and the full breakdown ("2 ready (1 blocked, 1
 * working) · 1 asleep"). An empty project has total 0, no signal and the
 * breakdown "No workspaces".
 */
export function projectRollup(rows: ReadonlyArray<RollupRow>): ProjectRollup {
	let live = 0;
	let starting = 0;
	let reconnecting = 0;
	let crashed = 0;
	let asleep = 0;
	/** Ready rows per activity kind (the parenthesised detail after "ready"). */
	const readyKinds: Partial<Record<SignalKind, number>> = {};
	let best: { rank: number; row: RollupRow } | null = null;
	for (const row of rows) {
		if (row.status === "ready") live++;
		else if (STARTING_STATUSES[row.status] === true) starting++;
		else if (row.status === "reconnecting") reconnecting++;
		else if (row.status === "error") crashed++;
		else asleep++;
		const kind = signalKind(row);
		if (kind === null) continue;
		if (row.status === "ready") readyKinds[kind] = (readyKinds[kind] ?? 0) + 1;
		const rank = SIGNAL_ORDER.indexOf(kind);
		if (best === null || rank < best.rank) best = { rank, row };
	}
	const readyDetail = (["blocked", "working", "unreviewed", "unread"] as const).flatMap((kind) =>
		readyKinds[kind] ? [`${readyKinds[kind]} ${kind}`] : [],
	);
	const parts = [
		live > 0 && `${live} ready${readyDetail.length > 0 ? ` (${readyDetail.join(", ")})` : ""}`,
		starting > 0 && `${starting} starting`,
		reconnecting > 0 && `${reconnecting} reconnecting`,
		crashed > 0 && `${crashed} crashed`,
		asleep > 0 && `${asleep} asleep`,
	].filter((part): part is string => part !== false);
	let signal: RollupSignal | null = null;
	if (best !== null) {
		const { status, activity } = best.row;
		signal = status === "ready" && activity ? { status, activity } : { status };
	}
	return {
		live,
		total: rows.length,
		asleep,
		signal,
		breakdown: parts.length > 0 ? parts.join(" · ") : "No workspaces",
	};
}

/**
 * The muted text a collapsed project shows beside its rail mark: "live/total"
 * when something is live ("2/5"); "N asleep" when nothing is live but some
 * workspaces sleep; "0/total" when nothing is live and nothing sleeps (all
 * starting, reconnecting or crashed); "" for an empty project.
 */
export function rollupSummary(r: Pick<ProjectRollup, "live" | "total" | "asleep">): string {
	if (r.total === 0) return "";
	if (r.live > 0) return `${r.live}/${r.total}`;
	return r.asleep > 0 ? `${r.asleep} asleep` : `0/${r.total}`;
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
	roster: ReadonlyArray<RosterEntry>,
	projects: ReadonlyArray<RegisteredProject>,
	workspaceId: string,
): ActiveWorkspace | null {
	if (workspaceId === "") return null;
	const entry = roster.find((d) => d.workspaceId === workspaceId);
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
