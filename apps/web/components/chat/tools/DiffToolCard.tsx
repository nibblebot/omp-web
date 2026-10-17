import { createMemo, For, Match, Show, Switch, type Component } from "solid-js";
import type { DiffRow } from "../../../text/diff";
import { editPreview, splitRows, type EditPreview } from "../../../text/edit-diff";
import type { ToolItem } from "../../../state";
import { CollapsibleOutput, ToolCardShell } from "./ToolCardShell";

/** One diff line, or a collapsed-run marker. `null` is an empty split cell. */
const DiffLine: Component<{ row: DiffRow | null }> = (props) => (
	<Show when={props.row} fallback={<div class="diff-line" data-type="blank" />}>
		{(row) => {
			const r = row();
			return r.type === "collapse" ? (
				<div class="diff-collapse">… {r.count} unchanged lines</div>
			) : (
				<div class="diff-line" data-type={r.type}>
					<span class="diff-sign">{r.type === "add" ? "+" : r.type === "del" ? "-" : " "}</span>
					{r.text}
				</div>
			);
		}}
	</Show>
);

/** Shows the unified diff (narrow) and the two-column split (wide); CSS picks one by container width. */
const DiffSection: Component<{ rows: DiffRow[] }> = (props) => (
	<div class="diff-section">
		<div class="diff-view">
			<For each={props.rows}>{(row) => <DiffLine row={row} />}</For>
		</div>
		<div class="diff-split">
			<For each={splitRows(props.rows)}>
				{(pair) => (
					<div class="diff-split-row">
						<DiffLine row={pair.left} />
						<DiffLine row={pair.right} />
					</div>
				)}
			</For>
		</div>
	</div>
);

const DiffBody: Component<{ preview: EditPreview }> = (props) => (
	<Show when={props.preview.rows.length > 0} fallback={<div class="diff-pending">no changes</div>}>
		<DiffSection rows={props.preview.rows} />
	</Show>
);

/**
 * edit, write, apply_patch, patch, hashline: a `+n −m path` summary that
 * expands to the diff. Never raw args: with no renderable diff yet it shows a
 * neutral placeholder (streaming) or the tool's text output (settled, errors).
 */
export const DiffToolCard: Component<{ item: ToolItem }> = (props) => {
	const preview = createMemo(() =>
		editPreview(props.item.name, props.item.args, props.item.details),
	);
	const label = () => {
		const p = preview();
		const target = p && p.files > 1 ? `${p.files} files` : p?.path;
		return target ? `${props.item.name} ${target}` : props.item.name;
	};
	return (
		<ToolCardShell
			name={label()}
			status={props.item.status}
			class="diff-tool"
			collapsible
			meta={
				<Show when={preview()}>
					{(p) => (
						<span class="diff-stats">
							<span class="diff-add">+{p().added}</span>{" "}
							<span class="diff-del">−{p().removed}</span>
						</span>
					)}
				</Show>
			}
		>
			<Switch fallback={<CollapsibleOutput item={props.item} output={props.item.output} />}>
				<Match when={props.item.status === "error"}>
					<CollapsibleOutput item={props.item} output={props.item.output} />
				</Match>
				<Match when={preview()}>{(p) => <DiffBody preview={p()} />}</Match>
				<Match when={props.item.status === "running"}>
					<div class="diff-pending">preparing…</div>
				</Match>
			</Switch>
		</ToolCardShell>
	);
};
