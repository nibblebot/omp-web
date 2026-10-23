import { createMemo, For, Match, Show, Switch, type Component } from "solid-js";
import type { DiffRow } from "../../../text/diff";
import {
	editPreview,
	highlightDiffRows,
	type DiffFile,
	type EditPreview,
} from "../../../text/edit-diff";
import { highlightLines, languageForPath } from "../../../text/highlight";
import type { ToolItem } from "../../../state";
import { CollapsibleOutput, ToolCardShell } from "./ToolCardShell";
import { HighlightedLine } from "./HighlightedLine";

/** One diff line, or a collapsed-run marker. `html` is its highlighted code, null for plain text. */
const DiffLine: Component<{ row: DiffRow; html: string | null }> = (props) => (
	<Show when={props.row}>
		{(row) => {
			const r = row();
			return r.type === "collapse" ? (
				<div class="diff-collapse">… {r.count} unchanged lines</div>
			) : (
				<div class="diff-line" data-type={r.type} data-hl={props.html === null ? undefined : ""}>
					<span class="diff-sign">{r.type === "add" ? "+" : r.type === "del" ? "-" : " "}</span>
					<HighlightedLine html={props.html} text={r.text} />
				</div>
			);
		}}
	</Show>
);

/** One file's rows, highlighted by the file's language (plain when it has none or the grammar is loading). */
const DiffFileRows: Component<{ file: DiffFile }> = (props) => {
	const html = createMemo(() => {
		const path = props.file.path;
		const lang = path === null ? undefined : languageForPath(path);
		if (lang === undefined) return null;
		return highlightDiffRows(props.file.rows, (code) => highlightLines(code, lang));
	});
	return (
		<For each={props.file.rows}>
			{(row, i) => <DiffLine row={row} html={html()?.[i()] ?? null} />}
		</For>
	);
};

const DiffBody: Component<{ preview: EditPreview }> = (props) => (
	<Show when={props.preview.rows.length > 0} fallback={<div class="diff-pending">no changes</div>}>
		<div class="diff-view">
			<For each={props.preview.sections}>{(file) => <DiffFileRows file={file} />}</For>
		</div>
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
	const target = () => {
		const p = preview();
		return p && p.files > 1 ? `${p.files} files` : p?.path;
	};
	return (
		<ToolCardShell
			name={props.item.name}
			arg={target()}
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
