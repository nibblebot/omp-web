import { createMemo, createSignal, For, Show, type Component } from "solid-js";
import type { ModelRoleCatalogEntry } from "#lib/wire/protocol";
import { state } from "../../state";
import {
	selectModelDialogRole,
	setModelRoleAssignment,
	setModelRoleHidden,
} from "../../store/models";
import { ArrowLeftIcon, ChevronDownIcon } from "../ui/icons";
import { ModelSearchList } from "./ModelSearchList";
import {
	modelThinkingEfforts,
	roleDisplay,
	roleLabel,
	roleSelector,
	sortedRoles,
	type ModelDialogPane,
} from "../../usage/model-roles";

/**
 * Roles tab: every role with its assigned model in a sidebar (hidden roles last, dimmed)
 * and the selected role's editor on the right: a full-height searchable model list,
 * the role model's own thinking levels, Unassign, Show/Hide, source and storage note.
 * Edits persist through the store, which reports failures as notices.
 */
export const ModelRolesTab: Component<{
	pane: ModelDialogPane;
	onPane: (pane: ModelDialogPane) => void;
}> = (props) => {
	const [busy, setBusy] = createSignal(false);
	const roles = createMemo(() => sortedRoles(state.modelRoleCatalog ?? []));
	const current = createMemo<ModelRoleCatalogEntry | undefined>(
		() =>
			roles().find((r) => r.role === state.modelDialogRole) ??
			roles().find((r) => r.role === "default") ??
			roles()[0],
	);

	const run = async (action: () => Promise<boolean>): Promise<boolean> => {
		setBusy(true);
		try {
			return await action();
		} finally {
			setBusy(false);
		}
	};

	return (
		<div class="model-dialog-split" data-pane={props.pane}>
			<div class="model-dialog-side">
				<ul class="model-dialog-list model-dialog-roles" aria-label="Roles">
					<For each={roles()}>
						{(entry) => (
							<li
								class="model-dialog-row"
								classList={{ selected: current()?.role === entry.role, hidden: entry.hidden }}
							>
								<button
									type="button"
									class="model-dialog-row-main model-dialog-role-main"
									aria-current={current()?.role === entry.role ? "true" : undefined}
									onClick={() => {
										selectModelDialogRole(entry.role);
										props.onPane("detail");
									}}
								>
									<span class="model-dialog-role-label">
										<span class="model-dialog-row-name" title={entry.name}>
											{roleLabel(entry)}
										</span>
										<Show when={entry.hidden}>
											<span class="picker-chip">hidden</span>
										</Show>
									</span>
									<span class="picker-detail model-dialog-row-model" title={roleDisplay(entry)}>
										{roleDisplay(entry) ?? "auto"}
									</span>
									<span
										class="picker-detail model-dialog-row-thinking"
										title={entry.thinkingLevel && `Thinking: ${entry.thinkingLevel}`}
									>
										{entry.thinkingLevel ?? ""}
									</span>
								</button>
							</li>
						)}
					</For>
				</ul>
			</div>
			<section class="model-dialog-detail" aria-label="Role detail">
				<button
					type="button"
					class="picker-back model-dialog-back"
					onClick={() => props.onPane("list")}
				>
					<ArrowLeftIcon /> Back
				</button>
				<Show
					when={current()}
					fallback={<p class="picker-detail">No model roles are available for this session.</p>}
				>
					{(entry) => {
						const selector = (): string | undefined => roleSelector(entry());
						const efforts = createMemo(() => modelThinkingEfforts(state.modelBrowser, selector()));
						// A level the role carries but its model no longer lists still shows, so it can be cleared.
						const levels = createMemo(() => {
							const level = entry().thinkingLevel;
							return level && !efforts().includes(level) ? [...efforts(), level] : efforts();
						});

						const pickModel = (picked: string): Promise<boolean> => {
							// Keep the role's thinking level only when the new model supports it.
							const level = entry().thinkingLevel;
							const supported = modelThinkingEfforts(state.modelBrowser, picked);
							return run(() =>
								setModelRoleAssignment(
									entry().role,
									picked,
									level && supported.includes(level) ? level : undefined,
								),
							);
						};

						const pickThinking = async (select: HTMLSelectElement): Promise<void> => {
							const chosen = selector();
							if (chosen === undefined) return;
							const level = select.value;
							const ok = await run(() =>
								setModelRoleAssignment(entry().role, chosen, level || undefined),
							);
							if (!ok) select.value = entry().thinkingLevel ?? "";
						};

						return (
							<>
								<header class="model-dialog-detail-head">
									<h3 class="model-dialog-detail-title" title={entry().name}>
										{roleLabel(entry())}
									</h3>
									<Show when={entry().hidden}>
										<span class="picker-chip">hidden</span>
									</Show>
								</header>
								<p class="picker-detail">
									{roleDisplay(entry()) ?? "Unassigned: auto-selection applies."} Source:{" "}
									{entry().source}.
									<Show when={state.modelRoleStorage}>{(scope) => <> Saved to {scope()}.</>}</Show>
								</p>
								<div class="model-dialog-actions">
									<label class="model-dialog-field">
										<span class="picker-detail">Thinking</span>
										<span class="settings-select">
											<select
												aria-label={`Thinking for role ${entry().name}`}
												disabled={busy() || selector() === undefined}
												title={
													selector() !== undefined && efforts().length === 0
														? "This model does not offer thinking levels."
														: undefined
												}
												onChange={(e) => void pickThinking(e.currentTarget)}
											>
												<option value="" selected={!entry().thinkingLevel}>
													inherit
												</option>
												<For each={levels()}>
													{(level) => (
														<option value={level} selected={level === entry().thinkingLevel}>
															{level}
														</option>
													)}
												</For>
											</select>
											<ChevronDownIcon class="settings-select-chevron" />
										</span>
									</label>
									<button
										type="button"
										class="settings-control-btn"
										title="Back to auto-selection for this role"
										disabled={busy() || selector() === undefined}
										onClick={() => void run(() => setModelRoleAssignment(entry().role, undefined))}
									>
										Unassign
									</button>
									<button
										type="button"
										class="settings-control-btn"
										aria-label={`${entry().hidden ? "Show" : "Hide"} role ${entry().name}`}
										disabled={busy()}
										onClick={() =>
											void run(() => setModelRoleHidden(entry().role, !entry().hidden))
										}
									>
										{entry().hidden ? "Show" : "Hide"}
									</button>
								</div>
								<div class="model-dialog-grow">
									<Show when={entry().role} keyed>
										<ModelSearchList
											label={`Search models for role ${entry().name}`}
											placeholder="Search models"
											currentSelector={selector()}
											onPick={pickModel}
											onPicked={() => undefined}
										/>
									</Show>
								</div>
							</>
						);
					}}
				</Show>
			</section>
		</div>
	);
};
