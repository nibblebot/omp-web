import type { SubagentNode } from "../store/subagents";
import { sumKnown } from "./format";

/** Totals across a set of agents (a fan-out, or the whole forest). */
export interface SubagentTotals {
	count: number;
	running: number;
	failed: number;
	tokens?: number;
	cost?: number;
	elapsedMs: number;
}

/** Every agent in a forest, pre-order (a parent before its children). */
export function flattenSubagentTree(nodes: readonly SubagentNode[]): SubagentNode[] {
	return nodes.flatMap((node) => [node, ...flattenSubagentTree(node.children)]);
}

/**
 * The forest narrowed to agents whose label, type or status contains `query`
 * (case-insensitive). A matching agent keeps its whole subtree; a non-matching
 * ancestor of a match is kept so the path to it stays visible.
 */
export function filterSubagentTree(nodes: readonly SubagentNode[], query: string): SubagentNode[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") return [...nodes];
	return nodes.flatMap((node) => {
		const self = [node.label, node.agentType ?? "", node.status].some((text) =>
			text.toLowerCase().includes(needle),
		);
		if (self) return [node];
		const children = filterSubagentTree(node.children, needle);
		return children.length > 0 ? [{ ...node, children }] : [];
	});
}

/** Totals across every agent in a forest; same definition as the store's `fanoutTotals`. */
export function summarizeSubagentTree(nodes: readonly SubagentNode[]): SubagentTotals {
	const all = flattenSubagentTree(nodes);
	return {
		count: all.length,
		running: all.filter((node) => node.status === "running" || node.status === "pending").length,
		failed: all.filter((node) => node.status === "failed").length,
		tokens: sumKnown(all.map((node) => node.metrics.tokens)),
		cost: sumKnown(all.map((node) => node.metrics.cost)),
		elapsedMs: all.reduce((max, node) => Math.max(max, node.metrics.elapsedMs), 0),
	};
}
