import { createEffect, createSignal, For, Show, type Accessor, type Component } from "solid-js";
import { attachSession, state } from "../../state";

/** One rung of the register→spawn→attach onboarding pipeline. */
export type Stage =
	| { kind: "form" }
	| { kind: "creating" }
	| { kind: "spawning"; daemonId: string }
	| { kind: "attaching"; daemonId: string }
	| { kind: "error"; stage: "creating" | "spawning" | "attaching"; message: string };

/** Index of the active rung for a stage, or -1 for the form. */
export function stageIndex(stage: Stage): number {
	switch (stage.kind) {
		case "creating":
			return 0;
		case "spawning":
			return 1;
		case "attaching":
			return 2;
		case "error":
			return stage.stage === "creating" ? 0 : stage.stage === "spawning" ? 1 : 2;
		default:
			return -1;
	}
}

/**
 * Shared register→spawn→attach pipeline for the onboarding modals (add
 * project / add worktree). Owns the stage signal plus the three roster
 * watchers that drive it:
 *
 *   creating → spawning  the roster grew an entry that wasn't there at submit
 *   creating → error     a global error frame landed while registering
 *   spawning → ready     daemon_status frame → attachSession → onReady
 *   spawning → error     daemon_status error frame
 *
 * `begin` snapshots the pre-command roster/error, runs the modal's send
 * action, then enters the pipeline — or closes when the session wasn't
 * requested (the command is fire-and-forget and the new row appears in the
 * sidebar on its own).
 */
export function useOnboardingPipeline(onReady: () => void) {
	const [stage, setStage] = createSignal<Stage>({ kind: "form" });

	// Pipeline bookkeeping, captured at submit: the roster daemonIds that
	// existed BEFORE the command, and the global error text at that moment.
	let beforeIds: Set<string> | null = null;
	let errorSnapshot: string | null = null;

	/** creating → spawning: the roster grew an entry that wasn't there at submit. */
	createEffect(() => {
		const st = stage();
		const ids = beforeIds;
		if (st.kind !== "creating" || ids === null) return;
		const fresh = state.daemonRoster.find((d) => !ids.has(d.daemonId));
		if (fresh) setStage({ kind: "spawning", daemonId: fresh.daemonId });
	});

	/** creating → error: a global error frame landed while the project was registering. */
	createEffect(() => {
		const st = stage();
		if (st.kind !== "creating" || errorSnapshot === null) return;
		if (state.error !== null && state.error !== errorSnapshot) {
			setStage({ kind: "error", stage: "creating", message: state.error });
		}
	});

	/** spawning → ready (attach) / error (daemon_status error frame). */
	createEffect(() => {
		const st = stage();
		if (st.kind !== "spawning") return;
		const d = state.daemonRoster.find((x) => x.daemonId === st.daemonId);
		if (!d) return;
		if (d.status === "error") {
			setStage({ kind: "error", stage: "spawning", message: d.error ?? "daemon failed to start" });
			return;
		}
		if (d.status === "ready") {
			setStage({ kind: "attaching", daemonId: st.daemonId });
			void attachSession(st.daemonId)
				.then(onReady)
				.catch((err) =>
					setStage({
						kind: "error",
						stage: "attaching",
						message: err instanceof Error ? err.message : String(err),
					}),
				);
		}
	});

	/** Snapshot pre-command roster/error, run the send, then enter the
	 *  pipeline (or close when start was off). */
	const begin = (send: () => void, start: boolean, close: () => void) => {
		beforeIds = new Set(state.daemonRoster.map((d) => d.daemonId));
		errorSnapshot = state.error;
		send();
		if (start) setStage({ kind: "creating" });
		else close();
	};

	const busy = () => stage().kind !== "form";
	/** Narrowed error stage for the notice, or null. */
	const errorInfo = () => {
		const st = stage();
		return st.kind === "error" ? st : null;
	};

	return { stage, begin, busy, errorInfo };
}

/**
 * Register→spawn→attach progress strip. `prefix` is the feature's CSS class
 * prefix (`project-` / `worktree-`); the markup matches the original
 * hand-rolled footers so styles.css stays untouched.
 */
export const PipelineProgress: Component<{
	stage: Accessor<Stage>;
	labels: string[];
	note: string;
	prefix: string;
}> = (props) => (
	<Show when={props.stage().kind !== "form" && props.stage().kind !== "error"}>
		<div class={`${props.prefix}-progress`}>
			<For each={props.labels}>
				{(label, i) => (
					<div
						class={`${props.prefix}-progress-step`}
						classList={{
							done: i() < stageIndex(props.stage()),
							current: i() === stageIndex(props.stage()),
						}}
					>
						<span class={`${props.prefix}-progress-dot`} />
						<span class={`${props.prefix}-progress-label`}>{label}</span>
					</div>
				)}
			</For>
			<div class={`${props.prefix}-progress-note`}>{props.note}</div>
		</div>
	</Show>
);
