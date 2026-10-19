import { createSignal, For, onMount, Show, type Component } from "solid-js";
import {
	annotations,
	annotationsError,
	annotationsLoading,
	composeForComposer,
	createAnnotation,
	queuedAnnotationIds,
	refreshAnnotations,
	removeAnnotation,
	toggleQueuedAnnotation,
} from "../../store/review";
import { sha256Hex } from "../../text/sha256";

/** Anchored feedback: durable IDs, original anchors, stale marking, composer insert. */
export const AnnotationsPanel: Component = () => {
	const [note, setNote] = createSignal("");
	const [error, setError] = createSignal("");
	onMount(() => void refreshAnnotations());
	return (
		<div class="review-annotations">
			<Show when={annotationsLoading()}>
				<div class="tool-collapsed-note">loading annotations…</div>
			</Show>
			<Show when={annotationsError()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
			<For each={annotations()} fallback={<p>No annotations</p>}>
				{(row) => (
					<div class="review-annotation-row">
						<span class="picker-chip">{row.status}</span>
						<Show when={queuedAnnotationIds().includes(row.id)}>
							<span class="picker-chip">queued with next prompt</span>
						</Show>
						<span class="picker-label">{row.note}</span>
						<span class="picker-meta">
							{row.source} · rev {row.revision}
						</span>
						<button type="button" onClick={() => void composeForComposer("insert", [row.id])}>
							insert
						</button>
						<button type="button" onClick={() => toggleQueuedAnnotation(row.id)}>
							{queuedAnnotationIds().includes(row.id) ? "cancel send" : "send with next prompt"}
						</button>
						<button type="button" onClick={() => void removeAnnotation(row.id)}>
							remove
						</button>
					</div>
				)}
			</For>
			<div class="review-annotation-create">
				<input
					class="picker-filter"
					aria-label="Annotation note"
					placeholder="Note for selected text…"
					value={note()}
					onInput={(e) => setNote(e.currentTarget.value)}
				/>
				<button
					type="button"
					disabled={!note().trim()}
					onClick={() => {
						setError("");
						void createAnnotation({
							source: "text",
							anchor: { kind: "text", text: note(), contentHash: sha256Hex(note()) },
							note: note(),
						}).catch((e) => setError(e instanceof Error ? e.message : String(e)));
					}}
				>
					annotate selection
				</button>
				<Show when={error()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
			</div>
		</div>
	);
};
