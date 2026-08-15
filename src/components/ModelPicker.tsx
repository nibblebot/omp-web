import { createEffect, createSignal, For, onMount, Show, type Component } from "solid-js";
import type { ModelInfo, ModelRoleCatalogEntry } from "../../shared/protocol";
import { fuzzyRank } from "../autocomplete";
import { call, setState, state } from "../state";
import { Modal } from "./Modal";
import { PickerRow, useClickableRow } from "./PickerRow";

/** One row of the step-3 thinking picker. */
export interface ThinkingOption {
	/** Wire value passed to setModelRole's thinkingLevel arg ("" = omit entirely). */
	value: string;
	label: string;
	/** TUI metadata description, rendered dim beside the label. */
	hint?: string;
}

/**
 * TUI label parity (THINKING_LEVEL_METADATA in the SDK's src/thinking.ts):
 * minimal renders as "min"; every other level is its own wire value.
 */
export function thinkingLevelLabel(level: string): string {
	return level === "minimal" ? "min" : level;
}

/** TUI descriptions for the two non-effort selectors (src/thinking.ts metadata). */
const THINKING_HINTS: Record<string, string> = {
	inherit: "Inherit session default",
	off: "No reasoning",
};

/**
 * Thinking options for a model that exposes a controllable effort surface:
 * "inherit" (defer to the session thinking level) and "off" first, then the
 * model's own efforts in catalog order — all with TUI labels. Empty for
 * models without a surface — callers then skip step 3 and assign without a level.
 */
export function thinkingOptions(efforts: readonly string[] | undefined): ThinkingOption[] {
	if (!efforts || efforts.length === 0) return [];
	return [
		{ value: "inherit", label: "inherit", hint: THINKING_HINTS.inherit },
		{ value: "off", label: "off", hint: THINKING_HINTS.off },
		...efforts.map(e => ({ value: e, label: thinkingLevelLabel(e) })),
	];
}

type Step = "roles" | "model" | "thinking";

/** Compact context-window label for model rows, e.g. "ctx 128k" / "ctx 1.2M". */
function formatCtx(tokens: number | null | undefined): string | undefined {
	if (!tokens || tokens <= 0) return undefined;
	if (tokens >= 1_000_000) return `ctx ${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	return `ctx ${Math.round(tokens / 1000)}k`;
}

/**
 * Model-role picker: three-step wizard (roles → model → thinking). Fetching a
 * role's model opens the same fuzzy-filtered, provider-grouped list as the
 * old picker; picking a reasoning model then asks for a thinking level that
 * gets baked into the role value. Edits persist per `modelRoleStorage`
 * (global config vs project .omp/config.yml) and apply live when they touch
 * the session's active role.
 */
export const ModelPicker: Component<{ onClose: () => void }> = props => {
	const [step, setStep] = createSignal<Step>("roles");
	const [role, setRole] = createSignal<ModelRoleCatalogEntry | undefined>(undefined);
	const [model, setModel] = createSignal<ModelInfo | undefined>(undefined);
	const [showHidden, setShowHidden] = createSignal(false);
	const [filter, setFilter] = createSignal("");
	let input!: HTMLInputElement;

	onMount(() => {
		void call("getAvailableModels")
			.then(models => setState("availableModels", models as ModelInfo[]))
			.catch(err => setState("error", String(err)));
	});

	// The step-2 filter mounts when the model step opens; focus it after the
	// step change flushes so typing filters immediately.
	createEffect(() => {
		if (step() === "model") input?.focus();
	});

	/** Is this catalog entry the role's currently assigned model? */
	const isActiveRole = (entry: ModelRoleCatalogEntry) =>
		entry.provider !== undefined &&
		entry.id !== undefined &&
		state.model?.provider === entry.provider &&
		state.model?.id === entry.id;
	const roles = () => state.modelRoleCatalog?.filter(e => !e.hidden) ?? [];
	const hiddenRoles = () => state.modelRoleCatalog?.filter(e => e.hidden) ?? [];

	/** Open the model step for this role (two statements: remember + advance). */
	const pickRole = (entry: ModelRoleCatalogEntry) => {
		setRole(entry);
		setStep("model");
	};

	/** Assign the picked model to the picked role; closes the wizard. */
	const commit = (m: ModelInfo, level: string | undefined) => {
		const r = role()!;
		// "inherit" (and no level) means no explicit thinking baked into the
		// role value; the wire arg is omitted entirely for it.
		const args: unknown[] = level === undefined || level === "inherit" ? [r.role, m.provider, m.id] : [r.role, m.provider, m.id, level];
		void call("setModelRole", args).catch(err => setState("error", String(err)));
		props.onClose();
	};

	const pickModel = (m: ModelInfo) => {
		if (m.thinking?.efforts?.length) {
			setModel(m);
			setStep("thinking");
		} else {
			// No controllable thinking surface: assign without a level.
			commit(m, undefined);
		}
	};

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

	const title = () => {
		if (step() === "roles") return "Model roles";
		if (step() === "model") return `Model roles — ${role()?.tag ?? role()?.name ?? ""}`;
		return `Thinking — ${role()?.tag ?? role()?.name ?? ""}`;
	};

	return (
		<Modal title={title()} onClose={props.onClose}>
			<Show when={step() === "roles"}>
				<div class="picker-list">
					<For each={roles()}>
						{entry => (
							<div
								class="picker-row"
								classList={{ active: isActiveRole(entry) }}
								aria-pressed={isActiveRole(entry)}
								{...useClickableRow(() => pickRole(entry))}
								title={`${entry.tag ?? entry.name} — pick a model`}
							>
								<span class="picker-label">{entry.tag ?? entry.name}</span>
								{entry.provider && entry.id ? (
									<span class="picker-meta">
										{entry.provider}/{entry.id}
									</span>
								) : (
									<span class="picker-detail">auto</span>
								)}
								{entry.thinkingLevel && <span class="picker-chip">{thinkingLevelLabel(entry.thinkingLevel)}</span>}
								{entry.provider && entry.id && (
									<button
										class="picker-row-action"
										title={`Clear ${entry.tag ?? entry.name} (back to auto)`}
										onClick={e => {
											e.stopPropagation();
											void call("clearModelRole", [entry.role]).catch(err => setState("error", String(err)));
										}}
									>
										clear
									</button>
								)}
								<button
									class="picker-row-action"
									title={`Hide ${entry.tag ?? entry.name}`}
									onClick={e => {
										e.stopPropagation();
										void call("setModelRoleHidden", [entry.role, true]).catch(err => setState("error", String(err)));
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
						<button class="picker-hidden-toggle" onClick={() => setShowHidden(v => !v)}>
							{showHidden() ? "▾" : "▸"} hidden roles ({hiddenRoles().length})
						</button>
					</div>
					<Show when={showHidden()}>
						<div class="picker-list">
							<For each={hiddenRoles()}>
								{entry => (
									<div class="picker-row">
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
											onClick={() => void call("setModelRoleHidden", [entry.role, false]).catch(err => setState("error", String(err)))}
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
					{state.modelRoleStorage === "project" ? "saves to project .omp/config.yml" : "saves to global config.yml"}
				</div>
			</Show>
			<Show when={step() === "model"}>
				<div class="picker-group-head">
					<button class="picker-back" onClick={() => setStep("roles")}>
						← roles
					</button>
				</div>
				<input
					class="picker-filter"
					ref={input}
					aria-label="Filter models"
					placeholder="Filter models…"
					value={filter()}
					onInput={e => setFilter(e.currentTarget.value)}
					onKeyDown={e => {
						if (e.key === "Enter") {
							const first = groups()[0]?.[1][0];
							if (first) pickModel(first);
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
											classList={{ active: role()?.provider === m.provider && role()?.id === m.id }}
											aria-pressed={role()?.provider === m.provider && role()?.id === m.id}
											onClick={() => pickModel(m)}
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
			</Show>
			<Show when={step() === "thinking"}>
				<div class="picker-group-head">
					<button class="picker-back" onClick={() => setStep("model")}>
						← model
					</button>
				</div>
				<div class="picker-list">
					<For each={thinkingOptions(model()?.thinking?.efforts as readonly string[] | undefined)}>
						{opt => (
							<PickerRow
								class="picker-row"
								classList={{ active: (role()?.thinkingLevel ?? "inherit") === opt.value }}
								aria-pressed={(role()?.thinkingLevel ?? "inherit") === opt.value}
								onClick={() => commit(model()!, opt.value)}
							>
								<span class="picker-label">{opt.label}</span>
								{opt.hint && <span class="picker-meta">{opt.hint}</span>}
							</PickerRow>
						)}
					</For>
				</div>
			</Show>
		</Modal>
	);
};
