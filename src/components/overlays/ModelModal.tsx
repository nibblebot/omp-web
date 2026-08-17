import { createMemo, createSignal, onMount, Show, type Component } from "solid-js";
import type { ModelInfo, ModelRoleCatalogEntry } from "../../../shared/protocol";
import { fuzzyRank } from "../../autocomplete";
import { call, setState, state } from "../../state";
import { Modal } from "../shared/Modal";
import { ModelsStep } from "./ModelsStep";
import { RolesStep } from "./RolesStep";
import { ThinkingStep } from "./ThinkingStep";

type Step = "roles" | "model" | "thinking";

/**
 * Model-role picker: three-step wizard (roles → model → thinking). Fetching a
 * role's model opens the same fuzzy-filtered, provider-grouped list as the
 * old picker; picking a reasoning model then asks for a thinking level that
 * gets baked into the role value. Edits persist per `modelRoleStorage`
 * (global config vs project .omp/config.yml) and apply live when they touch
 * the session's active role. Per-step rendering lives in RolesStep /
 * ModelsStep / ThinkingStep; this file owns the step machine, the shared
 * wizard-lifetime UI state (filter, hidden-toggle), and navigation.
 */
export const ModelModal: Component<{ onClose: () => void }> = (props) => {
	const [step, setStep] = createSignal<Step>("roles");
	const [role, setRole] = createSignal<ModelRoleCatalogEntry | undefined>(undefined);
	const [model, setModel] = createSignal<ModelInfo | undefined>(undefined);
	const [showHidden, setShowHidden] = createSignal(false);
	const [filter, setFilter] = createSignal("");

	onMount(() => {
		void call("getAvailableModels")
			.then((models) => setState("availableModels", models as ModelInfo[]))
			.catch((err) => setState("error", String(err)));
	});

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
		if (step() === "roles") return "Model roles";
		if (step() === "model") return `Model roles — ${role()?.tag ?? role()?.name ?? ""}`;
		return `Thinking — ${role()?.tag ?? role()?.name ?? ""}`;
	};

	return (
		<Modal title={title()} onClose={props.onClose}>
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
		</Modal>
	);
};
