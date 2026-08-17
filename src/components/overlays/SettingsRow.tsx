import { createSignal, For, Show, type JSX } from "solid-js";
import { displayOptionValue, formatItemValue } from "../../settings";
import { updateSetting } from "../../state";
import { ChevronDownIcon, ChevronUpIcon } from "../shared/icons";
import type { SettingsItem } from "../../../shared/protocol";

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

	const commitText = () => {
		if (!dirty()) return;
		updateSetting(item.path, draft());
		setDraft("");
		setDirty(false);
	};

	const seedLimitDrafts = () => {
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
		// Empty input = unlimited: only finite positive numbers make it through.
		const out: Record<string, number> = {};
		for (const p of item.providers ?? []) {
			const text = next[p];
			if (text === undefined || text === "") continue;
			const n = Number(text);
			if (Number.isFinite(n) && n > 0) out[p] = n;
		}
		updateSetting(item.path, out);
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
		default:
			control = <span class="settings-item-desc">{formatItemValue(item)}</span>;
	}

	return (
		<>
			<Row label={item.label} description={item.description} changed={item.changed}>
				{control}
			</Row>
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
