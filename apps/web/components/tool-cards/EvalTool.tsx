import { Show, type Component } from "solid-js";
import type { ToolItem } from "../../state";
import { ImageScan } from "../shared/ImageScan";
import { CollapsiblePre, ToolShell } from "./ToolShell";

/** eval tool: language + code header, streaming output pre, display images. */
export const EvalTool: Component<{ item: ToolItem }> = (props) => {
	const args = () => (props.item.args as { code?: string; language?: string } | null) ?? {};
	const code = () => args().code ?? "";
	const language = () => args().language ?? "";
	return (
		<ToolShell
			name={language() ? `eval (${language()})` : "eval"}
			status={props.item.status}
			class="bash-tool"
		>
			<Show when={code()}>
				<pre class="terminal eval-code">{code()}</pre>
			</Show>
			<CollapsiblePre item={props.item} output={props.item.output} tail />
			<ImageScan images={props.item.images} />
		</ToolShell>
	);
};
