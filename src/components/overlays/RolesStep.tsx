import { For, Show, type Component } from "solid-js";
import type { ModelRoleCatalogEntry } from "../../../shared/protocol";
import { thinkingLevelLabel } from "../../usage/model-options";
import { call, setState, state } from "../../state";
import { CharacterAvatar } from "../shared/CharacterAvatar";
import { ChevronDownIcon, ChevronRightIcon } from "../shared/icons";
import { useClickableRow } from "../shared/PickerRow";

/**
 * Step 1 of the model-role wizard: the role catalog (visible + collapsible
 * hidden sections) and the storage-scope note. Rows are composite — each
 * carries nested clear/hide action buttons — so they stay div +
 * useClickableRow rather than PickerRow (a real <button> cannot nest
 * buttons). Navigation is handed up via onPickRole; the hidden-section
 * expansion lives in ModelModal so it survives step navigation.
 */
export const RolesStep: Component<{
	showHidden: boolean;
	onToggleHidden: () => void;
	onPickRole: (entry: ModelRoleCatalogEntry) => void;
}> = (props) => {
	/** Is this catalog entry the role's currently assigned model? */
	const isActiveRole = (entry: ModelRoleCatalogEntry) =>
		entry.provider !== undefined &&
		entry.id !== undefined &&
		state.model?.provider === entry.provider &&
		state.model?.id === entry.id;
	const roles = () => state.modelRoleCatalog?.filter((e) => !e.hidden) ?? [];
	const hiddenRoles = () => state.modelRoleCatalog?.filter((e) => e.hidden) ?? [];

	return (
		<>
			<div class="picker-list">
				<For each={roles()}>
					{(entry) => (
						<div
							class="picker-row"
							classList={{ active: isActiveRole(entry) }}
							aria-pressed={isActiveRole(entry)}
							{...useClickableRow(() => props.onPickRole(entry))}
							title={`${entry.tag ?? entry.name} — pick a model`}
						>
							<Show when={entry.provider && entry.id}>
								<CharacterAvatar
									class="picker-avatar"
									provider={entry.provider}
									id={entry.id}
									size={32}
								/>
							</Show>
							<span class="picker-label">{entry.tag ?? entry.name}</span>
							{entry.provider && entry.id ? (
								<span class="picker-meta">
									{entry.provider}/{entry.id}
								</span>
							) : (
								<span class="picker-detail">auto</span>
							)}
							{entry.thinkingLevel && (
								<span class="picker-chip">{thinkingLevelLabel(entry.thinkingLevel)}</span>
							)}
							{entry.provider && entry.id && (
								<button
									class="picker-row-action"
									title={`Clear ${entry.tag ?? entry.name} (back to auto)`}
									onClick={(e) => {
										e.stopPropagation();
										void call("clearModelRole", [entry.role]).catch((err) =>
											setState("error", String(err)),
										);
									}}
								>
									clear
								</button>
							)}
							<button
								class="picker-row-action"
								title={`Hide ${entry.tag ?? entry.name}`}
								onClick={(e) => {
									e.stopPropagation();
									void call("setModelRoleHidden", [entry.role, true]).catch((err) =>
										setState("error", String(err)),
									);
								}}
							>
								hide
							</button>
						</div>
					)}
				</For>
				<Show when={state.modelRoleCatalog === undefined}>
					<div class="picker-note">No models available</div>
				</Show>
			</div>
			<Show when={hiddenRoles().length > 0}>
				<div class="picker-group-head">
					<button class="picker-hidden-toggle" onClick={props.onToggleHidden}>
						{props.showHidden ? <ChevronDownIcon /> : <ChevronRightIcon />} hidden roles (
						{hiddenRoles().length})
					</button>
				</div>
				<Show when={props.showHidden}>
					<div class="picker-list">
						<For each={hiddenRoles()}>
							{(entry) => (
								<div class="picker-row">
									<Show when={entry.provider && entry.id}>
										<CharacterAvatar
											class="picker-avatar"
											provider={entry.provider}
											id={entry.id}
											size={32}
										/>
									</Show>
									<span class="picker-label">{entry.tag ?? entry.name}</span>
									{entry.provider && entry.id ? (
										<span class="picker-meta">
											{entry.provider}/{entry.id}
										</span>
									) : (
										<span class="picker-detail">auto</span>
									)}
									<button
										class="picker-row-action"
										title={`Unhide ${entry.tag ?? entry.name}`}
										onClick={() =>
											void call("setModelRoleHidden", [entry.role, false]).catch((err) =>
												setState("error", String(err)),
											)
										}
									>
										unhide
									</button>
								</div>
							)}
						</For>
					</div>
				</Show>
			</Show>
			<div class="picker-note">
				{state.modelRoleStorage === "project"
					? "saves to project .omp/config.yml"
					: "saves to global config.yml"}
			</div>
		</>
	);
};
