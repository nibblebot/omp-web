import { createSignal, onMount, Show, type Component } from "solid-js";
import {
	cancelPlan,
	decidePlan,
	planError,
	planLoading,
	planReview,
	refreshPlan,
	reopenPlan,
	reviewAvailable,
	unavailableReason,
} from "../../store/review";

/** Versioned plan review: approve / request changes / reopen / cancel with stale refusal. */
export const PlanReview: Component = () => {
	const [note, setNote] = createSignal("");
	onMount(() => {
		if (reviewAvailable("planReview")) void refreshPlan();
	});
	if (!reviewAvailable("planReview"))
		return <div class="msg-notice">{unavailableReason("planReview")}</div>;
	return (
		<div class="review-plan">
			<Show when={planLoading()}>
				<div class="tool-collapsed-note">loading plan…</div>
			</Show>
			<Show when={planError()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
			<Show when={planReview()} keyed>
				{(review) => (
					<div class="review-plan-body">
						<div class="goal-meta">
							<span class="picker-label">{review.title}</span> v{review.version} · {review.status}
						</div>
						<div class="picker-detail">{review.planFilePath}</div>
						<input
							class="picker-filter"
							aria-label="Review note"
							placeholder="Note (optional)…"
							value={note()}
							onInput={(e) => setNote(e.currentTarget.value)}
						/>
						<div class="graph-actions">
							<button type="button" onClick={() => void decidePlan("approve", note() || undefined)}>
								approve
							</button>
							<button
								type="button"
								onClick={() => void decidePlan("request_changes", note() || undefined)}
							>
								request changes
							</button>
							<button type="button" onClick={() => void reopenPlan()}>
								reopen
							</button>
							<button type="button" onClick={() => void cancelPlan()}>
								cancel
							</button>
						</div>
					</div>
				)}
			</Show>
		</div>
	);
};
