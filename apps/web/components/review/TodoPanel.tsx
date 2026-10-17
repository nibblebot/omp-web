import { createSignal, For, onMount, Show, type Component } from "solid-js";
import {
	applyTodoOps,
	exportTodos,
	importTodos,
	refreshTodos,
	reviewAvailable,
	setTodoDraft,
	todoBoard,
	todoConflict,
	todoDraft,
	todoError,
	todoLoading,
	unavailableReason,
} from "../../store/review";

/** Editable phased todos: same authoritative state, stale-revision conflict refresh. */
export const TodoPanel: Component = () => {
	const [error, setError] = createSignal("");
	const [exported, setExported] = createSignal<string | null>(null);
	onMount(() => {
		if (reviewAvailable("todos")) void refreshTodos();
	});
	if (!reviewAvailable("todos")) return <div class="msg-notice">{unavailableReason("todos")}</div>;
	return (
		<div class="review-todos">
			<Show when={todoLoading()}>
				<div class="tool-collapsed-note">loading todos…</div>
			</Show>
			<Show when={todoError()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
			<Show when={todoConflict()}>
				<div class="msg-notice">Todo list changed; refreshed to the current revision.</div>
			</Show>
			<For each={todoBoard()?.phases ?? []} fallback={<p>No phases</p>}>
				{(phase, pi) => (
					<section class="review-todo-phase">
						<h3>{phase.name ?? `Phase ${pi()}`}</h3>
						<For each={phase.tasks ?? []}>
							{(task) => (
								<div class="review-todo-row">
									<span class="picker-chip">{task.status}</span>
									<span class="picker-label">{task.content}</span>
									<button
										type="button"
										onClick={() =>
											void applyTodoOps([
												{ op: "done", phase: phase.name ?? "", task: task.content },
											]).catch((e) => setError(e instanceof Error ? e.message : String(e)))
										}
									>
										done
									</button>
								</div>
							)}
						</For>
					</section>
				)}
			</For>
			<div class="review-todo-import">
				<input
					class="picker-filter"
					aria-label="Todo import markdown"
					placeholder="Paste phased markdown to import…"
					value={todoDraft()}
					onInput={(e) => setTodoDraft(e.currentTarget.value)}
				/>
				<button
					type="button"
					onClick={() =>
						void importTodos(todoDraft(), true).catch((e) =>
							setError(e instanceof Error ? e.message : String(e)),
						)
					}
				>
					import
				</button>
				<button
					type="button"
					onClick={() =>
						void exportTodos()
							.then((result) => setExported(result?.markdown ?? null))
							.catch((e) => setError(e instanceof Error ? e.message : String(e)))
					}
				>
					export
				</button>
				<Show when={error()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
				<Show when={exported()}>
					{(markdown) => (
						<div class="review-todo-export">
							<textarea readonly aria-label="Exported todo markdown" value={markdown()} />
							<button type="button" onClick={() => void navigator.clipboard?.writeText(markdown())}>
								copy
							</button>
						</div>
					)}
				</Show>
			</div>
		</div>
	);
};
