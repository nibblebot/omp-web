import type { UsageReport } from "@oh-my-pi/pi-ai";
import {
	daemonsKey,
	type RosterEntry,
	type DaemonInfo,
	type ProjectBranch,
	type PublicProviderProfile,
	type RegisteredProject,
	type SessionListEntry,
} from "#lib/wire/protocol";
import type { ProjectGroupsData } from "../../web/components/fleet/sidebar/ProjectGroups";
import type { state, WorktreeDeleteInfo } from "../../web/state";

/** Fixed base for determinism; session.ts uses 12:00Z, these fixtures use 10:00Z. */
const T0 = Date.parse("2026-10-09T10:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const OMP_WEB = "/home/joshua/Repos/omp-web";
const LOCALACTION = "/home/joshua/Repos/localaction";
const LOCALACTION_WORKTREES = "/home/joshua/Repos/localaction-worktrees";
const NIXOS_CONFIG = "/home/joshua/Repos/nixos-config";
const NIXOS_CONFIG_WORKTREES = "/home/joshua/Repos/nixos-config-worktrees";
const WORKTREES = "/home/joshua/Repos/omp-web-worktrees";

const ompWeb: RegisteredProject = {
	projectId: "proj_omp_web",
	path: OMP_WEB,
	name: "omp-web",
	addedAt: T0 - 14 * DAY,
};

const localaction: RegisteredProject = {
	projectId: "proj_localaction",
	path: LOCALACTION,
	name: "localaction",
	addedAt: T0 - 30 * DAY,
};

/** A registered project with no sessions yet: its group shows the "start a session" chevron. */
const nixosConfig: RegisteredProject = {
	projectId: "proj_nixos_config",
	path: NIXOS_CONFIG,
	name: "nixos-config",
	addedAt: T0 - 2 * DAY,
};

/** RegisteredProject list: FleetSidebar project sections and AddProjectDialog duplicate checks. */
export const rosterProjects: RegisteredProject[] = [ompWeb, localaction, nixosConfig];

/** ProjectBranch list: branch rows in the New workspace popover's picker. */
export const rosterProjectBranches: ProjectBranch[] = [
	{ name: "main", checkedOut: true, worktreePath: OMP_WEB },
	{ name: "feat/design-fixtures", checkedOut: true, worktreePath: `${WORKTREES}/design-fixtures` },
	{ name: "feat/tx-pagination", checkedOut: true, worktreePath: `${WORKTREES}/tx-pagination` },
	{ name: "fix/review-anchors", checkedOut: false },
	{ name: "chore/bump-sdk-18-9", checkedOut: false },
	{ name: "release/0.3", checkedOut: false },
];

/** RosterEntry: the omp-web main checkout, ready and mid-turn according to the fleet edge. */
const sessionMain: RosterEntry = {
	workspaceId: "dmn_a001",
	name: "omp-web",
	cwd: OMP_WEB,
	project: "omp-web",
	projectId: "proj_omp_web",
	branch: "main",
	git: { added: 0, modified: 2, deleted: 0, untracked: 1, linesAdded: 64, linesDeleted: 9 },
	status: "ready",
	lastSessionFile: "/home/joshua/.omp/sessions/omp-web/2026-10-09T08-12-40.jsonl",
	sessionTitle: "Bump the SDK pins to 18.9",
	readyAt: T0 - 95 * MIN,
	uptime: 95 * 60,
	pid: 41877,
	workspaceKind: "direct",
	desiredState: "running",
};

/** RosterEntry: linked worktree, ready, with local changes; the row the browser is attached to. */
const sessionFixtures: RosterEntry = {
	workspaceId: "dmn_a002",
	name: "design-fixtures",
	cwd: `${WORKTREES}/design-fixtures`,
	project: "omp-web",
	projectId: "proj_omp_web",
	worktreeOf: OMP_WEB,
	branch: "feat/design-fixtures",
	git: { added: 2, modified: 5, deleted: 0, untracked: 3, linesAdded: 412, linesDeleted: 18 },
	status: "ready",
	lastSessionFile: "/home/joshua/.omp/sessions/omp-web/2026-10-09T09-40-12.jsonl",
	sessionTitle: "Design-system fixture modules",
	readyAt: T0 - 22 * MIN,
	uptime: 22 * 60,
	pid: 48211,
	workspaceKind: "worktree",
	desiredState: "running",
};

/** RosterEntry: asleep worktree whose session can be resumed from the worktree sessions dialog. */
const sessionAsleep: RosterEntry = {
	workspaceId: "dmn_a003",
	name: "review-anchors",
	cwd: `${WORKTREES}/review-anchors`,
	project: "omp-web",
	projectId: "proj_omp_web",
	worktreeOf: OMP_WEB,
	branch: "fix/review-anchors",
	git: { added: 0, modified: 0, deleted: 0, untracked: 0 },
	status: "asleep",
	lastSessionFile: "/home/joshua/.omp/sessions/omp-web/2026-10-08T16-02-33.jsonl",
	sessionTitle: "Anchor migration for stale annotations",
	workspaceKind: "worktree",
	desiredState: "stopped",
};

/** RosterEntry: registered linked worktree in the default creation directory; deletable like any other. */
const sessionRegisteredWorktree: RosterEntry = {
	...sessionAsleep,
	workspaceId: "dmn_a007",
	name: "adopted-review",
	cwd: `${WORKTREES}/adopted-review`,
	branch: "review/external",
	lastSessionFile: undefined,
	sessionTitle: undefined,
};

/** RosterEntry: worktree whose session process is still connecting (transitional status). */
const sessionStarting: RosterEntry = {
	workspaceId: "dmn_a004",
	name: "tx-pagination",
	cwd: `${WORKTREES}/tx-pagination`,
	project: "omp-web",
	projectId: "proj_omp_web",
	worktreeOf: OMP_WEB,
	branch: "feat/tx-pagination",
	status: "connecting",
	sessionEmpty: true,
	workspaceKind: "worktree",
	desiredState: "running",
};

/** RosterEntry: provider-run clone workspace still preparing its checkout. */
const sessionClonePreparing: RosterEntry = {
	workspaceId: "dmn_a005",
	name: "bench-clone",
	cwd: "/home/joshua/.omp/clones/bench-clone",
	project: "omp-web",
	projectId: "proj_omp_web",
	branch: "main",
	status: "connecting",
	providerProfileId: "bwrap-default",
	workspaceKind: "clone",
	desiredState: "running",
	lifecycleStage: "runtime",
};

/** RosterEntry: clone workspace whose lifecycle failed; the row offers Retry. */
const sessionCloneFailed: RosterEntry = {
	workspaceId: "dmn_a006",
	name: "k8s-trial",
	cwd: "/home/joshua/.omp/clones/k8s-trial",
	project: "omp-web",
	projectId: "proj_omp_web",
	status: "error",
	error: "workspace lifecycle failed",
	providerProfileId: "k8s-bench",
	workspaceKind: "clone",
	desiredState: "running",
	lifecycleStage: "failed",
	lifecycleError:
		"PersistentVolumeClaim omp-k8s-trial stayed Pending for 120s (no fast-ssd capacity)",
};

/** RosterEntry: ready clone cut from the project's local path; its row offers "Fetch into project". */
const sessionCloneLocal: RosterEntry = {
	workspaceId: "dmn_a008",
	name: "local-clone",
	cwd: "/home/joshua/.omp/clones/local-clone",
	project: "omp-web",
	projectId: "proj_omp_web",
	branch: "local-clone",
	status: "ready",
	providerProfileId: "bwrap-default",
	workspaceKind: "clone",
	desiredState: "running",
	lifecycleStage: "ready",
	localSource: true,
	readyAt: T0 - 12 * MIN,
	uptime: 12 * 60,
};

/** RosterEntry: localaction main checkout, ready; its turn finished while the user was elsewhere (unread). */
const sessionLocalactionMain: RosterEntry = {
	workspaceId: "dmn_b001",
	name: "localaction",
	cwd: LOCALACTION,
	project: "localaction",
	projectId: "proj_localaction",
	branch: "main",
	git: { added: 0, modified: 1, deleted: 1, untracked: 0, linesAdded: 12, linesDeleted: 30 },
	status: "ready",
	lastSessionFile: "/home/joshua/.omp/sessions/localaction/2026-10-09T07-55-01.jsonl",
	sessionTitle: "Cache action checkouts between runs",
	readyAt: T0 - 140 * MIN,
	uptime: 140 * 60,
	pid: 40122,
	workspaceKind: "direct",
	desiredState: "running",
};

/** RosterEntry: attached session whose socket dropped; the status dot pulses while it redials. */
const sessionReconnecting: RosterEntry = {
	workspaceId: "dmn_b002",
	name: "job-matrix",
	cwd: `${LOCALACTION_WORKTREES}/job-matrix`,
	project: "localaction",
	projectId: "proj_localaction",
	worktreeOf: LOCALACTION,
	branch: "feat/job-matrix",
	status: "reconnecting",
	sessionTitle: "Expand matrix strategies into jobs",
	error: "socket closed (ECONNRESET); retrying in 4s",
	workspaceKind: "worktree",
	desiredState: "running",
};

/** RosterEntry: session whose session file could not be found; an error row with a failed lifecycle stage. */
const sessionErrorEntry: RosterEntry = {
	workspaceId: "dmn_c001",
	name: "localaction-bench",
	cwd: "/srv/work/localaction",
	project: "nixos-config",
	projectId: "proj_nixos_config",
	status: "error",
	error: "session file not found on remote host",
	sessionEmpty: true,
	providerProfileId: "bwrap-default",
	lifecycleStage: "failed",
	lifecycleError: "bwrap exited with status 1",
};

/** RosterEntry: session waiting on an extension dialog (blocked activity). */
const sessionBlocked: RosterEntry = {
	workspaceId: "dmn_c002",
	name: "release-bot",
	cwd: "/srv/work/release",
	project: "nixos-config",
	projectId: "proj_nixos_config",
	status: "ready",
	sessionTitle: "Cut 0.3 release notes",
	sessionEmpty: false,
	readyAt: T0 - 8 * MIN,
	uptime: 8 * 60,
};

/** RosterEntry list: everything the roster renders, across statuses and workspace kinds. */
export const rosterEntries: RosterEntry[] = [
	sessionMain,
	sessionFixtures,
	sessionAsleep,
	sessionRegisteredWorktree,
	sessionStarting,
	sessionClonePreparing,
	sessionCloneFailed,
	sessionCloneLocal,
	sessionLocalactionMain,
	sessionReconnecting,
	sessionErrorEntry,
	sessionBlocked,
];

/** Individual entries, for stories that show one row or one detail view. */
export const rosterEntry = {
	main: sessionMain,
	worktree: sessionFixtures,
	asleep: sessionAsleep,
	registeredWorktree: sessionRegisteredWorktree,
	starting: sessionStarting,
	clonePreparing: sessionClonePreparing,
	cloneFailed: sessionCloneFailed,
	cloneLocal: sessionCloneLocal,
	localactionMain: sessionLocalactionMain,
	reconnecting: sessionReconnecting,
	sessionError: sessionErrorEntry,
	blocked: sessionBlocked,
} satisfies Record<string, RosterEntry>;

/** RosterEntry: localaction linked worktree, ready and idle; the App view's healthy counterpart of `sessionReconnecting`. */
const sessionJobMatrix: RosterEntry = {
	workspaceId: "dmn_b003",
	name: "job-matrix",
	cwd: `${LOCALACTION_WORKTREES}/job-matrix`,
	project: "localaction",
	projectId: "proj_localaction",
	worktreeOf: LOCALACTION,
	branch: "feat/job-matrix",
	git: { added: 1, modified: 3, deleted: 0, untracked: 0, linesAdded: 148, linesDeleted: 22 },
	status: "ready",
	lastSessionFile: "/home/joshua/.omp/sessions/localaction/2026-10-09T09-12-48.jsonl",
	sessionTitle: "Expand matrix strategies into jobs",
	readyAt: T0 - 48 * MIN,
	uptime: 48 * 60,
	pid: 46305,
	workspaceKind: "worktree",
	desiredState: "running",
};

/** RosterEntry: asleep localaction worktree from yesterday (App view only). */
const sessionArtifactPaths: RosterEntry = {
	workspaceId: "dmn_b004",
	name: "artifact-paths",
	cwd: `${LOCALACTION_WORKTREES}/artifact-paths`,
	project: "localaction",
	projectId: "proj_localaction",
	worktreeOf: LOCALACTION,
	branch: "fix/artifact-paths",
	git: { added: 0, modified: 0, deleted: 0, untracked: 0 },
	status: "asleep",
	lastSessionFile: "/home/joshua/.omp/sessions/localaction/2026-10-08T14-31-07.jsonl",
	sessionTitle: "Normalize artifact upload paths on Windows runners",
	workspaceKind: "worktree",
	desiredState: "stopped",
};

/** RosterEntry: nixos-config main checkout, ready with uncommitted host changes (App view only). */
const sessionNixosMain: RosterEntry = {
	workspaceId: "dmn_d001",
	name: "nixos-config",
	cwd: NIXOS_CONFIG,
	project: "nixos-config",
	projectId: "proj_nixos_config",
	branch: "main",
	git: { added: 1, modified: 2, deleted: 0, untracked: 0, linesAdded: 57, linesDeleted: 14 },
	status: "ready",
	lastSessionFile: "/home/joshua/.omp/sessions/nixos-config/2026-10-09T08-47-19.jsonl",
	sessionTitle: "Split home-manager modules per host",
	readyAt: T0 - 70 * MIN,
	uptime: 70 * 60,
	pid: 43968,
	workspaceKind: "direct",
	desiredState: "running",
};

/** RosterEntry: asleep nixos-config worktree for a flake input bump (App view only). */
const sessionFlakeUpdate: RosterEntry = {
	workspaceId: "dmn_d002",
	name: "flake-update",
	cwd: `${NIXOS_CONFIG_WORKTREES}/flake-update`,
	project: "nixos-config",
	projectId: "proj_nixos_config",
	worktreeOf: NIXOS_CONFIG,
	branch: "chore/flake-update",
	git: { added: 0, modified: 1, deleted: 0, untracked: 0, linesAdded: 18, linesDeleted: 18 },
	status: "asleep",
	lastSessionFile: "/home/joshua/.omp/sessions/nixos-config/2026-10-07T19-05-52.jsonl",
	sessionTitle: "Bump nixpkgs and fix broken overlays",
	workspaceKind: "worktree",
	desiredState: "stopped",
};

/** RosterEntry list for the App view (`/`): a plausible working sidebar, with no clone, failed, transitional, or reconnecting rows. */
export const rosterAppEntries: RosterEntry[] = [
	sessionMain,
	sessionFixtures,
	sessionAsleep,
	sessionLocalactionMain,
	sessionJobMatrix,
	sessionArtifactPaths,
	sessionNixosMain,
	sessionFlakeUpdate,
];

/** ProjectGroupsData: grouped sessions per project for ProjectGroups; main checkouts first, then worktrees and clones. */
export const rosterSidebarGroups: ProjectGroupsData = [
	{
		project: ompWeb,
		sessions: [
			sessionMain,
			sessionClonePreparing,
			sessionCloneFailed,
			sessionCloneLocal,
			sessionFixtures,
			sessionAsleep,
			sessionStarting,
		],
	},
	{ project: localaction, sessions: [sessionLocalactionMain, sessionReconnecting] },
	{ project: nixosConfig, sessions: [sessionErrorEntry, sessionBlocked] },
];

/** Supervised process rows for the Daemons section, anchored to `now` since a row renders `Date.now() - startedAt`.
    Each row's projectDir and `reportedBy` match the roster session whose broker reports it: the
    design-fixtures worktree (dmn_a002, the seeded selection) and localaction main (dmn_b001). */
export function rosterDaemonInfos(now: number): DaemonInfo[] {
	const designFixtures = `${WORKTREES}/design-fixtures`;
	return [
		{
			name: "vite-dev",
			id: "dmn_p001",
			projectDir: designFixtures,
			reportedBy: ["dmn_a002"],
			state: "running",
			pid: 48211,
			createdAt: now - 25 * MIN,
			startedAt: now - 24 * MIN,
			readyAt: now - 23 * MIN,
			readyPort: 5173,
			readyHost: "127.0.0.1",
			restartCount: 0,
			persist: true,
			detached: false,
		},
		{
			name: "design-server",
			id: "dmn_p002",
			projectDir: designFixtures,
			reportedBy: ["dmn_a002"],
			state: "running",
			pid: 48540,
			createdAt: now - 12 * MIN,
			startedAt: now - 11 * MIN,
			readyAt: now - 11 * MIN + 4_000,
			readyPort: 4799,
			restartCount: 1,
			persist: false,
			detached: false,
		},
		{
			name: "bench-runner",
			id: "dmn_p003",
			projectDir: LOCALACTION,
			reportedBy: ["dmn_b001"],
			state: "restarting",
			pid: 49102,
			createdAt: now - 6 * MIN,
			startedAt: now - 5 * MIN,
			restartCount: 3,
			persist: true,
			detached: true,
		},
		{
			name: "fleet-edge",
			id: "dmn_p004",
			projectDir: designFixtures,
			reportedBy: ["dmn_a002"],
			state: "starting",
			createdAt: now - 20_000,
			startedAt: now - 15_000,
			restartCount: 0,
			persist: false,
			detached: false,
		},
		{
			name: "docs-watch",
			id: "dmn_p005",
			projectDir: designFixtures,
			reportedBy: ["dmn_a002"],
			state: "exited",
			createdAt: now - 90 * MIN,
			startedAt: now - 89 * MIN,
			exitedAt: now - 70 * MIN,
			exitCode: 1,
			restartCount: 2,
			persist: false,
			detached: true,
		},
	];
}

/** PublicProviderProfile list: NewWorkspacePopover run-on profiles and clone-row profile chips. */
export const rosterProviderProfiles: PublicProviderProfile[] = [
	{ id: "bwrap-default", provider: "bwrap", preparation: "fleet", network: "host" },
	{ id: "host-dev", provider: "host", preparation: "fleet" },
	{
		id: "k8s-bench",
		provider: "kubernetes",
		preparation: "provider",
		resources: { cpu: "4", memory: "8Gi" },
		storageClassName: "fast-ssd",
		secretRefNames: ["omp-api-keys"],
	},
];

/** Reset times count from page load, so the sidebar's time-left labels read as live countdowns. */
const USAGE_NOW = Date.now();

/** UsageReport list: one Anthropic, OpenAI Codex, and OpenCode Go account each, with a warning and an exhausted window. */
export const rosterUsageReports: UsageReport[] = [
	{
		provider: "anthropic",
		fetchedAt: USAGE_NOW,
		limits: [
			{
				id: "anthropic:5h",
				label: "Claude 5 Hour",
				scope: { provider: "anthropic", windowId: "5h", shared: true },
				window: {
					id: "5h",
					label: "5 Hour",
					durationMs: 5 * 60 * MIN,
					resetsAt: USAGE_NOW + 95 * MIN,
				},
				amount: { unit: "percent", usedFraction: 0.63 },
				status: "ok",
			},
			{
				id: "anthropic:7d",
				label: "Claude 7 Day",
				scope: { provider: "anthropic", windowId: "7d", shared: true },
				window: {
					id: "7d",
					label: "7 Day",
					durationMs: 7 * DAY,
					resetsAt: USAGE_NOW + 3 * DAY + 4 * 60 * MIN,
				},
				amount: { unit: "percent", usedFraction: 0.82 },
				status: "warning",
			},
			{
				id: "anthropic:7d:fable",
				label: "Claude 7 Day (Fable)",
				scope: { provider: "anthropic", windowId: "7d", tier: "fable" },
				window: {
					id: "7d",
					label: "7 Day",
					durationMs: 7 * DAY,
					resetsAt: USAGE_NOW + 3 * DAY + 4 * 60 * MIN,
				},
				amount: { unit: "percent", usedFraction: 0.27 },
				status: "ok",
			},
		],
		metadata: { email: "joshua@example.com" },
	},
	{
		provider: "openai-codex",
		fetchedAt: USAGE_NOW,
		limits: [
			{
				id: "codex:5h",
				label: "Codex 5 Hour",
				scope: { provider: "openai-codex", windowId: "5h", shared: true },
				window: {
					id: "5h",
					label: "5 Hour",
					durationMs: 5 * 60 * MIN,
					resetsAt: USAGE_NOW + 40 * MIN,
				},
				amount: { unit: "requests", used: 150, limit: 150 },
				status: "exhausted",
			},
			{
				id: "codex:7d",
				label: "Codex 7 Day",
				scope: { provider: "openai-codex", windowId: "7d", shared: true },
				window: {
					id: "7d",
					label: "7 Day",
					durationMs: 7 * DAY,
					resetsAt: USAGE_NOW + 5 * DAY + 11 * 60 * MIN,
				},
				amount: { unit: "percent", usedFraction: 0.46 },
				status: "ok",
			},
		],
	},
	{
		provider: "opencode-go",
		fetchedAt: USAGE_NOW,
		limits: [
			{
				id: "rolling-5h",
				label: "Rolling 5 Hour",
				scope: { provider: "opencode-go", windowId: "5h", shared: true },
				window: {
					id: "5h",
					label: "5 Hour",
					durationMs: 5 * 60 * MIN,
					resetsAt: USAGE_NOW + 3 * 60 * MIN + 12 * MIN,
				},
				amount: { unit: "percent", usedFraction: 0.12 },
				status: "ok",
			},
			{
				id: "weekly",
				label: "Weekly",
				scope: { provider: "opencode-go", windowId: "7d", shared: true },
				window: {
					id: "7d",
					label: "7 Day",
					durationMs: 7 * DAY,
					resetsAt: USAGE_NOW + 6 * DAY + 2 * 60 * MIN,
				},
				amount: { unit: "percent", usedFraction: 0.35 },
				status: "ok",
			},
		],
	},
];

/** WorktreeDeleteInfo: clean, merged, linked worktree; the dialog offers branch deletion. */
export const worktreeInfoClean: WorktreeDeleteInfo = {
	type: "worktree_delete_info",
	workspaceId: "dmn_a003",
	linked: true,
	dirty: false,
	branch: "fix/review-anchors",
	merged: true,
	unpushed: false,
	hasUpstream: true,
};

/** WorktreeDeleteInfo: dirty worktree, so the dialog refuses and lists the change counts. */
export const worktreeInfoDirty: WorktreeDeleteInfo = {
	type: "worktree_delete_info",
	workspaceId: "dmn_a002",
	linked: true,
	dirty: true,
	git: { added: 2, modified: 5, deleted: 0, untracked: 3, linesAdded: 412, linesDeleted: 18 },
	branch: "feat/design-fixtures",
	merged: false,
	unpushed: true,
	files: [
		"src/fleet/worktrees.ts",
		"src/web/DeleteWorkspaceDialog.tsx",
		"src/web/NewWorkspacePopover.tsx",
		"docs/ux-audit.txt",
		"scratch/notes.md",
		"scratch/fixtures.json",
	],
	reason: "commit or stash the changes first",
};

/** WorktreeDeleteInfo: not a linked Git worktree; the dialog refuses it. */
export const worktreeInfoNotLinked: WorktreeDeleteInfo = {
	type: "worktree_delete_info",
	workspaceId: "dmn_a007",
	linked: false,
	dirty: false,
	reason: "This is not a linked Git worktree omp-web can delete; its files stay on disk.",
};

/** SessionListEntry list per session for the worktree sessions dialog, newest first. */
export function rosterSessions(now: number): SessionListEntry[] {
	return [
		{
			path: "/home/joshua/.omp/sessions/omp-web/2026-10-09T09-40-12.jsonl",
			id: "sess_9d2c41aa",
			name: "Design-system fixture modules",
			cwd: `${WORKTREES}/design-fixtures`,
			modifiedAt: now - 4 * MIN,
			messageCount: 64,
		},
		{
			path: "/home/joshua/.omp/sessions/omp-web/2026-10-08T16-02-33.jsonl",
			id: "sess_7b10e2f3",
			name: "Anchor migration for stale annotations",
			cwd: `${WORKTREES}/design-fixtures`,
			modifiedAt: now - 18 * 60 * MIN,
			messageCount: 112,
		},
		{
			path: "/home/joshua/.omp/sessions/omp-web/2026-10-07T11-27-09.jsonl",
			id: "sess_41c0d9a8",
			cwd: `${WORKTREES}/design-fixtures`,
			modifiedAt: now - 2 * DAY,
			messageCount: 9,
		},
	];
}

/** Store fields every roster story needs: a connected fleet with the projects, roster and provider profiles above. */
export const rosterFleetState = {
	connected: true,
	authStatus: "disabled",
	sidebarVisible: true,
	registeredProjects: rosterProjects,
	sessionRoster: rosterEntries,
	// The seeded roster is the first roster frame: rows present now never animate in.
	rosterLoaded: true,
	providerProfiles: rosterProviderProfiles,
	fleetConfigPath: "/home/joshua/.config/omp-web/fleet.json",
	currentWorkspaceId: "dmn_a002",
	usageReports: rosterUsageReports,
	sidebarUsage: true,
	// dmn_a001 is mid-turn, dmn_c002 waits on a dialog; dmn_b001 is marked unread by seedRosterFleet (roster-seed.ts).
	sessionActivity: {
		dmn_a001: { streaming: true, blocked: false },
		dmn_c002: { streaming: false, blocked: true },
	},
} satisfies Partial<typeof state>;

/** Map of supervised processes keyed like state.daemons, for the Daemons section seeds. */
export function rosterDaemonMap(now: number): Map<string, DaemonInfo> {
	return new Map(rosterDaemonInfos(now).map((info) => [daemonsKey(info), info]));
}
