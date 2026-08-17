import { For, Show, type Component } from "solid-js";
import { call, pushNotice, setState, type ChatItem } from "../../../state";
import type { ImageArg } from "../../../../shared/protocol";
import { imageDataUrl } from "../../../images";
import { CopyButton } from "../../shared/CopyButton";

/** User message card: branch-from-here action, copy button, text, image thumbs. */
export const UserCard: Component<{
	user: Extract<ChatItem, { kind: "user" }>;
	onZoom: (img: ImageArg) => void;
}> = (props) => {
	const images = () => props.user.images ?? [];
	// Phase 11: branch-from-here. AgentMessage user payloads carry no entryId
	// (pi-ai UserMessage has no id field), so resolve it via the branching
	// list and match by exact text.
	const branchFromHere = (text: string) => {
		void call("getBranchMessages")
			.then((msgs) => {
				const entry = (msgs as Array<{ entryId: string; text: string }>).find(
					(m) => m.text === text,
				);
				if (!entry) {
					pushNotice("warning", "No branch point found for this message.");
					return undefined;
				}
				return call("branch", [entry.entryId]);
			})
			.then((result) => {
				const r = result as { text?: string; cancelled?: boolean } | null;
				if (!r || r.cancelled) return;
				pushNotice("info", `branched at: ${(r.text ?? text).slice(0, 200)}`);
			})
			.catch((err) => setState("error", String(err)));
	};
	return (
		<div class="msg-user">
			<div class="msg-toolbar">
				<button
					class="msg-branch-btn"
					title="Branch from here"
					disabled={!props.user.text}
					onClick={() => branchFromHere(props.user.text)}
				>
					branch
				</button>
				<CopyButton class="msg-copy-btn" title="Copy message text" text={() => props.user.text} />
			</div>
			{props.user.text && <div class="msg-user-text">{props.user.text}</div>}
			<Show when={images().length > 0}>
				<div class="msg-user-images">
					<For each={images()}>
						{(img) => (
							<button class="img-thumb" type="button" onClick={() => props.onZoom(img)}>
								<img
									src={imageDataUrl(img)}
									alt={`user attached image (${img.mimeType})`}
									decoding="async"
								/>
							</button>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
};
