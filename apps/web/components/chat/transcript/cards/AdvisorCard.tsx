import { createEffect, createSignal, For, on, Show, type Component } from "solid-js";
import type { AdvisorItem } from "../../../../store/slices/advisor";
import { setState, state } from "../../../../state";
import { Card } from "../../../ui/Card";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Advisor card: notes the advisor injected into the primary session, rendered
 * inline like the TUI's `createAdvisorMessageCard`. Header `Advisor · N notes
 * [· K blockers]`, one severity-tinted rail per note with badge, advisor
 * attribution (non-default advisors only) and `T-n` age. Collapsed shows the
 * header alone; expanded adds every note. The Appearance sheet's Advisor
 * preference (`state.display.advisor`) picks the mode, independent of the
 * Ctrl+O tool-output toggle; clicking the header flips this card until the
 * preference changes again.
 */
export const AdvisorCard: Component<{ item: AdvisorItem }> = (props) => {
	const notes = () => props.item.notes;
	const blockers = () => notes().filter((n) => n.severity === "blocker").length;
	const [override, setOverride] = createSignal<boolean | undefined>(undefined);
	createEffect(
		on(
			() => state.display.advisor,
			() => setOverride(undefined),
			{ defer: true },
		),
	);
	const expanded = () => override() ?? state.display.advisor === "expanded";
	return (
		<Card class="advisor-item" classList={{ "advisor-has-blocker": blockers() > 0 }}>
			<div class="advisor-head">
				<button
					type="button"
					class="advisor-summary"
					aria-expanded={expanded()}
					onClick={() => setOverride(!expanded())}
				>
					<span class="advisor-label">Advisor</span>
					<span class="advisor-meta"> · {plural(notes().length, "note")}</span>
					<Show when={blockers() > 0}>
						<span class="advisor-blockers"> · {plural(blockers(), "blocker")}</span>
					</Show>
				</button>
				<button class="advisor-open" onClick={() => setState("modal", "advisor")}>
					Open advisor
				</button>
			</div>
			<For each={expanded() ? notes() : []}>
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
		</Card>
	);
};
