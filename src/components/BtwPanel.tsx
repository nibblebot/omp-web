import { Show, type Component } from "solid-js";
import { closeBtw, state } from "../state";
import { Markdown } from "./Markdown";
import { Modal } from "./Modal";

/**
 * Phase 11: /btw side sheet — an ephemeral Q&A that streams the side-channel
 * reply (runEphemeralTurn) and never appears in the transcript. Esc and
 * backdrop click close it through Modal; closing while streaming aborts the
 * side turn server-side (closeBtw).
 */
export const BtwPanel: Component = () => {
	const btw = () => state.btw;
	return (
		<Show when={btw()}>
			{(b) => (
				<Modal title="btw — side question" variant="sheet" onClose={closeBtw}>
					<div class="btw-panel">
						<Show when={b().question}>
							<div class="btw-question">{b().question}</div>
						</Show>
						<div class="btw-reply">
							<Show
								when={b().streaming || b().reply || b().error}
								fallback={<div class="tool-collapsed-note">ask with /btw &lt;question&gt;</div>}
							>
								<Markdown src={b().reply} />
								{b().streaming && <span class="btw-cursor" aria-hidden="true" />}
							</Show>
						</div>
						<Show when={b().error}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
						<div class="btw-footer">
							<Show when={b().streaming}>
								<button type="button" class="btw-abort" onClick={closeBtw}>
									stop
								</button>
							</Show>
							<button type="button" class="btw-close" onClick={closeBtw}>
								close
							</button>
						</div>
					</div>
				</Modal>
			)}
		</Show>
	);
};
