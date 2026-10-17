import { FeaturesSettings } from "../../../web/components/settings/FeaturesSettings";
import { FEATURES } from "../../../web/features/manifest";
import { markFeaturesActive } from "../../../web/features/preferences";
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
				name: "Sizes",
				description:
					"Sizes measured and the default features loaded: the summary lists them, and each row shows its own size. Toggles load or unload at once.",
				seed: () => {
					featureSizesFixture.available = true;
					resetFeatureSizes();
					markFeaturesActive(defaultEnabled);
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
				},
				render: () => <FeaturesSettings />,
			},
		],
	}),
];
