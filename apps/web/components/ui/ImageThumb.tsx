import { Show, type Component } from "solid-js";
import type { ImageArg } from "#lib/wire/protocol";
import { imageDataUrl, isUnresolvedImage } from "../../text/images";

/**
 * One image thumbnail; click zooms. An image whose data is still a `blob:sha256:` reference (a subagent
 * transcript image not resolved yet, or one too large or gone) renders an `[image]` chip, never a broken <img>,
 * and becomes the thumbnail in place when the bytes land.
 */
export const ImageThumb: Component<{
	image: ImageArg;
	alt: string;
	onZoom: (image: ImageArg) => void;
}> = (props) => (
	<Show
		when={!isUnresolvedImage(props.image)}
		fallback={
			<span class="img-pending" title="Image not available inline">
				[image]
			</span>
		}
	>
		<button class="img-thumb" type="button" onClick={() => props.onZoom(props.image)}>
			<img src={imageDataUrl(props.image)} alt={props.alt} decoding="async" />
		</button>
	</Show>
);
