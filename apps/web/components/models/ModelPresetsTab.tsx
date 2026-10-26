import {
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	Show,
	type Component,
	type JSX,
} from "solid-js";
import type { ModelPresetDetail } from "#lib/wire/protocol";
import { state } from "../../state";
import {
	applyModelPreset,
	deleteModelPreset,
	presetNameError,
	saveModelPreset,
	updateModelPreset,
} from "../../store/models";
import { ArrowLeftIcon, PlusIcon, TrashIcon, WarningIcon } from "../ui/icons";
import {
	presetSourceLabel,
	presetLockReason,
	presetRoleRows,
	type ModelDialogPane,
} from "../../usage/model-roles";

/** Focus `id` once the DOM has re-rendered; inline editors unmount the control that held focus. */
function focusSoon(id: string): void {
	queueMicrotask(() => document.getElementById(id)?.focus());
}

/** A hover reason on a control that is disabled (a disabled button swallows its own tooltip). */
const Tip: Component<{ reason: string | undefined; children: JSX.Element }> = (props) => (
	<span class="model-dialog-tip" title={props.reason}>
		{props.children}
	</span>
);

/** Escape cancels an inline editor without closing the dialog (Modal skips `data-inline-escape` targets). */
const cancelOnEscape = (cancel: () => void) => (e: KeyboardEvent) => {
	if (e.key !== "Escape") return;
	e.preventDefault();
	e.stopPropagation();
	cancel();
};

/**
 * Presets tab: every saved preset in a sidebar (active badge, source badge, warning for
 * a malformed one, inline delete confirm, inline save field) and the selected preset's
 * read-only roles on the right, with Activate and Update from current roles.
 */
export const ModelPresetsTab: Component<{
	pane: ModelDialogPane;
	onPane: (pane: ModelDialogPane) => void;
	onClose: () => void;
}> = (props) => {
	const [selected, setSelected] = createSignal<string | undefined>();
	const [confirmDelete, setConfirmDelete] = createSignal<string | undefined>();
	const [confirmUpdate, setConfirmUpdate] = createSignal(false);
	const [busy, setBusy] = createSignal(false);
	const [saving, setSaving] = createSignal(false);
	const [name, setName] = createSignal("");
	const [saveError, setSaveError] = createSignal<string | undefined>();

	const presets = createMemo(() =>
		[...(state.modelPresetDetails ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
	);
	const active = (): string | undefined => state.modelPresets?.active;
	const current = createMemo<ModelPresetDetail | undefined>(() => {
		const all = presets();
		return all.find((p) => p.name === selected()) ?? all.find((p) => p.name === active()) ?? all[0];
	});
	const nameError = (): string | undefined =>
		presetNameError(name().trim(), state.modelPresets?.names ?? []);
	const shownError = (): string | undefined =>
		name() === "" ? undefined : (saveError() ?? nameError());

	createEffect(
		on(
			() => current()?.name,
			() => setConfirmUpdate(false),
			{ defer: true },
		),
	);

	const select = (preset: ModelPresetDetail): void => {
		setSelected(preset.name);
		props.onPane("detail");
	};

	const remove = async (preset: ModelPresetDetail): Promise<void> => {
		setBusy(true);
		const deleted = await deleteModelPreset(preset.name);
		setBusy(false);
		setConfirmDelete(undefined);
		focusSoon(deleted ? "model-preset-save-open" : `model-preset-trash-${preset.name}`);
	};

	const cancelDelete = (preset: ModelPresetDetail): void => {
		setConfirmDelete(undefined);
		focusSoon(`model-preset-trash-${preset.name}`);
	};

	const activate = async (preset: ModelPresetDetail): Promise<void> => {
		setBusy(true);
		const ok = await applyModelPreset(preset.name);
		setBusy(false);
		if (ok) props.onClose();
	};

	const update = async (preset: ModelPresetDetail): Promise<void> => {
		setBusy(true);
		const ok = await updateModelPreset(preset.name);
		setBusy(false);
		if (ok) setConfirmUpdate(false);
	};

	const openSave = (): void => {
		setSaving(true);
		focusSoon("model-preset-name");
	};
	const cancelSave = (): void => {
		setSaving(false);
		setName("");
		setSaveError(undefined);
		focusSoon("model-preset-save-open");
	};
	const submitSave = async (e: SubmitEvent): Promise<void> => {
		e.preventDefault();
		const value = name().trim();
		if (nameError() !== undefined || busy()) return;
		setBusy(true);
		const error = await saveModelPreset(value);
		setBusy(false);
		if (error !== undefined) {
			setSaveError(error);
			return;
		}
		setSelected(value);
		setSaving(false);
		setName("");
		focusSoon("model-preset-save-open");
	};

	return (
		<div class="model-dialog-split" data-pane={props.pane}>
			<div class="model-dialog-side">
				<ul class="model-dialog-list" aria-label="Presets">
					<For each={presets()}>
						{(preset) => {
							const deleteReason = (): string | undefined => presetLockReason(preset, "delete");
							return (
								<li
									class="model-dialog-row"
									classList={{ selected: current()?.name === preset.name }}
								>
									<Show
										when={confirmDelete() === preset.name}
										fallback={
											<>
												<button
													type="button"
													class="model-dialog-row-main"
													aria-current={current()?.name === preset.name ? "true" : undefined}
													onClick={() => select(preset)}
												>
													<span class="model-dialog-row-name">{preset.name}</span>
													<Show when={preset.name === active()}>
														<span class="picker-chip">active</span>
													</Show>
													<Show when={presetSourceLabel(preset)}>
														{(label) => (
															<span class="picker-chip" title={presetLockReason(preset, "delete")}>
																{label()}
															</span>
														)}
													</Show>
													<Show when={preset.invalid}>
														{(reason) => (
															<span class="model-dialog-warn" title={reason()}>
																<WarningIcon />
																<span class="visually-hidden">Malformed preset</span>
															</span>
														)}
													</Show>
												</button>
												<Tip reason={deleteReason()}>
													<button
														type="button"
														id={`model-preset-trash-${preset.name}`}
														class="model-dialog-icon-btn"
														aria-label={`Delete preset ${preset.name}`}
														disabled={deleteReason() !== undefined || busy()}
														onClick={() => {
															setConfirmDelete(preset.name);
															focusSoon(`model-preset-delete-cancel-${preset.name}`);
														}}
													>
														<TrashIcon />
													</button>
												</Tip>
											</>
										}
									>
										<div
											class="model-dialog-confirm"
											role="group"
											aria-label={`Delete preset ${preset.name}`}
											data-inline-escape
											onKeyDown={cancelOnEscape(() => cancelDelete(preset))}
										>
											<span class="model-dialog-confirm-text">Delete "{preset.name}"?</span>
											<button
												type="button"
												class="settings-control-btn model-dialog-danger"
												disabled={busy()}
												onClick={() => void remove(preset)}
											>
												Delete
											</button>
											<button
												type="button"
												id={`model-preset-delete-cancel-${preset.name}`}
												class="settings-control-btn"
												onClick={() => cancelDelete(preset)}
											>
												Cancel
											</button>
										</div>
									</Show>
								</li>
							);
						}}
					</For>
				</ul>
				<div class="model-dialog-side-foot">
					<Show
						when={saving()}
						fallback={
							<button
								type="button"
								id="model-preset-save-open"
								class="settings-control-btn model-dialog-save-open"
								onClick={openSave}
							>
								<PlusIcon /> Save preset
							</button>
						}
					>
						<form
							class="model-dialog-save"
							data-inline-escape
							onSubmit={(e) => void submitSave(e)}
							onKeyDown={cancelOnEscape(cancelSave)}
						>
							<input
								id="model-preset-name"
								class="picker-filter"
								type="text"
								placeholder="Preset name"
								aria-label="Preset name"
								aria-invalid={shownError() !== undefined}
								aria-describedby="model-preset-name-error"
								autocomplete="off"
								spellcheck={false}
								value={name()}
								onInput={(e) => {
									setName(e.currentTarget.value);
									setSaveError(undefined);
								}}
							/>
							<p id="model-preset-name-error" class="model-dialog-error" role="alert">
								{shownError()}
							</p>
							<div class="model-dialog-actions">
								<button
									type="submit"
									class="settings-control-btn"
									disabled={nameError() !== undefined || busy()}
								>
									Save
								</button>
								<button type="button" class="settings-control-btn" onClick={cancelSave}>
									Cancel
								</button>
							</div>
						</form>
					</Show>
				</div>
			</div>
			<section class="model-dialog-detail" aria-label="Preset detail">
				<button
					type="button"
					class="picker-back model-dialog-back"
					onClick={() => props.onPane("list")}
				>
					<ArrowLeftIcon /> Back
				</button>
				<Show
					when={current()}
					fallback={
						<div class="model-dialog-empty">
							<Show
								when={state.modelPresetDetails !== undefined}
								fallback={<p class="picker-detail">Loading presets...</p>}
							>
								<p class="model-dialog-empty-title">No presets yet</p>
								<p class="picker-detail">
									A preset saves your current model roles and default thinking level under a name,
									so you can switch the whole setup in one step. Use Save preset to snapshot the
									roles as they are now.
								</p>
							</Show>
						</div>
					}
				>
					{(preset) => {
						const isActive = (): boolean => preset().name === active();
						const updateReason = (): string | undefined => presetLockReason(preset(), "update");
						const activateReason = (): string | undefined =>
							preset().invalid !== undefined
								? "This preset is malformed and cannot be activated."
								: undefined;
						const rows = createMemo(() =>
							presetRoleRows(preset(), state.modelRoleCatalog ?? [], !isActive()),
						);
						return (
							<>
								<header class="model-dialog-detail-head">
									<h3 class="model-dialog-detail-title">{preset().name}</h3>
									<Show when={isActive()}>
										<span class="picker-chip">active</span>
									</Show>
									<Show when={presetSourceLabel(preset())}>
										{(label) => <span class="picker-chip">{label()}</span>}
									</Show>
								</header>
								<Show when={preset().invalid === undefined}>
									<p class="picker-detail">
										Default thinking: {preset().defaultThinkingLevel ?? "inherit"}
									</p>
								</Show>
								<div class="model-dialog-actions">
									<Tip reason={activateReason()}>
										<button
											type="button"
											class="settings-control-btn model-dialog-primary"
											disabled={isActive() || preset().invalid !== undefined || busy()}
											onClick={() => void activate(preset())}
										>
											{isActive() ? "Active" : "Activate"}
										</button>
									</Tip>
									<Show
										when={confirmUpdate()}
										fallback={
											<Tip reason={updateReason()}>
												<button
													type="button"
													class="settings-control-btn"
													disabled={updateReason() !== undefined || busy()}
													onClick={() => {
														setConfirmUpdate(true);
														focusSoon("model-preset-update-cancel");
													}}
												>
													Update from current roles
												</button>
											</Tip>
										}
									>
										<div
											class="model-dialog-confirm"
											role="group"
											aria-label="Update preset"
											data-inline-escape
											onKeyDown={cancelOnEscape(() => {
												setConfirmUpdate(false);
											})}
										>
											<span class="model-dialog-confirm-text">
												Overwrite "{preset().name}" with the current roles?
											</span>
											<button
												type="button"
												class="settings-control-btn model-dialog-danger"
												disabled={busy()}
												onClick={() => void update(preset())}
											>
												Update
											</button>
											<button
												type="button"
												id="model-preset-update-cancel"
												class="settings-control-btn"
												onClick={() => setConfirmUpdate(false)}
											>
												Cancel
											</button>
										</div>
									</Show>
								</div>
								<Show
									when={preset().invalid}
									fallback={
										<ul class="model-dialog-role-list" aria-label="Preset roles">
											<For each={rows()}>
												{(row) => (
													<li class="model-dialog-role-row">
														<span class="model-dialog-role-name">{row.label}</span>
														<span class="model-dialog-role-model">{row.model}</span>
														<span class="picker-detail">thinking {row.level ?? "inherit"}</span>
														<Show when={row.current}>
															{(live) => <span class="model-dialog-diff">current: {live()}</span>}
														</Show>
													</li>
												)}
											</For>
										</ul>
									}
								>
									{(reason) => (
										<p class="model-dialog-invalid" role="alert">
											<WarningIcon /> {reason()}
										</p>
									)}
								</Show>
							</>
						);
					}}
				</Show>
			</section>
		</div>
	);
};
