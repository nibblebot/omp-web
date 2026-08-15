import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { Portal } from "solid-js/web";
import type { ImageArg } from "../../../shared/protocol";
import { imageDataUrl } from "../../images";

/** Full-size overlay: Esc or backdrop click closes; focus moves into the
 *  dialog on open, is trapped on Tab, and is restored to the opener on
 *  close (mirrors Modal's dialog pattern). */
export const FullImageOverlay: Component<{ image: ImageArg; onClose: () => void }> = props => {
	let box!: HTMLDivElement;
	let img!: HTMLImageElement;
	// The element that had focus before the overlay mounted; restored on close.
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
		img.focus();
	});
	onCleanup(() => {
		document.removeEventListener("keydown", onKeyDown, true);
		// Restore focus to the opener only if it survived and focus is still
		// inside this overlay (Esc/backdrop close).
		if (previousFocus && previousFocus.isConnected && box.contains(document.activeElement)) {
			previousFocus.focus();
		}
	});

	return (
		<Portal>
			<div
				class="img-overlay"
				role="dialog"
				aria-modal="true"
				aria-label="Screenshot preview"
				ref={box}
				onClick={props.onClose}
			>
				<img
					ref={img}
					src={imageDataUrl(props.image)}
					alt="full-size image"
					decoding="async"
					tabindex="0"
					onClick={e => e.stopPropagation()}
				/>
			</div>
		</Portal>
	);
};

/** Inline thumbnails for tool-result images; click zooms to full size. */
export const ImageScan: Component<{ images: ImageArg[] | undefined }> = props => {
	const [zoomed, setZoomed] = createSignal<ImageArg | null>(null);
	return (
		<>
			<Show when={props.images && props.images.length > 0}>
				<div class="img-scan">
					<For each={props.images}>
						{img => (
							<button class="img-thumb" type="button" onClick={() => setZoomed(img)}>
								<img src={imageDataUrl(img)} alt="tool result image" decoding="async" />
							</button>
						)}
					</For>
				</div>
			</Show>
			<Show when={zoomed()}>{img => <FullImageOverlay image={img()} onClose={() => setZoomed(null)} />}</Show>
		</>
	);
};
