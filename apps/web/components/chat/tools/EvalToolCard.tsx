import { Show, type Component } from "solid-js";
import type { ToolItem } from "../../../state";
import { ImageThumbnails } from "../../ui/ImageThumbnails";
import { HighlightedText } from "./HighlightedText";
import { CollapsibleOutput, ToolCardShell } from "./ToolCardShell";

/** eval tool: language arg in the header, highlighted code block, streaming output pre, images the cell printed. */
export const EvalToolCard: Component<{ item: ToolItem }> = (props) => {
	const args = () => (props.item.args as { code?: string; language?: string } | null) ?? {};
	const code = () => args().code ?? "";
	const language = () => args().language ?? "";
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
			<CollapsibleOutput item={props.item} output={props.item.output} tail />
			<ImageThumbnails images={props.item.images} />
		</ToolCardShell>
	);
};
