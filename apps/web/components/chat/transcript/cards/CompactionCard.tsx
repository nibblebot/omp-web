import { Show, type Component } from "solid-js";
import type { ChatItem } from "../../../../state";
import { humanizeCompactionError } from "../../../../store/compaction-view";
import { formatTokens } from "../../../../usage/context";
import { Card } from "../../../ui/Card";
import { createLazyOpen } from "../../../ui/lazy-open";
import { Markdown } from "../../../ui/Markdown";

/** Compaction marker in the transcript: "Compacted 148K -> 22K", with the
 *  summary one click away. Live (auto_compaction_end) and replayed
 *  (compactionSummary history) items share this shape. */
export const CompactionCard: Component<{
	item: Extract<ChatItem, { kind: "compaction" }>;
}> = (props) => {
	const c = () => props.item;
	// The summary can be long; it renders when the card is first opened.
	const { opened, onToggle, onClick } = createLazyOpen(false);
	return (
		<Card
			collapsible
			onToggle={onToggle}
			onClick={onClick}
			class="compaction-item"
			header={
				<>
					{c().action === "handoff" ? "Handed off" : "Compacted"}
					<Show when={c().tokensBefore !== undefined}>
						{" "}
						{formatTokens(c().tokensBefore!)}
						<Show when={c().tokensAfter !== undefined}>
							{" -> "}
							{formatTokens(c().tokensAfter!)}
						</Show>
					</Show>
					{c().skipped && <span class="picker-detail"> · skipped</span>}
					{c().aborted && <span class="picker-detail"> · stopped</span>}
				</>
			}
		>
			<Show when={opened()}>
				{c().errorMessage && (
					<div class="msg-notice" role="alert">
						{humanizeCompactionError(c().errorMessage)}
					</div>
				)}
				{c().summary ? (
					<Markdown src={c().summary!} />
				) : (
					!c().errorMessage && <div class="tool-collapsed-note">No summary was kept.</div>
				)}
			</Show>
		</Card>
	);
};
