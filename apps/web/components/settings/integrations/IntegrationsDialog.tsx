import { For, Show, type Component } from "solid-js";
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

const TABS: Array<{ id: IntegrationTab; label: string }> = [
	{ id: "extensions", label: "Extensions" },
	{ id: "plugins", label: "Plugins" },
];

/** One dialog for extensions (skills and MCP servers) and plugins. */
export const IntegrationsDialog: Component<{ onClose: () => void }> = (props) => (
	<Modal title="Extensions" class="integrations-dialog" size="wide" onClose={props.onClose}>
		<div class="integrations-head">
			<div class="integrations-tabs" role="tablist" aria-label="Sections">
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
			class="integrations-panel"
			aria-labelledby={`integrations-tab-${integrationsTab()}`}
		>
			<Show when={integrationsTab() === "extensions"}>
				<ExtensionsTab />
			</Show>
			<Show when={integrationsTab() === "plugins"}>
				<PluginsTab />
			</Show>
		</div>
	</Modal>
);
