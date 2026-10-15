import { For, Show, type Component } from "solid-js";
import type { ImageArg } from "#lib/wire/protocol";
import { showImages } from "../../chat/display-prefs";
import { openLightbox } from "../../state";
import { imageDataUrl } from "../../text/images";

/** Inline thumbnails for tool-result images; click opens the full-size lightbox.
 *  With `terminal.showImages` off, a text placeholder stands in for each image. */
export const ImageThumbnails: Component<{ images: ImageArg[] | undefined }> = (props) => (
	<Show when={props.images && props.images.length > 0}>
		<Show
			when={showImages()}
			fallback={
				<div class="img-hidden">
					[{props.images?.length} image{props.images?.length === 1 ? "" : "s"} hidden]
				</div>
			}
		>
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
	</Show>
);
