import { createMemo, createResource, createSignal, For, Show, type Component } from "solid-js";
import type { ModelBrowserEntry, ModelRoleCatalogEntry } from "#lib/wire/protocol";
import { state } from "../../state";
import { loadModelBrowser, setModelRoleAssignment, setModelRoleHidden } from "../../store/models";
import { lockMessage } from "../../usage/model-search";
import { ChevronDownIcon } from "../ui/icons";

const selectorOf = (entry: ModelRoleCatalogEntry): string =>
	entry.provider && entry.id ? `${entry.provider}/${entry.id}` : "";

/** Available models grouped by provider, in first-seen provider order. */
const groupByProvider = (
	models: readonly ModelBrowserEntry[],
): Array<[string, ModelBrowserEntry[]]> => {
	const groups = new Map<string, ModelBrowserEntry[]>();
	for (const model of models) {
		const list = groups.get(model.provider) ?? [];
		list.push(model);
		groups.set(model.provider, list);
	}
	return [...groups.entries()];
};

/**
 * Role table for Settings > Model: one row per known role (built-in and
 * custom) with its assigned model, thinking suffix and persistence layer.
 * Each edit goes through the store, which writes config.yml and reports any
 * failure as a notice; a failed select is put back to the stored value.
 */
export const ModelRoleTable: Component = () => {
	const [busy, setBusy] = createSignal<string | undefined>();
	const groups = createMemo(() => groupByProvider(state.modelBrowser));
	// Options come from the same getModelBrowser list the quick picker reads. Settings
	// never opens the picker, so the table loads it itself and waits for it: a select
	// must never open with only "Clear (inherit)".
	const [browser] = createResource(loadModelBrowser);

	const run = async (role: string, action: () => Promise<boolean>): Promise<boolean> => {
		setBusy(role);
		try {
			return await action();
		} finally {
			setBusy(undefined);
		}
	};

	const pickModel = async (
		entry: ModelRoleCatalogEntry,
		select: HTMLSelectElement,
	): Promise<void> => {
		const selector = select.value;
		const ok = await run(entry.role, () =>
			setModelRoleAssignment(entry.role, selector || undefined),
		);
		if (!ok) select.value = selectorOf(entry);
	};

	const pickThinking = async (
		entry: ModelRoleCatalogEntry,
		select: HTMLSelectElement,
	): Promise<void> => {
		const level = select.value;
		const ok = await run(entry.role, () =>
			setModelRoleAssignment(entry.role, selectorOf(entry), level || undefined),
		);
		if (!ok) select.value = entry.thinkingLevel ?? "";
	};

	return (
		<Show when={state.modelRoleCatalog?.length && !browser.loading}>
			<div class="settings-block">
				<div class="settings-group">
					<div class="settings-roles-scroll">
						<table class="settings-roles">
							<caption>Model roles</caption>
							<thead>
								<tr>
									<th scope="col">Role</th>
									<th scope="col">Model</th>
									<th scope="col">Thinking</th>
									<th scope="col">Source</th>
									<th scope="col">Actions</th>
								</tr>
							</thead>
							<tbody>
								<For each={state.modelRoleCatalog}>
									{(entry) => (
										<tr classList={{ "settings-roles-hidden": entry.hidden }}>
											<th scope="row">
												<span class="settings-roles-name">{entry.name}</span>
												<Show when={entry.tag}>
													<span class="settings-roles-tag">{entry.tag}</span>
												</Show>
												<Show when={entry.hidden}>
													<span class="settings-roles-tag">hidden</span>
												</Show>
											</th>
											<td>
												<span class="settings-roles-value">
													{selectorOf(entry) || "inherits default"}
												</span>
												<span class="settings-select">
													<select
														aria-label={`Model for role ${entry.name}`}
														disabled={busy() !== undefined}
														onChange={(e) => void pickModel(entry, e.currentTarget)}
													>
														<option value="" selected={!selectorOf(entry)}>
															Clear (inherit)
														</option>
														<Show
															when={
																selectorOf(entry) &&
																!state.modelBrowser.some(
																	(m) => `${m.provider}/${m.id}` === selectorOf(entry),
																)
															}
														>
															<option value={selectorOf(entry)} selected>
																{selectorOf(entry)}
															</option>
														</Show>
														<For each={groups()}>
															{([provider, models]) => (
																<optgroup label={provider}>
																	<For each={models}>
																		{(model) => (
																			<option
																				value={`${model.provider}/${model.id}`}
																				disabled={model.locked !== undefined}
																				selected={
																					`${model.provider}/${model.id}` === selectorOf(entry)
																				}
																			>
																				{model.locked
																					? `${model.id} (${lockMessage(model.locked, model.provider)})`
																					: model.id}
																			</option>
																		)}
																	</For>
																</optgroup>
															)}
														</For>
													</select>
													<ChevronDownIcon class="settings-select-chevron" />
												</span>
											</td>
											<td>
												<span class="settings-roles-value">{entry.thinkingLevel ?? "inherit"}</span>
												<Show when={selectorOf(entry)}>
													<span class="settings-select">
														<select
															aria-label={`Thinking for role ${entry.name}`}
															disabled={busy() !== undefined}
															onChange={(e) => void pickThinking(entry, e.currentTarget)}
														>
															<option value="" selected={!entry.thinkingLevel}>
																inherit
															</option>
															<For each={state.thinkingSelectors ?? []}>
																{(level) => (
																	<option value={level} selected={level === entry.thinkingLevel}>
																		{level}
																	</option>
																)}
															</For>
														</select>
														<ChevronDownIcon class="settings-select-chevron" />
													</span>
												</Show>
											</td>
											<td>{entry.source}</td>
											<td>
												<button
													type="button"
													class="settings-reset"
													aria-label={`${entry.hidden ? "Show" : "Hide"} role ${entry.name}`}
													disabled={busy() !== undefined}
													onClick={() =>
														void run(entry.role, () =>
															setModelRoleHidden(entry.role, !entry.hidden),
														)
													}
												>
													{entry.hidden ? "Show" : "Hide"}
												</button>
											</td>
										</tr>
									)}
								</For>
							</tbody>
						</table>
					</div>
				</div>
				<Show when={state.modelRoleStorage}>
					{(scope) => <p class="settings-roles-storage">Saved to {scope()}</p>}
				</Show>
			</div>
		</Show>
	);
};
