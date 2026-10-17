import { Show, type Component } from "solid-js";
import type { TextAttachment } from "../../../prompt/attachments";
import { FileIcon, WarningIcon, XIcon } from "../../ui/icons";

/** Human-readable size for a chip: bytes under 1 KB, then KB and MB. */
function chipSize(bytes: number): string {
	if (bytes < 1000) return `${bytes} B`;
	if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
	return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * A text file attached to the composer. A rejected file shows its reason
 * inside the chip in the error tone, and is never sent.
 */
export const AttachmentChip: Component<{
	attachment: TextAttachment;
	/** Kept in memory only: too large or credential-like for the stored draft. */
	unsaved?: boolean;
	onRemove: () => void;
}> = (props) => (
	<span
		class="attachment-chip"
		classList={{ "attachment-chip--error": props.attachment.error !== undefined }}
		title={props.attachment.error ?? props.attachment.name}
	>
		<Show when={props.attachment.error} fallback={<FileIcon class="attachment-chip-icon" />}>
			<WarningIcon class="attachment-chip-icon" />
		</Show>
		<Show when={props.attachment.error === undefined}>
			<span class="attachment-chip-name">{props.attachment.name}</span>
		</Show>
		<span class="attachment-chip-meta">
			{props.attachment.error ?? chipSize(props.attachment.size)}
		</span>
		<Show when={props.unsaved}>
			<span class="attachment-chip-meta">not saved with draft</span>
		</Show>
		<button
			type="button"
			class="attachment-chip-remove"
			aria-label={`Remove ${props.attachment.name}`}
			onClick={() => props.onRemove()}
		>
			<XIcon class="attachment-chip-icon" />
		</button>
	</span>
);
