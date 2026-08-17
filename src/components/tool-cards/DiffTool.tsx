import { For, Show, type Component } from "solid-js";
import { buildDiffRows } from "../../diff";
import { type ToolItem } from "../../state";
import { GenericToolCard } from "./GenericToolCard";
import { CollapsiblePre, ToolShell, WRITE_PREVIEW_LINES } from "./ToolShell";

interface WriteArgs {
	path: string;
	content: string;
}
interface EditArgs {
	path: string;
	edits: Array<{ oldText: string; newText: string }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parseWrite(args: unknown): WriteArgs | null {
	const r = asRecord(args);
	if (r && typeof r.path === "string" && typeof r.content === "string")
		return { path: r.path, content: r.content };
	return null;
}

function parseEdit(args: unknown): EditArgs | null {
	const r = asRecord(args);
	if (!r || typeof r.path !== "string") return null;
	const isPair = (e: unknown): e is { oldText: string; newText: string } => {
		const p = asRecord(e);
		return !!p && typeof p.oldText === "string" && typeof p.newText === "string";
	};
	if (Array.isArray(r.edits) && r.edits.length > 0 && r.edits.every(isPair))
		return { path: r.path, edits: r.edits };
	if (typeof r.oldText === "string" && typeof r.newText === "string")
		return { path: r.path, edits: [{ oldText: r.oldText, newText: r.newText }] };
	return null;
}

const DiffView: Component<{ oldText: string; newText: string }> = (props) => (
	<div class="diff-view">
		<For each={buildDiffRows(props.oldText, props.newText)}>
			{(row) =>
				row.type === "collapse" ? (
					<div class="diff-collapse">… {row.count} unchanged lines</div>
				) : (
					<div class="diff-line" data-type={row.type}>
						<span class="diff-sign">
							{row.type === "add" ? "+" : row.type === "del" ? "-" : " "}
						</span>
						{row.text}
					</div>
				)
			}
		</For>
	</div>
);

const WriteView: Component<{ item: ToolItem; content: string }> = (props) => (
	<div class="write-view">
		<CollapsiblePre
			item={props.item}
			output={props.content}
			numbered
			maxLines={WRITE_PREVIEW_LINES}
		/>
	</div>
);

/** edit/write/apply_patch: inline diff for replacements, numbered content for writes. */
export const DiffTool: Component<{ item: ToolItem }> = (props) => {
	const edit = () => parseEdit(props.item.args);
	const write = () => (props.item.name === "write" ? parseWrite(props.item.args) : null);

	return (
		<Show when={edit() || write()} fallback={<GenericToolCard item={props.item} />}>
			<ToolShell
				name={
					<>
						{props.item.name} {edit()?.path ?? write()?.path}
					</>
				}
				status={props.item.status}
				class="diff-tool"
			>
				<Show when={edit()}>
					{(e) => (
						<For each={e().edits}>
							{(ed: { oldText: string; newText: string }) => (
								<DiffView oldText={ed.oldText} newText={ed.newText} />
							)}
						</For>
					)}
				</Show>
				<Show when={write()}>{(w) => <WriteView item={props.item} content={w().content} />}</Show>
			</ToolShell>
		</Show>
	);
};
