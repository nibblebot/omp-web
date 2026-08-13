import { isZodSchema, zodToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { MODEL_ROLE_IDS } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { daemonClientForProject, type DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonSnapshot } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import {
	DAEMON_KEY_SEP,
	daemonsKey,
	type DaemonInfo,
	type WebSessionState,
} from "../shared/protocol";
import type { SessionConfig } from "./config";
import type { SessionEntry } from "./session-entry";
import { broadcast, broadcastTo } from "./sse-delivery";

// ---------------------------------------------------------------------------
// Session state snapshots + the omp hub daemon-broker polling/control client:
// `state` frames (prime + post-mutation) are built from live session getters;
// the daemons roster is polled from the bound project's broker every
// DAEMON_POLL_MS and re-broadcast unconditionally (a change-gate would strand
// clients that connect between broadcasts — the roster is small and the tick
// cadence is 3s, so unconditional re-broadcast self-heals late joins and
// dropped frames). The poll runs only while at least one stream is live.
// ---------------------------------------------------------------------------

export interface DaemonBrokerDeps {
	/** Bound project root: the daemon-poll target and roster scoping. */
	config: SessionConfig;
	/** Read the boot readiness timestamp (R8); set by the daemon boot once provider/model/auth resolution completes. */
	getReadyAt: () => number | null;
}

export interface DaemonBroker {
	buildStateSnapshot(session: AgentSession): WebSessionState;
	broadcastState(entry: SessionEntry, withStats?: boolean): Promise<void>;
	broadcastAvailableCommands(entry: SessionEntry): Promise<void>;
	daemonInfoWithEndpoint(client: DaemonBrokerClient, dir: string, snap: DaemonSnapshot): Promise<DaemonInfo>;
	startDaemonPoll(): void;
	stopDaemonPoll(): void;
}

export function createDaemonBroker(deps: DaemonBrokerDeps): DaemonBroker {
	/** Resolved model-role assignments via the SDK's getRoleModelCycle (skips unconfigured/unavailable roles). */
	function buildModelRoles(session: AgentSession): WebSessionState["modelRoles"] {
		// Canonical built-in order, then any custom roles from settings (deduped).
		const customRoles = Object.keys(session.settings.getModelRoles()).filter(
			role => !(MODEL_ROLE_IDS as readonly string[]).includes(role),
		);
		const cycle = session.getRoleModelCycle([...MODEL_ROLE_IDS, ...customRoles]);
		if (!cycle) return undefined;
		return cycle.models.map(entry => ({ role: entry.role, provider: entry.model.provider, id: entry.model.id }));
	}

	function buildStateSnapshot(session: AgentSession): WebSessionState {
		return {
			model: session.model,
			modelRoles: buildModelRoles(session),
			thinkingLevel: session.thinkingLevel,
			isStreaming: session.isStreaming,
			isCompacting: session.isCompacting,
			steeringMode: session.steeringMode,
			followUpMode: session.followUpMode,
			interruptMode: session.interruptMode,
			sessionFile: session.sessionFile,
			sessionId: session.sessionId,
			readyAt: deps.getReadyAt() ?? undefined,
			sessionName: session.sessionName,
			autoCompactionEnabled: session.autoCompactionEnabled,
			autoRetryEnabled: session.autoRetryEnabled,
			messageCount: session.messages.length,
			queuedMessageCount: session.queuedMessageCount,
			todoPhases: session.getTodoPhases(),
			systemPrompt: session.systemPrompt,
			dumpTools: session.agent.state.tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				parameters: isZodSchema(tool.parameters) ? zodToWireSchema(tool.parameters) : tool.parameters,
				examples: tool.examples,
			})),
			contextUsage: session.getContextUsage(),
			// Phase 9: cheap sync getters — refreshed on every state broadcast.
			goalModeState: session.getGoalModeState(),
			planModeEnabled: session.getPlanModeState()?.enabled ?? false,
			fastModeEnabled: session.isFastModeEnabled(),
			computerToolEnabled: session.getActiveToolNames().includes("computer"),
			inspectImageMode: session.inspectImageState().mode,
		};
	}

	async function broadcastState(entry: SessionEntry, withStats = false): Promise<void> {
		const stats = withStats ? entry.session.getSessionStats() : undefined;
		broadcastTo(entry.handle, { type: "state", state: buildStateSnapshot(entry.session), stats });
	}

	async function broadcastAvailableCommands(entry: SessionEntry): Promise<void> {
		broadcastTo(entry.handle, { type: "available_commands", commands: await buildAvailableSlashCommands(entry.session) });
	}

	const DAEMON_POLL_MS = 3000;
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
			exitReason: snap.exitReason,
			restartCount: snap.restartCount,
			outputBytes: snap.outputBytes,
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
	 * describe, broker hiccup) resolves undefined without propagating — the next
	 * poll tick retries.
	 */
	async function readyEndpointFor(client: DaemonBrokerClient, dir: string, snap: DaemonSnapshot): Promise<{ port?: number; host?: string } | undefined> {
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

	async function daemonInfoWithEndpoint(client: DaemonBrokerClient, dir: string, snap: DaemonSnapshot): Promise<DaemonInfo> {
		const info = daemonInfo(dir, snap);
		const endpoint = await readyEndpointFor(client, dir, snap);
		if (endpoint?.port !== undefined) {
			info.readyPort = endpoint.port;
			info.readyHost = endpoint.host ?? "127.0.0.1";
		}
		return info;
	}

	/**
	 * Poll the daemon broker for the bound cwd and broadcast the roster every
	 * tick. A change-gate would strand clients that connect between broadcasts
	 * (or miss one frame): the roster is small (~2.5 KB) and the tick cadence is
	 * 3s, so re-broadcasting unconditionally self-heals late joins and dropped
	 * frames. On broker failure the empty roster is broadcast, and the next
	 * successful tick restores the real one.
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
			if (result.op === "list")
				for (const snap of result.daemons) merged.set(daemonsKey({ projectDir: dir, name: snap.name }), await daemonInfoWithEndpoint(client, dir, snap));
		} catch {
			// Broker unreachable (not started / shut down): empty roster.
		}
		// Drop cached endpoints for project dirs that left the roster scope. The
		// \u0000 separator cannot appear in paths, so a plain prefix check is
		// unambiguous.
		const dirPrefixes = [`${dir}${DAEMON_KEY_SEP}`];
		for (const key of [...readyEndpointCache.keys()]) {
			if (!dirPrefixes.some(prefix => key.startsWith(prefix))) readyEndpointCache.delete(key);
		}
		broadcast({ type: "daemons", daemons: [...merged.values()] });
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

	return { buildStateSnapshot, broadcastState, broadcastAvailableCommands, daemonInfoWithEndpoint, startDaemonPoll, stopDaemonPoll };
}
