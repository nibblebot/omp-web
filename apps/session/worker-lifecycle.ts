// Same-ID lifecycle operations; the SDK owns adoption and coalesced transitions.
import { stat } from "node:fs/promises";
import {
	AgentLifecycleManager,
	type PersistedSubagentReviverFactory,
} from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import {
	AgentRegistry,
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
import type { SessionEntry } from "./session-entry";
import type { SubagentSnapshot } from "./subagent-mirror";

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
	progress?: SubagentSnapshot["progress"];
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

function ownsRef(entry: SessionEntry, ref: AgentRef): boolean {
	if (ref.kind !== "sub" || ref.id === MAIN_AGENT_ID) return false;
	const root = entry.session.sessionFile;
	// File ownership is stronger than reused process-global IDs or parent Main.
	if (ref.sessionFile) return !!root && sessionFileBelongsToRoot(ref.sessionFile, root);
	if (!entry.subagentSnapshots.has(ref.id)) return false;
	const seen = new Set<string>();
	let parent = ref.parentId;
	while (parent && parent !== MAIN_AGENT_ID && !seen.has(parent)) {
		seen.add(parent);
		const ancestor = entry.agentRegistry.get(parent);
		if (!ancestor || ancestor.kind !== "sub") return false;
		if (ancestor.sessionFile) return !!root && sessionFileBelongsToRoot(ancestor.sessionFile, root);
		parent = ancestor.parentId;
	}
	return parent === MAIN_AGENT_ID;
}

/** Register ambient dependencies per owning entry, never capture the first root for every revival. */
export function ensureWorkerReviver(entry: SessionEntry, deps: WorkerReviverDeps): void {
	if (entry.agentRegistry !== AgentRegistry.global()) return;
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

export async function listWorkers(entry: SessionEntry): Promise<WorkerRecord[]> {
	const root = entry.session.sessionFile;
	try {
		if (root) await ensurePersistedRoster(entry.agentRegistry, root);
	} catch {
		/* Preserve authorized in-memory history. */
	}
	const ids = new Set([
		...entry.subagentSnapshots.keys(),
		...entry.transcriptSessionFilesBySubagentId.keys(),
	]);
	for (const ref of entry.agentRegistry.list()) if (ownsRef(entry, ref)) ids.add(ref.id);
	const workers: WorkerRecord[] = [];
	for (const id of ids) {
		if (id === MAIN_AGENT_ID) continue;
		const registered = entry.agentRegistry.get(id);
		if (registered && !ownsRef(entry, registered)) continue;
		const snap = entry.subagentSnapshots.get(id);
		const sessionFile =
			registered?.sessionFile ??
			entry.transcriptSessionFilesBySubagentId.get(id) ??
			snap?.sessionFile ??
			null;
		if (sessionFile && (!root || !sessionFileBelongsToRoot(sessionFile, root))) continue;
		let hasHistory = false;
		if (sessionFile) {
			try {
				hasHistory = (await stat(sessionFile)).isFile();
			} catch {
				/* Missing history stays read-only. */
			}
		}
		const terminal = snap?.status === "completed" || snap?.status === "failed";
		const status = mapStatus(
			registered?.status === "aborted"
				? "aborted"
				: terminal
					? snap.status
					: (registered?.status ?? snap?.status),
		);
		const manager =
			entry.agentRegistry === AgentRegistry.global() ? AgentLifecycleManager.global() : undefined;
		let revivable = false;
		let unavailableReason: string | undefined =
			sessionFile && !hasHistory ? "worker history is missing or inaccessible" : undefined;
		if (status === "parked") {
			const factory = revivers.get(entry);
			if (!hasHistory) unavailableReason = "worker history is missing or inaccessible";
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
		workers.push({
			id,
			sessionId: entry.session.sessionManager.getSessionId(),
			displayName: registered?.displayName ?? snap?.agent ?? id,
			status,
			parentAgentId: registered?.parentId,
			parentToolCallId: snap?.parentToolCallId,
			task: snap?.task,
			assignment: snap?.assignment,
			description: snap?.description,
			progress: snap?.progress,
			sessionFile,
			hasHistory,
			lastActivity: registered?.lastActivity ?? snap?.lastUpdate ?? 0,
			createdAt: registered?.createdAt ?? snap?.lastUpdate ?? 0,
			adopted: !!registered && !!manager?.has(id, registered),
			revivable,
			unavailableReason,
		});
	}
	workers.sort((a, b) => rank[a.status] - rank[b.status] || b.lastActivity - a.lastActivity);
	return workers;
}

async function authorizedWorker(entry: SessionEntry, id: string): Promise<AgentRef> {
	if (id === MAIN_AGENT_ID) throw new Error("Main cannot use worker lifecycle controls");
	const root = entry.session.sessionFile;
	if (root) await ensurePersistedRoster(entry.agentRegistry, root);
	const ref = entry.agentRegistry.get(id);
	if (!ref || !ownsRef(entry, ref)) throw new Error(`worker "${id}" is not owned by this session`);
	if (entry.agentRegistry !== AgentRegistry.global())
		throw new Error("worker lifecycle requires the owning SDK registry");
	return ref;
}

export async function parkWorker(
	entry: SessionEntry,
	agentId: string,
): Promise<WorkerLifecycleResult> {
	const ref = await authorizedWorker(entry, agentId);
	const manager = AgentLifecycleManager.global();
	const snapshot = entry.subagentSnapshots.get(agentId);
	if (
		ref.status === "aborted" ||
		snapshot?.status === "completed" ||
		snapshot?.status === "failed"
	) {
		throw new Error(`worker "${agentId}" is terminal`);
	}
	const adopted = manager.has(agentId, ref);
	const before = ref.status;
	await manager.park(agentId);
	const fresh = entry.agentRegistry.get(agentId);
	if (fresh !== ref || !ownsRef(entry, fresh))
		throw new Error(`worker "${agentId}" changed during parking`);
	const parked = fresh.status === "parked";
	return {
		id: agentId,
		status: mapStatus(fresh.status),
		parked,
		outcome: adopted && before !== "parked" && parked ? "parked" : "noop",
	};
}

export async function reviveWorker(
	entry: SessionEntry,
	agentId: string,
): Promise<WorkerLifecycleResult> {
	const ref = await authorizedWorker(entry, agentId);
	const snapshot = entry.subagentSnapshots.get(agentId);
	if (
		ref.status === "aborted" ||
		snapshot?.status === "completed" ||
		snapshot?.status === "failed"
	) {
		throw new Error(`worker "${agentId}" is terminal and cannot be revived`);
	}
	const before = ref.status;
	if (!ref.session && (!ref.sessionFile || !revivers.has(entry)))
		throw new Error(
			`worker "${agentId}" revival requires its history and initialized dependencies`,
		);
	try {
		await AgentLifecycleManager.global().ensureLive(agentId);
	} catch {
		throw new Error(
			`worker "${agentId}" could not be revived: its history, workspace or runtime dependencies are unavailable, or its lifecycle changed`,
		);
	}
	const fresh = entry.agentRegistry.get(agentId);
	if (fresh !== ref || !ownsRef(entry, fresh) || !fresh.session)
		throw new Error(`worker "${agentId}" changed during revival`);
	return {
		id: agentId,
		status: mapStatus(fresh.status),
		outcome: before === "parked" ? "revived" : "noop",
	};
}

/** Resume is a same-ID revival, never a new spawn or broadcast operation. */
export const resumeWorker = reviveWorker;
