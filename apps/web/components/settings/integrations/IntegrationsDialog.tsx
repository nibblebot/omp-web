import { For, Show, type Component } from "solid-js";
import { isFeatureEnabled } from "../../../features/registry";
import type { IntegrationTab } from "../../../store/slices/integrations";
import {
	integrationsTab,
	reloadIntegrations,
	selectIntegrationsTab,
} from "../../../store/integrations";
import { Modal } from "../../ui/Modal";
import { ExtensionsTab } from "./ExtensionsTab";
import { PluginsTab } from "./PluginsTab";
import "./integrations.css";

/** The tabs the dialog can show; each belongs to the optional feature that owns it. */
const TABS: Array<{ id: IntegrationTab; label: string; feature: "integrations" | "plugins" }> = [
	{ id: "extensions", label: "Extensions", feature: "integrations" },
	{ id: "plugins", label: "Plugins", feature: "plugins" },
];

/**
 * One dialog for extensions (skills and MCP servers) and plugins. It renders while
 * either owning feature is on and shows only the tabs of the features that are.
 */
export const IntegrationsDialog: Component<{ onClose: () => void }> = (props) => {
	const tabs = () => TABS.filter((tab) => isFeatureEnabled(tab.feature));
	const hasExtensions = () => isFeatureEnabled("integrations");
	// The stored tab may belong to a feature that is off: fall back to the first one shown.
	const activeTab = () => {
		const available = tabs();
		return available.find((tab) => tab.id === integrationsTab())?.id ?? available[0]?.id;
	};
	return (
		<Modal
			title={hasExtensions() ? "Extensions" : "Plugins"}
			class="integrations-dialog"
			size="wide"
			onClose={props.onClose}
		>
			<Show when={tabs().length > 1 || hasExtensions()}>
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
					<Show when={hasExtensions()}>
						<button
							type="button"
							class="settings-control-btn"
							title="Rediscover skills and commands and reconnect MCP servers. No confirmation needed."
							onClick={reloadIntegrations}
						>
							Reload integrations
						</button>
					</Show>
				</div>
			</Show>
			<div
				role="tabpanel"
				id="integrations-panel"
				class="integrations-panel"
				aria-labelledby={tabs().length > 1 ? `integrations-tab-${activeTab()}` : undefined}
			>
				<Show when={activeTab() === "extensions"}>
					<ExtensionsTab />
				</Show>
				<Show when={activeTab() === "plugins"}>
					<PluginsTab />
				</Show>
			</div>
		</Modal>
	);
};
