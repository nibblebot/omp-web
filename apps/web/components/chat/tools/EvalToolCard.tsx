import { createMemo, For, Show, type Component, type JSX } from "solid-js";
import {
	describeStatusEvent,
	EVAL_STATUS_COLLAPSED,
	evalNotes,
	evalStatusOf,
	evalViews,
	splitEvalOutput,
	type EvalOutputPart,
} from "../../../chat/eval-details";
import type { ToolItem } from "../../../state";
import { ImageThumbnails } from "../../ui/ImageThumbnails";
import { JsonTree } from "../../ui/JsonTree";
import { Markdown } from "../../ui/Markdown";
import { EvalTable } from "./EvalTable";
import { HighlightedText } from "./HighlightedText";
import { CollapsibleOutput, ToolCardShell, toolExpanded } from "./ToolCardShell";

/** One piece of a settled cell's output: printed text, or the view standing in place of the text it matched. */
function renderPart(item: ToolItem, part: EvalOutputPart): JSX.Element {
	if (part.kind === "text") return <CollapsibleOutput item={item} output={part.text} tail />;
	const view = part.view;
	switch (view.kind) {
		case "table":
			return (
				<div class="eval-view">
					<EvalTable columns={view.columns} rows={view.rows} />
				</div>
			);
		case "json":
			return (
				<div class="eval-view">
					<JsonTree value={view.value} />
				</div>
			);
		case "markdown":
			return (
				<div class="eval-view">
					<Markdown src={view.text} />
				</div>
			);
	}
}

/**
 * eval tool: language arg in the header, highlighted code block, then the cell's
 * output. A settled cell shows what it printed in order, with each printed
 * DataFrame as a table, JSON value as a collapsible tree and Markdown object as
 * Markdown in place of its text (the model only ever sees the text). The status
 * events helpers logged (`log()`, MCP progress, `agent()` snapshots) list below,
 * live while the cell runs. Images the cell printed follow.
 */
export const EvalToolCard: Component<{ item: ToolItem }> = (props) => {
	const args = () => (props.item.args as { code?: string; language?: string } | null) ?? {};
	const code = () => args().code ?? "";
	const language = () => args().language ?? "";
	// Views exist only once the cell settled; a running card shows the live tail as text.
	const parts = createMemo((): EvalOutputPart[] | undefined => {
		if (props.item.status === "running") return undefined;
		const views = evalViews(props.item.details);
		return views.length > 0 ? splitEvalOutput(props.item.output, views) : undefined;
	});
	const status = createMemo(() => evalStatusOf(props.item));
	const notes = createMemo(() => evalNotes(props.item.details));
	// The folded card keeps the newest events behind an "N earlier" line; Ctrl+O lists the whole kept log.
	const shownStatus = () => {
		const events = status()?.status ?? [];
		return toolExpanded(props.item) ? events : events.slice(-EVAL_STATUS_COLLAPSED);
	};
	const earlier = () => {
		const log = status();
		if (log === undefined) return 0;
		return (log.elided ?? 0) + log.status.length - shownStatus().length;
	};
	return (
		<ToolCardShell
			name="eval"
			arg={language() ? `(${language()})` : undefined}
			status={props.item.status}
			class="bash-tool"
		>
			<Show when={code()}>
				<pre class="terminal tool-code">
					<HighlightedText code={code()} lang={language()} />
				</pre>
			</Show>
			<Show
				when={parts()}
				fallback={<CollapsibleOutput item={props.item} output={props.item.output} tail />}
			>
				{(list) => <For each={list()}>{(part) => renderPart(props.item, part)}</For>}
			</Show>
			<Show when={status()}>
				<ul class="eval-status" aria-label="Status events">
					<Show when={earlier() > 0}>
						<li class="eval-status-earlier">{earlier()} earlier</li>
					</Show>
					<For each={shownStatus()}>
						{(event) => {
							const line = describeStatusEvent(event);
							return (
								<li class="eval-status-line">
									<span class="eval-status-op">{line.op}</span>
									<For each={line.fields}>
										{(field) => (
											<span class="eval-status-field">
												<span class="eval-status-key">{field.key}=</span>
												{field.value}
											</span>
										)}
									</For>
									<Show when={line.progress}>
										<span class="eval-status-progress">{line.progress}</span>
									</Show>
								</li>
							);
						}}
					</For>
				</ul>
			</Show>
			<For each={notes()}>{(note) => <div class="tool-meta">{note}</div>}</For>
			<ImageThumbnails images={props.item.images} />
		</ToolCardShell>
	);
};
