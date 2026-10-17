import { onCleanup, onMount, Show, type Component, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { XIcon } from "./icons";
import { focusOrigin, pageFocusFallback, resolveFocusReturn } from "./focus";

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
	children: JSX.Element;
}> = (props) => {
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

	onMount(() => {
		document.addEventListener("keydown", onKeyDown, true);
		previousFocus = focusOrigin();
		box.focus();
	});
	onCleanup(() => {
		document.removeEventListener("keydown", onKeyDown, true);
		// Hand focus back when it is still on this dialog or was lost with it
		// (Esc, backdrop, close button). Focus that moved to another control
		// on purpose is left alone.
		const active = document.activeElement;
		if (active && active !== document.body && !box.contains(active)) return;
		resolveFocusReturn(previousFocus, pageFocusFallback)?.focus();
	});

	return (
		<Portal>
			<div
				class="modal-backdrop"
				classList={{ sheet: props.variant === "sheet", lightbox: props.variant === "lightbox" }}
				onClick={props.onClose}
			>
				<div
					class={props.class ? `modal ${props.class}` : "modal"}
					classList={{ sheet: props.variant === "sheet", lightbox: props.variant === "lightbox" }}
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
