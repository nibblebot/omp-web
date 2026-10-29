import { createMemo, For, Match, Show, Switch, type Component } from "solid-js";
import type { DiffRow } from "../../../text/diff";
import {
	capDiffSections,
	cheapEditStats,
	editPreview,
	highlightDiffRows,
	type DiffFile,
	type EditPreview,
} from "../../../text/edit-diff";
import { highlightLines, languageForPath } from "../../../text/highlight";
import type { ToolItem } from "../../../state";
import { CollapsibleOutput, toolExpanded, toolRowCap, ToolCardShell } from "./ToolCardShell";
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

/** The diff, capped like every other tool body: `toolRowCap()` rows (across files) until Ctrl+O. */
const DiffBody: Component<{ item: ToolItem; preview: EditPreview }> = (props) => {
	const limit = () => (toolExpanded(props.item) ? Number.POSITIVE_INFINITY : toolRowCap());
	const sections = createMemo(() => capDiffSections(props.preview.sections, limit()));
	const hidden = () =>
		props.preview.rows.length - sections().reduce((n, file) => n + file.rows.length, 0);
	return (
		<Show
			when={props.preview.rows.length > 0}
			fallback={<div class="diff-pending">no changes</div>}
		>
			<div class="diff-view">
				<For each={sections()}>{(file) => <DiffFileRows file={file} />}</For>
			</div>
			<Show when={hidden() > 0}>
				<div class="tool-collapsed-note">{hidden()} hidden lines (Ctrl+O to expand)</div>
			</Show>
		</Show>
	);
};

/**
 * The card's body, mounted only once the card opens, so a closed card never runs the line diff.
 * `headerPreview` is the preview the header already computed when it could not use cheap stats
 * (undefined when it did not), so the diff is never computed twice.
 */
const DiffCardBody: Component<{
	item: ToolItem;
	headerPreview: () => EditPreview | null | undefined;
}> = (props) => {
	const preview = createMemo(() => {
		const shared = props.headerPreview();
		return shared !== undefined
			? shared
			: editPreview(props.item.name, props.item.args, props.item.details);
	});
	return (
		<Switch fallback={<CollapsibleOutput item={props.item} output={props.item.output} />}>
			<Match when={props.item.status === "error"}>
				<CollapsibleOutput item={props.item} output={props.item.output} />
			</Match>
			<Match when={preview()}>{(p) => <DiffBody item={props.item} preview={p()} />}</Match>
			<Match when={props.item.status === "running"}>
				<div class="diff-pending">preparing…</div>
			</Match>
		</Switch>
	);
};

/**
 * edit, write, apply_patch, patch, hashline: a `+n −m path` summary that
 * expands to the diff. Never raw args: with no renderable diff yet it shows a
 * neutral placeholder (streaming) or the tool's text output (settled, errors).
 */
export const DiffToolCard: Component<{ item: ToolItem }> = (props) => {
	// The header gets its numbers from `cheapEditStats` and falls back to the full
	// preview only for a call that needs the line diff. Memos run when created, so
	// the full preview otherwise lives in the body, which a closed card never mounts.
	const cheap = createMemo(() =>
		cheapEditStats(props.item.name, props.item.args, props.item.details),
	);
	const headerPreview = createMemo(() =>
		cheap() === undefined
			? editPreview(props.item.name, props.item.args, props.item.details)
			: undefined,
	);
	const stats = () => cheap() ?? headerPreview();
	const target = () => {
		const p = stats();
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
				<Show when={stats()}>
					{(p) => (
						<span class="diff-stats">
							<span class="diff-add">+{p().added}</span>{" "}
							<span class="diff-del">−{p().removed}</span>
						</span>
					)}
				</Show>
			}
		>
			<DiffCardBody item={props.item} headerPreview={headerPreview} />
		</ToolCardShell>
	);
};
