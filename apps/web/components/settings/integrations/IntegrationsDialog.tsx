import { For, Show, type Component } from "solid-js";
import { featurePluginsTab } from "../../../features/registry";
import type { IntegrationTab } from "../../../store/slices/integrations";
import {
	integrationsTab,
	reloadIntegrations,
	selectIntegrationsTab,
} from "../../../store/integrations";
import { Modal } from "../../ui/Modal";
import { McpTab } from "./McpTab";
import { SkillsTab } from "./SkillsTab";
import "./integrations.css";

/**
 * One dialog for skills, MCP servers, and, while the optional `plugins` feature is on, plugins,
 * each in its own tab. The Plugins body comes from the feature's `pluginsTab` slot, so the
 * plugins chunk is never loaded while the feature is off.
 */
export const IntegrationsDialog: Component<{ onClose: () => void }> = (props) => {
	// The stored tab may be Plugins after the feature was turned off: Skills shows then.
	const activeTab = (): IntegrationTab => {
		const tab = integrationsTab();
		return tab === "plugins" && !featurePluginsTab() ? "skills" : tab;
	};
	const tabs = (): Array<{ id: IntegrationTab; label: string }> => [
		{ id: "skills", label: "Skills" },
		...(featurePluginsTab() ? [{ id: "plugins" as const, label: "Plugins" }] : []),
		{ id: "mcp", label: "MCP" },
	];
	return (
		<Modal title="Extensions" class="integrations-dialog" size="wide" onClose={props.onClose}>
			<div class="integrations-head">
				<div class="integrations-tabs" role="tablist" aria-label="Sections">
					<For each={tabs()}>
						{(tab) => (
							<button
								type="button"
								role="tab"
								id={`integrations-tab-${tab.id}`}
								aria-selected={activeTab() === tab.id}
								aria-controls="integrations-panel"
								class="integrations-tab-button"
								classList={{ "integrations-tab-button-active": activeTab() === tab.id }}
								onClick={() => {
									if (activeTab() !== tab.id) selectIntegrationsTab(tab.id);
								}}
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
				class="integrations-panel"
				aria-labelledby={`integrations-tab-${activeTab()}`}
			>
				<Show when={activeTab() === "skills"}>
					<SkillsTab />
				</Show>
				<Show when={activeTab() === "plugins" ? featurePluginsTab() : undefined} keyed>
					{(Tab) => <Tab />}
				</Show>
				<Show when={activeTab() === "mcp"}>
					<McpTab />
				</Show>
			</div>
		</Modal>
	);
};
