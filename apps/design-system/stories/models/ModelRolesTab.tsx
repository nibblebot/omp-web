import type { ModelRoleCatalogEntry } from "#lib/wire/protocol";
import type { JSX } from "solid-js";
import { setState } from "../../../web/state";
import { ModelRolesTab } from "../../../web/components/models/ModelRolesTab";
import { seedDialog } from "../../fixtures/models";
import { defineStory } from "../../registry";

/** The tab fills the dialog's panel: a frame stands in for the Modal's fixed height and surface. */
const Host = (props: { children: JSX.Element }) => (
	<div class="ds-frame ds-frame-column ds-frame-panel">
		<div class="model-dialog-panel">{props.children}</div>
	</div>
);

/** Extra roles beyond the fixture catalog, including a custom untagged role and a very long model id. */
const manyRoles: ModelRoleCatalogEntry[] = [
	{
		role: "web",
		name: "Web search",
		tag: "WEB",
		hidden: false,
		provider: "openai",
		id: "gpt-5.2-mini",
		value: "openai/gpt-5.2-mini",
		source: "global",
	},
	{
		role: "widgets",
		name: "Job widgets",
		tag: "WIDGET",
		hidden: false,
		provider: "anthropic",
		id: "claude-haiku-5-5",
		value: "anthropic/claude-haiku-5-5",
		source: "global",
	},
	{
		role: "tiny",
		name: "Tiny",
		tag: "TINY",
		hidden: false,
		provider: "openrouter",
		id: "meta-llama/llama-3.3-70b-instruct:free-with-a-very-long-suffix",
		value: "openrouter/meta-llama/llama-3.3-70b-instruct:free-with-a-very-long-suffix",
		source: "global",
	},
	{
		role: "docs-writer",
		name: "Documentation writer",
		hidden: false,
		provider: "google",
		id: "gemini-3-pro",
		value: "google/gemini-3-pro",
		source: "global",
	},
	{ role: "review", name: "Review", tag: "REVIEW", hidden: false, source: "default" },
	{
		role: "search",
		name: "Search",
		tag: "SEARCH",
		hidden: false,
		provider: "anthropic",
		id: "claude-sonnet-5-5",
		value: "anthropic/claude-sonnet-5-5",
		source: "global",
	},
];

const render = () => (
	<Host>
		<ModelRolesTab pane="list" onPane={() => undefined} />
	</Host>
);

export default defineStory({
	id: "models-model-roles-tab",
	title: "ModelRolesTab",
	component: { file: "apps/web/components/models/ModelRolesTab.tsx", export: "ModelRolesTab" },
	seed: { currentWorkspaceId: "sess_09a41c" },
	variants: [
		{
			name: "Default role",
			description: "The role model's own thinking levels, Unassign and Hide beside the model list.",
			seed: seedDialog({ tab: "roles" }),
			render,
		},
		{
			name: "Hidden role",
			description: "A hidden, unassigned role: Show instead of Hide, Unassign disabled.",
			seed: seedDialog({ tab: "roles", role: "vision" }),
			render,
		},
		{
			name: "Many roles",
			description:
				"Compact one-line rows, TAG then model: a long model id ellipsizes, a custom role without a tag shows its name, hidden roles go last.",
			seed: () => {
				seedDialog({ tab: "roles" })();
				setState("modelRoleCatalog", (catalog) => [...(catalog ?? []), ...manyRoles]);
			},
			render,
		},
	],
});
