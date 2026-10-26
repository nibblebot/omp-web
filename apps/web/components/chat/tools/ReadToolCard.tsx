import { createMemo, For, Show, type Component } from "solid-js";
import { capRows } from "../../../chat/tool-rows";
import { type ToolItem } from "../../../state";
import { settingValue } from "../../../store/settings";
import { highlightLines, languageForPath } from "../../../text/highlight";
import { Markdown } from "../../ui/Markdown";
import { HighlightedLine } from "./HighlightedLine";
import { isMarkitDocument, parseReadOutput } from "./read-view";
import { toolExpanded, toolRowCap, ToolCardShell } from "./ToolCardShell";

/**
 * Read tool: path header and body. Settings gate the view:
 * - `read.toolResultPreview` (off: a collapsed summary row; on: body inline).
 * - `readLineNumbers` (line gutter); SDK-numbered output always keeps it.
 * - `read.renderMarkdown` (converted documents render as Markdown).
 * File content is syntax-highlighted by the path's language (never the gutter).
 */
export const ReadToolCard: Component<{ item: ToolItem }> = (props) => {
	const path = () => (props.item.args as { path?: string } | null)?.path ?? "";
	const offset = () => (props.item.args as { offset?: number } | null)?.offset ?? 1;
	const previewInline = () => settingValue<boolean>("read.toolResultPreview") ?? false;
	const lineNumbersOn = () => settingValue<boolean>("readLineNumbers") ?? false;
	const renderMarkdown = () =>
		(settingValue<boolean>("read.renderMarkdown") ?? false) && isMarkitDocument(path());

	const view = createMemo(() => parseReadOutput(props.item.output, offset()));
	const gutter = () => view().numbered || lineNumbersOn();
	// Whole content highlighted once so multi-line comments and strings color
	// right; the memo only re-runs when the output or the grammar load changes.
	const rows = createMemo(() => {
		const all = view().rows;
		const code = all.filter((row) => row.code).map((row) => row.text);
		const html =
			props.item.status === "error"
				? null
				: highlightLines(code.join("\n"), languageForPath(path()));
		let k = 0;
		return all.map((row) => ({ ...row, html: row.code ? (html?.[k++] ?? null) : null }));
	});
	const expanded = () => toolExpanded(props.item);
	const capped = () => capRows(rows(), toolRowCap(), "head");
	const shown = () => (expanded() ? rows() : capped().shown);
	const hidden = () => capped().hidden;

	const ReadRows: Component = () => {
		return (
			<Show when={rows().length > 0}>
				<Show
					when={gutter()}
					fallback={
						<pre class="terminal">
							<For each={shown()}>
								{(row, i) => (
									<>
										<Show when={i() > 0}>{"\n"}</Show>
										<HighlightedLine html={row.html} text={row.text} />
									</>
								)}
							</For>
						</pre>
					}
				>
					<For each={shown()}>
						{(row) => (
							<div class="write-line">
								<span class="line-no">{row.no}</span>
								<HighlightedLine html={row.html} text={row.text} />
							</div>
						)}
					</For>
				</Show>
				<Show when={!expanded() && hidden() > 0}>
					<div class="tool-collapsed-note">{hidden()} hidden lines (Ctrl+O to expand)</div>
				</Show>
			</Show>
		);
	};

	return (
		<ToolCardShell
			name="read"
			arg={path()}
			status={props.item.status}
			class="read-tool"
			collapsible={!previewInline()}
		>
			<Show when={props.item.output}>
				<div class="read-body">
					<Show when={renderMarkdown()} fallback={<ReadRows />}>
						<Markdown src={props.item.output} />
					</Show>
				</div>
			</Show>
		</ToolCardShell>
	);
};
