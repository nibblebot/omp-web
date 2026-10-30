import { ProviderLoginDialog } from "../components/models/ProviderLoginDialog";
import { pushNotice, setState } from "../state";
import type { FeatureCommand, FeatureModule } from "./registry";

/** `/login` opens the provider login dialog; the provider is picked there. */
const login: FeatureCommand = {
	detail: "Log in to a model provider",
	run(args) {
		if (args.trim())
			return pushNotice(
				"error",
				"Usage: /login takes no arguments; pick the provider in the dialog.",
			);
		setState("modal", "login");
	},
};

export default {
	id: "providers",
	modals: {
		// Login belongs with Settings > Providers: closing returns there.
		login: () => (
			<ProviderLoginDialog
				onClose={() => setState({ modal: "settings", settingsTab: "providers" })}
			/>
		),
	},
	commands: { login },
} satisfies FeatureModule;
