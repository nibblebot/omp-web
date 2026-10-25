import { createSignal, onCleanup, onMount, type Component, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { placePopover, type PopoverPlacement } from "./popover-placement";

export interface PopoverProps {
	/** The trigger that owns this popover; pointer presses on it are not "outside" (its own click toggles). */
	anchor: HTMLElement;
	onClose: () => void;
	/** Accessible name of the dialog. */
	label: string;
	/** Extra class on the surface, for the content's own layout. */
	class?: string;
	/** Surface width in px; also what the viewport clamp uses. */
	width?: number;
	/** Preferred side of the anchor; the popover flips when that side is short of room. */
	side?: "above" | "below";
	/** Which edge of the anchor the surface lines up with. */
	align?: "start" | "end";
	/** The element to focus on open; the surface itself when omitted. */
	initialFocus?: () => HTMLElement | undefined;
	children: JSX.Element;
}

const DEFAULT_WIDTH = 320;
const GAP = 4;
const MARGIN = 8;
/** Below this much room on the preferred side the popover flips when the other side has more. */
const MIN_ROOM = 240;

/**
 * Anchored popover surface: portaled, `position: fixed` beside its trigger (above by
 * default), flipped when the preferred side is short of room and clamped inside the
 * viewport. Closes on an outside pointer press or Escape; Escape with focus inside
 * returns focus to the trigger. Owned by its trigger, never a ModalHost overlay (AGENTS.md).
 * The caller mounts and unmounts it; `onClose` asks the caller to unmount.
 */
export const Popover: Component<PopoverProps> = (props) => {
	let root: HTMLDivElement | undefined;
	const width = () => props.width ?? DEFAULT_WIDTH;
	const [place, setPlace] = createSignal<PopoverPlacement>({
		side: props.side ?? "above",
		left: 0,
		offset: 0,
		maxHeight: 0,
	});
	const reposition = () =>
		setPlace(
			placePopover(
				props.anchor.getBoundingClientRect(),
				{ width: window.innerWidth, height: window.innerHeight },
				{
					width: width(),
					side: props.side ?? "above",
					align: props.align ?? "start",
					gap: GAP,
					margin: MARGIN,
					minRoom: MIN_ROOM,
				},
			),
		);
	reposition();
	// `style` is the one computed value: the anchor's viewport position.
	const style = (): JSX.CSSProperties => {
		const p = place();
		return {
			left: `${p.left}px`,
			width: `${width()}px`,
			"max-height": `${p.maxHeight}px`,
			...(p.side === "above" ? { bottom: `${p.offset}px` } : { top: `${p.offset}px` }),
		};
	};

	onMount(() => {
		// Portal content mounts after this callback; focus once it exists.
		queueMicrotask(() => (props.initialFocus?.() ?? root)?.focus());
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node | null;
			if (target && (root?.contains(target) || props.anchor.contains(target))) return;
			props.onClose();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			const wasInside = root?.contains(document.activeElement) ?? false;
			props.onClose();
			if (wasInside) props.anchor.focus();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKey);
		window.addEventListener("resize", reposition);
		// The anchor can move without a scroll or resize (the composer grows, a strip above it
		// collapses): follow it, touching the placement only when its rect changed.
		let frame = 0;
		reposition();
		let seen = props.anchor.getBoundingClientRect();
		const follow = () => {
			const r = props.anchor.getBoundingClientRect();
			if (
				r.left !== seen.left ||
				r.top !== seen.top ||
				r.right !== seen.right ||
				r.bottom !== seen.bottom
			) {
				seen = r;
				reposition();
			}
			frame = requestAnimationFrame(follow);
		};
		frame = requestAnimationFrame(follow);
		onCleanup(() => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("resize", reposition);
			cancelAnimationFrame(frame);
		});
	});

	return (
		<Portal>
			<div
				ref={root}
				class={props.class ? `popover ${props.class}` : "popover"}
				role="dialog"
				aria-label={props.label}
				tabindex="-1"
				data-side={place().side}
				style={style()}
			>
				{props.children}
			</div>
		</Portal>
	);
};
