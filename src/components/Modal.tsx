import { onCleanup, onMount, type Component, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

/**
 * Generic overlay: backdrop click and Esc close, Tab cycles within the
 * dialog. Every picker (model, thinking, stats, sessions, branch) reuses it.
 */
export const Modal: Component<{ title?: string; onClose: () => void; class?: string; children: JSX.Element }> = props => {
	let box!: HTMLDivElement;

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
		box.focus();
	});
	onCleanup(() => document.removeEventListener("keydown", onKeyDown, true));

	return (
		<Portal>
			<div class="modal-backdrop" onClick={props.onClose}>
				<div
					class={props.class ? `modal ${props.class}` : "modal"}
					role="dialog"
					aria-modal="true"
					tabindex="-1"
					ref={box}
					onClick={e => e.stopPropagation()}
				>
					{props.title && <h2 class="modal-title">{props.title}</h2>}
					{props.children}
				</div>
			</div>
		</Portal>
	);
};
