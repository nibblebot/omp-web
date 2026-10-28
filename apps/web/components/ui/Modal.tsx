import {
	createContext,
	createEffect,
	createSignal,
	on,
	onCleanup,
	onMount,
	Show,
	useContext,
	type Accessor,
	type Component,
	type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import { createPresence } from "../../motion/presence";
import { XIcon } from "./icons";
import { focusOrigin, pageFocusFallback, resolveFocusReturn } from "./focus";

/**
 * The host's handle on one mounted overlay (ModalHost owns a layer per open
 * `state.modal`). A side sheet slides out before it unmounts: it calls `hold()`
 * while rendering so the host keeps the layer mounted after `exiting()` turns
 * true, then `release()` once the exit motion is over. Every other variant
 * never holds, so the host unmounts its layer at once.
 */
export interface ModalLayer {
	exiting: Accessor<boolean>;
	hold: () => void;
	release: () => void;
}
export const ModalLayerContext = createContext<ModalLayer>();

/**
 * A layer for a host to provide through `ModalLayerContext`. `release` unmounts
 * it; `close()` starts the exit of a modal that held the layer, or releases at
 * once when nothing did.
 */
export function createModalLayer(release: () => void): ModalLayer & { close: () => void } {
	const [exiting, setExiting] = createSignal(false);
	let held = false;
	return {
		exiting,
		hold: () => {
			held = true;
		},
		release,
		close: () => (held ? setExiting(true) : release()),
	};
}

// Stable per-instance ids: several modals can be mounted at once (a state.modal
// picker plus BtwSheet sheets), so a module counter keeps ids unique.
let modalTitleSeq = 0;

/**
 * Generic overlay: backdrop click, Esc, and a visible close button (the title
 * row's right edge; a viewport-corner button for the lightbox) close it, Tab
 * cycles within the dialog. Every picker (model, thinking, stats, sessions,
 * branch) reuses it.
 */
export const Modal: Component<{
	title?: string;
	/** Screen-reader name when the dialog renders no h2.modal-title. */
	ariaLabel?: string;
	/** Custom title-row content (replaces the h2 title; pair with ariaLabel). The close button stays at the row's right edge. */
	header?: JSX.Element;
	onClose: () => void;
	class?: string;
	/** "sheet": full-height right-anchored side sheet. "lightbox": bare full-size image, no panel chrome. */
	variant?: "sheet" | "lightbox";
	/** "wide": a roomy dialog (about 960px, fitting the viewport) for list-and-detail bodies. */
	size?: "wide";
	children: JSX.Element;
}> = (props) => {
	// Only a sheet that a host keeps alive plays an exit; elsewhere closing unmounts at once.
	const layer = props.variant === "sheet" ? useContext(ModalLayerContext) : undefined;
	layer?.hold();
	const presence = layer && createPresence(() => !layer.exiting());
	const exiting = () => layer?.exiting() ?? false;
	let box!: HTMLDivElement;
	const titleId = `modal-title-${++modalTitleSeq}`;
	// The element that had focus before the modal mounted; restored on close.
	let previousFocus: HTMLElement | null = null;

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			// Open inline editors inside the modal (settings JSON, provider limits) take their own Escape.
			if (e.target instanceof Element && e.target.closest("[data-inline-escape]")) return;
			e.stopPropagation();
			props.onClose();
			return;
		}
		if (e.key !== "Tab") return;
		const focusables = box.querySelectorAll<HTMLElement>(
			'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
		);
		if (focusables.length === 0) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	};

	// Hand focus back when it is still on this dialog or was lost with it
	// (Esc, backdrop, close button). Focus that moved to another control
	// on purpose is left alone. Runs once, when the close starts: a sheet's exit
	// motion is still on screen then, and must not keep the trap or the focus.
	let released = false;
	const releaseFocus = () => {
		if (released) return;
		released = true;
		document.removeEventListener("keydown", onKeyDown, true);
		// Drop the opener either way: a closed dialog must not pin it (or what it links to).
		const origin = previousFocus;
		previousFocus = null;
		const active = document.activeElement;
		if (active && active !== document.body && !box.contains(active)) return;
		resolveFocusReturn(origin, pageFocusFallback)?.focus();
	};

	onMount(() => {
		document.addEventListener("keydown", onKeyDown, true);
		previousFocus = focusOrigin();
		box.focus();
	});
	onCleanup(releaseFocus);
	if (layer && presence) {
		createEffect(on(exiting, (isExiting) => isExiting && releaseFocus(), { defer: true }));
		createEffect(
			on(
				presence.mounted,
				(isMounted) => {
					if (!isMounted) layer.release();
				},
				{ defer: true },
			),
		);
	}

	return (
		<Portal>
			<div
				class="modal-backdrop"
				classList={{ sheet: props.variant === "sheet", lightbox: props.variant === "lightbox" }}
				data-motion={presence?.phase()}
				inert={exiting()}
				ref={(el) => presence?.ref(el)}
				onClick={props.onClose}
			>
				<div
					class={props.class ? `modal ${props.class}` : "modal"}
					classList={{
						sheet: props.variant === "sheet",
						lightbox: props.variant === "lightbox",
						wide: props.size === "wide",
					}}
					role="dialog"
					aria-modal="true"
					aria-labelledby={props.title ? titleId : undefined}
					aria-label={props.title ? undefined : props.ariaLabel}
					tabindex="-1"
					ref={box}
					onClick={(e) => e.stopPropagation()}
				>
					<Show
						when={props.variant !== "lightbox"}
						fallback={
							<button type="button" class="modal-close" aria-label="Close" onClick={props.onClose}>
								<XIcon />
							</button>
						}
					>
						<div class="modal-head">
							{props.header ??
								(props.title && (
									<h2 class="modal-title" id={titleId}>
										{props.title}
									</h2>
								))}
							<button type="button" class="modal-close" aria-label="Close" onClick={props.onClose}>
								<XIcon />
							</button>
						</div>
					</Show>
					{props.children}
				</div>
			</div>
		</Portal>
	);
};
