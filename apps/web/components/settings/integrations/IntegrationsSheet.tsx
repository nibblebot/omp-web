import { For, Show, type Component } from "solid-js";
import type { IntegrationTab } from "../../../store/slices/integrations";
import {
	integrationsTab,
	reloadIntegrations,
	selectIntegrationsTab,
} from "../../../store/integrations";
import { Modal } from "../../ui/Modal";
import { McpTab } from "./McpTab";
import { PluginsTab } from "./PluginsTab";
import { SkillsTab } from "./SkillsTab";
import "./integrations.css";

const TABS: Array<{ id: IntegrationTab; label: string }> = [
	{ id: "mcp", label: "MCP servers" },
	{ id: "skills", label: "Skills" },
	{ id: "plugins", label: "Plugins" },
];

/** One sheet for MCP servers, skills, and plugins. */
export const IntegrationsSheet: Component<{ onClose: () => void }> = (props) => (
	<Modal title="Integrations" class="integrations-sheet" onClose={props.onClose}>
		<div class="integrations-head">
			<div class="integrations-tabs" role="tablist" aria-label="Integrations">
				<For each={TABS}>
					{(tab) => (
						<button
							type="button"
							role="tab"
							id={`integrations-tab-${tab.id}`}
							aria-selected={integrationsTab() === tab.id}
							aria-controls="integrations-panel"
							class="integrations-tab-button"
							classList={{ "integrations-tab-button-active": integrationsTab() === tab.id }}
							onClick={() => selectIntegrationsTab(tab.id)}
						>
							{tab.label}
						</button>
					)}
				</For>
			</div>
			<button
				type="button"
				class="settings-control-btn"
				title="Rediscover skills and commands and reconnect MCP servers. No confirmation needed."
				onClick={reloadIntegrations}
			>
				Reload integrations
			</button>
		</div>
		<div
			role="tabpanel"
			id="integrations-panel"
			aria-labelledby={`integrations-tab-${integrationsTab()}`}
		>
			<Show when={integrationsTab() === "mcp"}>
				<McpTab />
			</Show>
			<Show when={integrationsTab() === "skills"}>
				<SkillsTab />
			</Show>
			<Show when={integrationsTab() === "plugins"}>
				<PluginsTab />
			</Show>
		</div>
	</Modal>
);
