import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ModelBrowserEntry } from "#lib/wire/protocol";
import { ModelPicker } from "../../../web/components/models/ModelPicker";
import { ThinkingLevelPicker } from "../../../web/components/models/ThinkingLevelPicker";
import { setState } from "../../../web/state";
import { seedRecentModels } from "../../../web/store/models";
import { modelInfos, sessionModel } from "../../fixtures/overlays";
import { answerCalls } from "../../daemon";
import { defineStory } from "../../registry";

/** Browser rows: every fixture model usable, except row 3 locked to show the disabled state. */
const browserEntries: ModelBrowserEntry[] = modelInfos.map((model, index) =>
	index === 3 ? { ...model, locked: "credentials" } : model,
);
const recentSelectors = modelInfos.slice(1, 3).map((model) => `${model.provider}/${model.id}`);
const thinkingLadder = ["off", "minimal", "low", "medium", "high", "xhigh"];

export default [
	defineStory({
		id: "models-model-picker",
		title: "ModelPicker",
		component: [
			{ file: "apps/web/components/models/ModelPicker.tsx", export: "ModelPicker" },
			{ file: "apps/web/components/models/ModelSearchList.tsx", export: "ModelSearchList" },
		],
		tabs: true,
		seed: {
			currentSessionId: "sess_09a41c",
			model: sessionModel,
		},
		variants: [
			{
				name: "Browser loaded",
				description: "Recent rows first, one locked row, current model marked.",
				seed: () => {
					answerCalls({ getModelBrowser: () => browserEntries });
					seedRecentModels(recentSelectors);
				},
				render: (ctx) => <ModelPicker onClose={ctx.close} />,
			},
			{
				name: "Task model mode",
				description: "Opened from the Task toggle: picking a row sets the Task subagent model.",
				seed: () => {
					answerCalls({ getModelBrowser: () => browserEntries });
					seedRecentModels(recentSelectors);
					setState("modelPickerTask", true);
					setState("taskModel", "anthropic/claude-haiku-5-5");
				},
				render: (ctx) => <ModelPicker onClose={ctx.close} />,
			},
			{
				name: "Catalog loading",
				seed: () => {
					answerCalls({ getModelBrowser: () => Promise.withResolvers<unknown>().promise });
				},
				render: (ctx) => <ModelPicker onClose={ctx.close} />,
			},
		],
	}),
	defineStory({
		id: "models-thinking-level-picker",
		title: "ThinkingLevelPicker",
		component: {
			file: "apps/web/components/models/ThinkingLevelPicker.tsx",
			export: "ThinkingLevelPicker",
		},
		tabs: true,
		variants: [
			{
				name: "Medium selected",
				seed: {
					currentSessionId: "sess_09a41c",
					model: sessionModel,
					thinkingSelectors: thinkingLadder,
					thinkingLevel: "medium" as ThinkingLevel,
				},
				render: (ctx) => <ThinkingLevelPicker onClose={ctx.close} />,
			},
			{
				name: "High selected",
				seed: {
					currentSessionId: "sess_09a41c",
					model: sessionModel,
					thinkingSelectors: thinkingLadder,
					thinkingLevel: "high" as ThinkingLevel,
				},
				render: (ctx) => <ThinkingLevelPicker onClose={ctx.close} />,
			},
			{
				name: "Auto thinking",
				seed: {
					currentSessionId: "sess_09a41c",
					model: sessionModel,
					thinkingSelectors: thinkingLadder,
					autoThinking: true,
				},
				render: (ctx) => <ThinkingLevelPicker onClose={ctx.close} />,
			},
			{
				name: "No thinking dial",
				seed: {
					currentSessionId: "sess_09a41c",
					model: sessionModel,
					thinkingSelectors: [],
				},
				render: (ctx) => <ThinkingLevelPicker onClose={ctx.close} />,
			},
		],
	}),
];
