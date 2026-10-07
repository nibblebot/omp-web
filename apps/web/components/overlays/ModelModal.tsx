import { createMemo, createSignal, For, onMount, Show, type Component } from "solid-js";
import type { ModelInfo, ModelRoleCatalogEntry } from "#lib/wire/protocol";
import { fuzzyRank } from "../../prompt/autocomplete";
import { call, pushNotice, setState, state } from "../../state";
import {
	cycleModel,
	expandMentionChips,
	expandTagsForEdit,
	getModelMentions,
	invalidateMentions,
	modelRoute,
	runModelRoute,
} from "../../store/models";
import { graphGeneration, noteTranscriptReplaced } from "../../store/graph";
import { Modal } from "../shared/Modal";
import { ModelsStep } from "./ModelsStep";
import { RolesStep } from "./RolesStep";
import { ThinkingStep } from "./ThinkingStep";

type Step = "roles" | "model" | "thinking" | "temp" | "presets" | "chips";

/**
 * Model picker: the persisted role wizard (roles → model → thinking) plus
 * three P2 additions that NEVER touch persisted roles:
 * - temp: argument-aware temporary switch (session-only, journal role
 *   `temporary`) + cycleModel forward/back.
 * - presets: list/save/apply/delete with entitlement/effort feedback.
 * - chips: branch-local model-worker pseudonyms (`^selector` → `m<N>`),
 *   persisted/restored across resume/rewind via the journal mirror.
 * Bare `/model` still opens this wizard at the roles step (P0 route).
 */
export const ModelModal: Component<{ onClose: () => void }> = (props) => {
	const [step, setStep] = createSignal<Step>("roles");
	const [role, setRole] = createSignal<ModelRoleCatalogEntry | undefined>(undefined);
	const [model, setModel] = createSignal<ModelInfo | undefined>(undefined);
	const [showHidden, setShowHidden] = createSignal(false);
	const [filter, setFilter] = createSignal("");
	const [tempSelector, setTempSelector] = createSignal("");
	const [tempThinking, setTempThinking] = createSignal("");
	const [presetName, setPresetName] = createSignal("");
	const [presetMsg, setPresetMsg] = createSignal<string | null>(null);
	const [chips, setChips] = createSignal<Array<{ agent: string; selector: string; name: string }>>(
		[],
	);
	const [chipError, setChipError] = createSignal<string | null>(null);

	onMount(() => {
		void call("getAvailableModels")
			.then((models) => setState("availableModels", models as ModelInfo[]))
			.catch((err) => setState("error", String(err)));
		void refreshChips();
	});

	const refreshChips = (): void => {
		void getModelMentions(graphGeneration()).then(
			(m) => {
				setChips(m);
				setChipError(null);
			},
			(err: unknown) => setChipError(String(err instanceof Error ? err.message : err)),
		);
	};

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
		const args: unknown[] =
			level === undefined || level === "inherit"
				? [r.role, m.provider, m.id]
				: [r.role, m.provider, m.id, level];
		void call("setModelRole", args).catch((err) => setState("error", String(err)));
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

	// Fuzzy-filtered provider groups; memoized so typing only recomputes the
	// grouping when the filter or the model catalog actually changes.
	const groups = createMemo(() => {
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
	});

	const title = () => {
		const s = step();
		if (s === "roles") return "Model roles";
		if (s === "model") return `Model roles, ${role()?.tag ?? role()?.name ?? ""}`;
		if (s === "thinking") return `Thinking, ${role()?.tag ?? role()?.name ?? ""}`;
		if (s === "temp") return "Temporary model (this session only)";
		if (s === "presets") return "Model presets";
		return "Model-worker chips (this branch)";
	};

	const runTemp = (): void => {
		const raw = tempSelector().trim();
		if (!raw) return;
		const thinking = tempThinking().trim();
		void runModelRoute(modelRoute(raw + (thinking ? `:${thinking}` : ""))).then(() =>
			props.onClose(),
		);
	};

	const runPreset = (action: "list" | "save" | "apply" | "delete"): void => {
		const name = presetName().trim();
		void runModelRoute(
			action === "list" ? { kind: "preset", action: "list" } : { kind: "preset", action, name },
		)
			.then(() => {
				setPresetMsg(
					action === "list"
						? "Preset list sent to notices."
						: action === "save"
							? `Saved preset "${name}".`
							: action === "apply"
								? `Applied preset "${name}".`
								: `Deleted preset "${name}".`,
				);
			})
			.catch((err) => setPresetMsg(String(err instanceof Error ? err.message : err)));
	};

	return (
		<Modal title={title()} onClose={props.onClose}>
			<div class="graph-filters" role="group" aria-label="Model modal section">
				<For
					each={
						[
							{ v: "roles", label: "roles" },
							{ v: "temp", label: "temp" },
							{ v: "presets", label: "presets" },
							{ v: "chips", label: "chips" },
						] as const
					}
				>
					{(t) => (
						<button
							type="button"
							class="graph-filter"
							aria-pressed={
								step() === t.v || (t.v === "roles" && (step() === "model" || step() === "thinking"))
							}
							onClick={() => setStep(t.v)}
						>
							{t.label}
						</button>
					)}
				</For>
			</div>
			<Show when={step() === "roles"}>
				<RolesStep
					showHidden={showHidden()}
					onToggleHidden={() => setShowHidden((v) => !v)}
					onPickRole={pickRole}
				/>
			</Show>
			<Show when={step() === "model"}>
				<ModelsStep
					role={role()}
					filter={filter()}
					onFilterChange={setFilter}
					groups={groups()}
					onBack={() => setStep("roles")}
					onPickModel={pickModel}
				/>
			</Show>
			<Show when={step() === "thinking"}>
				<ThinkingStep
					role={role()}
					model={model()}
					onBack={() => setStep("model")}
					onSelect={(value) => commit(model()!, value)}
				/>
			</Show>
			<Show when={step() === "temp"}>
				<div class="picker-group-name">Session-only switch — persisted roles unchanged</div>
				<div class="picker-note">
					Current: {state.model ? `${state.model.provider}/${state.model.id}` : "(none)"} — resolves
					via live discovery like `/model [selector]`; never writes settings (journal temporary).
				</div>
				<input
					class="picker-filter"
					aria-label="Temporary model selector"
					placeholder="provider/model[:thinking]…"
					value={tempSelector()}
					onInput={(e) => setTempSelector(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") runTemp();
					}}
				/>
				<input
					class="picker-filter"
					aria-label="Thinking level (optional)"
					placeholder="thinking level (optional)…"
					value={tempThinking()}
					onInput={(e) => setTempThinking(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") runTemp();
					}}
				/>
				<div class="graph-actions">
					<button type="button" class="send" disabled={!tempSelector().trim()} onClick={runTemp}>
						Switch for this session
					</button>
					<button
						type="button"
						title="Next model (session-only, roles unchanged)"
						onClick={() => {
							void cycleModel(false).catch((err) => pushNotice("error", String(err)));
						}}
					>
						Cycle →
					</button>
					<button
						type="button"
						title="Previous model (session-only, roles unchanged)"
						onClick={() => {
							void cycleModel(true).catch((err) => pushNotice("error", String(err)));
						}}
					>
						← Cycle
					</button>
				</div>
			</Show>
			<Show when={step() === "presets"}>
				<div class="picker-group-name">
					Named role snapshots (persisted storage, applied wholesale)
				</div>
				<input
					class="picker-filter"
					aria-label="Preset name"
					placeholder="Preset name…"
					value={presetName()}
					onInput={(e) => setPresetName(e.currentTarget.value)}
				/>
				<div class="graph-actions">
					<button type="button" onClick={() => runPreset("list")}>
						List
					</button>
					<button type="button" disabled={!presetName().trim()} onClick={() => runPreset("save")}>
						Save
					</button>
					<button type="button" disabled={!presetName().trim()} onClick={() => runPreset("apply")}>
						Apply
					</button>
					<button type="button" disabled={!presetName().trim()} onClick={() => runPreset("delete")}>
						Delete
					</button>
				</div>
				<Show when={presetMsg()}>{(m) => <div class="picker-note">{m()}</div>}</Show>
			</Show>
			<Show when={step() === "chips"}>
				<div class="picker-group-name">
					Branch-local delegation targets — a chip is the requested target, not proof a worker
					launched
				</div>
				<Show when={chipError()}>{(e) => <div class="msg-notice">{e()}</div>}</Show>
				<Show when={chips().length === 0 && !chipError()}>
					<div class="picker-note">
						No chips on this branch yet. Type ^provider/model in the composer to tag one.
					</div>
				</Show>
				<div class="picker-list">
					<For each={chips()}>
						{(c) => (
							<div class="picker-row">
								<span class="picker-chip">{c.agent}</span>
								<span class="picker-label">^{c.selector}</span>
								<span class="picker-detail">{c.name}</span>
							</div>
						)}
					</For>
				</div>
				<div class="graph-actions">
					<button
						type="button"
						title="Re-read branch journal (resume/rewind restore)"
						onClick={() => {
							invalidateMentions();
							noteTranscriptReplaced();
							void refreshChips();
						}}
					>
						Refresh from branch
					</button>
					<button
						type="button"
						title="Preview current composer chips against this mapping"
						onClick={() => {
							void expandMentionChips("^").then(() => refreshChips());
						}}
					>
						Validate
					</button>
				</div>
				<div class="picker-note">
					Chips persist in the branch journal and restore on resume/rewind; edit text with ^selector
					form (tags expand back via the same mapping).
				</div>
				<Show when={false}>
					<span>{expandTagsForEdit("", [])}</span>
				</Show>
			</Show>
		</Modal>
	);
};
