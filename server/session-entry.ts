import type { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { CollabHostAdapter } from "./collab-host";
import type { SseConsumer } from "./sse-delivery";
import type { SubagentSnapshot } from "./subagent-mirror";

// ---------------------------------------------------------------------------
// Session registry types: the single boot session. omp-session is de-muxed
// (Phase 6) — there is exactly one SessionEntry and every web socket is
// attached to it from upgrade. The handle "s1" survives only as the attached
// frame's client guard token. Per-session AgentRegistry/EventBus/SessionManager
// (Phase 1 factory) keeps subagent rosters namespaced per session; ui_request
// pending maps and the subagent mirror live here too.
// ---------------------------------------------------------------------------

export interface SessionEntry {
	handle: string;
	cwd: string;
	session: AgentSession;
	agentRegistry: AgentRegistry;
	eventBus: EventBus;
	slashRuntime: SlashCommandRuntime;
	pendingUiRequests: Map<
		string,
		{ streams: Set<SseConsumer>; resolve: (value: unknown) => void; reject: (err: Error) => void }
	>;
	subagentSnapshots: Map<string, SubagentSnapshot>;
	transcriptSessionFilesBySubagentId: Map<string, string>;
	staleSubagentIds: Set<string>;
	/** Collab host state: the live adapter (null when not live) plus the start-in-flight flag. */
	collab: { adapter: CollabHostAdapter | null; starting: boolean };
	/** Fired by the subagent mirror when the roster may have changed (collab agents tap). */
	onSubagentsChange: (() => void) | null;
}

/** The single boot session's constant handle: the attached frame's client guard token. */
export const BOOT_HANDLE = "s1";
