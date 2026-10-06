import { createSignal, For, onMount, Show, type Component } from "solid-js";
import {
	annotations,
	annotationsError,
	annotationsLoading,
	composerInsert,
	composeForComposer,
	createAnnotation,
	refreshAnnotations,
	removeAnnotation,
	reviewAvailable,
	unavailableReason,
} from "../../store/review";

/** Anchored feedback: durable IDs, original anchors, stale marking, composer insert. */
export const AnnotationSidebar: Component = () => {
	const [note, setNote] = createSignal("");
	const [error, setError] = createSignal("");
	onMount(() => {
		if (reviewAvailable("review")) void refreshAnnotations();
	});
	if (!reviewAvailable("review"))
		return <div class="msg-notice">{unavailableReason("review")}</div>;
	return (
		<div class="review-annotations">
			<Show when={annotationsLoading()}>
				<div class="tool-collapsed-note">loading annotations…</div>
			</Show>
			<Show when={annotationsError()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
			<Show when={composerInsert()}>
				{(text) => (
					<div class="tool-collapsed-note">composer insert ready ({text().length} chars)</div>
				)}
			</Show>
			<For each={annotations()} fallback={<p>No annotations</p>}>
				{(row) => (
					<div class="review-annotation-row">
						<span class="picker-chip">{row.status}</span>
						<span class="picker-label">{row.note}</span>
						<span class="picker-meta">
							{row.source} · rev {row.revision}
						</span>
						<button type="button" onClick={() => void composeForComposer("insert", [row.id])}>
							insert
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
							anchor: { kind: "text", text: note(), contentHash: "" },
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
