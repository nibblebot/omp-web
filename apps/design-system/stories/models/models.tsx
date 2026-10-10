import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ModelInfo, ModelRoleCatalogEntry } from "#lib/wire/protocol";
import { ModelPicker } from "../../../web/components/models/ModelPicker";
import { ModelStep } from "../../../web/components/models/ModelStep";
import { RoleStep } from "../../../web/components/models/RoleStep";
import { ThinkingLevelPicker } from "../../../web/components/models/ThinkingLevelPicker";
import { ThinkingStep } from "../../../web/components/models/ThinkingStep";
import { modelInfos, modelRoleCatalog, sessionModel } from "../../fixtures/overlays";
import { answerCalls } from "../../daemon";
import { defineStory } from "../../registry";

/** Group models by provider, the shape ModelStep receives from ModelPicker. */
function groupByProvider(models: ModelInfo[]): Array<[string, ModelInfo[]]> {
	const groups = new Map<string, ModelInfo[]>();
	for (const model of models) {
		const bucket = groups.get(model.provider) ?? [];
		bucket.push(model);
		groups.set(model.provider, bucket);
	}
	return [...groups.entries()];
}

const defaultRole: ModelRoleCatalogEntry | undefined = modelRoleCatalog.find(
	(entry) => entry.role === "default",
);
const reasoningModel: ModelInfo | undefined = modelInfos.find((model) => model.reasoning);
const plainModel: ModelInfo | undefined = modelInfos.find((model) => !model.reasoning);
const sonnetFilter = modelInfos.filter((model) => model.id.includes("sonnet"));

export default [
	defineStory({
		id: "models-model-picker",
		title: "ModelPicker",
		component: { file: "apps/web/components/models/ModelPicker.tsx", export: "ModelPicker" },
		tabs: true,
		seed: {
			currentSessionId: "sess_09a41c",
			model: sessionModel,
			modelRoleCatalog,
		},
		variants: [
			{
				name: "Roles and models loaded",
				description: "Role list with the session's current assignments.",
				seed: () =>
					answerCalls({
						getAvailableModels: () => modelInfos,
						getModelMentions: () => ({ mentions: [] }),
					}),
				render: (ctx) => <ModelPicker onClose={ctx.close} />,
			},
			{
				name: "Catalog loading",
				seed: () =>
					answerCalls({
						getAvailableModels: () => Promise.withResolvers<unknown>().promise,
						getModelMentions: () => ({ mentions: [] }),
					}),
				render: (ctx) => <ModelPicker onClose={ctx.close} />,
			},
			{
				name: "Catalog failed",
				seed: () =>
					answerCalls({
						getAvailableModels: () => {
							throw new Error("No provider credentials configured");
						},
						getModelMentions: () => ({ mentions: [] }),
					}),
				render: (ctx) => <ModelPicker onClose={ctx.close} />,
			},
		],
	}),
	defineStory({
		id: "models-model-step",
		title: "ModelStep",
		component: { file: "apps/web/components/models/ModelStep.tsx", export: "ModelStep" },
		seed: { modelRoleCatalog, model: sessionModel },
		variants: [
			{
				name: "All providers",
				render: () => (
					<ModelStep
						role={defaultRole}
						filter=""
						onFilterChange={() => undefined}
						groups={groupByProvider(modelInfos)}
						onBack={() => undefined}
						onPickModel={() => undefined}
					/>
				),
			},
			{
				name: "Filtered to sonnet",
				render: () => (
					<ModelStep
						role={defaultRole}
						filter="sonnet"
						onFilterChange={() => undefined}
						groups={groupByProvider(sonnetFilter)}
						onBack={() => undefined}
						onPickModel={() => undefined}
					/>
				),
			},
			{
				name: "No matches",
				render: () => (
					<ModelStep
						role={defaultRole}
						filter="o3-pro"
						onFilterChange={() => undefined}
						groups={[]}
						onBack={() => undefined}
						onPickModel={() => undefined}
					/>
				),
			},
		],
	}),
	defineStory({
		id: "models-role-step",
		title: "RoleStep",
		component: { file: "apps/web/components/models/RoleStep.tsx", export: "RoleStep" },
		seed: { modelRoleCatalog, model: sessionModel },
		variants: [
			{
				name: "Visible roles",
				render: () => (
					<RoleStep
						showHidden={false}
						onToggleHidden={() => undefined}
						onPickRole={() => undefined}
					/>
				),
			},
			{
				name: "Hidden roles shown",
				render: () => (
					<RoleStep showHidden onToggleHidden={() => undefined} onPickRole={() => undefined} />
				),
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
					thinkingLevel: "medium" as ThinkingLevel,
				},
				render: (ctx) => <ThinkingLevelPicker onClose={ctx.close} />,
			},
			{
				name: "High selected",
				seed: {
					currentSessionId: "sess_09a41c",
					model: sessionModel,
					thinkingLevel: "high" as ThinkingLevel,
				},
				render: (ctx) => <ThinkingLevelPicker onClose={ctx.close} />,
			},
			{
				name: "Inherit from role",
				seed: {
					currentSessionId: "sess_09a41c",
					model: sessionModel,
					thinkingLevel: "inherit",
				},
				render: (ctx) => <ThinkingLevelPicker onClose={ctx.close} />,
			},
		],
	}),
	defineStory({
		id: "models-thinking-step",
		title: "ThinkingStep",
		component: { file: "apps/web/components/models/ThinkingStep.tsx", export: "ThinkingStep" },
		seed: { modelRoleCatalog, model: sessionModel },
		variants: [
			{
				name: "Reasoning model",
				render: () => (
					<ThinkingStep
						role={defaultRole}
						model={reasoningModel}
						onBack={() => undefined}
						onSelect={() => undefined}
					/>
				),
			},
			{
				name: "Model without reasoning",
				render: () => (
					<ThinkingStep
						role={defaultRole}
						model={plainModel}
						onBack={() => undefined}
						onSelect={() => undefined}
					/>
				),
			},
		],
	}),
];
