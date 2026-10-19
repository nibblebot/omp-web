import { createSignal, onMount, Show, type Component } from "solid-js";
import { setState } from "../../state";
import {
	decidePlan,
	planError,
	planLoading,
	planReview,
	refreshPlan,
	reopenPlan,
} from "../../store/review";
import { Markdown } from "../ui/Markdown";

/** Plan review sheet: the rendered plan, an optional note, and Approve / Refine / Reject. A
 * decision that lands closes the sheet; a stale or failed one keeps it open with the error. */
export const PlanReviewPanel: Component = () => {
	const [note, setNote] = createSignal("");
	onMount(() => void refreshPlan());
	const decide = async (decision: "approve" | "request_changes" | "dismiss") => {
		if (await decidePlan(decision, note().trim() || undefined)) setState("modal", null);
	};
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
						<Markdown src={review.content ?? ""} />
						<Show
							when={review.status === "waiting"}
							fallback={
								<div class="graph-actions">
									<button type="button" onClick={() => void reopenPlan()}>
										reopen
									</button>
								</div>
							}
						>
							<textarea
								class="picker-filter"
								aria-label="Review note"
								rows={3}
								placeholder="Note for the agent. Required to refine."
								value={note()}
								onInput={(e) => setNote(e.currentTarget.value)}
							/>
							<div class="graph-actions">
								<button type="button" onClick={() => void decide("approve")}>
									approve
								</button>
								<button
									type="button"
									disabled={!note().trim()}
									onClick={() => void decide("request_changes")}
								>
									refine
								</button>
								<button type="button" onClick={() => void decide("dismiss")}>
									reject
								</button>
							</div>
						</Show>
					</div>
				)}
			</Show>
		</div>
	);
};
