import { For, Show, type Component } from "solid-js";
import {
	answersOf,
	askDetails,
	noteLabel,
	questionViews,
	type AskArgsQuestion,
} from "../../../chat/ask-answers";
import type { ToolItem } from "../../../state";
import { ImageThumbnails } from "../../ui/ImageThumbnails";
import { CircleDotIcon, CircleIcon, SquareCheckIcon, SquareIcon } from "../../ui/icons";
import { CollapsibleOutput, ToolCardShell } from "./ToolCardShell";

const OptionMarker: Component<{ multi: boolean; selected: boolean }> = (props) => (
	<Show
		when={props.multi}
		fallback={
			<Show when={props.selected} fallback={<CircleIcon class="ask-tool-marker" />}>
				<CircleDotIcon class="ask-tool-marker" />
			</Show>
		}
	>
		<Show when={props.selected} fallback={<SquareIcon class="ask-tool-marker" />}>
			<SquareCheckIcon class="ask-tool-marker" />
		</Show>
	</Show>
);

/** ask tool: every question with the options it offered; once answered, the
 *  chosen options are marked and any custom response or note is shown. */
export const AskToolCard: Component<{ item: ToolItem }> = (props) => {
	const args = () => (props.item.args as { questions?: AskArgsQuestion[] } | null)?.questions ?? [];
	const details = () => (props.item.status === "done" ? askDetails(props.item.details) : undefined);
	const answers = () => answersOf(details());
	const views = () => questionViews(args(), answers());
	// Structured details replace the model-facing result text; without them
	// (waiting, dismissed, or an error) the raw output is the only record.
	const structured = () => answers().length > 0 || details()?.chatRedirect === true;
	return (
		<ToolCardShell name="ask" status={props.item.status} class="ask-tool">
			<For each={views()}>
				{(q) => (
					<section class="ask-tool-item">
						<Show when={q.question}>
							<div class="ask-tool-question">{q.question}</div>
						</Show>
						<Show when={q.options.length > 0}>
							<ul class="ask-tool-options">
								<For each={q.options}>
									{(o) => (
										<li
											class="ask-tool-option"
											classList={{ "ask-tool-option--selected": o.selected }}
										>
											<OptionMarker multi={q.multi} selected={o.selected} />
											<span class="ask-tool-option-text">
												<span class="ask-tool-option-label">{o.label}</span>
												<Show when={o.selected}>
													<span class="visually-hidden"> (selected)</span>
												</Show>
												<Show when={o.description}>
													<span class="ask-tool-option-description">{o.description}</span>
												</Show>
											</span>
										</li>
									)}
								</For>
							</ul>
						</Show>
						<Show when={q.answer?.customInput !== undefined}>
							<div class="ask-tool-answer">
								<span class="ask-tool-answer-label">Custom response</span>
								<span class="ask-tool-answer-text">{q.answer?.customInput}</span>
							</div>
						</Show>
						<Show when={q.answer?.note}>
							<div class="ask-tool-answer">
								<span class="ask-tool-answer-label">{noteLabel(q.answer?.noteOption)}</span>
								<span class="ask-tool-answer-text">{q.answer?.note}</span>
							</div>
						</Show>
						<Show when={q.answer?.empty}>
							<div class="ask-tool-status">No option selected</div>
						</Show>
						<Show when={q.answer?.timedOut}>
							<div class="ask-tool-status">Auto-selected after timeout</div>
						</Show>
					</section>
				)}
			</For>
			<Show when={details()?.chatRedirect}>
				<div class="ask-tool-item ask-tool-status">
					Chose to chat about this instead of answering
				</div>
			</Show>
			<Show when={!structured()}>
				<CollapsibleOutput item={props.item} output={props.item.output} />
			</Show>
			<ImageThumbnails images={props.item.images} />
		</ToolCardShell>
	);
};
