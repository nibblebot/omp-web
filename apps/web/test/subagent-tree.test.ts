import { describe, expect, test } from "bun:test";
import { formatCost, formatDuration, formatTokens } from "../subagents/format";
import { filterSubagentTree, flattenSubagentTree, summarizeSubagentTree } from "../subagents/tree";
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
		label: id,
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
