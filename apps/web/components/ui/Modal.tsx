import { onCleanup, onMount, type Component, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

// Stable per-instance ids: several modals can be mounted at once (a state.modal
// picker plus AskDialog/BtwPanel sheets), so a module counter keeps ids unique.
let modalTitleSeq = 0;

/**
 * Generic overlay: backdrop click and Esc close, Tab cycles within the
 * dialog. Every picker (model, thinking, stats, sessions, branch) reuses it.
 */
export const Modal: Component<{
	title?: string;
	/** Screen-reader name when the dialog renders no h2.modal-title. */
	ariaLabel?: string;
	onClose: () => void;
	class?: string;
	/** "sheet" anchors the dialog as a full-height right-anchored side sheet. */
	variant?: "sheet";
	children: JSX.Element;
}> = (props) => {
	let box!: HTMLDivElement;
	const titleId = `modal-title-${++modalTitleSeq}`;
	// The element that had focus before the modal mounted; restored on close.
	let previousFocus: HTMLElement | null = null;

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
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
		previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		box.focus();
	});
	onCleanup(() => {
		document.removeEventListener("keydown", onKeyDown, true);
		// Restore focus to the opener only if it survived and focus is still
		// inside this modal (Esc/backdrop close). If focus moved on its own or
		// the opener was replaced, leave it where it is.
		if (previousFocus && previousFocus.isConnected && box.contains(document.activeElement)) {
			previousFocus.focus();
		}
	});

	return (
		<Portal>
			<div
				class="modal-backdrop"
				classList={{ sheet: props.variant === "sheet" }}
				onClick={props.onClose}
			>
				<div
					class={props.class ? `modal ${props.class}` : "modal"}
					classList={{ sheet: props.variant === "sheet" }}
					role="dialog"
					aria-modal="true"
					aria-labelledby={props.title ? titleId : undefined}
					aria-label={props.title ? undefined : props.ariaLabel}
					tabindex="-1"
					ref={box}
					onClick={(e) => e.stopPropagation()}
				>
					{props.title && (
						<h2 class="modal-title" id={titleId}>
							{props.title}
						</h2>
					)}
					{props.children}
				</div>
			</div>
		</Portal>
	);
};
