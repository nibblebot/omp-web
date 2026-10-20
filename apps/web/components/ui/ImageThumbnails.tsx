import { For, Show, type Component } from "solid-js";
import type { ImageArg } from "#lib/wire/protocol";
import { showImages } from "../../chat/display-prefs";
import { openLightbox } from "../../state";
import { ImageThumb } from "./ImageThumb";

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
					{(img) => <ImageThumb image={img} alt="tool result image" onZoom={openLightbox} />}
				</For>
			</div>
		</Show>
	</Show>
);
