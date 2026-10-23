import { describe, expect, test } from "bun:test";
import {
	agentTitle,
	formatCost,
	formatDuration,
	formatTokens,
	shortAgentName,
} from "../subagents/format";
import {
	filterActiveSubagentTree,
	filterSubagentTree,
	flattenSubagentTree,
	summarizeSubagentTree,
} from "../subagents/tree";
import type { SubagentNode, SubagentStatus } from "../store/subagents";

function node(
	id: string,
	options: {
		status?: SubagentStatus;
		agentType?: string;
		tokens?: number;
		cost?: number;
		elapsedMs?: number;
		children?: SubagentNode[];
	} = {},
): SubagentNode {
	return {
		id,
		name: id,
		title: id,
		agentType: options.agentType,
		status: options.status ?? "done",
		metrics: {
			elapsedMs: options.elapsedMs ?? 0,
			tokens: options.tokens ?? 0,
			cost: options.cost ?? 0,
		},
		subtree: { tokens: 0, cost: 0 },
		children: options.children ?? [],
	};
}

describe("flattenSubagentTree", () => {
	test("lists each parent before its children, depth first", () => {
		const forest = [
			node("a", { children: [node("a1"), node("a2", { children: [node("a2x")] })] }),
			node("b"),
		];
		expect(flattenSubagentTree(forest).map((n) => n.id)).toEqual(["a", "a1", "a2", "a2x", "b"]);
	});
});

describe("filterSubagentTree", () => {
	const forest = [
		node("explore", {
			agentType: "explore",
			children: [node("reader", { agentType: "task" })],
		}),
		node("review", { status: "failed", children: [node("lint", { agentType: "lint" })] }),
	];

	test("returns every root for an empty query", () => {
		expect(filterSubagentTree(forest, "  ").map((n) => n.id)).toEqual(["explore", "review"]);
	});

	test("matches on agent type and status case-insensitively", () => {
		expect(filterSubagentTree(forest, "EXPLORE").map((n) => n.id)).toEqual(["explore"]);
		expect(filterSubagentTree(forest, "failed").map((n) => n.id)).toEqual(["review"]);
	});

	test("keeps a non-matching ancestor only when a descendant matches", () => {
		const [kept] = filterSubagentTree(forest, "lint");
		expect(kept?.id).toBe("review");
		expect(kept?.children.map((n) => n.id)).toEqual(["lint"]);
	});

	test("keeps a matching agent's whole subtree", () => {
		const [kept] = filterSubagentTree(forest, "explore");
		expect(kept?.children.map((n) => n.id)).toEqual(["reader"]);
	});
});

describe("filterActiveSubagentTree", () => {
	const forest = () => [
		node("builder", {
			status: "done",
			children: [
				node("mapper", { status: "done" }),
				node("advisor", { status: "running" }),
				node("lint", { status: "pending" }),
				node("review", { status: "failed", children: [node("types", { status: "aborted" })] }),
			],
		}),
		node("docs", { status: "parked" }),
		node("solo", { status: "running" }),
	];

	test("keeps running and pending agents and drops finished leaves", () => {
		const kept = filterActiveSubagentTree(forest());
		expect(flattenSubagentTree(kept).map((n) => n.id)).toEqual([
			"builder",
			"advisor",
			"lint",
			"solo",
		]);
	});

	test("keeps a finished ancestor of a running child with only its kept children", () => {
		const [builder] = filterActiveSubagentTree(forest());
		expect(builder?.id).toBe("builder");
		expect(builder?.status).toBe("done");
		expect(builder?.children.map((n) => n.id)).toEqual(["advisor", "lint"]);
	});

	test("keeps keepId even when finished, and its ancestors", () => {
		const kept = filterActiveSubagentTree(forest(), "types");
		expect(flattenSubagentTree(kept).map((n) => n.id)).toEqual([
			"builder",
			"advisor",
			"lint",
			"review",
			"types",
			"solo",
		]);
	});

	test("returns nothing when no agent is active and none is kept", () => {
		expect(filterActiveSubagentTree([node("a"), node("b", { status: "failed" })])).toEqual([]);
	});

	test("does not mutate the input", () => {
		const input = forest();
		const before = structuredClone(input);
		filterActiveSubagentTree(input, "types");
		expect(input).toEqual(before);
	});
});

describe("summarizeSubagentTree", () => {
	test("counts running and pending as running, failures separately, and sums metrics", () => {
		const forest = [
			node("a", {
				status: "running",
				tokens: 100,
				cost: 0.5,
				elapsedMs: 4000,
				children: [
					node("a1", { status: "failed", tokens: 50, cost: 0.25, elapsedMs: 9000 }),
					node("a2", { status: "pending" }),
				],
			}),
			node("b", { status: "done", tokens: 10, cost: 0.1, elapsedMs: 1000 }),
		];
		expect(summarizeSubagentTree(forest)).toEqual({
			count: 4,
			running: 2,
			failed: 1,
			tokens: 160,
			cost: 0.85,
			elapsedMs: 9000,
		});
	});

	test("is all zeros for an empty forest", () => {
		expect(summarizeSubagentTree([])).toEqual({
			count: 0,
			running: 0,
			failed: 0,
			tokens: 0,
			cost: 0,
			elapsedMs: 0,
		});
	});
});

describe("subagent formatters", () => {
	test("formats durations in ms, seconds, and minutes", () => {
		expect(formatDuration(850)).toBe("850ms");
		expect(formatDuration(12_000)).toBe("12s");
		expect(formatDuration(65_000)).toBe("1m05s");
	});

	test("formats token counts with k and M suffixes", () => {
		expect(formatTokens(842)).toBe("842");
		expect(formatTokens(12_400)).toBe("12.4k");
		expect(formatTokens(1_300_000)).toBe("1.3M");
	});

	test("shows three decimals under a dollar", () => {
		expect(formatCost(0.0421)).toBe("$0.042");
		expect(formatCost(1.5)).toBe("$1.50");
	});
});

describe("shortAgentName", () => {
	test("takes the last dot segment and keeps the dedup suffix", () => {
		expect(shortAgentName("Explorer")).toBe("Explorer");
		expect(shortAgentName("Explorer-2")).toBe("Explorer-2");
		expect(shortAgentName("Parent.Child-3")).toBe("Child-3");
		expect(shortAgentName("A.B.C")).toBe("C");
		expect(shortAgentName("trailing.")).toBe("trailing.");
	});
});

describe("agentTitle", () => {
	test("prefers the description, then the first non-empty assignment line, then the display name", () => {
		expect(agentTitle({ description: " Fix it ", assignments: ["x"], displayName: "task" })).toBe(
			"Fix it",
		);
		expect(agentTitle({ assignments: ["\n  \n  Do the thing \nmore"], displayName: "task" })).toBe(
			"Do the thing",
		);
		expect(agentTitle({ assignments: [undefined, "", "second"], displayName: "task" })).toBe(
			"second",
		);
		expect(agentTitle({ description: "  ", assignments: ["  "], displayName: "task" })).toBe(
			"task",
		);
		expect(
			agentTitle({ assignments: ["# Target\nRepo root (cwd). No edits."], displayName: "task" }),
		).toBe("Repo root (cwd). No edits.");
	});
});
