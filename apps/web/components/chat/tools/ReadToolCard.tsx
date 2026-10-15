import { Show, type Component } from "solid-js";
import { type ToolItem } from "../../../state";
import { settingValue } from "../../../store/settings";
import { Markdown } from "../../ui/Markdown";
import { CollapsibleOutput, ToolCardShell } from "./ToolCardShell";
import { hasLineNumbers, isMarkitDocument, LINE_NUMBER } from "./read-view";

/**
 * Read tool: path header and body. Settings gate the view:
 * - `read.toolResultPreview` (off: a collapsed summary row; on: body inline).
 * - `readLineNumbers` (line gutter); SDK-numbered output always keeps it.
 * - `read.renderMarkdown` (converted documents render as Markdown).
 */
export const ReadToolCard: Component<{ item: ToolItem }> = (props) => {
	const path = () => (props.item.args as { path?: string } | null)?.path ?? "";
	const offset = () => (props.item.args as { offset?: number } | null)?.offset ?? 1;
	const previewInline = () => settingValue<boolean>("read.toolResultPreview") ?? false;
	const lineNumbersOn = () => settingValue<boolean>("readLineNumbers") ?? false;
	const renderMarkdown = () =>
		(settingValue<boolean>("read.renderMarkdown") ?? false) && isMarkitDocument(path());

	const gutter = () => hasLineNumbers(props.item.output) || lineNumbersOn();
	const lines = () => {
		const raw = props.item.output.split("\n");
		const numbered = hasLineNumbers(props.item.output);
		return raw.map((l) => (numbered ? l.replace(LINE_NUMBER, "") : l));
	};
	const startNo = () => {
		if (!props.item.output) return offset();
		const m = /^\s*(\d+)\s*[→|:]/.exec(props.item.output);
		return m ? Number(m[1]) : offset();
	};

	return (
		<ToolCardShell
			name={<>read {path()}</>}
			status={props.item.status}
			class="read-tool"
			collapsible={!previewInline()}
		>
			<Show when={props.item.output}>
				<div class="read-body">
					<Show
						when={renderMarkdown()}
						fallback={
							<CollapsibleOutput
								item={props.item}
								output={lines().join("\n")}
								numbered={gutter()}
								startNo={startNo()}
							/>
						}
					>
						<Markdown src={props.item.output} />
					</Show>
				</div>
			</Show>
		</ToolCardShell>
	);
};
