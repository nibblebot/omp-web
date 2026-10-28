import type { Component } from "solid-js";
import type { ImageArg } from "#lib/wire/protocol";
import { imageObjectUrl } from "../../text/images";
import { Modal } from "./Modal";

/** Full-size image on Modal's lightbox variant. Esc or a backdrop click
 *  closes; a click on the image does not (Modal's dialog box stops
 *  propagation). Mounted by ModalHost while state.lightboxImage is set. */
export const ImageLightbox: Component<{ image: ImageArg; onClose: () => void }> = (props) => (
	<Modal variant="lightbox" ariaLabel="Screenshot preview" onClose={props.onClose}>
		<img
			src={imageObjectUrl(props.image)}
			alt={`full-size image (${props.image.mimeType})`}
			decoding="async"
		/>
	</Modal>
);
