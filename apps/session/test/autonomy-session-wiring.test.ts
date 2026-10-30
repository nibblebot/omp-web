/**
 * Autonomy loop wiring at the host-abort and transcript-change boundaries
 * (apps/session/autonomy-adapter.ts). The SDK goal controller is minified and
 * needs a real AgentSession, so it is replaced by a recorder; the assertions are
 * on the order of hook calls made by the real web rows and on the loop state the
 * adapter adopts after a change.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SessionEntry } from "../session-entry";
import { installPlanReviewHandler } from "../review-plan";

const log: string[] = [];

class RecordingGoalController {
	constructor(_session: unknown) {}
	async reconcile(): Promise<void> {}
	observe(): void {}
	stopForHostAbort(): void {
		log.push("stopForHostAbort");
	}
	async beginSessionChange(): Promise<void> {
		log.push("beginSessionChange");
	}
	async endSessionChange(options?: { detachedRun?: boolean }): Promise<void> {
		log.push(`endSessionChange:${options?.detachedRun === true}`);
	}
}

mock.module("@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal", () => ({
	RpcGoalController: RecordingGoalController,
}));

// Dynamic imports: the goal mock must be registered before the adapter binds to it.
const { createWebMethods } = await import("../methods");
const { getAutonomyAdapter } = await import("../autonomy-adapter");

/** A session stub whose transcript id and branch follow the switches the rows perform. */
function stubEntry(sessionId: string): { entry: SessionEntry; state: { id: string } } {
	const state = { id: sessionId };
	// Each transcript owns its own branch: a record written to one must not appear in another.
	const branches = new Map<string, unknown[]>();
	const branch = (): unknown[] => {
		let records = branches.get(state.id);
		if (!records) {
			records = [];
			branches.set(state.id, records);
		}
		return records;
	};
	const session = {
		get sessionId() {
			return state.id;
		},
		get sessionFile() {
			return `/tmp/${state.id}.jsonl`;
		},
		sessionManager: {
			getSessionId: () => state.id,
			getBranch: () => branch(),
			appendCustomEntry: (customType: string, data: unknown) => {
				branch().push({ type: "custom", customType, data });
			},
			flush: async () => {},
		},
		subscribe: () => () => {},
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		isEvalRunning: false,
		hasPostPromptWork: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
		isSessionTransitioning: false,
		isDisposed: false,
		getPlanModeState: () => undefined,
		getVibeModeState: () => undefined,
		getGoalModeState: () => undefined,
		setPlanModeState: () => {},
		clearQueue: () => ({ steering: [], followUp: [] }),
		getEnabledToolNames: () => [],
		getMountedXdevToolNames: () => [],
		getAllToolNames: () => [],
		setPlanProposalHandler: () => {},
		abort: async () => {
			log.push("abort");
		},
		waitForIdle: async () => {},
		newSession: async () => {
			log.push("newSession");
			return true;
		},
		switchSession: async (target: string) => {
			log.push(`switchSession:${target}`);
			state.id = target;
			return true;
		},
		promptCustomMessage: async () => true,
	};
	const entry = {
		handle: "s1",
		cwd: "/tmp/fleet-test-cwd",
		session,
		pausedQueue: [],
		queuedCommands: { commands: [], paused: false },
		pendingUiRequests: new Map(),
		subagentSnapshots: new Map(),
		transcriptSessionFilesBySubagentId: new Map(),
		staleSubagentIds: new Set(),
		collab: { adapter: null, starting: false, refusal: null },
		onSubagentsChange: null,
	} as unknown as SessionEntry;
	installPlanReviewHandler(entry);
	return { entry, state };
}

function methodsTable() {
	return createWebMethods({
		settings: {} as never,
		authStorage: {} as never,
		collab: { stopRoom: async () => {}, abortSubagent: async () => {} } as never,
		broker: { broadcastAvailableCommands: async () => {} } as never,
		materializeSession: async () => ({ alreadyPresent: true as const }),
		sessionsDir: "/tmp/fleet-test-sessions",
		cwd: "/tmp/fleet-test-cwd",
		hasCallbackPair: () => false,
	}).methods;
}

beforeEach(() => {
	log.length = 0;
});

describe("autonomy hooks at the web rows", () => {
	test("a host abort stops goal continuation before the abort starts", async () => {
		const { entry } = stubEntry("s-old");
		await methodsTable().abort!(entry, []);
		expect(log).toEqual(["stopForHostAbort", "abort"]);
	});

	test("switching sessions brackets the transcript change with begin and end", async () => {
		const { entry } = stubEntry("s-old");
		await methodsTable().switchSession!(entry, ["/tmp/s-new.jsonl"]);
		expect(log).toEqual([
			"beginSessionChange",
			"switchSession:/tmp/s-new.jsonl",
			"endSessionChange:true",
		]);
	});

	test("a new session stops the run, then brackets the transcript change", async () => {
		const { entry } = stubEntry("s-old");
		await methodsTable().newSession!(entry, []);
		expect(log).toEqual(["abort", "beginSessionChange", "newSession", "endSessionChange:true"]);
	});
});

describe("autonomy loop state across a transcript change", () => {
	test("a running loop pauses at the change and the new transcript never inherits it", async () => {
		const { entry, state } = stubEntry("s-old");
		const adapter = getAutonomyAdapter(entry);
		adapter.start({ argsText: "3 keep going", consent: true });
		expect(adapter.snapshot().status).toBe("running");

		await adapter.beginSessionChange();
		expect(adapter.snapshot().status).toBe("paused");

		state.id = "s-new";
		await adapter.endSessionChange({ detachedRun: true });
		expect(adapter.snapshot().status).toBe("inactive");

		// Switching back restores the paused loop recorded in the original transcript.
		state.id = "s-old";
		await adapter.endSessionChange({ detachedRun: true });
		expect(adapter.snapshot().status).toBe("paused");
		adapter.dispose();
	});
});
