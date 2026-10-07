import { createMemo, createSignal, For, Match, Show, Switch, type Component } from "solid-js";
import type { BrowserUiBlock } from "#lib/wire/browser-ui-contract";
import { state } from "../../state";
import { answerBrowserUiRequest, type BrowserUiRequest } from "../../store/browser-ui";
import { Markdown } from "../shared/Markdown";
import { Modal } from "../shared/Modal";

const BlockView: Component<{
	block: BrowserUiBlock;
	request: BrowserUiRequest;
	answer: (actionId?: string) => void;
}> = (props) => (
	<Switch>
		<Match when={props.block.type === "text"}>
			<Show
				when={props.block.type === "text" && props.block.markdown}
				fallback={
					<div style={{ "white-space": "pre-wrap", "overflow-wrap": "anywhere" }}>
						{props.block.type === "text" ? props.block.text : ""}
					</div>
				}
			>
				<Markdown src={props.block.type === "text" ? props.block.text : ""} />
			</Show>
		</Match>
		<Match when={props.block.type === "code"}>
			<pre style={{ "white-space": "pre-wrap", "overflow-wrap": "anywhere" }}>
				<code>{props.block.type === "code" ? props.block.code : ""}</code>
			</pre>
		</Match>
		<Match when={props.block.type === "list"}>
			<Show
				when={props.block.type === "list" && props.block.ordered}
				fallback={
					<ul>
						<For each={props.block.type === "list" ? props.block.items : []}>
							{(item) => <li>{item}</li>}
						</For>
					</ul>
				}
			>
				<ol>
					<For each={props.block.type === "list" ? props.block.items : []}>
						{(item) => <li>{item}</li>}
					</For>
				</ol>
			</Show>
		</Match>
		<Match when={props.block.type === "actions"}>
			<div class="ask-actions">
				<For each={props.block.type === "actions" ? props.block.actions : []}>
					{(action) => (
						<button
							type="button"
							disabled={props.request.busy}
							onClick={() => props.answer(action.id)}
						>
							{action.label}
						</button>
					)}
				</For>
			</div>
		</Match>
	</Switch>
);

const ContributionView: Component<{ request: BrowserUiRequest }> = (props) => {
	const [error, setError] = createSignal<string | null>(null);
	const answer = (actionId?: string) => {
		setError(null);
		void answerBrowserUiRequest(props.request.requestId, actionId).catch((failure) =>
			setError(failure instanceof Error ? failure.message : String(failure)),
		);
	};
	return (
		<>
			<For each={props.request.contribution.payload.blocks}>
				{(block) => <BlockView block={block} request={props.request} answer={answer} />}
			</For>
			<Show when={error() ?? props.request.error}>
				{(message) => (
					<div class="msg-notice" role="alert">
						{message()}
					</div>
				)}
			</Show>
			<button type="button" disabled={props.request.busy} onClick={() => answer()}>
				Dismiss
			</button>
		</>
	);
};

/** Mount once for each composer slot and once for modals. Widgets never steal focus. */
export const BrowserUiRenderer: Component<{
	placement?: "aboveEditor" | "belowEditor" | "modal";
}> = (props) => {
	const requests = createMemo(() =>
		state.browserUi.requests.filter((request) => {
			const contribution = request.contribution;
			const placement =
				contribution.payload.placement ??
				(contribution.kind === "widget" || contribution.kind === "panel" ? "belowEditor" : "modal");
			return placement === (props.placement ?? "modal");
		}),
	);
	return (
		<>
			<Show
				when={(props.placement ?? "modal") === "modal"}
				fallback={
					<div class="browser-ui-widgets" aria-live="polite">
						<For each={requests()}>
							{(request) => (
								<section aria-label={request.contribution.title || "Extension widget"}>
									<Show when={request.contribution.title}>
										<h3>{request.contribution.title}</h3>
									</Show>
									<ContributionView request={request} />
								</section>
							)}
						</For>
						<Show when={props.placement === "belowEditor" && state.browserUi.error}>
							{(message) => (
								<div class="msg-notice" role="alert">
									{message()}
								</div>
							)}
						</Show>
					</div>
				}
			>
				<For each={requests().slice(0, 1)}>
					{(request) => (
						<Modal
							title={request.contribution.title || "Extension"}
							onClose={() => {
								void answerBrowserUiRequest(request.requestId).catch(() => {});
							}}
						>
							<ContributionView request={request} />
						</Modal>
					)}
				</For>
			</Show>
		</>
	);
};
