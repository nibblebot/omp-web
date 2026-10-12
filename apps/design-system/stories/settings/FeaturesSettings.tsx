import { FeaturesSettings } from "../../../web/components/settings/FeaturesSettings";
import { FEATURES } from "../../../web/features/manifest";
import { markFeaturesActive, setFeaturePreference } from "../../../web/features/preferences";
import { resetFeatureSizes } from "../../../web/features/sizes";
import { featureSizesFixture } from "../../fixtures/routes";
import { defineStory } from "../../registry";

const defaultEnabled = FEATURES.filter((f) => f.defaultEnabled).map((f) => f.id);

// The showcase resets feature preferences to manifest defaults before each
// story and variant (seed.ts), so a variant only sets what differs.
export default [
	defineStory({
		id: "settings-features-settings",
		title: "FeaturesSettings",
		component: {
			file: "apps/web/components/settings/FeaturesSettings.tsx",
			export: "FeaturesSettings",
		},
		variants: [
			{
				name: "Sizes, reload pending",
				description:
					"Analysis and debug turned off after load: summary shows the after-reload size and the Reload button.",
				seed: () => {
					featureSizesFixture.available = true;
					resetFeatureSizes();
					markFeaturesActive(defaultEnabled);
					setFeaturePreference("analysis", false);
					setFeaturePreference("debug", false);
				},
				render: () => <FeaturesSettings />,
			},
			{
				name: "Sizes unavailable",
				description:
					"No feature-sizes.json (dev build): rows show no sizes and the panel says sizes are measured in production builds.",
				seed: () => {
					featureSizesFixture.available = false;
					resetFeatureSizes();
					markFeaturesActive(defaultEnabled);
					setFeaturePreference("analysis", true);
					setFeaturePreference("debug", true);
				},
				render: () => <FeaturesSettings />,
			},
		],
	}),
];
