import type { Model } from "@oh-my-pi/pi-ai";
import {
	MODEL_ROLE_IDS,
	getKnownRoleIds,
	getRoleInfo,
} from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { getModelPresetNames } from "@oh-my-pi/pi-coding-agent/config/model-presets";
import { resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { cfgModelRoleStorage } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import {
	daemonClientForProject,
	type DaemonBrokerClient,
} from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { cfgTaskAgentModelOverrides } from "@oh-my-pi/pi-coding-agent/task/settings";
import { cfgComputerEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import {
	DAEMON_KEY_SEP,
	daemonsKey,
	type DaemonInfo,
	type ModelRoleCatalogEntry,
	type WebSessionState,
} from "#lib/wire/protocol";
import type { SessionConfig } from "./config";
import { planReviewWaiting } from "./review-plan";
import type { SessionEntry } from "./session-entry";
import { activeModelPreset } from "./model-role-pin";
import { broadcast, broadcastTo } from "./client-delivery";

// ---------------------------------------------------------------------------
// Session state snapshots + the omp hub daemon-broker polling/control client:
// `state` frames (prime + post-mutation) are built from live session getters;
// the daemons roster is polled from the bound project's broker every
// DAEMON_POLL_MS and broadcast only when its serialized form changes, or on a
// DAEMON_HEARTBEAT_MS heartbeat, so late joiners and dropped frames converge.
// The poll runs only while at least one stream is live.
// ---------------------------------------------------------------------------

/**
 * Change gate for the daemons roster. Returns true when the roster must be
 * sent: its serialized form differs from the last sent roster, or the
 * heartbeat has elapsed since it was last sent. `now` is injected for tests.
 */
export function createDaemonRosterGate(
	heartbeatMs: number,
): (roster: DaemonInfo[], now: number) => boolean {
	let last: { serialized: string; sentAt: number } | undefined;
	return (roster, now) => {
		const serialized = JSON.stringify(roster);
		if (last && last.serialized === serialized && now - last.sentAt < heartbeatMs) return false;
		last = { serialized, sentAt: now };
		return true;
	};
}

export interface DaemonBrokerDeps {
	/** Bound project root: the daemon-poll target and roster scoping. */
	config: SessionConfig;
	/** Read the boot readiness timestamp (R8); set by the daemon boot once provider/model/auth resolution completes. */
	getReadyAt: () => number | null;
	/** Additive host-owned capability and attachment binding snapshot. */
	getWebState?: (session: AgentSession) => Pick<WebSessionState, "capabilities" | "sessionScope">;
}

export interface DaemonBroker {
	buildStateSnapshot(entry: SessionEntry): WebSessionState;
	broadcastState(entry: SessionEntry, withStats?: boolean): Promise<void>;
	broadcastAvailableCommands(entry: SessionEntry): Promise<void>;
	daemonInfoWithEndpoint(
		client: DaemonBrokerClient,
		dir: string,
		snap: DaemonSnapshot,
	): Promise<DaemonInfo>;
	startDaemonPoll(): void;
	stopDaemonPoll(): void;
}

/** Structural slice of the session the catalog builder needs (kept narrow for testability). */
export interface ModelRoleCatalogContext {
	settings: AgentSession["settings"];
	availableModels: Model[];
	currentModel: Model | undefined;
}

/**
 * Full role catalog for the roles picker: every known role (built-in +
 * custom) in canonical order with its display metadata, effective assignment,
 * and persisted source. Undefined when no models are available.
 *
 * Unlike buildModelRoles, this lists every role whether or not it resolves;
 * unassigned roles render as "auto-selection applies" rows, and hidden roles
 * are emitted with their hidden flag for the client to filter.
 */
export function buildModelRoleCatalog(
	ctx: ModelRoleCatalogContext,
): WebSessionState["modelRoleCatalog"] {
	const { settings, availableModels, currentModel } = ctx;
	if (availableModels.length === 0) return undefined;
	const catalog: ModelRoleCatalogEntry[] = [];
	for (const role of getKnownRoleIds(settings)) {
		const info = getRoleInfo(role, settings);
		const entry: ModelRoleCatalogEntry = {
			role,
			name: info.name,
			hidden: info.hidden ?? false,
			source: settings.getModelRoleSource(role),
		};
		// Tag-first label parity with the TUI roles panel (model-hub.ts):
		// built-ins carry an uppercase tag; custom roles leave it unset.
		if (info.tag !== undefined) entry.tag = info.tag;
		// The default role falls back to the active model when unassigned
		// (same fallback the SDK's getRoleModelCycle uses).
		const value =
			role === "default"
				? (settings.getModelRole("default") ??
					(currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined))
				: settings.getModelRole(role);
		if (value) {
			const resolved = resolveModelRoleValue(value, availableModels, { settings });
			if (resolved.model) {
				entry.provider = resolved.model.provider;
				entry.id = resolved.model.id;
				// Surface the thinking selector only when it is baked into the
				// role value and resolvable; the "auto" sentinel cannot
				// round-trip through `provider/model:level`.
				if (
					resolved.explicitThinkingLevel &&
					resolved.thinkingLevel !== undefined &&
					resolved.thinkingLevel !== "auto"
				) {
					entry.thinkingLevel = resolved.thinkingLevel;
				}
			}
		}
		catalog.push(entry);
	}
	return catalog;
}

export function createDaemonBroker(deps: DaemonBrokerDeps): DaemonBroker {
	/** Resolved model-role assignments via the SDK's getRoleModelCycle (skips unconfigured/unavailable roles). */
	function buildModelRoles(session: AgentSession): WebSessionState["modelRoles"] {
		// Canonical built-in order, then any custom roles from settings (deduped).
		const customRoles = Object.keys(session.settings.getModelRoles()).filter(
			(role) => !(MODEL_ROLE_IDS as readonly string[]).includes(role),
		);
		const cycle = session.getRoleModelCycle([...MODEL_ROLE_IDS, ...customRoles]);
		if (!cycle) return undefined;
		return cycle.models.map((entry) => ({
			role: entry.role,
			provider: entry.model.provider,
			id: entry.model.id,
		}));
	}

	function buildStateSnapshot(entry: SessionEntry): WebSessionState {
		const session = entry.session;
		const presetNames = getModelPresetNames(session.settings);
		const taskOverride = cfgTaskAgentModelOverrides.get(session.settings).task;
		const taskModel = Array.isArray(taskOverride) ? taskOverride[0] : taskOverride;
		return {
			...deps.getWebState?.(session),
			model: session.model,
			modelRoles: buildModelRoles(session),
			modelRoleCatalog: buildModelRoleCatalog({
				settings: session.settings,
				availableModels: session.getAvailableModels(),
				currentModel: session.model,
			}),
			modelRoleStorage: cfgModelRoleStorage.get(session.settings),
			thinkingLevel: session.thinkingLevel,
			autoThinking: session.isAutoThinking,
			thinkingSelectors: session.getAvailableEffortSelectors(),
			modelPresets:
				presetNames.length > 0
					? { names: presetNames, active: activeModelPreset(session.settings) }
					: undefined,
			taskModel: taskModel || undefined,
			isStreaming: session.isStreaming,
			isCompacting: session.isCompacting,
			sessionFile: session.sessionFile,
			...(session.sessionManager.isSessionOnDisk() ? { sessionPersisted: true as const } : {}),
			sessionId: session.sessionId,
			readyAt: deps.getReadyAt() ?? undefined,
			sessionName: session.sessionName,
			autoCompactionEnabled: session.autoCompactionEnabled,
			autoRetryEnabled: session.autoRetryEnabled,
			messageCount: session.messages.length,
			queuedMessageCount: session.queuedMessageCount + entry.queuedCommands.commands.length,
			pausedQueueCount:
				entry.pausedQueue.length +
				(entry.queuedCommands.paused ? entry.queuedCommands.commands.length : 0),
			todoPhases: session.getTodoPhases(),
			contextUsage: session.getContextUsage(),
			// Phase 9: cheap sync getters, refreshed on every state broadcast.
			goalModeState: session.getGoalModeState(),
			planModeEnabled: session.getPlanModeState()?.enabled ?? false,
			planReviewPending: planReviewWaiting(entry),
			fastModeEnabled: session.isFastModeEnabled(),
			// 18.1.9 turned computer use into an eval prelude gated by the
			// session-scoped `computer.enabled` setting; there is no longer a
			// top-level `computer` tool to query.
			computerToolEnabled: cfgComputerEnabled.get(session.settings),
		};
	}

	async function broadcastState(entry: SessionEntry, withStats = false): Promise<void> {
		const stats = withStats ? entry.session.getSessionStats() : undefined;
		broadcastTo(entry.handle, { type: "state", state: buildStateSnapshot(entry), stats });
	}

	async function broadcastAvailableCommands(entry: SessionEntry): Promise<void> {
		broadcastTo(entry.handle, {
			type: "available_commands",
			commands: await buildAvailableSlashCommands(entry.session),
		});
	}

	const DAEMON_POLL_MS = 3000;
	const DAEMON_HEARTBEAT_MS = 30_000;
	const rosterGate = createDaemonRosterGate(DAEMON_HEARTBEAT_MS);
	let daemonPoll: ReturnType<typeof setInterval> | undefined;

	function daemonInfo(projectDir: string, snap: DaemonSnapshot): DaemonInfo {
		return {
			name: snap.name,
			id: snap.id,
			projectDir,
			state: snap.state,
			pid: snap.pid,
			createdAt: snap.createdAt,
			startedAt: snap.startedAt,
			readyAt: snap.readyAt,
			exitedAt: snap.exitedAt,
			exitCode: snap.exitCode,
			restartCount: snap.restartCount,
			owner: snap.owner,
			persist: snap.persist,
			detached: snap.detached,
		};
	}

	/**
	 * Per-daemon ready endpoint cache keyed by projectDir+name. Daemon ids are
	 * stable across restarts and change only when a NEW daemon record is started
	 * (new spec), so id equality invalidates stale specs.
	 */
	const readyEndpointCache = new Map<string, { id: string; port?: number; host?: string }>();

	/**
	 * Resolve a daemon's ready host/port from its launch spec via the broker
	 * describe op, cached by daemon id. Any failure (daemon died between list and
	 * describe, broker hiccup) resolves undefined without propagating; the next
	 * poll tick retries.
	 */
	async function readyEndpointFor(
		client: DaemonBrokerClient,
		dir: string,
		snap: DaemonSnapshot,
	): Promise<{ port?: number; host?: string } | undefined> {
		const key = daemonsKey({ projectDir: dir, name: snap.name });
		const cached = readyEndpointCache.get(key);
		if (cached?.id === snap.id) return cached;
		try {
			const result = await client.request({ op: "describe", name: snap.name });
			if (result.op !== "describe") return undefined;
			const ready = result.spec.ready;
			const endpoint = { id: snap.id, port: ready?.port, host: ready?.host };
			readyEndpointCache.set(key, endpoint);
			return endpoint;
		} catch {
			// Daemon died between list and describe, or broker hiccup: retry next tick.
			return undefined;
		}
	}

	async function daemonInfoWithEndpoint(
		client: DaemonBrokerClient,
		dir: string,
		snap: DaemonSnapshot,
	): Promise<DaemonInfo> {
		const info = daemonInfo(dir, snap);
		const endpoint = await readyEndpointFor(client, dir, snap);
		if (endpoint?.port !== undefined) {
			info.readyPort = endpoint.port;
			info.readyHost = endpoint.host ?? "127.0.0.1";
		}
		return info;
	}

	/**
	 * Poll the daemon broker for the bound cwd and broadcast the roster when it
	 * changes, or on the heartbeat (see createDaemonRosterGate). A broker failure
	 * yields an empty roster, which is broadcast once on transition, not every tick.
	 */
	async function refreshDaemons(): Promise<void> {
		const dir = deps.config.cwd;
		const merged = new Map<string, DaemonInfo>();
		try {
			const client = await daemonClientForProject(dir);
			const result = await client.request({ op: "list" });
			// Daemon names are unique per project dir only; key by
			// projectDir+name so same-named daemons in different projects both
			// reach the roster (the web client uses the same identity).
			if (result.op === "list") {
				// Describe calls run concurrently; insertion keeps the broker's order.
				const infos = await Promise.all(
					result.daemons.map((snap) => daemonInfoWithEndpoint(client, dir, snap)),
				);
				for (const info of infos)
					merged.set(daemonsKey({ projectDir: dir, name: info.name }), info);
			}
		} catch {
			// Broker unreachable (not started / shut down): empty roster.
		}
		// Drop cached endpoints for project dirs that left the roster scope. The
		// \u0000 separator cannot appear in paths, so a plain prefix check is
		// unambiguous.
		const dirPrefixes = [`${dir}${DAEMON_KEY_SEP}`];
		for (const key of [...readyEndpointCache.keys()]) {
			if (!dirPrefixes.some((prefix) => key.startsWith(prefix))) readyEndpointCache.delete(key);
		}
		const roster = [...merged.values()];
		if (rosterGate(roster, Date.now())) broadcast({ type: "daemons", daemons: roster });
	}

	function startDaemonPoll(): void {
		if (daemonPoll) return;
		daemonPoll = setInterval(() => void refreshDaemons(), DAEMON_POLL_MS);
	}

	function stopDaemonPoll(): void {
		if (!daemonPoll) return;
		clearInterval(daemonPoll);
		daemonPoll = undefined;
	}

	return {
		buildStateSnapshot,
		broadcastState,
		broadcastAvailableCommands,
		daemonInfoWithEndpoint,
		startDaemonPoll,
		stopDaemonPoll,
	};
}
