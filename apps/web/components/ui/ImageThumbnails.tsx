import { For, Show, type Component } from "solid-js";
import type { ImageArg } from "#lib/wire/protocol";
import { openLightbox } from "../../state";
import { imageDataUrl } from "../../text/images";

/** Inline thumbnails for tool-result images; click opens the full-size lightbox. */
export const ImageThumbnails: Component<{ images: ImageArg[] | undefined }> = (props) => (
	<Show when={props.images && props.images.length > 0}>
		<div class="img-scan">
			<For each={props.images}>
				{(img) => (
					<button class="img-thumb" type="button" onClick={() => openLightbox(img)}>
						<img src={imageDataUrl(img)} alt="tool result image" decoding="async" />
					</button>
				)}
			</For>
		</div>
	</Show>
);
