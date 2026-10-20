import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { pushNotice, type ChatItem } from "../../../../state";
import type { ImageArg } from "#lib/wire/protocol";
import { imageDataUrl } from "../../../../text/images";
import { branchFromCard } from "../../../../store/graph";
import { CopyButton } from "../../../ui/CopyButton";

/**
 * User message card: branch-from-here action (by stable entryId when the
 * history frame carries entryIds, never by text equality), copy button,
 * text, image thumbs. `branchable` false hides branch-from-here (a subagent's
 * transcript is not a branchable session). `fold` opts into clamping long
 * text (chat.css `.msg-user-text-folded`) behind a Show all toggle.
 */
export const UserCard: Component<{
	user: Extract<ChatItem, { kind: "user" }>;
	onZoom: (img: ImageArg) => void;
	branchable?: boolean;
	fold?: boolean;
}> = (props) => {
	let textRef: HTMLDivElement | undefined;
	const [expanded, setExpanded] = createSignal(false);
	const [overflowing, setOverflowing] = createSignal(false);
	onMount(() => {
		if (!props.fold || !textRef) return;
		const el = textRef;
		// Measured while clamped; re-measured as the width (and so the wrapping) changes.
		const observer = new ResizeObserver(() => {
			if (!expanded()) setOverflowing(el.scrollHeight > el.clientHeight + 1);
		});
		observer.observe(el);
		onCleanup(() => observer.disconnect());
	});
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
				<Show when={props.branchable !== false}>
					<button
						class="msg-branch-btn"
						title={entryId() ? "Branch from here (new session file)" : "Branch from here"}
						disabled={!props.user.text && images().length === 0}
						onClick={branchFromHere}
					>
						branch
					</button>
				</Show>
				<CopyButton class="msg-copy-btn" title="Copy message text" text={() => props.user.text} />
			</div>
			{props.user.text && (
				<div
					class="msg-user-text"
					classList={{ "msg-user-text-folded": props.fold === true && !expanded() }}
					ref={textRef}
				>
					{props.user.text}
				</div>
			)}
			<Show when={props.fold === true && (overflowing() || expanded())}>
				<button
					class="msg-user-fold-toggle"
					type="button"
					aria-expanded={expanded()}
					onClick={() => setExpanded(!expanded())}
				>
					{expanded() ? "Show less" : "Show all"}
				</button>
			</Show>
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
