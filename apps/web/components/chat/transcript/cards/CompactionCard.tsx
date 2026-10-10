import type { Component } from "solid-js";
import type { ChatItem } from "../../../../state";
import { Card } from "../../../ui/Card";
import { Markdown } from "../../../ui/Markdown";

/** Compaction notice card: action, token/skip/abort details, summary or error. */
export const CompactionCard: Component<{
	item: Extract<ChatItem, { kind: "compaction" }>;
}> = (props) => {
	const c = () => props.item;
	return (
		<Card
			collapsible
			class="compaction-item"
			header={
				<>
					compaction ({c().action})
					{c().tokensBefore !== undefined && (
						<span class="picker-detail"> · {c().tokensBefore} tokens before</span>
					)}
					{c().skipped && <span class="picker-detail"> · skipped</span>}
					{c().aborted && <span class="picker-detail"> · aborted</span>}
				</>
			}
		>
			{c().errorMessage && <div class="msg-notice">{c().errorMessage}</div>}
			{c().summary && <Markdown src={c().summary!} />}
			{!c().summary && !c().errorMessage && <div class="tool-collapsed-note">no summary</div>}
		</Card>
	);
};
