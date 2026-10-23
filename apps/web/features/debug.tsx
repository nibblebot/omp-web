import { DebugButton } from "../components/app/debug/DebugButton";
import { FleetDebugSheet } from "../components/app/debug/FleetDebugSheet";
import "./debug.css";
import type { FeatureModule } from "./registry";

export default {
	id: "debug",
	modals: {
		debug: (props) => <FleetDebugSheet onClose={props.onClose} />,
	},
	settingsAction: DebugButton,
} satisfies FeatureModule;
