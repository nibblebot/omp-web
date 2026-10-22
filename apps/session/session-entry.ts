import type { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { CollabHostAdapter } from "./collab-host";
import type { QueuedCommandState } from "./command-queue";
import type { HeldQueuedMessage } from "./queue-hold";
import type { ClientConsumer } from "./client-delivery";
import type { SubagentSnapshot } from "./subagent-mirror";

// ---------------------------------------------------------------------------
// Session registry types: the single boot session. omp-session is de-muxed
// (Phase 6): there is exactly one SessionEntry and every web socket is
// attached to it from upgrade. The handle "s1" survives only as the attached
// frame's client guard token. Per-session AgentRegistry/EventBus/SessionManager
// (Phase 1 factory) keeps subagent rosters namespaced per session; ui_request
// pending maps and the subagent mirror live here too.
// ---------------------------------------------------------------------------

export interface SessionEntry {
	handle: string;
	cwd: string;
	session: AgentSession;
	/** SDK MCP manager for this session; undefined when MCP discovery is not wired. */
	mcpManager?: MCPManager;
	agentRegistry: AgentRegistry;
	eventBus: EventBus;
	slashRuntime: SlashCommandRuntime;
	pendingUiRequests: Map<
		string,
		{
			streams: Set<ClientConsumer>;
			/** The dialog as sent, so a client that attaches later is primed with it. */
			method?: string;
			params?: unknown;
			resolve: (value: unknown) => void;
			reject: (err: Error) => void;
		}
	>;
	subagentSnapshots: Map<string, SubagentSnapshot>;
	transcriptSessionFilesBySubagentId: Map<string, string>;
	staleSubagentIds: Set<string>;
	/** User messages a Stop withdrew from the queue; held until resumed, run, edited, or deleted. */
	pausedQueue: HeldQueuedMessage[];
	/** Slash commands the SDK rejected while a turn ran; they run in order at turn end (see command-queue.ts). */
	queuedCommands: QueuedCommandState;
	/** The slash command currently running; its reply notices carry it as `command` (CMD-09). */
	activeCommand: string | null;
	/**
	 * Collab host state: the live adapter (null when not live), the start-in-flight flag,
	 * and the reason collab last could not run (shown to clients until the next start).
	 */
	collab: { adapter: CollabHostAdapter | null; starting: boolean; refusal: string | null };
	/** Fired by the subagent mirror when the roster may have changed (collab agents tap). */
	onSubagentsChange: (() => void) | null;
	/** Unsubscribes the `disabledExtensions` listener (skill-methods `watchSkills`); undefined until wired. */
	skillsUnlisten?: () => void;
}

/** The single boot session's constant handle: the attached frame's client guard token. */
export const BOOT_HANDLE = "s1";
