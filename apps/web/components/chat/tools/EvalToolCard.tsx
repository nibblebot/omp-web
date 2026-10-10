import { Show, type Component } from "solid-js";
import type { ToolItem } from "../../../state";
import { ImageThumbnails } from "../../ui/ImageThumbnails";
import { CollapsibleOutput, ToolCardShell } from "./ToolCardShell";

/** eval tool: language + code header, streaming output pre, display images. */
export const EvalToolCard: Component<{ item: ToolItem }> = (props) => {
	const args = () => (props.item.args as { code?: string; language?: string } | null) ?? {};
	const code = () => args().code ?? "";
	const language = () => args().language ?? "";
	return (
		<ToolCardShell
			name={language() ? `eval (${language()})` : "eval"}
			status={props.item.status}
			class="bash-tool"
		>
			<Show when={code()}>
				<pre class="terminal eval-code">{code()}</pre>
			</Show>
			<CollapsibleOutput item={props.item} output={props.item.output} tail />
			<ImageThumbnails images={props.item.images} />
		</ToolCardShell>
	);
};
