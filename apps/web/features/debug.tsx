import { DebugFooterButton } from "../components/app/debug/DebugFooterButton";
import { DebugStatusButton } from "../components/app/debug/DebugStatusButton";
import { FleetDebugSheet } from "../components/app/debug/FleetDebugSheet";
import "./debug.css";
import type { FeatureModule } from "./registry";

export default {
	id: "debug",
	modals: {
		debug: (props) => <FleetDebugSheet onClose={props.onClose} />,
	},
	statusBar: { debugButton: DebugStatusButton },
	sidebarFooter: { debugButton: DebugFooterButton },
} satisfies FeatureModule;
