import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task";
import type { CompletionProbeOptions } from "@oh-my-pi/pi-coding-agent/task/completion-probe";
import type { SessionEntry } from "../session-entry";
import { setSubagentCompletionDeps } from "../subagent-completion";
import {
	clearSubagents,
	handleSubagentLifecycle,
	subagentProgressFields,
} from "../subagent-mirror";

type LifecyclePayload = Parameters<typeof handleSubagentLifecycle>[1];
type Ref = { kind: "sub" | "main"; parentId?: string; session: AgentSession | null };

function sessionWith(probe: boolean): AgentSession {
	return {
		settings: Settings.isolated({ "task.completionProbe": probe }),
	} as unknown as AgentSession;
}

/**
 * An entry whose probe is a recorder: the SDK's timer never runs, the test
 * drives `onEstimate` and reads the gate through `session()`.
 */
function harness(ref: Ref | undefined, sdkProbes = false) {
	const entry = {
		subagentSnapshots: new Map(),
		transcriptSessionFilesBySubagentId: new Map(),
		staleSubagentIds: new Set(),
		handle: {},
	} as unknown as SessionEntry;
	const probes: CompletionProbeOptions[] = [];
	setSubagentCompletionDeps(entry, {
		startProbe: (options) => {
			probes.push(options);
		},
		refOf: () => ref,
		sdkProbes: () => sdkProbes,
	});
	const lifecycle = (status: string) =>
		handleSubagentLifecycle(entry, {
			id: "a1",
			index: 0,
			agent: "task",
			status,
			parentToolCallId: "t1",
		} as LifecyclePayload);
	const fields = (over: Partial<AgentProgress> = {}) =>
		subagentProgressFields(entry, {
			id: "a1",
			status: "running",
			recentTools: [],
			recentOutput: [],
			...over,
		} as AgentProgress);
	return { entry, probes, lifecycle, fields };
}

const child = (probe = true): Ref => ({
	kind: "sub",
	parentId: MAIN_AGENT_ID,
	session: sessionWith(probe),
});

describe("subagent completion estimates", () => {
	test("an estimate lands on the agent's progress until the agent finishes", () => {
		const h = harness(child());
		h.lifecycle("started");
		expect(h.probes).toHaveLength(1);
		expect(h.fields().completionPercent).toBeUndefined();
		h.probes[0].onEstimate({ percent: 40, stage: "writing tests" }, 0.01);
		expect(h.fields()).toMatchObject({ completionPercent: 40, stage: "writing tests" });
		h.probes[0].onEstimate({ percent: 55 }, 0.01);
		expect(h.fields()).toMatchObject({ completionPercent: 55, stage: "writing tests" });
		h.lifecycle("completed");
		expect(h.probes[0].signal.aborted).toBe(true);
		expect(h.fields().completionPercent).toBeUndefined();
	});

	test("probes only the main agent's own subagents while task.completionProbe is on", () => {
		const direct = harness(child());
		direct.lifecycle("started");
		expect(direct.probes[0].session()).not.toBeNull();
		const nested = harness({ kind: "sub", parentId: "Parent", session: sessionWith(true) });
		nested.lifecycle("started");
		expect(nested.probes[0].session()).toBeNull();
		const off = harness(child(false));
		off.lifecycle("started");
		expect(off.probes[0].session()).toBeNull();
		const parked = harness({ kind: "sub", parentId: MAIN_AGENT_ID, session: null });
		parked.lifecycle("started");
		expect(parked.probes[0].session()).toBeNull();
	});

	test("a final yield pins 99% and later estimates do not move it", () => {
		const h = harness(child());
		h.lifecycle("started");
		h.probes[0].onEstimate({ percent: 70, stage: "running tests" }, 0);
		const incremental = { extractedToolData: { yield: [{ type: ["findings"] }] } };
		expect(h.fields(incremental).completionPercent).toBe(70);
		const final = { extractedToolData: { yield: [{ type: ["findings"] }, { type: "report" }] } };
		expect(h.fields(final).completionPercent).toBe(99);
		h.probes[0].onEstimate({ percent: 80, stage: "stale" }, 0);
		expect(h.fields(final)).toMatchObject({ completionPercent: 99, stage: "running tests" });
	});

	test("an estimate the SDK set itself wins, and an interactive SDK host is never probed twice", () => {
		const h = harness(child());
		h.lifecycle("started");
		h.probes[0].onEstimate({ percent: 40 }, 0);
		expect(h.fields({ completionPercent: 12 }).completionPercent).toBe(12);
		const sdk = harness(child(), true);
		sdk.lifecycle("started");
		expect(sdk.probes).toHaveLength(0);
	});

	test("a session change stops every probe", () => {
		const h = harness(child());
		h.lifecycle("started");
		clearSubagents(h.entry);
		expect(h.probes[0].signal.aborted).toBe(true);
	});
});
