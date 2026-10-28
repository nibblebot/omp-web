// Same-ID lifecycle operations; the SDK owns adoption and coalesced transitions.
import { stat } from "node:fs/promises";
import {
	AgentLifecycleManager,
	type PersistedSubagentReviverFactory,
} from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import {
	AgentRegistry,
	isResumable,
	MAIN_AGENT_ID,
	type AgentRef,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	ensurePersistedRoster,
	sessionFileBelongsToRoot,
} from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import type { SubagentProgressFields, SubagentUsageFields } from "#lib/wire/protocol";
import type { SessionEntry } from "./session-entry";
import {
	finishedSubagentMeta,
	finishedSubagentUsage,
	resolveSubagentSessionFile,
	subagentProgressFields,
} from "./subagent-mirror";
import { persistedTaskMeta } from "./subagent-task-meta";
import { transcriptUsage } from "./subagent-transcript-usage";

export type WorkerLifecycleStatus =
	| "running"
	| "idle"
	| "parked"
	| "aborted"
	| "completed"
	| "failed"
	| "unavailable";
export interface WorkerRecord {
	id: string;
	sessionId: string;
	displayName: string;
	status: WorkerLifecycleStatus;
	parentAgentId?: string;
	parentToolCallId?: string;
	sessionFile: string | null;
	hasHistory: boolean;
	lastActivity: number;
	createdAt: number;
	adopted: boolean;
	revivable: boolean;
	unavailableReason?: string;
	task?: string;
	assignment?: string;
	description?: string;
	progress?: SubagentProgressFields;
	/** Last known usage of a finished worker (no live progress); absent when never reported. */
	usage?: SubagentUsageFields;
}
export interface WorkerReviverDeps {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	enableLsp: boolean;
	sessionsDir: string;
}
export interface WorkerLifecycleResult {
	id: string;
	status: WorkerLifecycleStatus;
	parked?: boolean;
	outcome: "parked" | "revived" | "noop";
}
const revivers = new WeakMap<SessionEntry, PersistedSubagentReviverFactory>();
const owners = new Set<SessionEntry>();
let installedManager: AgentLifecycleManager | undefined;

/**
 * Task subagents register in AgentRegistry.global(); the session's private registry holds only Main.
 * The snapshot is dropped on every non-started lifecycle frame, so a parked or finished worker is
 * found through the global registry too, and revival sees the ref the lifecycle manager just replaced.
 */
function workerRef(entry: SessionEntry, id: string): AgentRef | undefined {
	const global = AgentRegistry.global().get(id);
	if (global && (entry.subagentSnapshots.has(id) || ownsRef(entry, global))) return global;
	return entry.agentRegistry.get(id);
}

function ownsRef(entry: SessionEntry, ref: AgentRef): boolean {
	if (entry.subagentSnapshots.has(ref.id)) return true;
	if (ref.kind !== "sub" || ref.id === MAIN_AGENT_ID) return false;
	const root = entry.session.sessionFile;
	// File ownership is stronger than reused process-global IDs or parent Main.
	if (ref.sessionFile) return !!root && sessionFileBelongsToRoot(ref.sessionFile, root);
	if (!entry.subagentSnapshots.has(ref.id)) return false;
	const seen = new Set<string>();
	let parent = ref.parentId;
	while (parent && parent !== MAIN_AGENT_ID && !seen.has(parent)) {
		seen.add(parent);
		const ancestor = workerRef(entry, parent);
		if (!ancestor || ancestor.kind !== "sub") return false;
		if (ancestor.sessionFile) return !!root && sessionFileBelongsToRoot(ancestor.sessionFile, root);
		parent = ancestor.parentId;
	}
	return parent === MAIN_AGENT_ID;
}

/** Register ambient dependencies per owning entry, never capture the first root for every revival. */
export function ensureWorkerReviver(entry: SessionEntry, deps: WorkerReviverDeps): void {
	revivers.set(
		entry,
		createPersistedSubagentReviverFactory({
			session: entry.session,
			authStorage: deps.authStorage,
			modelRegistry: deps.modelRegistry,
			settings: deps.settings,
			enableLsp: deps.enableLsp,
			eventBus: entry.eventBus,
			subagentEventBus: entry.eventBus,
		}),
	);
	owners.add(entry);
	const manager = AgentLifecycleManager.global();
	if (installedManager === manager) return;
	manager.setPersistedSubagentReviverFactory(
		async (ref) => {
			for (const owner of owners) {
				if (ownsRef(owner, ref)) return revivers.get(owner)?.(ref);
			}
			return undefined;
		},
		() => 0,
	);
	installedManager = manager;
}

function mapStatus(raw?: string): WorkerLifecycleStatus {
	if (raw === "pending" || raw === "started") return "running";
	switch (raw) {
		case "running":
		case "idle":
		case "parked":
		case "aborted":
		case "completed":
		case "failed":
			return raw;
		default:
			return "unavailable";
	}
}
const rank: Record<WorkerLifecycleStatus, number> = {
	running: 0,
	idle: 1,
	parked: 2,
	completed: 3,
	failed: 3,
	aborted: 3,
	unavailable: 4,
};

/** Best effort: a roster scan failure leaves the authorized in-memory history, never the call. */
async function refreshPersistedRoster(entry: SessionEntry): Promise<void> {
	const root = entry.session.sessionFile;
	try {
		if (root) await ensurePersistedRoster(entry.agentRegistry, root);
	} catch {
		/* Preserve authorized in-memory history. */
	}
}

/**
 * The transcript file of a worker the roster lists. `undefined` means the file is outside the root
 * session's artifact tree: such a worker is never listed or read. `null` means no file is known.
 */
function workerSessionFile(
	entry: SessionEntry,
	id: string,
	registered: AgentRef | undefined,
): string | null | undefined {
	const root = entry.session.sessionFile;
	const sessionFile =
		registered?.sessionFile ??
		entry.transcriptSessionFilesBySubagentId.get(id) ??
		entry.subagentSnapshots.get(id)?.sessionFile ??
		null;
	if (sessionFile && (!root || !sessionFileBelongsToRoot(sessionFile, root))) return undefined;
	return sessionFile;
}

/** An owned worker's registry ref, or `undefined` for an id this session does not list (including Main). */
function listedWorkerRef(entry: SessionEntry, id: string): { registered?: AgentRef } | undefined {
	if (id === MAIN_AGENT_ID) return undefined;
	const registered = workerRef(entry, id);
	if (registered && !ownsRef(entry, registered)) return undefined;
	if (
		registered ||
		entry.subagentSnapshots.has(id) ||
		entry.transcriptSessionFilesBySubagentId.has(id)
	)
		return { registered };
	return undefined;
}

/**
 * Transcript path for a `getSubagentMessages` / `getSubagentImage` selector. The lifecycle mirror
 * answers while it remembers the agent; after a resume it does not, so the persisted roster answers
 * for every worker `listWorkers` lists, with the same ownership and root-artifact jail. Never an arbitrary path.
 */
export async function resolveTranscriptFile(
	entry: SessionEntry,
	selector: { subagentId?: string; sessionFile?: string },
): Promise<string> {
	try {
		return resolveSubagentSessionFile(entry, selector);
	} catch (mirrorError) {
		await refreshPersistedRoster(entry);
		if (selector.subagentId) {
			const listed = listedWorkerRef(entry, selector.subagentId);
			const file = listed && workerSessionFile(entry, selector.subagentId, listed.registered);
			if (file) return file;
		} else if (selector.sessionFile) {
			const wanted = selector.sessionFile;
			for (const ref of entry.agentRegistry.list()) {
				if (ref.sessionFile !== wanted || !ownsRef(entry, ref)) continue;
				if (workerSessionFile(entry, ref.id, ref) === wanted) return wanted;
			}
		}
		throw mirrorError;
	}
}

/** Where a worker's durable Task call record lives: Main's calls in the root file, a subagent's in its own transcript. */
function parentTranscriptFile(
	entry: SessionEntry,
	parentId: string | undefined,
): string | undefined {
	if (parentId === undefined || parentId === MAIN_AGENT_ID)
		return entry.session.sessionFile ?? undefined;
	const parent = workerRef(entry, parentId);
	const root = entry.session.sessionFile;
	const file = parent?.sessionFile;
	return file && root && sessionFileBelongsToRoot(file, root) ? file : undefined;
}

export async function listWorkers(entry: SessionEntry): Promise<WorkerRecord[]> {
	await refreshPersistedRoster(entry);
	const ids = new Set([
		...entry.subagentSnapshots.keys(),
		...entry.transcriptSessionFilesBySubagentId.keys(),
	]);
	for (const ref of entry.agentRegistry.list()) if (ownsRef(entry, ref)) ids.add(ref.id);
	const rows = await Promise.all(
		[...ids].map(async (id): Promise<WorkerRecord | undefined> => {
			if (id === MAIN_AGENT_ID) return undefined;
			const registered = workerRef(entry, id);
			if (registered && !ownsRef(entry, registered)) return undefined;
			const snap = entry.subagentSnapshots.get(id);
			const sessionFile = workerSessionFile(entry, id, registered);
			if (sessionFile === undefined) return undefined;
			let hasHistory = false;
			if (sessionFile) {
				try {
					hasHistory = (await stat(sessionFile)).isFile();
				} catch {
					/* Missing history stays read-only. */
				}
			}
			// A finished worker stays parkable and revivable. Once the lifecycle has moved it (idle or parked),
			// the live registry state wins; a finished snapshot only stands in for a stale running ref.
			const finished = snap?.status === "completed" || snap?.status === "failed";
			const status = mapStatus(
				registered?.status === "aborted"
					? "aborted"
					: finished && (!registered || registered.status === "running")
						? snap.status
						: (registered?.status ?? snap?.status),
			);
			const manager = AgentLifecycleManager.global();
			let revivable = false;
			let unavailableReason: string | undefined =
				sessionFile && !hasHistory ? "worker history is missing or inaccessible" : undefined;
			// A stopped (aborted) worker resumes from its transcript through the same cold path as a parked one.
			if (status === "parked" || status === "aborted") {
				const factory = revivers.get(entry);
				if (status === "aborted" && registered && !isResumable(registered))
					unavailableReason = "worker was stopped and has no transcript to resume from";
				else if (status === "aborted" && registered?.session)
					unavailableReason = "worker is still shutting down";
				else if (!hasHistory) unavailableReason = "worker history is missing or inaccessible";
				// An adopted worker revives through its own reviver; the persisted factory is the cold path.
				else if (manager && registered && manager.has(id, registered)) revivable = true;
				else if (!manager || !factory || !registered)
					unavailableReason = "worker revival dependencies are unavailable";
				else {
					try {
						revivable = !!(await factory(registered));
					} catch {
						/* Fail closed on inaccessible artifacts. */
					}
					if (!revivable)
						unavailableReason =
							"worker history, persisted contract or workspace is unavailable or nonresumable";
				}
			}
			const finishedMeta = finishedSubagentMeta(entry, id);
			// The mirror has nothing for an agent that finished before a resume; its parent's Task result does.
			const parentFile =
				snap || finishedMeta ? undefined : parentTranscriptFile(entry, registered?.parentId);
			const durable = parentFile ? (await persistedTaskMeta(entry, parentFile)).get(id) : undefined;
			const meta = finishedMeta ?? durable;
			const agentType = snap?.agent ?? meta?.agent ?? registered?.history?.agent;
			return {
				id,
				sessionId: entry.session.sessionManager.getSessionId(),
				// A live ref is named for its agent definition; a roster-restored ref is named for its id, so its recorded type stands in.
				displayName:
					registered && registered.displayName !== id
						? registered.displayName
						: (agentType ?? registered?.displayName ?? id),
				status,
				parentAgentId: registered?.parentId,
				parentToolCallId: snap?.parentToolCallId ?? meta?.parentToolCallId,
				task: snap?.task ?? meta?.task,
				assignment: snap?.assignment ?? meta?.assignment,
				description: snap?.description ?? meta?.description,
				progress:
					snap?.progress === undefined ? undefined : subagentProgressFields(entry, snap.progress),
				usage:
					snap?.progress !== undefined
						? undefined
						: (finishedSubagentUsage(entry, id) ??
							(sessionFile && hasHistory ? await transcriptUsage(sessionFile) : undefined)),
				sessionFile,
				hasHistory,
				lastActivity: registered?.lastActivity ?? snap?.lastUpdate ?? 0,
				createdAt: registered?.createdAt ?? snap?.lastUpdate ?? 0,
				adopted: !!registered && !!manager?.has(id, registered),
				revivable,
				unavailableReason,
			};
		}),
	);
	const workers = rows.filter((row): row is WorkerRecord => row !== undefined);
	workers.sort((a, b) => rank[a.status] - rank[b.status] || b.lastActivity - a.lastActivity);
	return workers;
}

async function authorizedWorker(entry: SessionEntry, id: string): Promise<AgentRef> {
	if (id === MAIN_AGENT_ID) throw new Error("Main cannot use worker lifecycle controls");
	const root = entry.session.sessionFile;
	if (root) await ensurePersistedRoster(entry.agentRegistry, root);
	const ref = workerRef(entry, id);
	if (!ref || !ownsRef(entry, ref)) throw new Error(`worker "${id}" is not owned by this session`);
	return ref;
}

/** Parking disposes a live adopted session. A worker without one has nothing to park, so the request fails instead of reporting success. */
export class WorkerNotAdoptedError extends Error {
	readonly code = "worker_not_adopted" as const;
}

export async function parkWorker(
	entry: SessionEntry,
	agentId: string,
): Promise<WorkerLifecycleResult> {
	const ref = await authorizedWorker(entry, agentId);
	const manager = AgentLifecycleManager.global();
	// Parking disposes a live session. A stopped worker has none, and the SDK never moves an aborted
	// ref to parked (aborted is terminal for its generation), so claiming success would misreport it.
	if (ref.status === "aborted") {
		throw new WorkerNotAdoptedError(
			`worker "${agentId}" was stopped and has no live session to park; revive it to resume`,
		);
	}
	// A parked worker has already released its session; re-parking is a no-op success.
	if (ref.status !== "parked" && !manager.has(agentId, ref)) {
		throw new WorkerNotAdoptedError(`worker "${agentId}" has no live session to park`);
	}
	await manager.park(agentId);
	const fresh = workerRef(entry, agentId);
	if (fresh !== ref || !ownsRef(entry, fresh))
		throw new Error(`worker "${agentId}" changed during parking`);
	const parked = fresh.status === "parked";
	if (!parked) throw new Error(`worker "${agentId}" did not park; its status is ${fresh.status}`);
	return {
		id: agentId,
		status: mapStatus(fresh.status),
		parked,
		outcome: "parked",
	};
}

export async function reviveWorker(
	entry: SessionEntry,
	agentId: string,
): Promise<WorkerLifecycleResult> {
	const ref = await authorizedWorker(entry, agentId);
	const before = ref.status;
	if (!ref.session && (!ref.sessionFile || !revivers.has(entry)))
		throw new Error(
			`worker "${agentId}" revival requires its history and initialized dependencies`,
		);
	try {
		await AgentLifecycleManager.global().ensureLive(agentId);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`worker "${agentId}" could not be revived: ${reason}`);
	}
	const fresh = workerRef(entry, agentId);
	// Revival re-registers the ref, so identity can change; ownership and a live session are the contract.
	if (!fresh || !ownsRef(entry, fresh) || !fresh.session)
		throw new Error(`worker "${agentId}" changed during revival`);
	return {
		id: agentId,
		status: mapStatus(fresh.status),
		outcome: before === "parked" || before === "aborted" ? "revived" : "noop",
	};
}
