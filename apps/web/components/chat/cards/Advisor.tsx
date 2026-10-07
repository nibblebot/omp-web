import { createEffect, createSignal, For, on, Show, type Component } from "solid-js";
import { state, type AdvisorItem } from "../../../state";

/** Notes shown while collapsed; matches the TUI advisor card (COLLAPSED_NOTES). */
const COLLAPSED_NOTES = 3;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Advisor card: notes the advisor injected into the primary session, rendered
 * inline like the TUI's `createAdvisorMessageCard`. Header `Advisor · N notes
 * [· K blockers]`, one severity-tinted rail per note with badge, advisor
 * attribution (non-default advisors only) and `T-n` age. Expansion follows the
 * transcript-wide tool-output toggle (Ctrl+O); a local toggle overrides it
 * until the global toggle changes again.
 */
export const AdvisorCard: Component<{ item: AdvisorItem }> = (props) => {
	const notes = () => props.item.notes;
	const blockers = () => notes().filter((n) => n.severity === "blocker").length;
	const [override, setOverride] = createSignal<boolean | undefined>(undefined);
	createEffect(
		on(
			() => state.toolsExpanded,
			() => setOverride(undefined),
			{ defer: true },
		),
	);
	const collapsible = () => notes().length > COLLAPSED_NOTES;
	const expanded = () => override() ?? state.toolsExpanded;
	const shown = () => (collapsible() && !expanded() ? notes().slice(0, COLLAPSED_NOTES) : notes());
	const hidden = () => notes().length - shown().length;
	return (
		<div class="advisor-item" classList={{ "advisor-has-blocker": blockers() > 0 }}>
			<div class="advisor-head">
				<span class="advisor-label">Advisor</span>
				<span class="advisor-meta"> · {plural(notes().length, "note")}</span>
				<Show when={blockers() > 0}>
					<span class="advisor-blockers"> · {plural(blockers(), "blocker")}</span>
				</Show>
			</div>
			<For each={shown()}>
				{(n) => (
					<div class={`advisor-note advisor-sev-${n.severity ?? "none"}`}>
						<Show when={n.severity}>
							<span class="advisor-badge">{n.severity}</span>
						</Show>
						<Show when={n.turnsAgo !== undefined}>
							<span class="advisor-dim">T-{n.turnsAgo}</span>
						</Show>
						<Show when={n.advisor && n.advisor !== "default"}>
							<span class="advisor-dim">[{n.advisor}]</span>
						</Show>
						<span class="advisor-text">{n.note}</span>
					</div>
				)}
			</For>
			<Show when={collapsible()}>
				<button class="advisor-toggle" onClick={() => setOverride(!expanded())}>
					{hidden() > 0 ? `… +${plural(hidden(), "more note")}` : "show fewer"}
				</button>
			</Show>
		</div>
	);
};
