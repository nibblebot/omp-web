import { createResource, createSignal, For, Show, type Component } from "solid-js";
import type { ModelRoleCatalogEntry } from "#lib/wire/protocol";
import { state } from "../../state";
import { loadModelBrowser, setModelRoleAssignment, setModelRoleHidden } from "../../store/models";
import { ChevronDownIcon } from "../ui/icons";
import { RoleModelPicker } from "./RoleModelPicker";

const selectorOf = (entry: ModelRoleCatalogEntry): string =>
	entry.provider && entry.id ? `${entry.provider}/${entry.id}` : "";

/**
 * Role table for Settings > Model: one row per known role (built-in and
 * custom) with its assigned model, thinking suffix and persistence layer.
 * The model opens the composer's searchable picker inline; the thinking level
 * stays a select. Each edit goes through the store, which writes config.yml and
 * reports any failure as a notice.
 */
export const ModelRoleTable: Component = () => {
	const [busy, setBusy] = createSignal<string | undefined>();
	const [openRole, setOpenRole] = createSignal<string | undefined>();
	// The picker's list comes from the same getModelBrowser list the composer reads.
	// Settings never opens the composer picker, so the table loads it itself and
	// waits for it before showing rows.
	const [browser] = createResource(loadModelBrowser);

	const run = async (role: string, action: () => Promise<boolean>): Promise<boolean> => {
		setBusy(role);
		try {
			return await action();
		} finally {
			setBusy(undefined);
		}
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
												<RoleModelPicker
													role={entry.role}
													name={entry.name}
													selector={selectorOf(entry) || undefined}
													open={openRole() === entry.role}
													disabled={busy() !== undefined}
													onOpen={() => setOpenRole(entry.role)}
													onClose={() => setOpenRole(undefined)}
													onPick={(selector) =>
														run(entry.role, () => setModelRoleAssignment(entry.role, selector))
													}
													onClear={() =>
														run(entry.role, () => setModelRoleAssignment(entry.role, undefined))
													}
												/>
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
