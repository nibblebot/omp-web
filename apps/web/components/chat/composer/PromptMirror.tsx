import { For, Show, type Component } from "solid-js";
import { magicKeywordGradient, type MagicKeywordId } from "../../../prompt/magic-keywords";

/** Plain or keyword run; concatenated runs equal the draft text. */
export interface MirrorSegment {
	text: string;
	id?: MagicKeywordId;
}

/**
 * Read-only layer behind the textarea, mirroring its text, wrapping, and
 * padding so keyword gradients and ghost text line up with the real glyphs.
 * The textarea goes transparent while this layer is mounted (see `.prompt-field--mirrored`).
 */
export const PromptMirror: Component<{
	segments: MirrorSegment[];
	ghost: string;
	/** The dim `⇥ N more` hint after a draft that equals one of several predictions. */
	hint?: string;
	ref: (el: HTMLDivElement) => void;
}> = (props) => (
	<div class="prompt-mirror" aria-hidden="true" ref={props.ref}>
		<For each={props.segments}>
			{(seg) =>
				seg.id ? (
					<span class="magic-kw" style={{ "background-image": magicKeywordGradient(seg.id) }}>
						{seg.text}
					</span>
				) : (
					<span>{seg.text}</span>
				)
			}
		</For>
		<Show when={props.ghost !== ""}>
			<span class="prompt-ghost">{props.ghost}</span>
		</Show>
		<Show when={(props.hint ?? "") !== ""}>
			<span class="prompt-ghost prompt-ghost-hint">{` ${props.hint}`}</span>
		</Show>
		{/* Keeps a trailing newline's caret line; pre-wrap drops an empty last line. */}{" "}
	</div>
);
