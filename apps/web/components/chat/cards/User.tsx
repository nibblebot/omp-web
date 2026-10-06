import { For, Show, type Component } from "solid-js";
import { pushNotice, type ChatItem } from "../../../state";
import type { ImageArg } from "#lib/wire/protocol";
import { imageDataUrl } from "../../../text/images";
import { branchFromCard } from "../../../store/graph";
import { CopyButton } from "../../shared/CopyButton";

/**
 * User message card: branch-from-here action (by stable entryId when the
 * history frame carries entryIds, never by text equality), copy button,
 * text, image thumbs.
 */
export const UserCard: Component<{
	user: Extract<ChatItem, { kind: "user" }>;
	onZoom: (img: ImageArg) => void;
}> = (props) => {
	const images = () => props.user.images ?? [];
	const entryId = () => (props.user as { entryId?: string }).entryId;
	const branchFromHere = () => {
		void branchFromCard({
			...(entryId() ? { entryId: entryId() as string } : {}),
			text: props.user.text,
			imageCount: images().length,
		}).catch((err) => pushNotice("error", String(err instanceof Error ? err.message : err)));
	};
	return (
		<div class="msg-user">
			<div class="msg-toolbar">
				<button
					class="msg-branch-btn"
					title={entryId() ? "Branch from here (new session file)" : "Branch from here"}
					disabled={!props.user.text && images().length === 0}
					onClick={branchFromHere}
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
