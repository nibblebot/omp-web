import { ProviderLoginModal } from "../../../web/components/models/ProviderLoginModal";
import { setState } from "../../../web/state";
import { loginBrowserUrl, loginCodePrompt, loginProviders } from "../../fixtures/dialogs";
import { answerCalls } from "../../daemon";
import { defineStory } from "../../registry";

const answerProviders = (): void => answerCalls({ getLoginProviders: () => loginProviders });

export default defineStory({
	id: "models-provider-login-modal",
	title: "ProviderLoginModal",
	component: {
		file: "apps/web/components/models/ProviderLoginModal.tsx",
		export: "ProviderLoginModal",
	},
	tabs: true,
	variants: [
		{
			name: "Provider list",
			seed: answerProviders,
			render: () => <ProviderLoginModal onClose={() => {}} />,
		},
		{
			name: "Browser sign-in in progress",
			seed: () => {
				answerProviders();
				setState("loginUrl", loginBrowserUrl);
			},
			render: () => <ProviderLoginModal onClose={() => {}} />,
		},
		{
			name: "Device code requested",
			seed: () => {
				answerProviders();
				setState("loginCodeRequest", loginCodePrompt);
			},
			render: () => <ProviderLoginModal onClose={() => {}} />,
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
			render: () => <ProviderLoginModal onClose={() => {}} />,
		},
	],
});
