import { createSignal, Index, onMount, Show, type Component, type JSX } from "solid-js";
import type { SubagentNode } from "../../store/subagents";
import { subagentRegionDomId, subagentRowDomId } from "../../subagents/tree";
import { rovingTarget, setRovingTabStop } from "../ui/roving";
import { SubagentTreeRow } from "./SubagentTreeRow";
import "./subagents.css";

/** Keyboard model: Up/Down/Home/End move between agents; Right expands or steps into children; Left collapses or steps to the parent. */
function onTreeKeyDown(e: KeyboardEvent, root: HTMLElement, toggle: (id: string) => void): void {
	const items = [...root.querySelectorAll<HTMLElement>('[role="treeitem"]')];
	const current = items.indexOf(e.target as HTMLElement);
	if (current < 0) return;
	const node = items[current];
	const id = node.dataset.subagentId ?? "";
	const expanded = node.getAttribute("aria-expanded");
	if (e.key === "ArrowRight" && expanded === "false") {
		e.preventDefault();
		toggle(id);
		return;
	}
	if (e.key === "ArrowRight" && expanded === "true") {
		e.preventDefault();
		items[current + 1]?.focus();
		return;
	}
	if (e.key === "ArrowLeft" && expanded === "true") {
		e.preventDefault();
		toggle(id);
		return;
	}
	if (e.key === "ArrowLeft") {
		const parent = node
			.closest('[role="group"]')
			?.parentElement?.querySelector<HTMLElement>('[role="treeitem"]');
		if (parent) {
			e.preventDefault();
			parent.focus();
		}
		return;
	}
	const target = rovingTarget(e.key, "vertical", current, items.length);
	if (target === null) return;
	e.preventDefault();
	setRovingTabStop(items, target);
	items[target].focus();
}

/**
 * Accordion behavior of a tree: at most one agent is expanded, its `body`
 * renders in a region right under its row, and every treeitem reports
 * `aria-selected`. Rows offer Park and Revive in their kebab.
 */
export interface SubagentTreeAccordion {
	expandedId: string | undefined;
	body: (id: string) => JSX.Element;
}

/** Rows for one level. `Index` keys by position so live updates do not remount the focused row. */
const SubagentTreeNodes: Component<{
	nodes: readonly SubagentNode[];
	level: number;
	collapsed: ReadonlySet<string>;
	onToggle: (id: string) => void;
	onOpen: (id: string) => void;
	accordion: SubagentTreeAccordion | undefined;
	rowMenu: boolean | undefined;
}> = (props) => (
	<Index each={props.nodes as SubagentNode[]}>
		{(node) => {
			const expanded = () => !props.collapsed.has(node().id);
			const open = () => props.accordion?.expandedId === node().id;
			return (
				<li role="none" class="subagent-tree-item">
					<SubagentTreeRow
						node={node()}
						level={props.level}
						expanded={expanded()}
						onToggle={() => props.onToggle(node().id)}
						onOpen={props.onOpen}
						selected={props.accordion ? open() : undefined}
						controlsId={open() ? subagentRegionDomId(node().id) : undefined}
						menu={props.rowMenu}
					/>
					{/* Keyed on the id, not the node: live updates rebuild every node object, and
					    re-rendering the body would remount the transcript and re-pin it to the bottom. */}
					<Show when={open() ? node().id : undefined} keyed>
						{(id) => (
							<div
								role="region"
								class="subagent-tree-body"
								id={subagentRegionDomId(id)}
								aria-labelledby={subagentRowDomId(id)}
							>
								{props.accordion?.body(id)}
							</div>
						)}
					</Show>
					{node().children.length > 0 && expanded() ? (
						<ul role="group" class="subagent-tree-group">
							<SubagentTreeNodes
								nodes={node().children}
								level={props.level + 1}
								collapsed={props.collapsed}
								onToggle={props.onToggle}
								onOpen={props.onOpen}
								accordion={props.accordion}
								rowMenu={props.rowMenu}
							/>
						</ul>
					) : null}
				</li>
			);
		}}
	</Index>
);

/**
 * Agent forest as a WAI-ARIA tree. Opening a row calls `onOpen` (the agent
 * pane, or the accordion toggle). Children collapse in local state unless the
 * caller controls it with `collapsed` and `onToggleCollapsed` (the dock keeps
 * them per workspace); `accordion` turns on single-select inline expansion.
 */
export const SubagentTree: Component<{
	nodes: readonly SubagentNode[];
	label: string;
	onOpen: (id: string) => void;
	collapsed?: ReadonlySet<string>;
	onToggleCollapsed?: (id: string) => void;
	accordion?: SubagentTreeAccordion;
	/** Row kebabs (Open in Analysis); default on. */
	rowMenu?: boolean;
}> = (props) => {
	const [ownCollapsed, setOwnCollapsed] = createSignal<ReadonlySet<string>>(new Set());
	let root!: HTMLUListElement;
	const collapsed = () => props.collapsed ?? ownCollapsed();
	const toggle = (id: string) => {
		if (props.onToggleCollapsed) {
			props.onToggleCollapsed(id);
			return;
		}
		setOwnCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	onMount(() => setRovingTabStop([...root.querySelectorAll<HTMLElement>('[role="treeitem"]')], 0));
	return (
		<ul
			ref={(el) => (root = el)}
			class="subagent-tree"
			role="tree"
			aria-label={props.label}
			onKeyDown={(e) => onTreeKeyDown(e, root, toggle)}
		>
			<SubagentTreeNodes
				nodes={props.nodes}
				level={1}
				collapsed={collapsed()}
				onToggle={toggle}
				onOpen={props.onOpen}
				accordion={props.accordion}
				rowMenu={props.rowMenu}
			/>
		</ul>
	);
};
