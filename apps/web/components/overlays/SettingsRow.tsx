import { createSignal, For, Show, type JSX } from "solid-js";
import {
	displayOptionValue,
	formatItemValue,
	formatSettingValue,
	parseSettingDraft,
	settingEffectLabel,
} from "../../prefs/settings";
import { state } from "../../state";
import { unsetSetting, updateSetting as writeSetting } from "../../store/settings";
import { ChevronDownIcon, ChevronUpIcon } from "../shared/icons";
import type { SettingsItem } from "#lib/wire/protocol";

/** Shared row layout: label (+ changed dot) and description left, control right. */
export function Row(props: {
	label: string;
	description?: string;
	changed?: boolean;
	children: JSX.Element;
}) {
	return (
		<div class="settings-item">
			<div>
				<div class="settings-item-label">
					{props.label}
					<Show when={props.changed}>
						<span class="changed-dot" />
					</Show>
				</div>
				<Show when={props.description}>
					<div class="settings-item-desc">{props.description}</div>
				</Show>
			</div>
			<div class="settings-item-control">{props.children}</div>
		</div>
	);
}

/** One server-model row; widget depends on item.type. */
export function SettingsRow(props: { item: SettingsItem }) {
	const item = props.item;
	// Text draft: local until Enter/blur commits it (placeholder shows the
	// current value; the draft starts empty so a no-op blur sends nothing).
	const [draft, setDraft] = createSignal("");
	const [dirty, setDirty] = createSignal(false);
	const [showSecret, setShowSecret] = createSignal(false);
	// providerLimits: expanded panel with per-provider drafts, reseeded on open.
	const [limitsOpen, setLimitsOpen] = createSignal(false);
	const [limitDrafts, setLimitDrafts] = createSignal<Record<string, string>>({});
	const [jsonDraft, setJsonDraft] = createSignal("");
	const [jsonEditing, setJsonEditing] = createSignal(false);
	const [jsonError, setJsonError] = createSignal("");
	const [layer, setLayer] = createSignal(
		item.view?.explicit?.layer === "project" ? "project" : "global",
	);
	let draftRevision: number | undefined;
	const updateSetting = (
		path: string,
		value: unknown,
		revision = state.settingsModel?.revision,
	) => {
		writeSetting(path, value, revision, layer());
	};
	const commitJson = () => {
		try {
			const value = parseSettingDraft(jsonDraft());
			setJsonError("");
			updateSetting(item.path, value, draftRevision);
			setJsonEditing(false);
		} catch (error) {
			setJsonError(`Invalid JSON: ${String(error)}`);
		}
	};

	const commitText = () => {
		if (!dirty()) return;
		updateSetting(item.path, draft(), draftRevision);
		setDraft("");
		setDirty(false);
	};

	const seedLimitDrafts = () => {
		draftRevision = state.settingsModel?.revision;
		const record = (item.value && typeof item.value === "object" ? item.value : {}) as Record<
			string,
			number
		>;
		const seeded: Record<string, string> = {};
		for (const provider of item.providers ?? []) {
			seeded[provider] = record[provider] !== undefined ? String(record[provider]) : "";
		}
		setLimitDrafts(seeded);
	};

	const commitLimit = (provider: string, raw: string) => {
		const next = { ...limitDrafts(), [provider]: raw };
		setLimitDrafts(next);
		// Empty input removes a provider limit; all numeric constraints belong to the backend.
		const out: Record<string, unknown> = { ...((item.value as Record<string, unknown>) ?? {}) };
		for (const p of item.providers ?? []) {
			const text = next[p];
			if (text === undefined || text === "") {
				delete out[p];
			} else {
				const n = Number(text);
				out[p] = Number.isFinite(n) ? n : text;
			}
		}
		updateSetting(item.path, out, draftRevision);
	};

	const resetLimits = () => {
		setLimitDrafts(Object.fromEntries((item.providers ?? []).map((p) => [p, ""])));
		updateSetting(item.path, {});
	};

	const selected = () => (Array.isArray(item.value) ? (item.value as string[]) : []);
	const chipOptions = () =>
		item.options ??
		(item.values ?? []).map((v) => ({ value: v, label: v, description: undefined }));
	const toggleOption = (value: string) => {
		const cur = selected();
		const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
		updateSetting(item.path, next);
	};
	const moveOption = (value: string, dir: -1 | 1) => {
		const cur = [...selected()];
		const i = cur.indexOf(value);
		if (i < 0) return;
		const j = i + dir;
		if (j < 0 || j >= cur.length) return;
		[cur[i], cur[j]] = [cur[j], cur[i]];
		updateSetting(item.path, cur);
	};

	let control: JSX.Element;
	switch (item.type) {
		case "boolean":
			control = (
				<input
					type="checkbox"
					aria-label={item.label}
					checked={Boolean(item.value)}
					onChange={(e) => updateSetting(item.path, e.currentTarget.checked)}
				/>
			);
			break;
		case "enum":
			control = (
				<select
					aria-label={item.label}
					value={displayOptionValue(item, item.value)}
					onChange={(e) => updateSetting(item.path, e.currentTarget.value)}
				>
					<For each={item.values ?? []}>{(v) => <option value={v}>{v}</option>}</For>
				</select>
			);
			break;
		case "submenu":
			control = (
				<select
					aria-label={item.label}
					value={displayOptionValue(item, item.value)}
					onChange={(e) => updateSetting(item.path, e.currentTarget.value)}
				>
					<For each={item.options ?? []}>
						{(opt) => (
							<option value={opt.value} title={opt.description}>
								{opt.label}
							</option>
						)}
					</For>
				</select>
			);
			break;
		case "text":
			control = (
				<div class="settings-text">
					<input
						type={item.secret && !showSecret() ? "password" : "text"}
						aria-label={item.label}
						value={draft()}
						placeholder={formatItemValue(item)}
						onInput={(e) => {
							if (!dirty()) draftRevision = state.settingsModel?.revision;
							setDraft(e.currentTarget.value);
							setDirty(true);
						}}
						onBlur={commitText}
						onKeyDown={(e) => {
							if (e.key === "Enter") e.currentTarget.blur();
						}}
					/>
					<Show when={item.secret}>
						<button
							type="button"
							class="settings-control-btn"
							onClick={() => setShowSecret((v) => !v)}
						>
							{showSecret() ? "hide" : "show"}
						</button>
					</Show>
				</div>
			);
			break;
		case "multiselect":
			control = (
				<div class="settings-chips">
					<For each={chipOptions()}>
						{(opt) => {
							const on = selected().includes(opt.value);
							return (
								<span class="settings-chip-wrap">
									<button
										type="button"
										class="settings-chip"
										aria-pressed={on}
										onClick={() => toggleOption(opt.value)}
									>
										{opt.label}
									</button>
									<Show when={item.ordered && on}>
										<button
											type="button"
											class="settings-chip-move"
											aria-label="Move up"
											onClick={(e) => {
												e.stopPropagation();
												moveOption(opt.value, -1);
											}}
										>
											<ChevronUpIcon />
										</button>
										<button
											type="button"
											class="settings-chip-move"
											aria-label="Move down"
											onClick={(e) => {
												e.stopPropagation();
												moveOption(opt.value, 1);
											}}
										>
											<ChevronDownIcon />
										</button>
									</Show>
								</span>
							);
						}}
					</For>
				</div>
			);
			break;
		case "providerLimits":
			control = (
				<button
					type="button"
					class="settings-control-btn"
					onClick={() => {
						seedLimitDrafts();
						setLimitsOpen((v) => !v);
					}}
				>
					{limitsOpen() ? "hide limits" : "set limits"}
				</button>
			);
			break;
		case "record":
		case "list":
			control = (
				<div class="settings-text">
					<Show
						when={jsonEditing()}
						fallback={
							<button
								type="button"
								class="settings-control-btn"
								onClick={() => {
									setJsonDraft(
										JSON.stringify(item.value ?? (item.type === "list" ? [] : {}), null, 2),
									);
									draftRevision = state.settingsModel?.revision;
									setJsonError("");
									setJsonEditing(true);
								}}
							>
								Edit {item.type}
							</button>
						}
					>
						<textarea
							aria-label={`${item.label} JSON`}
							value={jsonDraft()}
							onInput={(e) => setJsonDraft(e.currentTarget.value)}
						/>
						<button type="button" class="settings-control-btn" onClick={commitJson}>
							Save
						</button>
						<button
							type="button"
							class="settings-control-btn"
							onClick={() => setJsonEditing(false)}
						>
							Cancel
						</button>
						<Show when={jsonError()}>
							<div role="alert" class="settings-item-desc">
								{jsonError()}
							</div>
						</Show>
					</Show>
				</div>
			);
			break;
		default:
			control = <span class="settings-item-desc">{formatItemValue(item)}</span>;
	}

	return (
		<>
			<Row label={item.label} description={item.description} changed={item.changed}>
				{control}
				<Show when={item.view}>
					<select
						aria-label={`${item.label} write layer`}
						value={layer()}
						onChange={(e) => setLayer(e.currentTarget.value)}
					>
						<option value="global">Global config</option>
						<option value="project">Project config</option>
					</select>
					<button
						type="button"
						class="settings-control-btn"
						disabled={!item.view?.canUnset}
						title={
							item.view?.canUnset
								? "Remove the explicit override; inherit the next layer"
								: "No removable explicit override"
						}
						onClick={() =>
							unsetSetting(item.path, state.settingsModel?.revision, item.view?.explicit?.layer)
						}
					>
						Unset override
					</button>
				</Show>
			</Row>
			<Show when={item.view}>
				{(view) => (
					<div class="settings-item-desc">
						<div>
							Effective: {formatSettingValue(view().effective, item.secret)} · Source:{" "}
							{view().source}
						</div>
						<div>
							Explicit:{" "}
							{view().explicit
								? `${formatSettingValue(view().explicit!.value, item.secret)} (${view().explicit!.layer})`
								: "Inherited (no explicit override)"}
						</div>
						<div>
							{settingEffectLabel(view().effect)} ·{" "}
							{view().canUnset ? "Override can be unset" : "Override cannot be unset"}
						</div>
						<For each={view().warnings}>{(warning) => <div role="status">{warning}</div>}</For>
					</div>
				)}
			</Show>
			<Show when={item.type === "providerLimits" && limitsOpen()}>
				<div class="settings-limit-inputs">
					<For each={item.providers ?? []}>
						{(provider) => (
							<label class="settings-limit-field">
								{provider}
								<input
									type="number"
									min={0}
									value={limitDrafts()[provider] ?? ""}
									onInput={(e) => commitLimit(provider, e.currentTarget.value)}
								/>
							</label>
						)}
					</For>
					<button type="button" class="settings-control-btn" onClick={resetLimits}>
						reset
					</button>
				</div>
			</Show>
		</>
	);
}
