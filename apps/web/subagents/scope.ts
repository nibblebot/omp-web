/**
 * Status scopes of the subagents roster, mirroring the SDK agent hub's All / Running / Done /
 * Parked. The hub maps its registry statuses `running`, `idle` and `parked` onto the three
 * narrow scopes; the web's statuses map the same way: pending is running not yet started,
 * and a failed task ends idle in the registry, so it is Done. Aborted agents match no narrow
 * scope and show only under All, as in the hub.
 */
import type { SubagentNode, SubagentStatus } from "../store/subagents";
import { isActiveSubagent } from "./tree";

export type SubagentScope = "all" | "running" | "done" | "parked";

/** The scopes in on-screen order. */
export const SUBAGENT_SCOPES: readonly { id: SubagentScope; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "running", label: "Running" },
	{ id: "done", label: "Done" },
	{ id: "parked", label: "Parked" },
];

/** Agents per scope; `all` counts every agent, so it can exceed the sum of the others. */
export type SubagentScopeCounts = Record<SubagentScope, number>;

/** The narrow scope a status belongs to; undefined for statuses only All lists (aborted). */
export function subagentScopeOf(status: SubagentStatus): Exclude<SubagentScope, "all"> | undefined {
	if (isActiveSubagent({ status })) return "running";
	if (status === "done" || status === "failed") return "done";
	if (status === "parked") return "parked";
	return undefined;
}

export function inSubagentScope(status: SubagentStatus, scope: SubagentScope): boolean {
	return scope === "all" || subagentScopeOf(status) === scope;
}

export function emptySubagentScopeCounts(): SubagentScopeCounts {
	return { all: 0, running: 0, done: 0, parked: 0 };
}

/** Adds one agent of `status` to `counts` in place. */
export function tallySubagentScope(counts: SubagentScopeCounts, status: SubagentStatus): void {
	counts.all += 1;
	const scope = subagentScopeOf(status);
	if (scope !== undefined) counts[scope] += 1;
}

/**
 * The forest narrowed to one scope. A non-matching agent stays when a descendant matches, so the
 * path to every listed agent stays readable, and so does an agent in `keepIds` (the expanded ones,
 * whose open conversation must not vanish when the agent changes status). `all` returns the input
 * as is; other scopes return new arrays and never mutate the input nodes.
 */
export function filterSubagentTreeByScope(
	nodes: readonly SubagentNode[],
	scope: SubagentScope,
	keepIds?: ReadonlySet<string>,
): readonly SubagentNode[] {
	return scope === "all" ? nodes : narrow(nodes, scope, keepIds);
}

function narrow(
	nodes: readonly SubagentNode[],
	scope: SubagentScope,
	keepIds: ReadonlySet<string> | undefined,
): SubagentNode[] {
	return nodes.flatMap((node) => {
		const children = narrow(node.children, scope, keepIds);
		const kept =
			children.length > 0 || inSubagentScope(node.status, scope) || keepIds?.has(node.id) === true;
		return kept ? [{ ...node, children }] : [];
	});
}
