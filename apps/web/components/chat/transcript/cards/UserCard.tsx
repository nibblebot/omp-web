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
import {
	branchFromCard,
	openRewindPicker,
	runTurnAction,
	type TurnRef,
} from "../../../../store/graph";
import { CopyButton } from "../../../ui/CopyButton";
import { BranchIcon, PencilIcon, RefreshIcon, ResetIcon } from "../../../ui/icons";

/** How long a finger rests on a user message before its actions show (touch). */
const LONG_PRESS_MS = 500;

/**
 * User message card: copy button, the turn actions, branch-from-here, text,
 * image thumbs. A prompt with a message timestamp names its turn (the SDK's
 * `TurnMessage`; the session resolves it on the current branch, never by text
 * equality): Edit & resend and Retry turn rewind past it in the same file,
 * Rewind to here… opens the session tree on it, and branch-from-here forks a
 * new session file at it. Without one (an agent-attributed follow-up),
 * branch-from-here opens the tree picker filtered by the text. `branchable`
 * false hides every session action (a subagent's transcript is not a
 * branchable session). `fold` opts into clamping long text (chat.css
 * `.msg-user-text-folded`) behind a Show all toggle.
 *
 * The actions show on hover or focus with a mouse. Touch has no hover, so they
 * stay hidden until a long press on the message (`data-actions`, chat.css) and
 * hide again on a press outside it or once one runs.
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
	const turn = (): TurnRef | undefined =>
		props.user.timestamp === undefined ? undefined : { role: "user", at: props.user.timestamp };
	const [busy, setBusy] = createSignal(false);
	/** Run one session action at a time; failures land as an error notice. */
	const run = (action: () => Promise<void>) => {
		if (busy()) return;
		setBusy(true);
		setActionsShown(false);
		void action()
			.catch((err) => pushNotice("error", String(err instanceof Error ? err.message : err)))
			.finally(() => setBusy(false));
	};
	const branchFromHere = () =>
		run(() =>
			branchFromCard({
				...(turn() ? { turn: turn() } : {}),
				text: props.user.text,
				imageCount: images().length,
			}),
		);
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
				<CopyButton
					class="msg-copy-btn"
					title="Copy message text"
					icon
					text={() => props.user.text}
				/>
				<Show when={props.branchable !== false && turn()}>
					{(t) => (
						<>
							<button
								type="button"
								class="msg-action-btn"
								title="Edit & resend: rewind past this prompt and put it in the composer"
								aria-label="Edit & resend"
								disabled={busy()}
								onClick={() => run(() => runTurnAction("edit", t()))}
							>
								<PencilIcon />
							</button>
							<button
								type="button"
								class="msg-action-btn"
								title="Retry turn: rewind past this prompt and send it again"
								aria-label="Retry turn"
								disabled={busy()}
								onClick={() => run(() => runTurnAction("retry", t()))}
							>
								<RefreshIcon />
							</button>
							<button
								type="button"
								class="msg-action-btn"
								title="Rewind to here…: pick the point in the session tree"
								aria-label="Rewind to here…"
								disabled={busy()}
								onClick={() => run(() => openRewindPicker(t()))}
							>
								<ResetIcon />
							</button>
						</>
					)}
				</Show>
				<Show when={props.branchable !== false}>
					<button
						type="button"
						class="msg-branch-btn"
						title={turn() ? "Branch from here (new session file)" : "Branch from here"}
						aria-label="Branch from here"
						disabled={busy() || (!props.user.text && images().length === 0)}
						onClick={branchFromHere}
					>
						<BranchIcon />
					</button>
				</Show>
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
