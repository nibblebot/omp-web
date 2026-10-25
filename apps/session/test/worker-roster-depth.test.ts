/**
 * Nested Task subagents (a subagent spawning a subagent) must reach the root session's worker roster.
 * The SDK routes a spawn tree's lifecycle frames to `subagentEventBus`; a depth-2 spawn emits on its
 * parent's own bus plus that shared bus. The session must listen on the same bus the tree emits to.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@oh-my-pi/pi-coding-agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
import { EventBus, emitSubagentFrame } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createCollabSession } from "../collab-session";
import { listWorkers } from "../worker-lifecycle";

const BRANCH = "omp-web-depth-BranchA";
const LEAF = "omp-web-depth-BranchA.LeafA1";
let dir = "";
let root = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "omp-web-worker-roster-depth-"));
	root = join(dir, "root.jsonl");
	await mkdir(join(dir, "root"));
	await writeFile(root, "");
});

afterEach(async () => {
	AgentRegistry.global().unregister(LEAF);
	AgentRegistry.global().unregister(BRANCH);
	await rm(dir, { recursive: true, force: true });
});

function registerChild(id: string, parentId: string, sessionFile: string): void {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "sub",
		parentId,
		session: null,
		sessionFile,
		status: "idle",
	});
}

function startedFrame(id: string, sessionFile: string, parentToolCallId: string) {
	return {
		id,
		index: 0,
		agent: "task",
		status: "started" as const,
		sessionFile,
		parentToolCallId,
	};
}

describe("worker roster depth", () => {
	test("a depth-2 subagent is listed under its direct parent in the root roster", async () => {
		const branchFile = join(dir, "root", `${BRANCH}.jsonl`);
		const leafFile = join(dir, "root", `${LEAF}.jsonl`);
		await writeFile(branchFile, "");
		await writeFile(leafFile, "");
		registerChild(BRANCH, MAIN_AGENT_ID, branchFile);
		registerChild(LEAF, BRANCH, leafFile);

		let options: Parameters<typeof sdk.createAgentSession>[0] | undefined;
		const create = spyOn(sdk, "createAgentSession").mockImplementation((async (
			opts: Parameters<typeof sdk.createAgentSession>[0],
		) => {
			options = opts;
			return {
				session: {
					sessionFile: root,
					// createSession watches `disabledExtensions` on the session's settings.
					settings: Settings.isolated({}),
					subscribe: () => () => {},
					getEnabledToolNames: () => [],
					getMountedXdevToolNames: () => [],
					setPlanProposalHandler: () => {},
					sessionManager: {
						getSessionId: () => "root-session",
						getCwd: () => dir,
						onSessionNameChanged: () => () => {},
					},
				} as unknown as AgentSession,
				mcpManager: undefined,
				setToolUIContext: () => {},
			};
		}) as never);
		try {
			const collab = createCollabSession({
				config: { idleTimeoutMs: 0 } as never,
				agentDir: dir,
				authStorage: {} as never,
				modelRegistry: {} as never,
				settings: {} as never,
				broker: {
					broadcastState: async () => {},
					broadcastAvailableCommands: async () => {},
				} as never,
			});
			const entry = await collab.createSession(dir);

			// The SDK's spawn tree emits to `subagentEventBus`; when the session passes none, the SDK
			// makes a private one that the session never subscribes to.
			const spawnBus = options?.subagentEventBus ?? new EventBus();
			// Root's Task tool: its own bus is the session's, plus the spawn-tree bus.
			emitSubagentFrame(
				options?.eventBus,
				spawnBus,
				TASK_SUBAGENT_LIFECYCLE_CHANNEL,
				startedFrame(BRANCH, branchFile, "call-root"),
			);
			// BranchA's Task tool: its own bus, plus the spawn-tree bus.
			emitSubagentFrame(
				new EventBus(),
				spawnBus,
				TASK_SUBAGENT_LIFECYCLE_CHANNEL,
				startedFrame(LEAF, leafFile, "call-branch"),
			);

			const workers = await listWorkers(entry);
			expect(workers.map((worker) => worker.id).sort()).toEqual([BRANCH, LEAF].sort());
			expect(workers.find((worker) => worker.id === BRANCH)).toMatchObject({
				parentAgentId: MAIN_AGENT_ID,
				parentToolCallId: "call-root",
			});
			expect(workers.find((worker) => worker.id === LEAF)).toMatchObject({
				parentAgentId: BRANCH,
				parentToolCallId: "call-branch",
			});
		} finally {
			create.mockRestore();
		}
	});
});
