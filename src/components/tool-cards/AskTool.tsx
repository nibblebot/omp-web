import { Show, type Component } from "solid-js";
import type { ToolItem } from "../../state";
import { CollapsiblePre, ToolShell } from "./ToolShell";

type AskQuestion = { id?: string; question?: string; options?: { label?: string }[] };

/** ask tool: settled Q&A card — question from args, chosen answer from result. */
export const AskTool: Component<{ item: ToolItem }> = (props) => {
	const args = () => (props.item.args as { questions?: AskQuestion[] } | null) ?? {};
	const question = () => args().questions?.[0]?.question ?? "";
	const options = () =>
		(args().questions?.[0]?.options ?? []).map((o) => o?.label ?? "").filter(Boolean) ?? [];
	return (
		<ToolShell name="ask" status={props.item.status} class="ask-tool">
			<Show when={question()}>
				<div class="ask-tool-question">{question()}</div>
			</Show>
			<Show when={options().length > 0}>
				<div class="ask-tool-options">{options().join(" / ")}</div>
			</Show>
			<CollapsiblePre item={props.item} output={props.item.output} />
		</ToolShell>
	);
};
