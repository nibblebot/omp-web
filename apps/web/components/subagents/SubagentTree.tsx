import { createSignal, Index, onMount, type Component } from "solid-js";
import type { SubagentNode } from "../../store/subagents";
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

/** Rows for one level. `Index` keys by position so live updates do not remount the focused row. */
const SubagentTreeNodes: Component<{
	nodes: readonly SubagentNode[];
	level: number;
	collapsed: ReadonlySet<string>;
	onToggle: (id: string) => void;
	onOpen: (id: string) => void;
}> = (props) => (
	<Index each={props.nodes as SubagentNode[]}>
		{(node) => {
			const expanded = () => !props.collapsed.has(node().id);
			return (
				<li role="none" class="subagent-tree-item">
					<SubagentTreeRow
						node={node()}
						level={props.level}
						expanded={expanded()}
						onToggle={() => props.onToggle(node().id)}
						onOpen={props.onOpen}
					/>
					{node().children.length > 0 && expanded() ? (
						<ul role="group" class="subagent-tree-group">
							<SubagentTreeNodes
								nodes={node().children}
								level={props.level + 1}
								collapsed={props.collapsed}
								onToggle={props.onToggle}
								onOpen={props.onOpen}
							/>
						</ul>
					) : null}
				</li>
			);
		}}
	</Index>
);

/** Agent forest as a WAI-ARIA tree. Opening a row calls `onOpen` (the agent pane). */
export const SubagentTree: Component<{
	nodes: readonly SubagentNode[];
	label: string;
	onOpen: (id: string) => void;
}> = (props) => {
	const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
	let root!: HTMLUListElement;
	const toggle = (id: string) => {
		setCollapsed((prev) => {
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
			/>
		</ul>
	);
};
