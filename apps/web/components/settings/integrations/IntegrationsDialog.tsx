import { For, Show, type Component } from "solid-js";
import { featurePluginsTab } from "../../../features/registry";
import type { IntegrationTab } from "../../../store/slices/integrations";
import {
	integrationsTab,
	reloadIntegrations,
	selectIntegrationsTab,
} from "../../../store/integrations";
import { Modal } from "../../ui/Modal";
import { ExtensionsTab } from "./ExtensionsTab";
import "./integrations.css";

/**
 * One dialog for extensions (skills and MCP servers) and, while the optional `plugins` feature
 * is on, a Plugins tab. The tab body comes from the feature's `pluginsTab` slot, so the plugins
 * chunk is never loaded while the feature is off.
 */
export const IntegrationsDialog: Component<{ onClose: () => void }> = (props) => {
	// The stored tab may be Plugins after the feature was turned off: Extensions shows then.
	const activeTab = (): IntegrationTab =>
		integrationsTab() === "plugins" && featurePluginsTab() ? "plugins" : "extensions";
	const tabs = (): Array<{ id: IntegrationTab; label: string }> => [
		{ id: "extensions", label: "Extensions" },
		...(featurePluginsTab() ? [{ id: "plugins" as const, label: "Plugins" }] : []),
	];
	return (
		<Modal title="Extensions" class="integrations-dialog" size="wide" onClose={props.onClose}>
			<div class="integrations-head">
				<Show when={tabs().length > 1}>
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
									onClick={() => selectIntegrationsTab(tab.id)}
								>
									{tab.label}
								</button>
							)}
						</For>
					</div>
				</Show>
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
				aria-labelledby={tabs().length > 1 ? `integrations-tab-${activeTab()}` : undefined}
			>
				<Show when={activeTab() === "extensions"}>
					<ExtensionsTab />
				</Show>
				<Show when={activeTab() === "plugins" ? featurePluginsTab() : undefined} keyed>
					{(Tab) => <Tab />}
				</Show>
			</div>
		</Modal>
	);
};
