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

/** DOM id of an agent's tree row button; the accordion region is labelled by it. */
export function subagentRowDomId(id: string): string {
	return `subagent-row-${id}`;
}

/** DOM id of an agent's expanded accordion region; the row's `aria-controls` names it. */
export function subagentRegionDomId(id: string): string {
	return `subagent-region-${id}`;
}

/** Every agent in a forest, pre-order (a parent before its children). */
export function flattenSubagentTree(nodes: readonly SubagentNode[]): SubagentNode[] {
	return nodes.flatMap((node) => [node, ...flattenSubagentTree(node.children)]);
}

/**
 * The forest narrowed to agents whose id, title, type or status contains `query`
 * (case-insensitive). A matching agent keeps its whole subtree; a non-matching
 * ancestor of a match is kept so the path to it stays visible.
 */
export function filterSubagentTree(nodes: readonly SubagentNode[], query: string): SubagentNode[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") return [...nodes];
	return nodes.flatMap((node) => {
		const self = [node.id, node.title, node.agentType ?? "", node.status].some((text) =>
			text.toLowerCase().includes(needle),
		);
		if (self) return [node];
		const children = filterSubagentTree(node.children, needle);
		return children.length > 0 ? [{ ...node, children }] : [];
	});
}

/** Active = running or pending: what every "running" count and the Running scope mean. */
export function isActiveSubagent(node: Pick<SubagentNode, "status">): boolean {
	return node.status === "running" || node.status === "pending";
}

/**
 * Remembered order for one task card: an active agent (running or pending) keeps the
 * place it was first seen in, and settled agents (done, failed, aborted, parked) sit on
 * top in the order they settled. The input's `startedAt` order is not stable (live
 * frames, the roster and a mirror reload stamp it from different clocks), so agents that
 * started close together would swap on updates. A revived agent returns to its first-seen
 * place. Applies at every level and returns new arrays, but an agent that did not change keeps its
 * ordered copy, so rows keyed on node identity see only what moved; one instance per card.
 */
export function createStableSubagentOrder(): (nodes: readonly SubagentNode[]) => SubagentNode[] {
	const seen = new Map<string, number>();
	const settled = new Map<string, number>();
	// The ordered copy of a node, reused while the node and its ordered children are the same objects.
	const copies = new WeakMap<SubagentNode, SubagentNode>();
	let settleCount = 0;
	const sameNodes = (a: readonly SubagentNode[], b: readonly SubagentNode[]) =>
		a.length === b.length && a.every((node, i) => node === b[i]);
	const order = (nodes: readonly SubagentNode[]): SubagentNode[] => {
		for (const node of nodes) {
			if (!seen.has(node.id)) seen.set(node.id, seen.size);
			if (isActiveSubagent(node)) settled.delete(node.id);
		}
		const newlySettled = nodes
			.filter((node) => !isActiveSubagent(node) && !settled.has(node.id))
			.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
		for (const node of newlySettled) settled.set(node.id, settleCount++);
		return nodes
			.map((node) => {
				const children = order(node.children);
				const copy = copies.get(node);
				if (copy !== undefined && sameNodes(copy.children, children)) return copy;
				const next = { ...node, children };
				copies.set(node, next);
				return next;
			})
			.sort((a, b) => {
				const aSettled = settled.get(a.id);
				const bSettled = settled.get(b.id);
				if (aSettled !== undefined && bSettled !== undefined) return aSettled - bSettled;
				if (aSettled !== undefined) return -1;
				if (bSettled !== undefined) return 1;
				return (seen.get(a.id) ?? 0) - (seen.get(b.id) ?? 0);
			});
	};
	return order;
}

/** Totals across every agent in a forest; same definition as the store's `fanoutTotals`. */
export function summarizeSubagentTree(nodes: readonly SubagentNode[]): SubagentTotals {
	const all = flattenSubagentTree(nodes);
	return {
		count: all.length,
		running: all.filter(isActiveSubagent).length,
		failed: all.filter((node) => node.status === "failed").length,
		tokens: sumKnown(all.map((node) => node.metrics.tokens)),
		cost: sumKnown(all.map((node) => node.metrics.cost)),
		elapsedMs: all.reduce((max, node) => Math.max(max, node.metrics.elapsedMs), 0),
	};
}
