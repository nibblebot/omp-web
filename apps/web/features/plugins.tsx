import { IntegrationsDialog } from "../components/settings/integrations/IntegrationsDialog";
import type { FeatureModule } from "./registry";

// The Extensions dialog shows its Plugins tab while this feature is on; the
// `integrations` feature renders the same dialog, so either one opens it.
export default {
	id: "plugins",
	modals: {
		integrations: (props) => <IntegrationsDialog onClose={props.onClose} />,
	},
} satisfies FeatureModule;
