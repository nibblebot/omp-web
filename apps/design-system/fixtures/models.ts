import type { ModelBrowserEntry, ModelPresetDetail } from "#lib/wire/protocol";
import { setState, type ModelDialogTab } from "../../web/state";
import { openModelDialog, seedRecentModels } from "../../web/store/models";
import { answerCalls } from "../session";
import { modelInfos, modelRoleCatalog } from "./overlays";

/** Browser rows: every fixture model with its thinking efforts, row 3 locked to show the disabled state. */
export const browserEntries: ModelBrowserEntry[] = modelInfos.map((model, index) => ({
	provider: model.provider,
	id: model.id,
	kind: model.kind,
	contextWindow: model.contextWindow,
	reasoning: model.reasoning,
	thinkingEfforts: model.thinking ? [...model.thinking.efforts] : undefined,
	...(index === 3 ? { locked: "credentials" as const } : {}),
}));
const recentSelectors = modelInfos.slice(1, 3).map((model) => `${model.provider}/${model.id}`);

/** Matches the fixture role catalog exactly, so it reads as the active preset. */
export const heavy: ModelPresetDetail = {
	name: "heavy",
	source: "global",
	modelRoles: {
		default: "anthropic/claude-opus-4-1:high",
		smol: "anthropic/claude-haiku-5-5",
		plan: "openai/gpt-5.2:medium",
	},
	defaultThinkingLevel: "high",
};
/** Differs from the live roles in the default and plan roles and adds slow, which is unassigned now. */
export const fast: ModelPresetDetail = {
	name: "fast",
	source: "global",
	modelRoles: {
		default: "anthropic/claude-sonnet-4",
		smol: "anthropic/claude-haiku-5-5",
		plan: "openai/gpt-5.2:low",
		slow: "google/gemini-3-pro:high",
	},
	defaultThinkingLevel: "low",
};
export const shared: ModelPresetDetail = {
	name: "shared",
	source: "project",
	modelRoles: {
		default: "anthropic/claude-sonnet-4",
		smol: "anthropic/claude-haiku-5-5",
	},
};
export const ciFlag: ModelPresetDetail = {
	name: "ci-flag",
	source: "overlay",
	modelRoles: { default: "openai/gpt-5.2:minimal" },
};
export const broken: ModelPresetDetail = {
	name: "broken",
	source: "global",
	modelRoles: {},
	invalid: 'modelRoles.default: expected "provider/model", got 42',
};

export interface DialogSeed {
	tab: ModelDialogTab;
	role?: string;
	presets?: ModelPresetDetail[];
	active?: string;
}

/** Real store actions: the dialog opens through `openModelDialog`, which loads the fake session's answers. */
export function seedDialog({ tab, role, presets = [], active }: DialogSeed): () => void {
	return () => {
		const names = presets.map((preset) => preset.name).sort();
		answerCalls({
			getModelBrowser: () => browserEntries,
			getModelPresets: () => ({ names, active, presets }),
			applyModelPreset: (args) => ({ applied: args[0], warnings: [] }),
			saveModelPreset: (args) => ({ message: `Saved preset "${args[0]}".` }),
			deleteModelPreset: () => ({ result: "deleted" }),
		});
		setState({
			modelRoleCatalog,
			modelRoleStorage: "global",
			thinkingSelectors: ["off", "low", "medium", "high", "xhigh"],
			modelPresets: names.length > 0 ? { names, active } : undefined,
		});
		seedRecentModels(recentSelectors);
		openModelDialog(tab, role);
	};
}
