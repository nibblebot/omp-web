import { Show, useContext, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { isReplyWrite } from "../../../chat/tool-replies";
import type { ToolItem } from "../../../state";
import { GenericToolCard } from "./GenericToolCard";
import { RENDERERS } from "./renderers";
import { RunMemberContext, ToolCallIdContext } from "./ToolCardShell";
import { ReplyWrite, ToolReplies } from "./ToolReplies";

/** The component that draws a call: prose for a write to `out://`, else its renderer, else the generic card. */
const rendererOf = (item: ToolItem): Component<{ item: ToolItem }> =>
	isReplyWrite(item) ? ReplyWrite : (RENDERERS[item.name] ?? GenericToolCard);

/**
 * Dispatcher: per-tool renderer when registered, generic card otherwise; the card root carries the call's id for jumps (`ToolCallIdContext`).
 * A `write` to `out://` is a reply, drawn as prose instead of a card. A bash or eval call's `out://` replies follow its card as prose;
 * a consolidated run's member leaves them to the run row, which draws its calls' replies after the row.
 */
export const ToolCard: Component<{ item: ToolItem }> = (props) => {
	const inRun = useContext(RunMemberContext);
	return (
		<>
			<ToolCallIdContext.Provider value={props.item.toolCallId}>
				<Dynamic component={rendererOf(props.item)} item={props.item} />
			</ToolCallIdContext.Provider>
			<Show when={!inRun}>
				<ToolReplies item={props.item} />
			</Show>
		</>
	);
};
