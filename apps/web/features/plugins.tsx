import { PluginsTab } from "../components/settings/integrations/PluginsTab";
import type { FeatureModule } from "./registry";

// The Extensions dialog (core) shows its Plugins tab only while this feature is on; the tab
// body is contributed here so the plugins chunk stays out of the entry bundle.
export default {
	id: "plugins",
	pluginsTab: PluginsTab,
} satisfies FeatureModule;
