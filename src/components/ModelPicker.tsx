import { createSignal, For, onMount, type Component } from "solid-js";
import type { ModelInfo } from "../../shared/protocol";
import { fuzzyRank } from "../autocomplete";
import { call, setState, state } from "../state";
import { Modal } from "./Modal";
import { PickerRow } from "./PickerRow";

/** Model picker: fetches on open, fuzzy-filtered, grouped by provider. */
/** Compact context-window label for model rows, e.g. "ctx 128k" / "ctx 1.2M". */
function formatCtx(tokens: number | null | undefined): string | undefined {
	if (!tokens || tokens <= 0) return undefined;
	if (tokens >= 1_000_000) return `ctx ${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	return `ctx ${Math.round(tokens / 1000)}k`;
}

export const ModelPicker: Component<{ onClose: () => void }> = props => {
	const [filter, setFilter] = createSignal("");
	let input!: HTMLInputElement;

	onMount(() => {
		input.focus();
		void call("getAvailableModels")
			.then(models => setState("availableModels", models as ModelInfo[]))
			.catch(err => setState("error", String(err)));
	});

	const groups = () => {
		const q = filter();
		const byProvider = new Map<string, ModelInfo[]>();
		for (const m of state.availableModels) {
			const rank = fuzzyRank(q, `${m.provider}/${m.id}`);
			if (rank === null) continue;
			const list = byProvider.get(m.provider) ?? [];
			list.push(m);
			byProvider.set(m.provider, list);
		}
		return [...byProvider.entries()];
	};

	const choose = (m: ModelInfo) => {
		void call("setModel", [m.provider, m.id]).catch(err => setState("error", String(err)));
		props.onClose();
	};

	return (
		<Modal title="Model" onClose={props.onClose}>
			<input
				class="picker-filter"
				ref={input}
				placeholder="Filter models…"
				value={filter()}
				onInput={e => setFilter(e.currentTarget.value)}
				onKeyDown={e => {
					if (e.key === "Enter") {
						const first = groups()[0]?.[1][0];
						if (first) choose(first);
					}
				}}
			/>
			<div class="picker-list">
				<For each={groups()}>
					{([provider, models]) => (
						<div class="picker-group">
							<div class="picker-group-name">{provider}</div>
							<For each={models}>
								{m => (
									<PickerRow
										class="picker-row"
										classList={{ active: state.model?.provider === m.provider && state.model?.id === m.id }}
										onClick={() => choose(m)}
									>
										<span class="picker-label">{m.id}</span>
										{m.reasoning && <span class="picker-chip">reasoning</span>}
										{formatCtx(m.contextWindow) && (
											<span class="picker-meta">{formatCtx(m.contextWindow)}</span>
										)}
									</PickerRow>
								)}
							</For>
						</div>
					)}
				</For>
			</div>
		</Modal>
	);
};
