import {
	createEffect,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
	type Component,
} from "solid-js";
import { pushNotice, type ChatItem } from "../../../../state";
import type { ImageArg } from "#lib/wire/protocol";
import { ImageThumb } from "../../../ui/ImageThumb";
import { branchFromCard } from "../../../../store/graph";
import { CopyButton } from "../../../ui/CopyButton";
import { BranchIcon } from "../../../ui/icons";

/** How long a finger rests on a user message before its actions show (touch). */
const LONG_PRESS_MS = 500;

/**
 * User message card: branch-from-here action (by stable entryId when the
 * history frame carries entryIds, never by text equality), copy button,
 * text, image thumbs. `branchable` false hides branch-from-here (a subagent's
 * transcript is not a branchable session). `fold` opts into clamping long
 * text (chat.css `.msg-user-text-folded`) behind a Show all toggle.
 *
 * The actions show on hover or focus with a mouse. Touch has no hover, so they
 * stay hidden until a long press on the message (`data-actions`, chat.css) and
 * hide again on a press outside it.
 */
export const UserCard: Component<{
	user: Extract<ChatItem, { kind: "user" }>;
	onZoom: (img: ImageArg) => void;
	branchable?: boolean;
	fold?: boolean;
}> = (props) => {
	let root!: HTMLDivElement;
	let textRef: HTMLDivElement | undefined;
	const [actionsShown, setActionsShown] = createSignal(false);
	let pressTimer: ReturnType<typeof setTimeout> | undefined;
	const cancelPress = () => clearTimeout(pressTimer);
	const showActions = () => {
		cancelPress();
		if (actionsShown()) return;
		setActionsShown(true);
		navigator.vibrate?.(10);
	};
	onCleanup(cancelPress);
	createEffect(() => {
		if (!actionsShown()) return;
		const onOutside = (e: PointerEvent) => {
			if (!root.contains(e.target as Node | null)) setActionsShown(false);
		};
		document.addEventListener("pointerdown", onOutside, true);
		onCleanup(() => document.removeEventListener("pointerdown", onOutside, true));
	});
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
		<div
			class="msg-user"
			ref={root}
			data-actions={actionsShown() ? "" : undefined}
			onPointerDown={(e) => {
				if (e.pointerType !== "touch") return;
				cancelPress();
				pressTimer = setTimeout(showActions, LONG_PRESS_MS);
			}}
			onPointerUp={cancelPress}
			onPointerCancel={cancelPress}
			// Android raises the long-press menu (and TalkBack's double-tap-and-hold) as
			// contextmenu: show the actions instead of the browser's menu.
			onContextMenu={(e) => {
				if (!matchMedia("(pointer: coarse)").matches) return;
				e.preventDefault();
				showActions();
			}}
		>
			<div class="msg-toolbar">
				<Show when={props.branchable !== false}>
					<button
						type="button"
						class="msg-branch-btn"
						title={entryId() ? "Branch from here (new session file)" : "Branch from here"}
						aria-label="Branch from here"
						disabled={!props.user.text && images().length === 0}
						onClick={branchFromHere}
					>
						<BranchIcon />
					</button>
				</Show>
				<CopyButton
					class="msg-copy-btn"
					title="Copy message text"
					icon
					text={() => props.user.text}
				/>
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
							<ImageThumb
								image={img}
								alt={`user attached image (${img.mimeType})`}
								onZoom={props.onZoom}
							/>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
};
