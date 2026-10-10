import { ProviderLoginDialog } from "../../../web/components/models/ProviderLoginDialog";
import { setState } from "../../../web/state";
import { loginBrowserUrl, loginCodePrompt, loginProviders } from "../../fixtures/dialogs";
import { answerCalls } from "../../daemon";
import { defineStory } from "../../registry";

const answerProviders = (): void => answerCalls({ getLoginProviders: () => loginProviders });

export default defineStory({
	id: "models-provider-login-dialog",
	title: "ProviderLoginDialog",
	component: {
		file: "apps/web/components/models/ProviderLoginDialog.tsx",
		export: "ProviderLoginDialog",
	},
	tabs: true,
	variants: [
		{
			name: "Provider list",
			seed: answerProviders,
			render: () => <ProviderLoginDialog onClose={() => {}} />,
		},
		{
			name: "Browser sign-in in progress",
			seed: () => {
				answerProviders();
				setState("loginUrl", loginBrowserUrl);
			},
			render: () => <ProviderLoginDialog onClose={() => {}} />,
		},
		{
			name: "Device code requested",
			seed: () => {
				answerProviders();
				setState("loginCodeRequest", loginCodePrompt);
			},
			render: () => <ProviderLoginDialog onClose={() => {}} />,
		},
		{
			name: "Provider list failed",
			seed: () => {
				answerCalls({
					getLoginProviders: () => {
						throw new Error("auth store is locked by another daemon");
					},
				});
			},
			render: () => <ProviderLoginDialog onClose={() => {}} />,
		},
	],
});
