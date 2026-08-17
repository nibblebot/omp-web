import { createSignal, For, onMount, Show, type Component } from "solid-js";
import { call, pushNotice, setState } from "../../state";
import { Modal } from "../shared/Modal";
import { PickerRow } from "../shared/PickerRow";

interface BranchEntry {
	entryId: string;
	text: string;
}

/** Phase 5: `/tree` and `/branch` — pick an earlier message to branch from. */
export const BranchModal: Component<{ onClose: () => void }> = (props) => {
	const [entries, setEntries] = createSignal<BranchEntry[]>([]);
	const [error, setError] = createSignal<string | null>(null);

	onMount(() => {
		void call("getBranchMessages")
			.then((msgs) => setEntries(msgs as BranchEntry[]))
			.catch((err) => setError(String(err)));
	});

	const choose = (e: BranchEntry) => {
		void call("branch", [e.entryId])
			.then((result) => {
				const r = result as { text: string; cancelled: boolean } | null;
				if (r?.cancelled) {
					setError("Branch cancelled by extension");
					return;
				}
				pushNotice("info", `branched at: ${(r?.text ?? e.text).slice(0, 200)}`);
				setState("modal", null);
				props.onClose();
			})
			.catch((err) => setError(String(err)));
	};

	return (
		<Modal title="Branch session" onClose={props.onClose}>
			<Show when={error()}>{(err) => <div class="msg-notice">{err()}</div>}</Show>
			<div class="picker-list">
				<For each={entries()}>
					{(e) => (
						<PickerRow class="picker-row" onClick={() => choose(e)}>
							<span class="picker-label">{e.entryId.slice(0, 8)}</span>
							<span class="picker-detail">{e.text.slice(0, 160) || "(no text)"}</span>
						</PickerRow>
					)}
				</For>
				{entries().length === 0 && !error() && (
					<div class="tool-collapsed-note">no branch points</div>
				)}
			</div>
		</Modal>
	);
};
