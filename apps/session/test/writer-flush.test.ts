import { afterEach, describe, expect, test } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "../session-entry";
import { flushAllWriters } from "../writer-flush";

const OWNED = "omp-web-writer-owned-test";
const FOREIGN = "omp-web-writer-foreign-test";
afterEach(() => {
	AgentRegistry.global().unregister(OWNED);
	AgentRegistry.global().unregister(FOREIGN);
});

function writers(
	options: { catchup?: boolean; catchupError?: Error; flushError?: Error; paused?: boolean } = {},
) {
	const operations: string[] = [];
	const main = {
		isStreaming: false,
		queuedMessageCount: 0,
		getAdvisorStatusOverview: () => ({
			configured: true,
			advisors: [{ status: options.paused ? "paused" : "idle" }],
		}),
		waitForAdvisorCatchup: async (
			timeoutMs: number,
			drainOptions: { waitThroughRecovery?: boolean },
		) => {
			expect(timeoutMs).toBe(10_000);
			expect(drainOptions).toEqual({ waitThroughRecovery: true });
			operations.push("advisor-card-persisted");
			if (options.catchupError) throw options.catchupError;
			return options.catchup ?? true;
		},
		sessionManager: {
			flush: async () => {
				operations.push("main-flush");
				if (options.flushError) throw options.flushError;
			},
		},
	} as unknown as AgentSession;
	const registry = new AgentRegistry();
	const entry = { session: main, subagentSnapshots: new Map() } as unknown as SessionEntry;
	return { input: { entry, registry }, operations };
}

describe("quiesce writer evidence against current SDK contracts", () => {
	test.each([false, true])(
		"drains advisor cards before main flush, including paused advisors (paused=%s)",
		async (paused) => {
			const { input, operations } = writers({ paused });
			const result = await flushAllWriters(input);
			expect(result.ok).toBe(true);
			expect(result.advisors).toBe(paused ? "inactive" : "caught_up");
			expect(operations).toEqual(["advisor-card-persisted", "main-flush"]);
		},
	);

	test("advisor timeout cannot become deletion evidence or proceed to flush", async () => {
		const { input, operations } = writers({ catchup: false });
		const result = await flushAllWriters(input);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("catch-up timed out");
		expect(operations).toEqual(["advisor-card-persisted"]);
	});

	test("advisor drain failure fails closed instead of falling back to inactive", async () => {
		const { input, operations } = writers({
			paused: true,
			catchupError: new Error("card persistence failed"),
		});
		const result = await flushAllWriters(input);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("card persistence failed");
		expect(operations).toEqual(["advisor-card-persisted"]);
	});

	test("latched main persistence rejection still refuses deletion", async () => {
		const { input } = writers({ flushError: new Error("persistence indeterminate") });
		const result = await flushAllWriters(input);
		expect(result.ok).toBe(false);
		expect(result.error).toContain(
			"main session flush failed: unavailable: persistence indeterminate",
		);
	});

	test("global task writer belonging to this entry blocks quiesce, unrelated tasks do not", async () => {
		const { input, operations } = writers();
		const registry = AgentRegistry.global();
		registry.register({
			id: OWNED,
			displayName: "owned",
			kind: "sub",
			status: "running",
			session: input.entry.session,
		});
		registry.register({
			id: FOREIGN,
			displayName: "foreign",
			kind: "sub",
			status: "running",
			session: input.entry.session,
		});
		input.entry.subagentSnapshots.set(OWNED, { id: OWNED } as never);
		const refused = await flushAllWriters(input);
		expect(refused.ok).toBe(false);
		expect(refused.error).toContain(OWNED);
		expect(operations).toEqual([]);
		registry.unregister(OWNED);
		registry.register({
			id: OWNED,
			displayName: "owned",
			kind: "sub",
			status: "parked",
			session: null,
			sessionFile: "/owned.jsonl",
		});
		const safe = await flushAllWriters(input);
		expect(safe.ok).toBe(true);
		expect(safe.descendants).toEqual([
			{ id: OWNED, kind: "sub", sessionFile: "/owned.jsonl", state: "parked" },
		]);
	});
});
