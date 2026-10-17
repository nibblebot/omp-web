import { describe, expect, test } from "bun:test";
import type { AgentProgress, SubagentProgressPayload } from "@oh-my-pi/pi-coding-agent/task";
import type { SubagentProgressFrame } from "#lib/wire/protocol";
import {
	createProgressCoalescer,
	projectProgress,
	SUBAGENT_PROGRESS_INTERVAL_MS,
} from "../subagent-progress";

function progress(over: Partial<AgentProgress> = {}): AgentProgress {
	return {
		id: "Owl",
		status: "running",
		recentTools: [],
		recentOutput: [],
		...over,
	} as AgentProgress;
}

function update(
	over: Partial<AgentProgress> = {},
	extra: Partial<SubagentProgressPayload> = {},
): SubagentProgressPayload {
	return { index: 0, agent: "task", progress: progress(over), ...extra } as SubagentProgressPayload;
}

/**
 * Manual clock: `schedule` records timers that fire only when `advance` moves
 * time past their deadline. Bun's `Timer` is an opaque handle, so the fake
 * timer is cast once at the boundary and tracked by identity afterwards.
 */
type FakeTimer = { at: number; run: () => void };

function harness() {
	let clock = 0;
	const frames: SubagentProgressFrame[] = [];
	const pending: FakeTimer[] = [];
	const inert = new Set<FakeTimer>();
	const coalescer = createProgressCoalescer({
		emit: (frame) => frames.push(frame),
		now: () => clock,
		schedule: (run, ms) => {
			const timer: FakeTimer = { at: clock + ms, run };
			pending.push(timer);
			return timer as unknown as Timer;
		},
		cancel: (handle) => {
			if (handle === undefined) return;
			inert.add(handle as unknown as FakeTimer);
		},
	});
	return {
		frames,
		coalescer,
		advance(ms: number): void {
			clock += ms;
			for (const timer of pending) {
				if (inert.has(timer) || timer.at > clock) continue;
				inert.add(timer);
				timer.run();
			}
		},
	};
}

describe("projectProgress", () => {
	test("sends the newest tool only and drops the bulk history", () => {
		const projected = projectProgress(
			progress({
				recentTools: [
					{ tool: "read", args: "a.ts", isError: true, endMs: 2000 },
					{ tool: "grep", args: "x", endMs: 1000 },
				],
				recentOutput: ["line"],
			}),
		);
		expect(projected.lastTool).toEqual({ tool: "read", args: "a.ts", isError: true });
		expect(projected).not.toHaveProperty("recentTools");
		expect(projected).not.toHaveProperty("recentOutput");
	});
});

describe("createProgressCoalescer", () => {
	test("the first frame is full and goes out at once", () => {
		const { frames, coalescer } = harness();
		coalescer.offer(update({ description: "scan", currentTool: "bash", tokens: 10 }));
		expect(frames).toHaveLength(1);
		expect(frames[0]?.delta).toBeUndefined();
		expect(frames[0]?.progress).toEqual({
			id: "Owl",
			status: "running",
			description: "scan",
			currentTool: "bash",
			tokens: 10,
		});
		coalescer.dropAll();
	});

	test("a burst sends at most one frame per interval, then flushes the trailing state", () => {
		const { frames, coalescer, advance } = harness();
		for (let i = 0; i < 50; i++) {
			coalescer.offer(update({ currentToolArgs: `v${i}` }));
		}
		expect(frames).toHaveLength(1);
		advance(SUBAGENT_PROGRESS_INTERVAL_MS);
		expect(frames).toHaveLength(2);
		expect(frames[1]?.delta).toBe(true);
		expect(frames[1]?.progress).toEqual({ id: "Owl", currentToolArgs: "v49" });
		coalescer.dropAll();
	});

	test("deltas carry only changed fields, and cleared fields are sent as null", () => {
		const { frames, coalescer, advance } = harness();
		coalescer.offer(update({ currentTool: "bash", currentToolArgs: "ls", tokens: 10 }));
		advance(SUBAGENT_PROGRESS_INTERVAL_MS);
		coalescer.offer(update({ tokens: 25, cost: 0.5 }));
		expect(frames).toHaveLength(2);
		expect(frames[1]?.progress).toEqual({
			id: "Owl",
			currentTool: null,
			currentToolArgs: null,
			tokens: 25,
			cost: 0.5,
		});
		coalescer.dropAll();
	});

	test("unchanged progress sends nothing", () => {
		const { frames, coalescer, advance } = harness();
		coalescer.offer(update({ currentTool: "bash" }));
		advance(SUBAGENT_PROGRESS_INTERVAL_MS);
		coalescer.offer(update({ currentTool: "bash" }));
		expect(frames).toHaveLength(1);
		coalescer.dropAll();
	});

	test("task metadata is sent on the frame where it changes only", () => {
		const { frames, coalescer, advance } = harness();
		coalescer.offer(update({ currentTool: "bash" }, { task: "audit parser" }));
		advance(SUBAGENT_PROGRESS_INTERVAL_MS);
		coalescer.offer(update({ currentTool: "grep" }, { task: "audit parser" }));
		expect(frames[0]?.task).toBe("audit parser");
		expect(frames[1]?.task).toBeUndefined();
		expect(frames[1]?.progress).toEqual({ id: "Owl", currentTool: "grep" });
		coalescer.dropAll();
	});

	test("flush sends the terminal state now, and drop cancels the trailing timer", () => {
		const { frames, coalescer, advance } = harness();
		coalescer.offer(update({ currentTool: "bash" }));
		coalescer.offer(update({ status: "completed", currentTool: undefined }));
		coalescer.flush("Owl");
		expect(frames).toHaveLength(2);
		expect(frames[1]?.progress).toEqual({ id: "Owl", status: "completed", currentTool: null });
		coalescer.drop("Owl");
		advance(SUBAGENT_PROGRESS_INTERVAL_MS);
		expect(frames).toHaveLength(2);
	});

	test("dropAll cancels pending trailing timers for every agent", () => {
		const { frames, coalescer, advance } = harness();
		coalescer.offer(update({ currentTool: "bash" }));
		coalescer.offer(update({ currentTool: "grep" }));
		coalescer.dropAll();
		advance(SUBAGENT_PROGRESS_INTERVAL_MS);
		expect(frames).toHaveLength(1);
	});
});
