import { For, Show, type Component } from "solid-js";
import { buildDiffRows } from "../../diff";
import { state, type ToolItem } from "../../state";
import { GenericToolCard } from "./GenericToolCard";

interface WriteArgs {
	path: string;
	content: string;
}
interface EditArgs {
	path: string;
	edits: Array<{ oldText: string; newText: string }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseWrite(args: unknown): WriteArgs | null {
	const r = asRecord(args);
	if (r && typeof r.path === "string" && typeof r.content === "string") return { path: r.path, content: r.content };
	return null;
}

function parseEdit(args: unknown): EditArgs | null {
	const r = asRecord(args);
	if (!r || typeof r.path !== "string") return null;
	const isPair = (e: unknown): e is { oldText: string; newText: string } => {
		const p = asRecord(e);
		return !!p && typeof p.oldText === "string" && typeof p.newText === "string";
	};
	if (Array.isArray(r.edits) && r.edits.length > 0 && r.edits.every(isPair)) return { path: r.path, edits: r.edits };
	if (typeof r.oldText === "string" && typeof r.newText === "string")
		return { path: r.path, edits: [{ oldText: r.oldText, newText: r.newText }] };
	return null;
}

const DiffView: Component<{ oldText: string; newText: string }> = props => (
	<div class="diff-view">
		<For each={buildDiffRows(props.oldText, props.newText)}>
			{row =>
				row.type === "collapse" ? (
					<div class="diff-collapse">… {row.count} unchanged lines</div>
				) : (
					<div class="diff-line" data-type={row.type}>
						<span class="diff-sign">{row.type === "add" ? "+" : row.type === "del" ? "-" : " "}</span>
						{row.text}
					</div>
				)
			}
		</For>
	</div>
);

const WriteView: Component<{ content: string; expanded: boolean }> = props => {
	const lines = () => props.content.split("\n");
	const shown = () => (props.expanded ? lines() : lines().slice(0, 200));
	return (
		<div class="write-view">
			<For each={shown()}>
				{(line, i) => (
					<div class="write-line">
						<span class="line-no">{i() + 1}</span>
						{line}
					</div>
				)}
			</For>
			<Show when={!props.expanded && lines().length > 200}>
				<div class="tool-collapsed-note">{lines().length - 200} more lines (Ctrl+O to expand)</div>
			</Show>
		</div>
	);
};

/** edit/write/apply_patch: inline diff for replacements, numbered content for writes. */
export const DiffTool: Component<{ item: ToolItem }> = props => {
	const edit = () => parseEdit(props.item.args);
	const write = () => (props.item.name === "write" ? parseWrite(props.item.args) : null);
	const expanded = () => state.toolsExpanded || props.item.status === "running";

	return (
		<Show when={edit() || write()} fallback={<GenericToolCard item={props.item} />}>
			<div class="tool-card diff-tool">
				<div class="tool-header">
					<span class="tool-name">
						{props.item.name} {edit()?.path ?? write()?.path}
					</span>
					<span class="tool-status" data-status={props.item.status}>
						{props.item.status}
					</span>
				</div>
				<Show when={edit()}>
					{e => (
						<For each={e().edits}>{(ed: { oldText: string; newText: string }) => <DiffView oldText={ed.oldText} newText={ed.newText} />}</For>
					)}
				</Show>
				<Show when={write()}>{w => <WriteView content={w().content} expanded={expanded()} />}</Show>
			</div>
		</Show>
	);
};
