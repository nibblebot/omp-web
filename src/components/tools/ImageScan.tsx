import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { Portal } from "solid-js/web";
import type { ImageArg } from "../../protocol";
import { imageDataUrl } from "../../images";

/** Full-size overlay: Esc or backdrop click closes. */
export const FullImageOverlay: Component<{ image: ImageArg; onClose: () => void }> = props => {
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape") props.onClose();
	};
	onMount(() => document.addEventListener("keydown", onKeyDown, true));
	onCleanup(() => document.removeEventListener("keydown", onKeyDown, true));
	return (
		<Portal>
			<div class="img-overlay" role="dialog" aria-modal="true" onClick={props.onClose}>
				<img src={imageDataUrl(props.image)} alt="full-size image" onClick={e => e.stopPropagation()} />
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
								<img src={imageDataUrl(img)} alt="tool result image" />
							</button>
						)}
					</For>
				</div>
			</Show>
			<Show when={zoomed()}>{img => <FullImageOverlay image={img()} onClose={() => setZoomed(null)} />}</Show>
		</>
	);
};
